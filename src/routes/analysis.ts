// Analysis endpoints: sensitivity grids and loan sizing.
//
// These follow the same two invariants as the rest of the API. Nothing here
// touches the database except through repo.ts, which is ownership-scoped by
// actor, so there is no path to a deal the caller does not own. And nothing
// here returns a formula: a sensitivity grid is numbers plus the label, unit
// and format needed to render them, and the solver returns an amount and the
// name of the constraint that produced it.
//
// Every input key that reaches the engine is validated against the model's own
// declared inputs first. A grid is N model runs driven by a caller-supplied
// key; running one over an arbitrary name would be both a correctness hole and
// a way to probe the shape of a model the caller cannot otherwise read.

import { HttpError, json, readJson } from "../lib/http/server.ts";
import type { Ctx, Router } from "../lib/http/server.ts";
import * as repo from "../lib/db/repo.ts";
import { assembleInputs } from "../lib/underwrite.ts";
import {
  MAX_AXIS_LENGTH,
  PRESETS,
  resolvePresets,
  runPreset,
  runSensitivity,
  SensitivityError,
} from "../lib/engine/sensitivity.ts";
import type { AxisRequest, ThresholdSpec } from "../lib/engine/sensitivity.ts";
import { DEFAULT_MAX_LTV, DEFAULT_MIN_DSCR, solveLoanAmount } from "../lib/engine/solver.ts";
import type { RunInput } from "../lib/engine/model.ts";
import type { Depth, ModelDefinition } from "../lib/engine/types.ts";
import type { Value } from "../lib/engine/expr.ts";

interface AnalysisContext {
  definition: ModelDefinition;
  values: Map<string, RunInput>;
  modelName: string;
  depth: Depth;
}

/**
 * Resolve a deal to the model definition and base inputs the analysis will run
 * against — the same assembly the review screen and /preview use, so a grid's
 * base case is the deal as it actually stands.
 */
function loadContext(
  ctx: Ctx,
  options: { modelId?: unknown; depth?: unknown },
): AnalysisContext {
  const deal = repo.getDeal(ctx.user, ctx.params.id);
  if (!deal) throw new HttpError(404, "Deal not found");

  const modelId = typeof options.modelId === "string" && options.modelId ? options.modelId : deal.model_id;
  if (!modelId) throw new HttpError(400, "This deal has no underwriting model selected");

  const row = repo.getModelRow(ctx.user, modelId);
  const definition = repo.getModelDefinition(ctx.user, modelId);
  if (!row || !definition) throw new HttpError(404, "Underwriting model not found");

  let depth: Depth = (deal.depth as Depth) ?? definition.depth;
  if (options.depth !== undefined) {
    if (options.depth !== "quick" && options.depth !== "full") {
      throw new HttpError(400, 'Depth must be "quick" or "full"');
    }
    depth = options.depth;
  }

  const effective: ModelDefinition = { ...definition, depth };
  const { values } = assembleInputs(ctx.user, deal, effective);
  return { definition: effective, values, modelName: row.name, depth };
}

/** Engine rejections are client mistakes, not server faults. */
function asHttp(err: unknown): never {
  if (err instanceof SensitivityError) throw new HttpError(400, err.message);
  throw err;
}

function readAxis(raw: unknown, which: "row" | "column"): AxisRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, `A ${which} variable is required, as { key, values }`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key) {
    throw new HttpError(400, `The ${which} variable needs an input key`);
  }
  if (!Array.isArray(record.values) || record.values.length === 0) {
    throw new HttpError(400, `The ${which} variable needs at least one value`);
  }
  if (record.values.length > MAX_AXIS_LENGTH) {
    throw new HttpError(
      400,
      `A sensitivity axis is limited to ${MAX_AXIS_LENGTH} values — the ${which} variable has ${record.values.length}`,
    );
  }
  for (const value of record.values) {
    const type = typeof value;
    if (value !== null && type !== "number" && type !== "string" && type !== "boolean") {
      throw new HttpError(400, `The ${which} variable takes numbers, text or true/false only`);
    }
  }
  return { key: record.key, values: record.values as Value[] };
}

