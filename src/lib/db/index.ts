// Database access. node:sqlite (DatabaseSync) — no native modules, no server,
// no build step. The whole persistence layer is one file plus the schema.
//
// SQLite is the right call for this MVP and is not a corner being cut: a single
// writer, a handful of concurrent analysts, and a working set measured in
// megabytes. The repository layer in repo.ts is written so that swapping to
// Postgres later means rewriting one file, not the application.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env, ROOT } from "../env.ts";

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;

  mkdirSync(dirname(env.dbPath), { recursive: true });
  mkdirSync(env.uploadDir, { recursive: true });

  handle = new DatabaseSync(env.dbPath);

  // WAL lets readers proceed during a write, which matters the moment two
  // browser tabs poll the same deal. NORMAL synchronous is the right trade for
  // an app whose source of truth is re-derivable from the uploaded documents.
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec("PRAGMA busy_timeout = 5000");

  migrate(handle);
  return handle;
}

export function migrate(database: DatabaseSync = db()): void {
  const schema = readFileSync(resolve(ROOT, "src/lib/db/schema.sql"), "utf8");
  database.exec(schema);
  database
    .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)")
    .run("migrated_at", new Date().toISOString());
}

export function closeDb(): void {
  if (handle) {
    handle.close();
    handle = null;
  }
}

// ------------------------------------------------------------------ helpers --

type Row = Record<string, unknown>;

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number } {
  const result = db().prepare(sql).run(...(params as never[]));
  return { changes: Number(result.changes) };
}

/**
 * Wraps fn in a transaction. node:sqlite has no transaction helper, so this is
 * the explicit form. Nested calls are flattened via a depth counter because
 * SQLite has no nested BEGIN.
 */
let txDepth = 0;
export function transaction<T>(fn: () => T): T {
  const database = db();
  if (txDepth > 0) return fn();

  txDepth++;
  database.exec("BEGIN");
  try {
    const out = fn();
    database.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // A rollback failure means the connection is already unwound; the
      // original error is the one worth propagating.
    }
    throw err;
  } finally {
    txDepth--;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** JSON columns are stored as TEXT; these two keep the casts in one place. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}
