# Meridian — logical QA journal

One line per iteration: what a user would have seen before, and what they see
now. See `ralph/QA_PROMPT.md`.

**Signed out.** This track could not sign in to the running instance on :4100 —
every `/api/*` call returns `401 Sign in to continue` and no password was
available. Nothing here was verified through the browser. Everything was
reproduced and re-checked server-side instead, against a throwaway instance on a
spare port driven through the real HTTP API (the same technique `npm run smoke`
uses), with the Excel workbooks opened via the `xlsx` package. Screen-only
wording changes are therefore verified by reading the render path and by the
gate, not by a screenshot; that is stated per line where it applies.

- **Joint applicants.** Before: a broker with a couple in front of them saw one
  "Gross monthly income" field and one "Age", typed something, and got a
  maximum borrowing that read like a household figure with nothing anywhere
  saying it was not — and the obvious workaround, the co-applicant's salary in
  "Other monthly income", was silently haircut 20% while the term still came
  from the named applicant's age. Now: the intake form states, above the income
  field, and the Underwriting tab states, directly under the borrowing figure
  and on the printed pack, that Meridian assesses a single applicant, that a
  joint application is not modelled, and that a co-applicant's salary must not
  go into other income; the same sentence is in the model's methodology so it
  lands on the Excel Summary sheet the client is emailed. *Decision: stated on
  screen rather than filed as a design proposal — a proposal does not stop the
  wrong number being produced tomorrow, and the harm here is a plausible figure
  with an unstated scope, which is exactly the failure a note prevents.
  Modelling a second applicant is refiled as its own open item. Verified: the
  methodology text confirmed present in the exported mortgage workbook; the
  two on-screen placements read from `deal.assetType === "mortgage"` and were
  not seen in a browser.*

- **Off-plan document ask.** Before: a buyer purchasing off-plan — a case the
  product already understands well enough to halve their LTV cap and fire a flag
  about it — was sent a document list asking for a "Property MOU or Form F" and
  a "Title deed or Oqood". There is no seller and no Form F on an off-plan sale,
  and no title deed exists until handover; the buyer was left to work out which
  half of each line was theirs. Now: the case's own `is_off_plan` drives a third
  checklist axis alongside employment and residency, so an off-plan buyer is
  asked for the developer's SPA with its payment plan and the Oqood, and a
  resale buyer is asked for the MOU or Form F and the title deed — never both.
  The broker's Documents tab slot hint follows the same switch. *Verified
  through the API on three cases: ready mortgage, off-plan mortgage, and a
  property acquisition whose checklist is unchanged. A link issued before the
  off-plan flag was set is correctly reported stale, and its note now names the
  current profile instead of asserting that the residency changed.*

- **Age at maturity.** Before: a 66-year-old salaried applicant got a headline
  of "Maximum borrowing AED 0" explained by "Binding constraint: Income, with
  the term shortened by age" and a flag reading "The term is capped at 0 years"
  — income named as the reason when the reason was age, and a "cap" of zero
  presented as though a shorter loan were on offer; a 69-year-old was told
  "capped at 1 years". Now: reaching the maturity age is its own red flag that
  says there is no period left to lend over, that the borrowing is nil for that
  reason, and that the cash-to-complete figure is the entire price plus fees
  rather than a deposit; the binding-constraint line says "Age — no term is left
  before the maturity limit"; and the shortened-term flag reads "leaves 1 of the
  25 years requested". The due-diligence prompt no longer suggests adding a
  younger co-applicant without saying the tool cannot show that. *Verified at
  ages 41, 63, 65, 66, 69 and 72 across both employment types: every computed
  figure is byte-identical before and after — only prose and one display-only
  text line changed.*

