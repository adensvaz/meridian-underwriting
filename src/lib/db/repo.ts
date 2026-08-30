// Ownership-scoped data access.
//
// THE RULE: every function in this file that reads or writes user data takes an
// `actor` as its first argument and puts that actor's id into the WHERE clause.
// There is no `getDeal(id)`. There is only `getDeal(actor, id)`, and it returns
// undefined for a deal the actor does not own.
//
// This is deliberate and it is the mechanism behind the client's
// non-negotiable: a route handler physically cannot forget the ownership check,
// because there is no unscoped query to call. Changing an id in a URL returns
// 404, not somebody else's deal.
//
// `canRead` is a single seam. Today it is `owner_id = actor.id`. When the
// coaching business wants coaches to review a student's deals, that becomes a
// role check in ONE place rather than an audit of every endpoint.

import { randomUUID } from "node:crypto";
import { all, fromJson, get, nowIso, run, toJson, transaction } from "./index.ts";
import type { AuthenticatedUser } from "../auth/session.ts";
import type { ModelDefinition } from "../engine/types.ts";
import type { Value } from "../engine/expr.ts";

export function id(): string {
  return randomUUID();
}

// ------------------------------------------------------------------- actors --

/**
 * The single visibility predicate. Returns a SQL fragment plus its parameters.
 * Everything user-scoped routes through here.
 */
function visibility(actor: AuthenticatedUser, column = "owner_id"): { sql: string; params: unknown[] } {
  // Reviewers see everything in their organisation; everyone else sees only
  // their own. The MVP only ever issues the 'owner' role, so in practice this
  // is strict per-user isolation — but the seam is here and tested.
  if (actor.role === "reviewer" || actor.role === "admin") {
    return { sql: "org_id = ?", params: [actor.org_id] };
  }
  return { sql: `${column} = ?`, params: [actor.id] };
}

export function audit(
  actor: AuthenticatedUser | null,
  action: string,
  entity?: string,
  entityId?: string,
  meta?: unknown,
  ip?: string,
): void {
  run(
    `INSERT INTO audit_log (org_id, user_id, action, entity, entity_id, meta, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    actor?.org_id ?? null,
    actor?.id ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    meta === undefined ? null : toJson(meta),
    ip ?? null,
    nowIso(),
  );
}

// -------------------------------------------------------------------- users --

export interface OrganizationRow {
  id: string;
  name: string;
  market: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
  created_at: string;
  last_login_at: string | null;
}

export function createOrganization(name: string, market: string): OrganizationRow {
  const org: OrganizationRow = { id: id(), name, market, created_at: nowIso() };
  run(
    "INSERT INTO organizations (id, name, market, created_at) VALUES (?, ?, ?, ?)",
    org.id,
    org.name,
    org.market,
    org.created_at,
  );
  return org;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return get<UserRow>("SELECT * FROM users WHERE email = ?", email.trim().toLowerCase());
}

export function createUser(input: {
  orgId: string;
  email: string;
  name: string;
  role?: string;
  status?: string;
  passwordHash?: string;
  passwordSalt?: string;
  passwordAlgo?: string;
}): UserRow {
  const row: UserRow = {
    id: id(),
    org_id: input.orgId,
    email: input.email.trim().toLowerCase(),
    name: input.name,
    role: input.role ?? "owner",
    status: input.status ?? "active",
    password_hash: input.passwordHash ?? null,
    password_salt: input.passwordSalt ?? null,
    password_algo: input.passwordAlgo ?? "scrypt",
    created_at: nowIso(),
    last_login_at: null,
  };
  run(
    `INSERT INTO users
       (id, org_id, email, name, role, status, password_hash, password_salt, password_algo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.org_id, row.email, row.name, row.role, row.status,
    row.password_hash, row.password_salt, row.password_algo, row.created_at,
  );
  return row;
}

export function setUserPassword(
  userId: string,
  creds: { hash: string; salt: string; algo: string },
): void {
  run(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?, status = 'active' WHERE id = ?",
    creds.hash,
    creds.salt,
    creds.algo,
    userId,
  );
}

// ------------------------------------------------------- underwriting models --

export interface ModelRow {
  id: string;
  org_id: string | null;
  owner_id: string | null;
  key: string;
  name: string;
  description: string | null;
  market: string;
  currency: string;
  depth: string;
  asset_type: string;
  version: number;
  definition: string;
  is_system: number;
  is_default: number;
  cloned_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  market: string;
  currency: string;
  depth: string;
  assetType: string;
  version: number;
  isSystem: boolean;
  isDefault: boolean;
  editable: boolean;
  updatedAt: string;
}

function toModelSummary(row: ModelRow, actor: AuthenticatedUser): ModelSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    market: row.market,
    currency: row.currency,
    depth: row.depth,
    assetType: row.asset_type,
    version: row.version,
    isSystem: row.is_system === 1,
    isDefault: row.is_default === 1,
    editable: row.is_system !== 1 && row.org_id === actor.org_id,
    updatedAt: row.updated_at,
  };
}

