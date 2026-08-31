// Export routes: the underwriting as a workbook or a flat CSV.
//
// Three things are load-bearing here.
//
// OWNERSHIP. Every read goes through repo.ts with ctx.user as the actor, so a
// deal the caller does not own is simply not returned and the route answers
// 404. Not 403 — a 403 confirms the id exists, which is a small leak but a real
// one when the id is in a URL somebody guessed.
//
// THE RESPONSE IS WRITTEN SYNCHRONOUSLY AND FULLY. dispatch() appends a 204 to
// any handler that returns without committing a response, and it decides that
// on res.headersSent. A handler that hands the socket to something asynchronous
// and returns has already caused one production incident in this codebase (see
// the comment in src/lib/http/server.ts). The buffer is built in memory and
// written with a single writeHead + end, so there is no window in which this
// route is half-finished.
//
// THE FILENAME IS SANITISED. It is built from a deal name the user typed, and
// it lands in a Content-Disposition header. sanitiseFilename() removes quotes,
// path separators and control characters; contentDisposition() adds the RFC
// 5987 form so a non-Latin deal name survives the round trip.

import { HttpError, type Ctx, type Router } from "../lib/http/server.ts";
import { fromJson } from "../lib/db/index.ts";
import * as repo from "../lib/db/repo.ts";
import type { ModelDefinition, RunResult } from "../lib/engine/types.ts";
import {
  buildWorkbook,
  contentDisposition,
  exportFilename,
  XLSX_CONTENT_TYPE,
  type ExportBundle,
  type ExportNarrative,
} from "../lib/export/workbook.ts";
import { buildCsv, CSV_CONTENT_TYPE } from "../lib/export/csv.ts";

export function registerExportRoutes(router: Router): void {
  // GET downloads are triggered by navigation, which cannot carry a CSRF
  // header. They are safe methods with no side effects, so csrf is off — but
  // auth is not, and the ownership scoping below is what actually protects the
  // data.
  router.get(
    "/api/runs/:id/export.xlsx",
    (ctx) => {
      const bundle = bundleForRun(ctx, ctx.params.id);
      sendWorkbook(ctx, bundle);
    },
    { csrf: false },
  );

  router.get(
    "/api/deals/:id/export.xlsx",
    (ctx) => {
      const bundle = bundleForDeal(ctx, ctx.params.id);
      sendWorkbook(ctx, bundle);
    },
    { csrf: false },
  );

  router.get(
    "/api/deals/:id/export.csv",
    (ctx) => {
      const bundle = bundleForDeal(ctx, ctx.params.id);
      const body = Buffer.from(buildCsv(bundle), "utf8");
      const filename = exportFilename(bundle.deal.name, "csv", bundle.deal.assetType);

      repo.audit(ctx.user, "deal.exported", "deal", bundle.deal.id, { format: "csv", runId: bundle.run.id }, ctx.ip);

      ctx.res.writeHead(200, {
        "content-type": CSV_CONTENT_TYPE,
        "content-length": body.length,
        "content-disposition": contentDisposition(filename),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      ctx.res.end(body);
    },
    { csrf: false },
  );
}

// ------------------------------------------------------------------ sending --

function sendWorkbook(ctx: Ctx, bundle: ExportBundle): void {
  const body = buildWorkbook(bundle);
  const filename = exportFilename(bundle.deal.name, "xlsx", bundle.deal.assetType);

  repo.audit(ctx.user, "deal.exported", "deal", bundle.deal.id, { format: "xlsx", runId: bundle.run.id }, ctx.ip);

  ctx.res.writeHead(200, {
    "content-type": XLSX_CONTENT_TYPE,
    "content-length": body.length,
    "content-disposition": contentDisposition(filename),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  ctx.res.end(body);
}

// ----------------------------------------------------------------- assembly --

function bundleForRun(ctx: Ctx, runId: string): ExportBundle {
  const run = repo.getRun(ctx.user, runId);
  if (!run) throw new HttpError(404, "Run not found");

  const deal = repo.getDeal(ctx.user, run.deal_id);
  if (!deal) throw new HttpError(404, "Run not found");

  return assemble(ctx, deal, run);
}

function bundleForDeal(ctx: Ctx, dealId: string): ExportBundle {
  const deal = repo.getDeal(ctx.user, dealId);
  if (!deal) throw new HttpError(404, "Deal not found");

  const run = repo.latestRun(ctx.user, deal.id);
  if (!run) {
    throw new HttpError(
      404,
      "This deal has not been underwritten yet — run the underwriting, then export.",
    );
  }

  return assemble(ctx, deal, run);
}

function assemble(ctx: Ctx, deal: repo.DealRow, run: repo.RunRow): ExportBundle {
  const snapshot = fromJson<ModelDefinition | null>(run.model_snapshot, null);
  const results = fromJson<Record<string, unknown>>(run.results, {});

  // The persisted run is rebuilt into the RunResult shape rather than
  // re-underwritten, so an export always reproduces the numbers that were
  // actually signed off — not what the current model version would say today.
  const result: RunResult = {
    modelKey: snapshot?.key ?? "",
    depth: run.depth as RunResult["depth"],
    currency: deal.currency,
    inputs: fromJson(run.inputs_snapshot, []),
    lines: (results.lines ?? []) as RunResult["lines"],
    returns: (results.returns ?? []) as RunResult["returns"],
    summary: (results.summary ?? []) as RunResult["summary"],
    values: (results.values ?? {}) as RunResult["values"],
    projection: fromJson<RunResult["projection"]>(run.projection, undefined),
    benchmarks: fromJson(run.benchmarks, []),
    flags: (results.flags ?? []) as RunResult["flags"],
    warnings: fromJson(run.warnings, []),
    durationMs: run.duration_ms ?? 0,
  };

  const narrativeRow = repo.getNarrativeForRun(ctx.user, run.id);
  const narrative: ExportNarrative | null = narrativeRow
    ? {
        engine: narrativeRow.engine,
        status: narrativeRow.status,
        headline: narrativeRow.headline,
        summary: narrativeRow.summary,
        strengths: fromJson(narrativeRow.strengths, []),
        redFlags: fromJson(narrativeRow.red_flags, []),
        ddItems: fromJson(narrativeRow.dd_items, []),
      }
    : null;

  return {
    deal: {
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
    },
    run: {
      id: run.id,
      createdAt: run.created_at,
      depth: run.depth,
      modelName: snapshot?.name ?? null,
      modelKey: snapshot?.key ?? null,
      modelVersion: run.model_version,
      methodology: snapshot?.methodology ?? null,
    },
    result,
    units: repo.listRentRoll(ctx.user, deal.id),
    t12: repo.listT12(ctx.user, deal.id),
    narrative,
    // Provenance is only useful if the source column names a document rather
    // than a UUID, so the filenames come along for the lookup.
    documents: repo.listDocuments(ctx.user, deal.id).map((d) => ({ id: d.id, filename: d.filename })),
    generatedAt: new Date().toISOString(),
  };
}
