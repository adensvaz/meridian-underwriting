// Loan sizing: solve for the facility rather than assume it.
//
// In the model the loan is an input — you say 75% LTV and the engine tells you
// the DSCR. A lender does the opposite: it fixes the constraints and solves for
// the largest facility that clears all of them. This module inverts the model
// so an analyst can ask the lender's question.
//
// It binary-searches the loan amount and RE-RUNS THE WHOLE MODEL each iteration
// rather than inverting the debt-service algebra. That is deliberate. DSCR is
// monotonic in loan size, which is all bisection needs, but the path from loan
// to debt service is not: an interest-only period, a shorter amortisation tail,
// an arrangement fee that lands in the equity requirement, a regulatory LTV
// ceiling that clips the facility. A closed-form inversion would have to
// duplicate all of it and would drift the moment someone edits the model. Forty
// runs of a model that takes a millisecond is a price worth paying to have the
// answer come from the same code that produces the underwriting.
//
// Two honesty rules:
//
//   1. If no positive loan clears the cover test, the answer is "unfundable",
//      not 0. Returning 0 as though it were a solution reads as "an all-cash
//      purchase satisfies your DSCR covenant", which is a different statement.
//
//   2. The binding constraint is named. "LTV-bound at 75%" and "DSCR-bound at
//      1.25x" send the analyst to different places — more equity versus more
//      rent — and a number without that label does not.

import { runModel } from "./model.ts";
import type { RunInput } from "./model.ts";
import type { ModelDefinition, RunResult } from "./types.ts";
import type { Value } from "./expr.ts";

export const DEFAULT_MAX_LTV = 0.75;
/** UAE banks underwrite investment lending to 1.25x. */
export const DEFAULT_MIN_DSCR = 1.25;
/** Converge to the nearest AED 1,000 — finer than any bank draws a facility. */
export const TOLERANCE = 1000;
export const MAX_ITERATIONS = 40;

// Conventional names, tried in order. A model is free to use any of them; a
// model that uses none of them gets an honest "unavailable" rather than a
// grid of numbers built on a guess.
const LOAN_AMOUNT_INPUTS = ["loan_amount", "loan", "facility_amount", "debt_amount"];
const LTV_INPUTS = ["ltv", "loan_to_value", "ltv_requested"];
const LOAN_READOUTS = ["loan_amount", "loan", "facility_amount", "debt_amount"];
const PRICE_READOUTS = ["purchase_price", "price", "property_value", "asset_value"];
const DSCR_READOUTS = ["dscr", "dscr_year_1", "year_one_dscr", "min_dscr"];
const DEBT_YIELD_READOUTS = ["debt_yield", "debt_yield_pct"];
/** Reported alongside the answer when the model happens to compute them. */
const CONTEXT_READOUTS = [
  "noi",
  "annual_debt_service",
  "equity_required",
  "all_in_cost",
  "cash_on_cash",
  "levered_cash_flow",
  "levered_irr",
  "ltv_applied",
];

export type BindingCode = "ltv" | "dscr" | "debt_yield" | "model_ltv_ceiling";

export interface BindingConstraint {
  code: BindingCode;
  /** e.g. "DSCR-bound at 1.25x". */
  label: string;
  /** What the analyst should do about it. */
  detail: string;
}

export interface SolveLoanUnavailable {
  available: false;
  reason: string;
}

export interface SolveLoanSolved {
  available: true;
  /** False when no positive facility clears the constraints. */
  feasible: boolean;
  /** Null when infeasible — deliberately not 0. */
  loanAmount: number | null;
  ltv: number | null;
  price: number;
  dscr: number | null;
  debtYield: number | null;
  binding: BindingConstraint | null;
  constraints: { maxLtv: number; minDscr: number; minDebtYield: number | null };
  /** Present only when infeasible. */
  reason?: string;
  driver: { key: string; mode: "amount" | "ltv" };
  /** Computed values from the winning run, for the summary band. No formulas. */
  metrics: Record<string, number | null>;
  iterations: number;
  tolerance: number;
  currency: string;
  warnings: string[];
  durationMs: number;
}

export type SolveLoanResult = SolveLoanUnavailable | SolveLoanSolved;

export interface SolveLoanOptions {
  definition: ModelDefinition;
  values: Map<string, RunInput> | Record<string, RunInput>;
  maxLtv?: number;
  minDscr?: number;
  minDebtYield?: number | null;
}

// ------------------------------------------------------------------ helpers --

function toMap(v: SolveLoanOptions["values"]): Map<string, RunInput> {
  return v instanceof Map ? new Map(v) : new Map(Object.entries(v));
}

