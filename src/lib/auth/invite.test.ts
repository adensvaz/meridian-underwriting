// node --test src/lib/auth/invite.test.ts
//
// The security properties of the invite and password-reset flows, exercised
// against a throwaway database. These are the tests that would catch the
// failures that actually matter here: a token that outlives its single use, an
// invite that crosses an organisation boundary, a forgot-password endpoint that
// quietly tells an attacker which email addresses are real, and a webhook that
// takes underwriting down with it when the far end is dead.
//
// The database override is set before any application module is imported, so
// the whole module graph — including the CREATE TABLE that invite.ts runs at
// load — lands in a temporary file. Same pattern as src/scripts/selfcheck.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const scratch = mkdtempSync(join(tmpdir(), "meridian-invite-"));
process.env.MERIDIAN_DB_OVERRIDE = join(scratch, "invite.db");
// Explicitly empty rather than absent: env.ts only fills in a key that is
// undefined, so this also pins the values against a developer's local .env.
process.env.MERIDIAN_WEBHOOK_URL = "";
process.env.MERIDIAN_RESET_DELIVERY_URL = "";
process.env.ANTHROPIC_API_KEY = "";

const { db, migrate, get, run } = await import("../db/index.ts");
db();
migrate();

const repo = await import("../db/repo.ts");
const invite = await import("./invite.ts");
const notify = await import("../notify.ts");
const { resolveSession } = await import("./session.ts");
const { verifyPassword } = await import("./password.ts");

import type { AuthenticatedUser } from "./session.ts";

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures --

const PASSWORD = "tuesday granite lamp 41";
const OTHER_PASSWORD = "walnut harbour kettle 77";

let counter = 0;
function unique(prefix: string): string {
  counter++;
  return `${prefix}-${counter}-${Date.now()}@example.test`;
}

function makeFirm(name: string, role = "owner"): { org: repo.OrganizationRow; actor: AuthenticatedUser } {
  const org = repo.createOrganization(name, "AE");
  const user = repo.createUser({ orgId: org.id, email: unique("boss"), name: `${name} boss`, role });
  return {
    org,
    actor: {
      id: user.id,
      org_id: org.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInviteError(code: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof invite.InviteError, `expected an InviteError, got ${String(err)}`);
    assert.equal((err as InstanceType<typeof invite.InviteError>).code, code);
    return true;
  };
}

// -------------------------------------------------------------------- invites --

test("happy path: an invite is issued, previewed and accepted", async () => {
  invite.resetRateLimits();
  const firm = makeFirm("Marina Capital");
  const email = unique("analyst");

  const created = invite.createInvite(firm.actor, { email, role: "analyst" }, { ip: "10.0.0.1" });

  assert.ok(created.token.length >= 40, "the raw token must be high-entropy");
  assert.equal(created.invite.status, "pending");
  assert.equal(created.invite.email, email);
  assert.equal(created.invite.role, "analyst");

  // Only the hash is persisted. This is the property that makes a database dump
  // useless for getting into somebody's organisation.
  const stored = get<{ token_hash: string }>("SELECT token_hash FROM invites WHERE id = ?", created.invite.id);
  assert.ok(stored, "the invite row should exist");
  assert.notEqual(stored!.token_hash, created.token);
  assert.equal(stored!.token_hash, sha256(created.token));

  // The unauthenticated preview greets the invitee and says nothing else.
  const preview = invite.describeInvite(created.token, { ip: "10.0.0.2" });
  assert.equal(preview.email, email);
  assert.equal(preview.organization, "Marina Capital");
  assert.deepEqual(Object.keys(preview).sort(), ["email", "expiresAt", "organization", "role"]);

  const accepted = await invite.acceptInvite({
    token: created.token,
    name: "Nadia Haddad",
    password: PASSWORD,
    ip: "10.0.0.3",
  });

  assert.equal(accepted.session.user.email, email);
  assert.equal(accepted.session.user.name, "Nadia Haddad");
  assert.equal(accepted.session.user.role, "analyst");
  assert.equal(accepted.session.user.org_id, firm.org.id, "the new user must land in the inviting organisation");
  assert.ok(accepted.sessionToken.length > 20, "acceptance signs the invitee in");

  // The session is real, not a stub.
  const resolved = resolveSession(accepted.sessionToken);
  assert.equal(resolved?.user.id, accepted.session.user.id);

  // The password actually works.
  const row = repo.findUserByEmail(email);
  assert.ok(
    await verifyPassword(PASSWORD, {
      hash: row!.password_hash,
      salt: row!.password_salt,
      algo: row!.password_algo,
    }),
  );

  const actions = new Set(
    (
      run("SELECT 1") && []
    ).concat(),
  );
  void actions;

  const audited = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action IN ('invite.created','invite.accepted')",
    created.invite.id,
  );
  assert.equal(audited?.n, 2, "both the issue and the acceptance must be audited");
});

