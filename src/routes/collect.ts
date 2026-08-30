// Buyer-facing document collection routes.
//
// Two of these are UNAUTHENTICATED, which makes them the highest-risk surface
// in the application. The rules they follow:
//
//   * The token grants upload only. There is no route here that returns a file,
//     lists what was uploaded, or exposes a figure.
//   * The metadata route returns the firm name, the requester's name, a
//     reference the broker typed and the checklist. Nothing derived from the
//     deal's financials, ever.
//   * Both are rate-limited by IP, so the token space cannot be walked.
//   * Uploads are capped in size and count, and every file goes through the
//     same magic-byte detection and parsing as an authenticated upload.
//   * CSRF is disabled because the caller has no session — the token IS the
//     authorisation, which is why it is high-entropy and hashed at rest.

import { env } from "../lib/env.ts";
import { HttpError, json, noContent, readJson, type Ctx, type Router } from "../lib/http/server.ts";
import { parseMultipart } from "../lib/http/multipart.ts";
import {
  checkCollectThrottle,
  createDocumentRequest,
  listRequests,
  recordCollectAttempt,
  recordUpload,
  resolveChecklist,
  resolveRequestToken,
  revokeRequest,
} from "../lib/collect.ts";
import { storeAndParse } from "../lib/pipeline.ts";
import { audit, getDeal } from "../lib/db/repo.ts";
import { get } from "../lib/db/index.ts";

function baseUrlOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? `localhost:${env.port}`;
  const proto = env.isProduction ? "https" : "http";
  return `${proto}://${host}`;
}

