# Meridian

AI-powered commercial real estate deal underwriting, built for the Dubai / UAE
market.

Upload an Offering Memorandum, a rent roll and a T12. The system reads them,
extracts the underwriting inputs with a source citation and an honest confidence
for every figure, populates a **customisable** underwriting model, lets you
correct anything the machine got wrong, computes the return analysis, and writes
the investment committee memo — strengths, red flags and due-diligence
questions.

Runs on plain Node. **No build step, no framework, no database server.** Node
22.6+ executes the TypeScript directly and persistence is `node:sqlite`.

---

## Quick start

```bash
npm install
cp .env.example .env
npm run init -- --email you@yourfirm.ae --name "Your Name"
npm run seed
npm run serve
```

Then open <http://localhost:4100>. `npm run init` prints a generated password
once — save it.

An `ANTHROPIC_API_KEY` in `.env` switches on AI extraction and the AI-written
narrative. **Without a key the application still runs end to end** — this is
what lets a firm evaluate the tool, or run it permanently, without sending
confidential documents to a third party:

- **Extraction** falls back to a deterministic extractor
  ([`src/lib/ai/fallback.ts`](src/lib/ai/fallback.ts)). It reads structured
  tables properly — rent-roll columns are classified and mapped, totals rows are
  skipped, cheque counts and Ejari numbers are captured, sq m is converted to
  sq ft, and T12 lines are categorised into the normalised buckets with
  non-recurring items (special levies, legal settlements, capital works booked
  as repairs) excluded from NOI *with a stated reason*. It reads prose badly on
  purpose: only explicitly labelled figures are taken from an OM, because a
  Dubai broker teaser puts four large numbers on one page and guessing wrong is
  worse than reporting nothing. Confidence is capped at 0.75 so the review
  screen shows the difference honestly.
- **The narrative** falls back to a rules engine driven by the model's own flag
  and benchmark definitions.

`npm run check` includes a test that proves the no-key path actually extracts:
three tenancies and nine statement lines out of real CSVs, with the two
non-recurring items correctly excluded.

---

## Commands

| Command | What it does |
|---|---|
| `npm run init` | Create the database, install the shipped models, create the first account |
| `npm run seed` | Load six fictional Dubai deals with documents, extractions and runs |
| `npm run check` | Acceptance harness — engine arithmetic, tenant isolation, formatting |
| `npm run smoke` | End-to-end acceptance over real HTTP — boots a server on a throwaway database and drives the API a browser drives |
| `npm run test` | Unit tests for the document parsing layer |
| `npm run serve` | The application |
| `npm run dev` | The application, restarting on change |
| `npm run reset` | Drop the database and uploaded files |

---

## The four requirements, and how each is actually met

### 1. Private logins that are a real access barrier

This was the client's stated top priority, so it is enforced structurally rather
than by convention.

Every user-scoped query lives in [`src/lib/db/repo.ts`](src/lib/db/repo.ts) and
takes an actor as its first argument. **There is no `getDeal(id)`. There is only
`getDeal(actor, id)`.** A route handler cannot forget the ownership check
because there is no unscoped function available to it to call. Changing an id in
a URL returns 404, not somebody else's deal.

- Sessions are server-side. The cookie carries an opaque 256-bit token and
  nothing else — no user id, no role, no signed claims — so stealing the cookie
  is the only impersonation path and revocation is one `UPDATE`.
- Only the SHA-256 of the session token is stored. A database dump does not hand
  over live sessions.
- Passwords are scrypt (N=2^15, r=8) with a per-hash salt.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Every state-changing request carries a CSRF token bound to the session secret.
- Login is throttled by email *and* by IP.
- There is no public signup. Accounts are created by invitation.
- Uploaded documents stream through an authenticated route and are never
  reachable from a static path.

`npm run check` includes a tenant-isolation test that creates two firms and
asserts that the second cannot read or write the first's deal, documents,
fields, rent roll, T12 or runs — including by guessing the id directly.

### 2. The underwriting logic is customisable, not hard-coded

A model is **data, not code**: a JSON document in the database describing inputs,
computed lines, a multi-year projection and return formulas.

Formulas are evaluated by a purpose-built expression language in
[`src/lib/engine/expr.ts`](src/lib/engine/expr.ts) — a real tokenizer, Pratt
parser and tree-walking evaluator over a closed grammar. No `eval`, no
`new Function`, no property access, no assignment, a whitelisted function table,
and hard caps on depth and node count. Running `eval` on database content would
be a remote code execution hole with extra steps.

