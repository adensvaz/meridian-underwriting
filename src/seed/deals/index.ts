// The six demo deals.
//
// EVERYTHING HERE IS FICTIONAL. Marisol Residences, Azura Tower, Vireo Villas,
// Meridian Court, Lakeside Podium and Halcyon Logistics do not exist. The
// developers, brokers, managing agents, tenants and Ejari registration numbers
// are invented. The figures are plausible Dubai planning numbers prepared for a
// software demonstration; they are not an offer, a valuation, or investment
// advice. Every seeded deal also carries that statement in its `notes` column so
// it is visible in the product, not only in this file.
//
// THE CONTRACT THIS FILE MUST OBEY
//
// 1. `field.key` must be an input key of the deal's model, exactly as declared
//    in src/seed/models/*.ts. The engine reads inputs by key and silently
//    ignores anything it does not recognise, so a typo here is a wrong number
//    on screen rather than an error.
//
//    The models do NOT share a vocabulary. dubai-residential-quick calls the
//    passing rent `contract_rent`; dubai-residential-full calls it
//    `in_place_rent`; dubai-commercial-full has no rent total at all and takes
//    `rent_psf` x `nla_sqft` x `occupancy`. Check the model, do not assume.
//
// 2. `snippet` must appear verbatim in the generated text of the cited
//    document, or provenance click-through lands on nothing. Snippets are built
//    with the same kv() / tenancyRow() helpers the renderer uses so they cannot
//    drift, and the seeder asserts every one of them is present.
//
// 3. src/lib/underwrite.ts derives some inputs from the rent-roll and T12 tables
//    and those DERIVATIONS OUTRANK extracted fields. In practice:
//      - `size_sqft` (residential models) is the sum of rent-roll areas
//      - `cheque_count` is the modal rent-roll cheque count
//    so the tenancy rows below must foot to the areas and cheque counts the
//    fixtures claim. They do; changing one means changing the other.
//
// 4. `nla_sqft` (commercial) is NOT derived, because the commercial models name
//    the input differently. The rent roll is still made to foot to it.

import type { Value } from "../../lib/engine/expr.ts";
import type { DealFacts, DocKind, SeedT12Line, SeedTenancy } from "./documents.ts";
import { expiryConcentration, kv, money, num, pct, psf, tenancyRow, toSqm } from "./documents.ts";

// ------------------------------------------------------------------- types ---

/** One AI-extracted field, with the provenance the review screen renders. */
export interface SeedField {
  key: string;
  value: Value;
  confidence: number;
  doc: DocKind;
  page?: number;
  sheet?: string;
  snippet: string;
  unit?: string;
}

/**
 * A value the reviewer typed. Two flavours, both legitimate:
 *   - a CORRECTION, where an ai_value also exists and the two disagree; this is
 *     what the review screen exists to show.
 *   - an ASSUMPTION, where no document states it and the analyst supplies it.
 */
export interface SeedUserField {
  key: string;
  value: Value;
  note: string;
}

export interface SeedDeal {
  name: string;
  address: string;
  community: string;
  city: string;
  country: string;
  assetType: string;
  tenure: string;
  market: string;
  currency: string;
  depth: "quick" | "full";
  /** Resolved to a model_id with repo.findModelByKey at seed time. */
  modelKey: string;
  notes: string;
  facts: DealFacts;
  fields: SeedField[];
  userFields: SeedUserField[];
}

// ----------------------------------------------------------------- helpers ---

function om(key: string, value: Value, confidence: number, page: number, snippet: string, unit?: string): SeedField {
  return { key, value, confidence, doc: "om", page, snippet, unit };
}

function rr(key: string, value: Value, confidence: number, sheet: string, snippet: string, unit?: string): SeedField {
  return { key, value, confidence, doc: "rent_roll", sheet, snippet, unit };
}

function t12(key: string, value: Value, confidence: number, sheet: string, snippet: string, unit?: string): SeedField {
  return { key, value, confidence, doc: "t12", sheet, snippet, unit };
}

/** The area line as the OM renders it, so a snippet matches character for character. */
function areaLine(label: string, sqft: number): string {
  return kv(label, `${num(sqft)} sqft (${toSqm(sqft)} sqm)`);
}

/** The rent-roll summary lines, rebuilt exactly as generateRentRoll writes them. */
const rrTotalRent = (rent: number): string => kv("Total passing rent", money(rent));
const rrOccupancy = (occ: number): string => kv("Occupancy by area", pct(occ, 2));
const rrPassingPsf = (psfValue: number): string => kv("Passing rent per occupied sqft", psf(psfValue));
const rrExpiryShare = (share: number): string => kv("Largest single-year expiry (by rent)", pct(share, 1));

const FICTION_NOTE =
  "FICTIONAL DEMO DATA. This property, its tenants, its Ejari registrations and " +
  "every figure attached to it are synthetic, created to demonstrate Meridian's " +
  "Dubai underwriting. It is not an offer, a valuation, or investment advice.";

// =============================================================== 1. MARISOL ==
// The RERA set piece. A JVC one-bedroom that screens as a 7.43% gross yielder,
// but the in-place rent sits 14% under the DLD Smart Rental Index, which under
// the RERA increase table permits a 5% renewal increase and nothing more. The
// reversion is real and it is slow. At the 75% LTV the buyer wants, the debt
// service eats almost all of the NOI.

const MARISOL_TENANCIES: SeedTenancy[] = [
  {
    unit: "1204",
    unitType: "1 BR Apartment",
    areaSqft: 780,
    tenant: "R. Balakrishnan (individual)",
    annualRent: 78_000,
    cheques: 4,
    ejari: "EJ-2025-0447213",
    leaseStart: "2025-11-01",
    leaseEnd: "2026-10-31",
    status: "occupied",
    beds: 1,
    baths: 1.5,
    // ERV on a fresh letting. The residential model derives its `market_rent`
    // input from the sum of these, so leaving it null would silently make the
    // market rent equal the in-place rent.
    marketRent: 90_000,
    confidence: 0.95,
  },
];

// The district cooling capacity charge does NOT appear here: the Empower
// account is in the tenant's name (chiller_borne_by = "tenant"), so it never
// touches the landlord's statement. Putting a recharged cost on both sides of
// a statement inflates t12_opex_total and makes the model's OpEx look wrong
// against a T12 it actually agrees with.
const MARISOL_T12: SeedT12Line[] = [
  { label: "Residential Rent - Unit 1204 (Ejari EJ-2025-0447213)", section: "income", category: "rent", amount: 78_000, pattern: "cheque", cheques: 4, confidence: 0.96 },

  { label: "Service Charge - Owners Association (Mollak)", section: "opex", category: "service_charge", amount: 9_750, pattern: "quarterly", confidence: 0.95 },
  { label: "Reserve Fund Contribution", section: "opex", category: "reserve_fund", amount: 975, pattern: "quarterly", confidence: 0.92 },
  { label: "Property Management Fee", section: "opex", category: "management", amount: 4_680, pattern: "cheque", cheques: 4, confidence: 0.93 },
  { label: "Building Insurance - Landlord Liability & Contents", section: "opex", category: "insurance", amount: 525, pattern: "oneoff", monthIndex: 0, confidence: 0.9 },
  { label: "Repairs & Maintenance", section: "opex", category: "repairs", amount: 2_340, pattern: "even", confidence: 0.88 },
  { label: "AC Servicing Contract - 2 Visits", section: "opex", category: "repairs", amount: 630, pattern: "semiannual", confidence: 0.89 },
  { label: "Ejari Registration & Renewal", section: "opex", category: "compliance", amount: 220, pattern: "oneoff", monthIndex: 2, confidence: 0.94 },
  { label: "Leasing Commission - Renewal", section: "opex", category: "leasing", amount: 1_950, pattern: "oneoff", monthIndex: 3, confidence: 0.9 },
  { label: "Bank Charges - Post-Dated Cheque Handling", section: "opex", category: "bank", amount: 180, pattern: "even", confidence: 0.87 },
  { label: "DEWA - Landlord Account During Void", section: "opex", category: "utilities", amount: 340, pattern: "oneoff", monthIndex: 9, confidence: 0.84 },

  {
    label: "One-off Lift Modernisation Levy - Tower B",
    section: "opex",
    category: "capital",
    amount: 3_400,
    pattern: "oneoff",
    monthIndex: 5,
    recurring: false,
    excludeReason: "One-off lift modernisation levy — capital item, excluded from stabilised NOI",
    confidence: 0.93,
  },
  {
    label: "Backdated 2024 Service Charge True-Up (Mollak)",
    section: "opex",
    category: "service_charge",
    amount: 1_180,
    pattern: "oneoff",
    monthIndex: 8,
    recurring: false,
    excludeReason: "Prior-year Mollak true-up — non-recurring timing item, excluded from stabilised NOI",
    confidence: 0.88,
  },
];

