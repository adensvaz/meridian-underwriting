// AI extraction: documents → underwriting inputs, with provenance.
//
// Two rules govern this file.
//
// 1. ABSENT MEANS NULL. The prompt is emphatic that a figure not present in the
//    document must come back as null, never as a plausible guess. A confidently
//    invented service charge is worse than a blank one, because a blank is
//    visible on the review screen and an invention is not.
//
// 2. EVERY VALUE CITES ITS SOURCE. Each extracted field carries the document,
//    the page or sheet, and the snippet it came from. Without that the reviewer
//    cannot audit the number and will not trust the tool.

import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall, aiAvailable } from "./client.ts";
import type { InputDef, ModelDefinition } from "../engine/types.ts";
import type { Value } from "../engine/expr.ts";

export const PROMPT_VERSION = "extract-2026-08-a";

export interface ExtractedField {
  key: string;
  value: Value;
  confidence: number;
  page: number | null;
  sheet: string | null;
  snippet: string | null;
  reasoning?: string | null;
}

export interface ExtractedUnit {
  unit_no: string | null;
  unit_type: string | null;
  beds: number | null;
  area_sqft: number | null;
  in_place_rent: number | null;
  market_rent: number | null;
  cheques: number | null;
  lease_start: string | null;
  lease_end: string | null;
  occupancy_status: string | null;
  ejari_no: string | null;
  source_row: number | null;
  confidence: number;
}

export interface ExtractedT12Line {
  raw_label: string;
  section: "income" | "opex" | "below_noi" | "unknown";
  category: string | null;
  amount: number | null;
  months_covered: number;
  is_recurring: boolean;
  exclude_reason: string | null;
  source_row: number | null;
  confidence: number;
}

export interface ExtractionPayload {
  fields: ExtractedField[];
  units?: ExtractedUnit[];
  t12_lines?: ExtractedT12Line[];
  document_kind: "om" | "rent_roll" | "t12" | "other";
  notes: string[];
}

// The normalised T12 buckets. Sellers use a hundred different labels; the model
// maps into this closed list so a formula can reference `t12_insurance` and get
// the same thing regardless of whose accountant produced the statement.
export const T12_CATEGORIES = [
  "service_charge",
  "chiller_cooling",
  "management_fee",
  "insurance",
  "repairs_maintenance",
  "utilities",
  "cleaning",
  "security",
  "landscaping",
  "leasing_commission",
  "legal_professional",
  "marketing",
  "administration",
  "reserve_fund",
  "property_tax",
  "other_opex",
  "base_rent",
  "other_income",
  "parking_income",
  "recoveries",
] as const;

