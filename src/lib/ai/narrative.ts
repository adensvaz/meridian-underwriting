// The deal write-up: strengths, red flags, due-diligence questions.
//
// The single most important design decision here is what the model is allowed
// to see. It is given the COMPUTED underwriting output — the resolved inputs,
// every calculated line, the projection, the benchmark gradings and the
// deterministic flags the engine already fired — and it is NOT given the raw
// documents. That is deliberate:
//
//   * It cannot contradict the numbers on screen, because the numbers on screen
//     are its only source.
//   * It cannot re-extract a figure and quietly disagree with the review table.
//   * It cannot invent a return the engine did not compute.
//
// The deterministic flags in the model definition do the risk detection. The
// model's job is judgement and prose, not arithmetic.

import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall, aiAvailable } from "./client.ts";
import type { BenchmarkResult, FlagResult, RunResult } from "../engine/types.ts";
import { formatValue } from "../format.ts";

export const NARRATIVE_PROMPT_VERSION = "narrative-2026-08-b";

export interface NarrativeItem {
  title: string;
  detail: string;
  metric?: string | null;
  severity?: "red" | "amber" | "info" | "positive";
}

export interface Narrative {
  headline: string;
  summary: string;
  strengths: NarrativeItem[];
  redFlags: NarrativeItem[];
  ddItems: NarrativeItem[];
  engine: "ai" | "rules";
  error?: string;
}

const SYSTEM_PROMPT = `You are a senior acquisitions analyst at a Dubai real estate investment firm, writing the analysis section of an investment committee memo.

You are given the FULLY COMPUTED underwriting output for a deal: resolved inputs, calculated lines, the multi-year projection, benchmark gradings, and risk flags the underwriting engine has already fired deterministically.

RULES

1. Work only from the figures you are given. Do not compute new figures, do not restate a figure with a different value, and do not reference anything not in the data. If you want to cite a number, cite it exactly as provided.
2. Never invent a risk. The engine's flags are established fact; your job is to explain what they mean commercially and to add judgement the arithmetic cannot capture. If the data does not support a concern, do not manufacture one to look thorough.
3. Where an input is marked missing or low confidence, treat that gap itself as a due-diligence item. An underwriting built on an assumed service charge is a different thing from one built on a Mollak statement, and the memo must say so.
4. Be specific and quantitative. "Leverage is aggressive" is worthless. "DSCR of 1.08x sits below the 1.25x most UAE banks require on investment lending, so the loan as modelled is unlikely to be approved at this LTV" is useful.
5. Write for a principal who will spend ninety seconds on this. No preamble, no hedging, no restating the property description back at them.

MARKET CONTEXT YOU ARE EXPECTED TO APPLY

- Gross yield is the dominant local vernacular; net yield is the sophisticated buyer's number. Price per square foot is the metric every conversation opens with.
- Service charge is an owner cost billed by the Owners Association through Mollak and is the largest recurring expense on most Dubai assets. There is no annual property tax in the UAE.
- Rent is paid in post-dated cheques. A twelve-cheque tenancy carries materially more collection risk than a one-cheque tenancy, and since 2022 a bounced cheque is a civil matter in the UAE rather than a criminal one, so the historical deterrent is weaker than many owners assume.
- Renewal rent increases are capped against the RERA rental index on a tiered scale, so a unit let far below index cannot be marked to market in one step. Conversely a unit let far above index may not be renewable at that rent.
- Buyer-side transaction costs are roughly 6-7% all in (4% DLD transfer fee, ~2% agency, plus trustee, NOC, mortgage registration and conveyancing), which is why net yield must be measured on total capital deployed rather than on the purchase price.
- UAE banks typically want DSCR at or above 1.25x on investment lending.
- Property held by a natural person in a personal capacity is outside UAE corporate tax; property held in an entity is generally within it at 9% above AED 375,000.

TONE: dry, senior, and specific. This memo goes in front of people who deploy their own capital.`;

/**
 * The mortgage brief is a different document for a different reader.
 *
 * The prompt above asks for an investment committee memo on an asset. Handed a
 * mortgage affordability run it would write about cap rates, service charges and
 * DSCR covenants on behalf of a buyer who owns nothing yet, for a committee that
 * does not exist. A broker is producing a pre-approval indication for one person
 * and taking it back to that person and to a bank.
 */