const MARISOL_FACTS: DealFacts = {
  propertyName: "Marisol Residences",
  unitLabel: "Tower B, Unit 1204",
  community: "Jumeirah Village Circle (JVC)",
  locality: "District 12, off Al Khail Road",
  assetLine: "Residential apartment — 1 bedroom",
  areaLabel: "Suite area",
  areaSqft: 780,
  developer: "Almeria Developments LLC",
  handover: "Q2 2023",
  buildingAgeYears: 3,
  tenure: "Freehold",
  tenureNote: "Designated freehold area — open to all nationalities",
  parking: "1 allocated bay, basement level B1",
  pitch:
    "Tenanted one-bedroom in a 2023 tower carrying a Mollak service charge of AED 12.50/sqft, well inside the JVC band, with an in-place rent standing materially below the published rental index.",

  price: 1_050_000,
  pricePsf: 1_050_000 / 780,
  compLow: 1_150,
  compHigh: 1_450,

  annualRent: 78_000,
  cheques: 4,
  rentPsf: 78_000 / 780,
  grossYield: 78_000 / 1_050_000,
  reraIndexRent: 90_700,

  serviceChargePsf: 12.5,
  serviceChargeTotal: 9_750,
  chillerBorneBy: "Borne by the tenant — Empower account in the tenant's name",
  vatTreatment: "Residential lease — VAT exempt; input VAT on service charge and management fee is not recoverable",

  buyerProfile: "Expatriate resident individual, UAE residence visa",
  ltv: 0.75,
  loanAmount: 787_500,
  rateText: "4.49% fixed for 3 years, reverting to 3M EIBOR + 1.75%",
  ratePct: 0.0449,
  loanTermYears: 25,
  ioPeriodYears: 0,

  omFilename: "Marisol-Residences-JVC-Teaser.pdf",
  rentRollFilename: "Marisol-RentRoll-Aug26.xlsx",
  t12Filename: "Marisol-Collections-12M.xlsx",
  t12PeriodEnd: "2026-07-31",
  rentRollAsAt: "2026-08-01",
  broker: "Almanara Real Estate Advisory · Dubai",
  managingAgent: "Nurah Property Management LLC",

  tenancies: MARISOL_TENANCIES,
  t12Lines: MARISOL_T12,
};

const MARISOL: SeedDeal = {
  name: "Marisol Residences, JVC",
  address: "Tower B, Unit 1204, District 12",
  community: "Jumeirah Village Circle (JVC)",
  city: "Dubai",
  country: "AE",
  assetType: "residential",
  tenure: "freehold",
  market: "AE",
  currency: "AED",
  depth: "full",
  modelKey: "dubai-residential-full",
  notes:
    `${FICTION_NOTE}\n\n` +
    "Demo focus — the RERA cap. The in-place rent of AED 78,000 sits 14% below " +
    "the DLD Smart Rental Index reference of AED 90,700. That is reversionary, " +
    "but it cannot be taken in one step: the RERA increase table permits a 5% " +
    "increase only on the renewal of a subsisting tenancy in the 11-20% band. " +
    "The gap closes over several renewals, not at the first one. Watch also what " +
    "75% leverage does to DSCR on a AED 1.05m ticket. Below the AED 2m Golden " +
    "Visa threshold.",
  facts: MARISOL_FACTS,
  fields: [
    om("price", 1_050_000, 0.96, 1, kv("Asking price", money(1_050_000)), "AED"),
    om("size_sqft", 780, 0.94, 1, areaLine("Suite area", 780), "sqft"),
    om("property_type", "apartment", 0.95, 1, kv("Asset type", "Residential apartment — 1 bedroom")),
    om("community", "Jumeirah Village Circle (JVC)", 0.96, 1, kv("Community", "Jumeirah Village Circle (JVC)")),
    // Inferred from "Handover Q2 2023" rather than stated outright — low confidence
    // on purpose, so the review screen has something to argue with.
    om("building_age_years", 3, 0.62, 1, kv("Building age at completion", "3 years"), "years"),
    om("tenure", "freehold", 0.93, 1, kv("Tenure", "Freehold")),
    om("community_price_psf_low", 1_150, 0.58, 1, kv("Recent DLD transacted range", `${psf(1_150, 0)} to ${psf(1_450, 0)}`), "AED/sqft"),
    om("community_price_psf_high", 1_450, 0.58, 1, kv("Recent DLD transacted range", `${psf(1_150, 0)} to ${psf(1_450, 0)}`), "AED/sqft"),
    om("rera_index_rent", 90_700, 0.89, 2, kv("DLD Smart Rental Index (RERA)", money(90_700)), "AED"),
    om("chiller_borne_by", "tenant", 0.9, 2, kv("District cooling capacity charge", MARISOL_FACTS.chillerBorneBy)),
    om("ltv", 0.75, 0.9, 3, kv("Loan to value", pct(0.75, 0))),
    om("interest_rate", 0.0449, 0.88, 3, kv("Indicative rate", MARISOL_FACTS.rateText)),
    om("loan_term_years", 25, 0.91, 3, kv("Tenor", "25 years"), "years"),
    om("io_period_years", 0, 0.9, 3, kv("Amortisation", "Fully amortising, monthly instalments"), "years"),

    rr("in_place_rent", 78_000, 0.97, "Tenancy Schedule", rrTotalRent(78_000), "AED"),
    rr("is_vacant", false, 0.92, "Tenancy Schedule", tenancyRow(MARISOL_TENANCIES[0])),
    rr("cheque_count", 4, 0.95, "Tenancy Schedule", tenancyRow(MARISOL_TENANCIES[0])),
    rr("rent_regime", "rera_capped_renewal", 0.86, "Notes", "Renewal regime assumed: existing tenant renews, RERA cap applies."),
    rr("market_rent", 90_000, 0.79, "Tenancy Schedule", kv("Total ERV (market rent, all units)", money(90_000)), "AED"),

    // Taken from the managing agent's statement rather than the teaser: an
    // Owners Association budget on an issued statement is evidence, the same
    // figure on a broker's flyer is a claim.
    t12("service_charge_budget_psf", 12.5, 0.93, "Operating Statement", kv("Service charge (OA budget)", `${psf(12.5)}/yr`), "AED/sqft/yr"),
  ],
  userFields: [
    {
      key: "buyer_profile",
      value: "expat_resident",
      note: "Purchaser is an expatriate resident individual on a UAE residence visa. Sets the 80% regulatory LTV ceiling below AED 5m, so the 75% requested is inside the cap.",
    },
    {
      key: "exit_cap_rate",
      value: 0.055,
      note: "Exit assumption for a JVC one-bedroom at the end of a five-year hold. Analyst input — the teaser states no exit basis.",
    },
  ],
};

// ================================================================= 2. AZURA ==
// The quick screen. Same engine, shorter model: no projection, no IRR, just the
// stabilised year. A prime Marina two-bedroom over the Golden Visa threshold,
// and the demo's second story — the broker quoted a stale service charge and
// the reviewer corrected it from the managing agent's statement.

const AZURA_TENANCIES: SeedTenancy[] = [
  {
    unit: "2704",
    unitType: "2 BR Apartment",
    areaSqft: 1_320,
    tenant: "Lindqvist Family (individual)",
    annualRent: 210_000,
    cheques: 2,
    ejari: "EJ-2026-0113908",
    leaseStart: "2026-02-01",
    leaseEnd: "2027-01-31",
    status: "occupied",
    beds: 2,
    baths: 3,
    marketRent: 218_000,
    confidence: 0.95,
  },
];

const AZURA_T12: SeedT12Line[] = [
  { label: "Residential Rent - Unit 2704 (Ejari EJ-2026-0113908)", section: "income", category: "rent", amount: 210_000, pattern: "cheque", cheques: 2, confidence: 0.96 },

  { label: "Service Charge - Owners Association (Mollak)", section: "opex", category: "service_charge", amount: 22_440, pattern: "quarterly", confidence: 0.95 },
  { label: "Reserve Fund Contribution", section: "opex", category: "reserve_fund", amount: 2_244, pattern: "quarterly", confidence: 0.92 },
  { label: "Property Management Fee", section: "opex", category: "management", amount: 12_600, pattern: "cheque", cheques: 2, confidence: 0.93 },
  { label: "Building Insurance - Landlord Liability & Contents", section: "opex", category: "insurance", amount: 1_650, pattern: "oneoff", monthIndex: 0, confidence: 0.9 },
  { label: "Repairs & Maintenance", section: "opex", category: "repairs", amount: 5_280, pattern: "even", confidence: 0.88 },
  { label: "AC & Appliance Servicing Contract", section: "opex", category: "repairs", amount: 1_900, pattern: "semiannual", confidence: 0.89 },
  { label: "Ejari Registration & Renewal", section: "opex", category: "compliance", amount: 220, pattern: "oneoff", monthIndex: 6, confidence: 0.94 },
  { label: "Leasing Commission - New Tenancy", section: "opex", category: "leasing", amount: 10_500, pattern: "oneoff", monthIndex: 6, confidence: 0.91 },
  { label: "Bank Charges - Post-Dated Cheque Handling", section: "opex", category: "bank", amount: 120, pattern: "even", confidence: 0.87 },
  { label: "DEWA - Landlord Account During Void", section: "opex", category: "utilities", amount: 680, pattern: "oneoff", monthIndex: 5, confidence: 0.85 },

  {
    label: "Facade & Balcony Waterproofing Special Levy",
    section: "opex",
    category: "capital",
    amount: 14_800,
    pattern: "oneoff",
    monthIndex: 4,
    recurring: false,
    excludeReason: "One-off facade and balcony waterproofing levy — capital item, excluded from stabilised NOI",
    confidence: 0.92,
  },
  {
    label: "Owners Association Reserve Top-Up (2025 arrears)",
    section: "opex",
    category: "reserve_fund",
    amount: 3_600,
    pattern: "oneoff",
    monthIndex: 9,
    recurring: false,
    excludeReason: "Prior-year Owners Association reserve top-up — non-recurring, excluded from stabilised NOI",
    confidence: 0.86,
  },
];

