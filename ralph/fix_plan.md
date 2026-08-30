# Meridian — backlog

One item per Ralph iteration. Top-most unchecked item wins unless something
blocks it. Append new work at the bottom of the relevant section; never rewrite
this file wholesale.

## Correctness and trust

- [ ] Bind the commercial models' occupancy input to `occupancy_by_area` rather
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
- [ ] Re-extraction must never clobber a human correction. There is a guard in
      `upsertAiField`, but no test proves it. Write one: extract, edit a field,
      re-extract, assert `user_value` survived and `ai_value` updated.
- [ ] T12 normalisation rules are declared in the extraction prompt but not
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

- [ ] Sensitivity grid: exit yield against rent growth, computed server-side via
      the preview endpoint. Dubai buyers expect a 3x3 at minimum.
- [ ] Cheque-count sensitivity as a first-class toggle on the Underwriting tab —
      show the deal at 1, 2, 4 and 12 cheques side by side.
- [ ] Off-plan path: staged payment plan, handover date, zero income until
      handover, delay sensitivity. Currently unmodelled and it is a large slice
      of this market.
- [ ] Loan sizing: solve for proceeds subject to max LTV and min DSCR rather
      than taking the loan amount as an input.

## Product

- [ ] Export: a one-page IC pack as print-optimised HTML (`print.css` exists but
      nothing routes to it) and a CSV of the full underwriting.
- [ ] Invite flow. The schema has an `invites` table and there is no endpoint or
      screen. Until this exists, adding a second user needs a terminal.
- [ ] Password reset.
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

## Icebox — explicitly out of scope for the MVP

- Saved deal pipeline with stages, notes and CRM (Phase 2 in the brief).
- Business-plan builder (Phase 2).
- LP/GP waterfall, preferred return and promote.
- Multiple debt tranches, mezzanine, refinance mid-hold.
- Monthly cash flows and renovation phasing.
- Arabic UI. The CSS is RTL-ready; the copy is not translated.
- Mobile layouts beyond the responsive collapse already in `layout.css`.
