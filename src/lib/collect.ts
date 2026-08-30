// Buyer document collection.
//
// The problem this solves is not technical. A Dubai mortgage broker spends more
// time chasing a buyer for a salary certificate and six months of bank
// statements than doing any actual underwriting, and those documents arrive as
// WhatsApp photographs across four days with no way to tell what is still
// missing. This turns that into one link with a checklist that ticks itself off.
//
// THE SECURITY MODEL, stated plainly, because a public upload endpoint attached
// to confidential deal data deserves it:
//
//   Holding a token lets you do exactly two things — see which documents are
//   being requested, and add files. It does NOT let you read a file back, list
//   what has already been uploaded, see any figure, or learn anything about the
//   deal beyond a reference the broker typed. Only the token's SHA-256 is
//   stored. Links expire. Uploads are rate-limited by IP.
//
// The buyer never gets an account, and never needs one.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { all, fromJson, get, nowIso, run, toJson } from "./db/index.ts";
import { audit, getDeal, id, type DealRow } from "./db/repo.ts";
import type { AuthenticatedUser } from "./auth/session.ts";

export interface ChecklistItem {
  key: string;
  label: string;
  /** What the buyer sees under the label. Written for a person, not a lender. */
  hint: string;
  /** Maps onto the document `kind` column when the file lands. */
  kind: string;
  required: boolean;
  /** Only shown when the condition applies, e.g. self-employed applicants. */
  appliesWhen?: "salaried" | "self_employed" | "always";
}

/**
 * What a UAE lender actually asks a residential mortgage applicant for. This is
 * the broker's checklist, not a generic file-upload widget, and getting it right
 * is most of the value — a buyer who is told exactly what to send sends it once.
 */
export const MORTGAGE_CHECKLIST: ChecklistItem[] = [
  {
    key: "emirates_id",
    label: "Emirates ID",
    hint: "Both sides. A clear photo is fine.",
    kind: "identity",
    required: true,
    appliesWhen: "always",
  },
  {
    key: "passport_visa",
    label: "Passport and residence visa",
    hint: "The photo page and the visa page. Non-residents: passport only.",
    kind: "identity",
    required: true,
    appliesWhen: "always",
  },
  {
    key: "salary_certificate",
    label: "Salary certificate",
    hint: "Issued by your employer within the last month, addressed to the bank. It must state your basic salary, allowances and joining date.",
    kind: "income",
    required: true,
    appliesWhen: "salaried",
  },
  {
    key: "payslips",
    label: "Last 3 payslips",
    hint: "The three most recent months.",
    kind: "income",
    required: true,
    appliesWhen: "salaried",
  },
  {
    key: "trade_licence",
    label: "Trade licence",
    hint: "Valid licence plus the memorandum of association.",
    kind: "income",
    required: true,
    appliesWhen: "self_employed",
  },
  {
    key: "audited_financials",
    label: "Audited financials — 2 years",
    hint: "Audited or accountant-certified accounts for the last two financial years.",
    kind: "income",
    required: true,
    appliesWhen: "self_employed",
  },
  {
    key: "bank_statements",
    label: "Bank statements — 6 months",
    hint: "Six months of personal account statements, stamped by the bank. Self-employed applicants should send the business account too.",
    kind: "bank_statement",
    required: true,
    appliesWhen: "always",
  },
  {
    key: "liability_letter",
    label: "Liability letter",
    hint: "From any bank you have a loan or credit card with, showing the outstanding balance and monthly instalment. Only if you have existing borrowing.",
    kind: "liability",
    required: false,
    appliesWhen: "always",
  },
  {
    key: "credit_card_statements",
    label: "Credit card statements",
    hint: "Latest statement for each card, showing the credit limit. The limit matters even if the balance is zero.",
    kind: "liability",
    required: false,
    appliesWhen: "always",
  },
  {
    key: "property_mou",
    label: "Property MOU or Form F",
    hint: "The signed sale agreement, once you have one. Not needed for a pre-approval.",
    kind: "om",
    required: false,
    appliesWhen: "always",
  },
  {
    key: "title_deed",
    label: "Title deed or Oqood",
    hint: "The seller's title deed, or the Oqood certificate for an off-plan property.",
    kind: "om",
    required: false,
    appliesWhen: "always",
  },
];