- **Nothing answered yet.** Before: a mortgage case created with only a name
  opened on "Maximum borrowing AED 1,760,000 · Total cash to complete AED
  609,070", computed from the model's placeholder 45,000 income and 2,200,000
  price, with no warning of any kind — and the same in the property flow, where
  an empty commercial deal showed a 36m purchase price and 3.2m of contracted
  rent. The engine has a blocking warning for a missing required input, but
  every shipped model gives its required inputs defaults, so it has never once
  fired. Now: the Underwriting tab leads with a red notice naming exactly which
  required figures are still the model's own default — "Gross monthly income and
  Property price are still the model's own default … a worked example and not an
  assessment of this applicant" — and telling the user where to answer them,
  worded for whichever flow they are in. It clears itself as soon as the figures
  are typed or extracted. *Verified across all five shipped models empty and one
  mortgage case answered; no computed figure touched. The numbers are still on
  screen and still exportable — suppressing them would be a behaviour change
  rather than a wording one, so it is refiled rather than smuggled in here.*

- **Tenure in the header.** Before: "Sofia R — London, off-plan · Community not
  set · Mortgage · **Tenure not set** · AED" — a property-title term applied to
  a person, and not an unfilled field but a question that has no answer in that
  transaction. Now: the item is absent on a mortgage case and unchanged on a
  property deal, where "Tenure not set" is a genuine gap worth flagging.
  Community is kept on both, because where the buyer is purchasing is a real
  fact about a mortgage. *The tenure control was already confined to the
  property intake and the printed masthead already dropped a null tenure, so the
  header was the only leak. Read from the render path; not seen in a browser.*

- **Review tab.** Before: a mortgage case's Review tab ended with a section
  headed "Rent roll and T12" and the empty state "No unit or expense detail —
  Extraction did not find a rent roll or a trailing-twelve statement", and the
  extraction pass strip tallied "12 fields · 0 units · 0 lines" over a passport
  and a salary certificate. Now: neither appears on a mortgage — the tab ends
  after the field ledger, and the strip counts fields only — while a property
  deal still gets both, because there the absence of a rent roll is a finding.
  *Both gated on `deal.assetType`; read from the render path, not seen in a
  browser.*

- **Investment committee framing.** Before: a broker printing a mortgage
  assessment for one buyer got paper stamped "Meridian · Investment Committee
  pack", from a button labelled "Print IC pack", carrying a write-up headlined
  "Sofia R — underwriting complete." and a list headed "Due diligence"; had an
  API key been configured, the write-up would have been produced by a prompt
  casting the author as an acquisitions analyst at an investment firm and
  briefing them on cap rates, Mollak service charges and DSCR covenants for a
  buyer who owns nothing. Now: the masthead reads "Meridian · Pre-approval
  indication", the button "Print assessment", the sub-line "Dubai · Mortgage
  affordability" with no tenure, the list "Before submission", and the write-up
  opens "Affordability assessed on the UAE Mortgage Affordability — Buyer
  Assessment model, giving maximum borrowing AED 1,650,000 … This is an
  indication for discussion, not a credit decision or an offer of lending." The
  AI path has its own mortgage-adviser prompt built on the Central Bank caps,
  age at maturity, credit-card limits and completion costs, and told not to
  combine incomes. *Both narratives regenerated and compared: the property
  headline and summary are character-for-character unchanged.*

- **The Excel export.** Before: the mortgage workbook a broker emails a client
  had eight fixed sheets, two of which were empty property documents — a "Rent
  roll" tab with Unit, Beds, Baths, Lease start, Lease end, Ejari and
  "Total — 0 units", and a "T12" tab with Section, Category, Annualised and "In
  NOI" — and the Summary opened "Meridian — underwriting export" over a section
  headed "Property" with blank Address and Tenure rows. The file was called
  "Sofia R — London, off-plan underwriting.xlsx". Now the same case exports five
  sheets — Summary, Inputs, Assessment, Analysis, Benchmarks — the Summary opens
  "Meridian — mortgage affordability assessment" over an "Applicant" section
  with target community and case type and no address or tenure, and the file is
  called "… mortgage assessment.xlsx". *Verified by downloading both workbooks
  over the API and opening them with `xlsx`: the property workbook is unchanged,
  eight sheets, "Meridian — underwriting export", "Property" section intact,
  Rent roll and T12 present even though empty — a property deal whose rent roll
  has not arrived yet still gets the sheet, because that is the shape of the
  document it is going to be.*