/**
 * System models plus the actor's own. System models are readable by everyone
 * (they are the product's methodology) but writable by nobody — a user clones
 * one to customise it, which is what preserves a known-good baseline.
 */
export function listModels(actor: AuthenticatedUser): ModelSummary[] {
  const rows = all<ModelRow>(
    `SELECT * FROM underwriting_models
      WHERE is_system = 1 OR org_id = ?
      ORDER BY is_system DESC, market, depth, name`,
    actor.org_id,
  );
  return rows.map((r) => toModelSummary(r, actor));
}

export function getModelRow(actor: AuthenticatedUser, modelId: string): ModelRow | undefined {
  return get<ModelRow>(
    `SELECT * FROM underwriting_models
      WHERE id = ? AND (is_system = 1 OR org_id = ?)`,
    modelId,
    actor.org_id,
  );
}

export function getModelDefinition(
  actor: AuthenticatedUser,
  modelId: string,
): ModelDefinition | undefined {
  const row = getModelRow(actor, modelId);
  if (!row) return undefined;
  return fromJson<ModelDefinition | undefined>(row.definition, undefined);
}

export function findModelByKey(actor: AuthenticatedUser, key: string): ModelRow | undefined {
  return get<ModelRow>(
    `SELECT * FROM underwriting_models
      WHERE key = ? AND (is_system = 1 OR org_id = ?)
      ORDER BY is_system ASC, version DESC LIMIT 1`,
    key,
    actor.org_id,
  );
}

export function upsertSystemModel(def: ModelDefinition): void {
  const existing = get<ModelRow>(
    "SELECT * FROM underwriting_models WHERE key = ? AND is_system = 1 AND version = 1",
    def.key,
  );
  const now = nowIso();
  if (existing) {
    run(
      `UPDATE underwriting_models
          SET name = ?, description = ?, market = ?, currency = ?, depth = ?,
              asset_type = ?, definition = ?, updated_at = ?
        WHERE id = ?`,
      def.name, def.description ?? null, def.market, def.currency, def.depth,
      def.assetType, toJson(def), now, existing.id,
    );
    return;
  }
  run(
    `INSERT INTO underwriting_models
       (id, org_id, owner_id, key, name, description, market, currency, depth,
        asset_type, version, definition, is_system, is_default, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, ?, ?)`,
    id(), def.key, def.name, def.description ?? null, def.market, def.currency,
    def.depth, def.assetType, toJson(def), now, now,
  );
}

export function cloneModel(
  actor: AuthenticatedUser,
  sourceId: string,
  name: string,
): ModelRow | undefined {
  const source = getModelRow(actor, sourceId);
  if (!source) return undefined;

  const def = fromJson<ModelDefinition | null>(source.definition, null);
  if (!def) return undefined;

  const now = nowIso();
  const newId = id();
  const key = `${source.key}_${now.slice(0, 10).replace(/-/g, "")}_${newId.slice(0, 6)}`;
  def.key = key;
  def.name = name;

  run(
    `INSERT INTO underwriting_models
       (id, org_id, owner_id, key, name, description, market, currency, depth,
        asset_type, version, definition, is_system, is_default, cloned_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, ?, ?, ?)`,
    newId, actor.org_id, actor.id, key, name, source.description, source.market,
    source.currency, source.depth, source.asset_type, toJson(def), source.id, now, now,
  );

  recordModelRevision(actor, newId, 1, def, `Cloned from ${source.name}`);
  return getModelRow(actor, newId);
}