/** The investment-side equivalent, for an acquisition rather than a mortgage. */
export const ACQUISITION_CHECKLIST: ChecklistItem[] = [
  {
    key: "om",
    label: "Offering Memorandum or brochure",
    hint: "The marketing pack from the seller or broker.",
    kind: "om",
    required: true,
    appliesWhen: "always",
  },
  {
    key: "rent_roll",
    label: "Rent roll / tenancy schedule",
    hint: "One row per unit with the annual rent, cheque count and lease dates. Excel is better than PDF.",
    kind: "rent_roll",
    required: true,
    appliesWhen: "always",
  },
  {
    key: "t12",
    label: "12-month collection statement",
    hint: "Income and expenses for the last twelve months.",
    kind: "t12",
    required: true,
    appliesWhen: "always",
  },
  {
    key: "service_charge_statement",
    label: "Service charge statement",
    hint: "The latest Mollak statement or Owners Association invoice, showing the rate per square foot and any arrears.",
    kind: "other",
    required: false,
    appliesWhen: "always",
  },
  {
    key: "title_deed",
    label: "Title deed",
    hint: "Confirms ownership, area and whether any mortgage is registered against the property.",
    kind: "other",
    required: false,
    appliesWhen: "always",
  },
];

export function checklistFor(kind: "mortgage" | "acquisition"): ChecklistItem[] {
  return kind === "mortgage" ? MORTGAGE_CHECKLIST : ACQUISITION_CHECKLIST;
}

/**
 * Filters a checklist to the items that apply. A salaried applicant should not
 * be asked for a trade licence — every irrelevant row is one more reason for a
 * buyer to give up halfway.
 */
export function resolveChecklist(
  kind: "mortgage" | "acquisition",
  employment: "salaried" | "self_employed" = "salaried",
  keys?: string[],
): ChecklistItem[] {
  const base = checklistFor(kind).filter(
    (i) => !i.appliesWhen || i.appliesWhen === "always" || i.appliesWhen === employment,
  );
  if (!keys || !keys.length) return base;
  const wanted = new Set(keys);
  return base.filter((i) => wanted.has(i.key));
}

// ------------------------------------------------------------------ tokens --

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface DocumentRequestRow {
  id: string;
  deal_id: string;
  org_id: string;
  owner_id: string;
  token_hash: string;
  recipient_name: string | null;
  reference: string | null;
  message: string | null;
  checklist: string;
  status: string;
  expires_at: string;
  created_at: string;
  last_upload_at: string | null;
  upload_count: number;
  revoked_at: string | null;
}

export interface CreatedRequest {
  id: string;
  /** Returned exactly once. Only its hash is stored. */
  token: string;
  url: string;
  expiresAt: string;
  checklist: ChecklistItem[];
}

export function createDocumentRequest(
  actor: AuthenticatedUser,
  dealId: string,
  options: {
    recipientName?: string;
    reference?: string;
    message?: string;
    kind?: "mortgage" | "acquisition";
    employment?: "salaried" | "self_employed";
    items?: string[];
    ttlDays?: number;
    baseUrl?: string;
  } = {},
): CreatedRequest | null {
  const deal = getDeal(actor, dealId);
  if (!deal) return null;

  const checklist = resolveChecklist(
    options.kind ?? "mortgage",
    options.employment ?? "salaried",
    options.items,
  );

  const token = randomBytes(32).toString("base64url");
  const requestId = id();
  const ttlDays = Math.min(Math.max(options.ttlDays ?? 14, 1), 90);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  run(
    `INSERT INTO document_requests
       (id, deal_id, org_id, owner_id, token_hash, recipient_name, reference, message,
        checklist, status, expires_at, created_at, upload_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 0)`,
    requestId,
    deal.id,
    actor.org_id,
    actor.id,
    hashToken(token),
    options.recipientName ?? null,
    options.reference ?? null,
    options.message ? String(options.message).slice(0, 500) : null,
    toJson(checklist.map((c) => c.key)),
    expiresAt,
    nowIso(),
  );

  audit(actor, "collect.request_created", "deal", deal.id, { requestId, items: checklist.length });

  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  return {
    id: requestId,
    token,
    url: `${base}/collect/${token}`,
    expiresAt,
    checklist,
  };
}

