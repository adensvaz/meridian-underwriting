// The underwriting service: assemble inputs, run the model, persist the run.
//
// Input precedence, highest first:
//   1. a value the user typed on the review screen  (user_value)
//   2. a value derived from the rent roll or T12 tables
//   3. a value the AI pulled out of a document      (ai_value)
//   4. the model's declared default
//
// A human correction always beats the machine. That ordering is the whole
// reason ai_value and user_value are separate columns.

import { runModel } from "./engine/model.ts";
import type { RunInput } from "./engine/model.ts";
import type { ModelDefinition, RunResult } from "./engine/types.ts";
import type { Value } from "./engine/expr.ts";
import type { AuthenticatedUser } from "./auth/session.ts";
import {
  getDeal,
  getModelDefinition,
  getModelRow,
  listFields,
  listRentRoll,
  listT12,
  saveRun,
  touchDeal,
  type DealRow,
  type RentRollUnitRow,
  type T12LineRow,
} from "./db/repo.ts";

/**
 * Figures computed from the rent roll and T12 tables rather than from a single
 * extracted field. These are what make the review screen's totals foot: the
 * unit rents on screen sum to the gross rent the model uses.
 */
export interface DerivedInputs {
  values: Record<string, Value>;
  notes: string[];
}

export function deriveFromTables(
  units: RentRollUnitRow[],
  t12: T12LineRow[],
): DerivedInputs {
  const values: Record<string, Value> = {};
  const notes: string[] = [];

  if (units.length) {
    const occupied = units.filter((u) => (u.occupancy_status ?? "occupied") !== "vacant");
    const rents = units.map((u) => u.in_place_rent).filter((r): r is number => typeof r === "number");
    const marketRents = units
      .map((u) => u.market_rent ?? u.in_place_rent)
      .filter((r): r is number => typeof r === "number");
    const areas = units.map((u) => u.area_sqft).filter((a): a is number => typeof a === "number");
    const cheques = units.map((u) => u.cheques).filter((c): c is number => typeof c === "number");

    if (rents.length) {
      values.annual_rent = rents.reduce((a, b) => a + b, 0);
      values.in_place_rent_total = values.annual_rent;
      notes.push(`Annual rent summed from ${rents.length} rent-roll line(s)`);
    }
    if (marketRents.length) {
      values.market_rent_total = marketRents.reduce((a, b) => a + b, 0);
    }
    if (areas.length) {
      values.size_sqft = areas.reduce((a, b) => a + b, 0);
      notes.push(`Area summed from ${areas.length} rent-roll line(s)`);
    }
    if (cheques.length) {
      // The modal cheque count, not the mean — "3.4 cheques" is not a thing
      // that exists in a Dubai tenancy contract.
      const tally = new Map<number, number>();
      for (const c of cheques) tally.set(c, (tally.get(c) ?? 0) + 1);
      let best = cheques[0];
      let bestCount = 0;
      for (const [value, count] of tally) {
        if (count > bestCount) {
          best = value;
          bestCount = count;
        }
      }
      values.cheque_count = best;
    }

    values.units_count = units.length;
    if (units.length) {
      values.physical_occupancy = occupied.length / units.length;
      values.occupancy_by_units = values.physical_occupancy;

      // Area-weighted occupancy. For a commercial asset with suites of
      // different sizes this is the meaningful number and unit-count occupancy
      // is misleading: one vacant 600 sqft suite in a 6,800 sqft floor of five
      // is 80% by count and 91.2% by area, and the service-charge and
      // recovery lines follow the area, not the count.
      const occupiedArea = occupied.reduce((sum, u) => sum + (u.area_sqft ?? 0), 0);
      const totalArea = units.reduce((sum, u) => sum + (u.area_sqft ?? 0), 0);
      const areasComplete = totalArea > 0 && units.every((u) => typeof u.area_sqft === "number");

      if (areasComplete) {
        values.occupancy_by_area = occupiedArea / totalArea;
        values.vacant_area_sqft = totalArea - occupiedArea;
      }

      // The canonical measure a model should bind to. Area-weighted when the
      // rent roll carries a complete set of areas, unit-count otherwise.
      //
      // Binding a model directly to `occupancy_by_area` would look more precise
      // and behave worse: on a rent roll missing a single area the derivation
      // vanishes and the input silently falls back to its default, which is a
      // plausible number unrelated to the document. Degrading to the unit-count
      // measure is less exact but always answers the question that was asked.
      values.occupancy = areasComplete
        ? (values.occupancy_by_area as number)
        : occupied.length / units.length;

      const vacant = units.length - occupied.length;
      if (vacant > 0) {
        const byArea = values.occupancy_by_area;
        notes.push(
          typeof byArea === "number"
            ? `${vacant} of ${units.length} unit(s) vacant — ${(byArea * 100).toFixed(1)}% occupancy by area, ${((occupied.length / units.length) * 100).toFixed(1)}% by unit count`
            : `${vacant} of ${units.length} unit(s) recorded as vacant`,
        );
      }
    }
  }

  if (t12.length) {
    const recurring = t12.filter((l) => l.is_recurring === 1 && !l.exclude_reason);

    const annualise = (l: T12LineRow): number | null => {
      if (typeof l.annualized === "number") return l.annualized;
      if (typeof l.amount !== "number") return null;
      const months = l.months_covered > 0 ? l.months_covered : 12;
      return (l.amount / months) * 12;
    };

    const opex = recurring
      .filter((l) => l.section === "opex")
      .map(annualise)
      .filter((n): n is number => n !== null);
    const income = recurring
      .filter((l) => l.section === "income")
      .map(annualise)
      .filter((n): n is number => n !== null);

    if (opex.length) {
      values.t12_opex_total = opex.reduce((a, b) => a + b, 0);
      notes.push(`Operating expenses annualised from ${opex.length} T12 line(s)`);
    }
    if (income.length) {
      values.t12_income_total = income.reduce((a, b) => a + b, 0);
    }

    const excluded = t12.filter((l) => l.exclude_reason || l.is_recurring === 0);
    if (excluded.length) {
      notes.push(`${excluded.length} T12 line(s) excluded as non-recurring — see the T12 tab`);
    }

    // Roll each normalised category up so a model can reference, for example,
    // `t12_insurance` directly.
    const byCategory = new Map<string, number>();
    for (const line of recurring) {
      if (!line.category) continue;
      const amount = annualise(line);
      if (amount === null) continue;
      byCategory.set(line.category, (byCategory.get(line.category) ?? 0) + amount);
    }
    for (const [category, amount] of byCategory) {
      values[`t12_${category}`] = amount;
    }
  }

  return { values, notes };
}

