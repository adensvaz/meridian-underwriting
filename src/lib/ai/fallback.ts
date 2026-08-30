// Deterministic extraction — the path taken when no model API key is set.
//
// This exists because the product makes a specific promise: a firm that will
// not send confidential deal packs to a third-party model can still run the
// tool end to end. That promise is worthless if the no-key path silently
// extracts nothing, so this is a real extractor, not a stub.
//
// It is deliberately narrower than the model. It reads structured tables well
// — a rent roll and a T12 are grids, and the parse layer already classifies
// their columns — and reads prose badly, so it pulls only unambiguous labelled
// figures out of an Offering Memorandum and leaves everything else null.
//
// Confidence is capped at 0.75. A regex that matched is not the same kind of
// evidence as a model that read the surrounding sentence, and the review
// screen should show that difference honestly.

import { parseNumber, type ColumnClassification, type ColumnRole } from "../parse/tables.ts";
import type { ParsedDocument, ParsedTable } from "../parse/index.ts";
import type { ModelDefinition } from "../engine/types.ts";
import type {
  ExtractedField,
  ExtractedT12Line,
  ExtractedUnit,
  ExtractionPayload,
} from "./extract.ts";
import { T12_CATEGORIES } from "./extract.ts";

const MAX_CONFIDENCE = 0.75;
const SQFT_PER_SQM = 10.7639;

/** Maps a seller's free-text expense label onto our normalised bucket. */
const CATEGORY_PATTERNS: Array<{ category: (typeof T12_CATEGORIES)[number]; test: RegExp }> = [
  { category: "service_charge", test: /service\s*charge|owners?\s*assoc|\boa\b|mollak|community\s*fee|master\s*community/i },
  { category: "chiller_cooling", test: /chiller|district\s*cool|empower|emicool|tabreed|\bac\b\s*charge|cooling/i },
  { category: "management_fee", test: /management\s*fee|property\s*manage|managing\s*agent|\bpm\b\s*fee/i },
  { category: "insurance", test: /insurance|takaful/i },
  { category: "repairs_maintenance", test: /repair|maintenance|\bamc\b|handyman|snagging/i },
  { category: "utilities", test: /dewa|utilit|electric|water|sewerage|gas\b/i },
  { category: "cleaning", test: /clean|janitor|waste|pest\s*control/i },
  { category: "security", test: /security|guard|cctv|access\s*control/i },
  { category: "landscaping", test: /landscap|garden|irrigation|pool\s*maint/i },
  { category: "leasing_commission", test: /leasing|letting|broker|agency\s*commission|commission/i },
  { category: "legal_professional", test: /legal|professional|audit|accounting|consultan/i },
  { category: "marketing", test: /marketing|advertis|promotion|listing/i },
  { category: "administration", test: /admin|ejari|registration|licence|license|bank\s*charge/i },
  { category: "reserve_fund", test: /reserve\s*fund|sinking\s*fund|capital\s*reserve/i },
  { category: "property_tax", test: /property\s*tax|municipal(ity)?\s*(fee|tax)|housing\s*fee/i },
  { category: "parking_income", test: /parking/i },
  { category: "recoveries", test: /recover|reimburs|recharge/i },
  { category: "other_income", test: /other\s*income|sundry\s*income|misc.*income/i },
  { category: "base_rent", test: /base\s*rent|rental\s*income|rent\s*received|gross\s*rent|rent\b/i },
];

/**
 * Labels that must not flow into a stabilised NOI. Deterministic, and applied
 * before the reviewer sees the T12, so the exclusions are visible and editable
 * rather than buried.
 */
