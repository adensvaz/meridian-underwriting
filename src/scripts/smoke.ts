// npm run smoke — end-to-end acceptance test over real HTTP.
//
// `npm run check` proves the engine and the data layer in isolation. This
// proves the assembled application: it boots a server against a throwaway
// database on a spare port, then drives the actual API the browser drives.
//
// It exists because the interesting failures in this system are integration
// failures. The two it has already caught, both of which looked like working
// software from the inside:
//
//   * a model whose input keys did not match the platform's derivation keys,
//     so rent-roll figures silently fell back to defaults — a plausible number
//     on screen that had nothing to do with the uploaded documents;
//   * `??` mixed with `&&` without parentheses, which Node's type stripper
//     rejects at load, so the server did not start at all.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "../lib/env.ts";

const PORT = Number(process.env.SMOKE_PORT ?? 4177);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "smoke@meridian.test";
const PASSWORD = "tuesday granite lamp 41";

const scratch = mkdtempSync(join(tmpdir(), "meridian-smoke-"));
const dbPath = join(scratch, "smoke.db");

let cookie = "";
let csrf = "";
let failures = 0;

function log(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(50)} ${detail}`);
}

interface Reply {
  status: number;
  json: Record<string, unknown> | null;
  headers: Headers;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  options: { omitCsrf?: boolean } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== "GET" && !options.omitCsrf) headers["x-meridian-csrf"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(BASE + path, {
    method,
    headers,
    redirect: "manual",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair.startsWith("meridian_session=")) cookie = pair;
  }

  let json: Record<string, unknown> | null = null;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, headers: res.headers };
}

function pick<T>(obj: unknown, path: string): T | undefined {
  let cursor: unknown = obj;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor as T;
}

async function waitForServer(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/auth/me`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start within 15 seconds");
}

let server: ChildProcess | null = null;