function read(result: RunResult, key: string): number | null {
  const raw: Value | undefined = Object.hasOwn(result.values, key) ? result.values[key] : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function firstKey(candidates: string[], available: Set<string>): string | null {
  for (const c of candidates) if (available.has(c)) return c;
  return null;
}

function pct(x: number): string {
  const scaled = x * 100;
  return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}%`;
}

function ratio(x: number): string {
  return `${x.toFixed(2)}x`;
}

interface Probe {
  requested: number;
  loan: number;
  dscr: number | null;
  debtYield: number | null;
  result: RunResult;
}

// ------------------------------------------------------------------- solver --

export function solveLoanAmount(options: SolveLoanOptions): SolveLoanResult {
  const started = performance.now();
  const definition = options.definition;
  const base = toMap(options.values);
  const warnings: string[] = [];

  const maxLtv = options.maxLtv ?? DEFAULT_MAX_LTV;
  const minDscr = options.minDscr ?? DEFAULT_MIN_DSCR;
  const minDebtYield =
    typeof options.minDebtYield === "number" && Number.isFinite(options.minDebtYield)
      ? options.minDebtYield
      : null;

  if (!Number.isFinite(maxLtv) || maxLtv < 0 || maxLtv > 1) {
    return { available: false, reason: "The maximum LTV must be a decimal between 0 and 1" };
  }
  if (!Number.isFinite(minDscr) || minDscr <= 0) {
    return { available: false, reason: "The minimum DSCR must be a positive number" };
  }

  // ---- discover the model's own vocabulary -----------------------------

  const inputKeys = new Set((definition.inputs ?? []).map((i) => i.key));
  const computedKeys = new Set<string>([
    ...inputKeys,
    ...(definition.lines ?? []).map((l) => l.key),
    ...(definition.returns ?? []).map((r) => r.key),
  ]);

  const amountDriver = firstKey(LOAN_AMOUNT_INPUTS, inputKeys);
  const ltvDriver = firstKey(LTV_INPUTS, inputKeys);
  const driverKey = amountDriver ?? ltvDriver;
  if (!driverKey) {
    return {
      available: false,
      reason: `This model has no loan amount or LTV input to solve for (looked for ${[...LOAN_AMOUNT_INPUTS, ...LTV_INPUTS].join(", ")})`,
    };
  }
  const mode: "amount" | "ltv" = amountDriver ? "amount" : "ltv";

  const dscrKey = firstKey(DSCR_READOUTS, computedKeys);
  if (!dscrKey) {
    return {
      available: false,
      reason: `This model computes no DSCR line, so there is no cover test to size against (looked for ${DSCR_READOUTS.join(", ")})`,
    };
  }

  const loanKey = firstKey(LOAN_READOUTS, computedKeys) ?? (mode === "amount" ? driverKey : null);
  if (!loanKey) {
    return { available: false, reason: "This model computes no loan amount, so a facility cannot be sized" };
  }

  const debtYieldKey = firstKey(DEBT_YIELD_READOUTS, computedKeys);
  if (minDebtYield !== null && !debtYieldKey) {
    warnings.push(
      "The minimum debt yield was ignored — this model computes no debt yield line to test against",
    );
  }
  const debtYieldActive = minDebtYield !== null && debtYieldKey !== null;

  // ---- the base run, for the price the LTV test is measured against ----

  const baseResult = runModel({ definition, values: new Map(base) });
  const priceKey = firstKey(PRICE_READOUTS, computedKeys);
  const price = priceKey ? read(baseResult, priceKey) : null;
  if (price === null || price <= 0) {
    return {
      available: false,
      reason: `This model has no positive purchase price to measure LTV against (looked for ${PRICE_READOUTS.join(", ")})`,
    };
  }

  // ---- probing ---------------------------------------------------------

  const evaluate = (amount: number): Probe => {
    const values = new Map(base);
    const driverValue: Value = mode === "amount" ? amount : amount / price;
    values.set(driverKey, { key: driverKey, value: driverValue, origin: "user" });
    const result = runModel({ definition, values });
    return {
      requested: amount,
      loan: read(result, loanKey) ?? amount,
      dscr: read(result, dscrKey),
      debtYield: debtYieldKey ? read(result, debtYieldKey) : null,
      result,
    };
  };

  const EPS = 1e-9;
  // A zero facility has no debt service, so DSCR is undefined rather than
  // failed. Only a facility that actually exists has to clear cover.
  const dscrOk = (p: Probe): boolean =>
    p.loan <= EPS || (p.dscr !== null && p.dscr >= minDscr - 1e-9);
  const debtYieldOk = (p: Probe): boolean =>
    !debtYieldActive || p.loan <= EPS || (p.debtYield !== null && p.debtYield >= minDebtYield! - 1e-12);
  const passes = (p: Probe): boolean => dscrOk(p) && debtYieldOk(p);

  const ceiling = maxLtv * price;

  const finish = (
    winner: Probe,
    binding: BindingConstraint | null,
    iterations: number,
  ): SolveLoanSolved => {
    const metrics: Record<string, number | null> = {};
    for (const key of CONTEXT_READOUTS) {
      if (computedKeys.has(key)) metrics[key] = read(winner.result, key);
    }
    return {
      available: true,
      feasible: true,
      loanAmount: Math.round(winner.loan),
      ltv: winner.loan / price,
      price,
      dscr: winner.dscr,
      debtYield: winner.debtYield,
      binding,
      constraints: { maxLtv, minDscr, minDebtYield: debtYieldActive ? minDebtYield : null },
      driver: { key: driverKey, mode },
      metrics,
      iterations,
      tolerance: TOLERANCE,
      currency: definition.currency,
      warnings,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  };

  if (ceiling <= 0) {
    const zero = evaluate(0);
    return finish(zero, {
      code: "ltv",
      label: `LTV-bound at ${pct(maxLtv)}`,
      detail: "A zero maximum LTV means an all-cash purchase; there is no facility to size.",
    }, 0);
  }

  // ---- the LTV ceiling first: if cover holds there, nothing else binds --

  const atCeiling = evaluate(ceiling);
  if (passes(atCeiling)) {
    // The model may enforce its own regulatory ceiling below the one asked
    // for — in the UAE, the Central Bank caps by buyer profile. Saying
    // "LTV-bound at 75%" when the model actually drew 65% would be wrong.
    if (atCeiling.loan < ceiling - TOLERANCE) {
      return finish(atCeiling, {
        code: "model_ltv_ceiling",
        label: `LTV-bound at ${pct(atCeiling.loan / price)}`,
        detail: `The model caps leverage below the ${pct(maxLtv)} requested — check the buyer profile driving the regulatory ceiling. Cover has headroom at this size.`,
      }, 0);
    }
    return finish(atCeiling, {
      code: "ltv",
      label: `LTV-bound at ${pct(maxLtv)}`,
      detail: `Cover clears at the full facility (DSCR ${atCeiling.dscr === null ? "n/a" : ratio(atCeiling.dscr)} against ${ratio(minDscr)}). More equity, not more rent, is what limits this deal.`,
    }, 0);
  }

  // ---- otherwise bisect between a known-good floor and the failing ceiling --

  // The smallest facility worth drawing. If even this fails the cover test,
  // no positive loan works and the honest answer is "unfundable".
  const floorAmount = Math.min(TOLERANCE, ceiling);
  const atFloor = evaluate(floorAmount);
  if (!passes(atFloor)) {
    const noi = computedKeys.has("noi") ? read(baseResult, "noi") : null;
    const why =
      !dscrOk(atFloor)
        ? `even a nominal facility fails the ${ratio(minDscr)} cover test${
            atFloor.dscr === null
              ? " — DSCR could not be computed, so NOI is missing or negative"
              : ` (DSCR ${ratio(atFloor.dscr)})`
          }`
        : `even a nominal facility fails the ${pct(minDebtYield!)} debt yield test`;
    return {
      available: true,
      feasible: false,
      loanAmount: null,
      ltv: null,
      price,
      dscr: atFloor.dscr,
      debtYield: atFloor.debtYield,
      binding: {
        code: !dscrOk(atFloor) ? "dscr" : "debt_yield",
        label: !dscrOk(atFloor) ? `DSCR-bound at ${ratio(minDscr)}` : `Debt-yield-bound at ${pct(minDebtYield!)}`,
        detail:
          "This deal does not support debt at these constraints. It is an all-cash story, or the income has to change.",
      },
      constraints: { maxLtv, minDscr, minDebtYield: debtYieldActive ? minDebtYield : null },
      reason: `No loan can be sized: ${why}${noi === null ? "" : ` on NOI of ${Math.round(noi).toLocaleString("en-AE")}`}.`,
      driver: { key: driverKey, mode },
      metrics: {},
      iterations: 0,
      tolerance: TOLERANCE,
      currency: definition.currency,
      warnings,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  let lo = floorAmount;
  let hi = ceiling;
  let best = atFloor;
  let worst = atCeiling;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS && hi - lo > TOLERANCE) {
    iterations++;
    const mid = (lo + hi) / 2;
    const probe = evaluate(mid);
    if (passes(probe)) {
      lo = mid;
      best = probe;
    } else {
      hi = mid;
      worst = probe;
    }
  }

  // The binding constraint is whichever test fails just above the answer —
  // literally the thing stopping the facility from being larger.
  const binding: BindingConstraint = !dscrOk(worst)
    ? {
        code: "dscr",
        label: `DSCR-bound at ${ratio(minDscr)}`,
        detail: `The facility is limited by cover, not by leverage — it stops at ${pct(best.loan / price)} LTV against a ${pct(maxLtv)} ceiling. More equity does not help; more rent or a lower rate does.`,
      }
    : {
        code: "debt_yield",
        label: `Debt-yield-bound at ${pct(minDebtYield!)}`,
        detail: `The facility is limited by debt yield — it stops at ${pct(best.loan / price)} LTV against a ${pct(maxLtv)} ceiling. This is a rate-independent test, so cheaper debt will not move it; only more NOI will.`,
      };

  return finish(best, binding, iterations);
}
