// The API surface.
//
// Two invariants hold across every route in this file:
//
//   1. Handlers never query the database directly. They go through repo.ts,
//      which requires an actor and scopes by ownership. There is no route that
//      can read a deal the caller does not own, because there is no function
//      available to it that would.
//
//   2. No response ever contains a formula. A user may fetch a model definition
//      they own or that ships with the product — that is the point of a
//      customisable engine — but computed deal output returns values only. The
//      underwriting itself runs server-side and the client receives numbers.

import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { env } from "../lib/env.ts";
import { Router, HttpError, json, noContent, readJson, type Ctx } from "../lib/http/server.ts";
import { parseMultipart } from "../lib/http/multipart.ts";
import {
  buildSessionCookie,
  checkLoginThrottle,
  clearSessionCookie,
  createSession,
  parseCookies,
  recordLoginAttempt,
  revokeAllSessionsForUser,
  revokeSession,
  SESSION_COOKIE,
} from "../lib/auth/session.ts";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../lib/auth/password.ts";
import { fromJson } from "../lib/db/index.ts";
import * as repo from "../lib/db/repo.ts";
import { validateModel } from "../lib/engine/model.ts";
import type { ModelDefinition } from "../lib/engine/types.ts";
import { previewUnderwrite, underwriteDeal } from "../lib/underwrite.ts";
import { generateNarrative } from "../lib/ai/narrative.ts";
import { extractionAvailable, removeStoredFile, runExtraction, storeAndParse } from "../lib/pipeline.ts";
import { registerExportRoutes } from "./export.ts";
import { registerAnalysisRoutes } from "./analysis.ts";
import { registerAdminRoutes } from "./admin.ts";
import { registerCollectRoutes } from "./collect.ts";

export const router = new Router();

// ---------------------------------------------------------------------- auth --

router.get(
  "/api/auth/me",
  (ctx) => {
    if (!ctx.session) {
      json(ctx.res, 200, { authenticated: false });
      return;
    }
    json(ctx.res, 200, {
      authenticated: true,
      user: publicUser(ctx.session.user),
      csrfToken: ctx.session.csrfToken,
      capabilities: { aiExtraction: extractionAvailable() },
    });
  },
  { auth: false, csrf: false },
);

router.post(
  "/api/auth/login",
  async (ctx) => {
    const body = await readJson<{ email?: string; password?: string }>(ctx.req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!email || !password) throw new HttpError(400, "Email and password are required");

    const throttle = checkLoginThrottle(email, ctx.ip);
    if (!throttle.allowed) {
      repo.audit(null, "login.throttled", "user", undefined, { email }, ctx.ip);
      throw new HttpError(
        429,
        `Too many failed attempts. Try again in ${Math.ceil((throttle.retryAfterSeconds ?? 900) / 60)} minutes.`,
      );
    }

    const user = repo.findUserByEmail(email);
    const ok =
      user !== undefined &&
      user.status === "active" &&
      (await verifyPassword(password, {
        hash: user.password_hash,
        salt: user.password_salt,
        algo: user.password_algo,
      }));

    recordLoginAttempt(email, ctx.ip, ok);

    if (!ok || !user) {
      repo.audit(null, "login.failed", "user", user?.id, { email }, ctx.ip);
      // Identical message and status whether the account exists or not, so the
      // endpoint cannot be used to enumerate valid email addresses.
      throw new HttpError(401, "That email and password combination is not recognised");
    }

    const created = createSession(user.id, {
      ip: ctx.ip,
      userAgent: ctx.req.headers["user-agent"],
    });
    if (!created) throw new HttpError(500, "Could not start a session");

    repo.audit(created.session.user, "login.ok", "user", user.id, undefined, ctx.ip);

    json(
      ctx.res,
      200,
      {
        user: publicUser(created.session.user),
        csrfToken: created.session.csrfToken,
        capabilities: { aiExtraction: extractionAvailable() },
      },
      { "set-cookie": buildSessionCookie(created.token) },
    );
  },
  { auth: false, csrf: false },
);