const MORTGAGE_SYSTEM_PROMPT = `You are a senior mortgage adviser at a Dubai brokerage, writing the assessment a broker gives a buyer and takes to a lender. This is a pre-approval INDICATION for one applicant, not a credit decision, not an offer, and not an investment paper.

You are given the FULLY COMPUTED affordability output for one applicant: resolved inputs, calculated lines, benchmark gradings, and the constraints the engine has already fired deterministically.

RULES

1. Work only from the figures you are given. Do not compute new figures, do not restate a figure with a different value, and do not reference anything not in the data. Cite numbers exactly as provided.
2. Never invent a risk. The engine's flags are established fact; your job is to explain what they mean for this buyer's chances and to add judgement the arithmetic cannot capture.
3. Where an input is a model default rather than something the buyer or their documents supplied, say so. An affordability figure built on an assumed salary is not an assessment of anybody.
4. Be specific and quantitative. "Affordability is tight" is worthless. "A debt burden ratio of 49% sits just inside the 50% Central Bank ceiling, so a single additional card limit would put the file outside policy" is useful.
5. Say plainly which of the two ceilings binds — income or deposit — because that determines what the buyer should do next. More deposit does not raise an income-bound loan.
6. Write for a broker who will read this in ninety seconds and then repeat it to a client on the phone. No preamble, no hedging.
7. This assessment covers ONE applicant. Do not suggest combining incomes or refer to a household figure; a joint application is not modelled here.

MARKET CONTEXT YOU ARE EXPECTED TO APPLY

- UAE Central Bank regulation caps total debt service at 50% of assessed income. Under 40% is comfortable and clears underwriting faster.
- Loan-to-value ceilings depend on the applicant: UAE nationals may borrow the most, expat residents less, non-residents least; a second property and an off-plan purchase are both capped harder, off-plan at roughly 50% whoever the buyer is.
- The loan must be fully repaid by a maximum age at maturity, typically 65 salaried and 70 self-employed. For an older applicant this shortens the term, which raises the payment and cuts the maximum loan.
- Credit card LIMITS are assessed as a monthly commitment at around 5% whether or not the balance is nil, so unused limits cost real borrowing capacity.
- Buyer-side completion costs run roughly 6-8% of the price: 4% DLD transfer, ~2% agency, 0.25% mortgage registration, plus valuation, arrangement and conveyancing. Cash to complete is the deposit PLUS these, and buyers routinely underestimate it.
- Affordability is tested at a stressed rate above the quoted one, because a fixed period reverts.
- Only a subset of UAE banks lend to non-residents at all, and pricing is usually higher.

TONE: dry, specific, and usable on a phone call. Never promise approval.`;

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description: "One sentence, under 140 characters, stating what this deal is and the single thing that most determines whether it works.",
    },
    summary: {
      type: "string",
      description: "Two to four sentences. The investment case and the principal risk, with figures. No preamble.",
    },
    strengths: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Six words or fewer." },
          detail: { type: "string", description: "One to three sentences citing the specific figures." },
          metric: { type: ["string", "null"], description: "The key of the driving metric, if there is one." },
        },
        required: ["title", "detail"],
        additionalProperties: false,
      },
    },
    red_flags: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Six words or fewer." },
          detail: { type: "string", description: "What is wrong, what it costs, and what would have to be true for it to be acceptable." },
          severity: { type: "string", enum: ["red", "amber"] },
          metric: { type: ["string", "null"] },
        },
        required: ["title", "detail", "severity"],
        additionalProperties: false,
      },
    },
    dd_items: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The question, as a question." },
          detail: { type: "string", description: "Why it matters and what document or party answers it." },
          metric: { type: ["string", "null"] },
        },
        required: ["title", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "summary", "strengths", "red_flags", "dd_items"],
  additionalProperties: false,
};

export interface NarrativeContext {
  dealName: string;
  community: string | null;
  assetType: string;
  currency: string;
  result: RunResult;
  modelName: string;
}

/** The one place the two jobs are told apart. Everything else follows it. */
function isMortgage(ctx: NarrativeContext): boolean {
  return ctx.assetType === "mortgage";
}