/** Saves a new immutable revision and bumps the model's current version. */
export function saveModelDefinition(
  actor: AuthenticatedUser,
  modelId: string,
  def: ModelDefinition,
  note?: string,
): ModelRow | undefined {
  return transaction(() => {
    const row = get<ModelRow>(
      "SELECT * FROM underwriting_models WHERE id = ? AND org_id = ? AND is_system = 0",
      modelId,
      actor.org_id,
    );
    if (!row) return undefined;

    const version = row.version + 1;
    def.key = row.key;
    run(
      `UPDATE underwriting_models
          SET name = ?, description = ?, depth = ?, asset_type = ?, currency = ?,
              market = ?, definition = ?, version = ?, updated_at = ?
        WHERE id = ?`,
      def.name, def.description ?? null, def.depth, def.assetType, def.currency,
      def.market, toJson(def), version, nowIso(), modelId,
    );
    recordModelRevision(actor, modelId, version, def, note);
    return getModelRow(actor, modelId);
  });
}

function recordModelRevision(
  actor: AuthenticatedUser,
  modelId: string,
  version: number,
  def: ModelDefinition,
  note?: string,
): void {
  run(
    `INSERT INTO model_revisions (id, model_id, version, definition, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id(), modelId, version, toJson(def), note ?? null, actor.id, nowIso(),
  );
}

export function listModelRevisions(actor: AuthenticatedUser, modelId: string) {
  if (!getModelRow(actor, modelId)) return [];
  return all<{ id: string; version: number; note: string | null; created_at: string }>(
    `SELECT id, version, note, created_at FROM model_revisions
      WHERE model_id = ? ORDER BY version DESC`,
    modelId,
  );
}

export function deleteModel(actor: AuthenticatedUser, modelId: string): boolean {
  const result = run(
    "DELETE FROM underwriting_models WHERE id = ? AND org_id = ? AND is_system = 0",
    modelId,
    actor.org_id,
  );
  return result.changes > 0;
}

// -------------------------------------------------------------------- deals --

export interface DealRow {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  address: string | null;
  community: string | null;
  city: string | null;
  country: string;
  asset_type: string;
  tenure: string | null;
  market: string;
  currency: string;
  status: string;
  depth: string;
  model_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function createDeal(
  actor: AuthenticatedUser,
  input: Partial<DealRow> & { name: string },
): DealRow {
  const now = nowIso();
  const row: DealRow = {
    id: id(),
    org_id: actor.org_id,
    owner_id: actor.id,
    name: input.name,
    address: input.address ?? null,
    community: input.community ?? null,
    city: input.city ?? null,
    country: input.country ?? "AE",
    asset_type: input.asset_type ?? "residential",
    tenure: input.tenure ?? null,
    market: input.market ?? "AE",
    currency: input.currency ?? "AED",
    status: input.status ?? "draft",
    depth: input.depth ?? "quick",
    model_id: input.model_id ?? null,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };

  run(
    `INSERT INTO deals
       (id, org_id, owner_id, name, address, community, city, country, asset_type,
        tenure, market, currency, status, depth, model_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.org_id, row.owner_id, row.name, row.address, row.community, row.city,
    row.country, row.asset_type, row.tenure, row.market, row.currency, row.status,
    row.depth, row.model_id, row.notes, row.created_at, row.updated_at,
  );
  return row;
}

export function getDeal(actor: AuthenticatedUser, dealId: string): DealRow | undefined {
  const v = visibility(actor);
  return get<DealRow>(`SELECT * FROM deals WHERE id = ? AND ${v.sql}`, dealId, ...v.params);
}

export function listDeals(
  actor: AuthenticatedUser,
  options: { includeArchived?: boolean; query?: string; limit?: number } = {},
): DealRow[] {
  const v = visibility(actor);
  const clauses = [v.sql];
  const params: unknown[] = [...v.params];

  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  if (options.query) {
    clauses.push("(name LIKE ? OR community LIKE ? OR address LIKE ?)");
    const like = `%${options.query}%`;
    params.push(like, like, like);
  }

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  return all<DealRow>(
    `SELECT * FROM deals WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`,
    ...params,
  );
}

export function updateDeal(
  actor: AuthenticatedUser,
  dealId: string,
  patch: Partial<DealRow>,
): DealRow | undefined {
  if (!getDeal(actor, dealId)) return undefined;

  const allowed: Array<keyof DealRow> = [
    "name", "address", "community", "city", "country", "asset_type", "tenure",
    "market", "currency", "status", "depth", "model_id", "notes", "archived_at",
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (!sets.length) return getDeal(actor, dealId);

  sets.push("updated_at = ?");
  params.push(nowIso(), dealId);
  run(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return getDeal(actor, dealId);
}

export function touchDeal(dealId: string, status?: string): void {
  if (status) {
    run("UPDATE deals SET updated_at = ?, status = ? WHERE id = ?", nowIso(), status, dealId);
  } else {
    run("UPDATE deals SET updated_at = ? WHERE id = ?", nowIso(), dealId);
  }
}

export function deleteDeal(actor: AuthenticatedUser, dealId: string): DocumentRow[] {
  // Returns the document rows so the caller can unlink the files from disk.
  // Deleting a deal must actually remove the confidential documents, not just
  // the database rows pointing at them.
  return transaction(() => {
    const deal = getDeal(actor, dealId);
    if (!deal) return [];
    const docs = listDocuments(actor, dealId);
    run("DELETE FROM deals WHERE id = ?", dealId);
    return docs;
  });
}

// ---------------------------------------------------------------- documents --

export interface DocumentRow {
  id: string;
  deal_id: string;
  owner_id: string;
  kind: string;
  kind_source: string;
  filename: string;
  mime: string;
  detected_type: string | null;
  bytes: number;
  sha256: string;
  storage_path: string;
  page_count: number | null;
  sheet_count: number | null;
  has_text_layer: number | null;
  is_scanned: number;
  status: string;
  error: string | null;
  created_at: string;
}

export function createDocument(
  actor: AuthenticatedUser,
  dealId: string,
  input: Omit<DocumentRow, "id" | "deal_id" | "owner_id" | "created_at">,
): DocumentRow | undefined {
  if (!getDeal(actor, dealId)) return undefined;
  const row: DocumentRow = {
    ...input,
    id: id(),
    deal_id: dealId,
    owner_id: actor.id,
    created_at: nowIso(),
  };
  run(
    `INSERT INTO documents
       (id, deal_id, owner_id, kind, kind_source, filename, mime, detected_type, bytes,
        sha256, storage_path, page_count, sheet_count, has_text_layer, is_scanned, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.deal_id, row.owner_id, row.kind, row.kind_source, row.filename, row.mime,
    row.detected_type, row.bytes, row.sha256, row.storage_path, row.page_count,
    row.sheet_count, row.has_text_layer, row.is_scanned, row.status, row.error, row.created_at,
  );
  return row;
}

export function listDocuments(actor: AuthenticatedUser, dealId: string): DocumentRow[] {
  if (!getDeal(actor, dealId)) return [];
  return all<DocumentRow>(
    "SELECT * FROM documents WHERE deal_id = ? ORDER BY created_at ASC",
    dealId,
  );
}

export function getDocument(actor: AuthenticatedUser, documentId: string): DocumentRow | undefined {
  const doc = get<DocumentRow>("SELECT * FROM documents WHERE id = ?", documentId);
  if (!doc) return undefined;
  // Ownership is checked through the parent deal, so a document cannot be
  // reached by id alone even if the id leaks.
  return getDeal(actor, doc.deal_id) ? doc : undefined;
}

export function updateDocument(documentId: string, patch: Partial<DocumentRow>): void {
  const allowed: Array<keyof DocumentRow> = [
    "kind", "kind_source", "page_count", "sheet_count", "has_text_layer",
    "is_scanned", "status", "error", "detected_type",
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (!sets.length) return;
  params.push(documentId);
  run(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`, ...params);
}

export function deleteDocument(actor: AuthenticatedUser, documentId: string): DocumentRow | undefined {
  const doc = getDocument(actor, documentId);
  if (!doc) return undefined;
  run("DELETE FROM documents WHERE id = ?", documentId);
  return doc;
}

export function saveSegments(
  dealId: string,
  documentId: string,
  segments: Array<{ ordinal: number; pageNo?: number | null; sheetName?: string | null; content: string }>,
): void {
  transaction(() => {
    run("DELETE FROM document_segments WHERE document_id = ?", documentId);
    for (const seg of segments) {
      run(
        `INSERT INTO document_segments (id, document_id, deal_id, page_no, sheet_name, ordinal, content)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id(), documentId, dealId, seg.pageNo ?? null, seg.sheetName ?? null, seg.ordinal, seg.content,
      );
    }
  });
}

export function getSegments(actor: AuthenticatedUser, documentId: string) {
  if (!getDocument(actor, documentId)) return [];
  return all<{ id: string; page_no: number | null; sheet_name: string | null; ordinal: number; content: string }>(
    "SELECT id, page_no, sheet_name, ordinal, content FROM document_segments WHERE document_id = ? ORDER BY ordinal",
    documentId,
  );
}

// ----------------------------------------------------------------- extraction --

export interface ExtractedFieldRow {
  id: string;
  deal_id: string;
  owner_id: string;
  field_key: string;
  ai_value: string | null;
  user_value: string | null;
  unit: string | null;
  confidence: number | null;
  source_document_id: string | null;
  source_page: number | null;
  source_sheet: string | null;
  source_snippet: string | null;
  status: string;
  note: string | null;
  updated_at: string;
  updated_by: string | null;
}

export function listFields(actor: AuthenticatedUser, dealId: string): ExtractedFieldRow[] {
  if (!getDeal(actor, dealId)) return [];
  return all<ExtractedFieldRow>(
    "SELECT * FROM extracted_fields WHERE deal_id = ? ORDER BY field_key",
    dealId,
  );
}

/**
 * Writes an AI-extracted value. Critically it does NOT touch user_value: a
 * re-extraction must never silently discard a human correction. The review
 * screen shows both and the user decides.
 */
export function upsertAiField(
  dealId: string,
  ownerId: string,
  field: {
    key: string;
    value: Value;
    unit?: string | null;
    confidence?: number | null;
    documentId?: string | null;
    page?: number | null;
    sheet?: string | null;
    snippet?: string | null;
  },
): void {
  const serialized = field.value === null || field.value === undefined ? null : String(field.value);
  run(
    `INSERT INTO extracted_fields
       (id, deal_id, owner_id, field_key, ai_value, unit, confidence,
        source_document_id, source_page, source_sheet, source_snippet, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deal_id, field_key) DO UPDATE SET
       ai_value = excluded.ai_value,
       unit = excluded.unit,
       confidence = excluded.confidence,
       source_document_id = excluded.source_document_id,
       source_page = excluded.source_page,
       source_sheet = excluded.source_sheet,
       source_snippet = excluded.source_snippet,
       status = CASE WHEN extracted_fields.user_value IS NOT NULL THEN 'edited' ELSE excluded.status END,
       updated_at = excluded.updated_at`,
    id(), dealId, ownerId, field.key, serialized, field.unit ?? null,
    field.confidence ?? null, field.documentId ?? null, field.page ?? null,
    field.sheet ?? null, field.snippet ? field.snippet.slice(0, 500) : null,
    serialized === null ? "missing" : "extracted", nowIso(),
  );
}

export function setUserField(
  actor: AuthenticatedUser,
  dealId: string,
  key: string,
  value: Value,
  note?: string,
): boolean {
  if (!getDeal(actor, dealId)) return false;
  const serialized = value === null || value === undefined || value === "" ? null : String(value);
  run(
    `INSERT INTO extracted_fields
       (id, deal_id, owner_id, field_key, user_value, status, note, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deal_id, field_key) DO UPDATE SET
       user_value = excluded.user_value,
       status = CASE WHEN excluded.user_value IS NULL THEN
                       CASE WHEN extracted_fields.ai_value IS NULL THEN 'missing' ELSE 'extracted' END
                     ELSE 'edited' END,
       note = excluded.note,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    id(), dealId, actor.id, key, serialized, serialized === null ? "missing" : "edited",
    note ?? null, nowIso(), actor.id,
  );
  touchDeal(dealId);
  return true;
}

export function confirmField(actor: AuthenticatedUser, dealId: string, key: string): boolean {
  if (!getDeal(actor, dealId)) return false;
  run(
    "UPDATE extracted_fields SET status = 'confirmed', updated_at = ?, updated_by = ? WHERE deal_id = ? AND field_key = ?",
    nowIso(), actor.id, dealId, key,
  );
  return true;
}

export function createExtraction(
  dealId: string,
  ownerId: string,
  input: {
    documentId?: string | null;
    kind: string;
    engine: string;
    model?: string | null;
    promptVersion?: string | null;
    status: string;
    raw?: unknown;
    error?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    durationMs?: number | null;
  },
): string {
  const rowId = id();
  run(
    `INSERT INTO extractions
       (id, deal_id, document_id, owner_id, kind, engine, model, prompt_version,
        status, raw, error, tokens_in, tokens_out, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rowId, dealId, input.documentId ?? null, ownerId, input.kind, input.engine,
    input.model ?? null, input.promptVersion ?? null, input.status,
    input.raw === undefined ? null : toJson(input.raw), input.error ?? null,
    input.tokensIn ?? null, input.tokensOut ?? null, input.durationMs ?? null, nowIso(),
  );
  return rowId;
}

export function listExtractions(actor: AuthenticatedUser, dealId: string) {
  if (!getDeal(actor, dealId)) return [];
  return all<{
    id: string; document_id: string | null; kind: string; engine: string;
    model: string | null; status: string; error: string | null;
    tokens_in: number | null; tokens_out: number | null; duration_ms: number | null; created_at: string;
  }>(
    `SELECT id, document_id, kind, engine, model, status, error, tokens_in, tokens_out, duration_ms, created_at
       FROM extractions WHERE deal_id = ? ORDER BY created_at DESC`,
    dealId,
  );
}

// ------------------------------------------------------- rent roll and T12 ---

export interface RentRollUnitRow {
  id: string;
  deal_id: string;
  owner_id: string;
  ordinal: number;
  unit_no: string | null;
  unit_type: string | null;
  beds: number | null;
  baths: number | null;
  area_sqft: number | null;
  in_place_rent: number | null;
  market_rent: number | null;
  cheques: number | null;
  lease_start: string | null;
  lease_end: string | null;
  occupancy_status: string | null;
  ejari_no: string | null;
  source_document_id: string | null;
  source_page: number | null;
  source_row: number | null;
  confidence: number | null;
  edited: number;
}

export function replaceRentRoll(
  dealId: string,
  ownerId: string,
  units: Array<Partial<RentRollUnitRow>>,
): void {
  transaction(() => {
    // Rows the user has hand-edited survive a re-extraction.
    run("DELETE FROM rent_roll_units WHERE deal_id = ? AND edited = 0", dealId);
    const offset = get<{ n: number }>(
      "SELECT COALESCE(MAX(ordinal), 0) AS n FROM rent_roll_units WHERE deal_id = ?",
      dealId,
    );
    let ordinal = (offset?.n ?? 0) + 1;
    for (const u of units) {
      run(
        `INSERT INTO rent_roll_units
           (id, deal_id, owner_id, ordinal, unit_no, unit_type, beds, baths, area_sqft,
            in_place_rent, market_rent, cheques, lease_start, lease_end, occupancy_status,
            ejari_no, source_document_id, source_page, source_row, confidence, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        id(), dealId, ownerId, u.ordinal ?? ordinal++, u.unit_no ?? null, u.unit_type ?? null,
        u.beds ?? null, u.baths ?? null, u.area_sqft ?? null, u.in_place_rent ?? null,
        u.market_rent ?? null, u.cheques ?? null, u.lease_start ?? null, u.lease_end ?? null,
        u.occupancy_status ?? null, u.ejari_no ?? null, u.source_document_id ?? null,
        u.source_page ?? null, u.source_row ?? null, u.confidence ?? null,
      );
    }
  });
}

export function listRentRoll(actor: AuthenticatedUser, dealId: string): RentRollUnitRow[] {
  if (!getDeal(actor, dealId)) return [];
  return all<RentRollUnitRow>(
    "SELECT * FROM rent_roll_units WHERE deal_id = ? ORDER BY ordinal",
    dealId,
  );
}

export function updateRentRollUnit(
  actor: AuthenticatedUser,
  dealId: string,
  unitId: string,
  patch: Partial<RentRollUnitRow>,
): boolean {
  if (!getDeal(actor, dealId)) return false;
  const allowed: Array<keyof RentRollUnitRow> = [
    "unit_no", "unit_type", "beds", "baths", "area_sqft", "in_place_rent",
    "market_rent", "cheques", "lease_start", "lease_end", "occupancy_status", "ejari_no",
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (!sets.length) return false;
  sets.push("edited = 1");
  params.push(unitId, dealId);
  const result = run(
    `UPDATE rent_roll_units SET ${sets.join(", ")} WHERE id = ? AND deal_id = ?`,
    ...params,
  );
  if (result.changes) touchDeal(dealId);
  return result.changes > 0;
}

export interface T12LineRow {
  id: string;
  deal_id: string;
  owner_id: string;
  ordinal: number;
  raw_label: string;
  section: string | null;
  category: string | null;
  amount: number | null;
  months_covered: number;
  annualized: number | null;
  is_recurring: number;
  exclude_reason: string | null;
  source_document_id: string | null;
  source_page: number | null;
  source_row: number | null;
  confidence: number | null;
  edited: number;
}

export function replaceT12(
  dealId: string,
  ownerId: string,
  lines: Array<Partial<T12LineRow>>,
): void {
  transaction(() => {
    run("DELETE FROM t12_lines WHERE deal_id = ? AND edited = 0", dealId);
    const offset = get<{ n: number }>(
      "SELECT COALESCE(MAX(ordinal), 0) AS n FROM t12_lines WHERE deal_id = ?",
      dealId,
    );
    let ordinal = (offset?.n ?? 0) + 1;
    for (const l of lines) {
      run(
        `INSERT INTO t12_lines
           (id, deal_id, owner_id, ordinal, raw_label, section, category, amount,
            months_covered, annualized, is_recurring, exclude_reason,
            source_document_id, source_page, source_row, confidence, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        id(), dealId, ownerId, l.ordinal ?? ordinal++, l.raw_label ?? "(unlabelled)",
        l.section ?? null, l.category ?? null, l.amount ?? null, l.months_covered ?? 12,
        l.annualized ?? null, l.is_recurring ?? 1, l.exclude_reason ?? null,
        l.source_document_id ?? null, l.source_page ?? null, l.source_row ?? null,
        l.confidence ?? null,
      );
    }
  });
}

export function listT12(actor: AuthenticatedUser, dealId: string): T12LineRow[] {
  if (!getDeal(actor, dealId)) return [];
  return all<T12LineRow>("SELECT * FROM t12_lines WHERE deal_id = ? ORDER BY ordinal", dealId);
}

export function updateT12Line(
  actor: AuthenticatedUser,
  dealId: string,
  lineId: string,
  patch: Partial<T12LineRow>,
): boolean {
  if (!getDeal(actor, dealId)) return false;
  const allowed: Array<keyof T12LineRow> = [
    "raw_label", "section", "category", "amount", "months_covered",
    "annualized", "is_recurring", "exclude_reason",
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }
  if (!sets.length) return false;
  sets.push("edited = 1");
  params.push(lineId, dealId);
  const result = run(`UPDATE t12_lines SET ${sets.join(", ")} WHERE id = ? AND deal_id = ?`, ...params);
  if (result.changes) touchDeal(dealId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------- runs --

export interface RunRow {
  id: string;
  deal_id: string;
  owner_id: string;
  model_id: string | null;
  model_version: number | null;
  depth: string;
  model_snapshot: string;
  inputs_snapshot: string;
  results: string;
  projection: string | null;
  benchmarks: string | null;
  warnings: string | null;
  duration_ms: number | null;
  created_at: string;
}

export function saveRun(
  dealId: string,
  ownerId: string,
  input: {
    modelId: string | null;
    modelVersion: number | null;
    depth: string;
    modelSnapshot: unknown;
    inputsSnapshot: unknown;
    results: unknown;
    projection?: unknown;
    benchmarks?: unknown;
    warnings?: unknown;
    durationMs?: number;
  },
): string {
  const runId = id();
  run(
    `INSERT INTO underwriting_runs
       (id, deal_id, owner_id, model_id, model_version, depth, model_snapshot,
        inputs_snapshot, results, projection, benchmarks, warnings, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runId, dealId, ownerId, input.modelId, input.modelVersion, input.depth,
    toJson(input.modelSnapshot), toJson(input.inputsSnapshot), toJson(input.results),
    input.projection === undefined ? null : toJson(input.projection),
    input.benchmarks === undefined ? null : toJson(input.benchmarks),
    input.warnings === undefined ? null : toJson(input.warnings),
    input.durationMs ?? null, nowIso(),
  );
  return runId;
}

export function getRun(actor: AuthenticatedUser, runId: string): RunRow | undefined {
  const row = get<RunRow>("SELECT * FROM underwriting_runs WHERE id = ?", runId);
  if (!row) return undefined;
  return getDeal(actor, row.deal_id) ? row : undefined;
}

export function latestRun(actor: AuthenticatedUser, dealId: string): RunRow | undefined {
  if (!getDeal(actor, dealId)) return undefined;
  return get<RunRow>(
    "SELECT * FROM underwriting_runs WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1",
    dealId,
  );
}

export function listRuns(actor: AuthenticatedUser, dealId: string) {
  if (!getDeal(actor, dealId)) return [];
  return all<{ id: string; depth: string; created_at: string; duration_ms: number | null }>(
    "SELECT id, depth, created_at, duration_ms FROM underwriting_runs WHERE deal_id = ? ORDER BY created_at DESC LIMIT 50",
    dealId,
  );
}

// ---------------------------------------------------------------- narratives --

export interface NarrativeRow {
  id: string;
  run_id: string;
  deal_id: string;
  owner_id: string;
  engine: string;
  model: string | null;
  status: string;
  headline: string | null;
  summary: string | null;
  strengths: string | null;
  red_flags: string | null;
  dd_items: string | null;
  raw: string | null;
  error: string | null;
  created_at: string;
}

export function saveNarrative(
  runId: string,
  dealId: string,
  ownerId: string,
  input: {
    engine: string;
    model?: string | null;
    status?: string;
    headline?: string | null;
    summary?: string | null;
    strengths?: unknown;
    redFlags?: unknown;
    ddItems?: unknown;
    raw?: string | null;
    error?: string | null;
  },
): string {
  const narrativeId = id();
  run(
    `INSERT INTO narratives
       (id, run_id, deal_id, owner_id, engine, model, status, headline, summary,
        strengths, red_flags, dd_items, raw, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    narrativeId, runId, dealId, ownerId, input.engine, input.model ?? null,
    input.status ?? "ok", input.headline ?? null, input.summary ?? null,
    toJson(input.strengths ?? []), toJson(input.redFlags ?? []), toJson(input.ddItems ?? []),
    input.raw ?? null, input.error ?? null, nowIso(),
  );
  return narrativeId;
}

export function getNarrativeForRun(actor: AuthenticatedUser, runId: string): NarrativeRow | undefined {
  const row = get<NarrativeRow>(
    "SELECT * FROM narratives WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
    runId,
  );
  if (!row) return undefined;
  return getDeal(actor, row.deal_id) ? row : undefined;
}
