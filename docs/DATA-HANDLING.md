# Data handling

Written to be handed to a procurement or compliance reviewer as-is. Where
something is not yet done, it says so.

## What data the system holds

| Data | Where it lives | Notes |
|---|---|---|
| Uploaded documents (OM, rent roll, T12) | `data/uploads/<dealId>/` on the application server | **Currently unencrypted at rest.** See Gaps. |
| Extracted document text, page by page | `document_segments` table | Needed so every figure can cite its source |
| Extracted figures and human corrections | `extracted_fields`, `rent_roll_units`, `t12_lines` | AI value and user value kept in separate columns |
| Underwriting runs | `underwriting_runs` | Includes a full snapshot of the model and inputs used |
| Generated narratives | `narratives` | |
| Accounts | `users` | Email, name, scrypt password hash. No other personal data. |
| Sessions | `sessions` | SHA-256 of the token only — never the token itself |
| Access log | `audit_log` | Who did what, when. No figures, no document contents. |

Everything is in one SQLite database file plus one uploads directory. There is
no external data store and no telemetry.

## What leaves the server

**Only one thing, and only if you configure it: document text and computed
underwriting output sent to Anthropic's API.**

- Set `ANTHROPIC_API_KEY` in `.env` and the extraction pass sends the extracted
  **text** of each uploaded document to the model named in `MERIDIAN_MODEL`.
  The original file is never uploaded — only text pulled out of it locally.
- The narrative pass sends the **computed underwriting output** (resolved
  inputs, calculated lines, projection, benchmark gradings, risk flags). It
  deliberately does *not* send document text.
- Leave `ANTHROPIC_API_KEY` empty and **nothing leaves the server at all.** The
  application still works end to end: extraction falls back to deterministic
  table parsing, and the narrative falls back to a rules engine driven by the
  model's own risk definitions.

Nothing else makes an outbound network request. There is no analytics, no error
reporting service, no CDN — the front end loads no third-party resource of any
kind, which the Content-Security-Policy also enforces.

## Anthropic's terms

As of writing, Anthropic's commercial terms state that inputs and outputs
submitted through the API are **not used to train its models**, and that API
inputs and outputs are retained for a limited period for trust-and-safety
purposes. **Verify the current terms and the retention window directly with
Anthropic before signing anything that depends on them** — this document is not
a substitute for their contract, and the position can change.

If your counterparties will not accept a third-party model touching their
documents, run without a key. That path is supported deliberately, not as a
degraded mode.

## Access control

- No public signup. Accounts exist only by invitation.
- Sessions are server-side; the cookie is an opaque random token. Only its hash
  is stored, so a database compromise does not yield live sessions.
- Passwords are scrypt (N=2^15, r=8, p=1) with a per-hash salt.
- Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `NODE_ENV=production`.
- CSRF tokens are required on every state-changing request.
- Login attempts are throttled by email and by IP.
- Every user-scoped query is ownership-scoped in the data layer, not in route
  handlers. `npm run check` includes a test that a second firm cannot read or
  write the first firm's deals, documents, fields, rent roll, T12 or runs —
  including by guessing an id directly.
- Documents are streamed through an authenticated route with
  `Content-Security-Policy: default-src 'none'; sandbox`, never served from a
  static path.

## Deletion

Deleting a deal deletes its database rows **and unlinks its uploaded files from
disk**. It does not currently overwrite the file blocks, so on a shared or
cloud-hosted filesystem, treat deletion as logical rather than forensic.

## Gaps — the honest list

These are real and are on the backlog in `ralph/fix_plan.md`:

1. **Uploaded documents are not encrypted at rest.** Do this before real deal
   packs land on a shared host. Full-disk or volume encryption on the host is an
   acceptable interim answer; application-level encryption is the better one.
2. **No automated backup.** There is no restore procedure written down yet.
3. **No key rotation procedure** for `SESSION_SECRET`. Rotating it today signs
   everyone out, which is safe but abrupt.
4. **Audit log is not tamper-evident.** It is an ordinary table, so anyone with
   database access can edit it.
5. **Extraction accuracy is unmeasured.** No accuracy claim should be made until
   the ground-truth harness exists.

## Deployment posture

Run behind TLS with `NODE_ENV=production`. Set `SESSION_SECRET` explicitly. Set
`TRUST_PROXY=1` **only** behind a proxy you control — otherwise a client can
spoof `X-Forwarded-For` and defeat the login throttle. The development server
does not set `Secure` on cookies and must not be exposed publicly.
