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

- [x] **Joint applicants are not modelled at all.** Two incomes, two sets of
      identity documents, two liability positions — extremely common in Dubai
      and currently impossible to express. Decided: **state the limitation on
      screen**, at the two moments a broker can act on it — the mortgage intake
      form, before the income field is filled in, and under the KPI band on the
      Underwriting tab, where it also prints. The same sentence is in the
      model's methodology, so it reaches the Excel Summary sheet too. The
      workaround a broker would otherwise reach for — a co-applicant's salary
      in "Other monthly income" — is named and refused, because it is haircut
      as non-salary income and the term still comes from the named applicant's
      age. Modelling a second applicant remains open below.
- [x] **A resident buying off-plan is not asked for the Oqood.** The property
      slot mentioned it, but the checklist item was generic. Off-plan changes the
      LTV cap to 50%, so the case is already flagged — the document ask now
      follows. `purchase: ["ready" | "off_plan"]` is a third independent axis on
      `ChecklistItem`, alongside employment and residency, derived from the
      case's own `is_off_plan`. Ready gets MOU/Form F and title deed; off-plan
      gets the developer SPA with its payment plan and the Oqood, because there
      is no seller and no title deed until handover. The stale-link note stopped
      asserting which axis moved and now names the current profile instead.
- [x] **Age near the maturity limit.** At 63 the KPI band already explained
      itself — "Eligible term 2", "Binding constraint: Income, with the term
      shortened by age". At and past the limit it did not: a 66-year-old was
      told "the term is capped at 0 years", the headline named income as the
      binding constraint over a maximum borrowing of zero, and a 69-year-old
      self-employed applicant read "capped at 1 years". Now the past-maturity
      case is its own red flag that says there is no period to lend over and
      that the cash figure is the whole price rather than a deposit; the
      binding-constraint line names age; and the shortened-term wording is
      grammatical at one year. No computed value changed — re-checked at ages
      41/63/65/66/69/72, every figure identical before and after.
- [x] **Income not yet provided.** Confirmed and worse than filed: it is not
      only income, and it is not only the mortgage flow. Every shipped model
      marks a handful of inputs `required` AND gives each of them a default, so
      the engine's blocking warning for a missing required input can never fire.
      An empty mortgage case showed "Maximum borrowing AED 1,760,000" from a
      45,000 placeholder income; an empty commercial deal showed a 36m purchase
      price and a 3.2m rent; blocking warnings: zero, in all five models. The
      Underwriting tab now leads with a red notice naming the required inputs
      that are still model defaults and saying the figures are a worked example
      rather than an assessment. Derived from `required` + `origin`, both
      already computed — `required` is now carried onto `ResolvedInput`. The
      notice disappears the moment the figures are answered or extracted. **Not
      done:** the numbers are still shown and still exportable; suppressing them
      is a behaviour change, not a wording one, and is refiled below.

- [x] **`Tenure not set` in the deal header on a mortgage case.** Suppressed
      entirely for a mortgage rather than relabelled — the empty value was never
      the problem, the question was. Community stays on both flows, because
      where a buyer is purchasing is a real fact about a mortgage case. The
      printed masthead already dropped a null tenure and is unchanged; the
      tenure control was already confined to the property intake.
- [x] **The Review tab.** Confirmed: on a mortgage case the tab ended with a
      section headed `Rent roll and T12` containing "No unit or expense detail —
      Extraction did not find a rent roll or a trailing-twelve statement", which
      is a finding on a property deal and an empty shell of somebody else's job
      on an applicant. Suppressed for a mortgage; unchanged on a property deal,
      where the absence is worth reporting. The per-unit and T12 tables were
      already gated on having rows. Also fixed on the same tab: the extraction
      pass strip read "12 fields · 0 units · 0 lines" after reading a passport
      and a salary certificate, and now counts only fields on a mortgage.
