// The single entry point: bytes in, addressable segments out.
//
// Everything downstream — the AI extraction pass, the review screen's
// provenance column, the exported deal memo — depends on the shape returned
// here lining up with the `documents` and `document_segments` tables in
// src/lib/db/schema.sql:
//
//   documents          → type / mime / detected_type / page_count / sheet_count
//                        / has_text_layer / is_scanned / status / error
//   document_segments  → ordinal / page_no / sheet_name / content
//
// A segment is the smallest thing a human can be pointed at: one PDF page, one
// worksheet, one document section. `ordinal` is dense and 0-based across the
// whole document so a segment can be cited by position alone.
//
// This function NEVER throws. A corrupt upload returns ok:false with a message
// a non-technical user can act on, because the alternative — an exception
// escaping into the upload route — turns a bad file into a 500 and tells the
// user nothing.

import { detectFileType } from "./detect.ts";
import type { DetectResult, FileType } from "./detect.ts";
import { parsePdf } from "./pdf.ts";
import { parseSheetWorkbook } from "./sheet.ts";
import { parseDocx } from "./docx.ts";
import { parseTextDocument } from "./text.ts";
import {
  classifyColumns,
  detectHeaderRow,
  isLikelyRentRoll,
  isLikelyT12,
} from "./tables.ts";
import type { ColumnClassification } from "./tables.ts";

export type DocumentKind = "om" | "rent_roll" | "t12" | "other";
export type SegmentKind = "page" | "sheet" | "section";

export interface ParsedSegment {
  /** Dense, 0-based, ordered. Maps to document_segments.ordinal. */
  ordinal: number;
  /** 1-based page number for PDFs. Maps to document_segments.page_no. */
  pageNo?: number;
  /** Worksheet name. Maps to document_segments.sheet_name. */
  sheetName?: string;
  content: string;
  kind: SegmentKind;
}

export interface ParsedTable {
  sheetName?: string;
  pageNo?: number;
  rows: string[][];
  headerRowIndex: number;
  columns: ColumnClassification[];
}

export interface ParsedDocument {
  ok: boolean;
  type: FileType;
  mime: string;
  /** The detection reason — which signal decided the type. */
  detectedBy: string;
  pageCount?: number;
  sheetCount?: number;
  hasTextLayer?: boolean;
  isScanned: boolean;
  segments: ParsedSegment[];
  tables?: ParsedTable[];
  guessedKind: DocumentKind;
  warnings: string[];
  error?: string;
}

export interface ParseDocumentOptions {
  /** Total extracted-text ceiling. Default 2 MB. */
  maxChars?: number;
}

/** 2 MB of text is far more than any real OM; past this we truncate and warn. */
export const MAX_TOTAL_TEXT_CHARS = 2 * 1024 * 1024;

// ------------------------------------------------------------ kind guesses --

const FILENAME_HINTS: Array<[DocumentKind, RegExp]> = [
  ["rent_roll", /(rent[\s_-]*roll|rentroll|tenancy[\s_-]*(schedule|list)|tenant[\s_-]*list|ejari|unit[\s_-]*mix|lease[\s_-]*schedule)/i],
  ["t12", /(t[\s_-]?12|t[\s_-]?twelve|ttm|trailing[\s_-]*(12|twelve)|operating[\s_-]*statement|income[\s_-]*statement|p\s*&\s*l|p_?and_?l|profit[\s_-]*(and|&)[\s_-]*loss|financials?)/i],
  ["om", /(offering[\s_-]*memo|\bom\b|o\.m\.|memorandum|teaser|investment[\s_-]*(summary|memo|brochure)|marketing[\s_-]*(package|brochure)|ic[\s_-]*memo|flyer|e[\s_-]*brochure)/i],
];

const OM_TEXT_HINTS = [
  "offering memorandum", "investment summary", "investment highlights",
  "executive summary", "property overview", "the offering", "confidentiality",
  "disclaimer", "location overview", "market overview", "asking price",
  "purchase price", "for sale", "investment opportunity", "asset summary",
];

