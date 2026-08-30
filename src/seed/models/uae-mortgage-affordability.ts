// UAE residential mortgage affordability — for mortgage brokers and agents.
//
// This model exists to prove the central architectural claim: the underwriting
// engine knows nothing about real estate. A mortgage affordability assessment
// is a completely different financial question from an investment underwriting,
// and it required no engine changes at all — only a new JSON document.
//
// It answers the three questions a Dubai mortgage agent is asked every day:
//
//   1. How much can this buyer actually borrow?
//   2. Which rule is stopping them — income, deposit, or age?
//   3. How much cash do they need on the day?
//
// The regulatory frame is the UAE Central Bank mortgage regulations
// (Circular 31/2013) plus current market practice. Every threshold is an
// editable input, not a constant, because these move and a broker must be able
// to follow their lender's actual policy rather than ours.

import type { ModelDefinition } from "../../lib/engine/types.ts";

export const uaeMortgageAffordability: ModelDefinition = {
  key: "uae-mortgage-affordability",
  name: "UAE Mortgage Affordability — Buyer Assessment",
  description:
    "Dubai / UAE residential mortgage affordability for brokers. Computes maximum borrowing under the 50% debt burden ratio, the Central Bank LTV caps and the age-at-maturity term limit, reports which constraint binds, and totals the cash required to complete.",
  market: "AE",
  currency: "AED",
  depth: "quick",
  assetType: "mortgage",
  schemaVersion: 1,

  inputs: [
    // ---- applicant ----------------------------------------------------
    {
      key: "applicant_type",
      label: "Applicant type",
      group: "Applicant",
      type: "select",
      options: [
        { value: "uae_national", label: "UAE national" },
        { value: "expat_resident", label: "Expat resident" },
        { value: "non_resident", label: "Non-resident" },
      ],
      default: "expat_resident",
      extract: true,
      source: "om",
      help: "Whether the buyer is a UAE national, an expat living here, or based overseas. This alone changes how much they are allowed to borrow — nationals may borrow the most, non-residents the least.",
    },
    {
      key: "employment_type",
      label: "Employment",
      group: "Applicant",
      type: "select",
      options: [
        { value: "salaried", label: "Salaried" },
        { value: "self_employed", label: "Self-employed" },
      ],
      default: "salaried",
      extract: true,
      help: "Salaried or self-employed. It sets the age by which the loan must be repaid — usually 65 for salaried, 70 for self-employed — which can shorten the term for an older buyer.",
    },
    {
      key: "applicant_age",
      label: "Applicant age",
      group: "Applicant",
      type: "integer",
      unit: "years",
      default: 38,
      min: 18,
      max: 75,
      extract: true,
      source: "om",
      help: "From their Emirates ID or passport. It matters because the loan must be fully repaid before a maximum age, so an older buyer gets a shorter term and therefore a smaller loan.",
    },

    // ---- income -------------------------------------------------------
    {
      key: "gross_monthly_income",
      label: "Gross monthly income",
      group: "Income",
      type: "currency",
      unit: "AED/month",
      default: 45000,
      min: 0,
      extract: true,
      source: "om",
      required: true,
      help: "Basic salary plus fixed allowances, before any deductions — the figure on their salary certificate. Leave out bonuses and commission; most banks will not count them.",
    },
    {
      key: "other_monthly_income",
      label: "Other monthly income",
      group: "Income",
      type: "currency",
      unit: "AED/month",
      default: 0,
      min: 0,
      extract: true,
      help: "Any other regular documented income, such as rent from a property they already own. Banks count this but usually not in full.",
    },
    {
      key: "other_income_haircut",
      label: "Haircut applied to other income",
      group: "Income",
      type: "percent",
      default: 0.2,
      min: 0,
      max: 1,
      help: "How much of that other income the bank ignores, because it is less reliable than salary. 20% is typical.",
    },

    // ---- existing commitments ----------------------------------------
    {
      key: "existing_loan_repayments",
      label: "Existing monthly loan repayments",
      group: "Commitments",
      type: "currency",
      unit: "AED/month",
      default: 0,
      min: 0,
      extract: true,
      source: "om",
      help: "What they already pay each month on personal loans, car finance or another mortgage. Found on a liability letter from their bank, or on their statements.",
    },
    {
      key: "credit_card_limits",
      label: "Total credit card limits",
      group: "Commitments",
      type: "currency",
      unit: "AED",
      default: 0,
      min: 0,
      extract: true,
      source: "om",
      help: "The total LIMIT across all their cards — not what they owe. This catches people out: a card with a zero balance still reduces borrowing power, because the bank assumes they could spend up to the limit.",
    },
    {
      key: "credit_card_charge_rate",
      label: "Credit card commitment rate",
      group: "Commitments",
      type: "percent",
      default: 0.05,
      min: 0,
      max: 0.2,
      help: "How much of the card limit the bank counts as a monthly commitment. 5% is the UAE standard, so a 100,000 limit is treated as 5,000 a month.",
    },

    // ---- the property -------------------------------------------------
    {
      key: "property_price",
      label: "Property price",
      group: "Property",
      type: "currency",
      unit: "AED",
      default: 2200000,
      min: 0,
      extract: true,
      source: "om",
      required: true,
      help: "The agreed price, or the buyer’s target if they are still looking. Crossing AED 5,000,000 reduces how much they are allowed to borrow.",
    },
    {
      key: "is_first_property",
      label: "First property in the UAE",
      group: "Property",
      type: "boolean",
      default: true,
      extract: true,
      help: "Whether this is their first property in the UAE. A second one requires a bigger deposit.",
    },
    {
      key: "is_off_plan",
      label: "Off-plan purchase",
      group: "Property",
      type: "boolean",
      default: false,
      extract: true,
      help: "Buying from a developer before it is built. Off-plan requires at least a 50% deposit whoever the buyer is.",
    },

    // ---- the facility -------------------------------------------------
    {
      key: "interest_rate",
      label: "Interest rate",
      group: "Facility",
      type: "percent",
      default: 0.0449,
      min: 0,
      max: 0.25,
      help: "The rate the bank has quoted. If unsure, leave the default — it is close to current market and can be changed later.",
    },
    {
      key: "stress_uplift",
      label: "Affordability stress uplift",
      group: "Facility",
      type: "percent",
      default: 0.02,
      min: 0,
      max: 0.1,
      help: "How much higher than the quoted rate to test affordability at, in case rates rise. Banks do this too; 2% is typical.",
    },
    {
      key: "requested_term_years",
      label: "Requested term",
      group: "Facility",
      type: "integer",
      unit: "years",
      default: 25,
      min: 1,
      max: 30,
      help: "How many years the buyer wants to spread the loan over. Longer means lower monthly payments and a bigger possible loan, up to the 25-year legal maximum.",
    },
    {
      key: "max_term_years",
      label: "Regulatory maximum term",
      group: "Facility",
      type: "integer",
      unit: "years",
      default: 25,
      min: 1,
      max: 30,
      help: "The longest term allowed by UAE regulation. Leave at 25 unless your lender is stricter.",
    },
    {
      key: "dbr_cap",
      label: "Debt burden ratio cap",
      group: "Facility",
      type: "percent",
      default: 0.5,
      min: 0.1,
      max: 0.8,
      help: "The most of their income that can go to debt each month. UAE regulation caps this at 50%; some banks apply less.",
    },
    {
      key: "max_age_salaried",
      label: "Maximum age at maturity — salaried",
      group: "Facility",
      type: "integer",
      unit: "years",
      default: 65,
      min: 50,
      max: 80,
      help: "The age by which a salaried borrower must have repaid the loan. Usually 65.",
    },
    {
      key: "max_age_self_employed",
      label: "Maximum age at maturity — self-employed",
      group: "Facility",
      type: "integer",
      unit: "years",
      default: 70,
      min: 50,
      max: 85,
      help: "The age by which a self-employed borrower must have repaid. Usually 70 — five years more than salaried.",
    },

    // ---- completion costs --------------------------------------------
    {
      key: "dld_fee_pct",
      label: "DLD transfer fee",
      group: "Completion costs",
      type: "percent",
      default: 0.04,
      help: "The Land Department transfer fee, 4% of the price. Legally shared with the seller but in practice the buyer pays all of it.",
    },
    {
      key: "agency_fee_pct",
      label: "Agency commission",
      group: "Completion costs",
      type: "percent",
      default: 0.02,
      help: "The estate agent’s commission, normally 2% plus VAT.",
    },
    {
      key: "mortgage_reg_pct",
      label: "Mortgage registration fee",
      group: "Completion costs",
      type: "percent",
      default: 0.0025,
      help: "The fee to register the mortgage against the property, 0.25% of the loan.",
    },
    {
      key: "bank_arrangement_pct",
      label: "Bank arrangement fee",
      group: "Completion costs",
      type: "percent",
      default: 0.01,
      help: "What the bank charges to set the loan up, usually between 0.5% and 1% of the loan. Often negotiable.",
    },
    {
      key: "fixed_completion_costs",
      label: "Fixed completion costs",
      group: "Completion costs",
      type: "currency",
      unit: "AED",
      default: 12000,
      help: "Trustee office, title deed, valuation and conveyancing together — fees that do not scale with the price.",
    },
    {
      key: "buyer_available_cash",
      label: "Cash the buyer has available",
      group: "Completion costs",
      type: "currency",
      unit: "AED",
      default: 700000,
      min: 0,
      extract: true,
      help: "How much the buyer actually has to put in, from their savings and statements. Compared against everything they need on the day.",
    },
  ],

  lines: [
    // ---- income and commitments --------------------------------------
    {
      key: "assessed_income",
      label: "Assessed monthly income",
      group: "Affordability",
      formula: "gross_monthly_income + other_monthly_income * (1 - other_income_haircut)",
      format: "currency",
      unit: "AED/month",
      help: "The income a bank will actually count. Salary is taken in full; other income such as rent is usually discounted, because it is less certain.",
    },
    {
      key: "card_commitment",
      label: "Credit card commitment",
      group: "Affordability",
      formula: "credit_card_limits * credit_card_charge_rate",
      format: "currency",
      unit: "AED/month",
      help: "What credit cards cost this buyer in the bank’s eyes. UAE lenders assume a monthly commitment of 5% of the total card LIMIT even if the balance is zero, so an unused card still reduces how much they can borrow.",
    },
    {
      key: "total_existing_commitments",
      label: "Existing monthly commitments",
      group: "Affordability",
      formula: "existing_loan_repayments + card_commitment",
      format: "currency",
      unit: "AED/month",
    },
    {
      key: "dbr_allowance",
      label: "Total debt service allowed",
      group: "Affordability",
      formula: "assessed_income * dbr_cap",
      format: "currency",
      unit: "AED/month",
      help: "The most the regulator allows this buyer to spend on all debt each month — a fixed share of their assessed income.",
    },
    {
      key: "available_for_mortgage",
      label: "Available for mortgage repayment",
      group: "Affordability",
      formula: "max(0, dbr_allowance - total_existing_commitments)",
      format: "currency",
      unit: "AED/month",
      emphasis: "strong",
      help: "How much of their monthly income is free for a mortgage, after the regulator’s cap is applied and existing loan and credit-card commitments are deducted.",
    },

    // ---- term ---------------------------------------------------------
    {
      key: "max_maturity_age",
      label: "Maximum age at maturity",
      group: "Term",
      formula: 'employment_type == "self_employed" ? max_age_self_employed : max_age_salaried',
      format: "integer",
      unit: "years",
    },
    {
      key: "term_by_age",
      label: "Term available on age",
      group: "Term",
      formula: "max(0, max_maturity_age - applicant_age)",
      format: "integer",
      unit: "years",
    },
    {
      key: "eligible_term_years",
      label: "Eligible term",
      group: "Term",
      formula: "min(requested_term_years, max_term_years, term_by_age)",
      format: "integer",
      unit: "years",
      emphasis: "strong",
      help: "How many years are left before the buyer reaches the maximum age, which can shorten the loan term below what they asked for.",
    },
    {
      key: "term_months",
      label: "Term in months",
      group: "Term",
      formula: "eligible_term_years * 12",
      format: "integer",
      hidden: true,
    },

    // ---- maximum loan by income --------------------------------------
    {
      key: "stress_rate",
      label: "Stress-tested rate",
      group: "Facility",
      formula: "interest_rate + stress_uplift",
      format: "percent",
      help: "A rate higher than the one quoted, used to check the buyer could still afford the payments if rates rose. Banks do this; so does this assessment.",
    },
    {
      key: "monthly_stress_rate",
      label: "Monthly stress rate",
      group: "Facility",
      formula: "stress_rate / 12",
      format: "percent",
      precision: 4,
      hidden: true,
    },
    {
      key: "max_loan_by_income",
      label: "Maximum loan on income",
      group: "Borrowing capacity",
      // Present value of the affordable payment, at the stressed rate over the
      // eligible term. The zero-rate branch keeps a 0% promotional rate from
      // dividing by zero.
      formula:
        "monthly_stress_rate > 0 " +
        "? available_for_mortgage * (1 - pow(1 + monthly_stress_rate, 0 - term_months)) / monthly_stress_rate " +
        ": available_for_mortgage * term_months",
      format: "currency",
      unit: "AED",
      emphasis: "strong",
      help: "The most this buyer could afford to repay, based on their income after existing debts and tested at a higher interest rate than quoted. Nothing about the property affects this number.",
    },

    // ---- maximum loan by LTV -----------------------------------------
    {
      key: "ltv_cap",
      label: "Loan-to-value ceiling",
      group: "Borrowing capacity",
      // Central Bank ladder. Off-plan overrides everything; then second
      // property; then the AED 5m threshold by nationality.
      formula:
        "is_off_plan ? 0.50 : " +
        "(not is_first_property " +
        '  ? (applicant_type == "uae_national" ? 0.65 : (applicant_type == "non_resident" ? 0.50 : 0.60)) ' +
        '  : (applicant_type == "uae_national" ? (property_price > 5000000 ? 0.70 : 0.85) ' +
        '     : (applicant_type == "non_resident" ? 0.60 ' +
        "        : (property_price > 5000000 ? 0.65 : 0.80))))",
      format: "percent",
      emphasis: "strong",
      help: "The maximum share of the price a bank is permitted to lend to this buyer. UAE nationals may borrow more than expat residents, who may borrow more than non-residents, and everyone borrows less on a second property or an off-plan purchase.",
    },
    {
      key: "max_loan_by_ltv",
      label: "Maximum loan on deposit rules",
      group: "Borrowing capacity",
      formula: "property_price * ltv_cap",
      format: "currency",
      unit: "AED",
      emphasis: "strong",
      help: "The most the rules allow them to borrow against this particular property, regardless of income. Set by the Central Bank and depends on nationality, price, and whether it is their first UAE property.",
    },

    // ---- the answer ---------------------------------------------------
    {
      key: "max_loan",
      label: "Maximum borrowing",
      group: "Borrowing capacity",
      formula: "min(max_loan_by_income, max_loan_by_ltv)",
      format: "currency",
      unit: "AED",
      emphasis: "hero",
      help: "The most a UAE bank will lend this buyer. It is the lower of two separate limits — what their income can afford to repay, and what the deposit rules allow them to borrow. Whichever is lower is the answer.",
    },
    {
      key: "binding_constraint",
      label: "Binding constraint",
      group: "Borrowing capacity",
      // A text line so the UI and the memo can say WHY, not just how much.
      formula:
        "max_loan_by_income < max_loan_by_ltv " +
        '? (term_by_age < min(requested_term_years, max_term_years) ? "Income, with the term shortened by age" : "Income — the debt burden ratio") ' +
        ': "Deposit — the loan-to-value ceiling"',
      format: "text",
      emphasis: "strong",
      help: "Which of the two limits is holding this buyer back. \"Income\" means a bigger deposit will not increase the loan — they need more salary, fewer existing debts, or a longer term. \"Deposit\" means finding more cash will unlock a bigger loan.",
    },
    {
      key: "achieved_ltv",
      label: "Loan to value achieved",
      group: "Borrowing capacity",
      formula: "max_loan / property_price",
      format: "percent",
      help: "How much of the price is borrowed rather than paid in cash. 80% means the buyer puts in 20% of their own money. A lower figure is safer and usually earns a better interest rate.",
    },
    {
      key: "monthly_payment",
      label: "Monthly payment at the quoted rate",
      group: "Borrowing capacity",
      formula: "pmt(interest_rate / 12, term_months, max_loan)",
      format: "currency",
      unit: "AED/month",
      emphasis: "strong",
      help: "What they would pay every month at the rate quoted today. Look at the stressed figure beside it too — that is what the payment becomes if rates rise, and banks test affordability against that rather than this one.",
    },
    {
      key: "monthly_payment_stressed",
      label: "Monthly payment if stressed",
      group: "Borrowing capacity",
      formula: "pmt(monthly_stress_rate, term_months, max_loan)",
      format: "currency",
      unit: "AED/month",
      help: "How much of the price is borrowed rather than paid in cash. 80% means the buyer puts in 20% of their own money and borrows the other 80%. A lower figure is safer and usually earns a better interest rate.",
    },
    {
      key: "resulting_dbr",
      label: "Resulting debt burden ratio",
      group: "Affordability",
      formula: "(monthly_payment + total_existing_commitments) / assessed_income",
      format: "percent",
      emphasis: "strong",
      help: "The share of monthly income that goes to debt — this mortgage plus any existing loans and credit cards. UAE regulation caps it at 50%; under 40% is comfortable and gets approved more easily.",
    },

    // ---- cash to complete ---------------------------------------------
    {
      key: "down_payment",
      label: "Down payment",
      group: "Cash to complete",
      formula: "property_price - max_loan",
      format: "currency",
      help: "The part of the purchase price the buyer pays from their own money. It cannot be borrowed.",
      unit: "AED",
      emphasis: "strong",
    },
    {
      key: "dld_fee",
      label: "DLD transfer fee",
      group: "Cash to complete",
      formula: "property_price * dld_fee_pct + 580",
      format: "currency",
    },
    {
      key: "agency_fee",
      label: "Agency commission incl. VAT",
      group: "Cash to complete",
      formula: "property_price * agency_fee_pct * 1.05",
      format: "currency",
    },
    {
      key: "mortgage_reg_fee",
      label: "Mortgage registration",
      group: "Cash to complete",
      formula: "max_loan * mortgage_reg_pct + 290",
      format: "currency",
    },
    {
      key: "arrangement_fee",
      label: "Bank arrangement fee",
      group: "Cash to complete",
      formula: "max_loan * bank_arrangement_pct",
      format: "currency",
    },
    {
      key: "total_transaction_costs",
      label: "Transaction costs",
      group: "Cash to complete",
      formula: "dld_fee + agency_fee + mortgage_reg_fee + arrangement_fee + fixed_completion_costs",
      format: "currency",
      emphasis: "strong",
    },
    {
      key: "cash_required",
      label: "Total cash to complete",
      group: "Cash to complete",
      formula: "down_payment + total_transaction_costs",
      format: "currency",
      unit: "AED",
      emphasis: "hero",
      help: "All the one-off fees on top of the price: transfer, agency, mortgage registration, valuation and conveyancing. Typically 6-8% of the purchase price in Dubai.",
    },
    {
      key: "cash_surplus",
      label: "Cash surplus or shortfall",
      group: "Cash to complete",
      formula: "buyer_available_cash - cash_required",
      format: "currency",
      unit: "AED",
      emphasis: "strong",
      help: "What is left of the buyer’s savings after paying the deposit and every fee. If this is negative they cannot complete the purchase at this price, and the figure shows how far short they are.",
    },
    {
      key: "affordable_price_on_cash",
      label: "Price affordable on available cash",
      group: "Cash to complete",
      // Solve price from the cash constraint, holding the LTV and fee rates.
      formula:
        "buyer_available_cash > fixed_completion_costs " +
        "? (buyer_available_cash - fixed_completion_costs - 870) / " +
        "  ((1 - ltv_cap) + dld_fee_pct + agency_fee_pct * 1.05 + ltv_cap * (mortgage_reg_pct + bank_arrangement_pct)) " +
        ": null",
      format: "currency",
      unit: "AED",
      help: "The highest price this buyer could complete on with the cash they have, keeping the same deposit percentage and fees. Useful when the cash falls short of the property they asked about.",
    },
    {
      key: "cost_to_price_ratio",
      label: "Costs as a share of price",
      group: "Cash to complete",
      formula: "total_transaction_costs / property_price",
      format: "percent",
      help: "The fees expressed as a share of the purchase price, so it can be compared across deals of different sizes.",
    },
  ],

  summary: [
    "max_loan",
    "cash_required",
    "monthly_payment",
    "binding_constraint",
    "achieved_ltv",
    "resulting_dbr",
    "eligible_term_years",
    "cash_surplus",
  ],

  benchmarks: [
    {
      key: "resulting_dbr",
      label: "Debt burden ratio",
      direction: "lower",
      good: 0.4,
      warn: 0.5,
      note: "UAE Central Bank caps total debt service at 50% of income. Under 40% is comfortable.",
    },
    {
      key: "achieved_ltv",
      label: "Loan to value",
      direction: "lower",
      good: 0.7,
      warn: 0.8,
      note: "Lower leverage prices better and clears underwriting faster.",
    },
    {
      key: "cost_to_price_ratio",
      label: "Transaction costs",
      direction: "lower",
      good: 0.07,
      warn: 0.09,
      note: "Buyer-side costs in Dubai typically run 6-8% of the price.",
    },
  ],

  flags: [
    {
      id: "cash_shortfall",
      when: "cash_surplus < 0",
      severity: "red",
      title: "Buyer is short of the cash required",
      detail:
        "Completing at {property_price} needs {cash_required} in cash — {down_payment} deposit plus {total_transaction_costs} of fees — against {buyer_available_cash} available. The shortfall is {cash_surplus}. On current cash the affordable price is about {affordable_price_on_cash}.",
      metric: "cash_surplus",
      dd: "Confirm the source of funds and whether any gift or additional savings can be evidenced — lenders require the deposit to come from the buyer's own funds, not borrowed.",
    },
    {
      id: "dbr_breach",
      when: "resulting_dbr > dbr_cap",
      severity: "red",
      title: "Debt burden ratio exceeds the cap",
      detail:
        "Total debt service is {resulting_dbr} of assessed income against a {dbr_cap} ceiling. Existing commitments of {total_existing_commitments} per month are consuming the allowance.",
      metric: "resulting_dbr",
      dd: "Ask whether any existing facility can be settled or a credit card limit reduced before submission — each AED 100,000 of card limit costs roughly AED 5,000 a month of borrowing capacity.",
    },
    {
      id: "income_bound",
      when: "max_loan_by_income < max_loan_by_ltv",
      severity: "amber",
      title: "Borrowing is limited by income, not deposit",
      detail:
        "Income supports {max_loan_by_income} while the deposit rules would allow {max_loan_by_ltv}. A larger deposit will not increase the loan — only more income, fewer commitments, or a longer term will.",
      metric: "max_loan_by_income",
      dd: "Check whether documented rental or bonus income can be added, and whether a longer term is available within the age limit.",
    },
    {
      id: "age_limited_term",
      when: "term_by_age < min(requested_term_years, max_term_years)",
      severity: "amber",
      title: "Term shortened by age at maturity",
      detail:
        "The term is capped at {eligible_term_years} years because the loan must be repaid by age {max_maturity_age}, against a requested {requested_term_years} years. A shorter term raises the payment and reduces borrowing capacity.",
      metric: "eligible_term_years",
      dd: "Ask whether a lender offering a higher maturity age is available, or whether a younger co-applicant can be added.",
    },
    {
      id: "card_limits_material",
      when: "card_commitment > assessed_income * 0.05",
      severity: "amber",
      title: "Credit card limits are consuming borrowing capacity",
      detail:
        "Card limits of {credit_card_limits} are assessed as {card_commitment} a month even if the balances are nil. That is reducing the maximum loan materially.",
      metric: "card_commitment",
      dd: "Ask the buyer to reduce or close unused card limits and obtain a bank confirmation before submission.",
    },
    {
      id: "non_resident_cap",
      when: 'applicant_type == "non_resident"',
      severity: "info",
      title: "Non-resident lending is capped and limited to some lenders",
      detail:
        "A non-resident applicant is capped at {ltv_cap} loan-to-value, and only a subset of UAE banks lend to non-residents at all. Pricing is usually higher.",
      metric: "ltv_cap",
      dd: "Confirm which lenders on the panel accept this nationality and country of residence before promising terms.",
    },
    {
      id: "off_plan_cap",
      when: "is_off_plan",
      severity: "info",
      title: "Off-plan purchase capped at 50%",
      detail:
        "Off-plan borrowing is capped at {ltv_cap} regardless of profile, so the deposit is at least half the price. Payment-plan instalments before handover are additional to this.",
      metric: "ltv_cap",
      dd: "Obtain the developer payment plan and confirm which instalments fall due before the mortgage draws down.",
    },
    {
      id: "second_property",
      when: "not is_first_property",
      severity: "info",
      title: "Second property — reduced loan-to-value",
      detail: "A subsequent property caps the loan at {ltv_cap}, requiring a materially larger deposit than a first purchase.",
      metric: "ltv_cap",
      dd: "Confirm with the Land Department whether the buyer holds any other UAE property, including jointly.",
    },
    {
      id: "comfortable",
      when: "resulting_dbr <= 0.40 and cash_surplus > 0",
      severity: "positive",
      title: "Comfortably within lending criteria",
      detail:
        "Debt burden ratio of {resulting_dbr} sits well inside the {dbr_cap} cap, and the buyer has {cash_surplus} of cash beyond the {cash_required} required to complete.",
      metric: "resulting_dbr",
    },
    {
      id: "stress_gap",
      when: "monthly_payment_stressed > monthly_payment * 1.15",
      severity: "amber",
      title: "Payment rises sharply under the stress rate",
      detail:
        "At the quoted rate the payment is {monthly_payment}; stressed it is {monthly_payment_stressed}. The buyer should be shown the stressed figure before committing, since a fixed period will revert.",
      metric: "monthly_payment_stressed",
      dd: "Confirm the fixed period, the reversion margin over EIBOR, and the early settlement fee.",
    },
  ],

  methodology:
    "Maximum borrowing is the lower of two independent ceilings. The income ceiling is the present value of the affordable monthly payment — the debt burden ratio applied to assessed income, less existing commitments — discounted at a stressed rate over the eligible term. The deposit ceiling is the UAE Central Bank loan-to-value cap for the applicant's profile, the property price and whether the purchase is off-plan. The eligible term is the shortest of the requested term, the regulatory maximum and the years remaining to the maturity age. Cash to complete is the resulting deposit plus DLD, agency, mortgage registration, arrangement and fixed fees. Every threshold is an editable input, not a constant, so a broker can follow their lender's actual policy. This is an affordability indication for discussion, not a credit decision or a lending offer.",
};
