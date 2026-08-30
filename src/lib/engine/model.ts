// The underwriting runner: takes a model definition plus a set of input values
// and produces every computed figure, the multi-year projection, benchmark
// gradings and deterministic deal flags.
//
// This module runs ONLY on the server. That is a hard product requirement — the
// client is never sent a formula, only computed values — and it is enforced
// structurally: nothing under public/ imports anything from src/.

import {
  compile,
  evaluate,
  FormulaError,
  functionsOf,
  FUNCTIONS,
  irrOf,
  referencesOf,
  type HostFunctions,
  type Value,
} from "./expr.ts";
import { formatValue } from "../format.ts";
import type {
  BenchmarkResult,
  ComputedValue,
  FlagResult,
  LineDef,
  ModelDefinition,
  ProjectionResult,
  ResolvedInput,
  RunResult,
  RunWarning,
} from "./types.ts";

// Names the runner injects that a formula may read but no input may shadow.
const RESERVED = new Set(["year", "years", "period"]);
const SERIES_FUNCTIONS = new Set([
  "series_sum",
  "series_avg",
  "series_min",
  "series_max",
  "series_at",
  "series_first",
  "series_last",
  "series_irr",
  "series_npv",
  "series_count_below",
]);

export interface ValidationIssue {
  level: "error" | "warning";
  where: string;
  message: string;
}

/**
 * Static check of a model definition. Run on every save so a user cannot
 * persist a model that would explode at underwriting time — a broken formula
 * must fail in the model editor, next to the field that caused it.
 */
export function validateModel(def: ModelDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!def.key) issues.push({ level: "error", where: "model", message: "Model key is required" });
  if (!def.name) issues.push({ level: "error", where: "model", message: "Model name is required" });

  const inputKeys = new Set<string>();
  for (const input of def.inputs ?? []) {
    if (RESERVED.has(input.key)) {
      issues.push({
        level: "error",
        where: `input.${input.key}`,
        message: `"${input.key}" is a reserved name`,
      });
    }
    if (inputKeys.has(input.key)) {
      issues.push({ level: "error", where: `input.${input.key}`, message: "Duplicate input key" });
    }
    inputKeys.add(input.key);
  }

  const lineKeys = new Set<string>();
  const known = new Set<string>([...inputKeys, ...RESERVED]);

  const checkFormula = (where: string, src: string, extraNames: Set<string>): Set<string> => {
    let refs = new Set<string>();
    try {
      const ast = compile(src);
      refs = referencesOf(ast);
      for (const fn of functionsOf(ast)) {
        // Object.hasOwn, not a bare index: `constructor` and `toString` are
        // inherited from Object.prototype and would otherwise validate.
        if (!Object.hasOwn(FUNCTIONS, fn) && !SERIES_FUNCTIONS.has(fn)) {
          issues.push({ level: "error", where, message: `Unknown function "${fn}()"` });
        }
      }
      for (const ref of refs) {
        const bare = ref.startsWith("prev.") ? ref.slice(5) : ref;
        if (!extraNames.has(bare) && !known.has(bare)) {
          issues.push({ level: "error", where, message: `Unknown value "${ref}"` });
        }
      }
    } catch (err) {
      const message = err instanceof FormulaError ? err.message : String(err);
      issues.push({ level: "error", where, message });
    }
    return refs;
  };

  // Stage 2 lines, checked in declaration order against a growing scope. This
  // also means a definition must declare a line before it is used, which keeps
  // a hand-edited model readable top to bottom.
  for (const line of def.lines ?? []) {
    if (lineKeys.has(line.key) || inputKeys.has(line.key)) {
      issues.push({ level: "error", where: `line.${line.key}`, message: "Duplicate key" });
    }
    checkFormula(`line.${line.key}`, line.formula, known);
    lineKeys.add(line.key);
    known.add(line.key);
  }

  // Stage 3 projection. Rows see each other and prev.<row>.
  if (def.projection) {
    const rowKeys = new Set(def.projection.rows.map((r) => r.key));
    const projectionScope = new Set([...known, ...rowKeys]);
    for (const row of def.projection.rows) {
      checkFormula(`projection.${row.key}`, row.formula, projectionScope);
    }
    if (typeof def.projection.years === "string" && !inputKeys.has(def.projection.years)) {
      issues.push({
        level: "error",
        where: "projection.years",
        message: `Unknown input "${def.projection.years}" for projection length`,
      });
    }
    for (const k of rowKeys) known.add(`__series__${k}`);
  }

  // Stage 4 returns.
  for (const ret of def.returns ?? []) {
    checkFormula(`return.${ret.key}`, ret.formula, known);
    known.add(ret.key);
  }

  for (const key of def.summary ?? []) {
    if (!known.has(key)) {
      issues.push({ level: "warning", where: "summary", message: `Summary references unknown "${key}"` });
    }
  }
  for (const b of def.benchmarks ?? []) {
    if (!known.has(b.key)) {
      issues.push({ level: "warning", where: `benchmark.${b.key}`, message: `Unknown value "${b.key}"` });
    }
  }
  for (const f of def.flags ?? []) {
    checkFormula(`flag.${f.id}`, f.when, known);
  }

  return issues;
}

