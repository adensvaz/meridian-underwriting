// Server-side sessions and CSRF.
//
// The client's requirement was explicit: authentication must be a real access
// barrier, not a cosmetic login screen. That means, concretely:
//
//   * The cookie carries an opaque 256-bit random token and nothing else. No
//     user id, no role, no signed claims. Stealing the cookie value is the only
//     way to impersonate, and revocation is a single UPDATE.
//   * Only the SHA-256 of the token is stored. A database dump does not hand
//     over live sessions.
//   * Cookies are HttpOnly (JS cannot read them), SameSite=Lax (blocks
//     cross-site form posts while keeping ordinary navigation working), and
//     Secure in production.
//   * Every state-changing request carries a double-submitted CSRF token bound
//     to the session's own secret.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env.ts";
import { get, nowIso, run } from "../db/index.ts";

export const SESSION_COOKIE = "meridian_session";
export const CSRF_HEADER = "x-meridian-csrf";

export interface SessionRecord {
  id: string;
  user_id: string;
  csrf_secret: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AuthenticatedUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
}

export interface Session {
  id: string;
  user: AuthenticatedUser;
  csrfToken: string;
  expiresAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createSession(
  userId: string,
  context: { ip?: string; userAgent?: string } = {},
): { token: string; session: Session } | null {
  const token = newToken();
  const id = randomBytes(16).toString("hex");
  const csrfSecret = newToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + env.sessionTtlMs).toISOString();

  run(
    `INSERT INTO sessions
       (id, user_id, token_hash, csrf_secret, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    sha256(token),
    csrfSecret,
    createdAt,
    expiresAt,
    createdAt,
    context.ip ?? null,
    (context.userAgent ?? "").slice(0, 300) || null,
  );

  run("UPDATE users SET last_login_at = ? WHERE id = ?", createdAt, userId);

  const user = loadUser(userId);
  if (!user) return null;

  return {
    token,
    session: { id, user, csrfToken: csrfTokenFor(csrfSecret), expiresAt },
  };
}

function loadUser(userId: string): AuthenticatedUser | null {
  const row = get<AuthenticatedUser>(
    `SELECT id, org_id, email, name, role, status FROM users WHERE id = ?`,
    userId,
  );
  return row ?? null;
}

export function resolveSession(token: string | null | undefined): Session | null {
  if (!token || token.length < 20 || token.length > 200) return null;

  const row = get<SessionRecord & { expires_at: string }>(
    `SELECT id, user_id, csrf_secret, expires_at, revoked_at
       FROM sessions WHERE token_hash = ?`,
    sha256(token),
  );
  if (!row || row.revoked_at) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    run("UPDATE sessions SET revoked_at = ? WHERE id = ?", nowIso(), row.id);
    return null;
  }

  const user = loadUser(row.user_id);
  if (!user || user.status !== "active") return null;

  // Sliding expiry, written at most once a minute so an active session does not
  // generate a write per request.
  const seen = nowIso();
  const expiresAt = new Date(Date.now() + env.sessionTtlMs).toISOString();
  run(
    `UPDATE sessions SET last_seen_at = ?, expires_at = ?
      WHERE id = ? AND last_seen_at < ?`,
    seen,
    expiresAt,
    row.id,
    new Date(Date.now() - 60_000).toISOString(),
  );

  return {
    id: row.id,
    user,
    csrfToken: csrfTokenFor(row.csrf_secret),
    expiresAt: row.expires_at,
  };
}

export function revokeSession(token: string | null | undefined): void {
  if (!token) return;
  run("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?", nowIso(), sha256(token));
}

export function revokeAllSessionsForUser(userId: string): void {
  run(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    nowIso(),
    userId,
  );
}

export function purgeExpiredSessions(): number {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return run("DELETE FROM sessions WHERE expires_at < ?", cutoff).changes;
}

// ---------------------------------------------------------------------- CSRF --

// The token handed to the page is HMAC-ish over the session's stored secret and
// the server key. It is not stored anywhere, so it cannot leak from the
// database, and it is only valid for the session that owns the secret.
function csrfTokenFor(secret: string): string {
  return createHash("sha256").update(`${secret}:${env.sessionSecret}`).digest("base64url");
}

export function verifyCsrf(session: Session, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(presented);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ------------------------------------------------------------------ cookies --

export function buildSessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(env.sessionTtlMs / 1000)}`,
  ];
  if (env.isProduction) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (env.isProduction) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(piece.slice(eq + 1).trim());
  }
  return out;
}

// ------------------------------------------------------------- login throttle --

export interface ThrottleResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  remaining: number;
}

/**
 * Throttles by email AND by IP. Email alone lets one host spray many accounts;
 * IP alone lets a botnet grind one account. Both are cheap here.
 */
export function checkLoginThrottle(email: string, ip: string): ThrottleResult {
  const since = new Date(Date.now() - env.loginWindowMs).toISOString();

  const byEmail = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND ok = 0 AND created_at > ?",
    email.toLowerCase(),
    since,
  );
  const byIp = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND created_at > ?",
    ip,
    since,
  );

  const failures = Math.max(byEmail?.n ?? 0, Math.floor((byIp?.n ?? 0) / 3));
  const remaining = Math.max(0, env.loginMaxAttempts - failures);

  if (failures >= env.loginMaxAttempts) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(env.loginWindowMs / 1000),
      remaining: 0,
    };
  }
  return { allowed: true, remaining };
}

export function recordLoginAttempt(email: string, ip: string, ok: boolean): void {
  run(
    "INSERT INTO login_attempts (email, ip, ok, created_at) VALUES (?, ?, ?, ?)",
    email.toLowerCase(),
    ip,
    ok ? 1 : 0,
    nowIso(),
  );
  if (ok) {
    run("DELETE FROM login_attempts WHERE email = ? AND ok = 0", email.toLowerCase());
  }
  // Keep the table from growing without bound.
  run(
    "DELETE FROM login_attempts WHERE created_at < ?",
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  );
}