const NON_RECURRING_PATTERNS: Array<{ reason: string; test: RegExp }> = [
  { reason: "One-off capital works booked through the operating statement", test: /lift\s*modernis|fa[çc]ade|replacement|refurbish|renovation|capital\s*(work|expenditure)|capex|upgrade\s*project/i },
  { reason: "Legal settlement or dispute cost — not a recurring operating expense", test: /settlement|litigation|dispute|arbitration|penalty|fine\b/i },
  { reason: "Casualty or insurance claim — non-recurring", test: /casualty|claim|flood|fire\s*damage|storm/i },
  { reason: "Owner-specific charge — excluded from an unlevered NOI", test: /asset\s*management|partnership|depreciation|amortisation|interest\s*expense|mortgage|loan\s*repay|owner'?s?\s*draw|dividend/i },
  { reason: "One-off levy raised by the Owners Association", test: /special\s*levy|one[-\s]?off|extraordinary/i },
];

function categoriseLabel(label: string): (typeof T12_CATEGORIES)[number] | null {
  for (const { category, test } of CATEGORY_PATTERNS) {
    if (test.test(label)) return category;
  }
  return null;
}

function nonRecurringReason(label: string): string | null {
  for (const { reason, test } of NON_RECURRING_PATTERNS) {
    if (test.test(label)) return reason;
  }
  return null;
}

function columnFor(columns: ColumnClassification[], role: ColumnRole): number {
  // Highest-confidence column wins when a sheet has two plausible candidates,
  // which happens constantly with "Rent" and "Market Rent".
  let best = -1;
  let bestConfidence = 0;
  for (const c of columns) {
    if (c.role === role && c.confidence > bestConfidence) {
      best = c.index;
      bestConfidence = c.confidence;
    }
  }
  return best;
}

function cell(row: string[], index: number): string {
  if (index < 0 || index >= row.length) return "";
  return (row[index] ?? "").trim();
}

// --------------------------------------------------------------- rent roll --

function extractUnits(table: ParsedTable): ExtractedUnit[] {
  const { rows, headerRowIndex, columns } = table;
  const idx = {
    unit: columnFor(columns, "unit_no"),
    type: columnFor(columns, "unit_type"),
    beds: columnFor(columns, "beds"),
    area: columnFor(columns, "area_sqft"),
    annual: columnFor(columns, "annual_rent"),
    monthly: columnFor(columns, "monthly_rent"),
    cheques: columnFor(columns, "cheques"),
    start: columnFor(columns, "lease_start"),
    end: columnFor(columns, "lease_end"),
    ejari: columnFor(columns, "ejari"),
    status: columnFor(columns, "status"),
  };

  // Without a rent column there is nothing worth extracting.
  if (idx.annual < 0 && idx.monthly < 0) return [];

  const units: ExtractedUnit[] = [];

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !c || !c.trim())) continue;

    const label = cell(row, idx.unit >= 0 ? idx.unit : 0);
    // Skip the totals line — it is not a tenancy.
    if (/^(total|sub[-\s]?total|grand\s*total|sum)\b/i.test(label)) continue;

    const annual = idx.annual >= 0 ? parseNumber(cell(row, idx.annual)) : null;
    const monthly = idx.monthly >= 0 ? parseNumber(cell(row, idx.monthly)) : null;
    // Dubai quotes rent annually. A monthly column is normalised up, never
    // mixed with an annual one.
    const rent = annual ?? (monthly !== null ? monthly * 12 : null);
    if (rent === null) continue;

    let area = idx.area >= 0 ? parseNumber(cell(row, idx.area)) : null;
    // A header saying sqm means the figure is sqm; the model works in sqft.
    const areaHeader = columns.find((c) => c.index === idx.area)?.normalized ?? "";
    if (area !== null && /sq\s*m|sqm|m2|square\s*met/i.test(areaHeader)) {
      area = area * SQFT_PER_SQM;
    }

    const statusRaw = cell(row, idx.status).toLowerCase();
    const occupancy =
      /vacant|empty|available|void/.test(statusRaw) ? "vacant"
      : /notice|expiring|terminat/.test(statusRaw) ? "notice"
      : statusRaw ? "occupied"
      : null;

    units.push({
      unit_no: label || null,
      unit_type: idx.type >= 0 ? cell(row, idx.type) || null : null,
      beds: idx.beds >= 0 ? parseNumber(cell(row, idx.beds)) : null,
      area_sqft: area,
      in_place_rent: rent,
      market_rent: null,
      cheques: idx.cheques >= 0 ? parseNumber(cell(row, idx.cheques)) : null,
      lease_start: idx.start >= 0 ? cell(row, idx.start) || null : null,
      lease_end: idx.end >= 0 ? cell(row, idx.end) || null : null,
      occupancy_status: occupancy,
      ejari_no: idx.ejari >= 0 ? cell(row, idx.ejari) || null : null,
      source_row: r + 1,
      // Column classification carries its own confidence; inherit the weakest
      // link, since a misread rent column poisons the row.
      confidence: Math.min(
        MAX_CONFIDENCE,
        Math.max(0.4, columns.find((c) => c.index === (idx.annual >= 0 ? idx.annual : idx.monthly))?.confidence ?? 0.5),
      ),
    });
  }

  return units;
}