export interface ResolvedRequest {
  request: DocumentRequestRow;
  deal: DealRow;
  checklist: ChecklistItem[];
}

/**
 * Resolves a raw token. Returns null for anything not currently usable —
 * unknown, revoked, expired or already closed — without distinguishing between
 * them to the caller, so the endpoint cannot be used to probe token validity
 * beyond a single yes/no.
 */
export function resolveRequestToken(token: string | null | undefined): ResolvedRequest | null {
  if (!token || token.length < 20 || token.length > 200) return null;

  const row = get<DocumentRequestRow>(
    "SELECT * FROM document_requests WHERE token_hash = ?",
    hashToken(token),
  );
  if (!row) return null;

  // Constant-time compare on the stored hash. The lookup above is already by
  // hash, but this keeps the comparison itself off the timing channel.
  const presented = Buffer.from(hashToken(token));
  const stored = Buffer.from(row.token_hash);
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  if (row.revoked_at || row.status === "revoked") return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    run("UPDATE document_requests SET status = 'expired' WHERE id = ?", row.id);
    return null;
  }

  const deal = get<DealRow>("SELECT * FROM deals WHERE id = ?", row.deal_id);
  if (!deal) return null;

  const keys = fromJson<string[]>(row.checklist, []);
  const all = [...MORTGAGE_CHECKLIST, ...ACQUISITION_CHECKLIST];
  const checklist = keys
    .map((k) => all.find((i) => i.key === k))
    .filter((i): i is ChecklistItem => Boolean(i));

  return { request: row, deal, checklist };
}

export function recordUpload(requestId: string, count: number): void {
  run(
    "UPDATE document_requests SET upload_count = upload_count + ?, last_upload_at = ? WHERE id = ?",
    count,
    nowIso(),
    requestId,
  );
}

export function listRequests(actor: AuthenticatedUser, dealId: string) {
  if (!getDeal(actor, dealId)) return [];
  return all<DocumentRequestRow>(
    "SELECT * FROM document_requests WHERE deal_id = ? ORDER BY created_at DESC",
    dealId,
  ).map((r) => ({
    id: r.id,
    recipientName: r.recipient_name,
    reference: r.reference,
    status: r.revoked_at ? "revoked" : new Date(r.expires_at).getTime() <= Date.now() ? "expired" : r.status,
    checklist: fromJson<string[]>(r.checklist, []),
    uploadCount: r.upload_count,
    lastUploadAt: r.last_upload_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    // The token is deliberately absent. It was shown once at creation and
    // cannot be recovered — the broker re-issues rather than retrieves.
  }));
}

export function revokeRequest(actor: AuthenticatedUser, dealId: string, requestId: string): boolean {
  if (!getDeal(actor, dealId)) return false;
  const result = run(
    "UPDATE document_requests SET revoked_at = ?, status = 'revoked' WHERE id = ? AND deal_id = ? AND org_id = ?",
    nowIso(),
    requestId,
    dealId,
    actor.org_id,
  );
  if (result.changes) audit(actor, "collect.request_revoked", "deal", dealId, { requestId });
  return result.changes > 0;
}

// ------------------------------------------------------------ rate limiting --

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 40;

export function checkCollectThrottle(ip: string): { allowed: boolean; retryAfter: number } {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM collect_attempts WHERE ip = ? AND created_at > ?",
    ip,
    since,
  );
  const used = row?.n ?? 0;
  return {
    allowed: used < MAX_ATTEMPTS,
    retryAfter: Math.ceil(WINDOW_MS / 1000),
  };
}

export function recordCollectAttempt(ip: string, ok: boolean): void {
  run(
    "INSERT INTO collect_attempts (ip, ok, created_at) VALUES (?, ?, ?)",
    ip,
    ok ? 1 : 0,
    nowIso(),
  );
  run(
    "DELETE FROM collect_attempts WHERE created_at < ?",
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  );
}
