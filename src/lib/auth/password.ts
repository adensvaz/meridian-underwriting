// Password hashing on scrypt from node:crypto.
//
// scrypt rather than bcrypt/argon2 specifically because it ships in Node. This
// project has a hard no-native-modules rule (it is what lets the whole thing run
// with `node src/server.ts` and no build step), and a memory-hard KDF that is
// actually present beats a marginally better one that needs a compiler.
//
// Parameters: N=2^15, r=8, p=1 — roughly 32 MB and ~100ms per hash on a modern
// machine. That is the standard interactive-login trade: slow enough that
// offline cracking is expensive, fast enough that a login does not feel broken.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

// Node caps scrypt memory at 32 MB by default; N=2^15 with r=8 needs
// 128 * N * r = 32 MB exactly, so ask for headroom or it throws.
const MAX_MEMORY = 64 * 1024 * 1024;

export interface PasswordHash {
  hash: string;
  salt: string;
  algo: string;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return {
    hash: derived.toString("hex"),
    salt: salt.toString("hex"),
    algo: `scrypt$${N}$${R}$${P}`,
  };
}

export async function verifyPassword(
  password: string,
  stored: { hash?: string | null; salt?: string | null; algo?: string | null },
): Promise<boolean> {
  if (!stored.hash || !stored.salt) {
    // No credential set (an invite that was never accepted). Still burn the
    // time so that "user exists but has no password" is not distinguishable
    // from "wrong password" by response latency.
    await hashPassword(password);
    return false;
  }

  const { n, r, p } = parseAlgo(stored.algo);
  let derived: Buffer;
  try {
    derived = (await scryptAsync(password.normalize("NFKC"), Buffer.from(stored.salt, "hex"), KEY_LENGTH, {
      N: n,
      r,
      p,
      maxmem: MAX_MEMORY,
    })) as Buffer;
  } catch {
    return false;
  }

  const expected = Buffer.from(stored.hash, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

function parseAlgo(algo: string | null | undefined): { n: number; r: number; p: number } {
  // Stored per-user so the work factor can be raised later without
  // invalidating every existing password.
  if (typeof algo === "string" && algo.startsWith("scrypt$")) {
    const [, n, r, p] = algo.split("$");
    const parsed = { n: Number(n), r: Number(r), p: Number(p) };
    if (Number.isFinite(parsed.n) && Number.isFinite(parsed.r) && Number.isFinite(parsed.p)) {
      return parsed;
    }
  }
  return { n: N, r: R, p: P };
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Length first, composition rules barely at all — this follows current NIST
 * guidance rather than the "one uppercase, one symbol" ritual that pushes
 * people towards Password1!.
 */
export function checkPasswordPolicy(password: string, email?: string): PasswordPolicyResult {
  const problems: string[] = [];
  const value = password.normalize("NFKC");

  if (value.length < 12) problems.push("Use at least 12 characters");
  if (value.length > 512) problems.push("Password is too long");
  if (/^\s|\s$/.test(value)) problems.push("Password cannot start or end with a space");

  const lower = value.toLowerCase();
  if (email) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local && local.length > 2 && lower.includes(local)) {
      problems.push("Password cannot contain your email address");
    }
  }

  const COMMON = [
    "password", "123456", "qwerty", "letmein", "welcome", "admin",
    "meridian", "dubai", "changeme", "iloveyou", "monkey", "abc123",
  ];
  if (COMMON.some((c) => lower.includes(c))) {
    problems.push("Password contains a commonly guessed word");
  }

  // A single repeated character or a straight run is long but not strong.
  if (/^(.)\1+$/.test(value)) problems.push("Password cannot be a single repeated character");

  return { ok: problems.length === 0, problems };
}