const AZURA_FACTS: DealFacts = {
  propertyName: "Azura Tower",
  unitLabel: "Unit 2704, Level 27",
  community: "Dubai Marina",
  locality: "Marina Promenade, west side",
  assetLine: "Residential apartment — 2 bedroom",
  areaLabel: "Suite area",
  areaSqft: 1_320,
  developer: "Corvara Waterfront Developments",
  handover: "Q4 2018",
  buildingAgeYears: 8,
  tenure: "Freehold",
  tenureNote: "Designated freehold area — open to all nationalities",
  parking: "2 allocated bays, podium level P3",
  pitch:
    "Full marina-facing two-bedroom on the twenty-seventh floor, let on two cheques to a long-standing tenant, and comfortably over the AED 2m Golden Visa threshold.",

  price: 3_300_000,
  pricePsf: 3_300_000 / 1_320,
  compLow: 2_150,
  compHigh: 2_900,

  annualRent: 210_000,
  cheques: 2,
  rentPsf: 210_000 / 1_320,
  grossYield: 210_000 / 3_300_000,
  reraIndexRent: 218_000,

  serviceChargePsf: 17,
  serviceChargeTotal: 22_440,
  // The broker is quoting the 2024 budget; the agent's statement carries 17.00.
  quotedServiceChargePsf: 15.5,
  chillerBorneBy: "Borne by the tenant — Empower account in the tenant's name",
  vatTreatment: "Residential lease — VAT exempt; input VAT on service charge and management fee is not recoverable",

  buyerProfile: "Non-resident individual, no UAE residence visa",
  ltv: 0.55,
  loanAmount: 1_815_000,
  rateText: "4.99% fixed for 5 years, reverting to 3M EIBOR + 1.90%",
  ratePct: 0.0499,
  loanTermYears: 20,
  ioPeriodYears: 0,

  omFilename: "Azura-Tower-Marina-2BR-Teaser.pdf",
  rentRollFilename: "Azura-2704-Tenancy-Aug26.xlsx",
  t12Filename: "Azura-2704-Collections-12M.xlsx",
  t12PeriodEnd: "2026-07-31",
  rentRollAsAt: "2026-08-01",
  broker: "Almanara Real Estate Advisory · Dubai",
  managingAgent: "Nurah Property Management LLC",

  tenancies: AZURA_TENANCIES,
  t12Lines: AZURA_T12,
};

const AZURA: SeedDeal = {
  name: "Azura Tower, Dubai Marina",
  address: "Unit 2704, Level 27, Azura Tower, Marina Promenade",
  community: "Dubai Marina",
  city: "Dubai",
  country: "AE",
  assetType: "residential",
  tenure: "freehold",
  market: "AE",
  currency: "AED",
  depth: "quick",
  modelKey: "dubai-residential-quick",
  notes:
    `${FICTION_NOTE}\n\n` +
    "Demo focus — the quick screen. This deal runs the short model: stabilised " +
    "year only, no projection and no IRR, which is how a broker's e-mail gets " +
    "triaged in ninety seconds. It also carries the reviewer correction: the " +
    "teaser quotes a service charge of AED 15.50/sqft from a superseded budget, " +
    "while the managing agent's twelve-month statement shows the Mollak-approved " +
    "AED 17.00/sqft. Both values are kept and both are visible. Above the AED 2m " +
    "Golden Visa threshold.",
  facts: AZURA_FACTS,
  fields: [
    om("price", 3_300_000, 0.97, 1, kv("Asking price", money(3_300_000)), "AED"),
    om("size_sqft", 1_320, 0.95, 1, areaLine("Suite area", 1_320), "sqft"),
    om("property_type", "apartment", 0.96, 1, kv("Asset type", "Residential apartment — 2 bedroom")),
    // Extracted at low confidence because the teaser hedges it, and wrong — see
    // the reviewer's correction below.
    om("service_charge_budget_psf", 15.5, 0.66, 2, kv("Service charge (OA budget)", `${psf(15.5)}/yr`), "AED/sqft/yr"),
    om("vat_treatment", "exempt_residential", 0.9, 2, kv("VAT treatment", AZURA_FACTS.vatTreatment)),
    om("ltv", 0.55, 0.9, 3, kv("Loan to value", pct(0.55, 0))),
    om("interest_rate", 0.0499, 0.89, 3, kv("Indicative rate", AZURA_FACTS.rateText)),
    om("loan_term_years", 20, 0.92, 3, kv("Tenor", "20 years"), "years"),

    // dubai-residential-quick calls the passing rent `contract_rent`, not
    // `in_place_rent`. Different model, different vocabulary.
    rr("contract_rent", 210_000, 0.96, "Tenancy Schedule", rrTotalRent(210_000), "AED"),
    rr("cheque_count", 2, 0.94, "Tenancy Schedule", tenancyRow(AZURA_TENANCIES[0])),
  ],
  userFields: [
    {
      key: "service_charge_budget_psf",
      value: 17,
      note:
        "Corrected from the teaser. The OM quotes AED 15.50/sqft from the 2024 budget; " +
        "the managing agent's twelve-month statement shows the current Mollak-approved " +
        "Owners Association budget at AED 17.00/sqft, or AED 22,440 a year on 1,320 sqft. " +
        "The higher figure is the one that will actually be billed.",
    },
  ],
};

// ================================================================= 3. VIREO ==
// The leverage set piece. A prime Dubai Hills villa bought for capital growth
// on a 5.16% gross yield at 70% LTV — the regulatory ceiling for a UAE national
// above AED 5m. The rent does not cover the debt. The DSCR covenant flag fires,
// and it should.

const VIREO_TENANCIES: SeedTenancy[] = [
  {
    unit: "V-14",
    unitType: "4 BR Villa",
    areaSqft: 3_600,
    tenant: "Al Reyami Family (individual)",
    annualRent: 330_000,
    cheques: 1,
    ejari: "EJ-2025-0982441",
    leaseStart: "2025-09-15",
    leaseEnd: "2026-09-14",
    status: "occupied",
    beds: 4,
    baths: 5,
    marketRent: 358_000,
    confidence: 0.94,
  },
];

// Landlord scope only. Under a standard Dubai villa tenancy the tenant carries
// the garden, the pool water and chemicals, pest control and its own DEWA, so
// none of those belong on the owner's statement. Pool PLANT (the pump and
// filtration the landlord owns) does.
const VIREO_T12: SeedT12Line[] = [
  { label: "Villa Rent - V-14 (Ejari EJ-2025-0982441)", section: "income", category: "rent", amount: 330_000, pattern: "cheque", cheques: 1, confidence: 0.97 },

  { label: "Service Charge - Master Community (Mollak)", section: "opex", category: "service_charge", amount: 15_300, pattern: "quarterly", confidence: 0.95 },
  { label: "Reserve Fund Contribution", section: "opex", category: "reserve_fund", amount: 1_530, pattern: "quarterly", confidence: 0.91 },
  { label: "Property Management Fee", section: "opex", category: "management", amount: 19_800, pattern: "oneoff", monthIndex: 0, confidence: 0.93 },
  { label: "Building Insurance - Villa Structure & Liability", section: "opex", category: "insurance", amount: 3_200, pattern: "oneoff", monthIndex: 0, confidence: 0.9 },
  { label: "Repairs & Maintenance - Landlord Scope", section: "opex", category: "repairs", amount: 8_400, pattern: "even", confidence: 0.87 },
  { label: "AC Servicing Contract - 4 Split Systems", section: "opex", category: "repairs", amount: 3_600, pattern: "semiannual", confidence: 0.89 },
  { label: "Pool Plant Servicing - Pump & Filtration", section: "opex", category: "repairs", amount: 4_200, pattern: "quarterly", confidence: 0.86 },
  { label: "Ejari Registration & Renewal", section: "opex", category: "compliance", amount: 220, pattern: "oneoff", monthIndex: 8, confidence: 0.94 },
  { label: "Leasing Commission - Renewal", section: "opex", category: "leasing", amount: 16_500, pattern: "oneoff", monthIndex: 8, confidence: 0.9 },

  {
    label: "Roof Membrane Replacement",
    section: "opex",
    category: "capital",
    amount: 38_500,
    pattern: "oneoff",
    monthIndex: 3,
    recurring: false,
    excludeReason: "One-off roof membrane replacement — capital item, excluded from stabilised NOI",
    confidence: 0.93,
  },
  {
    label: "Boundary Wall Repair after Storm Damage",
    section: "opex",
    category: "repairs",
    amount: 9_700,
    pattern: "oneoff",
    monthIndex: 6,
    recurring: false,
    excludeReason: "Storm damage repair, recovered under the buildings policy — non-recurring, excluded from stabilised NOI",
    confidence: 0.87,
  },
  {
    label: "Developer Snagging Rectification (final)",
    section: "opex",
    category: "capital",
    amount: 5_200,
    pattern: "oneoff",
    monthIndex: 1,
    recurring: false,
    excludeReason: "Final snagging rectification against the developer — non-recurring, excluded from stabilised NOI",
    confidence: 0.84,
  },
];

const VIREO_FACTS: DealFacts = {
  propertyName: "Vireo Villas",
  unitLabel: "Villa V-14, Parkside cluster",
  community: "Dubai Hills Estate",
  locality: "Parkside cluster, off Al Khail Road",
  assetLine: "Residential villa — 4 bedroom",
  areaLabel: "BUA (built-up area)",
  areaSqft: 3_600,
  plotSqft: 5_200,
  developer: "Corvara Communities LLC",
  handover: "Q1 2020",
  buildingAgeYears: 6,
  tenure: "Freehold",
  tenureNote: "Designated freehold area — open to all nationalities",
  parking: "2 covered bays plus driveway",
  pitch:
    "Four-bedroom family villa on a 5,200 sqft plot backing the park, let on a single annual cheque. Bought for the plot and the community, not for the running yield.",

  price: 6_400_000,
  pricePsf: 6_400_000 / 3_600,
  compLow: 1_600,
  compHigh: 2_050,

  annualRent: 330_000,
  cheques: 1,
  rentPsf: 330_000 / 3_600,
  grossYield: 330_000 / 6_400_000,
  reraIndexRent: 372_000,

  serviceChargePsf: 4.25,
  serviceChargeTotal: 15_300,
  chillerBorneBy: "Not applicable — split DX systems, no district cooling connection",
  vatTreatment: "Residential lease — VAT exempt; input VAT on service charge and management fee is not recoverable",

  buyerProfile: "UAE national individual",
  ltv: 0.7,
  loanAmount: 4_480_000,
  rateText: "4.25% fixed for 3 years, reverting to 3M EIBOR + 1.50%",
  ratePct: 0.0425,
  loanTermYears: 25,
  ioPeriodYears: 0,

  omFilename: "Vireo-Villas-DubaiHills-V14-Teaser.pdf",
  rentRollFilename: "Vireo-V14-Tenancy-Aug26.xlsx",
  t12Filename: "Vireo-V14-Operating-T12.xlsx",
  t12PeriodEnd: "2026-07-31",
  rentRollAsAt: "2026-08-01",
  broker: "Cordelle Residential · Dubai",
  managingAgent: "Beit Asset Services LLC",

  tenancies: VIREO_TENANCIES,
  t12Lines: VIREO_T12,
};

