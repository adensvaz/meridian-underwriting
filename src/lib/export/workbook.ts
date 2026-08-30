// The Excel export.
//
// An underwriting an analyst cannot get out of the tool is an underwriting they
// will redo by hand in Excel, and then the tool has cost them time rather than
// saved it. So this file has one job: produce a workbook an analyst forwards to
// an investment committee without editing it first.
//
// THE RULES THAT MAKE IT FORWARDABLE
//
//  1. Numbers are numbers. Every figure is written as a numeric cell with an
//     Excel number format on `z`, never a pre-formatted string. A yield stored
//     as 0.0743 with `0.00%` displays 7.43% AND sums, sorts and charts. A yield
//     stored as the string "7.43%" does none of those things.
//  2. Missing is not zero. A null renders as an empty cell. A zero in an IC
//     pack means "we read this figure and it was zero"; a blank means "nobody
//     ever found it". Collapsing the two is how a deal gets approved on a
//     service charge that was never in the documents.
//  3. Provenance travels with the numbers. The Inputs sheet carries origin,
//     confidence, source document and page for every input, so the committee
//     can see which figures were read and which were assumed.
//  4. No formula leaves the server. Same invariant as the API: the export
//     carries computed values, labels and units. It does not carry the model's
//     methodology as evaluable source.
//
// Dubai conventions match src/lib/format.ts: currency symbol first, negatives
// in accounting parentheses, areas in square feet.

import XLSX from "xlsx";
import type { CellObject, ColInfo, WorkBook, WorkSheet } from "xlsx";
import type {
  BenchmarkResult,
  ComputedValue,
  Format,
  ResolvedInput,
  RunResult,
} from "../engine/types.ts";
import type { Value } from "../engine/expr.ts";
import type { RentRollUnitRow, T12LineRow } from "../db/repo.ts";

// ------------------------------------------------------------------ inputs --

export interface ExportDeal {
  id: string;
  name: string;
  address?: string | null;
  community?: string | null;
  city?: string | null;
  country?: string | null;
  assetType?: string | null;
  tenure?: string | null;
  market?: string | null;
  currency: string;
  status?: string | null;
}

export interface ExportRun {
  id: string;
  createdAt: string;
  depth: string;
  modelName: string | null;
  modelKey: string | null;
  modelVersion: number | null;
  methodology?: string | null;
}

/** Mirrors NarrativeItem in src/lib/ai/narrative.ts without importing the AI layer. */
export interface ExportNarrativeItem {
  title: string;
  detail: string;
}

export interface ExportNarrative {
  engine?: string | null;
  status?: string | null;
  headline: string | null;
  summary: string | null;
  strengths: ExportNarrativeItem[];
  redFlags: ExportNarrativeItem[];
  ddItems: ExportNarrativeItem[];
}

export interface ExportDocumentRef {
  id: string;
  filename: string;
}

