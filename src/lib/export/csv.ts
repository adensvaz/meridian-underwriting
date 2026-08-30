// The flat CSV export.
//
// The workbook is what an analyst forwards. This is what they paste into
// something else: one row per figure, no merged blocks, no group headers, no
// multi-sheet structure to unpick. It carries the inputs and the computed lines
// with their provenance, which is the part a downstream model actually needs.
//
// Two columns for every figure, deliberately:
//
//   `value`      the raw number, full precision, machine-readable
//   `formatted`  the same figure rendered with the Dubai conventions in
//                src/lib/format.ts, so a human reading the file sees
//                "AED 12,480,000" and "7.43%" rather than 12480000 and 0.0743
//
// A missing figure is an empty cell in both, never a zero. Same rule as the
// workbook, and for the same reason.

import { formatValue } from "../format.ts";
import type { ComputedValue, Format, ResolvedInput } from "../engine/types.ts";
import type { Value } from "../engine/expr.ts";
import type { ExportBundle } from "./workbook.ts";

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

const HEADERS = [
  "section",
  "group",
  "key",
  "label",
  "value",
  "formatted",
  "unit",
  "origin",
  "confidence",
  "source_document",
  "source_page",
  "note",
] as const;

/**
 * Excel and Sheets treat a leading =, +, @ or control character as the start of
 * a formula, so a deal named "=cmd|..." in a CSV is a code-execution vector on
 * whoever opens it. Prefixing with an apostrophe is the standard neutralisation
 * and is invisible once the file is open. A leading "-" is left alone: it is
 * far more often a negative number than an attack.
 */
function neutralise(value: string): string {
  return /^[=+@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";

  const text = neutralise(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(cells: Array<string | number | null | undefined>): string {
  return cells.map(cell).join(",");
}

/** The raw value column: numbers stay numbers, absent stays absent. */
function rawValue(value: Value): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

function displayValue(value: Value, format: Format | undefined, currency: string, precision?: number): string | null {
  if (value === null || value === undefined) return null;
  return formatValue(value, format, currency, precision);
}

function formatForInput(input: ResolvedInput): Format | undefined {
  if (input.format) return input.format;
  switch (input.type) {
    case "currency":
      return "currency";
    case "percent":
      return "percent";
    case "integer":
      return "integer";
    case "number":
      return "number";
    default:
      return undefined;
  }
}

export function buildCsv(bundle: ExportBundle): string {
  const currency = bundle.deal.currency;
  const docs = new Map(bundle.documents.map((d) => [d.id, d.filename]));
  const lines: string[] = [row([...HEADERS])];

  for (const input of bundle.result.inputs ?? []) {
    const format = formatForInput(input);
    lines.push(
      row([
        "input",
        input.group,
        input.key,
        input.label,
        rawValue(input.value),
        displayValue(input.value, format, currency),
        input.unit ?? null,
        // The provenance token, unmodified: "default" and "missing" are the
        // rows a reviewer has to look at before this goes anywhere.
        input.origin,
        typeof input.confidence === "number" ? input.confidence : null,
        input.sourceDocumentId ? (docs.get(input.sourceDocumentId) ?? input.sourceDocumentId) : null,
        typeof input.sourcePage === "number" ? input.sourcePage : null,
        null,
      ]),
    );
  }

  const computed: Array<[string, ComputedValue]> = [
    ...(bundle.result.lines ?? []).map((l): [string, ComputedValue] => ["line", l]),
    ...(bundle.result.returns ?? []).map((l): [string, ComputedValue] => ["return", l]),
  ];

  for (const [section, line] of computed) {
    lines.push(
      row([
        section,
        line.group,
        line.key,
        line.label,
        rawValue(line.value),
        displayValue(line.value, line.format, currency, line.precision),
        line.unit ?? null,
        "computed",
        null,
        null,
        null,
        line.error ?? null,
      ]),
    );
  }

  // A UTF-8 BOM: without it Excel on Windows opens the file as the system code
  // page and every em dash, × and Arabic deal name arrives as mojibake.
  // CRLF line endings for the same reason — RFC 4180, and what Excel expects.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
