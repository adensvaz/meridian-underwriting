// Central configuration. Everything that varies by deployment lands here so no
// other module has to reach for process.env.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");

// Node 22.6+ loads .env with --env-file, but we want `npm run serve` to work
// with no flags, so parse it ourselves. Existing process.env always wins.
function loadDotEnv(): void {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// The session secret must survive restarts or every login dies on deploy.
// If the operator has not set one, generate and persist it locally.
function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  const keyPath = resolve(ROOT, "data/.session-key");
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  mkdirSync(dirname(keyPath), { recursive: true });
  const generated = randomBytes(32).toString("hex");
  writeFileSync(keyPath, generated, { mode: 0o600 });
  return generated;
}

export const env = {
  nodeEnv: str("NODE_ENV", "development"),
  get isProduction(): boolean {
    return this.nodeEnv === "production";
  },

  port: num("PORT", 4100),

  // A getter, not a constant, so the self-check harness can point the whole
  // data layer at a throwaway database without ever touching real deals.
  get dbPath(): string {
    const override = process.env.MERIDIAN_DB_OVERRIDE;
    return override && override.length ? resolve(override) : resolve(ROOT, "data/meridian.db");
  },
  uploadDir: resolve(ROOT, "data/uploads"),
  publicDir: resolve(ROOT, "public"),

  anthropicKey: str("ANTHROPIC_API_KEY", ""),
  model: str("MERIDIAN_MODEL", "claude-opus-5"),
  maxDocsPerDeal: num("MERIDIAN_MAX_DOCS_PER_DEAL", 12),
  get aiEnabled(): boolean {
    return this.anthropicKey.length > 0 && this.maxDocsPerDeal > 0;
  },

  sessionSecret: sessionSecret(),
  sessionTtlMs: num("SESSION_TTL_HOURS", 12) * 60 * 60 * 1000,
  loginMaxAttempts: num("LOGIN_MAX_ATTEMPTS", 8),
  loginWindowMs: num("LOGIN_WINDOW_MINUTES", 15) * 60 * 1000,

  maxUploadBytes: num("MAX_UPLOAD_MB", 40) * 1024 * 1024,

  defaultMarket: str("DEFAULT_MARKET", "AE"),
} as const;

export type Env = typeof env;