export interface ExportBundle {
  deal: ExportDeal;
  run: ExportRun;
  result: RunResult;
  units: RentRollUnitRow[];
  t12: T12LineRow[];
  narrative: ExportNarrative | null;
  documents: ExportDocumentRef[];
  /** ISO timestamp stamped on the Summary sheet. */
  generatedAt: string;
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------------------------------------------------------- number formats --

/**
 * A currency code goes straight into an Excel format string between quotes, and
 * the deal's currency is ultimately user-supplied. Anything that is not a plain
 * alphabetic code would either break the format or smuggle characters into it,
 * so it falls back to AED.
 */
function currencyToken(currency: string | null | undefined): string {
  const code = String(currency ?? "").trim().toUpperCase();
  return /^[A-Z]{2,6}$/.test(code) ? code : "AED";
}

function decimals(precision: number | undefined, fallback: number): string {
  const places = Number.isFinite(precision) ? Math.min(Math.max(precision as number, 0), 6) : fallback;
  return places > 0 ? `.${"0".repeat(places)}` : "";
}

/** Accounting parentheses for negatives, exactly as formatCurrency() renders them. */
export function currencyFormat(currency: string, precision = 0): string {
  const token = currencyToken(currency);
  const body = `"${token}"#,##0${decimals(precision, 0)}`;
  return `${body};(${body})`;
}

export const AREA_FORMAT = '#,##0" sqft"';
export const DATE_FORMAT = "dd/mm/yyyy";

/**
 * Format → Excel number format. The mapping deliberately parallels
 * formatValue() in src/lib/format.ts; the screen and the export must not
 * disagree about what a number means.
 */
export function numberFormat(
  format: Format | undefined,
  currency: string,
  precision?: number,
  value?: Value,
): string {
  switch (format) {
    case "currency":
    case "currency_compact":
      return currencyFormat(currency, precision ?? 0);
    case "percent":
      return `0${decimals(precision, 2)}%`;
    case "multiple":
    case "ratio":
      return `0${decimals(precision, 2)}"×"`;
    case "years":
      return `0${decimals(precision, 1)}" yrs"`;
    case "per_sqft":
      return `"${currencyToken(currency)}"#,##0${decimals(precision, 2)}"/sqft"`;
    case "integer":
      return "#,##0";
    case "number":
      return `#,##0${decimals(precision, 2)}`;
    default:
      // No declared format. Same conservative guess formatValue() makes: a
      // value strictly inside (-1, 1) that is not zero is a rate in this domain.
      if (typeof value === "number" && value !== 0 && Math.abs(value) < 1) return "0.00%";
      if (typeof value === "number" && Math.abs(value) >= 10_000) return "#,##0";
      return "#,##0.00";
  }
}

// ------------------------------------------------------------------- cells --

/** `null` means "write nothing at this address" — a blank cell, never a zero. */
type Cell = CellObject | null;
type Matrix = Cell[][];

function txt(value: string | null | undefined): Cell {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length ? { t: "s", v: s } : null;
}

function num(value: number | null | undefined, z?: string): Cell {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return z ? { t: "n", v: value, z } : { t: "n", v: value };
}

function bool(value: boolean | null | undefined): Cell {
  if (typeof value !== "boolean") return null;
  return { t: "s", v: value ? "Yes" : "No" };
}

/** A real date cell so Excel can sort and filter it; falls back to the raw text. */
function date(iso: string | null | undefined): Cell {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return txt(iso);
  return { t: "d", v: parsed, z: DATE_FORMAT };
}

/** The single dispatcher for an engine Value. Absent stays absent. */
function valueCell(
  value: Value,
  format: Format | undefined,
  currency: string,
  precision?: number,
): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return bool(value);
  if (typeof value === "string") return txt(value);
  if (!Number.isFinite(value)) return null;
  return num(value, numberFormat(format, currency, precision, value));
}

// ------------------------------------------------------------------ sheets --

interface SheetSpec {
  rows: Matrix;
  widths: number[];
  /** Top-left cell that stays visible; "A2" freezes the header row. */
  freeze?: string;
}

function sheetFrom(spec: SheetSpec): WorkSheet {
  const ws: WorkSheet = {};
  let maxCol = 0;

  for (let r = 0; r < spec.rows.length; r++) {
    const row = spec.rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      ws[XLSX.utils.encode_cell({ r, c })] = cell;
      if (c > maxCol) maxCol = c;
    }
  }

  const lastCol = Math.max(maxCol, spec.widths.length - 1, 0);
  const lastRow = Math.max(spec.rows.length - 1, 0);
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });
  ws["!cols"] = spec.widths.map((wch): ColInfo => ({ wch }));
  // SheetJS's community writer ignores this, so applyFreezePanes() below patches
  // the real <pane> element into the sheet XML afterwards. The property is still
  // set because it is the declaration of intent, and it is what the patcher reads.
  if (spec.freeze) (ws as Record<string, unknown>)["!freeze"] = spec.freeze;
  return ws;
}

/**
 * Removes C0 and C1 control characters — including CR, LF and NUL. Written as a
 * code-point filter rather than a regex so the source file never has to contain
 * a control character or a fragile escape for one.
 */
function stripControl(value: string, replacement = ""): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) ? replacement : char;
  }
  return out;
}

/** Excel forbids []:*?/\ in a sheet name and caps it at 31 characters. */
export function safeSheetName(name: string, fallback = "Sheet"): string {
  const cleaned = stripControl(String(name ?? ""))
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim();
  return cleaned.length ? cleaned : fallback;
}

