// Two-variable sensitivity analysis.
//
// An investment committee does not ask "what is the IRR"; it asks "what is the
// IRR if the exit yield is 100bps wider and rents grow at 2% instead of 4%".
// This module answers that by re-running the SAME engine once per cell. It does
// not differentiate, approximate or interpolate — every number in the grid is a
// real run of the model, which is the only way the grid can be trusted next to
// the base case it sits beside.
//
// Two things are load-bearing:
//
//   1. The grid is capped. 11 x 11 is 121 full model runs; an uncapped grid is
//      a one-request CPU denial of service on a shared server, and the cap is
//      enforced here rather than at the route so it holds for every caller.
//
//   2. A cell that cannot be computed is null, never zero and never omitted.
//      A zero in a sensitivity table reads as "this combination destroys the
//      deal" when it actually means "we did not work it out", and that is a
//      worse lie than a blank.
//
// Nothing here returns a formula. Callers get computed values plus the
// presentation metadata (label, unit, format) needed to render them.

import { coerceInputValue, runModel } from "./model.ts";
import type { RunInput } from "./model.ts";
import type { Format, InputDef, InputType, ModelDefinition } from "./types.ts";
import type { Value } from "./expr.ts";

/** Per-axis limit. 11 x 11 = 121 runs is the hard ceiling on one request. */
export const MAX_AXIS_LENGTH = 11;
export const MAX_CELLS = MAX_AXIS_LENGTH * MAX_AXIS_LENGTH;

/**
 * A rejected request, as opposed to a bug. Routes translate this into a 400;
 * the engine deliberately knows nothing about HTTP.
 */
export class SensitivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SensitivityError";
  }
}

// ------------------------------------------------------------------- shapes --

export interface AxisRequest {
  /** Must be a declared input key of the model. Never an arbitrary name. */
  key: string;
  values: Value[];
}

export interface ThresholdSpec {
  /** "min" — breach when below. "max" — breach when above. */
  direction: "min" | "max";
  value: number;
  label?: string;
}

export interface ResolvedAxis {
  key: string;
  label: string;
  group: string;
  type: InputType;
  unit?: string;
  format?: Format;
  values: Value[];
  /** The value the base case actually uses for this input. */
  baseValue: Value;
  /** Index of baseValue within values, or null when the base is off-grid. */
  baseIndex: number | null;
}

export interface MetricInfo {
  key: string;
  label: string;
  unit?: string;
  format?: Format;
  precision?: number;
  kind: "input" | "line" | "return";
}

export interface BreachCell {
  row: number;
  column: number;
}

export interface SensitivityResult {
  modelKey: string;
  currency: string;
  metric: MetricInfo;
  row: ResolvedAxis;
  /** Null for a one-dimensional sensitivity, where every row has one cell. */
  column: ResolvedAxis | null;
  /** cells[rowIndex][columnIndex]. Null means "could not be computed". */
  cells: Array<Array<number | null>>;
  base: { row: number | null; column: number | null; value: number | null };
  threshold: (ThresholdSpec & { source: "requested" | "benchmark" }) | null;
  breaches: BreachCell[];
  runs: number;
  warnings: string[];
  durationMs: number;
}

export interface SensitivityOptions {
  definition: ModelDefinition;
  /** The base case, exactly as assembleInputs produced it. */
  values: Map<string, RunInput> | Record<string, RunInput>;
  row: AxisRequest;
  column?: AxisRequest | null;
  metric: string;
  threshold?: ThresholdSpec | null;
}

// ------------------------------------------------------------------ helpers --

function toMap(v: SensitivityOptions["values"]): Map<string, RunInput> {
  return v instanceof Map ? new Map(v) : new Map(Object.entries(v));
}

function inputsOf(definition: ModelDefinition): Map<string, InputDef> {
  const map = new Map<string, InputDef>();
  for (const input of definition.inputs ?? []) map.set(input.key, input);
  return map;
}