- [x] **The Analysis tab and the printed IC pack.** Four leaks, all fixed for a
      mortgage case and all unchanged on a property deal: the print masthead
      stamped "Meridian · Investment Committee pack" and now reads "Meridian ·
      Pre-approval indication"; the header button said "Print IC pack" and now
      says "Print assessment"; the AI system prompt cast the writer as an
      acquisitions analyst writing a committee memo and briefed them on cap
      rates, service charges and DSCR covenants, and a mortgage case now gets a
      mortgage adviser's prompt with the Central Bank caps, the age-at-maturity
      limits, the card-limit rule and completion costs — plus an instruction not
      to combine incomes; and the rules-based write-up, which is what runs with
      no API key, headlined "— underwriting complete" and now names the model's
      own headline figures and states that this is an indication rather than a
      credit decision. The due-diligence card stack is headed "Before
      submission" on a mortgage. `NARRATIVE_PROMPT_VERSION` bumped.
- [x] **The Excel export.** Sheets now follow the case type. A mortgage
      assessment exports Summary, Inputs, Assessment, Analysis and Benchmarks —
      no `Rent roll`, no `T12`. The Summary opens "Meridian — mortgage
      affordability assessment" over an `Applicant` section (target community,
      city, country, case type) instead of a `Property` section with blank
      Address and Tenure rows, and the `Underwriting model` section is headed
      `Assessment model`. The file is named "… mortgage assessment.xlsx" rather
      than "… underwriting.xlsx". A property deal is untouched, including its
      empty Rent roll sheet — the rent roll has not arrived yet, but the
      document is still going to have one. The export menu's "xlsx · 8 sheets"
      was a constant that was already wrong for a quick property deal and now
      describes the contents instead of counting tabs.
- [x] **Empty states.** The deal list's "Create a deal, drop in the offering
      memorandum, rent roll and T12, and run extraction" now describes both jobs
      when a mortgage model is installed — gated on the same test the intake
      uses to decide whether to offer both modes — and keeps the original
      sentence when only property models are present. Also fixed: "No
      underwriting yet · Select a model and run the underwriting" and "Run the
      underwriting on the previous tab" on a mortgage case, along with the
      button they refer to, which now reads "Run assessment". A broker does not
      underwrite; the lender does.
- [ ] **The word "deal" throughout.** A mortgage case is an applicant, not a
      deal. Check the deal list column headings, the breadcrumb, the delete
      confirmation and the page titles. Decide once whether to say "case" in
      both flows or branch the noun, and write the decision down.
- [x] **The sensitivity presets on a mortgage model.** All four were offered on
      a mortgage case and all four were unavailable, each explained as "this
      model computes none of levered_irr, irr, unlevered_irr, equity_multiple" —
      a list of internal keys — plus a whole "Cheque structure · Dubai-specific"
      section about post-dated rent cheques on a buyer who is not letting
      anything to anybody. A shipped grid that cannot run is no longer offered
      in the dropdown at all (selecting one could only ever produce an error),
      the cheque section is suppressed when the model has no cheque input, and
      the remaining reason strings name what the grid reports in English rather
      than listing keys. Verified across all five models: the property
      dropdowns lose only the entries that were already dead, and a mortgage
      case is left with the custom grid and a section head that says why.
      **Not done:** no mortgage grids were added — rate × term or price × income
      would be the obvious pair, but that is a new feature, not a wording fix.
      Refiled below.
- [x] **The Underwriting tab's depth toggle.** Depth has exactly one effect in
      the engine — at "quick" the multi-year projection is suppressed — so on a
      model that declares no projection the two settings compute an identical
      answer. The control is now shown only when the selected model has a
      projection, which hides it on the mortgage model and also on
      `dubai-residential-quick`, where it was equally inert. Derived from a new
      `hasProjection` on the model summary, read from the stored definition, not
      from the asset type.
- [x] **Benchmark language.** Worse than filed, and wrong in both flows. Every
      benchmark was announced in the vocabulary of a higher-is-better metric,
      so a lower-is-better one got "Target ≤ 40.00%" on the KPI tile and
      "≤ 40.00% target · 50.00% floor" on the gauge — calling a UAE Central Bank
      ceiling a floor, which inverts it exactly. The property flow had the same
      bug on Payback and the OpEx ratio. The words now come from the
      benchmark's own `direction`: higher-is-better keeps "Target ≥ … · floor",
      lower-is-better reads "Comfortable ≤ … · limit". Also carried through the
      workbook's Benchmarks sheet (`Target`/`Tolerance` → `Comfortable at`/
      `Outer bound`), the brief handed to the AI writer, and the rules-based
      write-up, which could previously headline "Debt burden ratio above
      target" as a strength. The Thresholds section no longer calls a
      regulator's cap a covenant.