router.post(
  "/api/auth/logout",
  (ctx) => {
    const cookies = parseCookies(ctx.req.headers.cookie);
    revokeSession(cookies[SESSION_COOKIE]);
    if (ctx.session) repo.audit(ctx.session.user, "logout", "user", ctx.session.user.id, undefined, ctx.ip);
    json(ctx.res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
  },
  { auth: false, csrf: false },
);

router.post("/api/auth/change-password", async (ctx) => {
  const body = await readJson<{ current?: string; next?: string }>(ctx.req);
  const current = String(body.current ?? "");
  const next = String(body.next ?? "");

  const user = repo.findUserByEmail(ctx.user.email);
  if (!user) throw new HttpError(404, "Account not found");

  const ok = await verifyPassword(current, {
    hash: user.password_hash,
    salt: user.password_salt,
    algo: user.password_algo,
  });
  if (!ok) throw new HttpError(401, "Your current password is not correct");

  const policy = checkPasswordPolicy(next, user.email);
  if (!policy.ok) throw new HttpError(400, policy.problems.join(". "));

  repo.setUserPassword(user.id, await hashPassword(next));
  // Every other session is invalidated: a password change is the standard
  // response to "I think someone else has access".
  revokeAllSessionsForUser(user.id);
  repo.audit(ctx.user, "password.changed", "user", user.id, undefined, ctx.ip);

  json(ctx.res, 200, { ok: true, note: "All sessions have been signed out. Sign in again." });
});

// -------------------------------------------------------------------- models --

router.get("/api/models", (ctx) => {
  json(ctx.res, 200, { models: repo.listModels(ctx.user) });
});

router.get("/api/models/:id", (ctx) => {
  const row = repo.getModelRow(ctx.user, ctx.params.id);
  if (!row) throw new HttpError(404, "Model not found");
  const definition = fromJson<ModelDefinition | null>(row.definition, null);
  json(ctx.res, 200, {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    market: row.market,
    currency: row.currency,
    depth: row.depth,
    assetType: row.asset_type,
    version: row.version,
    isSystem: row.is_system === 1,
    editable: row.is_system !== 1 && row.org_id === ctx.user.org_id,
    definition,
  });
});

router.post("/api/models/validate", async (ctx) => {
  const body = await readJson<{ definition?: ModelDefinition }>(ctx.req);
  if (!body.definition) throw new HttpError(400, "A model definition is required");
  const issues = validateModel(body.definition);
  json(ctx.res, 200, {
    ok: !issues.some((i) => i.level === "error"),
    issues,
  });
});

router.post("/api/models/:id/clone", async (ctx) => {
  const body = await readJson<{ name?: string }>(ctx.req);
  const source = repo.getModelRow(ctx.user, ctx.params.id);
  if (!source) throw new HttpError(404, "Model not found");

  const name = String(body.name ?? `${source.name} (copy)`).slice(0, 200);
  const cloned = repo.cloneModel(ctx.user, ctx.params.id, name);
  if (!cloned) throw new HttpError(500, "Could not clone that model");

  repo.audit(ctx.user, "model.cloned", "model", cloned.id, { from: source.id }, ctx.ip);
  json(ctx.res, 201, { id: cloned.id, name: cloned.name, key: cloned.key });
});

router.put("/api/models/:id", async (ctx) => {
  const body = await readJson<{ definition?: ModelDefinition; note?: string }>(ctx.req);
  if (!body.definition) throw new HttpError(400, "A model definition is required");

  const existing = repo.getModelRow(ctx.user, ctx.params.id);
  if (!existing) throw new HttpError(404, "Model not found");
  if (existing.is_system === 1) {
    throw new HttpError(
      403,
      "Models that ship with Meridian cannot be edited. Clone it first — your copy is fully editable.",
    );
  }

  // A model that does not validate is never persisted. A broken formula must
  // fail here, in the editor, not three screens later during underwriting.
  const issues = validateModel(body.definition);
  if (issues.some((i) => i.level === "error")) {
    throw new HttpError(422, "This model has errors and was not saved", issues);
  }

  const saved = repo.saveModelDefinition(ctx.user, ctx.params.id, body.definition, body.note);
  if (!saved) throw new HttpError(500, "Could not save that model");

  repo.audit(ctx.user, "model.saved", "model", saved.id, { version: saved.version }, ctx.ip);
  json(ctx.res, 200, { id: saved.id, version: saved.version, issues });
});

router.get("/api/models/:id/revisions", (ctx) => {
  json(ctx.res, 200, { revisions: repo.listModelRevisions(ctx.user, ctx.params.id) });
});

router.delete("/api/models/:id", (ctx) => {
  if (!repo.deleteModel(ctx.user, ctx.params.id)) {
    throw new HttpError(404, "Model not found, or it ships with Meridian and cannot be deleted");
  }
  repo.audit(ctx.user, "model.deleted", "model", ctx.params.id, undefined, ctx.ip);
  noContent(ctx.res);
});

// --------------------------------------------------------------------- deals --

router.get("/api/deals", (ctx) => {
  const deals = repo.listDeals(ctx.user, {
    includeArchived: ctx.query.get("archived") === "1",
    query: ctx.query.get("q") ?? undefined,
  });

  // The list carries each deal's headline metrics so the pipeline view does not
  // need a request per row.
  const rows = deals.map((deal) => {
    const run = repo.latestRun(ctx.user, deal.id);
    const values = run ? fromJson<Record<string, unknown>>(run.results, {}) : {};
    const computed = (values.values ?? {}) as Record<string, number | null>;
    return {
      id: deal.id,
      name: deal.name,
      community: deal.community,
      city: deal.city,
      assetType: deal.asset_type,
      tenure: deal.tenure,
      status: deal.status,
      depth: deal.depth,
      currency: deal.currency,
      market: deal.market,
      updatedAt: deal.updated_at,
      createdAt: deal.created_at,
      metrics: run
        ? {
            purchasePrice: computed.purchase_price ?? null,
            pricePerSqft: computed.price_per_sqft ?? null,
            grossYield: computed.gross_yield ?? null,
            netYield: computed.net_yield ?? null,
            noi: computed.noi ?? null,
            dscr: computed.dscr ?? null,
            cashOnCash: computed.cash_on_cash ?? null,
            irr: computed.levered_irr ?? computed.irr ?? null,
          }
        : null,
      lastRunAt: run?.created_at ?? null,
    };
  });

  json(ctx.res, 200, { deals: rows });
});

router.post("/api/deals", async (ctx) => {
  const body = await readJson<Record<string, string>>(ctx.req);
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "Give the deal a name");

  // Default to a model matching the requested market and depth so a new deal is
  // immediately runnable rather than presenting an empty dropdown.
  let modelId = body.modelId ?? null;
  if (!modelId) {
    const market = body.market ?? env.defaultMarket;
    const depth = body.depth ?? "quick";
    const candidates = repo.listModels(ctx.user).filter((m) => m.market === market);
    const match =
      candidates.find((m) => m.depth === depth && m.assetType === (body.assetType ?? "residential")) ??
      candidates.find((m) => m.depth === depth) ??
      candidates[0];
    modelId = match?.id ?? null;
  }

  const deal = repo.createDeal(ctx.user, {
    name,
    address: body.address ?? null,
    community: body.community ?? null,
    city: body.city ?? null,
    country: body.country ?? "AE",
    asset_type: body.assetType ?? "residential",
    tenure: body.tenure ?? null,
    market: body.market ?? env.defaultMarket,
    currency: body.currency ?? (body.market === "US" ? "USD" : "AED"),
    depth: body.depth ?? "quick",
    model_id: modelId,
  });

  repo.audit(ctx.user, "deal.created", "deal", deal.id, { name }, ctx.ip);
  json(ctx.res, 201, { deal: shapeDeal(deal) });
});