const VIREO: SeedDeal = {
  name: "Vireo Villas, Dubai Hills Estate",
  address: "Villa V-14, Parkside cluster, Dubai Hills Estate",
  community: "Dubai Hills Estate",
  city: "Dubai",
  country: "AE",
  assetType: "residential",
  tenure: "freehold",
  market: "AE",
  currency: "AED",
  depth: "full",
  modelKey: "dubai-residential-full",
  notes:
    `${FICTION_NOTE}\n\n` +
    "Demo focus — thin cover. At a 5.16% gross yield and the 70% LTV a UAE " +
    "national can draw above AED 5m, the debt service is larger than the NOI. " +
    "The DSCR covenant flag is supposed to fire here: this is a capital-growth " +
    "purchase that has to be funded out of the buyer's pocket, not out of the " +
    "rent, and the underwriting should say so before the bank does.",
  facts: VIREO_FACTS,
  fields: [
    om("price", 6_400_000, 0.96, 1, kv("Asking price", money(6_400_000)), "AED"),
    om("size_sqft", 3_600, 0.93, 1, areaLine("BUA (built-up area)", 3_600), "sqft"),
    om("property_type", "villa", 0.95, 1, kv("Asset type", "Residential villa — 4 bedroom")),
    om("community", "Dubai Hills Estate", 0.96, 1, kv("Community", "Dubai Hills Estate")),
    om("building_age_years", 6, 0.9, 1, kv("Building age at completion", "6 years"), "years"),
    om("tenure", "freehold", 0.94, 1, kv("Tenure", "Freehold")),
    om("community_price_psf_low", 1_600, 0.87, 1, kv("Recent DLD transacted range", `${psf(1_600, 0)} to ${psf(2_050, 0)}`), "AED/sqft"),
    om("community_price_psf_high", 2_050, 0.87, 1, kv("Recent DLD transacted range", `${psf(1_600, 0)} to ${psf(2_050, 0)}`), "AED/sqft"),
    // Villa index entries are thinner than apartment ones, hence the hedge.
    om("rera_index_rent", 372_000, 0.61, 2, kv("DLD Smart Rental Index (RERA)", money(372_000)), "AED"),
    om("chiller_borne_by", "none", 0.85, 2, kv("District cooling capacity charge", VIREO_FACTS.chillerBorneBy)),
    om("ltv", 0.7, 0.9, 3, kv("Loan to value", pct(0.7, 0))),
    om("interest_rate", 0.0425, 0.9, 3, kv("Indicative rate", VIREO_FACTS.rateText)),
    om("loan_term_years", 25, 0.92, 3, kv("Tenor", "25 years"), "years"),
    om("io_period_years", 0, 0.9, 3, kv("Amortisation", "Fully amortising, monthly instalments"), "years"),

    rr("in_place_rent", 330_000, 0.96, "Tenancy Schedule", rrTotalRent(330_000), "AED"),
    rr("is_vacant", false, 0.93, "Tenancy Schedule", tenancyRow(VIREO_TENANCIES[0])),
    rr("cheque_count", 1, 0.95, "Tenancy Schedule", tenancyRow(VIREO_TENANCIES[0])),
    rr("rent_regime", "rera_capped_renewal", 0.88, "Notes", "Renewal regime assumed: existing tenant renews, RERA cap applies."),
    rr("market_rent", 358_000, 0.77, "Tenancy Schedule", kv("Total ERV (market rent, all units)", money(358_000)), "AED"),

    t12("service_charge_budget_psf", 4.25, 0.91, "Operating Statement", kv("Service charge (OA budget)", `${psf(4.25)}/yr`), "AED/sqft/yr"),
  ],
  userFields: [
    {
      key: "maintenance_psf",
      value: 4.5,
      note:
        "Raised from the model's generic AED 3.00/sqft. A six-year-old villa with its own " +
        "pool plant and four split systems carries more landlord-scope maintenance than an " +
        "apartment; AED 4.50/sqft reconciles the build-up to the twelve-month statement.",
    },
    {
      key: "buyer_profile",
      value: "uae_national",
      note: "Purchaser is a UAE national. Above AED 5m the regulatory ceiling is 70%, which is exactly the leverage requested — there is no headroom to gear further.",
    },
    {
      key: "exit_cap_rate",
      value: 0.0475,
      note: "Prime Dubai Hills villas are priced off owner-occupier demand rather than off yield, so the exit cap sits well inside the entry running yield. Analyst input.",
    },
  ],
};

// ======================================================== 4. MERIDIAN COURT ==
// The commercial flagship. A half floor in Business Bay, demised into five
// suites, one of which is vacant — so occupancy is 91.18% and the passing rent
// on LET area (AED 170/sqft) is a different number from the headline rent on
// total NLA (AED 155/sqft). Getting those two the right way round is most of
// the job. Mainland LLC, so standard-rated VAT and corporate tax in scope.

const MERIDIAN_TENANCIES: SeedTenancy[] = [
  {
    unit: "Suite 1201",
    unitType: "Fitted office",
    areaSqft: 1_850,
    tenant: "Harkness Advisory Partners FZ-LLC",
    annualRent: 314_500,
    cheques: 4,
    ejari: "EJ-2024-0771204",
    leaseStart: "2024-10-01",
    leaseEnd: "2029-09-30",
    status: "occupied",
    confidence: 0.94,
    marketRent: 323_750,
  },
  {
    unit: "Suite 1202",
    unitType: "Fitted office",
    areaSqft: 1_420,
    tenant: "Delmar Logistics Consulting LLC",
    annualRent: 241_400,
    cheques: 4,
    ejari: "EJ-2025-0338117",
    leaseStart: "2025-04-01",
    leaseEnd: "2030-03-31",
    status: "occupied",
    confidence: 0.94,
    marketRent: 248_500,
  },
  {
    unit: "Suite 1203",
    unitType: "Shell & core, tenant fitted",
    areaSqft: 1_240,
    tenant: "Nooran Legal Consultants",
    annualRent: 210_800,
    cheques: 4,
    ejari: "EJ-2025-0611902",
    leaseStart: "2025-07-15",
    leaseEnd: "2029-07-14",
    status: "occupied",
    confidence: 0.92,
    marketRent: 217_000,
  },
  {
    unit: "Suite 1205",
    unitType: "Fitted office",
    areaSqft: 1_690,
    tenant: "Sarrazin Interiors Trading LLC",
    annualRent: 287_300,
    cheques: 4,
    ejari: "EJ-2024-0903455",
    leaseStart: "2024-12-01",
    leaseEnd: "2030-11-30",
    status: "occupied",
    confidence: 0.93,
    marketRent: 295_750,
  },
  {
    unit: "Suite 1206",
    unitType: "Fitted office",
    areaSqft: 600,
    tenant: "Vacant — being marketed",
    annualRent: null,
    cheques: null,
    ejari: null,
    leaseStart: null,
    leaseEnd: null,
    status: "vacant",
    marketRent: 105_000,
    confidence: 0.9,
  },
];