// ------------------------------------------------------------------ running --

export interface RunInput {
  key: string;
  value: Value;
  origin: ResolvedInput["origin"];
  confidence?: number | null;
  sourceDocumentId?: string | null;
  sourcePage?: number | null;
  sourceSnippet?: string | null;
  aiValue?: Value;
}

export interface RunOptions {
  definition: ModelDefinition;
  /** Keyed by input key. Anything absent falls back to the model default. */
  values: Map<string, RunInput> | Record<string, RunInput>;
}

function toMap(v: RunOptions["values"]): Map<string, RunInput> {
  return v instanceof Map ? v : new Map(Object.entries(v));
}

export function runModel(options: RunOptions): RunResult {
  const started = performance.now();
  const def = options.definition;
  const supplied = toMap(options.values);

  const warnings: RunWarning[] = [];
  const scope = new Map<string, Value>();
  const resolvedInputs: ResolvedInput[] = [];

  // ---- stage 1: inputs -------------------------------------------------

  for (const input of def.inputs ?? []) {
    const hit = supplied.get(input.key);
    let value: Value = hit?.value ?? null;
    let origin: ResolvedInput["origin"] = hit?.origin ?? "missing";

    if (value === null || value === undefined || value === "") {
      if (input.default !== undefined && input.default !== null) {
        value = input.default;
        origin = "default";
      } else {
        value = null;
        origin = "missing";
      }
    }

    // Coerce to the declared type so a string "1,250,000" from a spreadsheet
    // does not silently poison every downstream formula.
    value = coerce(value, input.type);

    if (value !== null && typeof value === "number") {
      if (input.min !== undefined && value < input.min) {
        warnings.push({
          level: "warning",
          key: input.key,
          message: `${input.label} is ${value}, below the expected minimum of ${input.min}`,
        });
      }
      if (input.max !== undefined && value > input.max) {
        warnings.push({
          level: "warning",
          key: input.key,
          message: `${input.label} is ${value}, above the expected maximum of ${input.max}`,
        });
      }
    }

    if (input.required && value === null) {
      warnings.push({
        level: "blocking",
        key: input.key,
        message: `${input.label} is required and was not found in the documents or supplied`,
      });
    }

    scope.set(input.key, value);
    resolvedInputs.push({
      key: input.key,
      label: input.label,
      group: input.group,
      value,
      type: input.type,
      unit: input.unit,
      origin,
      confidence: hit?.confidence ?? null,
      sourceDocumentId: hit?.sourceDocumentId ?? null,
      sourcePage: hit?.sourcePage ?? null,
      sourceSnippet: hit?.sourceSnippet ?? null,
      aiValue: hit?.aiValue,
    });
  }

  const lookup = (name: string): Value | undefined => {
    if (scope.has(name)) return scope.get(name);
    return undefined;
  };

  // ---- stage 2: lines --------------------------------------------------

  const lines: ComputedValue[] = [];
  for (const line of def.lines ?? []) {
    const computed = evalLine(line, { lookup });
    if (computed.error) {
      warnings.push({ level: "warning", key: line.key, message: `${line.label}: ${computed.error}` });
    }
    scope.set(line.key, computed.value);
    lines.push(computed);
  }

  // ---- stage 3: projection ---------------------------------------------

  let projection: ProjectionResult | undefined;
  const series = new Map<string, Value[]>();

  if (def.projection && def.depth !== "quick") {
    const rawYears =
      typeof def.projection.years === "string"
        ? scope.get(def.projection.years)
        : def.projection.years;
    const years = clampYears(rawYears);

    if (years === null) {
      warnings.push({
        level: "warning",
        message: "Projection skipped — the hold period is missing or out of range",
      });
    } else {
      for (const row of def.projection.rows) series.set(row.key, []);

      for (let y = 1; y <= years; y++) {
        // Values computed earlier in THIS year are visible to later rows.
        const yearScope = new Map<string, Value>();
        const projectionLookup = (name: string): Value | undefined => {
          if (name === "year") return y;
          if (name === "years") return years;
          if (name.startsWith("prev.")) {
            const key = name.slice(5);
            const history = series.get(key);
            if (!history) return undefined;
            return y === 1 ? null : (history[y - 2] ?? null);
          }
          if (yearScope.has(name)) return yearScope.get(name);
          return lookup(name);
        };

        for (const row of def.projection.rows) {
          let value: Value = null;
          try {
            value = evaluate(compile(row.formula), { lookup: projectionLookup });
          } catch (err) {
            if (y === 1) {
              warnings.push({
                level: "warning",
                key: row.key,
                message: `${row.label}: ${err instanceof FormulaError ? err.message : String(err)}`,
              });
            }
          }
          yearScope.set(row.key, value);
          series.get(row.key)!.push(value);
        }
      }

      projection = {
        years,
        rows: def.projection.rows.map((row) => ({
          key: row.key,
          label: row.label,
          unit: row.unit,
          format: row.format,
          precision: row.precision,
          emphasis: row.emphasis,
          values: series.get(row.key) ?? [],
        })),
      };
    }
  }

  // ---- stage 4: returns ------------------------------------------------

  const host = seriesFunctions(series);
  const returns: ComputedValue[] = [];
  for (const ret of def.returns ?? []) {
    const computed = evalLine(ret, { lookup, host });
    if (computed.error) {
      warnings.push({ level: "warning", key: ret.key, message: `${ret.label}: ${computed.error}` });
    }
    scope.set(ret.key, computed.value);
    returns.push(computed);
  }

  // ---- gradings and flags ----------------------------------------------

  const values: Record<string, Value> = {};
  for (const [k, v] of scope) values[k] = v;

  // Presentation metadata for every computed key, so flag prose and benchmark
  // thresholds render in the same units as the figure they describe.
  const formatByKey = new Map<string, { format?: string; precision?: number }>();
  for (const line of [...(def.lines ?? []), ...(def.returns ?? [])]) {
    formatByKey.set(line.key, { format: line.format, precision: line.precision });
  }
  for (const input of def.inputs ?? []) {
    if (formatByKey.has(input.key)) continue;
    const format =
      input.type === "currency" ? "currency"
      : input.type === "percent" ? "percent"
      : input.type === "integer" ? "integer"
      : undefined;
    formatByKey.set(input.key, { format, precision: input.precision });
  }

  const benchmarks: BenchmarkResult[] = (def.benchmarks ?? []).map((b) => {
    const value = scope.get(b.key) ?? null;
    const presentation = formatByKey.get(b.key);
    let status: BenchmarkResult["status"] = "unknown";
    if (typeof value === "number" && Number.isFinite(value)) {
      if (b.direction === "higher") {
        status = value >= b.good ? "good" : value >= b.warn ? "warn" : "bad";
      } else {
        status = value <= b.good ? "good" : value <= b.warn ? "warn" : "bad";
      }
    }
    return {
      key: b.key,
      label: b.label,
      value,
      status,
      good: b.good,
      warn: b.warn,
      direction: b.direction,
      unit: b.unit,
      note: b.note,
      format: presentation?.format as BenchmarkResult["format"],
      precision: presentation?.precision,
    };
  });

  const flags: FlagResult[] = [];
  for (const rule of def.flags ?? []) {
    let fired: Value = null;
    try {
      fired = evaluate(compile(rule.when), { lookup, host });
    } catch {
      // A flag that cannot be evaluated is silently skipped. Flags are
      // advisory; one broken rule must not take down the whole underwriting.
      continue;
    }
    // Null means "not enough data to judge" and must NOT fire a flag. Claiming
    // a red flag on absent data is worse than staying quiet about it.
    if (fired === true) {
      flags.push({
        id: rule.id,
        severity: rule.severity,
        title: rule.title,
        detail: interpolate(rule.detail, values, def.currency, formatByKey),
        metric: rule.metric,
        metricValue: rule.metric ? (scope.get(rule.metric) ?? null) : undefined,
        // The due-diligence question interpolates too — a memo containing a
        // raw "{dscr_covenant}" placeholder is worse than no memo.
        dd: rule.dd ? interpolate(rule.dd, values, def.currency, formatByKey) : undefined,
      });
    }
  }

  const byKey = new Map<string, ComputedValue>();
  for (const c of [...lines, ...returns]) byKey.set(c.key, c);
  const summary: ComputedValue[] = (def.summary ?? [])
    .map((key) => byKey.get(key))
    .filter((c): c is ComputedValue => Boolean(c));

  // Surface silent gaps: an input that nothing filled in and that a formula
  // actually depended on is the single most common cause of a wrong number.
  for (const input of resolvedInputs) {
    if (input.origin === "missing" && !warnings.some((w) => w.key === input.key)) {
      warnings.push({
        level: "info",
        key: input.key,
        message: `${input.label} was not found — dependent figures may be incomplete`,
      });
    }
  }

  return {
    modelKey: def.key,
    depth: def.depth,
    currency: def.currency,
    inputs: resolvedInputs,
    lines,
    projection,
    returns,
    summary,
    benchmarks,
    flags,
    warnings,
    values,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

// ------------------------------------------------------------------ helpers --

function evalLine(
  line: LineDef,
  ctx: { lookup: (n: string) => Value | undefined; host?: HostFunctions },
): ComputedValue {
  const base: ComputedValue = {
    key: line.key,
    label: line.label,
    group: line.group,
    value: null,
    unit: line.unit,
    format: line.format,
    precision: line.precision,
    emphasis: line.emphasis,
    help: line.help,
    hidden: line.hidden,
  };
  try {
    base.value = evaluate(compile(line.formula), ctx);
  } catch (err) {
    base.error = err instanceof FormulaError ? err.message : String(err);
  }
  return base;
}

function clampYears(raw: Value | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  if (n < 1) return null;
  // A hard ceiling keeps a malformed model from producing a 10,000-row table.
  return Math.min(n, 40);
}

function coerce(value: Value, type: string): Value {
  if (value === null) return null;

  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
    return null;
  }

  if (type === "text" || type === "select" || type === "date") {
    return typeof value === "string" ? value : String(value);
  }

  if (typeof value === "number") {
    return type === "integer" ? Math.round(value) : value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;

  // Spreadsheets and OMs hand over "AED 1,250,000", "(4,200)", "6.5%".
  const cleaned = String(value)
    .replace(/[\s ]/g, "")
    .replace(/^(aed|usd|us\$|\$|£|€|د\.إ)/i, "")
    .replace(/,/g, "");
  const negated = /^\(.*\)$/.test(cleaned);
  const inner = negated ? cleaned.slice(1, -1) : cleaned;
  const isPercent = inner.endsWith("%");
  const numeric = Number(isPercent ? inner.slice(0, -1) : inner);
  if (!Number.isFinite(numeric)) return null;

  let out = negated ? -numeric : numeric;
  // A percent-typed input written as "6.5%" means 0.065; written as 6.5 it
  // also means 0.065. Bare 0.065 is left alone.
  if (type === "percent") {
    if (isPercent) out = out / 100;
    else if (Math.abs(out) > 1) out = out / 100;
  }
  return type === "integer" ? Math.round(out) : out;
}

function seriesFunctions(series: Map<string, Value[]>): HostFunctions {
  const get = (name: Value): number[] => {
    if (typeof name !== "string") return [];
    return (series.get(name) ?? []).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  };

  return {
    series_sum: (args) => {
      const xs = get(args[0]);
      return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
    },
    series_avg: (args) => {
      const xs = get(args[0]);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    },
    series_min: (args) => {
      const xs = get(args[0]);
      return xs.length ? Math.min(...xs) : null;
    },
    series_max: (args) => {
      const xs = get(args[0]);
      return xs.length ? Math.max(...xs) : null;
    },
    series_first: (args) => {
      const xs = get(args[0]);
      return xs.length ? xs[0] : null;
    },
    series_last: (args) => {
      const xs = get(args[0]);
      return xs.length ? xs[xs.length - 1] : null;
    },
    // series_at(key, year) — 1-based, matching how the table is labelled.
    series_at: (args) => {
      const xs = get(args[0]);
      const y = typeof args[1] === "number" ? Math.trunc(args[1]) : NaN;
      if (!Number.isFinite(y) || y < 1 || y > xs.length) return null;
      return xs[y - 1];
    },
    // series_count_below(key, threshold) — e.g. how many years DSCR < 1.25.
    series_count_below: (args) => {
      const xs = get(args[0]);
      const t = typeof args[1] === "number" ? args[1] : NaN;
      if (!Number.isFinite(t)) return null;
      return xs.filter((x) => x < t).length;
    },
    // series_irr(key, initialCashFlow) — initial is t=0 and normally negative.
    series_irr: (args) => {
      const xs = get(args[0]);
      const t0 = typeof args[1] === "number" ? args[1] : NaN;
      if (!Number.isFinite(t0) || !xs.length) return null;
      return irrOf([t0, ...xs]);
    },
    // series_npv(key, rate, initialCashFlow)
    series_npv: (args) => {
      const xs = get(args[0]);
      const rate = typeof args[1] === "number" ? args[1] : NaN;
      const t0 = typeof args[2] === "number" ? args[2] : 0;
      if (!Number.isFinite(rate) || !xs.length) return null;
      let total = t0;
      for (let i = 0; i < xs.length; i++) total += xs[i] / Math.pow(1 + rate, i + 1);
      return Number.isFinite(total) ? total : null;
    },
  };
}

/**
 * Replaces {key} with a formatted value in flag prose and due-diligence text.
 *
 * It uses the model's DECLARED format for the key rather than guessing from the
 * magnitude. Guessing produced "DSCR is 98.8%x against a 1.25x covenant",
 * because a DSCR of 0.988 is below 1 and looked like a rate. A model that
 * declares dscr as a ratio gets a ratio.
 */
function interpolate(
  template: string,
  values: Record<string, Value>,
  currency: string,
  formatByKey: Map<string, { format?: string; precision?: number }>,
): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g, (_whole, key: string) => {
    const v = Object.hasOwn(values, key) ? values[key] : undefined;
    if (v === undefined || v === null) return "—";

    const declared = formatByKey.get(key);
    if (declared?.format) return formatValue(v, declared.format, currency, declared.precision);

    if (typeof v === "number") {
      // No declared format. Fall back to the shared formatter's own heuristic
      // so at least the whole product guesses the same way.
      return formatValue(v, undefined, currency);
    }
    return String(v);
  });
}