test("an expired token is refused", async () => {
  invite.resetRateLimits();
  const firm = makeFirm("Expired Holdings");
  const created = invite.createInvite(firm.actor, { email: unique("late") });

  run(
    "UPDATE invites SET expires_at = ? WHERE id = ?",
    new Date(Date.now() - 1000).toISOString(),
    created.invite.id,
  );

  await assert.rejects(
    () => invite.acceptInvite({ token: created.token, name: "Too Late", password: PASSWORD, ip: "10.1.0.1" }),
    isInviteError("expired"),
  );
  assert.throws(() => invite.describeInvite(created.token, { ip: "10.1.0.2" }), isInviteError("expired"));
});

test("a token cannot be reused once it has been accepted", async () => {
  invite.resetRateLimits();
  const firm = makeFirm("Single Use LLC");
  const created = invite.createInvite(firm.actor, { email: unique("once") });

  await invite.acceptInvite({ token: created.token, name: "First Arrival", password: PASSWORD, ip: "10.2.0.1" });

  await assert.rejects(
    () =>
      invite.acceptInvite({
        token: created.token,
        name: "Second Arrival",
        password: OTHER_PASSWORD,
        ip: "10.2.0.2",
      }),
    isInviteError("already_accepted"),
  );

  const listed = invite.listInvites(firm.actor).find((i) => i.id === created.invite.id);
  assert.equal(listed?.status, "accepted");
});

test("an unknown token is refused", async () => {
  invite.resetRateLimits();
  await assert.rejects(
    () =>
      invite.acceptInvite({
        token: "Zm9yZ2VkLXRva2VuLXRoYXQtd2FzLW5ldmVyLWlzc3VlZA",
        name: "Chancer",
        password: PASSWORD,
        ip: "10.3.0.1",
      }),
    isInviteError("invalid_token"),
  );

  // A too-short token is refused by shape before it can touch the database.
  await assert.rejects(
    () => invite.acceptInvite({ token: "abc", name: "Chancer", password: PASSWORD, ip: "10.3.0.2" }),
    isInviteError("invalid_token"),
  );
});

test("a token for an email that already has an account is refused", async () => {
  invite.resetRateLimits();
  const firm = makeFirm("Duplicate Partners");
  const email = unique("taken");

  const created = invite.createInvite(firm.actor, { email });

  // The address acquires an account after the invite was issued — the invite
  // must not be a second route to a duplicate identity.
  repo.createUser({ orgId: firm.org.id, email, name: "Already Here" });

  await assert.rejects(
    () => invite.acceptInvite({ token: created.token, name: "Twin", password: PASSWORD, ip: "10.4.0.1" }),
    isInviteError("already_a_user"),
  );

  // And inviting a known address is refused up front rather than issuing a
  // token that could never work.
  assert.throws(() => invite.createInvite(firm.actor, { email }), isInviteError("already_a_user"));
});

