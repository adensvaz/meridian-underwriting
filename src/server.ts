// Meridian server. `node src/server.ts` — no build, no bundler, no framework.

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "./lib/env.ts";
import { db } from "./lib/db/index.ts";
import { dispatch, redirect, serveStatic, HttpError } from "./lib/http/server.ts";
import { parseCookies, purgeExpiredSessions, resolveSession, SESSION_COOKIE } from "./lib/auth/session.ts";
import { router } from "./routes/index.ts";
import { installSystemModels } from "./seed/install.ts";

// Page routes. The HTML shells carry no underwriting logic — every formula runs
// on the server and the client receives computed values — so serving the shell
// to an anonymous visitor leaks nothing. The redirect is for usability, and the
// API behind it is what actually enforces access.
const PAGES: Record<string, string> = {
  "/app": "/app.html",
  "/login": "/login.html",
  "/models": "/models.html",
  "/styleguide": "/index.html",
  // The buyer-facing upload page. Public by design — the token in the URL
  // is the authorisation, and the page itself contains no deal data.
  "/collect": "/collect.html",
};

function boot(): void {
  db();
  const installed = installSystemModels();
  const purged = purgeExpiredSessions();

  console.log(`Meridian — AI deal underwriting`);
  console.log(`  database        ${env.dbPath}`);
  console.log(`  uploads         ${env.uploadDir}`);
  console.log(`  system models   ${installed} installed`);
  console.log(`  AI extraction   ${env.aiEnabled ? `enabled (${env.model})` : "disabled — no ANTHROPIC_API_KEY"}`);
  if (purged) console.log(`  sessions        purged ${purged} expired`);
  if (!env.isProduction) {
    console.log(`  mode            development (cookies are not Secure — do not expose this publicly)`);
  }
}

boot();

const server = createServer((req, res) => {
  const start = performance.now();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  res.on("finish", () => {
    // Never log query strings or bodies: this application handles confidential
    // deal data and an access log is not the place for it.
    const ms = (performance.now() - start).toFixed(0);
    if (res.statusCode >= 400 || !path.startsWith("/api/")) {
      console.log(`${req.method} ${path} ${res.statusCode} ${ms}ms`);
    }
  });

  // Page shells and the root redirect.
  if ((req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/")) {
    if (path === "/") {
      const session = resolveSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      redirect(res, session ? "/app" : "/login");
      return;
    }

    const page = PAGES[path];
    if (page) {
      if (serveStatic(res, page)) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `${page} has not been built yet.\n\nRun the front end build step, or open /styleguide to review the design system.`,
      );
      return;
    }
  }

  dispatch(req, res, { router }).catch((err) => {
    console.error("[fatal] unhandled dispatch error", err);
    if (res.headersSent || res.writableEnded) {
      // Already committed — the only thing left is to stop cleanly. Writing
      // again here is what turned a failed request into a dead process.
      if (!res.writableEnded) res.destroy();
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong on our side" }));
  });
});

server.listen(env.port, () => {
  console.log(`\n  → http://localhost:${env.port}\n`);
});

// A slow client must not hold a socket open indefinitely.
server.headersTimeout = 30_000;
server.requestTimeout = 300_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    server.close(() => process.exit(0));
    // Force exit if connections do not drain promptly.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export { server };
