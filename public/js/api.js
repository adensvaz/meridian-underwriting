// The fetch wrapper. One place that knows about the CSRF header, the 401
// redirect and the stale-token retry, so no screen has to remember any of it.
//
// Every non-GET request carries `x-meridian-csrf`. Without it the server
// answers 403 and the action silently does nothing, which is the single most
// expensive bug this file exists to prevent.

const CSRF_HEADER = "x-meridian-csrf";

const session = {
  user: null,
  csrfToken: null,
  capabilities: { aiExtraction: false },
};

export function currentUser() {
  return session.user;
}

export function capabilities() {
  return session.capabilities;
}

export function csrfToken() {
  return session.csrfToken;
}

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function adoptSession(payload) {
  if (!payload) return;
  if (payload.user) session.user = payload.user;
  if (payload.csrfToken) session.csrfToken = payload.csrfToken;
  if (payload.capabilities) session.capabilities = payload.capabilities;
}

function clearSession() {
  session.user = null;
  session.csrfToken = null;
}

let redirecting = false;

function toLogin() {
  if (redirecting) return;
  redirecting = true;
  clearSession();
  window.location.replace("/login");
}

async function parseBody(response) {
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    const text = await response.text();
    return text ? { error: text } : null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function send(method, path, { body, form, allowAnonymous = false } = {}) {
  const headers = {};
  let payload;

  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating && session.csrfToken) headers[CSRF_HEADER] = session.csrfToken;

  const response = await fetch(path, {
    method,
    headers,
    body: payload,
    credentials: "same-origin",
    cache: "no-store",
  });

  if (response.ok) {
    const data = await parseBody(response);
    return data;
  }

  const data = await parseBody(response);
  const message = (data && data.error) || `Request failed (${response.status})`;

  if (response.status === 401 && !allowAnonymous) {
    toLogin();
    throw new ApiError(401, message, data && data.detail);
  }

  // A stale CSRF token is recoverable exactly once: refresh it from the
  // session endpoint and replay the request. A second failure is real.
  if (response.status === 403 && mutating && /stale|token/i.test(message)) {
    const refreshed = await refreshSession();
    if (refreshed && session.csrfToken) {
      const retryHeaders = { ...headers, [CSRF_HEADER]: session.csrfToken };
      const retry = await fetch(path, {
        method,
        headers: retryHeaders,
        body: form || (body !== undefined ? JSON.stringify(body) : undefined),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (retry.ok) return parseBody(retry);
      const retryData = await parseBody(retry);
      if (retry.status === 401 && !allowAnonymous) toLogin();
      throw new ApiError(
        retry.status,
        (retryData && retryData.error) || message,
        retryData && retryData.detail,
      );
    }
  }

  throw new ApiError(response.status, message, data && data.detail);
}

async function refreshSession() {
  try {
    const me = await send("GET", "/api/auth/me", { allowAnonymous: true });
    if (me && me.authenticated) {
      adoptSession(me);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export const api = {
  get: (path) => send("GET", path),
  post: (path, body) => send("POST", path, { body }),
  patch: (path, body) => send("PATCH", path, { body }),
  put: (path, body) => send("PUT", path, { body }),
  del: (path) => send("DELETE", path),
  upload: (path, formData) => send("POST", path, { form: formData }),
};

// ----------------------------------------------------------------- session --

export async function me() {
  const payload = await send("GET", "/api/auth/me", { allowAnonymous: true });
  if (payload && payload.authenticated) {
    adoptSession(payload);
    return payload;
  }
  clearSession();
  return { authenticated: false, capabilities: session.capabilities };
}

export async function login(email, password) {
  const payload = await send("POST", "/api/auth/login", {
    body: { email, password },
    allowAnonymous: true,
  });
  adoptSession(payload);
  return payload;
}

export async function logout() {
  try {
    await send("POST", "/api/auth/logout", { allowAnonymous: true });
  } finally {
    clearSession();
    window.location.replace("/login");
  }
}

export async function changePassword(current, next) {
  return send("POST", "/api/auth/change-password", { body: { current, next } });
}

/**
 * Guard for the authenticated shells. Resolves with the session or navigates to
 * the login plate and never resolves — the caller does not have to branch.
 */
export async function requireSession() {
  const payload = await me();
  if (!payload.authenticated) {
    toLogin();
    return new Promise(() => {});
  }
  return payload;
}

// ------------------------------------------------------------------- deals --

export const deals = {
  list: () => api.get("/api/deals"),
  create: (body) => api.post("/api/deals", body),
  get: (id) => api.get(`/api/deals/${encodeURIComponent(id)}`),
  update: (id, body) => api.patch(`/api/deals/${encodeURIComponent(id)}`, body),
  remove: (id) => api.del(`/api/deals/${encodeURIComponent(id)}`),

  uploadDocuments: (id, formData) =>
    api.upload(`/api/deals/${encodeURIComponent(id)}/documents`, formData),
  deleteDocument: (documentId) => api.del(`/api/documents/${encodeURIComponent(documentId)}`),

  extract: (id) => api.post(`/api/deals/${encodeURIComponent(id)}/extract`, {}),

  patchFields: (id, updates) =>
    api.patch(`/api/deals/${encodeURIComponent(id)}/fields`, { updates }),
  confirmField: (id, key) =>
    api.post(`/api/deals/${encodeURIComponent(id)}/fields/${encodeURIComponent(key)}/confirm`, {}),
  patchUnit: (id, unitId, patch) =>
    api.patch(`/api/deals/${encodeURIComponent(id)}/units/${encodeURIComponent(unitId)}`, patch),
  patchT12: (id, lineId, patch) =>
    api.patch(`/api/deals/${encodeURIComponent(id)}/t12/${encodeURIComponent(lineId)}`, patch),

  underwrite: (id, body) => api.post(`/api/deals/${encodeURIComponent(id)}/underwrite`, body),
  preview: (id, body) => api.post(`/api/deals/${encodeURIComponent(id)}/preview`, body),
};

export const runs = {
  get: (id) => api.get(`/api/runs/${encodeURIComponent(id)}`),
  narrative: (id) => api.post(`/api/runs/${encodeURIComponent(id)}/narrative`, {}),
};

// ------------------------------------------------------------------ models --

export const models = {
  list: () => api.get("/api/models"),
  get: (id) => api.get(`/api/models/${encodeURIComponent(id)}`),
  validate: (definition) => api.post("/api/models/validate", { definition }),
  save: (id, definition, note) =>
    api.put(`/api/models/${encodeURIComponent(id)}`, { definition, note }),
  clone: (id, name) => api.post(`/api/models/${encodeURIComponent(id)}/clone`, { name }),
  revisions: (id) => api.get(`/api/models/${encodeURIComponent(id)}/revisions`),
  remove: (id) => api.del(`/api/models/${encodeURIComponent(id)}`),
};