- [ ] **Model a second applicant.** The limitation is now stated rather than
      hidden, which is the QA fix; the product fix is still open. Two incomes,
      two ages at maturity, two liability positions and two document sets, with
      the term taken from the older applicant. This is a model and schema
      change, not a wording change — it belongs to the build track.
- [ ] **There are no sensitivity grids for a mortgage case.** The shipped four
      are all investment grids and are now correctly hidden, which leaves a
      broker with the custom builder and nothing pre-made. The two a broker
      actually asks for are interest rate × term (what happens to the payment
      and the maximum loan if rates move or the term shortens) and price ×
      income. Both are expressible in the existing `PresetSpec` shape against
      `interest_rate`, `requested_term_years`, `property_price` and
      `gross_monthly_income`. Feature work, not wording — build track.
- [ ] **A result built entirely from defaults is still exportable.** The screen
      now says so; the workbook does not. The Summary sheet's Warnings section
      is driven by `result.warnings`, which is empty on these cases, and only
      the Inputs sheet's Origin column reveals that every required figure reads
      "default". Decide whether an all-defaults run should carry the same
      statement on the Summary sheet and the printed pack, or whether the export
      should refuse. This is the artefact that leaves the building.
- [ ] **`required` with a `default` is a contradiction in every shipped model.**
      The engine only raises its blocking warning when a required input resolves
      to null, and a default guarantees it never does. Either required inputs
      should not carry defaults, or the engine needs a distinct state for
      "required and still on its default". Currently the mechanism exists and
      does nothing. Model/engine change — build track, not this one.
- [ ] **The deterministic model flags render on the Analysis tab only.** They
      are the explanation of the result, and the result is on the Underwriting
      tab — which is also where a new mortgage case lands straight after intake.
      A broker who never opens Analysis sees "Maximum borrowing AED 0" with no
      reason given anywhere on the screen in front of them. `renderUnderwriting`
      surfaces `result.warnings` at level `blocking` and nothing else; the
      shipped models declare no blocking warnings on these paths.
- [ ] **`income_bound` still fires past the maturity age.** With no term, both
      ceilings are nil and the flag says "Income supports AED 0 while the
      deposit rules would allow AED 2,200,000 — only more income, fewer
      commitments, or a longer term will [help]", which is not true of someone
      who is simply too old to borrow. The red past-maturity flag now sits
      beside it and contradicts it. Gate `income_bound` on `term_by_age > 0` the
      way `age_limited_term` now is.
- [ ] **The Collect tab's checklist preview always says "0 items".**
      `newRequestForm()` in `public/js/collect-admin.js` reads
      `checklists.mortgage[employment]`, but `/api/collect/checklists` is nested
      residency → employment → purchase, so the lookup misses and the preview
      renders an empty list under the line "The buyer will be asked for 0
      items". The custom-item picker (same file, the spread of
      `checklists.mortgage?.salaried`) is empty for the same reason. Consider
      replying with the checklist this case would actually produce — the deal is
      known at `/api/deals/:id/collect` — rather than shipping the whole matrix
      and re-deriving the filter in the browser.
- [ ] **`title_deed` is a key in both checklists.** `resolveRequestToken()`
      resolves a stored key against `[...MORTGAGE_CHECKLIST,
      ...ACQUISITION_CHECKLIST]` and takes the first match, so an ACQUISITION
      link asking for a title deed renders the mortgage item's label and hint
      and files the upload under kind `om` instead of `other`. Keys need to be
      unique across both lists, or resolved within the list the request was
      issued from.
- [ ] **`element.style.setProperty()` is used on ~10 call sites** (`ui.js`
      `el({css})` and `gauge()`, `app.js` KPI and flag `--i` stagger) and the
      app serves `style-src 'self'` with no `'unsafe-inline'`, so every one of
      them is refused by the browser and fails silently. Either the animations
      and the ad-hoc spacing are not working at all, or the CSP is not what
      `src/lib/http/server.ts` says it is. Confirm in a browser, then move the
      values to classes or a constructed stylesheet — do not weaken the CSP.
      (Not a mortgage/property leak; filed from the sweep.)
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
