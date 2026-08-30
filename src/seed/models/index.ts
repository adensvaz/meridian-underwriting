// The system model library.
//
// These are seeded into the database on first run and are the starting point a
// user clones and edits. They are plain data: every formula is a string in the
// expression language defined in src/lib/engine/expr.ts, and nothing here is
// executable code. Adding a market means adding a file to this list.
//
// `market` is a KEY, not a display name — "AE" and "US". Other parts of the
// system (selfcheck, default model selection from env.defaultMarket) match on
// it exactly. The human-readable market is in each model's description.

import type { ModelDefinition } from "../../lib/engine/types.ts";

import { dubaiResidentialQuick } from "./dubai-residential-quick.ts";
import { dubaiResidentialFull } from "./dubai-residential-full.ts";
import { dubaiCommercialFull } from "./dubai-commercial-full.ts";
import { usMultifamilyFull } from "./us-multifamily-full.ts";

export { dubaiResidentialQuick } from "./dubai-residential-quick.ts";
export { dubaiResidentialFull } from "./dubai-residential-full.ts";
export { dubaiCommercialFull } from "./dubai-commercial-full.ts";
export { usMultifamilyFull } from "./us-multifamily-full.ts";

/**
 * Every model shipped with the product, in the order they should be offered.
 * The Dubai quick screen comes first because it is the default entry point for
 * the AE market.
 */
export const SYSTEM_MODELS: ModelDefinition[] = [
  dubaiResidentialQuick,
  dubaiResidentialFull,
  dubaiCommercialFull,
  usMultifamilyFull,
];

/** Lookup by model key. Returns undefined for an unknown key. */
export function systemModelByKey(key: string): ModelDefinition | undefined {
  return SYSTEM_MODELS.find((m) => m.key === key);
}

/** Every model for a market key ("AE", "US"), quick models first. */
export function systemModelsForMarket(market: string): ModelDefinition[] {
  return SYSTEM_MODELS.filter((m) => m.market === market).sort((a, b) =>
    a.depth === b.depth ? 0 : a.depth === "quick" ? -1 : 1,
  );
}