- **Empty states.** Before: a broker whose pipeline was empty was told "Create a
  deal, drop in the offering memorandum, rent roll and T12, and run extraction"
  — on a screen that also offers "Assess a buyer" — and a mortgage case with no
  run read "No underwriting yet · Select a model and run the underwriting" under
  a button marked "Run underwriting", with the Analysis tab pointing back at
  "Run the underwriting first". Now: the list says "Underwrite a property from
  its offering memorandum, rent roll and T12 — or assess a buyer for a mortgage
  from their income, age and documents" when a mortgage model is installed, and
  keeps the original sentence when only property models are, so an
  investment-only account is not told about a job it cannot do; and a mortgage
  case says "No assessment yet", "Run assessment", "Run the assessment first".
  *Property copy verified unchanged on every branch; read from the render path,
  not seen in a browser.*

- **Benchmark wording.** Before: the debt burden ratio tile read "Target ≤
  40.00%" and its gauge "≤ 40.00% target · 50.00% floor" — a broker is not
  aiming for a debt burden ratio, and the 50% figure beneath it is the UAE
  Central Bank's ceiling, labelled as a floor, which inverts it exactly. The
  same words were applied to every lower-is-better benchmark in the property
  flow too: "Payback · Target ≤ 14 yrs · 18 yrs floor", "OpEx ratio · … 35.00%
  floor". Now the wording comes from the benchmark's own `direction`:
  higher-is-better is unchanged ("Target ≥ 1.35× · 1.25× floor"), lower-is-better
  reads "Comfortable ≤ 40.00%" and "≤ 40.00% comfortable · 50.00% limit". The
  workbook's Benchmarks sheet is headed "Comfortable at" and "Outer bound"
  instead of "Target" and "Tolerance"; the rules-based write-up no longer
  headlines "Debt burden ratio above target" as a strength; and the Thresholds
  section no longer calls a regulator's cap a covenant. *Verified by rendering
  the exact strings for all 13 benchmarks across both flows, and by reading the
  Benchmarks sheet out of both downloaded workbooks. No threshold value moved.*

- **Depth toggle.** Before: every case, mortgage included, carried a "Depth ·
  Quick | Full" control at the top of the Underwriting tab. Depth does exactly
  one thing in the engine — suppress the multi-year projection at "quick" — and
  the mortgage model has no projection, no hold period and no exit, so a broker
  clicking Full waited for a recompute and got the identical answer back, having
  been told there was more to see. Now the control appears only when the
  selected model actually declares a projection. *Verified against all five
  shipped models through the API: shown for dubai-residential-full,
  dubai-commercial-full and us-multifamily-full; hidden for the mortgage model
  and for dubai-residential-quick, where it was equally inert. Derived from the
  stored model definition, so a user's own cloned model gets the right answer
  without being asked anything.*

- **Sensitivity presets.** Before: a mortgage case's Sensitivity section offered
  a dropdown of "Exit yield x rent growth — unavailable", "Price x rent —
  unavailable", "LTV x interest rate — unavailable" and, below it, a section
  headed "Cheque structure · Dubai-specific" explaining that it could not run
  because "this model computes none of cash_on_cash, net_yield, levered_irr,
  effective_gross_income" — four investment grids a broker cannot use, refused
  in a list of internal variable names, over an explanation of post-dated rent
  cheques for a buyer who is not letting anything to anybody. Now: a grid that
  cannot run is not offered, the cheque section is absent when the model has no
  cheque input, and where a reason is still shown it reads "this grid reports an
  equity return — an IRR or an equity multiple, and this model does not compute
  one". A mortgage case is left with the custom builder and a section head that
  says so. *Verified by resolving the presets against all five shipped models:
  the property dropdowns lose only entries that were already dead — commercial
  loses "Price x rent", US multifamily loses that and the cheque section, which
  does not exist as an instrument there either.*