router.get("/api/deals/:id", (ctx) => {
  const deal = repo.getDeal(ctx.user, ctx.params.id);
  if (!deal) throw new HttpError(404, "Deal not found");

  const run = repo.latestRun(ctx.user, deal.id);
  const narrative = run ? repo.getNarrativeForRun(ctx.user, run.id) : undefined;

  json(ctx.res, 200, {
    deal: shapeDeal(deal),
    documents: repo.listDocuments(ctx.user, deal.id).map(shapeDocument),
    fields: repo.listFields(ctx.user, deal.id).map(shapeField),
    units: repo.listRentRoll(ctx.user, deal.id),
    t12: repo.listT12(ctx.user, deal.id),
    extractions: repo.listExtractions(ctx.user, deal.id),
    run: run ? shapeRun(run) : null,
    narrative: narrative ? shapeNarrative(narrative) : null,
    models: repo.listModels(ctx.user),
  });
});

router.patch("/api/deals/:id", async (ctx) => {
  const body = await readJson<Record<string, unknown>>(ctx.req);
  const patch: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: "name", address: "address", community: "community", city: "city",
    country: "country", assetType: "asset_type", tenure: "tenure", market: "market",
    currency: "currency", status: "status", depth: "depth", modelId: "model_id", notes: "notes",
  };
  for (const [from, to] of Object.entries(map)) {
    if (body[from] !== undefined) patch[to] = body[from];
  }
  if (body.archived !== undefined) {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
  }

  const updated = repo.updateDeal(ctx.user, ctx.params.id, patch);
  if (!updated) throw new HttpError(404, "Deal not found");
  json(ctx.res, 200, { deal: shapeDeal(updated) });
});

