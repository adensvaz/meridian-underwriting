// Invitations, organisation membership, and password reset.
//
// The product is invite-only by design: there is no public signup route and
// there never will be. Until now the only way to add a second analyst was to
// run a script on the server, which is not a product. This file is that
// missing piece, and it is written to the same posture as the rest of auth:
//
//   * The raw invite token is generated with the same primitive as a session
//     token and only its SHA-256 is stored. The raw value is returned exactly
//     once, to the inviter, and is not recoverable afterwards — a database
//     dump does not hand over a route into somebody's organisation.
//   * Tokens expire and are single-use. Acceptance is guarded by a conditional
//     UPDATE, so two concurrent accepts cannot both create an account.
//   * Every entry point that takes a token is rate-limited HERE, not in the
//     route handler, so an endpoint physically cannot forget to throttle.
//   * Every read and write is scoped to the actor's organisation. A user
//     cannot see, revoke, or accept into another firm.
//
// Configuration (read from process.env directly — src/lib/env.ts is owned
// elsewhere, so the knobs are documented here):
//
//   MERIDIAN_INVITE_TTL_DAYS       Invite lifetime, default 7.
//   MERIDIAN_RESET_TTL_MINUTES     Reset-token lifetime, default 60.
//   MERIDIAN_TOKEN_WINDOW_MINUTES  Rate-limit window, default 15.
//   MERIDIAN_INVITE_ACCEPT_MAX     Accept attempts per IP per window, default 10.
//   MERIDIAN_INVITE_LOOKUP_MAX     Invite previews per IP per window, default 30.
//   MERIDIAN_RESET_REQUEST_MAX     Forgot-password calls per IP per window, default 5.
//   MERIDIAN_FORGOT_FLOOR_MS       Constant-time floor for forgot-password, default 120.
//   MERIDIAN_RESET_DELIVERY_URL    Where to POST a reset link. Unset = the raw
//                                  token comes back in the response instead.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { all, get, nowIso, run, transaction } from "../db/index.ts";
import { checkPasswordPolicy, hashPassword } from "./password.ts";
import {
  createSession,
  newToken,
  revokeAllSessionsForUser,
  type AuthenticatedUser,
  type Session,
} from "./session.ts";
import { audit, createUser, findUserByEmail, setUserPassword } from "../db/repo.ts";
import { deliverJson } from "../notify.ts";

// ------------------------------------------------------------------ config --