// --------------------------------------------------------------------- T12 --

function extractT12(table: ParsedTable): ExtractedT12Line[] {
  const { rows, headerRowIndex, columns } = table;
  const labelIdx = columnFor(columns, "label");
  const totalIdx = columnFor(columns, "total");
  const amountIdx = columnFor(columns, "amount");

  const valueIdx = totalIdx >= 0 ? totalIdx : amountIdx;
  if (labelIdx < 0 && valueIdx < 0) return [];

  const lines: ExtractedT12Line[] = [];
  let section: ExtractedT12Line["section"] = "unknown";

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !c || !c.trim())) continue;

    const label = cell(row, labelIdx >= 0 ? labelIdx : 0);
    if (!label) continue;

    // Section headers carry no amount and rename the section that follows.
    const amount = valueIdx >= 0 ? parseNumber(cell(row, valueIdx)) : null;
    if (amount === null) {
      if (/income|revenue|receipts|collections/i.test(label)) section = "income";
      else if (/expense|expenditure|operating\s*cost|opex|outgoings/i.test(label)) section = "opex";
      else if (/below\s*noi|debt\s*service|financing|capital/i.test(label)) section = "below_noi";
      continue;
    }

    if (/^(total|sub[-\s]?total|grand\s*total|net\s*operating|noi)\b/i.test(label)) continue;

    const category = categoriseLabel(label);
    const excludeReason = nonRecurringReason(label);

    // Fall back to the category when no section header was seen at all.
    const inferred: ExtractedT12Line["section"] =
      section !== "unknown" ? section
      : category && ["base_rent", "other_income", "parking_income", "recoveries"].includes(category) ? "income"
      : category ? "opex"
      : "unknown";

    lines.push({
      raw_label: label,
      section: inferred,
      category,
      amount,
      months_covered: 12,
      is_recurring: excludeReason === null,
      exclude_reason: excludeReason,
      source_row: r + 1,
      confidence: category ? 0.7 : 0.45,
    });
  }

  return lines;
}

// ------------------------------------------------------------------ prose --

/**
 * Unambiguous labelled figures out of an OM. Every pattern requires an explicit
 * label next to the number — no positional guessing, because a Dubai broker
 * teaser puts four large numbers on one page and picking the wrong one is worse
 * than picking none.
 */
const PROSE_PATTERNS: Array<{
  keys: string[];
  test: RegExp;
  transform?: (n: number, match: RegExpMatchArray) => number;
}> = [
  {
    keys: ["price", "purchase_price", "asking_price"],
    test: /(?:asking\s*price|purchase\s*price|sale\s*price|price)\s*[:\-]?\s*(?:aed|usd|د\.إ)?\s*([\d,.]+\s*(?:m|million|k)?)/i,
  },
  {
    keys: ["size_sqft", "nla_sqft", "total_rentable_sqft"],
    test: /(?:suite\s*area|net\s*(?:leasable|lettable)\s*area|built[-\s]?up\s*area|bua|nla|gfa|size|area)\s*[:\-]?\s*([\d,.]+)\s*(?:sq\s*\.?\s*ft|sqft|ft2)/i,
  },
  {
    keys: ["size_sqft", "nla_sqft", "total_rentable_sqft"],
    test: /(?:suite\s*area|built[-\s]?up\s*area|bua|size|area)\s*[:\-]?\s*([\d,.]+)\s*(?:sq\s*\.?\s*m|sqm|m2)/i,
    transform: (n) => n * SQFT_PER_SQM,
  },
  {
    keys: ["in_place_rent", "contract_rent", "annual_rent", "contract_rent_total"],
    test: /(?:annual\s*rent|contract\s*rent|passing\s*rent|current\s*rent|rent\s*\(aed\)|rent\s*per\s*annum)\s*[:\-]?\s*(?:aed)?\s*([\d,.]+\s*(?:m|million|k)?)/i,
  },
  {
    keys: ["service_charge_budget_psf", "service_charge_per_sqft"],
    test: /service\s*charge\s*[:\-]?\s*(?:aed)?\s*([\d,.]+)\s*(?:\/|per\s*)\s*sq/i,
  },
  {
    keys: ["cheque_count"],
    test: /([\d]+)\s*cheques?\b/i,
  },
  {
    keys: ["tenure_years_remaining"],
    test: /(?:musataha|usufruct|leasehold)[^.]{0,60}?([\d]+)\s*years?\s*(?:remaining|unexpired|left)/i,
  },
];

