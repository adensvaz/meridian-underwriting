// Table-shape helpers shared by the sheet, PDF and DOCX parsers, and consumed
// by the AI extraction layer downstream.
//
// Three jobs:
//
//   1. Find the real header row. Rent rolls and T12s exported from Yardi, MRI,
//      or somebody's hand-built Excel almost never start at A1 — there is a
//      property banner, a date stamp and a blank row above the thing you want.
//   2. Guess what each column means, using vocabulary from BOTH markets. A
//      Dubai rent roll says "Ejari", "No. of Cheques" and "BUA"; a US one says
//      "Lease Expiration", "Market Rent" and "Charge Code".
//   3. Turn a cell into a number without ever inventing one. `parseNumber`
//      returns null rather than 0 or NaN, because a silent zero in an
//      underwriting input is indistinguishable from a real zero and will be
//      quietly averaged into a cap rate.

export type ColumnRole =
  | "unit_no"
  | "unit_type"
  | "beds"
  | "area_sqft"
  | "annual_rent"
  | "monthly_rent"
  | "cheques"
  | "lease_start"
  | "lease_end"
  | "ejari"
  | "tenant"
  | "status"
  | "label"
  | "amount"
  | "month"
  | "total"
  | "unknown";

export interface ColumnClassification {
  index: number;
  /** The header cell as it appeared, trimmed. */
  header: string;
  /** Lower-case, punctuation-flattened form used for matching. */
  normalized: string;
  role: ColumnRole;
  confidence: number;
  /** "header-exact" | "header-phrase" | "content" | "none". */
  evidence: string;
}

export interface InferredHeaders {
  /** -1 when no row in the sample looks like a header. */
  headerRowIndex: number;
  /** Snake-case, de-duplicated column keys. Always one per column. */
  headers: string[];
  /** The header cells exactly as they appeared. */
  raw: string[];
}

// ---------------------------------------------------------------- numbers --

const ARABIC_INDIC_START = 0x0660; // ٠..٩
const EXT_ARABIC_INDIC_START = 0x06f0; // ۰..۹

/** Spaces that Excel, Word and Arabic locales use as thousands separators. */
const INVISIBLE_SPACES = /[   -​  ⁠　﻿]/g;

const NOT_A_NUMBER = new Set([
  "",
  "-",
  "--",
  "---",
  "–",
  "—",
  ".",
  "n/a",
  "na",
  "n.a.",
  "n.a",
  "nil",
  "none",
  "null",
  "nan",
  "tbd",
  "tba",
  "unknown",
  "vacant",
  "#n/a",
  "#value!",
  "#ref!",
  "#div/0!",
  "#name?",
  "#num!",
  "#null!",
]);

const CURRENCY_TOKENS =
  /\b(aed|dhs?|usd|us\$|eur|gbp|sar|qar|kwd|omr|bhd|egp|inr|jpy|chf|cad|aud)\b/gi;
const CURRENCY_SYMBOLS = /[$£€¥₹﷼]|د\.?إ|ر\.?س/g;
const TRAILING_UNITS =
  /\b(sq\s*\.?\s*(ft|feet|f|m|metres|meters)|sqft|sqm|sf|ft2|m2|psf|pa|p\.a\.|per\s+annum|per\s+year|per\s+month|per\s+sqft|yr|year|month|mo)\b\.?/gi;

const MAGNITUDES: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  mn: 1e6,
  mm: 1e6,
  b: 1e9,
  bn: 1e9,
};

export interface ParseNumberOptions {
  /**
   * When true (the default) "6.5%" becomes 0.065, which is what an
   * underwriting model wants to multiply by. Set false to get 6.5.
   */
  percentAsFraction?: boolean;
}

