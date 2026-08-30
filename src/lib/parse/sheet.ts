// Workbook parsing: xlsx / xlsm / xlsb / xls / ods / csv / tsv, via SheetJS.
//
// A rent roll is never a clean rectangle. The things this file has to survive,
// all of which are routine in real Dubai and US brokerage exports:
//
//   * Merged cells. A merged "SUNRISE TOWER — RENT ROLL" banner across A1:H1,
//     and merged column-group headers above the real ones. We UNMERGE by
//     writing the top-left value into every covered cell, because a header that
//     only exists in one of the six columns it labels is a header the
//     extraction layer cannot see.
//   * Formulas. We take the cached computed value (`cell.v`), never the formula
//     string — "=SUM(D5:D40)" is not a number.
//   * Dates. Returned as ISO strings. `cellDates` makes SheetJS do the
//     serial-to-date conversion itself, which is what accounts for the Excel
//     1900 leap-year bug (and the 1904 epoch some Mac workbooks still use).
//   * Numbers stored as text. Left exactly as they were; tables.ts/parseNumber
//     is the single place that decides what "72,000" means.
//   * Junk rows above the header, and completely empty sheets.

import XLSX from "xlsx";
import type { FileType } from "./detect.ts";
import { detectHeaderRow } from "./tables.ts";

export interface ParsedSheet {
  name: string;
  index: number;
  /** Fully rectangular, merges expanded, every cell a string. */
  rows: string[][];
  /** RFC-4180 rendering of `rows`, handy for prompting and for diffing. */
  csv: string;
  /** A1-style range actually populated, e.g. "A1:H43". "" for empty sheets. */
  usedRange: string;
  /** Index into `rows`, or -1 when nothing looks like a header. */
  headerRowIndex: number;
  /** How many merge ranges were expanded. */
  mergedRanges: number;
  truncated: boolean;
}

export interface SheetParseResult {
  ok: boolean;
  sheets: ParsedSheet[];
  warnings: string[];
  error?: string;
}

export interface SheetParseOptions {
  maxChars?: number;
  maxRowsPerSheet?: number;
  maxColumnsPerSheet?: number;
}

const DEFAULT_MAX_CHARS = 2 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_COLS = 1024;

interface AnyCell {
  t?: string;
  v?: unknown;
  w?: string;
  f?: string;
}

function isoFromDate(value: Date): string {
  if (Number.isNaN(value.getTime())) return "";
  const iso = value.toISOString();
  // Midnight UTC means a plain date; anything else keeps its time component.
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, "Z");
}

function numberToString(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  // Kill float noise (1234.5600000000001) without touching real precision.
  const cleaned = Number(value.toPrecision(12));
  return String(cleaned);
}

/** One cell to one string. Formulas resolve to their cached value. */
function cellToString(cell: AnyCell | undefined): string {
  if (!cell) return "";
  if (cell.t === "z") return "";
  if (cell.t === "e") return ""; // #REF!, #DIV/0! — not data
  const v = cell.v;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return isoFromDate(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return numberToString(v);
  return String(v).replace(/\r\n?/g, "\n").trim();
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => csvEscape(cell ?? "")).join(",")).join("\n");
}

/**
 * Real bounds of a worksheet.
 *
 * `!ref` is not trusted on its own: workbooks in the wild declare A1:XFD1048576
 * and materialising that is an out-of-memory bug, not a parse. We intersect the
 * declared range with the cells that actually exist.
 */
function realBounds(
  sheet: Record<string, unknown>,
  maxRows: number,
  maxCols: number,
): { rows: number; cols: number; clamped: boolean } {
  let maxRow = -1;
  let maxCol = -1;
  for (const key of Object.keys(sheet)) {
    if (key.charCodeAt(0) === 33 /* ! */) continue;
    const address = XLSX.utils.decode_cell(key);
    if (!address || !Number.isFinite(address.r) || !Number.isFinite(address.c)) continue;
    if (address.r > maxRow) maxRow = address.r;
    if (address.c > maxCol) maxCol = address.c;
  }
  const merges = (sheet["!merges"] as Array<{ e: { r: number; c: number } }> | undefined) ?? [];
  for (const merge of merges) {
    if (merge?.e?.r > maxRow) maxRow = merge.e.r;
    if (merge?.e?.c > maxCol) maxCol = merge.e.c;
  }
  if (maxRow < 0 || maxCol < 0) return { rows: 0, cols: 0, clamped: false };

  const clamped = maxRow + 1 > maxRows || maxCol + 1 > maxCols;
  return {
    rows: Math.min(maxRow + 1, maxRows),
    cols: Math.min(maxCol + 1, maxCols),
    clamped,
  };
}

function trimTrailing(rows: string[][]): string[][] {
  let lastRow = -1;
  let lastCol = -1;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      if ((rows[r]![c] ?? "") !== "") {
        if (r > lastRow) lastRow = r;
        if (c > lastCol) lastCol = c;
      }
    }
  }
  if (lastRow < 0) return [];
  return rows.slice(0, lastRow + 1).map((row) => {
    const next = row.slice(0, lastCol + 1);
    while (next.length < lastCol + 1) next.push("");
    return next;
  });
}

