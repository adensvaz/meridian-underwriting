// Team and integration routes: invitations, organisation membership, password
// reset, and the webhook test ping.
//
// The same two invariants as src/routes/index.ts hold here:
//
//   1. No handler queries the database. Everything goes through repo.ts or
//      src/lib/auth/invite.ts, both of which scope by the actor's organisation
//      in the SQL itself, so a handler physically cannot forget the check.
//
//   2. Nothing sensitive is returned by an unauthenticated route. The three
//      public endpoints — invite preview, invite accept, password reset — are
//      the only ones in the product besides login, and each returns the
//      narrowest possible answer.
//
// Rate limiting and the token rules live in invite.ts, not here. These handlers
// parse, delegate, and shape a response; they do not make security decisions,
// which is what keeps the rules testable without an HTTP server.

import { HttpError, json, noContent, readJson, type Ctx, type Router } from "../lib/http/server.ts";
import { buildSessionCookie } from "../lib/auth/session.ts";
import {
  acceptInvite,
  createInvite,
  completePasswordReset,
  describeInvite,
  InviteError,
  listInvites,
  listOrgMembers,
  rateLimit,
  requestPasswordReset,
  revokeInvite,
} from "../lib/auth/invite.ts";
import { audit } from "../lib/db/repo.ts";
import { sendTestPing, webhookDetail, webhookTarget } from "../lib/notify.ts";

/**
 * Turns an InviteError into the HttpError the router already knows how to
 * render, preserving the status the rule chose and surfacing Retry-After when
 * a throttle fired. Anything that is not an InviteError is a bug and is
 * re-thrown untouched so it reaches the 500 path with its stack intact.
 */
function rethrow(ctx: Ctx, err: unknown): never {
  if (err instanceof InviteError) {
    if (err.status === 429 && err.retryAfterSeconds) {
      ctx.res.setHeader("retry-after", String(err.retryAfterSeconds));
    }
    throw new HttpError(err.status, err.message, { code: err.code });
  }
  throw err;
}

export function registerAdminRoutes(router: Router): void {
  // ------------------------------------------------------------- invites --

  router.post("/api/invites", async (ctx) => {
    const body = await readJson<{ email?: unknown; role?: unknown }>(ctx.req);
    try {
      const created = createInvite(ctx.user, { email: body.email, role: body.role }, { ip: ctx.ip });
      // The raw token appears in this response and nowhere else, ever. Only its
      // SHA-256 was stored, so re-fetching the invite cannot reproduce it.
      json(ctx.res, 201, {
        invite: created.invite,
        token: created.token,
        expiresAt: created.expiresAt,
        note: "Send this link to your colleague now — the token is not recoverable afterwards.",
      });
    } catch (err) {
      rethrow(ctx, err);
    }
  });

  router.get("/api/invites", (ctx) => {
    json(ctx.res, 200, { invites: listInvites(ctx.user) });
  });

  // Registered before the /:token preview so a DELETE never falls through to
  // it, and after the collection routes so segment counts stay unambiguous.
  router.post(
    "/api/invites/accept",
    async (ctx) => {
      const body = await readJson<{ token?: unknown; name?: unknown; password?: unknown }>(ctx.req);
      try {
        const accepted = await acceptInvite({
          token: body.token,
          name: body.name,
          password: body.password,
          ip: ctx.ip,
          userAgent: ctx.req.headers["user-agent"],
        });
        const user = accepted.session.user;
        json(
          ctx.res,
          201,
          {
            user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.org_id },
            csrfToken: accepted.session.csrfToken,
          },
          { "set-cookie": buildSessionCookie(accepted.sessionToken) },
        );
      } catch (err) {
        rethrow(ctx, err);
      }
    },
    // The invitee has no account and therefore no session and no CSRF secret.
    // The token in the body is the credential, and it is rate-limited in
    // invite.ts so the token space cannot be ground down.
    { auth: false, csrf: false },
  );

  router.get(
    "/api/invites/:token",
    (ctx) => {
      try {
        const preview = describeInvite(ctx.params.token, { ip: ctx.ip });
        // Deliberately only these fields: enough to greet the invitee by
        // address and name their new firm, and nothing that would turn a
        // leaked link into a source of intelligence about the organisation.
        json(ctx.res, 200, {
          email: preview.email,
          organization: preview.organization,
          role: preview.role,
          expiresAt: preview.expiresAt,
        });
      } catch (err) {
        rethrow(ctx, err);
      }
    },
    { auth: false, csrf: false },
  );

  router.delete("/api/invites/:id", (ctx) => {
    if (!revokeInvite(ctx.user, ctx.params.id, { ip: ctx.ip })) {
      // Same answer for "does not exist", "belongs to another firm" and
      // "already accepted" — a 404 that does not confirm the id is real.
      throw new HttpError(404, "Invitation not found");
    }
    noContent(ctx.res);
  });

  // ------------------------------------------------------------- members --

  router.get("/api/org/members", (ctx) => {
    json(ctx.res, 200, {
      members: listOrgMembers(ctx.user),
      invites: listInvites(ctx.user).filter((i) => i.status === "pending"),
    });
  });

  // ------------------------------------------------------ password reset --

  router.post(
    "/api/auth/forgot-password",
    async (ctx) => {
      const body = await readJson<{ email?: unknown }>(ctx.req);
      try {
        const result = await requestPasswordReset({ email: body.email, ip: ctx.ip });
        // One response for every input. No branch, no conditional field, no
        // different status code — see the note in requestPasswordReset.
        json(ctx.res, 200, result);
      } catch (err) {
        rethrow(ctx, err);
      }
    },
    { auth: false, csrf: false },
  );

  router.post(
    "/api/auth/reset-password",
    async (ctx) => {
      const body = await readJson<{ token?: unknown; password?: unknown }>(ctx.req);
      try {
        await completePasswordReset({ token: body.token, password: body.password, ip: ctx.ip });
        json(ctx.res, 200, {
          ok: true,
          note: "Your password has been changed and every existing session was signed out. Sign in again.",
        });
      } catch (err) {
        rethrow(ctx, err);
      }
    },
    { auth: false, csrf: false },
  );

  // ------------------------------------------------------------- webhook --

  router.post("/api/admin/webhook/test", async (ctx) => {
    // The destination is always the configured MERIDIAN_WEBHOOK_URL. A
    // caller-supplied URL would turn this into a server-side request forgery
    // gadget for any authenticated user, so there is no such parameter.
    const target = webhookTarget();
    if (!target) {
      throw new HttpError(
        400,
        "No webhook is configured. Set MERIDIAN_WEBHOOK_URL and restart the server.",
      );
    }

    const throttle = rateLimit("webhook.test", ctx.user.id, 5, 15 * 60 * 1000);
    if (!throttle.allowed) {
      ctx.res.setHeader("retry-after", String(throttle.retryAfterSeconds));
      throw new HttpError(429, "Too many test pings. Wait a few minutes before trying again.");
    }

    const result = await sendTestPing({ by: ctx.user.name });
    audit(ctx.user, "webhook.tested", "webhook", undefined, { ok: result.ok, status: result.status }, ctx.ip);

    json(ctx.res, result.ok ? 200 : 502, {
      ok: result.ok,
      // The URL itself is a bearer credential and is never echoed back.
      destination: { flavour: target.flavour, host: hostOf(target.url) },
      detailLevel: webhookDetail(),
      status: result.status ?? null,
      durationMs: result.durationMs,
      error: result.error ?? null,
    });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}