export interface AssembledInputs {
  values: Map<string, RunInput>;
  derivedNotes: string[];
}

export function assembleInputs(
  actor: AuthenticatedUser,
  deal: DealRow,
  definition: ModelDefinition,
): AssembledInputs {
  const fields = listFields(actor, deal.id);
  const units = listRentRoll(actor, deal.id);
  const t12 = listT12(actor, deal.id);
  const derived = deriveFromTables(units, t12);

  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const values = new Map<string, RunInput>();

  for (const input of definition.inputs ?? []) {
    const field = byKey.get(input.key);
    // A model names its inputs however it likes; `derivedFrom` says which of
    // the platform's rent-roll / T12 derivations feeds this one.
    const derivationKey = input.derivedFrom ?? input.key;
    const derivedValue = Object.hasOwn(derived.values, derivationKey)
      ? derived.values[derivationKey]
      : undefined;

    // 1. user override
    if (field?.user_value !== null && field?.user_value !== undefined) {
      values.set(input.key, {
        key: input.key,
        value: field.user_value,
        origin: "user",
        confidence: null,
        sourceDocumentId: field.source_document_id,
        sourcePage: field.source_page,
        sourceSnippet: field.source_snippet,
        aiValue: field.ai_value,
      });
      continue;
    }

    // 2. derived from the rent roll / T12 tables
    if (derivedValue !== undefined && derivedValue !== null) {
      values.set(input.key, {
        key: input.key,
        value: derivedValue,
        origin: "extracted",
        confidence: field?.confidence ?? 0.9,
        sourceDocumentId: field?.source_document_id ?? null,
        sourcePage: field?.source_page ?? null,
        sourceSnippet: "Derived from the rent roll / T12 tables",
        aiValue: field?.ai_value,
      });
      continue;
    }

    // 3. AI-extracted single value
    if (field?.ai_value !== null && field?.ai_value !== undefined) {
      values.set(input.key, {
        key: input.key,
        value: field.ai_value,
        origin: "extracted",
        confidence: field.confidence,
        sourceDocumentId: field.source_document_id,
        sourcePage: field.source_page,
        sourceSnippet: field.source_snippet,
        aiValue: field.ai_value,
      });
      continue;
    }

    // 4. fall through to the model default, handled inside runModel
  }

  return { values, derivedNotes: derived.notes };
}