// ---------------------------------------------------------------- filenames --

/**
 * The deal name is user-supplied and ends up in a Content-Disposition header.
 * Quotes would terminate the filename parameter, CR/LF would inject a header,
 * and path separators would suggest a directory to a careless client. All three
 * are removed rather than escaped.
 */
export function sanitiseFilename(name: string, fallback = "meridian-export"): string {
  // Control characters, including CR and LF, would inject a header.
  const cleaned = stripControl(String(name ?? ""), " ")
    // Path separators and the Windows-reserved set.
    .replace(/[/\\:*?<>|]/g, " ")
    // Every flavour of quote, straight and curly.
    .replace(/["'`‘’“”]/g, "")
    // Drop any token that is only dots. Path separators have already become
    // spaces, so "../../etc/passwd" is ".. .. etc passwd" by this point and a
    // single leading-dot strip would leave the second "..' behind.
    .replace(/(?:^|\s)\.+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides the file on Unix; a trailing dot is illegal on Windows.
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned.length ? cleaned : fallback;
}

/** ASCII-only fallback plus an RFC 5987 form, so Arabic deal names survive. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function exportFilename(dealName: string, extension: "xlsx" | "csv"): string {
  return `${sanitiseFilename(dealName)} underwriting.${extension}`;
}

// ------------------------------------------------------------------ lookups --

function indexComputed(result: RunResult): Map<string, ComputedValue> {
  const byKey = new Map<string, ComputedValue>();
  for (const line of [...(result.lines ?? []), ...(result.returns ?? [])]) {
    if (!byKey.has(line.key)) byKey.set(line.key, line);
  }
  for (const line of result.summary ?? []) {
    if (!byKey.has(line.key)) byKey.set(line.key, line);
  }
  return byKey;
}

/**
 * The headline band an investment committee looks for first. Models are free to
 * name their keys, so each metric lists the aliases the shipped models use and
 * the first one the run actually produced wins. A metric no model computed is
 * omitted rather than shown as a blank promise.
 */
const HEADLINE: Array<{ label: string; keys: string[]; format: Format }> = [
  { label: "Price per sqft", keys: ["price_per_sqft", "price_psf", "purchase_price_psf"], format: "per_sqft" },
  { label: "Purchase price", keys: ["purchase_price", "price", "all_in_cost", "total_cost"], format: "currency" },
  { label: "Annual rent", keys: ["annual_rent", "gross_rent", "contract_rent", "in_place_rent", "gross_potential_rent", "passing_rent"], format: "currency" },
  { label: "Gross yield", keys: ["gross_yield"], format: "percent" },
  { label: "Net yield", keys: ["net_yield", "net_initial_yield"], format: "percent" },
  { label: "NOI", keys: ["noi", "net_operating_income", "stabilised_noi"], format: "currency" },
  { label: "DSCR", keys: ["dscr", "dscr_year_1", "min_dscr"], format: "ratio" },
  { label: "Cash-on-cash", keys: ["cash_on_cash", "coc", "cash_on_cash_return"], format: "percent" },
  { label: "Payback", keys: ["payback", "payback_years", "payback_period"], format: "years" },
  { label: "IRR", keys: ["levered_irr", "irr", "unlevered_irr", "project_irr"], format: "percent" },
  { label: "Equity multiple", keys: ["equity_multiple", "moic", "em"], format: "multiple" },
];

// ------------------------------------------------------------------ builders --

function summarySheet(bundle: ExportBundle): WorkSheet {
  const { deal, run, result } = bundle;
  const currency = deal.currency;
  const computed = indexComputed(result);
  const inputsByKey = new Map((result.inputs ?? []).map((i) => [i.key, i]));
  const values = result.values ?? {};

  const rows: Matrix = [];
  const pair = (label: string, cell: Cell, note?: Cell): void => {
    rows.push([txt(label), cell, note ?? null]);
  };
  const blank = (): void => {
    rows.push([null, null, null]);
  };
  const section = (title: string): void => {
    blank();
    rows.push([txt(title), null, null]);
  };

  rows.push([txt("Meridian — underwriting export"), txt(deal.name), null]);

  section("Property");
  pair("Deal", txt(deal.name));
  pair("Address", txt(deal.address));
  pair("Community", txt(deal.community));
  pair("City", txt(deal.city));
  pair("Country", txt(deal.country));
  pair("Asset type", txt(deal.assetType));
  pair("Tenure", txt(deal.tenure));
  pair("Market", txt(deal.market));
  pair("Currency", txt(currency));
  pair("Status", txt(deal.status));

  section("Underwriting model");
  pair("Model", txt(run.modelName));
  pair("Model key", txt(run.modelKey));
  pair("Model version", num(run.modelVersion, "0"));
  pair("Depth", txt(run.depth));
  pair("Run ID", txt(run.id));
  pair("Run timestamp", date(run.createdAt));
  pair("Exported", date(bundle.generatedAt));

  section("Headline metrics");
  rows.push([txt("Metric"), txt("Value"), txt("Key")]);

  const shown = new Set<string>();
  for (const metric of HEADLINE) {
    const key = metric.keys.find(
      (k) => computed.has(k) || inputsByKey.has(k) || Object.hasOwn(values, k),
    );
    if (!key) continue;
    shown.add(key);

    const line = computed.get(key);
    const input = inputsByKey.get(key);
    const value: Value = line ? line.value : input ? input.value : (values[key] ?? null);
    const format = line?.format ?? input?.format ?? metric.format;
    pair(metric.label, valueCell(value, format, currency, line?.precision), txt(key));
  }

  // Anything the model itself nominated for its KPI band that the canonical
  // list did not already cover. A custom model's headline is still a headline.
  for (const line of result.summary ?? []) {
    if (shown.has(line.key)) continue;
    shown.add(line.key);
    pair(line.label, valueCell(line.value, line.format, currency, line.precision), txt(line.key));
  }

  const warnings = result.warnings ?? [];
  if (warnings.length) {
    section("Warnings");
    rows.push([txt("Level"), txt("Message"), txt("Input")]);
    for (const w of warnings) rows.push([txt(w.level), txt(w.message), txt(w.key ?? null)]);
  }

  if (run.methodology) {
    section("Methodology");
    rows.push([txt(run.methodology), null, null]);
  }

  return sheetFrom({ rows, widths: [28, 46, 26], freeze: "A2" });
}

function inputsSheet(bundle: ExportBundle): WorkSheet {
  const currency = bundle.deal.currency;
  const docs = new Map(bundle.documents.map((d) => [d.id, d.filename]));

  const rows: Matrix = [
    [
      txt("Group"), txt("Label"), txt("Key"), txt("Value"), txt("Unit"), txt("Type"),
      txt("Origin"), txt("Confidence"), txt("Source document"), txt("Page"), txt("Source snippet"),
    ],
  ];

  for (const input of bundle.result.inputs ?? []) {
    rows.push([
      txt(input.group),
      txt(input.label),
      txt(input.key),
      valueCell(input.value, formatForInput(input), currency),
      txt(input.unit ?? null),
      txt(input.type),
      // The raw provenance token, not a prettified one: an analyst filters this
      // column to "default" and "missing" to find every number nobody read.
      txt(input.origin),
      num(typeof input.confidence === "number" ? input.confidence : null, "0%"),
      txt(input.sourceDocumentId ? (docs.get(input.sourceDocumentId) ?? input.sourceDocumentId) : null),
      num(typeof input.sourcePage === "number" ? input.sourcePage : null, "0"),
      txt(input.sourceSnippet ?? null),
    ]);
  }

  return sheetFrom({
    rows,
    widths: [18, 32, 24, 18, 12, 11, 11, 12, 30, 7, 60],
    freeze: "A2",
  });
}

/** An input carries a display format only sometimes; its type is the fallback. */
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

function underwritingSheet(bundle: ExportBundle): WorkSheet {
  const currency = bundle.deal.currency;
  const rows: Matrix = [[txt("Label"), txt("Key"), txt("Value"), txt("Unit"), txt("Note")]];

  // Declaration order is preserved exactly; a group header is emitted whenever
  // the group changes. A model that interleaves groups therefore gets two
  // blocks with the same name, which is the honest rendering of its own order.
  let currentGroup: string | null = null;
  const all: ComputedValue[] = [...(bundle.result.lines ?? []), ...(bundle.result.returns ?? [])];

  for (const line of all) {
    const group = line.group ?? "";
    if (group !== currentGroup) {
      currentGroup = group;
      if (rows.length > 1) rows.push([null, null, null, null, null]);
      rows.push([txt(group || "Ungrouped"), null, null, null, null]);
    }
    rows.push([
      txt(line.label),
      txt(line.key),
      valueCell(line.value, line.format, currency, line.precision),
      txt(line.unit ?? null),
      txt(line.error ?? null),
    ]);
  }

  return sheetFrom({ rows, widths: [38, 26, 20, 12, 46], freeze: "A2" });
}

function projectionSheet(bundle: ExportBundle): WorkSheet | null {
  const projection = bundle.result.projection;
  if (!projection) return null;

  const currency = bundle.deal.currency;
  const years = Math.max(
    projection.years ?? 0,
    ...projection.rows.map((r) => r.values.length),
    0,
  );

  const header: Matrix[number] = [txt("Line"), txt("Unit")];
  for (let y = 1; y <= years; y++) header.push(txt(`Year ${y}`));
  const rows: Matrix = [header];

  for (const row of projection.rows) {
    const cells: Matrix[number] = [txt(row.label), txt(row.unit ?? null)];
    for (let y = 0; y < years; y++) {
      cells.push(valueCell(row.values[y] ?? null, row.format, currency, row.precision));
    }
    rows.push(cells);
  }

  return sheetFrom({
    rows,
    widths: [34, 12, ...Array.from({ length: years }, () => 16)],
    freeze: "A2",
  });
}

function rentRollSheet(bundle: ExportBundle): WorkSheet {
  const currency = bundle.deal.currency;
  const money = currencyFormat(currency, 0);

  const rows: Matrix = [
    [
      txt("Unit"), txt("Type"), txt("Beds"), txt("Baths"), txt("Area"),
      txt("In-place rent"), txt("Market rent"), txt("Cheques"),
      txt("Lease start"), txt("Lease end"), txt("Ejari"), txt("Status"),
    ],
  ];

  let area = 0;
  let inPlace = 0;
  let market = 0;
  let hasArea = false;
  let hasInPlace = false;
  let hasMarket = false;

  for (const unit of bundle.units) {
    if (typeof unit.area_sqft === "number") {
      area += unit.area_sqft;
      hasArea = true;
    }
    if (typeof unit.in_place_rent === "number") {
      inPlace += unit.in_place_rent;
      hasInPlace = true;
    }
    if (typeof unit.market_rent === "number") {
      market += unit.market_rent;
      hasMarket = true;
    }

    rows.push([
      txt(unit.unit_no),
      txt(unit.unit_type),
      num(unit.beds, "0.#"),
      num(unit.baths, "0.#"),
      num(unit.area_sqft, AREA_FORMAT),
      num(unit.in_place_rent, money),
      num(unit.market_rent, money),
      num(unit.cheques, "0"),
      date(unit.lease_start),
      date(unit.lease_end),
      txt(unit.ejari_no),
      txt(unit.occupancy_status),
    ]);
  }

  // The totals row foots against the units above it, and stays blank rather
  // than printing zero for a column in which nothing was ever recorded.
  rows.push([
    txt(`Total — ${bundle.units.length} unit${bundle.units.length === 1 ? "" : "s"}`),
    null,
    null,
    null,
    hasArea ? num(area, AREA_FORMAT) : null,
    hasInPlace ? num(inPlace, money) : null,
    hasMarket ? num(market, money) : null,
    null,
    null,
    null,
    null,
    null,
  ]);

  return sheetFrom({
    rows,
    widths: [12, 12, 7, 7, 14, 18, 18, 10, 13, 13, 20, 12],
    freeze: "A2",
  });
}

function t12Sheet(bundle: ExportBundle): WorkSheet {
  const currency = bundle.deal.currency;
  const money = currencyFormat(currency, 0);

  const rows: Matrix = [
    [
      txt("Line"), txt("Section"), txt("Category"), txt("Amount"),
      txt("Months"), txt("Annualised"), txt("In NOI"), txt("Exclusion reason"),
    ],
  ];

  let includedAmount = 0;
  let includedAnnual = 0;
  let allAmount = 0;
  let allAnnual = 0;

  for (const line of bundle.t12) {
    const included = line.is_recurring === 1 && !line.exclude_reason;
    if (typeof line.amount === "number") {
      allAmount += line.amount;
      if (included) includedAmount += line.amount;
    }
    if (typeof line.annualized === "number") {
      allAnnual += line.annualized;
      if (included) includedAnnual += line.annualized;
    }

    rows.push([
      txt(line.raw_label),
      txt(line.section),
      txt(line.category),
      num(line.amount, money),
      num(line.months_covered, "0"),
      num(line.annualized, money),
      txt(included ? "Yes" : "No"),
      txt(line.exclude_reason),
    ]);
  }

  if (bundle.t12.length) {
    rows.push([
      txt("Total — included in NOI"), null, null,
      num(includedAmount, money), null, num(includedAnnual, money), null, null,
    ]);
    rows.push([
      txt("Total — all statement lines"), null, null,
      num(allAmount, money), null, num(allAnnual, money), null, null,
    ]);
  }

  return sheetFrom({ rows, widths: [42, 14, 22, 18, 9, 18, 9, 52], freeze: "A2" });
}

function analysisSheet(bundle: ExportBundle): WorkSheet {
  const rows: Matrix = [[txt("Section"), txt("Item"), txt("Detail")]];
  const narrative = bundle.narrative;

  if (narrative) {
    rows.push([txt("Headline"), txt(narrative.headline), null]);
    rows.push([txt("Summary"), null, txt(narrative.summary)]);
    rows.push([
      txt("Written by"),
      txt(narrative.engine === "ai" ? "AI narrative" : "Deterministic rules engine"),
      txt(narrative.status && narrative.status !== "ok" ? `status: ${narrative.status}` : null),
    ]);
    rows.push([null, null, null]);

    const block = (label: string, items: ExportNarrativeItem[]): void => {
      for (const item of items ?? []) {
        rows.push([txt(label), txt(item?.title ?? null), txt(item?.detail ?? null)]);
      }
    };
    block("Strength", narrative.strengths);
    block("Red flag", narrative.redFlags);
    block("Due diligence", narrative.ddItems);
  } else {
    rows.push([
      txt("Analysis"),
      txt("No write-up has been generated for this run"),
      txt("Generate the analysis in Meridian and export again."),
    ]);
  }

  // The deterministic flags the engine fired. These are the established facts
  // the write-up was built on, so they belong in the same pack.
  const flags = bundle.result.flags ?? [];
  if (flags.length) {
    rows.push([null, null, null]);
    for (const flag of flags) {
      rows.push([txt(`Flag (${flag.severity})`), txt(flag.title), txt(flag.detail)]);
    }
  }

  return sheetFrom({ rows, widths: [20, 48, 110], freeze: "A2" });
}

function benchmarksSheet(bundle: ExportBundle): WorkSheet {
  const currency = bundle.deal.currency;
  const grading: Record<BenchmarkResult["status"], string> = {
    good: "Pass",
    warn: "Warn",
    bad: "Fail",
    unknown: "Not assessed",
  };

  const rows: Matrix = [
    [
      txt("Metric"), txt("Value"), txt("Target"), txt("Tolerance"),
      txt("Direction"), txt("Grading"), txt("Note"),
    ],
  ];

  for (const b of bundle.result.benchmarks ?? []) {
    rows.push([
      txt(b.label),
      valueCell(b.value, b.format, currency, b.precision),
      valueCell(b.good, b.format, currency, b.precision),
      valueCell(b.warn, b.format, currency, b.precision),
      txt(b.direction === "higher" ? "Higher is better" : "Lower is better"),
      txt(grading[b.status] ?? "Not assessed"),
      txt(b.note ?? null),
    ]);
  }

  if (!(bundle.result.benchmarks ?? []).length) {
    rows.push([txt("This model declares no benchmarks."), null, null, null, null, null, null]);
  }

  return sheetFrom({ rows, widths: [30, 16, 16, 16, 18, 14, 60], freeze: "A2" });
}

// ------------------------------------------------------------------- output --

/**
 * The workbook object, before serialisation. Exported so tests can inspect the
 * sheet properties (`!cols`, `!freeze`) the binary format hides.
 */
export function buildWorkbookModel(bundle: ExportBundle): WorkBook {
  const wb = XLSX.utils.book_new();

  const sheets: Array<[string, WorkSheet | null]> = [
    ["Summary", summarySheet(bundle)],
    ["Inputs", inputsSheet(bundle)],
    ["Underwriting", underwritingSheet(bundle)],
    ["Projection", projectionSheet(bundle)],
    ["Rent roll", rentRollSheet(bundle)],
    ["T12", t12Sheet(bundle)],
    ["Analysis", analysisSheet(bundle)],
    ["Benchmarks", benchmarksSheet(bundle)],
  ];

  for (const [name, ws] of sheets) {
    if (!ws) continue;
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
  }

  return wb;
}

export function buildWorkbook(bundle: ExportBundle): Buffer {
  const wb = buildWorkbookModel(bundle);
  const written = XLSX.write(wb, {
    type: "buffer",
    bookType: "xlsx",
    cellDates: true,
    compression: true,
  }) as Buffer;
  return applyFreezePanes(wb, Buffer.isBuffer(written) ? written : Buffer.from(written));
}

/**
 * SheetJS's community writer emits `<sheetView>` with no `<pane>`, so `!freeze`
 * has no effect on the file it produces. A frozen header row is not decoration
 * on a 300-row rent roll — it is the difference between a usable sheet and a
 * scroll puzzle — so the pane element is patched into the sheet XML afterwards.
 *
 * This is cosmetic, so any failure returns the unpatched workbook rather than
 * failing the export.
 */
function applyFreezePanes(wb: WorkBook, buffer: Buffer): Buffer {
  try {
    const CFB = (XLSX as unknown as { CFB?: Record<string, never> }).CFB as
      | {
          read: (d: Buffer, o: { type: string }) => unknown;
          find: (c: unknown, p: string) => { content: Uint8Array } | null;
          write: (c: unknown, o: { type: string; fileType: string }) => Buffer;
          utils: { cfb_add: (c: unknown, p: string, d: Buffer) => void };
        }
      | undefined;
    if (!CFB) return buffer;

    const frozen = wb.SheetNames.map((name, index) => ({
      index,
      freeze: (wb.Sheets[name] as Record<string, unknown>)["!freeze"] as string | undefined,
    })).filter((s) => typeof s.freeze === "string");
    if (!frozen.length) return buffer;

    const container = CFB.read(buffer, { type: "buffer" });
    let patched = 0;

    for (const sheet of frozen) {
      const path = `/xl/worksheets/sheet${sheet.index + 1}.xml`;
      const entry = CFB.find(container, path);
      if (!entry?.content) continue;

      const xml = Buffer.from(entry.content).toString("utf8");
      if (xml.includes("<pane ")) continue;

      const cell = XLSX.utils.decode_cell(sheet.freeze as string);
      const attrs = [
        cell.c > 0 ? `xSplit="${cell.c}"` : "",
        cell.r > 0 ? `ySplit="${cell.r}"` : "",
        `topLeftCell="${sheet.freeze}"`,
        `activePane="${cell.c > 0 ? "bottomRight" : "bottomLeft"}"`,
        'state="frozen"',
      ]
        .filter(Boolean)
        .join(" ");
      const pane = `<pane ${attrs}/><selection pane="${cell.c > 0 ? "bottomRight" : "bottomLeft"}" activeCell="${sheet.freeze}" sqref="${sheet.freeze}"/>`;

      const replaced = xml.replace(
        /<sheetView([^>]*?)\/>/,
        (_match, sheetAttrs: string) => `<sheetView${sheetAttrs}>${pane}</sheetView>`,
      );
      if (replaced === xml) continue;

      CFB.utils.cfb_add(container, path, Buffer.from(replaced, "utf8"));
      patched++;
    }

    if (!patched) return buffer;
    const out = CFB.write(container, { type: "buffer", fileType: "zip" });
    return Buffer.isBuffer(out) ? out : Buffer.from(out as unknown as ArrayBuffer);
  } catch (err) {
    console.error("[export] could not apply freeze panes", err);
    return buffer;
  }
}