// Owner-level costs only. This is a strata half floor: building cleaning,
// manned reception and common-area DEWA are inside the Owners Association
// budget already captured on the "Service Charge - Owners Association" line,
// so listing them again would double count them and put the model's OpEx build
// 30% adrift of its own T12.
const MERIDIAN_T12: SeedT12Line[] = [
  { label: "Office Rent - Suite 1201 Harkness Advisory", section: "income", category: "rent", amount: 314_500, pattern: "cheque", cheques: 4, confidence: 0.95 },
  { label: "Office Rent - Suite 1202 Delmar Logistics", section: "income", category: "rent", amount: 241_400, pattern: "cheque", cheques: 4, confidence: 0.95 },
  { label: "Office Rent - Suite 1203 Nooran Legal", section: "income", category: "rent", amount: 210_800, pattern: "cheque", cheques: 4, confidence: 0.94 },
  { label: "Office Rent - Suite 1205 Sarrazin Interiors", section: "income", category: "rent", amount: 287_300, pattern: "cheque", cheques: 4, confidence: 0.94 },
  { label: "Service Charge Recovered from Tenants", section: "income", category: "sc_recovery", amount: 130_416, pattern: "quarterly", confidence: 0.9 },
  { label: "Car Park Licence Income - 12 Bays", section: "income", category: "other_income", amount: 43_200, pattern: "quarterly", confidence: 0.88 },

  { label: "Service Charge - Owners Association (Mollak)", section: "opex", category: "service_charge", amount: 149_600, pattern: "quarterly", confidence: 0.96 },
  { label: "Property Management Fee", section: "opex", category: "management", amount: 39_841, pattern: "cheque", cheques: 4, confidence: 0.93 },
  { label: "Building Insurance - Landlord Liability & Loss of Rent", section: "opex", category: "insurance", amount: 6_120, pattern: "oneoff", monthIndex: 0, confidence: 0.91 },
  { label: "Void Suite Service Charge - Suite 1206", section: "opex", category: "void_costs", amount: 13_200, pattern: "quarterly", confidence: 0.87 },
  { label: "Repairs & Maintenance - Demised Areas (landlord scope)", section: "opex", category: "repairs", amount: 9_800, pattern: "even", confidence: 0.88 },
  { label: "Cleaning - Suite 1206 & Marketing Presentation", section: "opex", category: "cleaning", amount: 3_600, pattern: "even", confidence: 0.86 },
  { label: "DEWA - Suite 1206 Landlord Account", section: "opex", category: "utilities", amount: 4_200, pattern: "even", confidence: 0.88 },
  { label: "Security - Out of Hours Access Control (landlord share)", section: "opex", category: "security", amount: 6_000, pattern: "quarterly", confidence: 0.85 },
  { label: "Ejari Registration & Renewals", section: "opex", category: "compliance", amount: 880, pattern: "oneoff", monthIndex: 3, confidence: 0.93 },
  { label: "Leasing Commission - Suite 1202 New Letting", section: "opex", category: "leasing", amount: 12_070, pattern: "oneoff", monthIndex: 7, confidence: 0.9 },

  {
    label: "Chilled Water Pump Replacement - Level 12 Riser",
    section: "opex",
    category: "capital",
    amount: 84_000,
    pattern: "oneoff",
    monthIndex: 5,
    recurring: false,
    excludeReason: "One-off chilled water pump replacement — capital item, excluded from stabilised NOI",
    confidence: 0.93,
  },
  {
    label: "Suite 1206 Reinstatement on Tenant Exit",
    section: "opex",
    category: "letting_costs",
    amount: 41_500,
    pattern: "oneoff",
    monthIndex: 9,
    recurring: false,
    excludeReason: "Reinstatement following a tenant exit — non-recurring letting cost, excluded from stabilised NOI",
    confidence: 0.89,
  },
  {
    label: "DCD Fire Alarm Panel Upgrade",
    section: "opex",
    category: "capital",
    amount: 28_600,
    pattern: "oneoff",
    monthIndex: 2,
    recurring: false,
    excludeReason: "Regulatory fire alarm panel upgrade — capital item, excluded from stabilised NOI",
    confidence: 0.9,
  },
];

const MERIDIAN_FACTS: DealFacts = {
  propertyName: "Meridian Court",
  unitLabel: "Half floor, Level 12",
  community: "Business Bay",
  locality: "Marasi Drive, canal side",
  assetLine: "Commercial office — half floor, five demised suites",
  areaLabel: "Net lettable area",
  areaSqft: 6_800,
  developer: "Corvara Commercial Developments",
  handover: "Q3 2014",
  buildingAgeYears: 12,
  tenure: "Freehold",
  tenureNote: "Designated freehold area — commercial strata title",
  parking: "12 allocated bays, basement levels B1 and B2",
  pitch:
    "Half floor demised into five suites, four let to established professional occupiers on four-cheque terms, one 600 sqft suite vacant and under offer. The service charge is fully recoverable.",

  price: 12_240_000,
  pricePsf: 12_240_000 / 6_800,
  compLow: 1_550,
  compHigh: 2_100,

  annualRent: 1_054_000,
  cheques: 4,
  // The teaser's headline: passing rent spread over TOTAL area. The rent roll
  // reports the passing rent on LET area, AED 170/sqft, and the model takes
  // that one because it is the honest measure of what the leases actually pay.
  rentPsf: 1_054_000 / 6_800,
  grossYield: 1_054_000 / 12_240_000,
  marketRentPsf: 175,
  waltYears: 3.5,
  occupancy: 6_200 / 6_800,
  largestTenantPct: 314_500 / 1_054_000,

  serviceChargePsf: 22,
  serviceChargeTotal: 149_600,
  quotedServiceChargePsf: 20,
  chillerBorneBy: "Borne by the tenants — recharged through the service charge",
  vatTreatment: "Commercial lease — standard-rated at 5%; input VAT recoverable by a registered owner",
  escalationNote: undefined,

  buyerProfile: "UAE mainland LLC, VAT-registered",
  ltv: 0.6,
  loanAmount: 7_344_000,
  rateText: "3M EIBOR + 2.25% floating (5.95% all-in at a 3M EIBOR of 3.70%)",
  ratePct: 0.0595,
  loanTermYears: 15,
  ioPeriodYears: 0,

  omFilename: "Meridian-Court-BusinessBay-OM.pdf",
  rentRollFilename: "MeridianCourt-TenancySchedule-Aug26.xlsx",
  t12Filename: "MeridianCourt-Operating-T12.xlsx",
  t12PeriodEnd: "2026-07-31",
  rentRollAsAt: "2026-08-01",
  broker: "Cordelle Commercial Advisory · Dubai",
  managingAgent: "Beit Asset Services LLC",

  tenancies: MERIDIAN_TENANCIES,
  t12Lines: MERIDIAN_T12,
};

const MERIDIAN: SeedDeal = {
  name: "Meridian Court, Business Bay",
  address: "Half floor, Level 12, Meridian Court, Marasi Drive",
  community: "Business Bay",
  city: "Dubai",
  country: "AE",
  assetType: "commercial",
  tenure: "freehold",
  market: "AE",
  currency: "AED",
  depth: "full",
  modelKey: "dubai-commercial-full",
  notes:
    `${FICTION_NOTE}\n\n` +
    "Demo focus — two different rents per square foot. The teaser quotes AED 155/sqft, " +
    "which is the passing rent spread over the whole 6,800 sqft NLA. The rent roll " +
    "reports AED 170/sqft, which is the passing rent on the 6,200 sqft actually let. " +
    "Suite 1206 is vacant, so occupancy is 91.18% and the two numbers are not the " +
    "same thing. The model takes rent/sqft on let area and multiplies back through " +
    "occupancy, which reproduces the AED 1,054,000 passing rent either way. " +
    "Mainland LLC: VAT standard-rated with input VAT recoverable, and UAE corporate " +
    "tax in scope at 9% above AED 375,000.",
  facts: MERIDIAN_FACTS,
  fields: [
    om("price", 12_240_000, 0.96, 1, kv("Asking price", money(12_240_000)), "AED"),
    om("nla_sqft", 6_800, 0.94, 1, areaLine("Net lettable area", 6_800), "sqft"),
    om("asset_subtype", "office", 0.96, 1, kv("Asset type", "Commercial office — half floor, five demised suites")),
    om("community", "Business Bay", 0.95, 1, kv("Community", "Business Bay")),
    om("building_age_years", 12, 0.88, 1, kv("Building age at completion", "12 years"), "years"),
    om("tenure", "freehold", 0.92, 1, kv("Tenure", "Freehold")),
    om("community_price_psf_low", 1_550, 0.83, 1, kv("Recent DLD transacted range", `${psf(1_550, 0)} to ${psf(2_100, 0)}`), "AED/sqft"),
    om("community_price_psf_high", 2_100, 0.83, 1, kv("Recent DLD transacted range", `${psf(1_550, 0)} to ${psf(2_100, 0)}`), "AED/sqft"),
    // WALT is a derived figure the teaser asserts rather than evidences, so it
    // goes in at low confidence and lands on the review screen.
    om("walt_years", 3.5, 0.64, 2, kv("WALT to expiry", "3.5 years"), "years"),
    om("largest_tenant_pct", 314_500 / 1_054_000, 0.86, 2, kv("Largest tenant share of income", pct(314_500 / 1_054_000, 1))),
    om("service_charge_budget_psf", 20, 0.69, 2, kv("Service charge (OA budget)", `${psf(20)}/yr`), "AED/sqft/yr"),
    om("chiller_borne_by", "tenant", 0.89, 2, kv("District cooling capacity charge", MERIDIAN_FACTS.chillerBorneBy)),
    om("vat_treatment", "standard_rated", 0.93, 2, kv("VAT treatment", MERIDIAN_FACTS.vatTreatment)),
    om("ltv", 0.6, 0.91, 3, kv("Loan to value", pct(0.6, 0))),
    om("interest_rate", 0.0595, 0.87, 3, kv("Indicative rate", MERIDIAN_FACTS.rateText)),
    om("loan_term_years", 15, 0.92, 3, kv("Tenor", "15 years"), "years"),
    om("io_period_years", 0, 0.9, 3, kv("Amortisation", "Fully amortising, monthly instalments"), "years"),

    rr("rent_psf", 170, 0.92, "Tenancy Schedule", rrPassingPsf(170), "AED/sqft/yr"),
    rr("occupancy", 6_200 / 6_800, 0.93, "Tenancy Schedule", rrOccupancy(6_200 / 6_800)),
    rr("cheque_count", 4, 0.94, "Tenancy Schedule", tenancyRow(MERIDIAN_TENANCIES[0])),
    rr("service_charge_recoverable", true, 0.9, "Notes", "Leases are on the standard commercial form with the service charge"),
    rr("expiry_share", expiryConcentration(MERIDIAN_TENANCIES), 0.9, "Tenancy Schedule", rrExpiryShare(expiryConcentration(MERIDIAN_TENANCIES))),

    // NOTE: `rent_escalation_pct` is deliberately NOT extracted. The leases here
    // are silent on indexation — the schedule notes say so — and the model has
    // to fall back to its 3% default. That is a real assumption and the review
    // screen should make somebody own it.
  ],
  userFields: [
    {
      key: "service_charge_budget_psf",
      value: 22,
      note:
        "Corrected from the teaser. The OM quotes 'circa AED 20/sqft'; the twelve-month " +
        "operating statement shows the Mollak-approved budget at AED 22.00/sqft, or " +
        "AED 149,600 a year across 6,800 sqft. Underwritten on the higher, evidenced figure.",
    },
    {
      key: "vacancy_rate",
      value: 0.04,
      note:
        "Cut from the model's 8% default. Physical vacancy is already carried explicitly " +
        "through the 91.18% occupancy input; applying 8% structural vacancy on top of it " +
        "would count the empty suite twice. 4% covers re-letting downtime only.",
    },
    {
      // The platform derives occupancy from the rent roll as occupied UNITS
      // over total units — 4 of 5, or 80%. That is wrong on a floor of unequal
      // suites: the vacant 1206 is 600 sqft of 6,800, not a fifth of the floor.
      // A reviewer correcting a machine derivation is exactly what the review
      // screen is for, and it moves service charge recovery by AED 16,720.
      key: "occupancy",
      value: 6_200 / 6_800,
      note:
        "Corrected to an area basis. The rent roll derives occupancy from unit count " +
        "(4 of 5 suites let = 80%), but the vacant Suite 1206 is 600 sqft of a 6,800 sqft " +
        "floor. Occupancy by lettable area is 6,200 / 6,800 = 91.18%, which is the basis " +
        "the service charge is apportioned on.",
    },
    { key: "non_recoverable_psf", value: 6.5, note: "Landlord's irrecoverable costs — void-suite service charge, landlord-scope repairs, out-of-hours security and the Suite 1206 utilities. Set from the twelve-month operating statement rather than the model's generic AED 4.00/sqft." },
    { key: "market_rent_psf", value: 175, note: "ERV for fitted Business Bay space on this floor plate, from live listings and recent Ejari registrations in the tower." },
    { key: "tenant_covenant", value: "sme", note: "Four owner-managed professional firms. No investment-grade covenant on the floor." },
    { key: "dscr_covenant", value: 1.2, note: "Covenant on the indicative facility for a 60% LTV mainland acquisition. Lower than the model's 1.30 default, which assumes a tighter commercial term sheet." },
    { key: "exit_cap_rate", value: 0.0825, note: "Business Bay strata office exit at the end of a seven-year hold. Analyst input; the teaser states no exit basis." },
  ],
};