test("the acceptance endpoint is rate limited so the token space cannot be ground down", async () => {
  invite.resetRateLimits();
  const previous = process.env.MERIDIAN_INVITE_ACCEPT_MAX;
  process.env.MERIDIAN_INVITE_ACCEPT_MAX = "3";
  try {
    const ip = "203.0.113.9";
    const guess = "Z3Vlc3Npbmctb25lLXRva2VuLWF0LWEtdGltZS1mb3JldmVy";

    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(
        () => invite.acceptInvite({ token: guess, name: "Guesser", password: PASSWORD, ip }),
        isInviteError("invalid_token"),
        `attempt ${attempt + 1} should still be allowed through to the token check`,
      );
    }

    await assert.rejects(
      () => invite.acceptInvite({ token: guess, name: "Guesser", password: PASSWORD, ip }),
      isInviteError("rate_limited"),
    );

    // The throttle is per-IP, so a different caller is unaffected.
    await assert.rejects(
      () => invite.acceptInvite({ token: guess, name: "Guesser", password: PASSWORD, ip: "203.0.113.10" }),
      isInviteError("invalid_token"),
    );
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_INVITE_ACCEPT_MAX;
    else process.env.MERIDIAN_INVITE_ACCEPT_MAX = previous;
  }
});

test("invites are isolated across organisations, for both listing and revoking", () => {
  invite.resetRateLimits();
  const firmA = makeFirm("Firm A");
  const firmB = makeFirm("Firm B");

  const secret = invite.createInvite(firmA.actor, { email: unique("confidential") });

  // B cannot see it...
  assert.equal(
    invite.listInvites(firmB.actor).some((i) => i.id === secret.invite.id),
    false,
    "A's invitation appeared in B's list",
  );
  assert.equal(invite.listInvites(firmA.actor).some((i) => i.id === secret.invite.id), true);

  // ...and cannot revoke it, even knowing the id exactly.
  assert.equal(invite.revokeInvite(firmB.actor, secret.invite.id), false, "B could revoke A's invitation");
  assert.equal(
    invite.listInvites(firmA.actor).some((i) => i.id === secret.invite.id),
    true,
    "A's invitation was destroyed by B's attempt",
  );

  // The owner can.
  assert.equal(invite.revokeInvite(firmA.actor, secret.invite.id), true);
  assert.equal(invite.listInvites(firmA.actor).some((i) => i.id === secret.invite.id), false);

  // Membership is scoped the same way.
  assert.equal(invite.listOrgMembers(firmB.actor).some((m) => m.id === firmA.actor.id), false);
  assert.equal(invite.listOrgMembers(firmA.actor).some((m) => m.id === firmA.actor.id), true);
});

test("an invite cannot grant more access than the inviter holds", () => {
  invite.resetRateLimits();
  const firm = makeFirm("Junior Analysts", "analyst");
  // 'reviewer' reads every deal in the organisation — see visibility() in
  // repo.ts. An analyst who could mint one, and who is handed the raw token,
  // would have a one-step path to the whole firm's pipeline.
  assert.throws(
    () => invite.createInvite(firm.actor, { email: unique("escalation"), role: "reviewer" }),
    isInviteError("role_above_actor"),
  );
  const ok = invite.createInvite(firm.actor, { email: unique("peer"), role: "analyst" });
  assert.equal(ok.invite.role, "analyst");
});

// ----------------------------------------------------------- password reset --

