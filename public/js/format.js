// Number, currency and area formatting — a mirror of src/lib/format.ts.
//
// The printed IC pack is generated from server-side strings while the live
// screen formats in the browser, so the two must agree character for character.
// Dubai conventions, deliberately: symbol BEFORE the value, comma thousands,
// accounting parentheses for negatives, areas in sqft with sqm secondary, and
// an em dash for absent. Absent must look absent, never like zero.

const LOCALE = "en-AE";

export const EM_DASH = "—";

const SQFT_PER_SQM = 10.7639;

export function formatCurrency(value, currency = "AED", precision = 0) {
  const abs = Math.abs(value);
  const body = abs.toLocaleString(LOCALE, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  return value < 0 ? `(${currency} ${body})` : `${currency} ${body}`;
}

/** "AED 12.48m" — for headline tiles where the full figure would not fit. */
export function formatCurrencyCompact(value, currency = "AED") {
  const abs = Math.abs(value);
  let body;

  if (abs >= 1e9) body = `${(abs / 1e9).toFixed(2)}bn`;
  else if (abs >= 1e6) body = `${(abs / 1e6).toFixed(2)}m`;
  else if (abs >= 10000) body = `${(abs / 1000).toFixed(0)}k`;
  else body = abs.toLocaleString(LOCALE, { maximumFractionDigits: 0 });

  return value < 0 ? `(${currency} ${body})` : `${currency} ${body}`;
}

export function formatPercent(value, precision = 2) {
  const body = `${(value * 100).toFixed(precision)}%`;
  return value < 0 ? `(${body.replace("-", "")})` : body;
}

export function formatNumber(value, precision = 0) {
  const abs = Math.abs(value);
  const body = abs.toLocaleString(LOCALE, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  return value < 0 ? `(${body})` : body;
}

export function formatMultiple(value, precision = 2) {
  return `${value.toFixed(precision)}×`;
}

export function formatYears(value, precision = 1) {
  const rounded = Number(value.toFixed(precision));
  return `${rounded} ${rounded === 1 ? "yr" : "yrs"}`;
}

export function formatPerSqft(value, currency = "AED", precision = 2) {
  return `${currency} ${value.toLocaleString(LOCALE, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })}/sqft`;
}

/** "1,320 sqft (122.6 sqm)" — every Dubai rent roll mixes the two units. */
export function formatArea(sqft, withMetric = true) {
  const feet = `${Math.round(sqft).toLocaleString(LOCALE)} sqft`;
  if (!withMetric) return feet;
  const sqm = sqft / SQFT_PER_SQM;
  return `${feet} (${sqm.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} sqm)`;
}

export function sqftToSqm(sqft) {
  return sqft / SQFT_PER_SQM;
}

/**
 * The single dispatcher used everywhere a computed line is rendered. A missing
 * value renders as an em dash, never as zero.
 */
export function formatValue(value, format, currency = "AED", precision) {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return EM_DASH;

  switch (format) {
    case "currency":
      return formatCurrency(value, currency, precision ?? 0);
    case "currency_compact":
      return formatCurrencyCompact(value, currency);
    case "percent":
      return formatPercent(value, precision ?? 2);
    case "multiple":
    case "ratio":
      return formatMultiple(value, precision ?? 2);
    case "years":
      return formatYears(value, precision ?? 1);
    case "per_sqft":
      return formatPerSqft(value, currency, precision ?? 2);
    case "integer":
      return formatNumber(value, 0);
    case "number":
      return formatNumber(value, precision ?? 2);
    case "boolean":
      return value ? "Yes" : "No";
    default:
      // No declared format: guess conservatively. A value strictly inside
      // (-1, 1) that is not zero is almost always a rate in this domain.
      if (value !== 0 && Math.abs(value) < 1) return formatPercent(value, 2);
      if (Math.abs(value) >= 10000) return formatNumber(value, 0);
      return formatNumber(value, 2);
  }
}

/** DD/MM/YYYY — the UAE convention. */
/**
 * Field values round-trip through SQLite as text, so "742000" and 742000 both
 * arrive. A figure that reads as a number is formatted as one.
 */
export function coerceNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function formatDate(iso) {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

export function formatDateTime(iso) {
  if (!iso) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso)} ${hh}:${mi}`;
}

/** File sizes in the same register as everything else: a number and its unit. */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return EM_DASH;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// -------------------------------------------------------------- typography --

// A formatted string decomposed into its typographic parts. The currency is a
// raised prefix, the integer carries the meaning, the decimal is a footnote,
// and no number is ever rendered without its unit.
const CURRENCY_PREFIX = /^([A-Z]{3})\s+(.*)$/;
const NUMERIC_HEAD = /^([\d.,]+)(.*)$/;
const MAGNITUDE = /^(bn|m|k)$/;

export function decomposeFigure(str) {
  const out = { negative: false, currency: null, integer: "", decimal: "", magnitude: "", unit: "" };
  if (str === null || str === undefined) return { ...out, integer: EM_DASH };

  let s = String(str);
  if (s === EM_DASH || s === "") return { ...out, integer: EM_DASH };

  if (s.startsWith("(") && s.endsWith(")")) {
    out.negative = true;
    s = s.slice(1, -1);
  }

  const cur = CURRENCY_PREFIX.exec(s);
  if (cur) {
    out.currency = cur[1];
    s = cur[2];
  }

  const head = NUMERIC_HEAD.exec(s);
  if (!head) {
    out.integer = s;
    return out;
  }

  let numeric = head[1];
  let tail = head[2];

  if (MAGNITUDE.test(tail)) {
    out.magnitude = tail;
    tail = "";
  }
  out.unit = tail;

  const dot = numeric.lastIndexOf(".");
  if (dot > -1) {
    out.integer = numeric.slice(0, dot);
    out.decimal = numeric.slice(dot);
  } else {
    out.integer = numeric;
  }

  return out;
}

/**
 * Build a figure as DOM. Never innerHTML: every part of this string can
 * originate in a document somebody else wrote.
 *
 * `typeset` splits the string into its typographic parts — raised currency
 * prefix, reduced decimal, magnitude suffix. That treatment belongs to display
 * figures only. In a table it would break the rigid rectangle a column of
 * numbers has to be, so a table cell gets the plain string.
 */
export function figureFragment(str, options = {}) {
  const frag = document.createDocumentFragment();
  const parts = decomposeFigure(str);

  const host = document.createElement("span");
  if (parts.negative && options.judgement) host.className = "neg-fig";
  host.setAttribute("dir", "ltr");
  host.style.setProperty("unicode-bidi", "isolate");

  if (!options.typeset) {
    host.textContent = str === null || str === undefined || str === "" ? EM_DASH : String(str);
    frag.append(host);
    return frag;
  }

  const span = (cls, textContent) => {
    const node = document.createElement("span");
    if (cls) node.className = cls;
    node.textContent = textContent;
    return node;
  };

  if (parts.negative) host.append(document.createTextNode("("));
  if (parts.currency) host.append(span("cur", parts.currency));
  host.append(span(null, parts.integer));
  if (parts.decimal) host.append(span("dec", parts.decimal));
  if (parts.magnitude) host.append(span("mag", parts.magnitude));
  if (parts.unit) host.append(span("unit", parts.unit));
  if (parts.negative) host.append(document.createTextNode(")"));

  frag.append(host);
  return frag;
}

/**
 * The integer the CSS count-up rolls to. Large figures roll their own digits;
 * a value under 100 rolls its hundredths, so a DSCR of 1.42 still shows motion
 * rather than counting zero to one.
 */
export function countTarget(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const abs = Math.abs(value);
  if (abs === 0) return 0;
  if (abs < 1) return Math.round(abs * 10000);
  if (abs < 100) return Math.round(abs * 100);
  return Math.round(abs);
}

/** Area cell: sqft primary, sqm secondary in --text-3. */
export function areaFragment(sqft) {
  const frag = document.createDocumentFragment();
  if (typeof sqft !== "number" || !Number.isFinite(sqft)) {
    frag.append(document.createTextNode(EM_DASH));
    return frag;
  }
  const primary = document.createElement("span");
  primary.textContent = `${Math.round(sqft).toLocaleString(LOCALE)} sqft`;
  const secondary = document.createElement("span");
  secondary.className = "sqm";
  secondary.textContent = `${sqftToSqm(sqft).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} sqm`;
  frag.append(primary, secondary);
  return frag;
}

/** Parse what a user typed back into a number, tolerating commas and %. */
export function parseNumeric(raw, type) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || s === EM_DASH) return null;

  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }

  s = s.replace(/[A-Za-z×]{1,4}\s*\/?\s*(sqft|sqm|yr|yrs)?/g, (match) =>
    /^(bn|m|k)$/i.test(match.trim()) ? match : "",
  );
  s = s.replace(/,/g, "").trim();

  const wasPercent = s.includes("%");
  s = s.replace(/%/g, "").trim();

  let multiplier = 1;
  const magnitude = /^(-?[\d.]+)\s*(bn|m|k)$/i.exec(s);
  if (magnitude) {
    s = magnitude[1];
    const suffix = magnitude[2].toLowerCase();
    multiplier = suffix === "bn" ? 1e9 : suffix === "m" ? 1e6 : 1e3;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  let value = n * multiplier;
  if (negative) value = -value;
  // A percent input is stored as a rate. "5%" and "0.05" both mean 0.05, and a
  // reviewer types both.
  if (type === "percent" && (wasPercent || Math.abs(value) > 1)) value = value / 100;
  return value;
}