// ========================================================== 5. LAKESIDE PODIUM
// Retail. Fully let to two occupiers, so income is concentrated: the F&B unit is
// 56.5% of the rent. An eighteen-year-old JLT tower, which is where first-cycle
// capital works live. Free-zone SPV — and rental income from real estate is
// excluded from the 0% qualifying-income regime, so 9% corporate tax applies.

const LAKESIDE_TENANCIES: SeedTenancy[] = [
  {
    unit: "R-01",
    unitType: "Retail — F&B",
    areaSqft: 1_750,
    tenant: "Cafe Solane Restaurant LLC",
    annualRent: 385_000,
    cheques: 4,
    ejari: "EJ-2024-0559312",
    leaseStart: "2024-11-01",
    leaseEnd: "2030-10-31",
    status: "occupied",
    confidence: 0.94,
    marketRent: 428_750,
  },
  {
    unit: "R-02",
    unitType: "Retail — Pharmacy",
    areaSqft: 1_350,
    tenant: "Wafra Pharmacy LLC",
    annualRent: 297_000,
    cheques: 4,
    ejari: "EJ-2025-0294887",
    leaseStart: "2025-06-01",
    leaseEnd: "2031-05-31",
    status: "occupied",
    confidence: 0.93,
    marketRent: 330_750,
  },
];

const LAKESIDE_T12: SeedT12Line[] = [
  { label: "Retail Rent - R-01 Cafe Solane", section: "income", category: "rent", amount: 385_000, pattern: "cheque", cheques: 4, confidence: 0.96 },
  { label: "Retail Rent - R-02 Wafra Pharmacy", section: "income", category: "rent", amount: 297_000, pattern: "cheque", cheques: 4, confidence: 0.95 },
  { label: "Service Charge Recovered from Tenants", section: "income", category: "sc_recovery", amount: 73_625, pattern: "quarterly", confidence: 0.91 },
  { label: "Signage & Shopfront Licence Income", section: "income", category: "other_income", amount: 9_600, pattern: "semiannual", confidence: 0.87 },

  { label: "Service Charge - Owners Association (Mollak)", section: "opex", category: "service_charge", amount: 77_500, pattern: "quarterly", confidence: 0.96 },
  { label: "Property Management Fee", section: "opex", category: "management", amount: 25_507, pattern: "cheque", cheques: 4, confidence: 0.93 },
  { label: "Building Insurance - Landlord Liability & Loss of Rent", section: "opex", category: "insurance", amount: 4_250, pattern: "oneoff", monthIndex: 0, confidence: 0.9 },
  { label: "Repairs & Maintenance - Shopfronts & Demised Areas", section: "opex", category: "repairs", amount: 6_400, pattern: "even", confidence: 0.88 },
  { label: "Grease Trap & Kitchen Extract Servicing (F&B unit)", section: "opex", category: "repairs", amount: 9_600, pattern: "quarterly", confidence: 0.86 },
  { label: "Pest Control - Food Premises Contract", section: "opex", category: "cleaning", amount: 4_800, pattern: "quarterly", confidence: 0.88 },
  { label: "Ejari Registration & Renewals", section: "opex", category: "compliance", amount: 440, pattern: "oneoff", monthIndex: 4, confidence: 0.93 },
  { label: "Leasing Commission - R-02 New Letting", section: "opex", category: "leasing", amount: 14_850, pattern: "oneoff", monthIndex: 9, confidence: 0.91 },

  {
    label: "Chiller Plant Overhaul Special Levy - JLT Tower",
    section: "opex",
    category: "capital",
    amount: 62_000,
    pattern: "oneoff",
    monthIndex: 5,
    recurring: false,
    excludeReason: "One-off chiller plant overhaul levy raised by the Owners Association — capital item, excluded from stabilised NOI",
    confidence: 0.94,
  },
  {
    label: "Shopfront Reinstatement after Tenant Exit (R-02)",
    section: "opex",
    category: "letting_costs",
    amount: 23_400,
    pattern: "oneoff",
    monthIndex: 2,
    recurring: false,
    excludeReason: "Reinstatement works on a tenant exit — non-recurring letting cost, excluded from stabilised NOI",
    confidence: 0.9,
  },
  {
    label: "Fire Alarm System Upgrade to DCD 2025 Code",
    section: "opex",
    category: "capital",
    amount: 31_500,
    pattern: "oneoff",
    monthIndex: 7,
    recurring: false,
    excludeReason: "Regulatory fire alarm upgrade — capital item, excluded from stabilised NOI",
    confidence: 0.92,
  },
];

const LAKESIDE_FACTS: DealFacts = {
  propertyName: "Lakeside Podium",
  unitLabel: "Units R-01 and R-02, podium level",
  community: "Jumeirah Lake Towers (JLT)",
  locality: "Cluster N, lake frontage",
  assetLine: "Commercial retail — two ground-floor units",
  areaLabel: "Net lettable area",
  areaSqft: 3_100,
  developer: "Corvara Commercial Developments",
  handover: "Q2 2008",
  buildingAgeYears: 18,
  tenure: "Freehold",
  tenureNote: "Designated freehold area — commercial strata title",
  parking: "6 allocated bays plus shared podium visitor parking",
  pitch:
    "Two lake-frontage retail units let to an established F&B operator and a pharmacy, both on long leases with the service charge fully recoverable. Rents stand below the current podium ERV.",

  price: 8_500_000,
  pricePsf: 8_500_000 / 3_100,
  compLow: 2_400,
  compHigh: 3_100,

  annualRent: 682_000,
  cheques: 4,
  rentPsf: 682_000 / 3_100,
  grossYield: 682_000 / 8_500_000,
  marketRentPsf: 245,
  waltYears: 4.4,
  occupancy: 1,
  largestTenantPct: 385_000 / 682_000,

  serviceChargePsf: 25,
  serviceChargeTotal: 77_500,
  chillerBorneBy: "Borne by the tenants — Empower accounts in the tenants' names",
  vatTreatment: "Commercial lease — standard-rated at 5%; input VAT recoverable by a registered owner",
  escalationNote: "Contractual rent escalation of 3.0% per annum applies on each tenancy from the second year.",

  buyerProfile: "DMCC free-zone SPV",
  ltv: 0.55,
  loanAmount: 4_675_000,
  rateText: "5.25% fixed for 3 years, reverting to 3M EIBOR + 2.10%",
  ratePct: 0.0525,
  loanTermYears: 15,
  ioPeriodYears: 0,

  omFilename: "Lakeside-Podium-JLT-Retail-OM.pdf",
  rentRollFilename: "LakesidePodium-TenancySchedule-Aug26.xlsx",
  t12Filename: "LakesidePodium-Operating-T12.xlsx",
  t12PeriodEnd: "2026-07-31",
  rentRollAsAt: "2026-08-01",
  broker: "Cordelle Commercial Advisory · Dubai",
  managingAgent: "Beit Asset Services LLC",

  tenancies: LAKESIDE_TENANCIES,
  t12Lines: LAKESIDE_T12,
};