const SYSTEM_PROMPT = `You are a commercial real estate analyst extracting structured data from deal documents for an underwriting platform used in Dubai and the wider UAE.

ABSOLUTE RULES

1. If a figure is not present in the document, return null. Never estimate, never infer from market norms, never carry a number over from a different line item. A null is a correct answer. A plausible invention is a serious error that will reach an investment committee.
2. Every value you return must cite where it came from: the page number (PDFs) or sheet name (spreadsheets), plus a short verbatim snippet of the surrounding text.
3. Confidence is 0.0-1.0 and must be honest. Use above 0.9 only when the document states the figure explicitly and unambiguously. Use 0.5-0.7 when you had to interpret a label or combine cells. Use below 0.4 when you are reading a damaged, ambiguous or partially legible figure.
4. Return figures as plain numbers with no currency symbols, no thousands separators and no percent signs. A percentage must be returned as a decimal: 6.5% becomes 0.065.
5. Rent figures in this market are quoted ANNUALLY. If a document gives a monthly figure, multiply by 12 and say so in the snippet. Never mix the two.

DUBAI / UAE MARKET CONVENTIONS YOU MUST APPLY

- Rent is paid in post-dated cheques. "4 cheques" or "4 chqs" means four instalments per year. Capture the cheque count; it is a real underwriting input here, not a payment detail.
- Service charge is quoted in AED per square foot per year and is an owner cost, billed by the Owners Association through Mollak. It is the dominant operating expense. Do not label it CAM and do not treat it as tenant-recoverable in residential.
- District cooling (Empower, Emicool, Tabreed) appears as a separate chiller charge with a fixed capacity component. Capture it separately from electricity.
- There is NO annual property tax in the UAE. If you see a line labelled "property tax" on a UAE asset, flag it in notes rather than mapping it to a tax bucket; it is usually a mislabelled service charge or a foreign-template artefact.
- The DLD transfer fee is 4% of the purchase price and is a one-off acquisition cost, not an operating expense.
- Areas may be given in square feet or square metres, and rent rolls routinely mix them. 1 sqm = 10.7639 sqft. Always return area in SQUARE FEET and note in the snippet if you converted.
- Ejari is the tenancy registration number. Capture it when present.
- Tenure may be freehold, leasehold, usufruct or musataha. Capture the remaining years for anything that is not freehold.

DOCUMENT TYPES

- An Offering Memorandum in this market is often a short broker teaser: price, size, price per square foot, expected rent and gross yield, and little else. Extract what is there and leave the rest null.
- A rent roll is a tenancy schedule: one row per unit with rent, cheque count, lease dates and often the Ejari number.
- A T12 is a twelve-month collection or income statement. Map each line to the closed category list you are given. Mark non-recurring items (one-off legal costs, capital works booked as repairs, casualty losses, owner-specific charges) as is_recurring false with an exclude_reason, because they must not flow into a stabilised NOI.

Work only from the text you are given. Do not use outside knowledge of any specific property.`;

