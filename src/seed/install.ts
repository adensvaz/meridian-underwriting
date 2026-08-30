// Installs the underwriting models that ship with the product.
//
// These are "system" models: readable by every account, editable by none. A
// user who wants to change the methodology clones one, and their copy is fully
// editable. That preserves a known-good baseline to compare against and means a
// broken custom model is always one click away from a working reference.
//
// Runs on every boot and is idempotent, so shipping a corrected formula is a
// deploy rather than a migration.

import { SYSTEM_MODELS } from "./models/index.ts";
import { validateModel } from "../lib/engine/model.ts";
import { upsertSystemModel } from "../lib/db/repo.ts";

export function installSystemModels(): number {
  let installed = 0;

  for (const definition of SYSTEM_MODELS) {
    const issues = validateModel(definition);
    const errors = issues.filter((i) => i.level === "error");

    if (errors.length) {
      // A broken shipped model is a build defect, not a runtime condition. Fail
      // loudly in the log but keep serving — the other models still work.
      console.error(
        `[seed] model "${definition.key}" failed validation and was NOT installed:\n` +
          errors.map((e) => `        ${e.where}: ${e.message}`).join("\n"),
      );
      continue;
    }

    for (const warning of issues) {
      console.warn(`[seed] ${definition.key} — ${warning.where}: ${warning.message}`);
    }

    upsertSystemModel(definition);
    installed++;
  }

  return installed;
}