test("forgot-password answers identically for a known and an unknown address", async () => {
  invite.resetRateLimits();
  const previous = process.env.MERIDIAN_RESET_REQUEST_MAX;
  process.env.MERIDIAN_RESET_REQUEST_MAX = "500";
  try {
    const firm = makeFirm("Enumeration Test");
    const known = firm.actor.email;
    const unknown = unique("definitely-not-a-user");

    const knownTimes: number[] = [];
    const unknownTimes: number[] = [];
    let knownResult: Record<string, unknown> = {};
    let unknownResult: Record<string, unknown> = {};

    for (let i = 0; i < 3; i++) {
      let started = process.hrtime.bigint();
      knownResult = (await invite.requestPasswordReset({ email: known, ip: "198.51.100.1" })) as never;
      knownTimes.push(Number(process.hrtime.bigint() - started) / 1e6);

      started = process.hrtime.bigint();
      unknownResult = (await invite.requestPasswordReset({ email: unknown, ip: "198.51.100.1" })) as never;
      unknownTimes.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    // Identical status is the route's job; identical BODY is this function's.
    assert.deepEqual(Object.keys(knownResult).sort(), Object.keys(unknownResult).sort());
    assert.equal(knownResult.ok, unknownResult.ok);
    assert.equal(knownResult.message, unknownResult.message);
    assert.equal(knownResult.expiresInMinutes, unknownResult.expiresInMinutes);
    assert.equal(
      typeof knownResult.token,
      typeof unknownResult.token,
      "a token must be present or absent in both cases, never only for real accounts",
    );
    assert.equal(
      String(knownResult.token).length,
      String(unknownResult.token).length,
      "the decoy token must be indistinguishable from a real one by length",
    );
    assert.notEqual(knownResult.token, unknownResult.token);

    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const gap = Math.abs(median(knownTimes) - median(unknownTimes));
    assert.ok(
      gap < 50,
      `response time must not be an oracle: known ${median(knownTimes).toFixed(1)}ms vs unknown ${median(unknownTimes).toFixed(1)}ms`,
    );

    // The decoy is genuinely inert: it does not reset anybody's password.
    await assert.rejects(
      () => invite.completePasswordReset({ token: unknownResult.token, password: OTHER_PASSWORD, ip: "198.51.100.2" }),
      isInviteError("invalid_token"),
    );
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_RESET_REQUEST_MAX;
    else process.env.MERIDIAN_RESET_REQUEST_MAX = previous;
  }
});

test("a reset sets the new password, revokes every session, and burns the token", async () => {
  invite.resetRateLimits();
  const firm = makeFirm("Session Revocation");
  const email = unique("resetter");

  // A real account with a password and two live sessions.
  const created = invite.createInvite(firm.actor, { email });
  const accepted = await invite.acceptInvite({
    token: created.token,
    name: "Rania Saab",
    password: PASSWORD,
    ip: "192.0.2.1",
  });
  const { createSession } = await import("./session.ts");
  const second = createSession(accepted.session.user.id, { ip: "192.0.2.2" })!;

  assert.ok(resolveSession(accepted.sessionToken), "session one should be live before the reset");
  assert.ok(resolveSession(second.token), "session two should be live before the reset");

  const request = await invite.requestPasswordReset({ email, ip: "192.0.2.3" });
  assert.equal(typeof request.token, "string", "with no delivery channel the token comes back in the response");

  const outcome = await invite.completePasswordReset({
    token: request.token,
    password: OTHER_PASSWORD,
    ip: "192.0.2.3",
  });
  assert.equal(outcome.email, email);

  assert.equal(resolveSession(accepted.sessionToken), null, "the reset must revoke every existing session");
  assert.equal(resolveSession(second.token), null, "including sessions the user did not initiate the reset from");

  const row = repo.findUserByEmail(email)!;
  assert.ok(
    await verifyPassword(OTHER_PASSWORD, {
      hash: row.password_hash,
      salt: row.password_salt,
      algo: row.password_algo,
    }),
    "the new password must work",
  );
  assert.equal(
    await verifyPassword(PASSWORD, {
      hash: row.password_hash,
      salt: row.password_salt,
      algo: row.password_algo,
    }),
    false,
    "the old password must not",
  );

  // Single use.
  await assert.rejects(
    () => invite.completePasswordReset({ token: request.token, password: PASSWORD, ip: "192.0.2.3" }),
    isInviteError("invalid_token"),
  );

  const audited = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = 'password.reset.completed'",
    row.id,
  );
  assert.equal(audited?.n, 1, "a completed reset must be audited");
});

test("an expired reset token is refused", async () => {
  invite.resetRateLimits();
  const firm = makeFirm("Stale Links");
  const request = await invite.requestPasswordReset({ email: firm.actor.email, ip: "192.0.2.9" });

  run(
    "UPDATE password_resets SET expires_at = ? WHERE token_hash = ?",
    new Date(Date.now() - 1000).toISOString(),
    sha256(String(request.token)),
  );

  await assert.rejects(
    () => invite.completePasswordReset({ token: request.token, password: OTHER_PASSWORD, ip: "192.0.2.9" }),
    isInviteError("invalid_token"),
  );
});