function readThreshold(raw: unknown): ThresholdSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "A threshold is { direction: \"min\" | \"max\", value }");
  }
  const record = raw as Record<string, unknown>;
  if (record.direction !== "min" && record.direction !== "max") {
    throw new HttpError(400, 'A threshold direction must be "min" or "max"');
  }
  if (typeof record.value !== "number" || !Number.isFinite(record.value)) {
    throw new HttpError(400, "A threshold needs a finite numeric value");
  }
  return {
    direction: record.direction,
    value: record.value,
    label: typeof record.label === "string" ? record.label.slice(0, 120) : undefined,
  };
}

function readRate(raw: unknown, name: string, bounds: [number, number]): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new HttpError(400, `${name} must be a number`);
  }
  if (raw < bounds[0] || raw > bounds[1]) {
    throw new HttpError(400, `${name} must be between ${bounds[0]} and ${bounds[1]}`);
  }
  return raw;
}

export function registerAnalysisRoutes(router: Router): void {
  // ------------------------------------------------------------ sensitivity --

  router.post("/api/deals/:id/sensitivity", async (ctx) => {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const context = loadContext(ctx, { modelId: body.modelId, depth: body.depth });

    if (typeof body.metric !== "string" || !body.metric) {
      throw new HttpError(400, "A metric to report is required");
    }

    const row = readAxis(body.row, "row");
    const column = body.column === undefined || body.column === null ? null : readAxis(body.column, "column");

    try {
      const result = runSensitivity({
        definition: context.definition,
        values: context.values,
        row,
        column,
        metric: body.metric,
        threshold: readThreshold(body.threshold),
      });
      json(ctx.res, 200, { modelName: context.modelName, depth: context.depth, sensitivity: result });
    } catch (err) {
      asHttp(err);
    }
  });

  /**
   * The presets that apply to THIS deal's model, with their value ranges already
   * resolved against its base case. The UI reads this rather than hard-coding
   * input keys, which is what lets a preset survive a model that names its exit
   * yield differently — or report itself unavailable when there is none.
   */
  router.get(
    "/api/deals/:id/sensitivity/presets",
    (ctx) => {
      const context = loadContext(ctx, {
        modelId: ctx.query.get("modelId") ?? undefined,
        depth: ctx.query.get("depth") ?? undefined,
      });
      json(ctx.res, 200, {
        modelName: context.modelName,
        depth: context.depth,
        presets: resolvePresets(context.definition, context.values),
      });
    },
    { csrf: false },
  );

  router.post("/api/deals/:id/sensitivity/preset", async (ctx) => {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const context = loadContext(ctx, { modelId: body.modelId, depth: body.depth });

    if (typeof body.preset !== "string" || !body.preset) {
      throw new HttpError(
        400,
        `A preset name is required. Available: ${PRESETS.map((p) => p.key).join(", ")}`,
      );
    }
    if (body.metric !== undefined && typeof body.metric !== "string") {
      throw new HttpError(400, "A metric override must be a key");
    }

    try {
      const result = runPreset({
        definition: context.definition,
        values: context.values,
        preset: body.preset,
        metric: body.metric as string | undefined,
        threshold: readThreshold(body.threshold),
      });
      json(ctx.res, 200, {
        modelName: context.modelName,
        depth: context.depth,
        preset: body.preset,
        sensitivity: result,
      });
    } catch (err) {
      asHttp(err);
    }
  });

  // -------------------------------------------------------------- loan sizing --

  router.post("/api/deals/:id/solve-loan", async (ctx) => {
    const body = await readJson<Record<string, unknown>>(ctx.req);
    const context = loadContext(ctx, { modelId: body.modelId, depth: body.depth });

    const maxLtv = readRate(body.maxLtv, "maxLtv", [0, 1]) ?? DEFAULT_MAX_LTV;
    const minDscr = readRate(body.minDscr, "minDscr", [0.1, 5]) ?? DEFAULT_MIN_DSCR;
    const minDebtYield = readRate(body.minDebtYield, "minDebtYield", [0, 1]) ?? null;

    const solution = solveLoanAmount({
      definition: context.definition,
      values: context.values,
      maxLtv,
      minDscr,
      minDebtYield,
    });

    // "Unavailable" is information about the model, not a bad request — the
    // caller asked a reasonable question this model cannot answer.
    json(ctx.res, 200, { modelName: context.modelName, depth: context.depth, solution });
  });
}