router.delete("/api/deals/:id", (ctx) => {
  // Check existence first: deleteDeal returns an empty array both for "not
  // found" and for "found, had no documents", and those need different answers.
  if (!repo.getDeal(ctx.user, ctx.params.id)) throw new HttpError(404, "Deal not found");

  const docs = repo.deleteDeal(ctx.user, ctx.params.id);
  // Deleting a deal removes the confidential documents from disk, not just the
  // rows that point at them.
  for (const doc of docs) removeStoredFile(doc);

  repo.audit(ctx.user, "deal.deleted", "deal", ctx.params.id, { files: docs.length }, ctx.ip);
  noContent(ctx.res);
});

// ----------------------------------------------------------------- documents --

router.post("/api/deals/:id/documents", async (ctx) => {
  const deal = repo.getDeal(ctx.user, ctx.params.id);
  if (!deal) throw new HttpError(404, "Deal not found");

  const upload = await parseMultipart(ctx.req, { maxBytes: env.maxUploadBytes, maxFiles: 8 });
  if (!upload.files.length) throw new HttpError(400, "No files were uploaded");

  const stored: unknown[] = [];
  const warnings: string[] = [];

  for (const file of upload.files) {
    // The field name carries the slot the user dropped it into: om, rent_roll,
    // t12, or "auto" to let detection decide.
    const declaredKind = upload.fields[`${file.field}_kind`] ?? file.field ?? "auto";
    const result = await storeAndParse(ctx.user, deal.id, file, declaredKind);
    if ("error" in result) {
      warnings.push(`${file.filename}: ${result.error}`);
      continue;
    }
    stored.push(shapeDocument(result.document));
    warnings.push(...result.warnings);
  }

  repo.audit(ctx.user, "documents.uploaded", "deal", deal.id, { count: stored.length }, ctx.ip);
  json(ctx.res, 201, { documents: stored, warnings });
});

