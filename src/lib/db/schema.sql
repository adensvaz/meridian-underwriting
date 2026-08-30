-- Meridian schema.
--
-- Design notes that matter:
--
--  * Every user-owned row carries BOTH org_id and owner_id. The MVP only ever
--    reads by owner_id, but a coaching business will want coach-reviews-student
--    within months and a nullable org column costs nothing now versus a
--    migration later. Isolation is enforced in src/lib/db/repo.ts, never in a
--    route handler, so an endpoint physically cannot forget the check.
--
--  * Money is REAL. Underwriting is a modelling exercise, not a ledger; doubles
--    carry ~15 significant digits which is far beyond the precision of any
--    assumption feeding them. Rounding happens at presentation only.
--
--  * An underwriting run snapshots BOTH the model definition and the resolved
--    inputs as JSON. A finalised deal must never silently change because
--    somebody edited a template afterwards.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  market      TEXT NOT NULL DEFAULT 'AE',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  -- 'owner' | 'analyst' | 'reviewer'. Only 'owner' is used in the MVP; the
  -- column exists so roles can be switched on without touching the schema.
  role           TEXT NOT NULL DEFAULT 'owner',
  status         TEXT NOT NULL DEFAULT 'active',   -- active | invited | disabled
  password_hash  TEXT,                             -- hex; null until invite accepted
  password_salt  TEXT,
  password_algo  TEXT NOT NULL DEFAULT 'scrypt',
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

-- Account creation is invite-only. There is deliberately no public signup.
CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'analyst',
  token_hash  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);

-- Server-side sessions. The cookie carries an opaque token; only its hash is
-- stored, so a database leak does not hand over live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_secret  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_email ON login_attempts(email, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip ON login_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     TEXT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  meta       TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at);

-- ------------------------------------------------------- underwriting model --