function fieldSchema(inputs: InputDef[]): Record<string, unknown> {
  const keys = inputs.filter((i) => i.extract !== false).map((i) => i.key);
  return {
    type: "object",
    properties: {
      document_kind: {
        type: "string",
        enum: ["om", "rent_roll", "t12", "other"],
        description: "What this document actually is, judged from its contents.",
      },
      fields: {
        type: "array",
        description: "One entry per figure you found. Omit fields entirely rather than returning a guessed value.",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: keys, description: "Which underwriting input this is." },
            value: {
              type: ["number", "string", "boolean", "null"],
              description: "The value. Numbers plain, percentages as decimals, null if absent.",
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            page: { type: ["integer", "null"], description: "1-based PDF page number." },
            sheet: { type: ["string", "null"], description: "Spreadsheet sheet name." },
            snippet: {
              type: ["string", "null"],
              description: "Short verbatim text from the document around this figure.",
            },
            reasoning: {
              type: ["string", "null"],
              description: "One line, only if you had to interpret or convert something.",
            },
          },
          required: ["key", "value", "confidence", "page", "sheet", "snippet"],
          additionalProperties: false,
        },
      },
      units: {
        type: "array",
        description: "Rent roll rows. Only for a rent roll document; otherwise an empty array.",
        items: {
          type: "object",
          properties: {
            unit_no: { type: ["string", "null"] },
            unit_type: { type: ["string", "null"], description: "e.g. Studio, 1BR, 2BR, Office, Retail, Warehouse" },
            beds: { type: ["number", "null"] },
            area_sqft: { type: ["number", "null"], description: "Square feet. Convert from sqm if needed." },
            in_place_rent: { type: ["number", "null"], description: "Contract ANNUAL rent." },
            market_rent: { type: ["number", "null"], description: "Annual market or asking rent if stated." },
            cheques: { type: ["integer", "null"], description: "Instalments per year: 1, 2, 4, 6 or 12." },
            lease_start: { type: ["string", "null"], description: "ISO date if determinable." },
            lease_end: { type: ["string", "null"] },
            occupancy_status: { type: ["string", "null"], enum: ["occupied", "vacant", "notice", null] },
            ejari_no: { type: ["string", "null"] },
            source_row: { type: ["integer", "null"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["unit_no", "area_sqft", "in_place_rent", "confidence"],
          additionalProperties: false,
        },
      },
      t12_lines: {
        type: "array",
        description: "T12 statement rows. Only for a T12 document; otherwise an empty array.",
        items: {
          type: "object",
          properties: {
            raw_label: { type: "string", description: "The label exactly as printed." },
            section: { type: "string", enum: ["income", "opex", "below_noi", "unknown"] },
            category: { type: ["string", "null"], enum: [...T12_CATEGORIES, null] },
            amount: { type: ["number", "null"], description: "As stated. Negative for a credit." },
            months_covered: { type: "integer", description: "12 for a full year, fewer if partial." },
            is_recurring: { type: "boolean" },
            exclude_reason: {
              type: ["string", "null"],
              description: "Why this must not flow into stabilised NOI, if applicable.",
            },
            source_row: { type: ["integer", "null"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["raw_label", "section", "amount", "months_covered", "is_recurring", "confidence"],
          additionalProperties: false,
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "Anything the reviewer should know: contradictions, illegible figures, unusual conventions, suspected errors in the source document.",
      },
    },
    required: ["document_kind", "fields", "notes"],
    additionalProperties: false,
  };
}

export interface DocumentForExtraction {
  id: string;
  filename: string;
  kind: string;
  isScanned: boolean;
  segments: Array<{ pageNo: number | null; sheetName: string | null; content: string }>;
}

export interface ExtractionOutcome {
  ok: boolean;
  payload?: ExtractionPayload;
  error?: string;
  engine: "ai" | "rules";
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
}

const MAX_CHARS_PER_DOCUMENT = 180_000;

export async function extractFromDocument(
  doc: DocumentForExtraction,
  definition: ModelDefinition,
): Promise<ExtractionOutcome> {
  if (!aiAvailable()) {
    return {
      ok: false,
      engine: "rules",
      error: "AI extraction is not configured",
      durationMs: 0,
    };
  }

  if (doc.isScanned) {
    return {
      ok: false,
      engine: "ai",
      error:
        "This document has no text layer — it is a scan or a photograph. Text extraction cannot read it. Upload a text-based PDF or an Excel file, or enter the figures manually.",
      durationMs: 0,
    };
  }

  const body = renderSegments(doc);
  if (body.trim().length < 40) {
    return {
      ok: false,
      engine: "ai",
      error: "No readable text was found in this document",
      durationMs: 0,
    };
  }

  const relevantInputs = (definition.inputs ?? []).filter((i) => i.extract !== false);
  const inputGuide = relevantInputs
    .map((i) => {
      const unit = i.unit ? ` [${i.unit}]` : "";
      const where = i.source ? ` (usually found in: ${i.source})` : "";
      return `- ${i.key}${unit}: ${i.label}.${where}${i.help ? ` ${i.help}` : ""}`;
    })
    .join("\n");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `The user has uploaded a document they labelled "${doc.kind}" with the filename "${doc.filename}".

Extract every underwriting input you can find. These are the inputs the model accepts — use these exact keys and nothing else:

${inputGuide}

Normalised T12 expense categories: ${T12_CATEGORIES.join(", ")}

Remember: a figure that is not in the document must be omitted or returned as null. Do not fill gaps with market assumptions.

=== DOCUMENT CONTENT ===

${body}`,
    },
  ];

  const result = await structuredCall<ExtractionPayload>({
    system: SYSTEM_PROMPT,
    messages,
    toolName: "record_extraction",
    toolDescription:
      "Record every underwriting figure found in this document, with a source citation and an honest confidence for each.",
    schema: fieldSchema(relevantInputs),
    maxTokens: 16000,
  });

  if (!result.ok || !result.data) {
    return {
      ok: false,
      engine: "ai",
      error: result.error ?? "Extraction failed",
      durationMs: result.durationMs,
    };
  }

  return {
    ok: true,
    engine: "ai",
    payload: sanitize(result.data, new Set(relevantInputs.map((i) => i.key))),
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    durationMs: result.durationMs,
  };
}

function renderSegments(doc: DocumentForExtraction): string {
  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const seg of doc.segments) {
    const header = seg.sheetName
      ? `\n--- sheet: ${seg.sheetName} ---\n`
      : seg.pageNo !== null
        ? `\n--- page ${seg.pageNo} ---\n`
        : "\n--- section ---\n";
    const piece = header + seg.content;

    if (used + piece.length > MAX_CHARS_PER_DOCUMENT) {
      const remaining = MAX_CHARS_PER_DOCUMENT - used;
      if (remaining > 500) {
        parts.push(piece.slice(0, remaining));
        used = MAX_CHARS_PER_DOCUMENT;
      }
      truncated = true;
      break;
    }
    parts.push(piece);
    used += piece.length;
  }

  if (truncated) {
    parts.push(
      "\n\n[This document was truncated because it exceeds the extraction size limit. Figures beyond this point were not read — say so in your notes.]",
    );
  }
  return parts.join("");
}

/**
 * Never trust the model's output shape blindly, even behind a forced schema.
 * Unknown keys are dropped, confidences are clamped, and anything that should
 * be a number but is not becomes null rather than poisoning a formula.
 */
function sanitize(payload: ExtractionPayload, allowedKeys: Set<string>): ExtractionPayload {
  const clamp = (n: unknown): number => {
    const value = typeof n === "number" && Number.isFinite(n) ? n : 0.5;
    return Math.min(1, Math.max(0, value));
  };

  return {
    document_kind: payload.document_kind ?? "other",
    notes: Array.isArray(payload.notes) ? payload.notes.filter((n) => typeof n === "string").slice(0, 30) : [],
    fields: (Array.isArray(payload.fields) ? payload.fields : [])
      .filter((f) => f && typeof f.key === "string" && allowedKeys.has(f.key))
      .map((f) => ({
        key: f.key,
        value: f.value === undefined ? null : f.value,
        confidence: clamp(f.confidence),
        page: typeof f.page === "number" ? f.page : null,
        sheet: typeof f.sheet === "string" ? f.sheet : null,
        snippet: typeof f.snippet === "string" ? f.snippet.slice(0, 500) : null,
        reasoning: typeof f.reasoning === "string" ? f.reasoning.slice(0, 300) : null,
      }))
      .slice(0, 200),
    units: (Array.isArray(payload.units) ? payload.units : [])
      .map((u) => ({
        unit_no: str(u.unit_no),
        unit_type: str(u.unit_type),
        beds: num(u.beds),
        area_sqft: num(u.area_sqft),
        in_place_rent: num(u.in_place_rent),
        market_rent: num(u.market_rent),
        cheques: num(u.cheques),
        lease_start: str(u.lease_start),
        lease_end: str(u.lease_end),
        occupancy_status: str(u.occupancy_status),
        ejari_no: str(u.ejari_no),
        source_row: num(u.source_row),
        confidence: clamp(u.confidence),
      }))
      .slice(0, 2000),
    t12_lines: (Array.isArray(payload.t12_lines) ? payload.t12_lines : [])
      .filter((l) => l && typeof l.raw_label === "string")
      .map((l) => ({
        raw_label: l.raw_label.slice(0, 200),
        section: (["income", "opex", "below_noi", "unknown"] as const).includes(l.section)
          ? l.section
          : "unknown",
        category:
          typeof l.category === "string" && (T12_CATEGORIES as readonly string[]).includes(l.category)
            ? l.category
            : null,
        amount: num(l.amount),
        months_covered:
          typeof l.months_covered === "number" && l.months_covered > 0 && l.months_covered <= 24
            ? Math.round(l.months_covered)
            : 12,
        is_recurring: l.is_recurring !== false,
        exclude_reason: str(l.exclude_reason),
        source_row: num(l.source_row),
        confidence: clamp(l.confidence),
      }))
      .slice(0, 500),
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.slice(0, 200) : null;
}
