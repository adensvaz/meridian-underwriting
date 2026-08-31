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

- [x] **A non-resident was asked for an Emirates ID and a UAE residence visa** —
      two documents they cannot hold. The checklist filtered on employment only.
      It now filters on residency too, and the two axes are independent because
      a self-employed non-resident needs a trade licence *and* cannot produce an
      Emirates ID. Non-residents get passport, proof of home address, employment
      contract or company registration, tax returns, overseas bank statements,
      source of the deposit and a home-country credit report.
- [x] **The broker had to restate the applicant profile to get the right
      checklist.** It now derives from the case's own `applicant_type` and
      `employment_type`, so the link is correct with no extra input.

## Open

- [ ] **Joint applicants are not modelled at all.** Two incomes, two sets of
      identity documents, two liability positions — extremely common in Dubai
      and currently impossible to express. Decide whether to model a second
      applicant or to state the limitation on screen; silently assessing only
      one income is the worst of the three.
- [ ] **A resident buying off-plan is not asked for the Oqood.** The property
      slot mentions it, but the checklist item is generic. Off-plan changes the
      LTV cap to 50%, so the case is already flagged — the document ask should
      follow.
- [ ] **Age near the maturity limit.** An applicant at 63 salaried gets a
      2-year term, a very large payment and a tiny loan. Check the screen does
      not present that as a normal result without explaining why.
- [ ] **Income not yet provided.** A case created with only a name should say
      what it needs, not show a maximum borrowing computed from a default
      income. Check what the Underwriting tab renders on an empty case.

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
- [ ] **There is no "not sure yet" for residency.** On a first call a broker
      often does not know whether the buyer is resident, and the field silently
      defaults to expat resident — which sets an 80% LTV ceiling that may be
      badly wrong, presented with no indication it was assumed. Either add an
      explicit unknown state that suppresses the borrowing figure until it is
      answered, or mark the result as provisional. Do not simply pick a
      different default; the problem is that a guess is presented as a fact.
- [ ] **Residency is asked once and never confirmed against the documents.**
      The passport and visa the buyer uploads are the evidence. When extraction
      is configured it should check the stated residency against what the
      documents show and flag a contradiction, rather than trusting the intake
      dropdown for the whole life of the case.
