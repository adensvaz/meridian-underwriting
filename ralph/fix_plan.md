# Meridian — backlog

One item per Ralph iteration. Top-most unchecked item wins unless something
blocks it. Append new work at the bottom of the relevant section; never rewrite
this file wholesale.

## Correctness and trust

- [x] Bind the commercial models' occupancy input to `occupancy_by_area` rather
      than `physical_occupancy`. The area-weighted derivation now exists in
      `deriveFromTables`, but `dubai-commercial-full` and `us-multifamily-full`
      still read the unit-count measure. On a floor of unequal suites those
      differ materially — one vacant 600 sqft suite of 6,800 across five units
      is 80% by count and 91.2% by area — and every recovery and service-charge
      line follows the area. Residential is unaffected where units are one-per-
      deal. Requires editing the two model definitions and re-running
      `npm run seed`.
- [ ] Decide whether `short_tenure_tail` at "under 30 years remaining" is the
      right threshold. The seeded Halcyon deal was given a 28-year musataha tail
      specifically so the flag fires in the demo; the market-analyst fixture
      said 42 years, which would not fire it. Either is defensible — 42 years is
      genuinely not a red flag — but the demo data and the stated fixture now
      disagree and one of them should move.

- [ ] Reconciliation panel on the Review tab: prove on screen that rent-roll unit
      rents sum to gross potential rent and that T12 opex lines sum to total
      opex. A rent roll whose rows do not foot to the stated total is the fastest
      way to lose a reader's trust, and right now nothing surfaces the mismatch.
- [x] Re-extraction must never clobber a human correction. There is a guard in (done — src/lib/db/repo.test.ts, 5 tests incl. rent-roll rows)
      `upsertAiField`, but no test proves it. Write one: extract, edit a field,
      re-extract, assert `user_value` survived and `ai_value` updated.
- [x] T12 normalisation rules are declared in the extraction prompt but not
      enforced anywhere. Add a deterministic post-pass that flags a line as
      non-recurring when its label matches a known one-off pattern (legal
      settlement, capital works booked as repairs, casualty, owner's asset
      management fee) and surfaces every exclusion on the Review tab.
- [ ] Rounding audit: confirm no displayed total is the sum of rounded parts.
      Round at presentation only.

## Extraction quality

- [ ] Exercise a FULL-depth run in the browser. The projection table, the depth
      toggle and `projectionTable()` are wired and registered for live updates,
      but every UI walkthrough so far used a quick model, which has no
      projection stage — so the multi-year table has never actually rendered on
      screen. Seed a full-depth deal and drive it.
- [ ] Render the confidence meters and source citations against real extracted
      data. They were verified against hand-seeded rows; the three-bar ink
      density and the `OM · p.14` hover have not been seen driven by an actual
      extraction run.

- [ ] Build a fixture set of realistic Dubai documents (a broker teaser PDF, an
      Excel tenancy schedule with Ejari numbers and cheque counts, a 12-month
      collection statement) and an accuracy harness that scores extraction
      against hand-written ground truth. Report field-level accuracy. Without
      this, "does the extraction work" is unfalsifiable.
- [ ] Handle a bilingual Arabic/English PDF. These are the norm in this market,
      not the exception. At minimum detect the mixed script and note it.
- [ ] Scanned-document path: currently refused with a clear message, which is
      correct. Decide whether to add OCR or to keep refusing, and write the
      decision into `docs/` either way.
- [ ] Multi-sheet workbooks where the rent roll and the T12 are tabs of the same
      file. Today they extract as one document with one guessed kind.

## Engine