const LAKESIDE: SeedDeal = {
  name: "Lakeside Podium, JLT",
  address: "Units R-01 and R-02, podium level, Cluster N, JLT",
  community: "Jumeirah Lake Towers (JLT)",
  city: "Dubai",
  country: "AE",
  assetType: "commercial",
  tenure: "freehold",
  market: "AE",
  currency: "AED",
  depth: "full",
  modelKey: "dubai-commercial-full",
  notes:
    `${FICTION_NOTE}\n\n` +
    "Demo focus — concentration and age. Two tenants only, and the F&B unit is " +
    "56.5% of the income, so the whole deal turns on one covenant with a " +
    "two-month deposit behind it. The tower handed over in 2008, which is " +
    "squarely in the first capital-works cycle: the twelve-month statement " +
    "already carries a chiller plant overhaul levy and a fire alarm upgrade, " +
    "both stripped out of stabilised NOI. Free-zone SPV, but rental income from " +
    "UAE real estate is excluded from the 0% qualifying-income regime, so 9% " +
    "corporate tax applies.",
  facts: LAKESIDE_FACTS,
  fields: [
    om("price", 8_500_000, 0.95, 1, kv("Asking price", money(8_500_000)), "AED"),
    om("nla_sqft", 3_100, 0.93, 1, areaLine("Net lettable area", 3_100), "sqft"),
    om("asset_subtype", "retail", 0.95, 1, kv("Asset type", "Commercial retail — two ground-floor units")),
    om("community", "Jumeirah Lake Towers (JLT)", 0.94, 1, kv("Community", "Jumeirah Lake Towers (JLT)")),
    om("building_age_years", 18, 0.89, 1, kv("Building age at completion", "18 years"), "years"),
    om("tenure", "freehold", 0.92, 1, kv("Tenure", "Freehold")),
    om("community_price_psf_low", 2_400, 0.82, 1, kv("Recent DLD transacted range", `${psf(2_400, 0)} to ${psf(3_100, 0)}`), "AED/sqft"),
    om("community_price_psf_high", 3_100, 0.82, 1, kv("Recent DLD transacted range", `${psf(2_400, 0)} to ${psf(3_100, 0)}`), "AED/sqft"),
    om("walt_years", 4.4, 0.81, 2, kv("WALT to expiry", "4.4 years"), "years"),
    // Two tenants, so the split is arithmetically obvious — but the teaser
    // rounds it and the extraction hedges accordingly.
    om("largest_tenant_pct", 385_000 / 682_000, 0.59, 2, kv("Largest tenant share of income", pct(385_000 / 682_000, 1))),
    om("chiller_borne_by", "tenant", 0.88, 2, kv("District cooling capacity charge", LAKESIDE_FACTS.chillerBorneBy)),
    om("vat_treatment", "standard_rated", 0.93, 2, kv("VAT treatment", LAKESIDE_FACTS.vatTreatment)),
    om("ltv", 0.55, 0.91, 3, kv("Loan to value", pct(0.55, 0))),
    om("interest_rate", 0.0525, 0.9, 3, kv("Indicative rate", LAKESIDE_FACTS.rateText)),
    om("loan_term_years", 15, 0.92, 3, kv("Tenor", "15 years"), "years"),
    om("io_period_years", 0, 0.9, 3, kv("Amortisation", "Fully amortising, monthly instalments"), "years"),

    rr("rent_psf", 220, 0.94, "Tenancy Schedule", rrPassingPsf(220), "AED/sqft/yr"),
    rr("occupancy", 1, 0.95, "Tenancy Schedule", rrOccupancy(1)),
    rr("cheque_count", 4, 0.94, "Tenancy Schedule", tenancyRow(LAKESIDE_TENANCIES[0])),
    rr("service_charge_recoverable", true, 0.91, "Notes", "Leases are on the standard commercial form with the service charge"),
    rr("expiry_share", expiryConcentration(LAKESIDE_TENANCIES), 0.9, "Tenancy Schedule", rrExpiryShare(expiryConcentration(LAKESIDE_TENANCIES))),
    rr("rent_escalation_pct", 0.03, 0.89, "Notes", LAKESIDE_FACTS.escalationNote as string),

    t12("service_charge_budget_psf", 25, 0.92, "Operating Statement", kv("Service charge (OA budget)", `${psf(25)}/yr`), "AED/sqft/yr"),
  ],
  userFields: [
    { key: "owner_type", value: "freezone_entity", note: "Acquisition through a DMCC free-zone SPV. Rental income from UAE immovable property is excluded income under the qualifying free-zone rules, so it is taxed at 9% above AED 375,000 rather than at 0%." },
    { key: "vacancy_rate", value: 0.05, note: "Both units are let and neither expiry falls inside the first two years, so structural vacancy is set below the model's 8% default." },
    { key: "non_recoverable_psf", value: 11.5, note: "Landlord's irrecoverable costs on a 3,100 sqft demise — shopfront repairs, the F&B grease trap and kitchen extract contract, food-premises pest control, Ejari and letting fees. High per sqft because the area is small, not because the costs are. Set from the twelve-month operating statement." },
    { key: "market_rent_psf", value: 245, note: "Podium retail ERV in Cluster N. Passing rent of AED 220/sqft is roughly 10% under it, which is the reversion this deal is being bought for." },
    { key: "tenant_covenant", value: "sme", note: "Both occupiers are owner-managed SMEs. Neither is a covenant a lender will underwrite on its own." },
    { key: "security_deposit_months", value: 2, note: "Deposits held are two months of rent on both units, thinner than the three months a weak covenant would normally require." },
    { key: "dscr_covenant", value: 1.25, note: "Covenant on the indicative facility at 55% LTV against two long retail leases. The model's 1.30 default assumes a tighter term sheet than this leverage attracts." },
    { key: "exit_cap_rate", value: 0.08, note: "JLT podium retail exit at the end of a seven-year hold. Analyst input." },
  ],
};

// =========================================================== 6. HALCYON DIP ==
// The tenure set piece. A DIP warehouse held on musataha with 28 years left,
// financed with two years interest-only inside a twelve-year facility. Year-one
// DSCR looks strong because it is measured on interest only; the amortisation
// cliff in year three is what the projection is for. The short tenure tail flag
// fires and it is the single most important thing on the page.

const HALCYON_TENANCIES: SeedTenancy[] = [
  {
    unit: "Bay A",
    unitType: "Warehouse + mezz office",
    areaSqft: 9_000,
    tenant: "Sindbar Freight & Logistics LLC",
    annualRent: 432_000,
    cheques: 2,
    ejari: "EJ-2024-0410778",
    leaseStart: "2024-05-01",
    leaseEnd: "2031-04-30",
    status: "occupied",
    confidence: 0.94,
    marketRent: 486_000,
  },
  {
    unit: "Bay B",
    unitType: "Warehouse",
    areaSqft: 7_500,
    tenant: "Karvelo Cold Chain FZE",
    annualRent: 360_000,
    cheques: 2,
    ejari: "EJ-2025-0157640",
    leaseStart: "2025-02-01",
    leaseEnd: "2030-01-31",
    status: "occupied",
    confidence: 0.93,
    marketRent: 405_000,
  },
  {
    unit: "Bay C",
    unitType: "Warehouse",
    areaSqft: 5_500,
    tenant: "Tamween Distribution LLC",
    annualRent: 264_000,
    cheques: 2,
    ejari: "EJ-2023-0862194",
    leaseStart: "2023-08-01",
    leaseEnd: "2028-07-31",
    status: "occupied",
    confidence: 0.92,
    marketRent: 297_000,
  },
];

const HALCYON_T12: SeedT12Line[] = [
  { label: "Warehouse Rent - Bay A Sindbar Freight", section: "income", category: "rent", amount: 432_000, pattern: "cheque", cheques: 2, confidence: 0.96 },
  { label: "Warehouse Rent - Bay B Karvelo Cold Chain", section: "income", category: "rent", amount: 360_000, pattern: "cheque", cheques: 2, confidence: 0.95 },
  { label: "Warehouse Rent - Bay C Tamween Distribution", section: "income", category: "rent", amount: 264_000, pattern: "cheque", cheques: 2, confidence: 0.95 },
  { label: "Service Charge Recovered from Tenants", section: "income", category: "sc_recovery", amount: 52_250, pattern: "semiannual", confidence: 0.9 },
  { label: "Yard & Trailer Parking Licence Income", section: "income", category: "other_income", amount: 18_000, pattern: "quarterly", confidence: 0.87 },

  { label: "Service Charge - Owners Association (Mollak)", section: "opex", category: "service_charge", amount: 55_000, pattern: "quarterly", confidence: 0.95 },
  { label: "Reserve Fund Contribution", section: "opex", category: "reserve_fund", amount: 5_500, pattern: "quarterly", confidence: 0.91 },
  { label: "Musataha Ground Rent - Dubai Investments Park", section: "opex", category: "ground_rent", amount: 44_000, pattern: "semiannual", confidence: 0.93 },
  { label: "Property Management Fee", section: "opex", category: "management", amount: 39_494, pattern: "cheque", cheques: 2, confidence: 0.92 },
  { label: "Building Insurance - Structure, Liability & Loss of Rent", section: "opex", category: "insurance", amount: 6_250, pattern: "oneoff", monthIndex: 0, confidence: 0.91 },
  { label: "Repairs & Maintenance - Roof, Doors & Docks", section: "opex", category: "repairs", amount: 14_400, pattern: "even", confidence: 0.88 },
  { label: "Fire System Servicing & DCD Annual Certification", section: "opex", category: "compliance", amount: 9_800, pattern: "semiannual", confidence: 0.9 },
  { label: "Security - Gatehouse & Perimeter Patrol", section: "opex", category: "security", amount: 12_000, pattern: "even", confidence: 0.9 },
  { label: "Cleaning - Yard & Common Areas", section: "opex", category: "cleaning", amount: 4_800, pattern: "even", confidence: 0.88 },
  { label: "DEWA - Common Area & External Lighting", section: "opex", category: "utilities", amount: 6_600, pattern: "even", confidence: 0.89 },
  { label: "Pest Control - Food Grade Storage Contract", section: "opex", category: "cleaning", amount: 3_000, pattern: "quarterly", confidence: 0.87 },
  { label: "Ejari Registration & Renewals", section: "opex", category: "compliance", amount: 660, pattern: "oneoff", monthIndex: 3, confidence: 0.92 },
  { label: "Leasing Commission - Bay B Renewal", section: "opex", category: "leasing", amount: 18_000, pattern: "oneoff", monthIndex: 5, confidence: 0.9 },

  {
    label: "Dock Leveller Replacement - Bays 3 to 6",
    section: "opex",
    category: "capital",
    amount: 96_000,
    pattern: "oneoff",
    monthIndex: 4,
    recurring: false,
    excludeReason: "One-off dock leveller replacement — capital item, excluded from stabilised NOI",
    confidence: 0.94,
  },
  {
    label: "Yard Resurfacing after Subsidence",
    section: "opex",
    category: "capital",
    amount: 74_500,
    pattern: "oneoff",
    monthIndex: 8,
    recurring: false,
    excludeReason: "One-off yard resurfacing following subsidence — capital item, excluded from stabilised NOI",
    confidence: 0.91,
  },
];

