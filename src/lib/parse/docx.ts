// DOCX via mammoth.
//
// Two passes over the same bytes, on purpose:
//
//   * `extractRawText` gives clean prose with no markup to strip — the best
//     input for the AI extraction pass.
//   * `convertToHtml` preserves headings and tables. Headings become section
//     boundaries (so provenance can say "Offering Memorandum § Rent Roll
//     Summary" rather than "somewhere in a 40-page Word file"), and tables come
//     out as rows the same shape sheet.ts produces, so tables.ts can classify
//     the columns of a rent roll that was pasted into Word.
//
// Word's own `.doc` (OLE2) is not readable here; detect.ts identifies it and
// the caller reports it rather than pretending.

import mammoth from "mammoth";
import { extractHtmlTables, sectionsFromHtml, sectionsFromPlain } from "./text.ts";
import type { TextSection } from "./text.ts";
import { classifyColumns, detectHeaderRow } from "./tables.ts";
import type { ColumnClassification } from "./tables.ts";

export interface DocxTable {
  rows: string[][];
  headerRowIndex: number;
  columns: ColumnClassification[];
}

export interface DocxParseResult {
  ok: boolean;
  text: string;
  sections: TextSection[];
  tables: DocxTable[];
  warnings: string[];
  error?: string;
}

export interface DocxParseOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 2 * 1024 * 1024;

function toNodeBuffer(input: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) return input;
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

/** Pad every row of an HTML-derived table to the widest row. */
function rectangularise(rows: string[][]): string[][] {
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < width) next.push("");
    return next;
  });
}

/**
 * Parse a .docx into text, heading-delimited sections and tables.
 * Never throws; a corrupt file returns `ok: false` with an explanation.
 */
export async function parseDocx(
  buffer: Buffer | Uint8Array,
  options?: DocxParseOptions,
): Promise<DocxParseResult> {
  const warnings: string[] = [];
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  try {
    if (!buffer || buffer.byteLength === 0) {
      return { ok: false, text: "", sections: [], tables: [], warnings, error: "DOCX is empty (0 bytes)" };
    }
    const buf = toNodeBuffer(buffer);

    let html = "";
    let raw = "";
    try {
      const htmlResult = await mammoth.convertToHtml({ buffer: buf });
      html = String(htmlResult?.value ?? "");
      for (const message of htmlResult?.messages ?? []) {
        const text = String((message as { message?: string })?.message ?? "");
        if (text !== "") warnings.push(`mammoth: ${text}`);
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      return {
        ok: false,
        text: "",
        sections: [],
        tables: [],
        warnings,
        error: `DOCX could not be parsed: ${message}`,
      };
    }

    try {
      const rawResult = await mammoth.extractRawText({ buffer: buf });
      raw = String(rawResult?.value ?? "");
    } catch {
      // The HTML pass already succeeded; fall back to stripping it.
      warnings.push("raw-text extraction failed; text derived from the HTML conversion instead");
    }

    const sections = sectionsFromHtml(html);
    let text = raw.trim();
    if (text === "") {
      text = sections.map((s) => (s.heading ? `${s.heading}\n${s.content}` : s.content)).join("\n\n").trim();
    }

    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    const finalSections: TextSection[] =
      sections.length > 0 ? sections : sectionsFromPlain(text);

    const tables: DocxTable[] = extractHtmlTables(html)
      .map((rows) => rectangularise(rows))
      .filter((rows) => rows.length > 0 && (rows[0]?.length ?? 0) > 0)
      .map((rows) => {
        const headerRowIndex = detectHeaderRow(rows);
        return { rows, headerRowIndex, columns: classifyColumns(rows, headerRowIndex) };
      });

    if (text.trim() === "" && tables.length === 0) {
      warnings.push("the document contains no extractable text — it may be image-only");
    }
    if (truncated) warnings.push(`extracted text truncated at ${maxChars} characters`);

    return { ok: true, text, sections: finalSections, tables, warnings };
  } catch (err) {
    return {
      ok: false,
      text: "",
      sections: [],
      tables: [],
      warnings,
      error: `DOCX could not be parsed: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}