function readOptions(type: FileType): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: "buffer",
    cellDates: true, // library-side serial→Date: handles the 1900 leap bug and 1904 epoch
    cellNF: false,
    cellText: false,
    cellFormula: true, // keep .f around, but we read .v
    dense: false,
    WTF: false,
  };
  if (type === "csv") return { ...base, raw: true, FS: "," };
  if (type === "tsv") return { ...base, raw: true, FS: "\t" };
  return base;
}

/**
 * Parse a workbook into rectangular, string-valued sheets.
 *
 * Never throws: a corrupt or password-protected workbook returns `ok: false`
 * with an explanation.
 */
export async function parseSheetWorkbook(
  buffer: Buffer | Uint8Array,
  type: FileType = "xlsx",
  options?: SheetParseOptions,
): Promise<SheetParseResult> {
  const warnings: string[] = [];
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxRows = options?.maxRowsPerSheet ?? DEFAULT_MAX_ROWS;
  const maxCols = options?.maxColumnsPerSheet ?? DEFAULT_MAX_COLS;

  try {
    if (!buffer || buffer.byteLength === 0) {
      return { ok: false, sheets: [], warnings, error: "spreadsheet is empty (0 bytes)" };
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    let workbook: { SheetNames: string[]; Sheets: Record<string, Record<string, unknown>> };
    try {
      workbook = XLSX.read(buf, readOptions(type) as never) as never;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (/password|encrypt/i.test(message)) {
        return {
          ok: false,
          sheets: [],
          warnings,
          error: `spreadsheet is password protected and cannot be read (${message})`,
        };
      }
      return { ok: false, sheets: [], warnings, error: `spreadsheet could not be parsed: ${message}` };
    }

    const names = workbook?.SheetNames ?? [];
    if (names.length === 0) {
      return { ok: false, sheets: [], warnings, error: "workbook contains no sheets" };
    }

    const sheets: ParsedSheet[] = [];
    let charBudget = maxChars;

    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      const sheet = workbook.Sheets?.[name];
      if (!sheet) {
        sheets.push({
          name, index, rows: [], csv: "", usedRange: "", headerRowIndex: -1,
          mergedRanges: 0, truncated: false,
        });
        continue;
      }

      const declaredRef = typeof sheet["!ref"] === "string" ? (sheet["!ref"] as string) : "";
      const bounds = realBounds(sheet, maxRows, maxCols);
      if (bounds.rows === 0) {
        warnings.push(`sheet "${name}" is empty`);
        sheets.push({
          name, index, rows: [], csv: "", usedRange: declaredRef, headerRowIndex: -1,
          mergedRanges: 0, truncated: false,
        });
        continue;
      }
      if (bounds.clamped) {
        warnings.push(
          `sheet "${name}" exceeds ${maxRows} rows or ${maxCols} columns and was clipped`,
        );
      }

      // ---- unmerge -------------------------------------------------------
      const merges =
        (sheet["!merges"] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> | undefined) ??
        [];
      const filled = new Map<string, string>();
      for (const merge of merges) {
        if (!merge?.s || !merge?.e) continue;
        const anchor = cellToString(
          sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })] as AnyCell | undefined,
        );
        if (anchor === "") continue;
        for (let r = merge.s.r; r <= merge.e.r && r < bounds.rows; r++) {
          for (let c = merge.s.c; c <= merge.e.c && c < bounds.cols; c++) {
            filled.set(`${r}:${c}`, anchor);
          }
        }
      }

      // ---- materialise ---------------------------------------------------
      const rows: string[][] = [];
      let truncated = false;
      for (let r = 0; r < bounds.rows; r++) {
        const row: string[] = new Array(bounds.cols);
        for (let c = 0; c < bounds.cols; c++) {
          let value = cellToString(sheet[XLSX.utils.encode_cell({ r, c })] as AnyCell | undefined);
          if (value === "") value = filled.get(`${r}:${c}`) ?? "";
          if (value.length > charBudget) {
            value = value.slice(0, Math.max(charBudget, 0));
            truncated = true;
          }
          charBudget -= value.length;
          row[c] = value;
        }
        rows.push(row);
        if (charBudget <= 0) {
          truncated = true;
          break;
        }
      }

      const trimmed = trimTrailing(rows);
      const usedRange =
        declaredRef !== ""
          ? declaredRef
          : trimmed.length === 0
            ? ""
            : XLSX.utils.encode_range({
                s: { r: 0, c: 0 },
                e: { r: trimmed.length - 1, c: (trimmed[0]?.length ?? 1) - 1 },
              });

      sheets.push({
        name,
        index,
        rows: trimmed,
        csv: rowsToCsv(trimmed),
        usedRange,
        headerRowIndex: detectHeaderRow(trimmed),
        mergedRanges: merges.length,
        truncated,
      });

      if (truncated) {
        warnings.push(`sheet "${name}" truncated: workbook text exceeded ${maxChars} characters`);
      }
    }

    if (sheets.every((s) => s.rows.length === 0)) {
      warnings.push("workbook parsed but every sheet is empty");
    }

    return { ok: true, sheets, warnings };
  } catch (err) {
    return {
      ok: false,
      sheets: [],
      warnings,
      error: `spreadsheet could not be parsed: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}