-- The customisable engine. `definition` is a JSON document describing inputs,
-- computed lines and their formulas — see src/lib/engine/types.ts. System
-- models (org_id NULL, is_system 1) ship with the product, are readable by
-- everyone and editable by nobody; a user clones one to customise it.
CREATE TABLE IF NOT EXISTS underwriting_models (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  market      TEXT NOT NULL DEFAULT 'AE',
  currency    TEXT NOT NULL DEFAULT 'AED',
  depth       TEXT NOT NULL DEFAULT 'full',        -- quick | full
  asset_type  TEXT NOT NULL DEFAULT 'residential',
  version     INTEGER NOT NULL DEFAULT 1,
  definition  TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,
  cloned_from TEXT REFERENCES underwriting_models(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_org ON underwriting_models(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_key
  ON underwriting_models(COALESCE(org_id, 'system'), key, version);

-- Every save of a model writes a new immutable revision. Runs reference the
-- snapshot they used, so history is reconstructible.
CREATE TABLE IF NOT EXISTS model_revisions (
  id          TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES underwriting_models(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  definition  TEXT NOT NULL,
  note        TEXT,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_model ON model_revisions(model_id, version);

-- ------------------------------------------------------------------- deals --

CREATE TABLE IF NOT EXISTS deals (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  community     TEXT,
  city          TEXT,
  country       TEXT NOT NULL DEFAULT 'AE',
  asset_type    TEXT NOT NULL DEFAULT 'residential',
  tenure        TEXT,                              -- freehold | leasehold
  market        TEXT NOT NULL DEFAULT 'AE',
  currency      TEXT NOT NULL DEFAULT 'AED',
  status        TEXT NOT NULL DEFAULT 'draft',     -- draft|extracting|review|underwritten|archived
  depth         TEXT NOT NULL DEFAULT 'quick',     -- quick | full
  model_id      TEXT REFERENCES underwriting_models(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_org ON deals(org_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  deal_id        TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'unknown',  -- om|rent_roll|t12|other|unknown
  kind_source    TEXT NOT NULL DEFAULT 'user',     -- user | detected
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  detected_type  TEXT,                             -- from magic bytes, not extension
  bytes          INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  storage_path   TEXT NOT NULL,
  page_count     INTEGER,
  sheet_count    INTEGER,
  has_text_layer INTEGER,
  is_scanned     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'uploaded', -- uploaded|parsed|failed
  error          TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_deal ON documents(deal_id);

-- Page- and sheet-level text kept so every extracted number can point back at
-- the exact place it came from. Without this the review screen cannot show
-- provenance and nobody trusts the output.
CREATE TABLE IF NOT EXISTS document_segments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  page_no     INTEGER,
  sheet_name  TEXT,
  ordinal     INTEGER NOT NULL,
  content     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_doc ON document_segments(document_id, ordinal);

CREATE TABLE IF NOT EXISTS extractions (
  id             TEXT PRIMARY KEY,
  deal_id        TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  document_id    TEXT REFERENCES documents(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  engine         TEXT NOT NULL,                    -- ai | rules
  model          TEXT,
  prompt_version TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|ok|failed
  raw            TEXT,
  error          TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extractions_deal ON extractions(deal_id, created_at DESC);

-- One row per underwriting input. ai_value and user_value are kept apart on
-- purpose: re-running extraction must never silently discard a human
-- correction, and the reviewer must be able to see what the machine said.
CREATE TABLE IF NOT EXISTS extracted_fields (
  id                 TEXT PRIMARY KEY,
  deal_id            TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_key          TEXT NOT NULL,
  ai_value           TEXT,
  user_value         TEXT,
  unit               TEXT,
  confidence         REAL,                          -- 0..1, null when user-entered
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_page        INTEGER,
  source_sheet       TEXT,
  source_snippet     TEXT,
  status             TEXT NOT NULL DEFAULT 'extracted', -- extracted|edited|confirmed|missing
  note               TEXT,
  updated_at         TEXT NOT NULL,
  updated_by         TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fields_deal_key ON extracted_fields(deal_id, field_key);

CREATE TABLE IF NOT EXISTS rent_roll_units (
  id                 TEXT PRIMARY KEY,
  deal_id            TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,
  unit_no            TEXT,
  unit_type          TEXT,
  beds               REAL,
  baths              REAL,
  area_sqft          REAL,
  in_place_rent      REAL,      -- annual, contract currency
  market_rent        REAL,      -- annual
  cheques            INTEGER,   -- Dubai: number of instalments per year
  lease_start        TEXT,
  lease_end          TEXT,
  occupancy_status   TEXT,      -- occupied | vacant | notice
  ejari_no           TEXT,
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_page        INTEGER,
  source_row         INTEGER,
  confidence         REAL,
  edited             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_units_deal ON rent_roll_units(deal_id, ordinal);

-- T12 rows as they appear in the seller's statement, plus our normalisation.
-- Keeping raw_label lets the mapping dictionary improve without re-uploading.
CREATE TABLE IF NOT EXISTS t12_lines (
  id                 TEXT PRIMARY KEY,
  deal_id            TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,
  raw_label          TEXT NOT NULL,
  section            TEXT,          -- income | opex | below_noi | unknown
  category           TEXT,          -- normalised bucket key
  amount             REAL,          -- as stated
  months_covered     INTEGER NOT NULL DEFAULT 12,
  annualized         REAL,
  is_recurring       INTEGER NOT NULL DEFAULT 1,
  exclude_reason     TEXT,          -- why it was dropped from NOI, if it was
  source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_page        INTEGER,
  source_row         INTEGER,
  confidence         REAL,
  edited             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_t12_deal ON t12_lines(deal_id, ordinal);

-- ---------------------------------------------------------------- outputs ---

CREATE TABLE IF NOT EXISTS underwriting_runs (
  id                TEXT PRIMARY KEY,
  deal_id           TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id          TEXT REFERENCES underwriting_models(id) ON DELETE SET NULL,
  model_version     INTEGER,
  depth             TEXT NOT NULL,
  model_snapshot    TEXT NOT NULL,   -- full definition JSON as run
  inputs_snapshot   TEXT NOT NULL,   -- resolved inputs as run
  results           TEXT NOT NULL,   -- computed lines
  projection        TEXT,            -- multi-year table, full depth only
  benchmarks        TEXT,
  warnings          TEXT,
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_deal ON underwriting_runs(deal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS narratives (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES underwriting_runs(id) ON DELETE CASCADE,
  deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine      TEXT NOT NULL,      -- ai | rules
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'ok',
  headline    TEXT,
  summary     TEXT,
  strengths   TEXT,               -- JSON array
  red_flags   TEXT,               -- JSON array
  dd_items    TEXT,               -- JSON array
  raw         TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_narratives_run ON narratives(run_id);

-- ------------------------------------------------- buyer document collection --

-- A mortgage broker cannot underwrite until the buyer has handed over a stack
-- of KYC and income documents, and chasing those documents by email is the
-- single most tedious part of the job. A document request is a tokenised,
-- expiring, UPLOAD-ONLY link the broker sends to a buyer who has no account.
--
-- The security model is deliberately narrow. Holding the token lets you do
-- exactly two things: see which documents are being asked for, and add files.
-- It never permits reading a file back, listing what was already uploaded,
-- seeing any figure, or learning anything about the deal beyond a reference the
-- broker chose. Only the SHA-256 of the token is stored, so a database leak
-- does not yield working links.
CREATE TABLE IF NOT EXISTS document_requests (
  id             TEXT PRIMARY KEY,
  deal_id        TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  -- Shown to the buyer so the link does not look like a phishing attempt.
  recipient_name TEXT,
  reference      TEXT,
  message        TEXT,
  -- JSON array of required document keys, from the checklist in collect.ts.
  checklist      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',   -- open | complete | revoked | expired
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_upload_at TEXT,
  upload_count   INTEGER NOT NULL DEFAULT 0,
  revoked_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_docreq_deal ON document_requests(deal_id);
CREATE INDEX IF NOT EXISTS idx_docreq_org ON document_requests(org_id, created_at DESC);

-- Rate limiting for the public upload endpoint, keyed by IP. Without this the
-- token space is brute-forceable and the upload route is a free disk-filling
-- primitive for anyone who finds the URL.
CREATE TABLE IF NOT EXISTS collect_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collect_ip ON collect_attempts(ip, created_at);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
