// The shape of a user-editable underwriting model.
//
// This is the contract that makes "the underwriting logic must be customizable,
// not hard-coded" true. A model is data, stored as JSON in the database, not
// code. Nothing in this file knows what a cap rate is; the Dubai and US models
// in src/seed/models are just documents that happen to describe one.
//
// A model has four evaluation stages, in order:
//
//   1. inputs      values from extraction, user edits, or defaults
//   2. lines       scalar formulas over inputs and each other (stabilised year)
//   3. projection  a row-by-year table; each row may read the previous year
//   4. returns     scalar formulas that may aggregate the projection
//
// A "quick" model uses stages 1-2 only. A "full" model uses all four. That is
// the whole of the "start high-level, scale to detailed" requirement: same
// engine, same inputs, a longer definition.

import type { Value } from "./expr.ts";

export type Depth = "quick" | "full";

export type InputType =
  | "currency"
  | "percent"
  | "number"
  | "integer"
  | "boolean"
  | "text"
  | "select"
  | "date";

export type Format =
  | "currency"
  | "currency_compact"
  | "percent"
  | "number"
  | "integer"
  | "multiple"
  | "years"
  | "ratio"
  | "per_sqft"
  | "text"
  | "boolean";

export interface SelectOption {
  value: string | number;
  label: string;
}

export interface InputDef {
  key: string;
  label: string;
  group: string;
  type: InputType;
  unit?: string;
  /** Used when neither extraction nor the user supplied a value. */
  default?: Value;
  options?: SelectOption[];
  min?: number;
  max?: number;
  precision?: number;
  help?: string;
  /** True when the AI extraction pass is expected to find this in a document. */
  extract?: boolean;
  /** Which document normally carries it — drives the extraction prompts. */
  source?: "om" | "rent_roll" | "t12" | "assumption" | "derived";
  /**
   * Binds this input to a value the platform derives from the rent-roll and
   * T12 tables (see deriveFromTables in src/lib/underwrite.ts). A model is free
   * to call its input whatever it likes — `contract_rent`, `annual_rent`,
   * `in_place_rent` — and this declares which derivation feeds it.
   *
   * Without it, a model whose input key happens not to match the derivation key
   * silently falls back to its default, which looks like a working number and
   * is not. Defaults to the input's own key.
   */
  derivedFrom?: string;
  /** A run cannot complete without it; surfaces as a blocking warning. */
  required?: boolean;
  /** Hidden inputs are computed plumbing the reviewer should not have to see. */
  hidden?: boolean;
}

export type Emphasis = "hero" | "strong" | "normal" | "muted";

export interface LineDef {
  key: string;
  label: string;
  group: string;
  /** Expression source. See src/lib/engine/expr.ts for the language. */
  formula: string;
  unit?: string;
  format?: Format;
  precision?: number;
  emphasis?: Emphasis;
  help?: string;
  hidden?: boolean;
}

export interface ProjectionRow {
  key: string;
  label: string;
  /**
   * Evaluated once per year. In scope: every input, every stage-2 line, `year`
   * (1-based), `years` (total), and `prev.<key>` for any projection row —
   * which is null in year 1.
   */
  formula: string;
  unit?: string;
  format?: Format;
  precision?: number;
  emphasis?: Emphasis;
}

export interface ProjectionDef {
  /** Either a fixed count or an input key resolving to one, e.g. "hold_period". */
  years: number | string;
  rows: ProjectionRow[];
}

/**
 * Thresholds a metric is judged against. Purely presentational — they colour a
 * tile and feed the narrative, they never change a computed number.
 */
export interface Benchmark {
  key: string;
  label: string;
  direction: "higher" | "lower";
  good: number;
  warn: number;
  unit?: string;
  note?: string;
}

/**
 * Deterministic deal flags. These run before the AI narrative and are handed to
 * it as established fact, which is what stops the write-up inventing a red flag
 * the numbers do not support. They also mean the product still produces a
 * useful analysis with no API key configured at all.
 */
export interface FlagRule {
  id: string;
  /** Expression returning true/false. Null (missing data) never fires a flag. */
  when: string;
  severity: "red" | "amber" | "info" | "positive";
  title: string;
  /** Supports {key} interpolation against computed values. */
  detail: string;
  /** Metric shown in the card footer, e.g. "dscr". */
  metric?: string;
  /** Suggested due-diligence question this flag implies. */
  dd?: string;
}

export interface ModelDefinition {
  key: string;
  name: string;
  description?: string;
  market: string;
  currency: string;
  depth: Depth;
  assetType: string;
  /** Bumped by the author when the definition changes meaningfully. */
  schemaVersion: number;
  inputs: InputDef[];
  lines: LineDef[];
  projection?: ProjectionDef;
  returns?: LineDef[];
  /** Keys, in order, for the headline KPI band. */
  summary: string[];
  benchmarks?: Benchmark[];
  flags?: FlagRule[];
  /** Free-text methodology note surfaced in the UI and the export. */
  methodology?: string;
}

// ------------------------------------------------------------------ results --

export interface ComputedValue {
  key: string;
  label: string;
  group: string;
  value: Value;
  unit?: string;
  format?: Format;
  precision?: number;
  emphasis?: Emphasis;
  help?: string;
  hidden?: boolean;
  /** Set when the formula could not be evaluated at all. */
  error?: string;
}

export interface ResolvedInput {
  key: string;
  label: string;
  group: string;
  value: Value;
  type: InputType;
  unit?: string;
  format?: Format;
  /**
   * Carried through from the InputDef so the reviewer sees the plain-English
   * explanation next to the field they are being asked to accept or overwrite.
   * `ComputedValue` already carries its own; without this one the UI could
   * explain a result and not the assumption that produced it.
   */
  help?: string;
  /** Where the value actually came from, for the provenance column. */
  origin: "user" | "extracted" | "default" | "missing";
  confidence?: number | null;
  sourceDocumentId?: string | null;
  sourcePage?: number | null;
  sourceSnippet?: string | null;
  aiValue?: Value;
}

export interface ProjectionResult {
  years: number;
  rows: Array<{
    key: string;
    label: string;
    unit?: string;
    format?: Format;
    precision?: number;
    emphasis?: Emphasis;
    values: Value[];
  }>;
}

export interface BenchmarkResult {
  key: string;
  label: string;
  value: Value;
  status: "good" | "warn" | "bad" | "unknown";
  good: number;
  warn: number;
  direction: "higher" | "lower";
  unit?: string;
  note?: string;
  /**
   * Carried over from the line this benchmark grades, so a threshold renders in
   * the same units as the value. Without it a DSCR of 0.99 prints as "98.8%"
   * and a 1.25x covenant prints as "1.25", which is how a memo loses a reader.
   */
  format?: Format;
  precision?: number;
}

export interface FlagResult {
  id: string;
  severity: FlagRule["severity"];
  title: string;
  detail: string;
  metric?: string;
  metricValue?: Value;
  dd?: string;
}

export type WarningLevel = "blocking" | "warning" | "info";

export interface RunWarning {
  level: WarningLevel;
  key?: string;
  message: string;
}

export interface RunResult {
  modelKey: string;
  depth: Depth;
  currency: string;
  inputs: ResolvedInput[];
  lines: ComputedValue[];
  projection?: ProjectionResult;
  returns: ComputedValue[];
  summary: ComputedValue[];
  benchmarks: BenchmarkResult[];
  flags: FlagResult[];
  warnings: RunWarning[];
  /** Every computed key → value, for narrative templating and exports. */
  values: Record<string, Value>;
  durationMs: number;
}
