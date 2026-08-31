# Meridian — logical QA backlog

Places where the product says or asks something that does not make sense for the
situation the user is in. See `ralph/QA_PROMPT.md` for the bug class and the
sweep procedure.

Almost all of these are the property flow leaking into the mortgage flow,
because the property flow was built first and every screen defaults to its
assumptions.

## Fixed

- [x] **The Documents tab asked a mortgage applicant for an Offering
      Memorandum, a rent roll and a T12** — documents that do not exist in that
      transaction. Now five slots derived from the same checklist the buyer
      sees: identity, income, bank statements, liabilities, property papers.
- [x] **The extraction line said "reconciles the rent roll against the T12"** on
      a case with neither.
- [x] **"Ask the seller for the native file"** on a scanned document, when a
      mortgage case has no seller involved in the upload.

## Open

- [ ] **`Tenure not set` in the deal header on a mortgage case.** Tenure is a
      property-title concept. Suppress the item entirely for a mortgage rather
      than printing "not set" — an empty value is not the problem, the question
      is.
- [ ] **The Review tab.** Check what it heads its sections with on a mortgage
      case. `Rent roll and T12` and the per-unit table are property concepts; a
      mortgage case has neither and should not show empty shells of them.
- [ ] **The Analysis tab and the printed IC pack.** "Investment committee" is
      the wrong frame for a mortgage assessment — a broker is producing a
      pre-approval indication for one buyer, not a committee paper. Check the
      headings, the narrative framing and the print masthead.
- [ ] **The Excel export.** The workbook is built with fixed sheets including
      `Rent roll` and `T12`. On a mortgage assessment those are empty sheets
      with property headings, and this is the artefact that gets emailed to a
      client. Sheets should follow the case type.
- [ ] **Empty states.** At least one says "Create a deal, drop in the offering
      memorandum, rent roll and T12, and run extraction" — wrong advice for half
      the product.
- [ ] **The word "deal" throughout.** A mortgage case is an applicant, not a
      deal. Check the deal list column headings, the breadcrumb, the delete
      confirmation and the page titles. Decide once whether to say "case" in
      both flows or branch the noun, and write the decision down.
- [ ] **The sensitivity presets on a mortgage model.** `exit_yield_x_rent_growth`
      and `price_x_rent` are investment sensitivities. Check what the preset
      list offers on a mortgage case and whether the unavailable ones explain
      themselves in terms a broker would recognise.
- [ ] **The Underwriting tab's depth toggle.** Quick and Full are meaningful for
      a property pro forma. Check whether they mean anything on the mortgage
      model, which is quick-only, and hide the control if they do not.
- [ ] **Benchmark language.** The mortgage model's benchmarks render with
      "Target ≤ 40.00%" under the debt burden ratio. A broker reads "target" as
      something they are aiming for; this is a regulatory ceiling. Check the
      wording across both flows.
- [ ] **Run a full sweep** per `QA_PROMPT.md` once the above are clear, covering
      every screen in both flows plus the export and the printed pack.
