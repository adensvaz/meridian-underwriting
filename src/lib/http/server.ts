// The HTTP plumbing: routing, request context, responses, static files and the
// security headers.
//
// No framework. A pattern-matching router over node:http is about 200 lines and
// removes an entire dependency tree from a product whose selling point includes
// "your confidential deal data lives on one server you control".

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { env } from "../env.ts";
import {
  CSRF_HEADER,
  parseCookies,
  resolveSession,
  SESSION_COOKIE,
  verifyCsrf,
  type Session,
} from "../auth/session.ts";
import type { AuthenticatedUser } from "../auth/session.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  ip: string;
  session: Session | null;
  /** Present only inside a handler declared with `auth: true`. */
  user: AuthenticatedUser;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

export interface RouteOptions {
  /** Requires a valid session. Defaults to true — opting OUT must be explicit. */
  auth?: boolean;
  /** Requires a valid CSRF token. Defaults to true for non-GET methods. */
  csrf?: boolean;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  options: RouteOptions;
}

export class HttpError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter(Boolean),
      handler,
      options,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add("GET", pattern, handler, options);
  }
  post(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add("POST", pattern, handler, options);
  }
  patch(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add("PATCH", pattern, handler, options);
  }
  put(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add("PUT", pattern, handler, options);
  }
  delete(pattern: string, handler: Handler, options?: RouteOptions) {
    return this.add("DELETE", pattern, handler, options);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);
    let methodMismatch = false;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }

    if (methodMismatch) throw new HttpError(405, "Method not allowed");
    return null;
  }
}

// ---------------------------------------------------------------- responses --

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function text(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
}

export function noContent(res: ServerResponse): void {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

// ------------------------------------------------------------------ requests --

const MAX_JSON_BYTES = 2 * 1024 * 1024;

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolvePromise, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        reject(new HttpError(413, "Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise());
    req.on("error", reject);
  });

  if (!total) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

export function clientIp(req: IncomingMessage): string {
  // Only trust a forwarding header when explicitly running behind a proxy;
  // otherwise a client can spoof it and defeat the login throttle.
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length) {
      return forwarded.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ------------------------------------------------------------------ security --

/**
 * The Content-Security-Policy is deliberately strict. The product's promise is
 * that proprietary underwriting logic cannot be extracted by someone without an
 * account; that argument only holds if the pages themselves cannot be turned
 * into an exfiltration channel. No inline script, no eval, no third-party
 * origin, and nowhere for injected content to phone home to.
 */
export function securityHeaders(isHtml: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  };

  if (isHtml) {
    headers["content-security-policy"] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  if (env.isProduction) {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

// -------------------------------------------------------------- static files --

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const root = resolve(env.publicDir);

  // Normalise first, then confirm the resolved path is still inside the public
  // directory. This is what stops `/../../.env` and its encoded variants.
  const requested = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(join(root, requested));
  if (candidate !== root && !candidate.startsWith(root + sep)) return false;

  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = extname(candidate).toLowerCase();
  const isHtml = ext === ".html";
  // Object.hasOwn: the extension comes from the request path, and a bare index
  // would resolve inherited Object.prototype keys to something truthy.
  const mime = Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : undefined;
  // Only serve types we recognise; an unknown extension under public/ is more
  // likely a mistake than a deliberate asset.
  if (!mime) return false;

  res.writeHead(200, {
    "content-type": mime,
    "content-length": stat.size,
    // HTML must revalidate so a deploy is picked up; hashed assets could be
    // cached hard, but for an MVP a short cache avoids a whole class of
    // "why am I seeing the old page" support questions.
    "cache-control": isHtml ? "no-cache" : "public, max-age=300, must-revalidate",
    "last-modified": stat.mtime.toUTCString(),
    ...securityHeaders(isHtml),
  });
  const stream = createReadStream(candidate);
  stream.on("error", (err) => {
    // statSync succeeded a moment ago, so this is a race or a permissions
    // problem. Headers are already sent; drop the socket rather than throw.
    console.error(`[static] cannot read ${candidate}`, err);
    res.destroy();
  });
  stream.pipe(res);
  return true;
}

// ------------------------------------------------------------------ dispatch --

export interface DispatchOptions {
  router: Router;
  /** Paths served without a session, e.g. the login page and its assets. */
  publicPaths?: (path: string) => boolean;
}

export async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  options: DispatchOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  try {
    const cookies = parseCookies(req.headers.cookie);
    const session = resolveSession(cookies[SESSION_COOKIE]);

    const matched = options.router.match(method, path);

    if (matched) {
      const { route, params } = matched;
      const needsAuth = route.options.auth !== false;
      const needsCsrf = route.options.csrf ?? (method !== "GET" && method !== "HEAD");

      if (needsAuth && !session) {
        throw new HttpError(401, "Sign in to continue");
      }

      if (needsCsrf) {
        if (!session) throw new HttpError(401, "Sign in to continue");
        const presented =
          (req.headers[CSRF_HEADER] as string | undefined) ?? url.searchParams.get("csrf") ?? null;
        if (!verifyCsrf(session, presented)) {
          throw new HttpError(403, "Your session token is stale — reload the page and try again");
        }
      }

      const ctx: Ctx = {
        req,
        res,
        method,
        path,
        query: url.searchParams,
        params,
        ip: clientIp(req),
        session,
        // Safe: needsAuth guarantees a session, and routes that opt out of auth
        // are written to not touch ctx.user.
        user: session?.user as AuthenticatedUser,
      };

      for (const [key, value] of Object.entries(securityHeaders(false))) {
        res.setHeader(key, value);
      }

      await route.handler(ctx);
      // headersSent, not just writableEnded: a handler that starts streaming a
      // file (document download) returns while the pipe is still running, so
      // writableEnded is false but the response is already committed. Writing a
      // 204 here would throw ERR_HTTP_HEADERS_SENT and take the process down.
      if (!res.headersSent && !res.writableEnded) noContent(res);
      return;
    }

    // Not an API route — try the filesystem.
    if (method === "GET" || method === "HEAD") {
      const filePath = path === "/" ? "/index.html" : path;
      if (serveStatic(res, filePath)) return;
    }

    if (path.startsWith("/api/")) {
      throw new HttpError(404, "No such endpoint");
    }
    throw new HttpError(404, "Not found");
  } catch (err) {
    handleError(res, err, path);
  }
}

function handleError(res: ServerResponse, err: unknown, path: string): void {
  // Once headers are out there is no way to turn a partial response into an
  // error response. Log it and drop the socket rather than throwing again from
  // inside the error handler.
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) {
      console.error(`[error] ${path} (after headers sent)`, err);
      res.destroy();
    }
    return;
  }

  if (err instanceof HttpError) {
    json(res, err.status, { error: err.message, detail: err.detail });
    return;
  }

  const named = err as { name?: string; status?: number; message?: string };
  if (named?.name === "UploadError" && typeof named.status === "number") {
    json(res, named.status, { error: named.message ?? "Upload failed" });
    return;
  }

  // Anything unrecognised is a bug. Log it in full server-side, return nothing
  // useful to the client — stack traces are a reconnaissance gift.
  console.error(`[error] ${path}`, err);
  json(res, 500, { error: "Something went wrong on our side" });
}