/** Normalise Arabic-Indic digits and separators into their ASCII equivalents. */
export function normaliseDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code >= ARABIC_INDIC_START && code <= ARABIC_INDIC_START + 9) {
      out += String(code - ARABIC_INDIC_START);
    } else if (code >= EXT_ARABIC_INDIC_START && code <= EXT_ARABIC_INDIC_START + 9) {
      out += String(code - EXT_ARABIC_INDIC_START);
    } else if (code === 0x066b) {
      out += "."; // Arabic decimal separator
    } else if (code === 0x066c || code === 0x060c) {
      out += ","; // Arabic thousands separator / Arabic comma
    } else if (code === 0x2212 || code === 0x2013 || code === 0x2014) {
      out += "-"; // minus sign, en dash, em dash
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Turn a spreadsheet or PDF cell into a number, or null.
 *
 * Never returns NaN and never returns a silent 0 for unparseable input — a
 * null propagates as "we did not find this" all the way to the review screen,
 * where a human can fill it in.
 */
export function parseNumber(raw: unknown, opts?: ParseNumberOptions): number | null {
  const percentAsFraction = opts?.percentAsFraction !== false;

  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return null;
  if (raw instanceof Date) return null;

  let s = normaliseDigits(String(raw)).replace(INVISIBLE_SPACES, "").trim();
  if (s === "") return null;
  if (NOT_A_NUMBER.has(s.toLowerCase())) return null;

  let sign = 1;

  // Accounting parentheses: (4,200) is -4200.
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    sign = -1;
    s = paren[1]!.trim();
  }

  // Percent, before currency stripping so "%" is not mistaken for a unit.
  let isPercent = false;
  const pct = s.match(/^(.*?)\s*(%|percent|pct)$/i);
  if (pct) {
    isPercent = true;
    s = pct[1]!.trim();
  }

  s = s.replace(CURRENCY_TOKENS, " ").replace(CURRENCY_SYMBOLS, " ").trim();
  s = s.replace(TRAILING_UNITS, " ").trim();
  s = s.replace(/\s*\/\s*(yr|year|annum|month|mo|sqft|sq\s*ft|sf)\b\.?/gi, " ").trim();

  // Leading or trailing sign, including the accounting trailing minus.
  const lead = s.match(/^([+-])\s*(.*)$/);
  if (lead) {
    if (lead[1] === "-") sign = -sign;
    s = lead[2]!.trim();
  }
  const trail = s.match(/^(.*?)\s*-$/);
  if (trail && /\d/.test(trail[1] ?? "")) {
    sign = -sign;
    s = trail[1]!.trim();
  }

  if (s === "" || NOT_A_NUMBER.has(s.toLowerCase())) return null;

  // Magnitude suffix: 1.2M, 850k, 1.4bn.
  let magnitude = 1;
  const mag = s.match(/^(.*?)\s*(mn|bn|mm|[kmb])$/i);
  if (mag && /\d/.test(mag[1] ?? "")) {
    const factor = MAGNITUDES[mag[2]!.toLowerCase()];
    if (factor !== undefined) {
      magnitude = factor;
      s = mag[1]!.trim();
    }
  }

  s = s.replace(/\s+/g, "");
  if (s === "") return null;
  // Anything alphabetic left over means this was never a number ("3 bedrooms",
  // "see note", "Q1 2024"). Refuse rather than salvage a digit out of it.
  if (/[^\d.,]/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal point.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastDot !== -1 && /^\d{1,3}(\.\d{3})+$/.test(s) && s.length > 5) {
    // 1.250.000 — European thousands grouping, no decimal part.
    s = s.replace(/\./g, "");
  }

  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  let out = sign * value * magnitude;
  if (isPercent && percentAsFraction) out = out / 100;
  return Number.isFinite(out) ? out : null;
}

// ---------------------------------------------------------------- headers --