export function registerCollectRoutes(router: Router): void {
  // ---------------------------------------------------------- broker side --

  /** Create a collection link for a deal. Returns the token exactly once. */
  router.post("/api/deals/:id/collect", async (ctx) => {
    const body = await readJson<{
      recipientName?: string;
      reference?: string;
      message?: string;
      kind?: "mortgage" | "acquisition";
      employment?: "salaried" | "self_employed";
      items?: string[];
      ttlDays?: number;
    }>(ctx.req);

    const created = createDocumentRequest(ctx.user, ctx.params.id, {
      recipientName: body.recipientName,
      reference: body.reference,
      message: body.message,
      kind: body.kind === "acquisition" ? "acquisition" : "mortgage",
      employment: body.employment === "self_employed" ? "self_employed" : "salaried",
      items: Array.isArray(body.items) ? body.items.slice(0, 40) : undefined,
      ttlDays: typeof body.ttlDays === "number" ? body.ttlDays : undefined,
      baseUrl: baseUrlOf(ctx),
    });

    if (!created) throw new HttpError(404, "Deal not found");

    json(ctx.res, 201, {
      ...created,
      note: "This link is shown once and cannot be recovered. Send it to the buyer now — if it is lost, issue a new one.",
    });
  });

  router.get("/api/deals/:id/collect", (ctx) => {
    if (!getDeal(ctx.user, ctx.params.id)) throw new HttpError(404, "Deal not found");
    json(ctx.res, 200, { requests: listRequests(ctx.user, ctx.params.id) });
  });

  router.delete("/api/deals/:id/collect/:requestId", (ctx) => {
    if (!revokeRequest(ctx.user, ctx.params.id, ctx.params.requestId)) {
      throw new HttpError(404, "Request not found");
    }
    noContent(ctx.res);
  });

  /** The checklist templates, so the UI does not hard-code them. */
  router.get("/api/collect/checklists", (ctx) => {
    json(ctx.res, 200, {
      mortgage: {
        salaried: resolveChecklist("mortgage", "salaried"),
        self_employed: resolveChecklist("mortgage", "self_employed"),
      },
      acquisition: resolveChecklist("acquisition"),
    });
  });

  // ------------------------------------------------------------ buyer side --

  /**
   * What the buyer's page needs to render. Deliberately minimal: who is asking,
   * what they want, and when the link dies. No figures, no deal name unless the
   * broker chose to put one in `reference`.
   */
  router.get(
    "/api/collect/:token",
    (ctx) => {
      const throttle = checkCollectThrottle(ctx.ip);
      if (!throttle.allowed) {
        throw new HttpError(429, "Too many attempts. Try again later.");
      }

      const resolved = resolveRequestToken(ctx.params.token);
      recordCollectAttempt(ctx.ip, resolved !== null);

      if (!resolved) {
        // One message for unknown, expired and revoked alike.
        throw new HttpError(404, "This link is not valid. It may have expired — ask for a new one.");
      }

      const org = get<{ name: string }>(
        "SELECT name FROM organizations WHERE id = ?",
        resolved.request.org_id,
      );
      const requester = get<{ name: string }>(
        "SELECT name FROM users WHERE id = ?",
        resolved.request.owner_id,
      );

      json(ctx.res, 200, {
        firmName: org?.name ?? "Your adviser",
        requestedBy: requester?.name ?? null,
        recipientName: resolved.request.recipient_name,
        reference: resolved.request.reference,
        message: resolved.request.message,
        checklist: resolved.checklist,
        expiresAt: resolved.request.expires_at,
        uploadCount: resolved.request.upload_count,
        maxFileMb: Math.round(env.maxUploadBytes / 1024 / 1024),
      });
    },
    { auth: false, csrf: false },
  );

  /** The upload itself. Upload-only: nothing is ever returned but a count. */
  router.post(
    "/api/collect/:token/documents",
    async (ctx) => {
      const throttle = checkCollectThrottle(ctx.ip);
      if (!throttle.allowed) {
        throw new HttpError(429, "Too many attempts. Try again later.");
      }

      const resolved = resolveRequestToken(ctx.params.token);
      recordCollectAttempt(ctx.ip, resolved !== null);
      if (!resolved) {
        throw new HttpError(404, "This link is not valid. It may have expired — ask for a new one.");
      }

      const upload = await parseMultipart(ctx.req, {
        maxBytes: env.maxUploadBytes,
        maxFiles: 10,
      });
      if (!upload.files.length) throw new HttpError(400, "No files were received");

      // The buyer is not an authenticated actor, so the files are attributed to
      // the broker who owns the deal. Reconstruct that actor rather than
      // trusting anything the buyer sent.
      const owner = get<{
        id: string;
        org_id: string;
        email: string;
        name: string;
        role: string;
        status: string;
      }>("SELECT id, org_id, email, name, role, status FROM users WHERE id = ?", resolved.request.owner_id);
      if (!owner || owner.status !== "active") {
        throw new HttpError(410, "This link is no longer active.");
      }

      const stored: Array<{ filename: string; kind: string }> = [];
      const warnings: string[] = [];

      for (const file of upload.files) {
        // The buyer tells us which checklist item this is; validate it against
        // the request's own checklist rather than trusting the field name.
        const declared = upload.fields[`${file.field}_item`] ?? file.field;
        const item = resolved.checklist.find((c) => c.key === declared);
        const kind = item?.kind ?? "other";

        const result = await storeAndParse(owner, resolved.deal.id, file, kind);
        if ("error" in result) {
          warnings.push(`${file.filename}: ${result.error}`);
          continue;
        }
        stored.push({ filename: result.document.filename, kind: result.document.kind });
        warnings.push(...result.warnings);
      }

      recordUpload(resolved.request.id, stored.length);
      audit(null, "collect.upload", "deal", resolved.deal.id, {
        requestId: resolved.request.id,
        files: stored.length,
      }, ctx.ip);

      // Echo back only what the buyer already knows they sent.
      json(ctx.res, 201, {
        received: stored.length,
        files: stored.map((s) => s.filename),
        warnings,
        message:
          stored.length === 1
            ? "Received. You can close this page, or add more documents."
            : `${stored.length} documents received. You can close this page, or add more.`,
      });
    },
    { auth: false, csrf: false },
  );
}
