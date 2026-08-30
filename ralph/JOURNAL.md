# Journal

Append one line per Ralph iteration: date, item, outcome, evidence. Do not
rewrite earlier entries.

---

2026-08-30 — Initial build. Engine, auth, data layer, document parsing, AI
extraction and narrative, API, four shipped underwriting models, design system,
front end, six seeded demo deals.

Verified: `npm run check` 18/18 · `npm run smoke` 28/28 over real HTTP ·
`npm run test` 85/85 · all four page routes serve 200 with no server errors ·
six seeded deals compute gross yields matching hand-checked targets exactly
(7.43 / 6.36 / 5.16 / 8.61 / 8.02 / 8.45%) · 112/112 provenance snippets found
verbatim in stored document text.

Defects found and fixed during the build, recorded because each one looked like
working software from the outside:

- Prototype pollution in the formula engine: `constructor` resolved through
  `Object.prototype` and evaluated instead of being rejected. Same flaw in the
  operator table, the function table and the static MIME map. All lookups now go
  through `Object.hasOwn`.
- `pdf-parse` silently mis-parsing every small PDF. Node pools Buffers under
  4 KB into a shared 64 KB slab; pdf.js re-wraps the typed array as
  `new value.constructor(value.buffer)`, producing a view over the whole pool,
  so xref offsets landed on unrelated memory. Every small PDF would have been
  reported as "scanned". Fixed by copying into a Uint8Array that owns its buffer.
- Model input keys not matching the platform's rent-roll derivation keys, so
  uploaded figures silently fell back to model defaults — a plausible number on
  screen with no relationship to the document. Fixed with an explicit
  `derivedFrom` binding, plus coalescing total-valued inputs for the three
  models whose income inputs are rates rather than totals.
- Streaming a document file crashed the process. The router checked
  `writableEnded`, which is still false while a file pipes, so it wrote a second
  set of headers onto a committed response. Now checks `headersSent`, and both
  file streams handle their own errors.
- `??` mixed with `&&` without parentheses — rejected by Node's type stripper,
  so the server did not boot at all.
- Flag prose guessed at number format, rendering a DSCR of 0.99 as "98.8%x", and
  due-diligence text was never interpolated so it emitted a raw
  `{dscr_covenant}` placeholder into the memo.
- A shipped formula used as placeholder text in the model editor, readable from
  the static bundle without an account.
- Container queries that targeted their own container, so no panel ever
  collapsed responsively; and a spacing token that did not exist, silently
  voiding eight declarations.

Next: work the backlog in `ralph/fix_plan.md`, top item first. The extraction
accuracy harness is the top item and should stay there — no accuracy claim can
be made until it exists.

---

2026-08-30 — Round 2: Excel/CSV export, sensitivity grid, loan sizing solver,
invite flow, password reset, outbound webhooks. Built by three parallel workers
on non-overlapping files, each registering its own routes so none had to edit
`src/routes/index.ts`.

All three workers were killed mid-verification by a session limit, so their work
was verified independently afterwards rather than taken on trust. It held, with
one real defect found: the export filename sanitiser stripped only the first
run of leading dots, so `../../etc/passwd` became `.. etc passwd`. Low severity —
it is a Content-Disposition header, not a filesystem path — but fixed by
dropping any dot-only token. CRLF injection was already blocked.

2026-08-30 — Round 3: mortgage broker mode.

The product now serves two jobs. The engine needed no changes for the second,
which is the payoff of treating underwriting logic as data rather than code — a
mortgage affordability assessment is a completely different financial question
and it shipped as one new JSON model.

- `uae-mortgage-affordability`: maximum borrowing as the lower of an income
  ceiling (50% debt burden ratio, stress-tested, over the age-capped term) and a
  deposit ceiling (Central Bank LTV ladder), reporting which one binds. Credit
  card limits are charged at 5% of the LIMIT, which is the actual UAE rule and
  the thing that most often surprises a buyer. Plus total cash to complete.
  Verified: AED 45k/month, AED 2.2m first home, expat resident → deposit-bound
  at AED 1,760,000 (80% LTV), DBR 21.7%, cash to complete AED 609,070.