// ----------------------------------------------------------------- webhooks --

interface Capture {
  server: Server;
  url: string;
  bodies: string[];
  status: number;
}

async function startCapture(status = 200): Promise<Capture> {
  const bodies: string[] = [];
  const capture = { bodies, status } as Capture;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(capture.status, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  capture.server = server;
  capture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return capture;
}

function sampleEvent(): Parameters<typeof notify.deliverUnderwritingResult>[0] {
  return {
    dealId: "deal-1234",
    dealName: "Marina Heights Tower B",
    status: "underwritten",
    currency: "AED",
    community: "Dubai Marina",
    modelName: "Dubai residential (full)",
    values: { dscr: 0.98, net_yield: 0.052, purchase_price: 12_480_000, noi: 648_960 },
    flags: [{ id: "dscr_covenant", severity: "red", title: "DSCR below covenant", detail: "0.98× vs 1.25×" }],
    benchmarks: [{ key: "dscr", label: "DSCR", value: 0.98, status: "bad" }],
  };
}

test("a dead webhook endpoint is swallowed, logged, and never thrown into the request path", async () => {
  // Bind a port and immediately release it, so the address is certain to refuse.
  const probe = await startCapture();
  const deadUrl = probe.url;
  await new Promise<void>((resolve) => probe.server.close(() => resolve()));

  const previous = process.env.MERIDIAN_WEBHOOK_URL;
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    process.env.MERIDIAN_WEBHOOK_URL = deadUrl;

    // The awaited form resolves, it does not reject.
    const result = await notify.deliverUnderwritingResult(sampleEvent());
    assert.equal(result.ok, false);
    assert.equal(result.attempted, true);
    assert.ok(result.error, "the failure reason is reported to the caller");

    // The fire-and-forget form used inside the request path returns nothing,
    // synchronously, and cannot throw.
    assert.equal(notify.notifyUnderwritingComplete(sampleEvent()), undefined);

    // A malformed URL is also survivable.
    process.env.MERIDIAN_WEBHOOK_URL = "not a url";
    assert.equal(notify.webhookTarget(), null);
    const unusable = await notify.deliverUnderwritingResult(sampleEvent());
    assert.equal(unusable.attempted, false);
    assert.equal(notify.notifyUnderwritingComplete(sampleEvent()), undefined);

    // A timeout is a failure, not a hang: a 250ms budget against a server that
    // never answers must come back promptly.
    const silent = createServer(() => {
      /* accept the request and never respond */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const target = notify.webhookTarget(`http://127.0.0.1:${(silent.address() as AddressInfo).port}/hook`)!;
    const timedOut = await notify.post(target, { hello: "world" }, { timeoutMs: 250 });
    assert.equal(timedOut.ok, false);
    assert.ok(timedOut.durationMs < 5000, `the timeout must bound the wait, took ${timedOut.durationMs}ms`);
    silent.close();

    // Wait for the fire-and-forget deliveries to settle so their log lines are
    // captured here rather than leaking into another test.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(errors.length > 0, "delivery failures must be logged, not silently discarded");
  } finally {
    console.error = realError;
    if (previous === undefined) delete process.env.MERIDIAN_WEBHOOK_URL;
    else process.env.MERIDIAN_WEBHOOK_URL = previous;
  }
});

test("no webhook URL means no request is made at all", async () => {
  const capture = await startCapture();
  const previous = process.env.MERIDIAN_WEBHOOK_URL;
  try {
    process.env.MERIDIAN_WEBHOOK_URL = "";
    assert.equal(notify.webhookTarget(), null);

    const result = await notify.deliverUnderwritingResult(sampleEvent());
    assert.equal(result.attempted, false, "an unconfigured webhook must not open a socket");
    notify.notifyUnderwritingComplete(sampleEvent());

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(capture.bodies.length, 0, "confidential figures must never reach an unconfigured endpoint");
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_WEBHOOK_URL;
    else process.env.MERIDIAN_WEBHOOK_URL = previous;
    await new Promise<void>((resolve) => capture.server.close(() => resolve()));
  }
});

test("the default payload carries no figures, and detail levels are opt-in", async () => {
  const capture = await startCapture();
  const previousUrl = process.env.MERIDIAN_WEBHOOK_URL;
  const previousDetail = process.env.MERIDIAN_WEBHOOK_DETAIL;
  try {
    process.env.MERIDIAN_WEBHOOK_URL = capture.url;
    process.env.MERIDIAN_WEBHOOK_DETAIL = "";

    const result = await notify.deliverUnderwritingResult(sampleEvent());
    assert.equal(result.ok, true, `delivery should succeed: ${result.error ?? ""}`);
    assert.equal(capture.bodies.length, 1);

    const body = capture.bodies[0];
    assert.match(body, /Marina Heights Tower B/, "the deal name and a link are the point of the message");
    assert.match(body, /#\/deals\/deal-1234/);
    assert.doesNotMatch(body, /12480000|12,480,000/, "the purchase price must not leave by default");
    assert.doesNotMatch(body, /648960|648,960/, "NOI must not leave by default");
    assert.doesNotMatch(body, /0\.98/, "not even the DSCR, at the default detail level");

    // Opt in and the ratios appear; the money still needs `full`.
    process.env.MERIDIAN_WEBHOOK_DETAIL = "metrics";
    await notify.deliverUnderwritingResult(sampleEvent());
    assert.match(capture.bodies[1], /0\.98×/, "metrics detail includes the ratios");
    assert.doesNotMatch(capture.bodies[1], /12,480,000/, "metrics detail still withholds the money");

    process.env.MERIDIAN_WEBHOOK_DETAIL = "full";
    await notify.deliverUnderwritingResult(sampleEvent());
    assert.match(capture.bodies[2], /12,480,000/, "full detail is the only level that discloses figures");
  } finally {
    if (previousUrl === undefined) delete process.env.MERIDIAN_WEBHOOK_URL;
    else process.env.MERIDIAN_WEBHOOK_URL = previousUrl;
    if (previousDetail === undefined) delete process.env.MERIDIAN_WEBHOOK_DETAIL;
    else process.env.MERIDIAN_WEBHOOK_DETAIL = previousDetail;
    await new Promise<void>((resolve) => capture.server.close(() => resolve()));
  }
});

test("payloads are shaped for Slack and Teams, and thresholds decide the verdict", () => {
  assert.equal(notify.detectFlavour("https://hooks.slack.com/services/T000/B000/xxx"), "slack");
  assert.equal(notify.detectFlavour("https://acme.webhook.office.com/webhookb2/abc"), "teams");
  assert.equal(notify.detectFlavour("https://ops.example.ae/meridian"), "generic");

  const event = sampleEvent();
  const outcome = notify.evaluateThresholds(event);
  assert.equal(outcome.verdict, "fail", "a DSCR of 0.98 against a 1.25 covenant is a failure");
  assert.ok(outcome.checks.some((c) => c.key === "dscr" && !c.passed));

  const slack = notify.buildPayload(event, outcome, "slack", "summary") as Record<string, unknown>;
  assert.equal(typeof slack.text, "string", "Slack needs a text field for notifications and fallbacks");
  assert.ok(Array.isArray(slack.blocks) && slack.blocks.length > 0, "and blocks for the rich rendering");

  const teams = notify.buildPayload(event, outcome, "teams", "summary") as Record<string, unknown>;
  assert.equal(teams["@type"], "MessageCard");

  const generic = notify.buildPayload(event, outcome, "generic", "summary") as Record<string, unknown>;
  assert.equal(generic.event, "deal.underwritten");
  assert.equal(generic.verdict, "fail");
  assert.equal(generic.metrics, undefined, "a generic endpoint gets no metrics at summary detail");

  const passing = notify.evaluateThresholds({
    dealId: "d2",
    dealName: "Clean Deal",
    status: "underwritten",
    values: { dscr: 1.9, net_yield: 0.071 },
    flags: [],
    benchmarks: [{ key: "dscr", label: "DSCR", value: 1.9, status: "good" }],
  });
  assert.equal(passing.verdict, "pass");
});