router.get(
  "/api/documents/:id/file",
  (ctx) => {
    const doc = repo.getDocument(ctx.user, ctx.params.id);
    if (!doc) throw new HttpError(404, "Document not found");

    // Documents are streamed through an authenticated route, never served from
    // a static path. Confidential deal packs must not be reachable by URL alone.
    ctx.res.writeHead(200, {
      "content-type": doc.mime || "application/octet-stream",
      "content-length": doc.bytes,
      "content-disposition": `inline; filename="${basename(doc.filename).replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // A hostile PDF or HTML file must not execute in our origin.
      "content-security-policy": "default-src 'none'; sandbox",
    });

    const stream = createReadStream(doc.storage_path);
    // The row can outlive the file (manual cleanup, restored backup, failed
    // write). Headers are already sent by this point, so the only correct
    // response is to log it and drop the connection — an unhandled stream
    // error would take the whole process down.
    stream.on("error", (err) => {
      console.error(`[documents] cannot read ${doc.storage_path}`, err);
      ctx.res.destroy();
    });
    stream.pipe(ctx.res);
  },
  { csrf: false },
);

router.get("/api/documents/:id/segments", (ctx) => {
  const doc = repo.getDocument(ctx.user, ctx.params.id);
  if (!doc) throw new HttpError(404, "Document not found");
  json(ctx.res, 200, {
    document: shapeDocument(doc),
    segments: repo.getSegments(ctx.user, doc.id),
  });
});

router.delete("/api/documents/:id", (ctx) => {
  const doc = repo.deleteDocument(ctx.user, ctx.params.id);
  if (!doc) throw new HttpError(404, "Document not found");
  removeStoredFile(doc);
  repo.audit(ctx.user, "document.deleted", "document", doc.id, undefined, ctx.ip);
  noContent(ctx.res);
});

// ---------------------------------------------------------------- extraction --

router.post("/api/deals/:id/extract", async (ctx) => {
  const deal = repo.getDeal(ctx.user, ctx.params.id);
  if (!deal) throw new HttpError(404, "Deal not found");

  const result = await runExtraction(ctx.user, deal.id);
  repo.audit(ctx.user, "deal.extracted", "deal", deal.id, { fields: result.fieldsWritten }, ctx.ip);

  json(ctx.res, 200, {
    ...result,
    fields: repo.listFields(ctx.user, deal.id).map(shapeField),
    units: repo.listRentRoll(ctx.user, deal.id),
    t12: repo.listT12(ctx.user, deal.id),
  });
});

// -------------------------------------------------------------------- fields --

router.get("/api/deals/:id/fields", (ctx) => {
  if (!repo.getDeal(ctx.user, ctx.params.id)) throw new HttpError(404, "Deal not found");
  json(ctx.res, 200, { fields: repo.listFields(ctx.user, ctx.params.id).map(shapeField) });
});

router.patch("/api/deals/:id/fields", async (ctx) => {
  const body = await readJson<{
    updates?: Array<{ key: string; value: unknown; note?: string }>;
  }>(ctx.req);
  const updates = body.updates ?? [];
  if (!Array.isArray(updates) || !updates.length) throw new HttpError(400, "No updates supplied");
  if (updates.length > 500) throw new HttpError(413, "Too many updates in one request");

  let applied = 0;
  for (const update of updates) {
    if (typeof update?.key !== "string") continue;
    const value = update.value as string | number | boolean | null;
    if (repo.setUserField(ctx.user, ctx.params.id, update.key, value, update.note)) applied++;
  }
  if (!applied) throw new HttpError(404, "Deal not found");

  json(ctx.res, 200, { applied, fields: repo.listFields(ctx.user, ctx.params.id).map(shapeField) });
});

router.post("/api/deals/:id/fields/:key/confirm", (ctx) => {
  if (!repo.confirmField(ctx.user, ctx.params.id, ctx.params.key)) {
    throw new HttpError(404, "Deal not found");
  }
  noContent(ctx.res);
});

router.patch("/api/deals/:id/units/:unitId", async (ctx) => {
  const body = await readJson<Record<string, unknown>>(ctx.req);
  if (!repo.updateRentRollUnit(ctx.user, ctx.params.id, ctx.params.unitId, body)) {
    throw new HttpError(404, "Unit not found");
  }
  json(ctx.res, 200, { units: repo.listRentRoll(ctx.user, ctx.params.id) });
});

router.patch("/api/deals/:id/t12/:lineId", async (ctx) => {
  const body = await readJson<Record<string, unknown>>(ctx.req);
  if (!repo.updateT12Line(ctx.user, ctx.params.id, ctx.params.lineId, body)) {
    throw new HttpError(404, "Line not found");
  }
  json(ctx.res, 200, { t12: repo.listT12(ctx.user, ctx.params.id) });
});

// -------------------------------------------------------------- underwriting --

router.post("/api/deals/:id/underwrite", async (ctx) => {
  const body = await readJson<{ depth?: "quick" | "full"; modelId?: string }>(ctx.req);
  const deal = repo.getDeal(ctx.user, ctx.params.id);
  if (!deal) throw new HttpError(404, "Deal not found");

  let outcome;
  try {
    outcome = underwriteDeal(ctx.user, deal.id, { depth: body.depth, modelId: body.modelId });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Underwriting failed");
  }

  if (body.depth && body.depth !== deal.depth) {
    repo.updateDeal(ctx.user, deal.id, { depth: body.depth });
  }
  repo.audit(ctx.user, "deal.underwritten", "deal", deal.id, { runId: outcome.runId }, ctx.ip);

  json(ctx.res, 200, {
    runId: outcome.runId,
    modelName: outcome.modelName,
    result: outcome.result,
    derivedNotes: outcome.derivedNotes,
  });
});

/**
 * Live recalculation for the review screen. Same engine, no persistence — this
 * is what makes editing an assumption update every dependent metric instantly
 * without re-running extraction or writing a run to history.
 */
router.post("/api/deals/:id/preview", async (ctx) => {
  const body = await readJson<{
    overrides?: Record<string, string | number | boolean | null>;
    depth?: "quick" | "full";
    modelId?: string;
  }>(ctx.req);

  try {
    const result = previewUnderwrite(ctx.user, ctx.params.id, body.overrides ?? {}, {
      depth: body.depth,
      modelId: body.modelId,
    });
    json(ctx.res, 200, { result });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Preview failed");
  }
});

router.get("/api/deals/:id/runs", (ctx) => {
  if (!repo.getDeal(ctx.user, ctx.params.id)) throw new HttpError(404, "Deal not found");
  json(ctx.res, 200, { runs: repo.listRuns(ctx.user, ctx.params.id) });
});

router.get("/api/runs/:id", (ctx) => {
  const run = repo.getRun(ctx.user, ctx.params.id);
  if (!run) throw new HttpError(404, "Run not found");
  const narrative = repo.getNarrativeForRun(ctx.user, run.id);
  json(ctx.res, 200, {
    run: shapeRun(run),
    narrative: narrative ? shapeNarrative(narrative) : null,
  });
});

// ---------------------------------------------------------------- narrative --

router.post("/api/runs/:id/narrative", async (ctx) => {
  const run = repo.getRun(ctx.user, ctx.params.id);
  if (!run) throw new HttpError(404, "Run not found");

  const deal = repo.getDeal(ctx.user, run.deal_id);
  if (!deal) throw new HttpError(404, "Deal not found");

  const snapshot = fromJson<ModelDefinition | null>(run.model_snapshot, null);
  const results = fromJson<Record<string, unknown>>(run.results, {});

  // Rebuild the RunResult shape the narrative expects from the persisted run,
  // so a write-up can be regenerated later without re-underwriting.
  const result = {
    modelKey: snapshot?.key ?? "",
    depth: run.depth as "quick" | "full",
    currency: deal.currency,
    inputs: fromJson<never[]>(run.inputs_snapshot, []),
    lines: (results.lines ?? []) as never[],
    returns: (results.returns ?? []) as never[],
    summary: (results.summary ?? []) as never[],
    values: (results.values ?? {}) as Record<string, never>,
    projection: fromJson<undefined>(run.projection, undefined),
    benchmarks: fromJson<never[]>(run.benchmarks, []),
    // Flags come from the persisted run, so a regenerated write-up always
    // agrees with the model version that produced these numbers.
    flags: (results.flags ?? []) as never[],
    warnings: fromJson<never[]>(run.warnings, []),
    durationMs: run.duration_ms ?? 0,
  };

  const narrative = await generateNarrative({
    dealName: deal.name,
    community: deal.community,
    assetType: deal.asset_type,
    currency: deal.currency,
    modelName: snapshot?.name ?? "Underwriting model",
    result: result as never,
  });

  const narrativeId = repo.saveNarrative(run.id, deal.id, ctx.user.id, {
    engine: narrative.engine,
    model: narrative.engine === "ai" ? env.model : null,
    status: narrative.error ? "fallback" : "ok",
    headline: narrative.headline,
    summary: narrative.summary,
    strengths: narrative.strengths,
    redFlags: narrative.redFlags,
    ddItems: narrative.ddItems,
    error: narrative.error ?? null,
  });

  repo.audit(ctx.user, "narrative.generated", "run", run.id, { engine: narrative.engine }, ctx.ip);
  json(ctx.res, 200, { id: narrativeId, ...narrative });
});

// ------------------------------------------------------ feature route modules --
//
// Each module registers its own routes rather than editing this file, which is
// what let three of them be built in parallel without collisions. They all
// receive the same Router and are bound by the same auth and CSRF defaults.

registerExportRoutes(router);   // Excel and CSV export
registerAnalysisRoutes(router); // sensitivity grids and the loan sizing solver
registerAdminRoutes(router);    // invites, password reset, outbound webhooks
registerCollectRoutes(router);  // buyer document collection links

// ------------------------------------------------------------------- shapers --

function publicUser(user: { id: string; email: string; name: string; role: string; org_id: string }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.org_id };
}

function shapeDeal(deal: repo.DealRow) {
  return {
    id: deal.id,
    name: deal.name,
    address: deal.address,
    community: deal.community,
    city: deal.city,
    country: deal.country,
    assetType: deal.asset_type,
    tenure: deal.tenure,
    market: deal.market,
    currency: deal.currency,
    status: deal.status,
    depth: deal.depth,
    modelId: deal.model_id,
    notes: deal.notes,
    createdAt: deal.created_at,
    updatedAt: deal.updated_at,
    archivedAt: deal.archived_at,
  };
}

function shapeDocument(doc: repo.DocumentRow) {
  return {
    id: doc.id,
    kind: doc.kind,
    kindSource: doc.kind_source,
    filename: doc.filename,
    mime: doc.mime,
    detectedType: doc.detected_type,
    bytes: doc.bytes,
    pageCount: doc.page_count,
    sheetCount: doc.sheet_count,
    isScanned: doc.is_scanned === 1,
    status: doc.status,
    error: doc.error,
    createdAt: doc.created_at,
  };
}

function shapeField(field: repo.ExtractedFieldRow) {
  return {
    key: field.field_key,
    aiValue: field.ai_value,
    userValue: field.user_value,
    // The effective value is what the engine will use — precedence resolved
    // once, server-side, so the client never has to reimplement the rule.
    value: field.user_value ?? field.ai_value,
    unit: field.unit,
    confidence: field.confidence,
    sourceDocumentId: field.source_document_id,
    sourcePage: field.source_page,
    sourceSheet: field.source_sheet,
    sourceSnippet: field.source_snippet,
    status: field.status,
    note: field.note,
    updatedAt: field.updated_at,
  };
}

function shapeRun(run: repo.RunRow) {
  const snapshot = fromJson<ModelDefinition | null>(run.model_snapshot, null);
  const results = fromJson<Record<string, unknown>>(run.results, {});
  return {
    id: run.id,
    dealId: run.deal_id,
    depth: run.depth,
    modelId: run.model_id,
    modelVersion: run.model_version,
    modelName: snapshot?.name ?? null,
    methodology: snapshot?.methodology ?? null,
    // The client gets the presentation metadata it needs to render a line —
    // label, unit, format — and the computed value. It does not get the formula.
    summary: results.summary ?? [],
    lines: results.lines ?? [],
    returns: results.returns ?? [],
    values: results.values ?? {},
    projection: fromJson(run.projection, null),
    benchmarks: fromJson(run.benchmarks, []),
    warnings: fromJson(run.warnings, []),
    inputs: fromJson(run.inputs_snapshot, []),
    durationMs: run.duration_ms,
    createdAt: run.created_at,
  };
}

function shapeNarrative(n: repo.NarrativeRow) {
  return {
    id: n.id,
    runId: n.run_id,
    engine: n.engine,
    status: n.status,
    headline: n.headline,
    summary: n.summary,
    strengths: fromJson(n.strengths, []),
    redFlags: fromJson(n.red_flags, []),
    ddItems: fromJson(n.dd_items, []),
    error: n.error,
    createdAt: n.created_at,
  };
}