- [x] Sensitivity grid: exit yield against rent growth, computed server-side via (done in Round 2 —
      the preview endpoint. Dubai buyers expect a 3x3 at minimum.
- [ ] Cheque-count sensitivity as a first-class toggle on the Underwriting tab —
      show the deal at 1, 2, 4 and 12 cheques side by side.
- [ ] Off-plan path: staged payment plan, handover date, zero income until
      handover, delay sensitivity. Currently unmodelled and it is a large slice
      of this market.
- [x] Loan sizing: solve for proceeds subject to max LTV and min DSCR rather (done in Round 2 —
      than taking the loan amount as an input.

## Product

- [x] Export: CSV and a full Excel workbook shipped in Round 2. The print IC
      pack is wired to the Print button on the deal page.
- [x] Invite flow. The schema has an `invites` table and there is no endpoint or (API done in Round 2; screen still open —
      screen. Until this exists, adding a second user needs a terminal.
- [x] Password reset. (done in Round 2)
- [ ] Deal duplication — "underwrite this again with different assumptions" is
      the most common real workflow and today it means re-uploading.

## Operations

- [ ] Encrypt uploaded documents at rest. They are confidential deal packs
      sitting in plaintext under `data/uploads/`.
- [ ] Backup and restore instructions in the README, plus a `npm run export`
      that produces a portable dump. Buyers ask how they get their data out.
- [ ] Write down, in `docs/`, exactly which third-party model processes uploaded
      documents and under what retention terms. This will be asked in
      procurement and the honest answer needs to be on paper.
- [ ] Structured request logging with a deal id, without ever logging figures or
      document contents.

## Round 2 — features and integrations

Added after the MVP shipped. Ordered by what a Dubai investment committee asks
for first.

- [x] **Excel / CSV export.** Done — 8-sheet workbook, real number formats, verified against a live deal. Multi-sheet workbook: summary,
      inputs with provenance, computed lines, projection, rent roll, T12,
      analysis, benchmarks. Real number formats, not strings, so the figures
      stay live in Excel. This is the single most requested thing by CRE
      professionals — a tool they cannot get out of is a tool they will not use.
- [x] **Sensitivity grid.** Done — presets resolve per model, cheque-count included. Two-variable table with Dubai-relevant
      presets: exit yield × rent growth, price × rent, LTV × rate, and a
      one-dimensional cheque-count sensitivity that no US-built tool would have.
- [x] **Loan sizing solver.** Done — Marisol solves DSCR-bound at AED 654,625 / 62.3% LTV. Solve the maximum facility subject to
      max LTV and minimum DSCR, and report which constraint binds — "LTV-bound
      at 75%" versus "DSCR-bound at 1.25×" tells an analyst whether more equity
      or more rent fixes the deal.
- [x] **Invite flow and password reset.** Done — 15 tests including cross-org isolation and enumeration resistance. The `invites` table has
      existed since day one and is unused; adding a second user currently needs
      a terminal.
- [x] **Outbound webhooks** (Slack / Teams / generic). Done. Fire when a
      deal clears or misses a threshold. Must never block or fail the
      underwriting request, and must not push confidential figures into a
      channel wider than the deal's owner by default.

- [x] Front end for all of the above: sensitivity grid UI with threshold
      shading, a solver panel on the Underwriting tab, an export menu, an
      invite/members screen, and an accept-invite page.
- [ ] Deal comparison — put two or three deals side by side on the metrics that
      matter. The most common real workflow after "underwrite this" is
      "and how does it compare to the other three I'm looking at".
- [ ] Deal duplication — "underwrite this again with different assumptions"
      currently means re-uploading the documents.
- [ ] Saved assumption presets — a named house model a user can apply to a new
      deal in one click, rather than editing the same six inputs every time.

## Icebox — explicitly out of scope for the MVP

- Saved deal pipeline with stages, notes and CRM (Phase 2 in the brief).
- Business-plan builder (Phase 2).
- LP/GP waterfall, preferred return and promote.
- Multiple debt tranches, mezzanine, refinance mid-hold.
- Monthly cash flows and renovation phasing.
- Arabic UI. The CSS is RTL-ready; the copy is not translated.
- Mobile layouts beyond the responsive collapse already in `layout.css`.

## Round 3 — mortgage broker mode

The platform now serves two jobs, not one: underwriting an investment, and
assessing a buyer for a mortgage. The engine needed no changes for the second —
affordability is just another model definition, which is the payoff of treating
underwriting logic as data.

- [x] **UAE mortgage affordability model.** Maximum borrowing as the lower of an
      income ceiling (50% debt burden ratio, stress-tested, over the age-capped
      term) and a deposit ceiling (Central Bank LTV ladder), reporting which one
      binds. Plus total cash to complete, which is the number every buyer asks.
- [x] **Buyer document collection.** A tokenised, expiring, upload-only link the
      broker sends to a buyer with no account. Checklist is the real UAE lender
      list — Emirates ID, salary certificate, 6 months of statements, liability
      letters — filtered by employment type.
- [x] Broker UI for collection links: create, copy, see what has arrived, revoke.
      The API and the buyer page exist; the broker-side screen does not.
- [ ] Show collection progress on the deal — which checklist items have landed
      and which are still outstanding. Right now the broker sees documents but
      not which requested item each satisfies.
- [ ] Extract from identity and income documents: Emirates ID number and expiry,
      salary and employer from a salary certificate, average balance and salary
      credits from bank statements. The extraction layer handles these already;
      the prompts and field mappings do not exist yet.
- [ ] Reminder nudges — a broker should be able to re-send a link for the items
      still missing, without re-issuing the whole request.
- [ ] Multi-bank comparison: same applicant, several lenders' LTV and rate
      policies side by side. This is what a broker actually sells.