const HALCYON_FACTS: DealFacts = {
  propertyName: "Halcyon Logistics",
  unitLabel: "Warehouse, Bays A to C, Plot 214",
  community: "Dubai Investments Park (DIP)",
  locality: "DIP 2, Ras Al Khor road corridor",
  assetLine: "Industrial — single-storey warehouse with mezzanine offices",
  areaLabel: "Gross floor area",
  areaSqft: 22_000,
  plotSqft: 35_000,
  developer: "Corvara Industrial",
  handover: "Q1 2019",
  buildingAgeYears: 7,
  tenure: "Musataha",
  tenureNote: "Musataha granted 2004 for 50 years, expiring 2054 — 28 years unexpired at completion",
  parking: "Fenced yard, 14 trailer bays and 22 staff spaces",
  pitch:
    "Three-bay logistics unit fully let to established operators on two-cheque terms, with a fenced 35,000 sqft yard. Passing rent stands roughly 11% below current DIP quoting levels.",

  price: 12_500_000,
  pricePsf: 12_500_000 / 22_000,
  // Comparable evidence is deliberately absent: DIP industrial trades thinly and
  // the teaser does not publish a range. Two inputs stay genuinely missing.
  compLow: undefined,
  compHigh: undefined,

  annualRent: 1_056_000,
  cheques: 2,
  rentPsf: 1_056_000 / 22_000,
  grossYield: 1_056_000 / 12_500_000,
  marketRentPsf: 54,
  waltYears: 3.6,
  occupancy: 1,
  largestTenantPct: 432_000 / 1_056_000,

  serviceChargePsf: 2.5,
  serviceChargeTotal: 55_000,
  chillerBorneBy: "Not applicable — no district cooling connection on this plot",
  vatTreatment: "Commercial lease — standard-rated at 5%; input VAT recoverable by a registered owner",
  escalationNote: "Contractual rent escalation of 3.0% per annum applies on each tenancy from the second year.",

  buyerProfile: "Foreign entity SPV, non-resident beneficial owner",
  ltv: 0.5,
  loanAmount: 6_250_000,
  rateText: "3M EIBOR + 2.50% floating (6.20% all-in at a 3M EIBOR of 3.70%)",
  ratePct: 0.062,
  loanTermYears: 12,
  ioPeriodYears: 2,

  omFilename: "Halcyon-Logistics-DIP-Warehouse-OM.pdf",
  rentRollFilename: "Halcyon-TenancySchedule-Aug26.xlsx",
  t12Filename: "Halcyon-Operating-T12.xlsx",
  t12PeriodEnd: "2026-07-31",
  rentRollAsAt: "2026-08-01",
  broker: "Cordelle Industrial · Dubai",
  managingAgent: "Beit Asset Services LLC",

  tenancies: HALCYON_TENANCIES,
  t12Lines: HALCYON_T12,
};

const HALCYON: SeedDeal = {
  name: "Halcyon Logistics, DIP",
  address: "Plot 214, DIP 2, Dubai Investments Park",
  community: "Dubai Investments Park (DIP)",
  city: "Dubai",
  country: "AE",
  assetType: "commercial",
  tenure: "musataha",
  market: "AE",
  currency: "AED",
  depth: "full",
  modelKey: "dubai-commercial-full",
  notes:
    `${FICTION_NOTE}\n\n` +
    "Demo focus — the tenure tail and the amortisation cliff. This is musataha, " +
    "not freehold, with 28 years unexpired. A wasting interest amortises to zero " +
    "and the buyer pool thins sharply once the tail is short, so the short-tenure " +
    "flag fires. Separately, the facility is two years interest-only inside a " +
    "twelve-year tenor: year-one DSCR is flattered because it is measured on " +
    "interest alone, and the projection shows what happens in year three when " +
    "principal starts. Comparable price evidence for DIP industrial is genuinely " +
    "absent from the pack, so two inputs stay unfilled on the review screen.",
  facts: HALCYON_FACTS,
  fields: [
    om("price", 12_500_000, 0.95, 1, kv("Asking price", money(12_500_000)), "AED"),
    om("nla_sqft", 22_000, 0.93, 1, areaLine("Gross floor area", 22_000), "sqft"),
    om("asset_subtype", "warehouse", 0.96, 1, kv("Asset type", "Industrial — single-storey warehouse with mezzanine offices")),
    om("community", "Dubai Investments Park (DIP)", 0.94, 1, kv("Community", "Dubai Investments Park (DIP)")),
    om("building_age_years", 7, 0.87, 1, kv("Building age at completion", "7 years"), "years"),
    om("tenure", "musataha", 0.9, 1, kv("Tenure", "Musataha")),
    // Read out of a prose note rather than a labelled field, hence the hedge —
    // and it is the single most consequential number on this deal.
    om("tenure_years_remaining", 28, 0.66, 1, kv("Tenure note", HALCYON_FACTS.tenureNote), "years"),
    om("walt_years", 3.6, 0.79, 2, kv("WALT to expiry", "3.6 years"), "years"),
    om("largest_tenant_pct", 432_000 / 1_056_000, 0.88, 2, kv("Largest tenant share of income", pct(432_000 / 1_056_000, 1))),
    om("chiller_borne_by", "none", 0.86, 2, kv("District cooling capacity charge", HALCYON_FACTS.chillerBorneBy)),
    om("vat_treatment", "standard_rated", 0.93, 2, kv("VAT treatment", HALCYON_FACTS.vatTreatment)),
    om("ltv", 0.5, 0.91, 3, kv("Loan to value", pct(0.5, 0))),
    om("interest_rate", 0.062, 0.85, 3, kv("Indicative rate", HALCYON_FACTS.rateText)),
    om("loan_term_years", 12, 0.92, 3, kv("Tenor", "12 years"), "years"),
    om(
      "io_period_years",
      2,
      0.9,
      3,
      kv("Amortisation", "2 years interest-only, then amortising over the balance of the tenor"),
      "years",
    ),

    rr("rent_psf", 48, 0.93, "Tenancy Schedule", rrPassingPsf(48), "AED/sqft/yr"),
    rr("occupancy", 1, 0.94, "Tenancy Schedule", rrOccupancy(1)),
    rr("cheque_count", 2, 0.93, "Tenancy Schedule", tenancyRow(HALCYON_TENANCIES[0])),
    rr("service_charge_recoverable", true, 0.89, "Notes", "Leases are on the standard commercial form with the service charge"),
    rr("expiry_share", expiryConcentration(HALCYON_TENANCIES), 0.9, "Tenancy Schedule", rrExpiryShare(expiryConcentration(HALCYON_TENANCIES))),
    rr("rent_escalation_pct", 0.03, 0.88, "Notes", HALCYON_FACTS.escalationNote as string),

    t12("service_charge_budget_psf", 2.5, 0.92, "Operating Statement", kv("Service charge (OA budget)", `${psf(2.5)}/yr`), "AED/sqft/yr"),

    // NOTE: `community_price_psf_low` and `community_price_psf_high` are
    // deliberately NOT extracted. They have no model default, so they resolve as
    // genuinely missing, the price-per-sqft range flag correctly declines to
    // fire on absent data, and the review screen carries a real gap.
  ],
  userFields: [
    { key: "owner_type", value: "foreign_entity", note: "Acquisition through a foreign-incorporated SPV. UAE-sourced rental income remains within the scope of UAE corporate tax at 9% above AED 375,000." },
    { key: "vacancy_rate", value: 0.05, note: "All three bays are let and no expiry falls inside the first two years. Structural vacancy set below the model's 8% default." },
    { key: "non_recoverable_psf", value: 5.15, note: "This is a standalone plot, so the owner contracts gatehouse security, yard cleaning and external lighting directly rather than through an Owners Association — and the musataha ground rent sits here too. Well above the model's generic AED 4.00/sqft, and set from the twelve-month operating statement." },
    { key: "market_rent_psf", value: 54, note: "Current DIP quoting level for comparable three-bay units. Passing rent of AED 48/sqft is roughly 11% under it." },
    { key: "tenant_covenant", value: "multinational", note: "Two of the three occupiers are subsidiaries of regional logistics groups with audited accounts." },
    { key: "exit_cap_rate", value: 0.085, note: "DIP industrial exit at the end of a seven-year hold, widened for the shortening musataha tail. Analyst input." },
  ],
};

// ------------------------------------------------------------------ export ---

/** The six demo deals, in the order they should appear on the dashboard. */
export const SEED_DEALS: SeedDeal[] = [MARISOL, AZURA, VIREO, MERIDIAN, LAKESIDE, HALCYON];

/** Every seeded deal name, for the idempotency and --reset checks in seed.ts. */
export const SEED_DEAL_NAMES: string[] = SEED_DEALS.map((d) => d.name);
