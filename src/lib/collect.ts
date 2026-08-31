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
  /**
   * Who this document applies to. Absent means everyone.
   *
   * Two independent axes, because they genuinely are independent: a
   * self-employed non-resident needs a trade licence AND is unable to produce
   * an Emirates ID. Collapsing them into one list produced a checklist that
   * asked a non-resident for a UAE residence visa they cannot hold.
   */
  employment?: Employment[];
  residency?: Residency[];
  /**
   * Third independent axis: what is being bought. An off-plan buyer has no
   * seller and no title deed — the developer holds the title until handover and
   * the buyer holds an Oqood, the DLD's interim registration. Asking them for a
   * title deed, or for a Form F that only exists on a resale, is the same class
   * of error as asking a non-resident for an Emirates ID.
   */
  purchase?: Purchase[];
}

export type Employment = "salaried" | "self_employed";
export type Residency = "uae_national" | "expat_resident" | "non_resident";
export type Purchase = "ready" | "off_plan";

const RESIDENTS: Residency[] = ["uae_national", "expat_resident"];

/**
 * What a UAE lender actually asks a residential mortgage applicant for. This is
 * the broker's checklist, not a generic file-upload widget, and getting it right
 * is most of the value — a buyer who is told exactly what to send sends it once.
 */
export const MORTGAGE_CHECKLIST: ChecklistItem[] = [
  // ---- identity -------------------------------------------------------
  {
    key: "emirates_id",
    label: "Emirates ID",
    hint: "Both sides. A clear photo is fine.",
    kind: "identity",
    required: true,
    // A non-resident does not hold one. Asking anyway is the fastest way to
    // make a buyer think the form was not meant for them.
    residency: RESIDENTS,
  },
  {
    key: "passport_visa",
    label: "Passport and residence visa",
    hint: "The photo page and the visa page.",
    kind: "identity",
    required: true,
    residency: ["expat_resident"],
  },
  {
    key: "passport_only",
    label: "Passport",
    hint: "The photo page. A UAE visa is not needed.",
    kind: "identity",
    required: true,
    residency: ["uae_national", "non_resident"],
  },
  {
    key: "proof_of_address",
    label: "Proof of home address",
    hint: "A utility bill or bank letter from your country of residence, dated within the last three months.",
    kind: "identity",
    required: true,
    residency: ["non_resident"],
  },

  // ---- income ---------------------------------------------------------
  {
    key: "salary_certificate",
    label: "Salary certificate",
    hint: "Issued by your employer within the last month, addressed to the bank. It must state your basic salary, allowances and joining date.",
    kind: "income",
    required: true,
    employment: ["salaried"],
    residency: RESIDENTS,
  },
  {
    key: "payslips",
    label: "Last 3 payslips",
    hint: "The three most recent months.",
    kind: "income",
    required: true,
    employment: ["salaried"],
  },
  {
    key: "employment_contract",
    label: "Employment contract or employer letter",
    hint: "Confirming your role, salary and start date. A UAE bank cannot verify an overseas employer the way it can a local one, so this stands in for the salary certificate.",
    kind: "income",
    required: true,
    employment: ["salaried"],
    residency: ["non_resident"],
  },
  {
    key: "tax_returns",
    label: "Tax returns — 2 years",
    hint: "Your personal tax filing from your country of residence, or the equivalent income statement. Not needed if your country does not issue one — tell us if so.",
    kind: "income",
    required: true,
    residency: ["non_resident"],
  },
  {
    key: "trade_licence",
    label: "Trade licence",
    hint: "Valid licence plus the memorandum of association.",
    kind: "income",
    required: true,
    employment: ["self_employed"],
    residency: RESIDENTS,
  },
  {
    key: "company_registration",
    label: "Company registration",
    hint: "The incorporation certificate and ownership structure for your business, from your country of registration.",
    kind: "income",
    required: true,
    employment: ["self_employed"],
    residency: ["non_resident"],
  },
  {
    key: "audited_financials",
    label: "Audited financials — 2 years",
    hint: "Audited or accountant-certified accounts for the last two financial years.",
    kind: "income",
    required: true,
    employment: ["self_employed"],
  },

  // ---- banking --------------------------------------------------------
  {
    key: "bank_statements",
    label: "Bank statements — 6 months",
    hint: "Six months of personal account statements, stamped by the bank. Self-employed applicants should send the business account too.",
    kind: "bank_statement",
    required: true,
    residency: RESIDENTS,
  },
  {
    key: "bank_statements_overseas",
    label: "Bank statements — 6 months",
    hint: "Six months from your main account, stamped or officially issued by the bank. Statements in a language other than English or Arabic need a certified translation.",
    kind: "bank_statement",
    required: true,
    residency: ["non_resident"],
  },
  {
    key: "source_of_funds",
    label: "Source of the deposit",
    hint: "Evidence of where the deposit came from — a savings history, a property sale, a share sale or a documented gift. Every UAE bank asks a non-resident this, and it is the single most common reason a file stalls.",
    kind: "liability",
    required: true,
    residency: ["non_resident"],
  },

  // ---- existing borrowing --------------------------------------------
  {
    key: "liability_letter",
    label: "Liability letter",
    hint: "From any bank you have a loan or credit card with, showing the outstanding balance and monthly instalment. Only if you have existing borrowing.",
    kind: "liability",
    required: false,
  },
  {
    key: "credit_report",
    label: "Credit report",
    hint: "From your home country credit bureau. UAE banks cannot see an overseas credit history, so most will ask for this.",
    kind: "liability",
    required: false,
    residency: ["non_resident"],
  },
  {
    key: "credit_card_statements",
    label: "Credit card statements",
    hint: "Latest statement for each card, showing the credit limit. The limit matters even if the balance is zero.",
    kind: "liability",
    required: false,
  },

  // ---- the property ---------------------------------------------------
  //
  // A resale and an off-plan purchase produce different paper. On a resale
  // there is a seller, a Form F on the DLD portal and a title deed to inspect.
  // Off-plan there is no seller and no title deed: the contract is the
  // developer's SPA with its payment plan, and the buyer's registration is the
  // Oqood. The case already knows which it is — `is_off_plan` drives the 50%
  // LTV cap and fires its own flag — so the ask follows it rather than offering
  // both and leaving the buyer to work out which half applies to them.
  {
    key: "property_mou",
    label: "Property MOU or Form F",
    hint: "The signed sale agreement with the seller, once you have one. Not needed for a pre-approval.",
    kind: "om",
    required: false,
    purchase: ["ready"],
  },
  {
    key: "title_deed",
    label: "Title deed",
    hint: "The seller's title deed for the property you are buying.",
    kind: "om",
    required: false,
    purchase: ["ready"],
  },
  {
    key: "developer_spa",
    label: "Developer sale agreement and payment plan",
    hint: "The SPA you signed with the developer, including the instalment schedule. The bank needs to see which instalments fall due before the mortgage draws down.",
    kind: "om",
    required: false,
    purchase: ["off_plan"],
  },
  {
    key: "oqood",
    label: "Oqood certificate",
    hint: "The Dubai Land Department's interim registration for an off-plan unit, issued through the developer. There is no title deed until handover.",
    kind: "om",
    required: false,
    purchase: ["off_plan"],
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
  },
  {
    key: "rent_roll",
    label: "Rent roll / tenancy schedule",
    hint: "One row per unit with the annual rent, cheque count and lease dates. Excel is better than PDF.",
    kind: "rent_roll",
    required: true,
  },
  {
    key: "t12",
    label: "12-month collection statement",
    hint: "Income and expenses for the last twelve months.",
    kind: "t12",
    required: true,
  },
  {
    key: "service_charge_statement",
    label: "Service charge statement",
    hint: "The latest Mollak statement or Owners Association invoice, showing the rate per square foot and any arrears.",
    kind: "other",
    required: false,
  },
  {
    key: "title_deed",
    label: "Title deed",
    hint: "Confirms ownership, area and whether any mortgage is registered against the property.",
    kind: "other",
    required: false,
  },
];