This means three levels of customisation, all without a rebuild:

- **Assumptions** — vacancy, management fee, growth rates, exit yield, loan
  terms. Edit and save as your house model.
- **Structure** — add, rename or remove income and expense lines.
- **Formulas** — change how NOI itself is calculated. `noi = egi - opex` is a
  string in a database row, and you can edit it in the browser.

Models are versioned. Every save writes an immutable revision, and **every
underwriting run snapshots the full model definition and the resolved inputs it
used**, so a finished deal never silently changes because somebody edited a
template afterwards.

The models that ship with the product are read-only. You clone one to customise
it, which preserves a known-good baseline to compare against.

A model that does not validate is never saved — a broken formula fails in the
editor, next to the line that caused it, rather than three screens later.

### 3. The proprietary model is not extractable without an account

The engine runs server-side only. Stated precisely, because the loose version of
this claim is wrong:

- **Deal output never contains a formula.** Underwriting a deal returns computed
  values plus the presentation metadata needed to render them — label, unit,
  format. `npm run smoke` asserts that no `"formula"` key appears anywhere in an
  underwriting response.
- **The static bundle never contains a shipped formula.** An anonymous visitor
  can fetch `/js/*.js`, so nothing there may carry the methodology. `npm run
  check` greps every client file against all 295 formulas in the four shipped
  models and fails if any appears. This caught a real leak: a shipped formula
  had been used as placeholder text in the model editor's formula field.
- **The model editor does handle formulas**, because a user-editable engine is
  the point — but only over the authenticated API, only for a model the caller
  is entitled to read, and never baked into a file served to a logged-out
  visitor.

Nothing under `public/` imports anything from `src/`, and that too is enforced by
a test rather than by convention.

The Content-Security-Policy is `script-src 'self'; object-src 'none'; base-uri
'none'; connect-src 'self'` with no inline script permitted, so the pages cannot
be turned into an exfiltration channel either.

### 4. Scalable architecture

The seams that are expensive to add later are already in place:

- `organization_id` and `role` exist on every user-owned row. The MVP only
  issues the `owner` role, but `visibility()` in `repo.ts` is a **single
  function** — when the coaching business wants coaches to review a student's
  deals, that is one predicate to change, not an audit of every endpoint.
- The repository layer is the only thing that speaks SQL. Moving to Postgres
  means rewriting one file.
- Quick and full analysis are the same engine with a longer model definition, so
  the "start high-level, scale to detailed" requirement is a data change.
- Documents, extractions, fields, runs and narratives are separate tables with
  provenance threaded through, so re-extraction, audit and history all work
  without a schema change.

---

## Built for Dubai, not ported to it

A US underwriting model applied to a Dubai asset is wrong in ways that are not
obvious until an investment committee points them out. What the shipped models
do differently:

- **Rent is an annual lump sum paid in 1, 2, 4, 6 or 12 post-dated cheques.**
  Cheque count is a first-class input, not a payment detail — it changes cash
  timing, effective yield and collection risk.
- **Service charge (AED per sq ft per year)** is the dominant operating expense,
  billed by the Owners Association through Mollak, and it is an owner cost. A US
  model that treats operating expenses as tenant-recoverable overstates NOI by
  15–30% here.
- **There is no annual property tax.** What exists is the 4% DLD transfer fee on
  acquisition and the municipality housing fee on rent. The models have no
  property tax line, because the market has no property tax.
- **Renewal increases are capped against the RERA rental index** on a tiered
  scale — up to 10% below index permits no increase, 11–20% below permits 5%,
  and so on to 20%. The projection caps in-place rent growth at the permitted
  step rather than applying a flat 3%. A unit let far below market cannot be
  marked up in one year, and the model says so.
- **Transaction costs are ~6–7% all in** (DLD 4%, agency ~2%, trustee, NOC,
  mortgage registration, conveyancing), so net yield is computed on total capital
  deployed rather than on the purchase price.
- **VAT**: residential leases are exempt, which means input VAT is *not*
  recoverable and the 5% on service charges is a real cost. Commercial is
  standard-rated and recoverable. Driven by a `vat_treatment` input.
- **Corporate tax**: 9% above AED 375,000 for entities; a natural person holding
  property in a personal capacity is outside the scope. Driven by `owner_type`.