/** Lower-case, strip punctuation to spaces, collapse runs. */
export function normaliseHeader(value: unknown): string {
  return normaliseDigits(String(value ?? ""))
    .replace(INVISIBLE_SPACES, " ")
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toKey(value: string, fallbackIndex: number): string {
  const key = normaliseHeader(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return key === "" ? `col_${fallbackIndex + 1}` : key;
}

const DATE_LIKE =
  /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s*[-/ ]\s*[a-z]{3,9}\s*[-/ ]\s*\d{2,4}|[a-z]{3,9}\s+\d{1,2},?\s*\d{4})/i;

const MONTH_WORDS =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i;

function isDateLike(value: string): boolean {
  const s = value.trim();
  if (s === "") return false;
  if (DATE_LIKE.test(s)) return true;
  return /^\d{4}-\d{2}-\d{2}T/.test(s);
}

function isNumericLike(value: string): boolean {
  return parseNumber(value) !== null;
}

function rowCells(rows: string[][], index: number): string[] {
  return rows[index] ?? [];
}

function nonEmpty(cells: string[]): string[] {
  return cells.filter((c) => String(c ?? "").trim() !== "");
}

/**
 * Score every row in the first `limit` rows and return the most header-like.
 *
 * A header row is: several non-empty cells, most of them short distinct text
 * rather than numbers or dates, and followed by rows that are mostly numeric.
 * The "distinct" term is what stops an unmerged banner ("SUNRISE TOWER"
 * splashed across A1:F1) from beating the real header underneath it.
 */
export function detectHeaderRow(rows: string[][], limit = 25): number {
  if (!Array.isArray(rows) || rows.length === 0) return -1;
  const scanned = Math.min(limit, rows.length);

  let bestIndex = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < scanned; i++) {
    const cells = rowCells(rows, i).map((c) => String(c ?? "").trim());
    const filled = nonEmpty(cells);
    if (filled.length < 2) continue;

    const textCells = filled.filter(
      (c) => c.length <= 60 && !isNumericLike(c) && !isDateLike(c),
    );
    const textRatio = textCells.length / filled.length;
    if (textRatio < 0.5) continue;

    const distinctRatio = new Set(filled.map((c) => c.toLowerCase())).size / filled.length;

    // How numeric is the body underneath?
    let bodyCells = 0;
    let bodyNumeric = 0;
    let bodyRowsSeen = 0;
    for (let j = i + 1; j < rows.length && bodyRowsSeen < 8; j++) {
      const below = nonEmpty(rowCells(rows, j).map((c) => String(c ?? "").trim()));
      if (below.length === 0) continue;
      bodyRowsSeen++;
      for (const cell of below) {
        bodyCells++;
        if (isNumericLike(cell) || isDateLike(cell)) bodyNumeric++;
      }
    }
    const bodyNumericRatio = bodyCells === 0 ? 0 : bodyNumeric / bodyCells;

    // Width relative to the widest row: a real header spans the table.
    const widest = Math.max(...rows.slice(0, Math.min(rows.length, 200)).map((r) => nonEmpty(r).length), 1);
    const widthRatio = filled.length / widest;

    const score =
      textRatio * 8 +
      distinctRatio * 7 +
      bodyNumericRatio * 9 +
      widthRatio * 5 +
      Math.min(filled.length, 12) * 0.25 -
      i * 0.2 -
      (bodyRowsSeen === 0 ? 4 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/** Detected header row plus normalised, unique column keys. */
export function inferHeaders(rows: string[][]): InferredHeaders {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { headerRowIndex: -1, headers: [], raw: [] };
  }
  const headerRowIndex = detectHeaderRow(rows);
  const width = rows.reduce((max, r) => Math.max(max, r?.length ?? 0), 0);
  const raw: string[] = [];
  for (let c = 0; c < width; c++) {
    raw.push(headerRowIndex >= 0 ? String(rows[headerRowIndex]?.[c] ?? "").trim() : "");
  }

  const seen = new Map<string, number>();
  const headers = raw.map((value, index) => {
    const base = toKey(value, index);
    const hits = seen.get(base) ?? 0;
    seen.set(base, hits + 1);
    return hits === 0 ? base : `${base}_${hits + 1}`;
  });

  return { headerRowIndex, headers, raw };
}

// ------------------------------------------------------------ classifying --

/**
 * Ordered most-specific-first. Order is load-bearing: "Monthly Rent" must be
 * tested before "Rent", "Plot Area" before "Total", "Unit Type" before "Unit".
 */
const ROLE_SYNONYMS: Array<[ColumnRole, string[]]> = [
  [
    "ejari",
    [
      "ejari", "ejari no", "ejari number", "ejari ref", "ejari contract", "ejari contract no",
      "tenancy contract no", "tenancy contract number", "contract no", "contract number",
      "contract ref", "lease no", "lease number", "lease id",
    ],
  ],
  [
    "cheques",
    [
      "cheques", "cheque", "checks", "check", "no of cheques", "no of cheque", "num of cheques",
      "number of cheques", "no of checks", "number of checks", "cheque count", "payments",
      "installments", "instalments", "payment terms", "payment mode", "mode of payment",
      "no of payments", "no of instalments", "no of installments",
    ],
  ],
  [
    "beds",
    [
      "beds", "bed", "bedroom", "bedrooms", "no of bedrooms", "number of bedrooms", "br",
      "bhk", "bed count", "bedroom count", "no of beds",
    ],
  ],
  [
    "area_sqft",
    [
      "area", "area sqft", "area sq ft", "area sqm", "sq ft", "sqft", "sq feet", "square feet",
      "square foot", "sq m", "sqm", "square meters", "square metres", "sq mtr", "sf", "sqf",
      "size", "unit size", "bua", "built up area", "built up", "gfa", "gla", "nla",
      "suite area", "plot area", "net area", "gross area", "carpet area", "leasable area",
      "rentable area", "usable area", "floor area", "m2", "ft2",
    ],
  ],
  [
    "monthly_rent",
    [
      "monthly rent", "rent monthly", "rent per month", "rent month", "month rent",
      "monthly rate", "monthly rental", "monthly income", "per month rent", "rent pm",
      "rent p m", "monthly",
    ],
  ],
  [
    "annual_rent",
    [
      "annual rent", "annual rent aed", "rent aed", "rent", "yearly rent", "rent per annum",
      "rent pa", "rent p a", "annual rental", "annual rate", "annual income", "contract rent",
      "contract value", "annual contract value", "in place rent", "inplace rent",
      "current rent", "passing rent", "market rent", "asking rent", "base rent",
      "face rent", "rental income", "rent amount", "gross rent", "net rent", "rent roll",
    ],
  ],
  [
    "lease_start",
    [
      "lease start", "lease start date", "start date", "start", "commencement",
      "commencement date", "lease commencement", "contract start", "contract start date",
      "tenancy start", "from", "from date", "date from", "occupancy date", "move in",
      "move in date",
    ],
  ],
  [
    "lease_end",
    [
      "lease end", "lease end date", "end date", "end", "expiry", "expiry date",
      "expiration", "expiration date", "lease expiry", "lease expiration", "contract end",
      "contract end date", "contract expiry", "tenancy end", "to", "to date", "date to",
      "expires", "move out", "move out date", "termination date",
    ],
  ],
  [
    "unit_type",
    [
      "unit type", "type", "apartment type", "property type", "layout", "config",
      "configuration", "unit category", "bedroom type", "floor plan", "plan", "typology",
      "unit mix",
    ],
  ],
  [
    "unit_no",
    [
      "unit", "unit no", "unit number", "unit id", "unit ref", "unit code", "apt", "apt no",
      "apartment", "apartment no", "apartment number", "flat", "flat no", "flat number",
      "suite", "suite no", "suite number", "villa", "villa no", "shop", "shop no",
      "premises", "premise no", "door", "door no", "space", "space no", "property no",
      "room", "room no",
    ],
  ],
  [
    "tenant",
    [
      "tenant", "tenant name", "tenants", "lessee", "lessee name", "occupant",
      "occupant name", "resident", "resident name", "customer", "customer name",
      "company", "company name", "name",
    ],
  ],
  [
    "status",
    [
      "status", "unit status", "lease status", "occupancy", "occupancy status", "occupied",
      "vacancy", "vacancy status", "availability", "available", "state",
    ],
  ],
  [
    "month",
    [
      "month", "months", "mth", "period", "jan", "feb", "mar", "apr", "may", "jun", "jul",
      "aug", "sep", "sept", "oct", "nov", "dec", "january", "february", "march", "april",
      "june", "july", "august", "september", "october", "november", "december",
    ],
  ],
  [
    "total",
    [
      "total", "totals", "grand total", "sub total", "subtotal", "ttl", "sum", "year total",
      "annual total", "full year", "t12", "ttm", "trailing 12", "trailing twelve",
      "trailing 12 months", "12 month total", "ytd total",
    ],
  ],
  [
    "amount",
    [
      "amount", "amount aed", "amt", "value", "actual", "actuals", "balance", "cost",
      "expense", "expenses", "income", "revenue", "budget", "variance", "ytd", "mtd",
      "net", "gross", "aed", "usd", "figure", "per unit", "per sqft", "psf",
    ],
  ],
  [
    "label",
    [
      "label", "description", "desc", "account", "account name", "account description",
      "account no", "gl", "gl account", "gl code", "line item", "item", "particulars",
      "charge code", "charge", "category", "chart of accounts", "coa", "detail",
      "details", "line", "narrative",
    ],
  ],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PHRASE_CACHE = new Map<string, RegExp>();
function phraseRegExp(pattern: string): RegExp {
  let re = PHRASE_CACHE.get(pattern);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${escapeRegExp(pattern)}(?:\\s|$)`);
    PHRASE_CACHE.set(pattern, re);
  }
  return re;
}

/** Header-text match only. Exposed so callers can classify a lone label. */
export function classifyHeaderText(header: string): { role: ColumnRole; confidence: number; evidence: string } {
  const normalized = normaliseHeader(header);
  if (normalized === "") return { role: "unknown", confidence: 0, evidence: "none" };

  for (const [role, patterns] of ROLE_SYNONYMS) {
    for (const pattern of patterns) {
      if (normalized === pattern) {
        return { role, confidence: 0.95, evidence: "header-exact" };
      }
    }
  }
  for (const [role, patterns] of ROLE_SYNONYMS) {
    for (const pattern of patterns) {
      if (phraseRegExp(pattern).test(normalized)) {
        return { role, confidence: 0.8, evidence: "header-phrase" };
      }
    }
  }
  // "Jan-24", "FY2024 Mar" and friends never survive word-boundary matching.
  if (MONTH_WORDS.test(normalized) || /^(fy)?\s*\d{4}\s*\d{0,2}$/.test(normalized)) {
    return { role: "month", confidence: 0.7, evidence: "header-phrase" };
  }
  return { role: "unknown", confidence: 0, evidence: "none" };
}

interface ColumnSample {
  values: string[];
  numeric: number;
  dates: number;
  months: number;
  currency: number;
  text: number;
  distinct: number;
}

function sampleColumn(rows: string[][], headerRowIndex: number, col: number, max = 40): ColumnSample {
  const values: string[] = [];
  for (let r = headerRowIndex + 1; r < rows.length && values.length < max; r++) {
    const cell = String(rows[r]?.[col] ?? "").trim();
    if (cell !== "") values.push(cell);
  }
  let numeric = 0;
  let dates = 0;
  let months = 0;
  let currency = 0;
  let text = 0;
  for (const v of values) {
    if (isDateLike(v)) dates++;
    else if (isNumericLike(v)) {
      numeric++;
      if (/[$£€]|aed|dhs?\b/i.test(v)) currency++;
    } else if (MONTH_WORDS.test(v) && v.length <= 20) months++;
    else text++;
  }
  return { values, numeric, dates, months, currency, text, distinct: new Set(values).size };
}

/**
 * Guess a semantic role for every column.
 *
 * Header text is trusted first. When the header is blank or unrecognised the
 * cell content is inspected, which is what rescues the many rent rolls whose
 * header row is an image, a merged banner, or simply missing.
 */
export function classifyColumns(rows: string[][], headerRowIndex: number): ColumnClassification[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const width = rows.reduce((max, r) => Math.max(max, r?.length ?? 0), 0);
  const headerRow = headerRowIndex >= 0 ? rows[headerRowIndex] ?? [] : [];

  const out: ColumnClassification[] = [];
  let dateColumnsSeen = 0;

  for (let c = 0; c < width; c++) {
    const header = String(headerRow[c] ?? "").trim();
    const normalized = normaliseHeader(header);
    const byHeader = classifyHeaderText(header);

    if (byHeader.role !== "unknown") {
      if (byHeader.role === "lease_start" || byHeader.role === "lease_end") dateColumnsSeen++;
      out.push({
        index: c,
        header,
        normalized,
        role: byHeader.role,
        confidence: byHeader.confidence,
        evidence: byHeader.evidence,
      });
      continue;
    }

    // ---- content fallback ------------------------------------------------
    const sample = sampleColumn(rows, headerRowIndex, c);
    const n = sample.values.length;
    let role: ColumnRole = "unknown";
    let confidence = 0;
    let evidence = "none";

    if (n >= 2) {
      const dateRatio = sample.dates / n;
      const numericRatio = sample.numeric / n;
      const monthRatio = sample.months / n;
      const textRatio = sample.text / n;

      if (dateRatio >= 0.6) {
        role = dateColumnsSeen === 0 ? "lease_start" : "lease_end";
        dateColumnsSeen++;
        confidence = 0.45;
        evidence = "content";
      } else if (monthRatio >= 0.6) {
        role = "month";
        confidence = 0.45;
        evidence = "content";
      } else if (numericRatio >= 0.7) {
        const magnitudes = sample.values.map((v) => parseNumber(v)).filter((v): v is number => v !== null);
        const median = magnitudes.slice().sort((a, b) => a - b)[Math.floor(magnitudes.length / 2)] ?? 0;
        if (sample.currency / Math.max(sample.numeric, 1) >= 0.5 || Math.abs(median) >= 1000) {
          role = "amount";
          confidence = 0.4;
          evidence = "content";
        }
      } else if (
        textRatio >= 0.7 &&
        sample.distinct / n >= 0.8 &&
        sample.values.every((v) => v.length <= 12) &&
        sample.values.filter((v) => /\d/.test(v)).length / n >= 0.7
      ) {
        role = "unit_no";
        confidence = 0.4;
        evidence = "content";
      } else if (textRatio >= 0.8) {
        role = "label";
        confidence = 0.35;
        evidence = "content";
      }
    }

    out.push({ index: c, header, normalized, role, confidence, evidence });
  }

  return out;
}

// ------------------------------------------------------------- heuristics --

const RENT_ROLL_KEYWORDS = [
  "rent roll", "rentroll", "tenancy schedule", "ejari", "cheque", "lease expiry",
  "lease expiration", "tenant name", "unit no", "occupancy status", "in place rent",
  "market rent", "tenancy contract",
];

const T12_KEYWORDS = [
  "trailing 12", "trailing twelve", "t12", "t-12", "ttm", "operating statement",
  "income statement", "profit and loss", "profit & loss", "p&l",
  "net operating income", "noi", "total operating expenses", "total expenses",
  "total income", "total revenue", "gross potential rent", "effective gross income",
  "vacancy loss", "service charge", "management fee", "chart of accounts",
  "repairs and maintenance", "utilities", "insurance", "property tax",
];

function joinedText(rows: string[][], maxRows = 80): string {
  return rows
    .slice(0, maxRows)
    .map((r) => (r ?? []).join(" "))
    .join("\n")
    .toLowerCase();
}

function countKeywords(text: string, keywords: string[]): number {
  let hits = 0;
  for (const k of keywords) if (text.includes(k)) hits++;
  return hits;
}

function dataRowCount(rows: string[][], headerRowIndex: number): number {
  let count = 0;
  for (let r = Math.max(headerRowIndex + 1, 0); r < rows.length; r++) {
    if (nonEmpty(rows[r] ?? []).length > 0) count++;
  }
  return count;
}

/** Cheap "does this table look like a rent roll?" check for auto-classification. */
export function isLikelyRentRoll(rows: string[][]): boolean {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const headerRowIndex = detectHeaderRow(rows);
  const columns = classifyColumns(rows, headerRowIndex);
  const roles = new Set(columns.filter((c) => c.confidence >= 0.4).map((c) => c.role));
  roles.delete("unknown");

  const rentRollRoles: ColumnRole[] = [
    "unit_no", "unit_type", "beds", "area_sqft", "annual_rent", "monthly_rent",
    "cheques", "lease_start", "lease_end", "ejari", "tenant", "status",
  ];
  const distinct = rentRollRoles.filter((r) => roles.has(r)).length;
  const hasRent = roles.has("annual_rent") || roles.has("monthly_rent");
  const hasUnit = roles.has("unit_no") || roles.has("unit_type") || roles.has("area_sqft");
  const rowsBelow = dataRowCount(rows, headerRowIndex);
  const keywordHits = countKeywords(joinedText(rows), RENT_ROLL_KEYWORDS);

  if (distinct >= 4 && rowsBelow >= 2) return true;
  if (distinct >= 3 && hasRent && hasUnit && rowsBelow >= 2) return true;
  if (keywordHits >= 2 && distinct >= 2) return true;
  return false;
}

/** Cheap "does this table look like a T12 / operating statement?" check. */
export function isLikelyT12(rows: string[][]): boolean {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const headerRowIndex = detectHeaderRow(rows);
  const columns = classifyColumns(rows, headerRowIndex);
  const monthColumns = columns.filter((c) => c.role === "month").length;
  const roles = new Set(columns.filter((c) => c.confidence >= 0.35).map((c) => c.role));
  const text = joinedText(rows);
  const keywordHits = countKeywords(text, T12_KEYWORDS);

  // Twelve monthly columns is the signature shape and needs no vocabulary.
  if (monthColumns >= 6) return true;
  if (monthColumns >= 3 && (roles.has("label") || roles.has("total"))) return true;
  if ((roles.has("label") || roles.has("total") || roles.has("amount")) && keywordHits >= 3) return true;
  if (keywordHits >= 5) return true;
  return false;
}