function kindFromFilename(filename: string): DocumentKind | null {
  const name = String(filename ?? "");
  for (const [kind, pattern] of FILENAME_HINTS) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

function kindFromText(text: string): DocumentKind | null {
  const body = text.toLowerCase().slice(0, 200_000);
  if (body === "") return null;

  let om = 0;
  for (const hint of OM_TEXT_HINTS) if (body.includes(hint)) om++;

  const rentRoll = [
    "rent roll", "tenancy schedule", "ejari", "no. of cheques", "no of cheques",
    "lease expiry", "lease expiration", "occupancy status", "in-place rent",
  ].filter((h) => body.includes(h)).length;

  const t12 = [
    "trailing 12", "trailing twelve", "operating statement", "net operating income",
    "total operating expenses", "effective gross income", "gross potential rent",
    "profit and loss", "income statement",
  ].filter((h) => body.includes(h)).length;

  const best = Math.max(om, rentRoll, t12);
  if (best === 0) return null;
  if (t12 === best && t12 >= 2) return "t12";
  if (rentRoll === best && rentRoll >= 2) return "rent_roll";
  if (om === best && om >= 2) return "om";
  return null;
}

/**
 * First table wins. A workbook often carries a rent roll AND a supporting
 * operating statement; the leading sheet is what the file is filed as, so we
 * take the earliest sheet that matches either shape rather than letting a
 * back-of-workbook T12 tab rename the whole upload.
 */
function kindFromTables(tables: ParsedTable[]): DocumentKind | null {
  for (const table of tables) {
    if (isLikelyRentRoll(table.rows)) return "rent_roll";
    if (isLikelyT12(table.rows)) return "t12";
  }
  return null;
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return value === "om" || value === "rent_roll" || value === "t12" || value === "other";
}

// ----------------------------------------------------------------- helpers --

/**
 * Append a segment, respecting the global text budget.
 * Returns false once the budget is exhausted so callers can stop early.
 */
function makeCollector(maxChars: number) {
  const segments: ParsedSegment[] = [];
  let budget = maxChars;
  let truncated = false;
  let dropped = 0;

  return {
    segments,
    get truncated() {
      return truncated;
    },
    get dropped() {
      return dropped;
    },
    push(content: string, kind: SegmentKind, page?: number, sheet?: string): boolean {
      const text = String(content ?? "");
      if (budget <= 0) {
        truncated = true;
        dropped++;
        return false;
      }
      let value = text;
      if (value.length > budget) {
        value = value.slice(0, budget);
        truncated = true;
      }
      budget -= value.length;
      const segment: ParsedSegment = { ordinal: segments.length, content: value, kind };
      if (page !== undefined) segment.pageNo = page;
      if (sheet !== undefined) segment.sheetName = sheet;
      segments.push(segment);
      return budget > 0;
    },
  };
}

function sheetSegmentText(name: string, csv: string): string {
  return csv.trim() === "" ? `# Sheet: ${name}\n(empty)` : `# Sheet: ${name}\n${csv}`;
}

// -------------------------------------------------------------- the parser --

/**
 * Turn an uploaded file into page-/sheet-addressable text segments.
 *
 * @param buffer        the raw upload
 * @param filename      used for the extension tiebreak and the filename kind hint only
 * @param declaredKind  what the user said it was; used when our own heuristics
 *                      are inconclusive, and warned about when they disagree
 */
export async function parseDocument(
  buffer: Buffer | Uint8Array,
  filename: string,
  declaredKind?: string,
  options?: ParseDocumentOptions,
): Promise<ParsedDocument> {
  const maxChars = options?.maxChars ?? MAX_TOTAL_TEXT_CHARS;
  const warnings: string[] = [];

  let detected: DetectResult;
  try {
    detected = await detectFileType(buffer ?? Buffer.alloc(0), filename);
  } catch (err) {
    return {
      ok: false,
      type: "unknown",
      mime: "application/octet-stream",
      detectedBy: "detection failed",
      isScanned: false,
      segments: [],
      guessedKind: "other",
      warnings,
      error: `could not inspect the file: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  const base = {
    type: detected.type,
    mime: detected.mime,
    detectedBy: detected.reason,
  };

  if (detected.extensionMismatch) {
    warnings.push(
      `"${filename}" has a .${detected.extension} extension but its contents are ${detected.type} ` +
        `— the extension was ignored (${detected.reason})`,
    );
  }
  if (detected.confidence < 0.7) {
    warnings.push(
      `file type detected with low confidence (${detected.confidence.toFixed(2)}): ${detected.reason}`,
    );
  }

  const fail = (message: string): ParsedDocument => ({
    ok: false,
    ...base,
    isScanned: false,
    segments: [],
    guessedKind: (isDocumentKind(declaredKind) ? declaredKind : kindFromFilename(filename)) ?? "other",
    warnings,
    error: message,
  });

  try {
    const collector = makeCollector(maxChars);
    const tables: ParsedTable[] = [];
    let pageCount: number | undefined;
    let sheetCount: number | undefined;
    let hasTextLayer: boolean | undefined;
    let isScanned = false;
    let plainText = "";

    switch (detected.type) {
      // ------------------------------------------------------------- PDF --
      case "pdf": {
        const result = await parsePdf(buffer, { maxChars });
        warnings.push(...result.meta.warnings);
        if (!result.ok) return fail(result.error ?? "the PDF could not be read");

        pageCount = result.pageCount;
        hasTextLayer = result.hasTextLayer;
        isScanned = result.isScanned;
        for (const page of result.pages) {
          if (!collector.push(page.text, "page", page.pageNo)) break;
        }
        plainText = result.pages.map((p) => p.text).join("\n");
        break;
      }

      // -------------------------------------------------- workbooks / CSV --
      case "xlsx":
      case "xls":
      case "csv":
      case "tsv": {
        const result = await parseSheetWorkbook(buffer, detected.type, { maxChars });
        warnings.push(...result.warnings);
        if (!result.ok) return fail(result.error ?? "the spreadsheet could not be read");

        sheetCount = result.sheets.length;
        hasTextLayer = result.sheets.some((s) => s.rows.length > 0);
        for (const sheet of result.sheets) {
          if (!collector.push(sheetSegmentText(sheet.name, sheet.csv), "sheet", undefined, sheet.name)) {
            break;
          }
          if (sheet.rows.length > 0) {
            tables.push({
              sheetName: sheet.name,
              rows: sheet.rows,
              headerRowIndex: sheet.headerRowIndex,
              columns: classifyColumns(sheet.rows, sheet.headerRowIndex),
            });
          }
        }
        plainText = result.sheets.map((s) => s.csv).join("\n");
        break;
      }

      // ------------------------------------------------------------ DOCX --
      case "docx": {
        const result = await parseDocx(buffer, { maxChars });
        warnings.push(...result.warnings);
        if (!result.ok) return fail(result.error ?? "the Word document could not be read");

        hasTextLayer = result.text.trim() !== "" || result.tables.length > 0;
        for (const section of result.sections) {
          const body = section.heading ? `${section.heading}\n${section.content}` : section.content;
          if (!collector.push(body, "section")) break;
        }
        for (const table of result.tables) {
          tables.push({
            rows: table.rows,
            headerRowIndex: table.headerRowIndex,
            columns: table.columns,
          });
        }
        plainText = result.text;
        isScanned = hasTextLayer === false;
        break;
      }

      // ------------------------------------------------- text-ish formats --
      case "html":
      case "markdown":
      case "text": {
        const result = await parseTextDocument(buffer, detected.type);
        warnings.push(...result.warnings);
        if (!result.ok) return fail(result.error ?? "the text document could not be read");

        hasTextLayer = result.text.trim() !== "";
        for (const section of result.sections) {
          const body = section.heading ? `${section.heading}\n${section.content}` : section.content;
          if (!collector.push(body, "section")) break;
        }
        for (const rows of result.tables) {
          if (rows.length === 0) continue;
          const headerRowIndex = detectHeaderRow(rows);
          tables.push({ rows, headerRowIndex, columns: classifyColumns(rows, headerRowIndex) });
        }
        plainText = result.text;
        break;
      }

      // ------------------------------------------- known-but-unsupported --
      case "doc":
        return fail(
          "this is a legacy Word 97-2003 (.doc) file, which cannot be read as text — " +
            "please re-save it as .docx or PDF and upload again",
        );
      case "ppt":
        return fail(
          "this is a legacy PowerPoint 97-2003 (.ppt) file, which cannot be read as text — " +
            "please export it to PDF and upload again",
        );
      case "pptx":
        return fail(
          "this is a PowerPoint deck; offering memoranda must be uploaded as the PDF export " +
            "(File → Export → PDF) so page numbers can be cited",
        );
      case "rtf":
        return fail(
          "this is an RTF file, which is not supported — please re-save it as .docx or PDF",
        );
      case "image":
        return fail(
          "this is an image, not a document — it contains no text layer that can be read; " +
            "please upload the original PDF, Word or Excel file",
        );
      case "zip":
        return fail(
          "this is a ZIP archive, not a document — please upload the individual OM, rent roll " +
            "or T12 file",
        );
      case "empty":
        return fail("the file is empty (0 bytes)");
      default:
        return fail(
          `the file type could not be identified from its contents (${detected.reason}) — ` +
            "supported formats are PDF, Word (.docx), Excel (.xlsx/.xls), CSV, TSV and plain text",
        );
    }

    if (collector.truncated) {
      warnings.push(
        `extracted text reached the ${maxChars}-character ceiling and was truncated` +
          (collector.dropped > 0 ? ` (${collector.dropped} later segment(s) dropped)` : ""),
      );
    }

    // ---- what kind of document is this? ---------------------------------
    const fromTables = kindFromTables(tables);
    const fromText = kindFromText(plainText);
    const fromFilename = kindFromFilename(filename);
    let guessedKind: DocumentKind = fromTables ?? fromText ?? fromFilename ?? "other";

    if (guessedKind === "other" && isDocumentKind(declaredKind)) {
      guessedKind = declaredKind;
    } else if (
      isDocumentKind(declaredKind) &&
      declaredKind !== "other" &&
      declaredKind !== guessedKind &&
      guessedKind !== "other"
    ) {
      warnings.push(
        `uploaded as "${declaredKind}" but the contents look like "${guessedKind}" — ` +
          "check the document was filed against the right slot",
      );
    }

    if (isScanned) {
      warnings.push(
        "this document is scanned and cannot be read as text; no figures can be extracted from it",
      );
    }
    if (collector.segments.length === 0) {
      warnings.push("no readable text segments were produced from this file");
    }

    const out: ParsedDocument = {
      ok: true,
      ...base,
      isScanned,
      segments: collector.segments,
      guessedKind,
      warnings,
    };
    if (pageCount !== undefined) out.pageCount = pageCount;
    if (sheetCount !== undefined) out.sheetCount = sheetCount;
    if (hasTextLayer !== undefined) out.hasTextLayer = hasTextLayer;
    if (tables.length > 0) out.tables = tables;
    return out;
  } catch (err) {
    return fail(`the file could not be parsed: ${(err as Error)?.message ?? String(err)}`);
  }
}

export { detectFileType } from "./detect.ts";
export { parsePdf } from "./pdf.ts";
export { parseSheetWorkbook } from "./sheet.ts";
export { parseDocx } from "./docx.ts";
export { parseTextDocument, htmlToText, extractHtmlTables, decodeEntities } from "./text.ts";
export {
  parseNumber,
  inferHeaders,
  detectHeaderRow,
  classifyColumns,
  classifyHeaderText,
  normaliseHeader,
  isLikelyRentRoll,
  isLikelyT12,
} from "./tables.ts";
export type { DetectResult, FileType } from "./detect.ts";
export type { PdfParseResult, PdfPage } from "./pdf.ts";
export type { ParsedSheet, SheetParseResult } from "./sheet.ts";
export type { DocxParseResult, DocxTable } from "./docx.ts";
export type { TextParseResult, TextSection } from "./text.ts";
export type { ColumnClassification, ColumnRole, InferredHeaders } from "./tables.ts";