export async function generateNarrative(ctx: NarrativeContext): Promise<Narrative> {
  if (!aiAvailable()) {
    return { ...ruleBasedNarrative(ctx), engine: "rules" };
  }

  const mortgage = isMortgage(ctx);
  const brief = renderBrief(ctx);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: mortgage
        ? `Write the pre-approval assessment for this applicant.\n\n${brief}`
        : `Write the investment committee analysis for this deal.\n\n${brief}`,
    },
  ];

  const result = await structuredCall<{
    headline: string;
    summary: string;
    strengths: NarrativeItem[];
    red_flags: NarrativeItem[];
    dd_items: NarrativeItem[];
  }>({
    system: mortgage ? MORTGAGE_SYSTEM_PROMPT : SYSTEM_PROMPT,
    messages,
    toolName: "record_analysis",
    toolDescription: "Record the deal analysis: headline, summary, strengths, red flags and due-diligence questions.",
    schema: SCHEMA,
    maxTokens: 6000,
  });

  if (!result.ok || !result.data) {
    // A failed narrative must not lose the underwriting. Fall back to the
    // deterministic write-up and say plainly that it is the fallback.
    const fallback = ruleBasedNarrative(ctx);
    return { ...fallback, engine: "rules", error: result.error };
  }

  const data = result.data;
  return {
    headline: String(data.headline ?? "").slice(0, 300),
    summary: String(data.summary ?? "").slice(0, 2000),
    strengths: normaliseItems(data.strengths),
    redFlags: normaliseItems(data.red_flags),
    ddItems: normaliseItems(data.dd_items),
    engine: "ai",
  };
}

function normaliseItems(items: unknown): NarrativeItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is NarrativeItem => Boolean(i) && typeof (i as NarrativeItem).title === "string")
    .map((i) => ({
      title: String(i.title).slice(0, 200),
      detail: String(i.detail ?? "").slice(0, 1500),
      metric: typeof i.metric === "string" ? i.metric : null,
      severity: i.severity,
    }))
    .slice(0, 12);
}

/**
 * The brief handed to the model. Note what is here and what is not: computed
 * figures, gradings and flags — no document text.
 */