try {
  const childEnv = {
    ...process.env,
    MERIDIAN_DB_OVERRIDE: dbPath,
    PORT: String(PORT),
    // Never let a smoke run bill the API or depend on the network.
    ANTHROPIC_API_KEY: "",
  };

  // Seed an account.
  const init = spawn(
    process.execPath,
    [resolve(ROOT, "src/scripts/init-db.ts"), "--email", EMAIL, "--name", "Smoke", "--password", PASSWORD],
    { env: childEnv, stdio: "ignore" },
  );
  await new Promise<void>((res, rej) => {
    init.on("exit", (code) => (code === 0 ? res() : rej(new Error(`init exited ${code}`))));
    init.on("error", rej);
  });

  server = spawn(process.execPath, [resolve(ROOT, "src/server.ts")], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverStderr = "";
  server.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  server.on("exit", (code) => {
    if (code !== 0 && code !== null && serverStderr) {
      console.error(`\nserver stderr:\n${serverStderr}`);
    }
  });

  await waitForServer(server);
  console.log(`\nserver up on ${BASE}, database ${dbPath}\n`);

  // ---- access control ---------------------------------------------------

  let r = await req("GET", "/api/deals");
  log("unauthenticated read is refused", r.status === 401, `status ${r.status}`);

  r = await req("GET", "/api/auth/me");
  log("auth probe works logged out", r.status === 200 && r.json?.authenticated === false, "authenticated=false");

  r = await req("POST", "/api/auth/login", { email: EMAIL, password: "definitely-not-the-password" });
  log("a wrong password is rejected", r.status === 401, `status ${r.status}`);

  r = await req("POST", "/api/auth/login", { email: "nobody@nowhere.test", password: PASSWORD });
  log("an unknown account gives the same 401", r.status === 401, "no user enumeration");

  r = await req("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  csrf = pick<string>(r.json, "csrfToken") ?? "";
  log("login succeeds and issues a CSRF token", r.status === 200 && csrf.length > 0, `status ${r.status}`);
  log("session cookie is set", cookie.length > 0, cookie ? "set" : "NOT SET");

  r = await req("POST", "/api/deals", { name: "csrf probe" }, { omitCsrf: true });
  log("a write without the CSRF header is refused", r.status === 403, `status ${r.status}`);

  // ---- the customisable model ------------------------------------------

  r = await req("GET", "/api/models");
  const models = pick<Array<Record<string, unknown>>>(r.json, "models") ?? [];
  log("shipped models are listed", models.length >= 4, `${models.length} models`);

  const systemModel = models.find((m) => m.isSystem === true)!;
  log("shipped models are read-only", systemModel?.editable === false, `editable=${systemModel?.editable}`);

  r = await req("GET", `/api/models/${systemModel.id}`);
  const definition = pick<Record<string, unknown>>(r.json, "definition");
  const inputs = pick<unknown[]>(r.json, "definition.inputs") ?? [];
  log("a model definition is retrievable", inputs.length > 0, `${inputs.length} inputs`);

  r = await req("PUT", `/api/models/${systemModel.id}`, { definition });
  log("a shipped model cannot be overwritten", r.status === 403, `status ${r.status}`);

  r = await req("POST", `/api/models/${systemModel.id}/clone`, { name: "House model" });
  const cloneId = pick<string>(r.json, "id");
  log("cloning a shipped model works", r.status === 201 && !!cloneId, `status ${r.status}`);

  const broken = JSON.parse(JSON.stringify(definition));
  broken.lines[0].formula = "this_key_does_not_exist * 2";
  r = await req("PUT", `/api/models/${cloneId}`, { definition: broken });
  const issues = pick<unknown[]>(r.json, "detail") ?? [];
  log("a broken formula is refused at save time", r.status === 422 && issues.length > 0, `status ${r.status}`);

  r = await req("POST", "/api/models/validate", { definition: broken });
  const where = pick<string>(r.json, "issues.0.where") ?? "";
  log("validation names the offending line", r.json?.ok === false && where.startsWith("line."), `where=${where}`);

  // ---- the core loop ----------------------------------------------------

  r = await req("POST", "/api/deals", {
    name: "Smoke Test Tower",
    community: "Business Bay",
    assetType: "residential",
    market: "AE",
    depth: "quick",
  });
  const dealId = pick<string>(r.json, "deal.id")!;
  log("a deal is created with a model auto-selected", r.status === 201 && !!dealId, `status ${r.status}`);

  r = await req("PATCH", `/api/deals/${dealId}/fields`, {
    updates: [
      { key: "price", value: 1_050_000 },
      { key: "contract_rent", value: 78_000 },
      { key: "size_sqft", value: 780 },
    ],
  });
  log("reviewer corrections are applied", r.status === 200 && r.json?.applied === 3, `applied=${r.json?.applied}`);

  r = await req("POST", `/api/deals/${dealId}/underwrite`, { depth: "quick" });
  const grossYield = pick<number>(r.json, "result.values.gross_yield");
  const expected = 78_000 / 1_050_000;
  log("underwriting runs", r.status === 200, `${pick<unknown[]>(r.json, "result.lines")?.length} lines`);
  log(
    "the reviewer's figures drive the result, not defaults",
    grossYield !== undefined && Math.abs(grossYield - expected) < 1e-9,
    `gross yield ${grossYield !== undefined ? (grossYield * 100).toFixed(2) + "%" : "null"} (expected 7.43%)`,
  );

  // The commercial requirement: the proprietary logic must not reach a browser.
  const leaked = /"formula"\s*:/.test(JSON.stringify(r.json));
  log("no formula appears anywhere in the response", !leaked, leaked ? "LEAKED" : "values and labels only");

  const runId = pick<string>(r.json, "runId")!;

  r = await req("POST", `/api/deals/${dealId}/preview`, { overrides: { contract_rent: 90_000 } });
  const previewYield = pick<number>(r.json, "result.values.gross_yield");
  log(
    "an assumption change recalculates live",
    previewYield !== undefined && Math.abs(previewYield - 90_000 / 1_050_000) < 1e-9,
    `gross yield ${previewYield !== undefined ? (previewYield * 100).toFixed(2) + "%" : "null"}`,
  );

  // ---- upload and download ---------------------------------------------
  // Exercises the hand-written multipart parser and the streamed download.
  // The download path is where a second writeHead once killed the process:
  // the handler returns while the file is still piping, so `writableEnded` is
  // false and the router used to append a 204 on top of a committed response.
  {
    const csv =
      "Unit,Type,Area (sqft),Annual Rent (AED),Cheques,Ejari No\n" +
      "1204,1BR,780,78000,4,EJ-2026-004182\n" +
      "1206,1BR,past,790,82000,4,EJ-2026-004183\n";
    const boundary = "----meridiansmoke";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="rent_roll"; filename="smoke-rentroll.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;

    const res = await fetch(`${BASE}/api/deals/${dealId}/documents`, {
      method: "POST",
      headers: {
        cookie,
        "x-meridian-csrf": csrf,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const uploaded = (await res.json()) as { documents?: Array<{ id: string; kind: string }> };
    const docId = uploaded.documents?.[0]?.id;
    log("a document uploads and parses", res.status === 201 && !!docId, `status ${res.status}, kind=${uploaded.documents?.[0]?.kind}`);

    if (docId) {
      const dl = await fetch(`${BASE}/api/documents/${docId}/file`, { headers: { cookie } });
      const text = await dl.text();
      log("the document streams back intact", dl.status === 200 && text.includes("EJ-2026-004182"), `status ${dl.status}, ${text.length} bytes`);
      log(
        "a downloaded document is sandboxed",
        (dl.headers.get("content-security-policy") ?? "").includes("sandbox"),
        dl.headers.get("content-security-policy") ?? "MISSING",
      );

      const anon = await fetch(`${BASE}/api/documents/${docId}/file`);
      log("an anonymous document fetch is refused", anon.status === 401, `status ${anon.status}`);

      // The server must still be alive after all of that.
      const alive = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
      log("the server survives a streamed download", alive.status === 200, `status ${alive.status}`);
    }
  }

  r = await req("POST", `/api/runs/${runId}/narrative`, {});
  log(
    "a narrative is produced with no API key",
    r.status === 200 && typeof r.json?.headline === "string",
    `engine=${r.json?.engine}, ${pick<unknown[]>(r.json, "redFlags")?.length} flags, ${pick<unknown[]>(r.json, "ddItems")?.length} DD items`,
  );

  // ---- hardening --------------------------------------------------------

  for (const path of ["/../.env", "/..%2f.env", "/css/../../.env", "/%2e%2e/%2e%2e/.env"]) {
    const res = await fetch(BASE + path, { redirect: "manual" });
    log(`path traversal is blocked: ${path}`, res.status >= 300, `status ${res.status}`);
  }

  {
    const res = await fetch(`${BASE}/login`);
    const csp = res.headers.get("content-security-policy") ?? "";
    log(
      "the CSP forbids inline script and outside origins",
      csp.includes("script-src 'self'") && csp.includes("object-src 'none'") && csp.includes("connect-src 'self'"),
      csp ? "strict" : "MISSING",
    );
    log("clickjacking is blocked", res.headers.get("x-frame-options") === "DENY", "X-Frame-Options DENY");
  }

  r = await req("POST", "/api/auth/logout", {});
  r = await req("GET", "/api/deals");
  log("logout revokes the session server-side", r.status === 401, `status ${r.status}`);
} catch (err) {
  failures++;
  console.error("\nsmoke run failed:", err instanceof Error ? err.message : err);
} finally {
  server?.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} smoke check(s) failed.` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
