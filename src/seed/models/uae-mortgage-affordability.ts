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
      help: "Drives the Central Bank loan-to-value ceiling. Non-residents are capped well below residents.",
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
      help: "Sets the maximum age at loan maturity: 65 for salaried, 70 for self-employed.",
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
      help: "From the Emirates ID or passport. Caps the term, because the loan must be repaid by the maturity age.",
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
      help: "Basic salary plus fixed allowances, from the salary certificate. Most lenders discount variable commission.",
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
      help: "Rental or other documented recurring income. Lenders typically haircut rental income — see the haircut input.",
    },
    {
      key: "other_income_haircut",
      label: "Haircut applied to other income",
      group: "Income",
      type: "percent",
      default: 0.2,
      min: 0,
      max: 1,
      help: "Banks rarely credit non-salary income in full. 20% is a common discount on documented rental income.",
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
      help: "Personal loans, car finance and any existing mortgage, from the liability letter or bank statements.",
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
      help: "The LIMIT, not the balance. UAE lenders assume a monthly commitment of a fixed percentage of the total limit even when the card is paid off.",
    },
    {
      key: "credit_card_charge_rate",
      label: "Credit card commitment rate",
      group: "Commitments",
      type: "percent",
      default: 0.05,
      min: 0,
      max: 0.2,
      help: "The share of the card limit counted as a monthly commitment. 5% is the standard UAE assumption.",
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
      help: "The agreed purchase price. The AED 5,000,000 line changes the LTV ceiling.",
    },
    {
      key: "is_first_property",
      label: "First property in the UAE",
      group: "Property",
      type: "boolean",
      default: true,
      extract: true,
      help: "A second or subsequent property carries a materially lower LTV ceiling.",
    },
    {
      key: "is_off_plan",
      label: "Off-plan purchase",
      group: "Property",
      type: "boolean",
      default: false,
      extract: true,
      help: "Off-plan borrowing is capped at 50% regardless of the applicant's profile.",
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
      help: "The rate actually quoted. Fixed-period rates revert to EIBOR plus a margin, which is what the stress rate is for.",
    },
    {
      key: "stress_uplift",
      label: "Affordability stress uplift",
      group: "Facility",
      type: "percent",
      default: 0.02,
      min: 0,
      max: 0.1,
      help: "Lenders test affordability at a rate above the quoted one. 200bps is a common assumption; set it to your lender's policy.",
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
      help: "Capped at 25 years by regulation and further capped by the applicant's age at maturity.",
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
      help: "The Central Bank ceiling on residential mortgage tenor.",
    },
    {
      key: "dbr_cap",
      label: "Debt burden ratio cap",
      group: "Facility",
      type: "percent",
      default: 0.5,
      min: 0.1,
      max: 0.8,
      help: "Total monthly debt service as a share of gross income. The Central Bank ceiling is 50%; some lenders apply less.",
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
      help: "The loan must be fully repaid by this age.",
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
      help: "Self-employed applicants are usually allowed five more years than salaried.",
    },

    // ---- completion costs --------------------------------------------
    {
      key: "dld_fee_pct",
      label: "DLD transfer fee",
      group: "Completion costs",
      type: "percent",
      default: 0.04,
      help: "4% of the price. Legally split, in practice paid entirely by the buyer.",
    },
    {
      key: "agency_fee_pct",
      label: "Agency commission",
      group: "Completion costs",
      type: "percent",
      default: 0.02,
      help: "2% plus 5% VAT is the market standard on a resale.",
    },
    {
      key: "mortgage_reg_pct",
      label: "Mortgage registration fee",
      group: "Completion costs",
      type: "percent",
      default: 0.0025,
      help: "0.25% of the loan amount, plus a fixed admin charge.",
    },
    {
      key: "bank_arrangement_pct",
      label: "Bank arrangement fee",
      group: "Completion costs",
      type: "percent",
      default: 0.01,
      help: "Typically 0.5%-1.0% of the loan, often negotiable.",
    },
    {
      key: "fixed_completion_costs",
      label: "Fixed completion costs",
      group: "Completion costs",
      type: "currency",
      unit: "AED",
      default: 12000,
      help: "Trustee office fee, title deed issuance, valuation and conveyancing, taken together.",
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
      help: "From the bank statements. Compared against the total cash needed to complete.",
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
      help: "Salary in full, other income after the lender's haircut.",
    },
    {
      key: "card_commitment",
      label: "Credit card commitment",
      group: "Affordability",
      formula: "credit_card_limits * credit_card_charge_rate",
      format: "currency",
      unit: "AED/month",
      help: "Counted on the limit, not the balance — a paid-off card still reduces borrowing power.",
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
      help: "The debt burden ratio ceiling applied to assessed income.",
    },
    {
      key: "available_for_mortgage",
      label: "Available for mortgage repayment",
      group: "Affordability",
      formula: "max(0, dbr_allowance - total_existing_commitments)",
      format: "currency",
      unit: "AED/month",
      emphasis: "strong",
      help: "What is left for a mortgage after existing commitments are deducted from the allowance.",
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
      help: "The shortest of what was asked for, what regulation allows, and what the applicant's age permits.",
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
      help: "Affordability is assessed at this rate, not at the headline rate.",
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
      help: "How much the buyer's income supports, stress-tested.",
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
      help: "UAE Central Bank ceiling for this applicant profile, property price and purchase type.",
    },
    {
      key: "max_loan_by_ltv",
      label: "Maximum loan on deposit rules",
      group: "Borrowing capacity",
      formula: "property_price * ltv_cap",
      format: "currency",
      unit: "AED",
      emphasis: "strong",
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
      help: "The lower of what income supports and what the deposit rules allow.",
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
      help: "Income-bound means more deposit will not help. Deposit-bound means it will.",
    },
    {
      key: "achieved_ltv",
      label: "Loan to value achieved",
      group: "Borrowing capacity",
      formula: "max_loan / property_price",
      format: "percent",
    },
    {
      key: "monthly_payment",
      label: "Monthly payment at the quoted rate",
      group: "Borrowing capacity",
      formula: "pmt(interest_rate / 12, term_months, max_loan)",
      format: "currency",
      unit: "AED/month",
      emphasis: "strong",
    },
    {
      key: "monthly_payment_stressed",
      label: "Monthly payment if stressed",
      group: "Borrowing capacity",
      formula: "pmt(monthly_stress_rate, term_months, max_loan)",
      format: "currency",
      unit: "AED/month",
      help: "What the payment becomes at the stressed rate — the number to show a buyer before they commit.",
    },
    {
      key: "resulting_dbr",
      label: "Resulting debt burden ratio",
      group: "Affordability",
      formula: "(monthly_payment + total_existing_commitments) / assessed_income",
      format: "percent",
      emphasis: "strong",
      help: "Total debt service over assessed income. Must sit at or below the cap.",
    },

    // ---- cash to complete ---------------------------------------------
    {
      key: "down_payment",
      label: "Down payment",
      group: "Cash to complete",
      formula: "property_price - max_loan",
      format: "currency",
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
      help: "Deposit plus every fee. This is the number a buyer actually needs on the day.",
    },
    {
      key: "cash_surplus",
      label: "Cash surplus or shortfall",
      group: "Cash to complete",
      formula: "buyer_available_cash - cash_required",
      format: "currency",
      unit: "AED",
      emphasis: "strong",
      help: "Negative means the purchase cannot complete at this price.",
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
      help: "The highest price this buyer's cash covers, at the same LTV and fee assumptions.",
    },
    {
      key: "cost_to_price_ratio",
      label: "Costs as a share of price",
      group: "Cash to complete",
      formula: "total_transaction_costs / property_price",
      format: "percent",
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