function renderBrief(ctx: NarrativeContext): string {
  const { result, currency } = ctx;
  const lines: string[] = [];

  if (isMortgage(ctx)) {
    lines.push(`APPLICANT: ${ctx.dealName}`);
    if (ctx.community) lines.push(`TARGET COMMUNITY: ${ctx.community}`);
    lines.push("CASE TYPE: residential mortgage affordability, single applicant");
  } else {
    lines.push(`PROPERTY: ${ctx.dealName}`);
    if (ctx.community) lines.push(`COMMUNITY: ${ctx.community}`);
    lines.push(`ASSET TYPE: ${ctx.assetType}`);
  }
  lines.push(`MODEL: ${ctx.modelName} (${result.depth} analysis)`);
  lines.push(`CURRENCY: ${currency}`);

  lines.push("\n=== HEADLINE METRICS ===");
  for (const s of result.summary) {
    lines.push(`${s.label}: ${formatValue(s.value, s.format, currency, s.precision)}`);
  }

  lines.push("\n=== RESOLVED INPUTS ===");
  for (const input of result.inputs) {
    if (input.value === null && input.origin !== "missing") continue;
    const shown = formatValue(input.value, inferFormat(input.type), currency);
    const provenance =
      input.origin === "missing"
        ? "NOT FOUND — no value from documents or assumptions"
        : input.origin === "default"
          ? "model default assumption"
          : input.origin === "user"
            ? "entered or corrected by the reviewer"
            : `extracted, confidence ${input.confidence === null ? "n/a" : (input.confidence * 100).toFixed(0) + "%"}`;
    lines.push(`${input.label} [${input.key}]: ${shown}  (${provenance})`);
  }

  lines.push("\n=== COMPUTED LINES ===");
  for (const line of [...result.lines, ...result.returns]) {
    if (line.hidden) continue;
    lines.push(
      `${line.label} [${line.key}]: ${formatValue(line.value, line.format, currency, line.precision)}` +
        (line.error ? `  (COULD NOT BE COMPUTED: ${line.error})` : ""),
    );
  }

  if (result.projection) {
    lines.push(`\n=== ${result.projection.years}-YEAR PROJECTION ===`);
    for (const row of result.projection.rows) {
      const cells = row.values
        .map((v, i) => `Y${i + 1} ${formatValue(v, row.format, currency, row.precision)}`)
        .join("  |  ");
      lines.push(`${row.label}: ${cells}`);
    }
  }

  if (result.benchmarks.length) {
    lines.push("\n=== BENCHMARK GRADINGS ===");
    for (const b of result.benchmarks) {
      // Not "target" for a lower-is-better metric: nobody aims for a 50% debt
      // burden ratio or a 15-year payback, and telling the model they do is how
      // a write-up ends up congratulating a buyer for approaching a cap.
      const comfortable =
        b.direction === "higher"
          ? `comfortable at or above ${b.good}, floor ${b.warn}`
          : `comfortable at or below ${b.good}, outer limit ${b.warn}`;
      lines.push(
        `${b.label}: ${formatValue(b.value, undefined, currency)} — graded ${b.status.toUpperCase()} ` +
          `(${comfortable})${b.note ? ` — ${b.note}` : ""}`,
      );
    }
  }

  if (result.flags.length) {
    lines.push("\n=== RISK FLAGS FIRED BY THE ENGINE (established fact — explain, do not re-derive) ===");
    for (const f of result.flags) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.title}: ${f.detail}${f.dd ? ` — suggested DD: ${f.dd}` : ""}`);
    }
  }

  const gaps = result.warnings.filter((w) => w.level !== "info");
  const missing = result.inputs.filter((i) => i.origin === "missing");
  if (gaps.length || missing.length) {
    lines.push("\n=== DATA GAPS AND WARNINGS ===");
    for (const w of gaps) lines.push(`${w.level.toUpperCase()}: ${w.message}`);
    for (const m of missing) lines.push(`MISSING INPUT: ${m.label} — the model used no value for this`);
  }

  return lines.join("\n");
}

function inferFormat(type: string): string | undefined {
  if (type === "currency") return "currency";
  if (type === "percent") return "percent";
  if (type === "integer") return "integer";
  return undefined;
}

// ------------------------------------------------------------- rules engine --

/**
 * The no-API-key path. Not a stub: it produces a genuinely useful memo from the
 * engine's own flags and benchmark gradings. This is what an investment
 * committee sees if they decline to send documents to a third-party model, and
 * it is also the safety net when the API is unavailable mid-run.
 */
export function ruleBasedNarrative(ctx: NarrativeContext): Omit<Narrative, "engine"> {
  const { result, currency } = ctx;

  const strengths: NarrativeItem[] = [];
  const redFlags: NarrativeItem[] = [];
  const ddItems: NarrativeItem[] = [];

  for (const flag of result.flags) {
    const item: NarrativeItem = {
      title: flag.title,
      detail: flag.detail,
      metric: flag.metric ?? null,
      severity: flag.severity,
    };
    if (flag.severity === "positive") strengths.push(item);
    else redFlags.push(item);
    if (flag.dd) {
      ddItems.push({ title: flag.dd, detail: `Raised by: ${flag.title}.`, metric: flag.metric ?? null });
    }
  }

  for (const b of result.benchmarks) {
    // Wording follows the benchmark's own direction. "Debt burden ratio above
    // target" and "Payback below acceptable" both read as praise for the thing
    // that is actually wrong.
    const higher = b.direction === "higher";
    if (b.status === "good") {
      strengths.push({
        title: higher ? `${b.label} above target` : `${b.label} comfortably low`,
        detail:
          `${b.label} of ${formatValue(b.value, undefined, currency)} is ` +
          (higher
            ? `clear of the ${b.good} target`
            : `inside the ${b.good} comfortable level`) +
          `${b.note ? `. ${b.note}` : "."}`,
        metric: b.key,
      });
    } else if (b.status === "bad") {
      redFlags.push({
        title: higher ? `${b.label} below acceptable` : `${b.label} past the limit`,
        detail:
          `${b.label} of ${formatValue(b.value, undefined, currency)} sits outside the acceptable band ` +
          (higher
            ? `(comfortable ≥ ${b.good}, floor ${b.warn})`
            : `(comfortable ≤ ${b.good}, outer limit ${b.warn})`) +
          `${b.note ? `. ${b.note}` : "."}`,
        metric: b.key,
        severity: "red",
      });
    }
  }

  // Every missing or low-confidence input is a due-diligence item. This is the
  // honest position: the model ran, but it ran on an assumption.
  for (const input of result.inputs) {
    if (input.origin === "missing") {
      ddItems.push({
        title: `Obtain ${input.label.toLowerCase()}`,
        detail: "This figure was not found in the uploaded documents and no assumption was applied. Dependent figures are incomplete.",
        metric: input.key,
      });
    } else if (input.origin === "default") {
      ddItems.push({
        title: `Confirm ${input.label.toLowerCase()}`,
        detail: `The model applied its default assumption of ${formatValue(input.value, inferFormat(input.type), currency)} because the documents did not state it. Verify before committing.`,
        metric: input.key,
      });
    } else if (typeof input.confidence === "number" && input.confidence < 0.6) {
      ddItems.push({
        title: `Verify ${input.label.toLowerCase()}`,
        detail: `Extracted at ${(input.confidence * 100).toFixed(0)}% confidence${input.sourceSnippet ? ` from "${input.sourceSnippet.slice(0, 120)}"` : ""}. Check it against the source document.`,
        metric: input.key,
      });
    }
  }

  const { headline, opener } = framing(ctx);

  const summaryParts: string[] = [opener];
  if (redFlags.length) {
    summaryParts.push(
      `${redFlags.length} risk ${redFlags.length === 1 ? "item was" : "items were"} flagged, led by ${redFlags[0].title.toLowerCase()}.`,
    );
  } else {
    summaryParts.push("No risk flags fired against the configured thresholds.");
  }
  const missingCount = result.inputs.filter((i) => i.origin === "missing").length;
  const defaultCount = result.inputs.filter((i) => i.origin === "default").length;
  if (missingCount || defaultCount) {
    summaryParts.push(
      `${missingCount} input${missingCount === 1 ? "" : "s"} could not be found and ${defaultCount} fell back to model defaults — treat the output as indicative until those are confirmed.`,
    );
  }

  return {
    headline,
    summary: summaryParts.join(" "),
    strengths: dedupe(strengths).slice(0, 6),
    redFlags: dedupe(redFlags).slice(0, 8),
    ddItems: dedupe(ddItems).slice(0, 12),
  };
}

/**
 * The first sentence of a write-up, and the one line above it.
 *
 * A mortgage run computes no yield, no price per square foot and no DSCR, so
 * the property framing collapsed to "— underwriting complete", which tells a
 * broker nothing, on a document headed "investment committee pack", which tells
 * them something false. The mortgage branch reads the model's OWN nominated
 * headline figures rather than a second hardcoded list of keys, and states what
 * the document is: an indication, not a decision.
 */
function framing(ctx: NarrativeContext): { headline: string; opener: string } {
  const { result, currency } = ctx;

  if (isMortgage(ctx)) {
    const band = result.summary
      .slice(0, 3)
      .filter((s) => s.value !== null && s.value !== undefined)
      .map((s) => `${s.label.toLowerCase()} ${formatValue(s.value, s.format, currency, s.precision)}`);
    return {
      headline: band.length
        ? `${ctx.dealName} — ${band.join(", ")}.`
        : `${ctx.dealName} — affordability assessed.`,
      opener:
        `Affordability assessed on the ${ctx.modelName} model${band.length ? `, giving ${band.join(", ")}` : ""}. ` +
        "This is an indication for discussion, not a credit decision or an offer of lending.",
    };
  }

  const v = result.values;
  const num = (key: string): number | null => (typeof v[key] === "number" ? (v[key] as number) : null);
  const psf = num("price_per_sqft");
  const grossYield = num("gross_yield");
  const netYield = num("net_yield");
  const dscr = num("dscr");

  const bits: string[] = [];
  if (psf !== null) bits.push(`${currency} ${Math.round(psf).toLocaleString("en-AE")}/sqft`);
  if (grossYield !== null) bits.push(`${(grossYield * 100).toFixed(2)}% gross yield`);
  if (netYield !== null) bits.push(`${(netYield * 100).toFixed(2)}% net yield`);
  if (dscr !== null) bits.push(`${dscr.toFixed(2)}x DSCR`);

  return {
    headline: bits.length
      ? `${ctx.dealName}${ctx.community ? `, ${ctx.community}` : ""} — ${bits.join(", ")}.`
      : `${ctx.dealName} — underwriting complete.`,
    opener: `Underwritten on the ${ctx.modelName} model at ${result.depth} depth${bits.length ? `, producing ${bits.join(", ")}` : ""}.`,
  };
}

function dedupe(items: NarrativeItem[]): NarrativeItem[] {
  const seen = new Set<string>();
  const out: NarrativeItem[] = [];
  for (const item of items) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