- **Tenure** — freehold, leasehold, usufruct or musataha — with remaining years,
  because a short leasehold tail destroys exit value.
- **Golden Visa threshold** at AED 2,000,000 is surfaced as a badge, because
  buyers in this market look for it.
- Headline metrics are the ones actually used here: **price per sq ft** first,
  then gross yield (the dominant local vernacular), net yield, DSCR, cash-on-cash
  and payback period.

Benchmark ranges in the shipped models are **indicative planning figures**
reflecting roughly 2025 market conditions. Re-baseline them against DLD, Mollak
and Property Monitor before relying on them commercially. They are assumptions in
a data file precisely so you can.

---

## How it works

```
OM / rent roll / T12
        │
        ├─ magic-byte type detection ──→ per-page and per-sheet segmentation
        │
        ├─ AI extraction ─────────────→ fields + rent-roll rows + T12 lines
        │                                each with document, page, snippet
        │                                and an honest confidence
        │
        ├─ human review ──────────────→ corrections stored separately from
        │                                the AI values, never overwritten
        │
        ├─ underwriting engine ───────→ NOI, yields, DSCR, cash-on-cash,
        │   (server-side only)           IRR, projection, benchmark grades,
        │                                deterministic risk flags
        │
        └─ narrative ─────────────────→ strengths, red flags, DD questions
```

**Type detection is by magic bytes, never by extension.** Hosts and users
routinely hand over an HTML error page or a renamed file with a `.pdf`
extension, and trusting the extension is how a stub becomes a phantom "scanned
document" full of invented numbers.

**Absent means absent.** The extraction prompt is emphatic that a figure not
present in the document must come back as null. Nulls propagate through the
formula engine — `rent - service_charge` with a missing service charge is null,
not `rent` — and render as an em dash. A confidently invented number is worse
than a blank one, because a blank is visible on the review screen and an
invention is not.

**The narrative is grounded in computed output, not in the documents.** The
model writing the memo is given the resolved inputs, every calculated line, the
projection, the benchmark gradings and the risk flags the engine already fired
deterministically — and it is *not* given the raw documents. It therefore cannot
contradict the numbers on screen, cannot quietly re-extract a figure, and cannot
invent a return the engine did not compute. Risk detection is deterministic; the
model's job is judgement and prose.

---

## Project layout

```
src/
  lib/
    engine/     expr.ts     the formula language — tokenizer, parser, evaluator
                model.ts    the runner: inputs → lines → projection → returns
                types.ts    what a model definition is
    db/         schema.sql  the schema, with the reasoning in comments
                repo.ts     ownership-scoped data access — the isolation seam
    auth/       password.ts scrypt hashing and policy
                session.ts  server-side sessions, CSRF, login throttling
    parse/      document ingestion: magic bytes, PDF, spreadsheets, docx
    ai/         extract.ts  documents → structured inputs, with provenance
                narrative.ts computed output → the IC memo, plus a rules fallback
    http/       a small router and a hand-written multipart parser
  seed/models/  the shipped underwriting models — data, not code
  routes/       the API
public/         hand-written HTML, CSS and JS. No framework, no build.
docs/DESIGN.md  the design system
ralph/          the iteration loop and its backlog
```

---

## Security notes

- `.env` is gitignored. Never commit a key.
- In development, cookies are not `Secure`. **Do not expose a development server
  publicly.** Set `NODE_ENV=production` behind TLS.
- Set `SESSION_SECRET` in production. Without it a key is generated and persisted
  to `data/.session-key`, which works but is not what you want across replicas.
- Uploaded documents are currently stored unencrypted under `data/uploads/`.
  Encryption at rest is on the backlog and should be done before real deal packs
  land on a shared host.
- `TRUST_PROXY=1` only behind a proxy you control — otherwise a client can spoof
  `X-Forwarded-For` and defeat the login throttle.

## Known limits

Stated plainly, because a buyer will find them anyway:

- Scanned and photographed documents are **detected and refused** with a clear
  message rather than being guessed at. Bilingual Arabic/English scans are the
  norm in this market, so OCR is a real gap.
- Extraction accuracy has not been measured against a ground-truth set. The
  harness for that is the top item on the backlog, and no accuracy claim should
  be made until it exists.
- Off-plan deals — staged payment plans, handover dates, escrow — are not
  modelled.
- Loan amount is an input; the engine does not yet solve for proceeds subject to
  max LTV and minimum DSCR.
- The demo data is fictional and labelled as such.
