// Number and currency formatting.
//
// Dubai conventions, deliberately: currency symbol BEFORE the value
// ("AED 12,480,000", never "12,480,000 AED" in an English UI), comma thousands
// separators, yields to one or two decimals, areas in square feet with square
// metres secondary, and accounting parentheses for negatives rather than a
// hyphen. Getting this wrong is the fastest way to lose a Gulf investment
// committee, and it costs nothing to get right.
//
// The client mirrors this in public/js/format.js. Keeping the two in step
// matters because the printed IC pack is generated from server-side strings
// while the live screen formats in the browser.

import type { Value } from "./engine/expr.ts";

const LOCALE = "en-AE";

export function formatCurrency(value: number, currency = "AED", precision = 0): string {
  const abs = Math.abs(value);
  const body = abs.toLocaleString(LOCALE, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  return value < 0 ? `(${currency} ${body})` : `${currency} ${body}`;
}

/** "AED 12.48m" — for headline tiles where the full figure would not fit. */
export function formatCurrencyCompact(value: number, currency = "AED"): string {
  const abs = Math.abs(value);
  let body: string;

  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(2)}bn`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(2)}m`;
  else if (abs >= 10_000) body = `${(abs / 1_000).toFixed(0)}k`;
  else body = abs.toLocaleString(LOCALE, { maximumFractionDigits: 0 });

  return value < 0 ? `(${currency} ${body})` : `${currency} ${body}`;
}

export function formatPercent(value: number, precision = 2): string {
  const body = `${(value * 100).toFixed(precision)}%`;
  return value < 0 ? `(${body.replace("-", "")})` : body;
}

export function formatNumber(value: number, precision = 0): string {
  const abs = Math.abs(value);
  const body = abs.toLocaleString(LOCALE, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  return value < 0 ? `(${body})` : body;
}

export function formatMultiple(value: number, precision = 2): string {
  return `${value.toFixed(precision)}×`;
}

export function formatYears(value: number, precision = 1): string {
  const rounded = Number(value.toFixed(precision));
  return `${rounded} ${rounded === 1 ? "yr" : "yrs"}`;
}

export function formatPerSqft(value: number, currency = "AED", precision = 2): string {
  return `${currency} ${value.toLocaleString(LOCALE, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })}/sqft`;
}

const SQFT_PER_SQM = 10.7639;

/** "1,320 sqft (122.6 sqm)" — every Dubai rent roll mixes the two units. */
export function formatArea(sqft: number, withMetric = true): string {
  const feet = `${Math.round(sqft).toLocaleString(LOCALE)} sqft`;
  if (!withMetric) return feet;
  const sqm = sqft / SQFT_PER_SQM;
  return `${feet} (${sqm.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} sqm)`;
}

export function sqftToSqm(sqft: number): number {
  return sqft / SQFT_PER_SQM;
}
export function sqmToSqft(sqm: number): number {
  return sqm * SQFT_PER_SQM;
}

/**
 * The single dispatcher used everywhere a computed line is rendered. A missing
 * value renders as an em dash, never as zero — the design system and the
 * underwriting engine agree that absent must look absent.
 */
export function formatValue(
  value: Value,
  format: string | undefined,
  currency = "AED",
  precision?: number,
): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "—";

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
      if (Math.abs(value) >= 10_000) return formatNumber(value, 0);
      return formatNumber(value, 2);
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  // DD/MM/YYYY — the UAE convention.
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}