- Buyer document collection: a tokenised, expiring, UPLOAD-ONLY link sent to a
  buyer who has no account. Verified end to end — the buyer view returns no
  numbers at all even when the case carries real figures, an anonymous fetch of
  an uploaded file is refused 401, and the token cannot be recovered from the
  broker's own list once issued.

One self-check had to be corrected rather than the code: it required every model
to bind rent-roll derivations, which is meaningless for a mortgage model that
assesses a buyer's income rather than a property's tenants.

Gate: `npm run check` 19/19 · `npm run smoke` 28/28 · 137 unit tests · five
shipped models validate.

Backlog: 28 open, 12 closed. The loop can continue from here — `./ralph/loop.sh`
now refuses to start on a red build, verifies after every iteration, commits each
good one, and stops after two iterations that make no progress.

---

2026-08-30 — Loop hardening.

Added `npm run arch`, an architecture and code-quality gate, and wired it into
the loop ahead of the other checks. Tests catch a wrong answer; they do not
catch a right answer arrived at badly, and that kind of decay is silent,
compounds across iterations, and is how a codebase rots under automation.

It enforces: one-way dependency direction (routes → lib → db, with the engine
pure and the db layer forbidden from importing transport or the AI layer); no
circular imports; Node's type-stripping limits (no enum, namespace, decorators,
parameter properties, explicit .ts extensions); no raw SQL outside repo.ts,
which is the mechanism behind tenant isolation; no hard-coded underwriting
constants in the engine, which would regress the "logic is data" claim; no
eval; and size budgets as warnings.

It found a false positive in itself on the first run — it contains the literal
text of every pattern it looks for, so it flagged its own rule table. A linter
cannot lint its own rules; carved out with a note.

Current state: 0 errors, 10 warnings. The warnings are real signal, chiefly
`runModel()` at 278 lines and `solveLoanAmount()` at 235.

`ralph/PROMPT.md` rewritten to carry the architecture map, the invariant list,
a think-before-you-type step, a self-review-the-diff step before ticking, and
an explicit instruction to move a wrong-shaped item to the Icebox rather than
thrash on it. Packaged as a skill at `.claude/skills/ralph/SKILL.md`.

`npm test` now discovers test files rather than using a hand-maintained list
that silently stops covering new tests.

2026-08-30 — Two correctness items closed.

- Commercial occupancy rebound to a new canonical `occupancy` derivation:
  area-weighted when the rent roll carries a complete set of areas, unit-count
  otherwise. Binding straight to `occupancy_by_area` would have looked more
  precise and behaved worse — one missing area and the derivation vanishes, the
  input falls back to its default, and the screen shows a plausible number with
  no relationship to the document. Verified: 91.18% by area vs 80.00% by units
  on a five-suite floor, and a clean degrade to 80.00% when an area is missing.
- `src/lib/db/repo.test.ts` proves the guarantee that had none: a human
  correction survives re-extraction, including hand-edited rent-roll rows, and
  clearing a correction falls back to the AI value rather than to nothing. Also
  covers ownership scoping on the collection paths added in Round 3.

Gate: arch 0 errors · check 19/19 · smoke 28/28 · 142 tests.
Backlog: 26 open, 14 closed.

2026-08-30 — T12 normalisation enforced deterministically on both extraction
paths. The prompt asked the model to mark one-off items non-recurring, but a
prompt is a request, not a guarantee, and a lift-modernisation levy or a legal
settlement that slips into a stabilised NOI overstates the deal for the whole
hold. The rule now runs again in `persistPayload` regardless of which extractor
produced the line. It only ever ADDS an exclusion, so it cannot quietly
re-include something already excluded, and an uncategorised line now falls back
to the deterministic categoriser so it still reaches the right total.
Verified against seven real Dubai statement labels.