export interface UnderwriteOutcome {
  runId: string;
  result: RunResult;
  modelName: string;
  derivedNotes: string[];
}

export function underwriteDeal(
  actor: AuthenticatedUser,
  dealId: string,
  options: { modelId?: string; depth?: "quick" | "full" } = {},
): UnderwriteOutcome {
  const deal = getDeal(actor, dealId);
  if (!deal) throw new Error("Deal not found");

  const modelId = options.modelId ?? deal.model_id;
  if (!modelId) throw new Error("This deal has no underwriting model selected");

  const modelRow = getModelRow(actor, modelId);
  const definition = getModelDefinition(actor, modelId);
  if (!modelRow || !definition) throw new Error("Underwriting model not found");

  // Depth is a property of the run, not only of the model, so the same
  // definition can produce the fast pass and the full pass.
  const effective: ModelDefinition = {
    ...definition,
    depth: options.depth ?? (deal.depth as "quick" | "full") ?? definition.depth,
  };

  const { values, derivedNotes } = assembleInputs(actor, deal, effective);
  const result = runModel({ definition: effective, values });

  const runId = saveRun(deal.id, actor.id, {
    modelId: modelRow.id,
    modelVersion: modelRow.version,
    depth: effective.depth,
    // The definition is snapshotted so a finished deal never silently changes
    // because somebody edited the template afterwards.
    modelSnapshot: effective,
    inputsSnapshot: result.inputs,
    results: {
      lines: result.lines,
      returns: result.returns,
      summary: result.summary,
      values: result.values,
      // Flags are persisted with the run so a narrative regenerated later still
      // agrees with the model version that actually produced these numbers.
      flags: result.flags,
    },
    projection: result.projection,
    benchmarks: result.benchmarks,
    warnings: [...result.warnings, ...derivedNotes.map((m) => ({ level: "info" as const, message: m }))],
    durationMs: result.durationMs,
  });

  touchDeal(deal.id, "underwritten");

  return { runId, result, modelName: modelRow.name, derivedNotes };
}

/**
 * A run with no persistence, for the review screen's live recalculation as the
 * user edits an assumption. Same engine, same inputs, no database write —
 * which is what keeps "editing vacancy updates every dependent metric" fast.
 */
export function previewUnderwrite(
  actor: AuthenticatedUser,
  dealId: string,
  overrides: Record<string, Value>,
  options: { modelId?: string; depth?: "quick" | "full" } = {},
): RunResult {
  const deal = getDeal(actor, dealId);
  if (!deal) throw new Error("Deal not found");

  const modelId = options.modelId ?? deal.model_id;
  if (!modelId) throw new Error("This deal has no underwriting model selected");

  const definition = getModelDefinition(actor, modelId);
  if (!definition) throw new Error("Underwriting model not found");

  const effective: ModelDefinition = {
    ...definition,
    depth: options.depth ?? (deal.depth as "quick" | "full") ?? definition.depth,
  };

  const { values } = assembleInputs(actor, deal, effective);
  for (const [key, value] of Object.entries(overrides)) {
    values.set(key, { key, value, origin: "user" });
  }

  return runModel({ definition: effective, values });
}