function envString(key: string): string {
  const raw = process.env[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function envNumber(key: string, fallback: number): number {
  const raw = envString(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function inviteTtlMs(): number {
  return envNumber("MERIDIAN_INVITE_TTL_DAYS", 7) * 24 * 60 * 60 * 1000;
}

function resetTtlMs(): number {
  return envNumber("MERIDIAN_RESET_TTL_MINUTES", 60) * 60 * 1000;
}

function throttleWindowMs(): number {
  return envNumber("MERIDIAN_TOKEN_WINDOW_MINUTES", 15) * 60 * 1000;
}

/** Roles an invite may grant. Anything else is refused. */
export const INVITABLE_ROLES = ["analyst", "owner", "reviewer", "admin"];

/**
 * Privilege rank, defined by how much the role can SEE — see visibility() in
 * repo.ts, where 'reviewer' and 'admin' read the whole organisation while
 * everyone else reads only their own deals.
 *
 * This matters because an invite is a privilege-granting operation performed by
 * an ordinary user who also receives the raw token. Without a rank check an
 * analyst could invite an address they control as a 'reviewer', accept it, and
 * read every deal in the firm. So: you may not invite above your own rank.
 */
const ROLE_RANK: Record<string, number> = {
  analyst: 1,
  owner: 2,
  reviewer: 3,
  admin: 4,
};

function rankOf(role: string): number {
  return ROLE_RANK[role] ?? 1;
}

// -------------------------------------------------------------- aux storage --

// The password-reset store. schema.sql is owned elsewhere, so this table is
// created idempotently at module load. CREATE TABLE IF NOT EXISTS is a no-op
// on every run after the first, and it is re-run by the helpers below so a
// process that swaps its database mid-life (the test harness does exactly
// that) still finds the table present.
function ensureAuxTables(): void {
  run(`CREATE TABLE IF NOT EXISTS password_resets (
         id          TEXT PRIMARY KEY,
         user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         token_hash  TEXT NOT NULL,
         expires_at  TEXT NOT NULL,
         used_at     TEXT,
         requested_ip TEXT,
         created_at  TEXT NOT NULL
       )`);
  run("CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(token_hash)");
  run("CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)");
}
ensureAuxTables();

// -------------------------------------------------------------------- errors --

/**
 * A failure with an HTTP status already decided. The route layer maps this
 * straight onto HttpError; keeping the decision here means the rules and their
 * status codes are testable without booting a server.
 */
export class InviteError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "InviteError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// -------------------------------------------------------------- rate limits --

// In-memory sliding window, keyed by bucket + subject. In-process is the right
// scope: this deployment is a single Node server against a single SQLite file,
// and a table write per guessed token would be a denial-of-service amplifier
// rather than a defence.
const windows = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(bucket: string, subject: string, limit: number, windowMs: number): RateLimitResult {
  const key = `${bucket}:${subject}`;
  const now = Date.now();
  const cutoff = now - windowMs;

  const hits = (windows.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limit) {
    windows.set(key, hits);
    const oldest = hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  hits.push(now);
  windows.set(key, hits);

  // Opportunistic sweep so a long-lived process does not accumulate keys for
  // every IP that ever touched the endpoint.
  if (windows.size > 5000) {
    for (const [k, v] of windows) {
      if (!v.some((t) => t > cutoff)) windows.delete(k);
    }
  }

  return { allowed: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}

/** Test seam. Never called from a route. */
export function resetRateLimits(): void {
  windows.clear();
}

function enforce(bucket: string, subject: string, limit: number, message: string): void {
  const result = rateLimit(bucket, subject || "unknown", limit, throttleWindowMs());
  if (!result.allowed) {
    throw new InviteError(429, "rate_limited", message, result.retryAfterSeconds);
  }
}

// ------------------------------------------------------------------ helpers --

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Confirms a candidate hash against the stored one in constant time.
 *
 * The row is located by an indexed equality lookup — that is what makes the
 * query fast — and this is the comparison that actually authorises it. Doing
 * both means the accept path never branches on a byte-by-byte string compare
 * of a secret-derived value.
 */
function hashMatches(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normaliseEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

// Deliberately loose. Address validity is proved by the invitee receiving the
// token, not by a regex, and an over-strict pattern rejects legitimate
// addresses. This only catches obvious rubbish.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

function assertEmail(email: string): void {
  if (!email || email.length > 254 || !EMAIL_SHAPE.test(email)) {
    throw new InviteError(400, "invalid_email", "That does not look like an email address");
  }
}

function tokenShapeOk(token: unknown): token is string {
  return typeof token === "string" && token.length >= 20 && token.length <= 200;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ invites --

interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  token_hash: string;
  created_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "expired";
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  invitedBy: string | null;
}

function summarise(row: InviteRow & { invited_by?: string | null }): InviteSummary {
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.accepted_at ? "accepted" : expired ? "expired" : "pending",
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    invitedBy: row.invited_by ?? null,
  };
}

export interface CreatedInvite {
  /** The raw token. Returned once, never stored, never retrievable again. */
  token: string;
  invite: InviteSummary;
  expiresAt: string;
}

export function createInvite(
  actor: AuthenticatedUser,
  input: { email: unknown; role?: unknown },
  context: { ip?: string } = {},
): CreatedInvite {
  const email = normaliseEmail(input.email);
  assertEmail(email);

  const role = String(input.role ?? "analyst").trim().toLowerCase() || "analyst";
  if (!INVITABLE_ROLES.includes(role)) {
    throw new InviteError(400, "invalid_role", `Role must be one of: ${INVITABLE_ROLES.join(", ")}`);
  }
  if (rankOf(role) > rankOf(actor.role)) {
    throw new InviteError(
      403,
      "role_above_actor",
      "You cannot invite somebody with more access than you have",
    );
  }

  // An address that already has an account cannot be invited anywhere — not
  // into this organisation and not into another one. Accounts are unique by
  // email, so this would fail at accept time regardless; refusing now gives the
  // inviter a useful answer instead of a dead token.
  if (findUserByEmail(email)) {
    throw new InviteError(409, "already_a_user", "An account already exists for that email address");
  }

  const token = newToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + inviteTtlMs()).toISOString();
  const inviteId = randomUUID();

  transaction(() => {
    // Re-inviting supersedes any outstanding invitation for the same address in
    // the same organisation, so a stale token cannot be used later.
    run(
      "UPDATE invites SET expires_at = ? WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND expires_at > ?",
      now,
      actor.org_id,
      email,
      now,
    );
    run(
      `INSERT INTO invites (id, org_id, email, role, token_hash, created_by, expires_at, accepted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      inviteId,
      actor.org_id,
      email,
      role,
      sha256(token),
      actor.id,
      expiresAt,
      now,
    );
  });

  audit(actor, "invite.created", "invite", inviteId, { email, role }, context.ip);

  const row = get<InviteRow>("SELECT * FROM invites WHERE id = ?", inviteId)!;
  return { token, invite: summarise(row), expiresAt };
}

/**
 * Every invite belonging to the actor's organisation and nobody else's. The
 * org filter is in the SQL, not applied afterwards, so there is no shape of
 * this function that returns another firm's rows.
 */
export function listInvites(actor: AuthenticatedUser): InviteSummary[] {
  const rows = all<InviteRow & { invited_by: string | null }>(
    `SELECT i.*, u.name AS invited_by
       FROM invites i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.org_id = ?
      ORDER BY i.created_at DESC
      LIMIT 200`,
    actor.org_id,
  );
  return rows.map(summarise);
}

/**
 * Revoking is a delete scoped by org_id in the same statement as the id, so a
 * guessed invite id from another firm changes nothing and reports not-found.
 */
export function revokeInvite(actor: AuthenticatedUser, inviteId: string, context: { ip?: string } = {}): boolean {
  const result = run(
    "DELETE FROM invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL",
    inviteId,
    actor.org_id,
  );
  if (!result.changes) return false;
  audit(actor, "invite.revoked", "invite", inviteId, undefined, context.ip);
  return true;
}

export interface InvitePreview {
  email: string;
  organization: string;
  role: string;
  expiresAt: string;
}

/**
 * What the accept screen is allowed to know before anybody has authenticated:
 * who was invited and by which firm, so the page can greet them. Nothing else —
 * no organisation id, no inviter identity, no deal counts, no user list.
 */
export function describeInvite(token: unknown, context: { ip?: string } = {}): InvitePreview {
  enforce(
    "invite.lookup",
    context.ip ?? "unknown",
    envNumber("MERIDIAN_INVITE_LOOKUP_MAX", 30),
    "Too many attempts. Wait a few minutes and try again.",
  );

  const row = loadUsableInvite(token);
  const org = get<{ name: string }>("SELECT name FROM organizations WHERE id = ?", row.org_id);
  return {
    email: row.email,
    organization: org?.name ?? "",
    role: row.role,
    expiresAt: row.expires_at,
  };
}

/**
 * Resolves a raw token to an invite that is genuinely usable, or throws. The
 * four refusal cases the brief calls out — unknown, expired, already accepted,
 * and an email that already has an account — all land here, so the accept path
 * and the preview path cannot disagree about what a valid invite is.
 */
function loadUsableInvite(token: unknown): InviteRow {
  if (!tokenShapeOk(token)) {
    throw new InviteError(400, "invalid_token", "That invitation link is not valid");
  }

  const candidate = sha256(token);
  const row = get<InviteRow>("SELECT * FROM invites WHERE token_hash = ?", candidate);
  if (!row || !hashMatches(row.token_hash, candidate)) {
    throw new InviteError(400, "invalid_token", "That invitation link is not valid");
  }
  if (row.accepted_at) {
    throw new InviteError(410, "already_accepted", "That invitation has already been used");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new InviteError(410, "expired", "That invitation has expired — ask for a new one");
  }
  if (findUserByEmail(row.email)) {
    throw new InviteError(409, "already_a_user", "An account already exists for that email address");
  }
  return row;
}

export interface AcceptedInvite {
  /** Session token for the new account — set as the session cookie. */
  sessionToken: string;
  session: Session;
}

/**
 * Unauthenticated by necessity: the invitee has no account yet. Everything that
 * would normally be provided by a session — throttling, identity, organisation
 * — comes from the token, so the token is treated as a credential throughout.
 */
export async function acceptInvite(input: {
  token: unknown;
  name: unknown;
  password: unknown;
  ip?: string;
  userAgent?: string;
}): Promise<AcceptedInvite> {
  // Throttle FIRST, before the token is even looked at, so a brute-force run
  // burns its budget on the very first guess rather than on the first valid one.
  enforce(
    "invite.accept",
    input.ip ?? "unknown",
    envNumber("MERIDIAN_INVITE_ACCEPT_MAX", 10),
    "Too many attempts. Wait a few minutes and try again.",
  );

  const name = String(input.name ?? "").trim().slice(0, 200);
  if (name.length < 2) {
    throw new InviteError(400, "invalid_name", "Tell us your name so colleagues can recognise you");
  }
  const password = String(input.password ?? "");

  const invite = loadUsableInvite(input.token);

  const policy = checkPasswordPolicy(password, invite.email);
  if (!policy.ok) {
    throw new InviteError(400, "weak_password", policy.problems.join(". "));
  }

  // Hashing is deliberately slow, so it happens outside the transaction.
  const creds = await hashPassword(password);

  const userId = transaction(() => {
    // Single-use is enforced by this conditional UPDATE, not by the read above:
    // two concurrent accepts race here and exactly one sees changes === 1.
    const claimed = run(
      "UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?",
      nowIso(),
      invite.id,
      nowIso(),
    );
    if (!claimed.changes) {
      throw new InviteError(410, "already_accepted", "That invitation has already been used");
    }

    const user = createUser({
      orgId: invite.org_id,
      email: invite.email,
      name,
      role: invite.role,
      status: "active",
      passwordHash: creds.hash,
      passwordSalt: creds.salt,
      passwordAlgo: creds.algo,
    });
    return user.id;
  });

  const created = createSession(userId, { ip: input.ip, userAgent: input.userAgent });
  if (!created) {
    throw new InviteError(500, "session_failed", "Your account was created but the session could not start");
  }

  audit(
    created.session.user,
    "invite.accepted",
    "invite",
    invite.id,
    { email: invite.email, role: invite.role },
    input.ip,
  );

  return { sessionToken: created.token, session: created.session };
}

// ------------------------------------------------------------------ members --

export interface OrgMember {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * Organisation roster. Scoped by the actor's own org_id in the SQL — there is
 * no argument a caller could pass that would widen it.
 */
export function listOrgMembers(actor: AuthenticatedUser): OrgMember[] {
  const rows = all<{
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    created_at: string;
    last_login_at: string | null;
  }>(
    `SELECT id, email, name, role, status, created_at, last_login_at
       FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT 500`,
    actor.org_id,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: r.status,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }));
}

// ----------------------------------------------------------- password reset --

export interface ForgotPasswordResult {
  /** Always true. The caller must not vary its response on anything else. */
  ok: true;
  message: string;
  /**
   * Present only when no delivery channel is configured. For an address with no
   * account this is a DECOY — a well-formed token that was never stored — so
   * the response is byte-identical in shape whether or not the account exists.
   */
  token?: string;
  expiresInMinutes?: number;
}

const FORGOT_MESSAGE =
  "If that email address has an account, a password reset has been issued. The link is valid for a short time.";

/**
 * Account enumeration is the entire risk on this endpoint, so both branches are
 * built to be indistinguishable:
 *
 *   * identical status, identical message, identical response shape;
 *   * the same amount of work — a token is generated and hashed either way;
 *   * a floor on elapsed time, so the extra INSERT on the real branch cannot be
 *     read off the clock;
 *   * delivery is fired and forgotten, never awaited, so a slow mail relay
 *     cannot leak "this address exists" through latency either.
 *
 * The decoy token is the part that is easy to get wrong: returning the raw
 * token only for real accounts would put the oracle straight into the body.
 */
export async function requestPasswordReset(input: {
  email: unknown;
  ip?: string;
}): Promise<ForgotPasswordResult> {
  const started = Date.now();
  const floorMs = envNumber("MERIDIAN_FORGOT_FLOOR_MS", 120);

  enforce(
    "password.forgot",
    input.ip ?? "unknown",
    envNumber("MERIDIAN_RESET_REQUEST_MAX", 5),
    "Too many password reset requests. Wait a few minutes and try again.",
  );

  ensureAuxTables();

  const email = normaliseEmail(input.email);
  // Both branches generate and hash a token; only one branch stores it.
  const token = newToken();
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + resetTtlMs()).toISOString();

  const user = EMAIL_SHAPE.test(email) ? findUserByEmail(email) : undefined;

  if (user && user.status !== "disabled") {
    run(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, requested_ip, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      randomUUID(),
      user.id,
      tokenHash,
      expiresAt,
      input.ip ?? null,
      nowIso(),
    );
    audit(
      { id: user.id, org_id: user.org_id, email: user.email, name: user.name, role: user.role, status: user.status },
      "password.reset.requested",
      "user",
      user.id,
      undefined,
      input.ip,
    );
    deliverResetToken(email, token, expiresAt);
  } else {
    // Same shape of work, same number of audit writes, no user row touched.
    audit(null, "password.reset.requested.unknown", "user", undefined, { email }, input.ip);
  }

  const result: ForgotPasswordResult = { ok: true, message: FORGOT_MESSAGE };
  if (!resetDeliveryUrl()) {
    // Self-hosted with no delivery channel: the operator reads the token from
    // this response and passes it on out of band. Issued for real and decoy
    // alike — a decoy simply fails when it is used.
    result.token = token;
    result.expiresInMinutes = Math.round(resetTtlMs() / 60_000);
  }

  const elapsed = Date.now() - started;
  if (elapsed < floorMs) await sleep(floorMs - elapsed);
  return result;
}

function resetDeliveryUrl(): string {
  return envString("MERIDIAN_RESET_DELIVERY_URL");
}

/** Fire-and-forget, exactly like the deal webhook: it cannot fail the request. */
function deliverResetToken(email: string, token: string, expiresAt: string): void {
  const url = resetDeliveryUrl();
  if (!url) return;
  try {
    void deliverJson(url, {
      event: "password.reset",
      email,
      token,
      expiresAt,
      sentAt: nowIso(),
    }).catch(() => {});
  } catch (err) {
    console.error("[invite] could not schedule reset delivery", err);
  }
}

export interface ResetOutcome {
  userId: string;
  email: string;
  sessionsRevoked: true;
}

export async function completePasswordReset(input: {
  token: unknown;
  password: unknown;
  ip?: string;
}): Promise<ResetOutcome> {
  enforce(
    "password.reset",
    input.ip ?? "unknown",
    envNumber("MERIDIAN_RESET_REQUEST_MAX", 5) * 2,
    "Too many attempts. Wait a few minutes and try again.",
  );

  ensureAuxTables();

  if (!tokenShapeOk(input.token)) {
    throw new InviteError(400, "invalid_token", "That reset link is not valid or has expired");
  }

  const candidate = sha256(input.token);
  const row = get<{
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
  }>("SELECT id, user_id, token_hash, expires_at, used_at FROM password_resets WHERE token_hash = ?", candidate);

  // One message for unknown, used and expired alike: unlike an invite, a reset
  // token maps to an existing account, so distinguishing the cases would tell a
  // guesser which of their guesses had ever been a real token.
  if (!row || !hashMatches(row.token_hash, candidate) || row.used_at) {
    throw new InviteError(400, "invalid_token", "That reset link is not valid or has expired");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new InviteError(400, "invalid_token", "That reset link is not valid or has expired");
  }

  const user = get<{ id: string; org_id: string; email: string; name: string; role: string; status: string }>(
    "SELECT id, org_id, email, name, role, status FROM users WHERE id = ?",
    row.user_id,
  );
  if (!user) {
    throw new InviteError(400, "invalid_token", "That reset link is not valid or has expired");
  }

  const password = String(input.password ?? "");
  const policy = checkPasswordPolicy(password, user.email);
  if (!policy.ok) {
    throw new InviteError(400, "weak_password", policy.problems.join(". "));
  }

  const creds = await hashPassword(password);

  transaction(() => {
    const claimed = run(
      "UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL",
      nowIso(),
      row.id,
    );
    if (!claimed.changes) {
      throw new InviteError(400, "invalid_token", "That reset link is not valid or has expired");
    }
    // Every other outstanding reset for this account dies with it. Otherwise a
    // second, older token issued to an attacker survives the victim's reset.
    run(
      "UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
      nowIso(),
      user.id,
    );
    setUserPassword(user.id, creds);
  });

  // A password reset is the standard response to "someone else has access".
  // Every existing session must die, including any the attacker holds.
  revokeAllSessionsForUser(user.id);
  audit(user, "password.reset.completed", "user", user.id, undefined, input.ip);

  return { userId: user.id, email: user.email, sessionsRevoked: true };
}

/** Housekeeping the operator can call; keeps the two token tables bounded. */
export function purgeExpiredTokens(): number {
  ensureAuxTables();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const invites = run("DELETE FROM invites WHERE accepted_at IS NULL AND expires_at < ?", cutoff).changes;
  const resets = run("DELETE FROM password_resets WHERE expires_at < ?", cutoff).changes;
  return invites + resets;
}