export function checklistFor(kind: "mortgage" | "acquisition"): ChecklistItem[] {
  return kind === "mortgage" ? MORTGAGE_CHECKLIST : ACQUISITION_CHECKLIST;
}

/**
 * Filters a checklist to the items that actually apply to this applicant.
 *
 * Every irrelevant row is one more reason for a buyer to abandon the form, and
 * an impossible row — an Emirates ID from someone who lives in London — reads
 * as the tool not knowing who they are.
 */
export function resolveChecklist(
  kind: "mortgage" | "acquisition",
  employment: Employment = "salaried",
  keys?: string[],
  residency: Residency = "expat_resident",
  purchase: Purchase = "ready",
): ChecklistItem[] {
  const base = checklistFor(kind).filter(
    (i) =>
      (!i.employment || i.employment.includes(employment)) &&
      (!i.residency || i.residency.includes(residency)) &&
      (!i.purchase || i.purchase.includes(purchase)),
  );
  if (!keys || !keys.length) return base;
  const wanted = new Set(keys);
  return base.filter((i) => wanted.has(i.key));
}

/**
 * Reads the applicant profile off the case rather than asking for it again.
 * Falls back to the commonest combination when a case has not been filled in
 * yet, which is a salaried expat resident.
 */
export function applicantProfile(dealId: string): {
  employment: Employment;
  residency: Residency;
  purchase: Purchase;
} {
  const rows = all<{ field_key: string; ai_value: string | null; user_value: string | null }>(
    "SELECT field_key, ai_value, user_value FROM extracted_fields WHERE deal_id = ? AND field_key IN ('employment_type','applicant_type','is_off_plan')",
    dealId,
  );
  const read = (key: string): string | null => {
    const row = rows.find((r) => r.field_key === key);
    return row ? (row.user_value ?? row.ai_value) : null;
  };

  const employment = read("employment_type") === "self_employed" ? "self_employed" : "salaried";
  const applicant = read("applicant_type");
  const residency: Residency =
    applicant === "non_resident" ? "non_resident"
    : applicant === "uae_national" ? "uae_national"
    : "expat_resident";
  // Booleans round-trip through extracted_fields as strings, so this reads the
  // same set of truthy spellings the client's own parser accepts.
  const purchase: Purchase = /^(y|yes|true|1)$/i.test(read("is_off_plan") ?? "") ? "off_plan" : "ready";

  return { employment, residency, purchase };
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
    employment?: Employment;
    residency?: Residency;
    purchase?: Purchase;
    items?: string[];
    ttlDays?: number;
    baseUrl?: string;
  } = {},
): CreatedRequest | null {
  const deal = getDeal(actor, dealId);
  if (!deal) return null;

  // Default both axes from what the case already knows. A broker has already
  // told us the applicant is a non-resident on the intake form; making them
  // say it again to get the right checklist is the kind of small stupidity
  // that makes a tool feel like paperwork.
  const known = applicantProfile(deal.id);
  const checklist = resolveChecklist(
    options.kind ?? (deal.asset_type === "mortgage" ? "mortgage" : "acquisition"),
    options.employment ?? known.employment,
    options.items,
    options.residency ?? known.residency,
    options.purchase ?? known.purchase,
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

const RESIDENCY_WORDS: Record<Residency, string> = {
  uae_national: "a UAE national",
  expat_resident: "an expat resident",
  non_resident: "a non-resident",
};

/** "a non-resident, self-employed, buying off-plan" — the whole current profile. */
function describeProfile(p: {
  employment: Employment;
  residency: Residency;
  purchase: Purchase;
}): string {
  return [
    RESIDENCY_WORDS[p.residency],
    p.employment === "self_employed" ? "self-employed" : "salaried",
    p.purchase === "off_plan" ? "buying off-plan" : "buying a completed property",
  ].join(", ");
}

export function listRequests(actor: AuthenticatedUser, dealId: string) {
  if (!getDeal(actor, dealId)) return [];

  // A request freezes its checklist at creation, which is right for the buyer —
  // a list that changes under them mid-upload would be baffling. But it means a
  // link sent before the broker corrected the applicant's residency is still
  // asking a non-resident for an Emirates ID. Detect that and say so, rather
  // than letting the fixed bug walk back in through a stale link.
  const current = applicantProfile(dealId);
  const expected = new Set(
    resolveChecklist(
      "mortgage",
      current.employment,
      undefined,
      current.residency,
      current.purchase,
    ).map((i) => i.key),
  );

  return all<DocumentRequestRow>(
    "SELECT * FROM document_requests WHERE deal_id = ? ORDER BY created_at DESC",
    dealId,
  ).map((r) => {
    const issued = fromJson<string[]>(r.checklist, []);
    const impossible = issued.filter((k) => !expected.has(k));
    const missing = [...expected].filter((k) => !issued.includes(k));
    return {
    id: r.id,
    recipientName: r.recipient_name,
    reference: r.reference,
    status: r.revoked_at ? "revoked" : new Date(r.expires_at).getTime() <= Date.now() ? "expired" : r.status,
    checklist: fromJson<string[]>(r.checklist, []),
    uploadCount: r.upload_count,
    lastUploadAt: r.last_upload_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    // Set when the applicant profile changed after this link was sent. The
    // buyer is being asked for the wrong documents and the broker needs to
    // re-issue.
    stale:
      r.revoked_at || impossible.length + missing.length === 0
        ? null
        : {
            asksForImpossible: impossible.length,
            missing: missing.length,
            // Naming the CURRENT profile rather than guessing which axis moved.
            // Asserting "sent before the applicant was recorded as a
            // non-resident" when what actually changed was the off-plan flag
            // would be the same class of wrong statement this whole track is
            // for.
            note:
              impossible.length > 0
                ? `This link asks for ${impossible.length} document${impossible.length === 1 ? "" : "s"} that do not apply to ${describeProfile(current)}. The case was updated after the link was sent — revoke it and send a new one.`
                : `The case was updated after this link was sent, so it is missing ${missing.length} document${missing.length === 1 ? "" : "s"} that ${describeProfile(current)} needs to provide. Send a new one.`,
          },
    // The token is deliberately absent. It was shown once at creation and
    // cannot be recovered — the broker re-issues rather than retrieves.
    };
  });
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