function finite(v: Value | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Trims the float noise from 0.055 - 0.01 = 0.045000000000000005. */
function tidy(n: number, digits = 6): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function sameValue(a: Value, b: Value): boolean {
  if (typeof a === "number" && typeof b === "number") {
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= 1e-9 * scale;
  }
  if (a === null || b === null) return a === b;
  // A select input declares numeric options but the engine coerces them to
  // text, so 4 and "4" are genuinely the same choice here.
  return String(a) === String(b);
}

/**
 * Every key the runner will place in `values`: inputs, stage-2 lines and
 * stage-4 returns. Projection rows are per-year series, not scalars, so they
 * are deliberately not addressable as a sensitivity metric.
 */
export function metricsOf(definition: ModelDefinition): Map<string, MetricInfo> {
  const map = new Map<string, MetricInfo>();
  for (const input of definition.inputs ?? []) {
    map.set(input.key, {
      key: input.key,
      label: input.label,
      unit: input.unit,
      format:
        input.type === "currency" ? "currency"
        : input.type === "percent" ? "percent"
        : input.type === "integer" ? "integer"
        : undefined,
      precision: input.precision,
      kind: "input",
    });
  }
  for (const line of definition.lines ?? []) {
    map.set(line.key, {
      key: line.key,
      label: line.label,
      unit: line.unit,
      format: line.format,
      precision: line.precision,
      kind: "line",
    });
  }
  for (const ret of definition.returns ?? []) {
    map.set(ret.key, {
      key: ret.key,
      label: ret.label,
      unit: ret.unit,
      format: ret.format,
      precision: ret.precision,
      kind: "return",
    });
  }
  return map;
}

function baseValueOf(input: InputDef, base: Map<string, RunInput>): Value {
  const supplied = base.get(input.key);
  const v = supplied?.value;
  const raw = v !== undefined && v !== null && v !== "" ? v : (input.default ?? null);
  // Coerce with the SAME rule the runner uses. Values come out of SQLite as
  // TEXT, so a reviewer-edited figure is the string "0.055" — testing that for
  // finiteness fails, which is why every preset that needed a numeric base
  // reported itself unavailable on every real deal while working perfectly on
  // model defaults.
  return coerceInputValue(raw, input.type);
}

function resolveAxis(
  axis: AxisRequest,
  which: "row" | "column",
  inputs: Map<string, InputDef>,
  base: Map<string, RunInput>,
  warnings: string[],
): ResolvedAxis {
  if (typeof axis?.key !== "string" || !axis.key) {
    throw new SensitivityError(`The ${which} variable needs an input key`);
  }
  const input = inputs.get(axis.key);
  if (!input) {
    // Never run a grid over a key the model has not declared. This is the check
    // that stops an arbitrary attacker-supplied name reaching the engine.
    throw new SensitivityError(`"${axis.key}" is not an input of this model`);
  }
  if (!Array.isArray(axis.values) || axis.values.length === 0) {
    throw new SensitivityError(`The ${which} variable "${input.label}" needs at least one value`);
  }
  if (axis.values.length > MAX_AXIS_LENGTH) {
    throw new SensitivityError(
      `A sensitivity axis is limited to ${MAX_AXIS_LENGTH} values — the ${which} variable "${input.label}" has ${axis.values.length}`,
    );
  }

  const optionValues = input.options ? new Set(input.options.map((o) => String(o.value))) : null;

  for (const value of axis.values) {
    if (value === null) {
      throw new SensitivityError(`The ${which} variable "${input.label}" cannot include a blank value`);
    }
    if (typeof value === "object") {
      throw new SensitivityError(`The ${which} variable "${input.label}" takes plain values only`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SensitivityError(`The ${which} variable "${input.label}" has a value that is not a finite number`);
    }
    if (optionValues && !optionValues.has(String(value))) {
      throw new SensitivityError(
        `"${String(value)}" is not one of the permitted values for "${input.label}"`,
      );
    }
    if (input.type === "percent" && typeof value === "number" && Math.abs(value) > 1) {
      // The engine would silently reinterpret 5.5 as 0.055. Silently is the
      // problem: a grid of 5.5 and 6.5 would look like it ran and would not
      // mean what the caller asked for.
      throw new SensitivityError(
        `"${input.label}" is a percentage and takes decimals — use 0.055 for 5.5%, not ${value}`,
      );
    }
    if (typeof value === "number" && input.min !== undefined && value < input.min) {
      warnings.push(`${input.label} value ${value} is below the model's expected minimum of ${input.min}`);
    }
    if (typeof value === "number" && input.max !== undefined && value > input.max) {
      warnings.push(`${input.label} value ${value} is above the model's expected maximum of ${input.max}`);
    }
  }

  const baseValue = baseValueOf(input, base);
  let baseIndex: number | null = null;
  for (let i = 0; i < axis.values.length; i++) {
    if (sameValue(axis.values[i], baseValue)) {
      baseIndex = i;
      break;
    }
  }

  return {
    key: input.key,
    label: input.label,
    group: input.group,
    type: input.type,
    unit: input.unit,
    format:
      input.type === "currency" ? "currency"
      : input.type === "percent" ? "percent"
      : input.type === "integer" ? "integer"
      : undefined,
    values: axis.values,
    baseValue,
    baseIndex,
  };
}

function thresholdFor(
  definition: ModelDefinition,
  metric: string,
  requested: ThresholdSpec | null | undefined,
): (ThresholdSpec & { source: "requested" | "benchmark" }) | null {
  if (requested) {
    if (requested.direction !== "min" && requested.direction !== "max") {
      throw new SensitivityError('A threshold direction must be "min" or "max"');
    }
    if (typeof requested.value !== "number" || !Number.isFinite(requested.value)) {
      throw new SensitivityError("A threshold needs a finite numeric value");
    }
    return { ...requested, source: "requested" };
  }
  // Fall back to the model's own benchmark for this metric, so a DSCR grid
  // shades against the covenant the model already grades against rather than
  // against a number the UI invented.
  const benchmark = (definition.benchmarks ?? []).find((b) => b.key === metric);
  if (!benchmark) return null;
  return {
    direction: benchmark.direction === "higher" ? "min" : "max",
    value: benchmark.warn,
    label: benchmark.note ?? benchmark.label,
    source: "benchmark",
  };
}

function breached(value: number | null, threshold: ThresholdSpec | null): boolean {
  if (value === null || !threshold) return false;
  return threshold.direction === "min" ? value < threshold.value : value > threshold.value;
}

// -------------------------------------------------------------------- runner --

export function runSensitivity(options: SensitivityOptions): SensitivityResult {
  const started = performance.now();
  const definition = options.definition;
  const inputs = inputsOf(definition);
  const warnings: string[] = [];

  if (typeof options.metric !== "string" || !options.metric) {
    throw new SensitivityError("A metric to report is required");
  }
  const metrics = metricsOf(definition);
  const metric = metrics.get(options.metric);
  if (!metric) {
    throw new SensitivityError(`"${options.metric}" is not a computed value of this model`);
  }
  if (metric.kind === "return" && definition.depth === "quick") {
    warnings.push(
      `${metric.label} is only computed in a full run — this grid ran at quick depth and every cell will be blank`,
    );
  }

  const base = toMap(options.values);
  const row = resolveAxis(options.row, "row", inputs, base, warnings);
  const column =
    options.column && options.column.key
      ? resolveAxis(options.column, "column", inputs, base, warnings)
      : null;

  if (column && column.key === row.key) {
    throw new SensitivityError("The row and column variables must be different inputs");
  }

  const columnValues: Value[] = column ? column.values : [null];
  const runs = row.values.length * columnValues.length;
  if (runs > MAX_CELLS) {
    throw new SensitivityError(
      `A sensitivity grid is limited to ${MAX_CELLS} cells (${MAX_AXIS_LENGTH} x ${MAX_AXIS_LENGTH}); this one asks for ${runs}`,
    );
  }

  const threshold = thresholdFor(definition, metric.key, options.threshold);

  const cells: Array<Array<number | null>> = [];
  const breaches: BreachCell[] = [];
  let computed = 0;

  for (let r = 0; r < row.values.length; r++) {
    const line: Array<number | null> = [];
    for (let c = 0; c < columnValues.length; c++) {
      const values = new Map(base);
      values.set(row.key, { key: row.key, value: row.values[r], origin: "user" });
      if (column) {
        values.set(column.key, { key: column.key, value: columnValues[c], origin: "user" });
      }

      let value: number | null = null;
      try {
        const result = runModel({ definition, values });
        // Object.hasOwn: the metric key is validated against the model, but the
        // record is a plain object and a bare index would inherit from
        // Object.prototype.
        const raw = Object.hasOwn(result.values, metric.key) ? result.values[metric.key] : null;
        value = finite(raw);
      } catch {
        // One bad combination must not take down the whole grid. A cell that
        // threw is a cell we could not compute, which is exactly null.
        value = null;
      }

      if (value !== null) computed++;
      if (breached(value, threshold)) breaches.push({ row: r, column: c });
      line.push(value);
    }
    cells.push(line);
  }

  if (computed === 0) {
    warnings.push(
      `No cell produced a value for ${metric.label} — the metric may depend on an input the deal has not supplied`,
    );
  }

  const baseRow = row.baseIndex;
  const baseColumn = column ? column.baseIndex : 0;
  const baseValue =
    baseRow !== null && baseColumn !== null ? (cells[baseRow]?.[baseColumn] ?? null) : null;

  return {
    modelKey: definition.key,
    currency: definition.currency,
    metric,
    row,
    column,
    cells,
    base: { row: baseRow, column: column ? baseColumn : null, value: baseValue },
    threshold,
    breaches,
    runs,
    warnings,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

// ------------------------------------------------------------------- presets --

/**
 * A preset is a named pair of axes described by CANDIDATE keys plus a rule for
 * generating values, not by hard-coded input names. A model that calls its exit
 * yield `exit_cap_rate` and a model that calls it `exit_yield` both resolve; a
 * model with neither reports the preset as unavailable instead of throwing.
 */
interface AxisTemplate {
  candidates: string[];
  /** Null means "cannot build an axis for this model". */
  build: (baseValue: number | null, input: InputDef) => Value[] | null;
  /** Human explanation used when build() returns null. */
  requires?: string;
}

interface PresetSpec {
  key: string;
  label: string;
  description: string;
  metricCandidates: string[];
  row: AxisTemplate;
  column?: AxisTemplate;
}

function filterToOptions(input: InputDef, values: Value[]): Value[] | null {
  if (!input.options) return values;
  const allowed = new Set(input.options.map((o) => String(o.value)));
  const kept = values.filter((v) => allowed.has(String(v)));
  return kept.length ? kept : null;
}

const AROUND_100BPS = [-0.01, -0.005, 0, 0.005, 0.01];
const PLUS_MINUS_10PCT = [0.9, 0.95, 1, 1.05, 1.1];

export const PRESETS: PresetSpec[] = [
  {
    key: "exit_yield_x_rent_growth",
    label: "Exit yield x rent growth",
    description:
      "The classic committee table. Exit yield 100bps either side of the base case against rent growth from nil to 6%. Everything an equity return depends on that the buyer does not control.",
    metricCandidates: ["levered_irr", "irr", "unlevered_irr", "equity_multiple"],
    row: {
      candidates: ["exit_yield", "exit_cap_rate", "exit_cap", "terminal_cap_rate", "reversion_yield"],
      build: (base) => {
        if (base === null || base <= 0) return null;
        return AROUND_100BPS.map((d) => tidy(base + d)).filter((v) => v > 0);
      },
      requires: "a base exit yield to move around",
    },
    column: {
      candidates: ["rent_growth", "market_rent_growth", "rental_growth", "rent_growth_rate"],
      build: () => [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06],
    },
  },
  {
    key: "price_x_rent",
    label: "Price x rent",
    description:
      "Purchase price and passing rent 10% either side of the base case. The negotiation table: what you would have to pay, or achieve, for the yield to hold.",
    metricCandidates: ["net_yield", "gross_yield", "levered_irr", "cash_on_cash"],
    row: {
      candidates: ["price", "purchase_price", "purchase_price_input", "acquisition_price"],
      build: (base) => {
        if (base === null || base <= 0) return null;
        return PLUS_MINUS_10PCT.map((m) => Math.round(base * m));
      },
      requires: "a base purchase price to move around",
    },
    column: {
      candidates: ["in_place_rent", "contract_rent", "annual_rent", "passing_rent", "market_rent", "rent"],
      build: (base) => {
        if (base === null || base <= 0) return null;
        return PLUS_MINUS_10PCT.map((m) => Math.round(base * m));
      },
      requires: "a base rent to move around",
    },
  },
  {
    key: "ltv_x_rate",
    label: "LTV x interest rate",
    description:
      "Leverage against the cost of it, reported on DSCR. This is the table the credit committee reads, not the equity one — it says at what point the facility stops clearing cover.",
    metricCandidates: ["dscr", "min_dscr", "debt_yield"],
    row: {
      candidates: ["ltv", "loan_to_value", "ltv_requested"],
      build: () => [0.5, 0.55, 0.6, 0.65, 0.7, 0.75],
    },
    column: {
      candidates: ["interest_rate", "mortgage_rate", "rate", "loan_rate"],
      build: () => [0.035, 0.04, 0.045, 0.05, 0.055, 0.06, 0.065],
    },
  },
  {
    key: "cheque_count",
    label: "Cheque structure",
    description:
      "The same deal at 1, 2, 4, 6 and 12 rent cheques. A Dubai tenancy is paid in post-dated cheques handed over at signing, so fewer cheques means the landlord holds the cash earlier and the return improves without the headline rent moving at all. There is no equivalent line in a US or UK underwrite.",
    metricCandidates: ["cash_on_cash", "net_yield", "levered_irr", "effective_gross_income"],
    row: {
      candidates: ["cheque_count", "cheques", "cheques_per_year", "rent_cheques"],
      build: (_base, input) => filterToOptions(input, [1, 2, 4, 6, 12]),
      requires: "a cheque count the model recognises",
    },
  },
];

export interface PresetAxisSummary {
  key: string;
  label: string;
  unit?: string;
  format?: Format;
  values: Value[];
  baseValue: Value;
  baseIndex: number | null;
}

export interface PresetSummary {
  key: string;
  label: string;
  description: string;
  dimensions: 1 | 2;
  available: boolean;
  /** Why it cannot run against this model. Present only when unavailable. */
  reason?: string;
  metric?: MetricInfo;
  row?: PresetAxisSummary;
  column?: PresetAxisSummary | null;
  runs?: number;
  notes?: string[];
}

function resolveTemplate(
  template: AxisTemplate,
  inputs: Map<string, InputDef>,
  base: Map<string, RunInput>,
): { input: InputDef; values: Value[] } | { missing: string[]; reason?: string } {
  for (const candidate of template.candidates) {
    const input = inputs.get(candidate);
    if (!input) continue;
    const built = template.build(finite(baseValueOf(input, base)), input);
    if (built && built.length) return { input, values: built.slice(0, MAX_AXIS_LENGTH) };
    return {
      missing: [candidate],
      reason: `"${input.label}" is declared but the preset needs ${template.requires ?? "a usable base value"}`,
    };
  }
  return { missing: template.candidates };
}

function summariseAxis(input: InputDef, values: Value[], base: Map<string, RunInput>): PresetAxisSummary {
  const baseValue = baseValueOf(input, base);
  let baseIndex: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (sameValue(values[i], baseValue)) {
      baseIndex = i;
      break;
    }
  }
  return {
    key: input.key,
    label: input.label,
    unit: input.unit,
    format:
      input.type === "currency" ? "currency"
      : input.type === "percent" ? "percent"
      : input.type === "integer" ? "integer"
      : undefined,
    values,
    baseValue,
    baseIndex,
  };
}

interface ResolvedPreset {
  spec: PresetSpec;
  metric: MetricInfo;
  row: { input: InputDef; values: Value[] };
  column: { input: InputDef; values: Value[] } | null;
  notes: string[];
}

function resolvePreset(
  spec: PresetSpec,
  definition: ModelDefinition,
  base: Map<string, RunInput>,
  metricOverride?: string,
): ResolvedPreset | { reason: string } {
  const inputs = inputsOf(definition);
  const metrics = metricsOf(definition);
  const notes: string[] = [];

  let metric: MetricInfo | undefined;
  if (metricOverride) {
    metric = metrics.get(metricOverride);
    if (!metric) return { reason: `"${metricOverride}" is not a computed value of this model` };
  } else {
    for (const candidate of spec.metricCandidates) {
      const hit = metrics.get(candidate);
      if (hit) {
        metric = hit;
        break;
      }
    }
  }
  if (!metric) {
    return {
      reason: `this model computes none of ${spec.metricCandidates.join(", ")}, so there is nothing to report`,
    };
  }
  if (metric.kind === "return" && definition.depth === "quick") {
    notes.push(`${metric.label} needs a full run — request depth "full" or every cell will be blank`);
  }

  const row = resolveTemplate(spec.row, inputs, base);
  if ("missing" in row) {
    return {
      reason: row.reason ?? `this model has no ${spec.row.candidates.join(" / ")} input`,
    };
  }

  let column: { input: InputDef; values: Value[] } | null = null;
  if (spec.column) {
    const resolved = resolveTemplate(spec.column, inputs, base);
    if ("missing" in resolved) {
      return {
        reason: resolved.reason ?? `this model has no ${spec.column.candidates.join(" / ")} input`,
      };
    }
    column = resolved;
  }

  return { spec, metric, row, column, notes };
}

/**
 * The presets that can actually run against this model, with the value ranges
 * already resolved against its base case — so the UI never has to know that
 * one model calls it `exit_cap_rate` and another calls it `exit_yield`.
 */
export function resolvePresets(
  definition: ModelDefinition,
  values: Map<string, RunInput> | Record<string, RunInput>,
): PresetSummary[] {
  const base = toMap(values);
  return PRESETS.map((spec) => {
    const resolved = resolvePreset(spec, definition, base);
    const dimensions: 1 | 2 = spec.column ? 2 : 1;
    if ("reason" in resolved) {
      return {
        key: spec.key,
        label: spec.label,
        description: spec.description,
        dimensions,
        available: false,
        reason: resolved.reason,
      };
    }
    const row = summariseAxis(resolved.row.input, resolved.row.values, base);
    const column = resolved.column
      ? summariseAxis(resolved.column.input, resolved.column.values, base)
      : null;
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      dimensions,
      available: true,
      metric: resolved.metric,
      row,
      column,
      runs: row.values.length * (column ? column.values.length : 1),
      notes: resolved.notes.length ? resolved.notes : undefined,
    };
  });
}

export interface PresetRunOptions {
  definition: ModelDefinition;
  values: Map<string, RunInput> | Record<string, RunInput>;
  preset: string;
  /** Optional override; still validated against the model's computed keys. */
  metric?: string;
  threshold?: ThresholdSpec | null;
}

export function runPreset(options: PresetRunOptions): SensitivityResult {
  const spec = PRESETS.find((p) => p.key === options.preset);
  if (!spec) {
    throw new SensitivityError(
      `"${options.preset}" is not a known preset. Available: ${PRESETS.map((p) => p.key).join(", ")}`,
    );
  }
  const base = toMap(options.values);
  const resolved = resolvePreset(spec, options.definition, base, options.metric);
  if ("reason" in resolved) {
    throw new SensitivityError(`The "${spec.label}" preset does not apply to this model — ${resolved.reason}`);
  }

  const result = runSensitivity({
    definition: options.definition,
    values: base,
    row: { key: resolved.row.input.key, values: resolved.row.values },
    column: resolved.column ? { key: resolved.column.input.key, values: resolved.column.values } : null,
    metric: resolved.metric.key,
    threshold: options.threshold ?? null,
  });

  return { ...result, warnings: [...new Set([...resolved.notes, ...result.warnings])] };
}