function expandMagnitude(raw: string): number | null {
  const trimmed = raw.trim();
  const multiplier = /\b(m|million)\b/i.test(trimmed) ? 1_000_000 : /\bk\b/i.test(trimmed) ? 1_000 : 1;
  const numeric = parseNumber(trimmed.replace(/\b(m|million|k)\b/gi, ""));
  if (numeric === null) return null;
  return numeric * multiplier;
}

function extractProse(
  segments: Array<{ pageNo: number | null; sheetName: string | null; content: string }>,
  allowedKeys: Set<string>,
): ExtractedField[] {
  const found = new Map<string, ExtractedField>();

  for (const segment of segments) {
    for (const pattern of PROSE_PATTERNS) {
      const target = pattern.keys.find((k) => allowedKeys.has(k) && !found.has(k));
      if (!target) continue;

      const match = pattern.test.exec(segment.content);
      if (!match) continue;

      let value = expandMagnitude(match[1]);
      if (value === null) continue;
      if (pattern.transform) value = pattern.transform(value, match);

      const at = match.index ?? 0;
      found.set(target, {
        key: target,
        value: Math.round(value * 100) / 100,
        confidence: 0.6,
        page: segment.pageNo,
        sheet: segment.sheetName,
        snippet: segment.content.slice(Math.max(0, at - 60), at + match[0].length + 60).replace(/\s+/g, " ").trim(),
        reasoning: "Matched a labelled figure without a language model",
      });
    }
  }

  return [...found.values()];
}

// ------------------------------------------------------------------ driver --

export function ruleBasedExtraction(
  parsed: ParsedDocument,
  definition: ModelDefinition,
): ExtractionPayload {
  const allowedKeys = new Set((definition.inputs ?? []).filter((i) => i.extract !== false).map((i) => i.key));
  const notes: string[] = [
    "Extracted without a language model. Structured tables are read directly; prose is only scanned for explicitly labelled figures, so an Offering Memorandum will yield far less than it would with AI extraction enabled. Confirm every figure before relying on it.",
  ];

  const tables = parsed.tables ?? [];
  let units: ExtractedUnit[] = [];
  let t12: ExtractedT12Line[] = [];

  for (const table of tables) {
    if (!units.length) {
      const candidate = extractUnits(table);
      if (candidate.length) {
        units = candidate;
        notes.push(`Read ${candidate.length} tenancy row(s) from ${table.sheetName ?? `page ${table.pageNo ?? "?"}`}.`);
      }
    }
    if (!t12.length) {
      const candidate = extractT12(table);
      // One or two rows is noise, not a statement.
      if (candidate.length > 3) {
        t12 = candidate;
        const excluded = candidate.filter((l) => !l.is_recurring).length;
        notes.push(
          `Read ${candidate.length} statement line(s) from ${table.sheetName ?? `page ${table.pageNo ?? "?"}`}` +
            (excluded ? `, ${excluded} marked non-recurring and excluded from NOI.` : "."),
        );
      }
    }
  }

  const fields = extractProse(
    parsed.segments.map((s) => ({
      pageNo: s.pageNo ?? null,
      sheetName: s.sheetName ?? null,
      content: s.content,
    })),
    allowedKeys,
  );

  if (!fields.length && !units.length && !t12.length) {
    notes.push("No figures could be read from this document without a language model.");
  }

  return {
    document_kind: parsed.guessedKind,
    fields,
    units,
    t12_lines: t12,
    notes,
  };
}
