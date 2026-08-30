// Synthetic document text for the demo deals.
//
// IMPORTANT — WHAT THESE ARE
//
// Every "document" produced here is a plain-text STAND-IN. The seeder writes it
// to data/uploads/<dealId>/<documentId>.txt so a real file exists on disk, the
// authenticated download route streams something, and the provenance drawer has
// genuine text to quote. We do NOT synthesise PDF or XLSX binaries: the display
// filename is the plausible one a broker would send (".pdf", ".xlsx") while the
// stored bytes, the mime type and detected_type are all honestly text/plain.
//
// Everything described below is FICTIONAL. The buildings, the towers, the
// tenant names, the Ejari registration numbers, the developers and the brokers
// do not exist. The figures are plausible Dubai planning numbers invented for a
// software demonstration and are not an offer, a valuation or investment advice.
//
// WHY THE FORMATTING HELPERS ARE EXPORTED
//
// The extracted-field fixtures in ./index.ts quote a `snippet` that must appear
// verbatim in the generated text, otherwise "click through to the source" lands
// on nothing. Rather than hand-copying padded strings, the fixtures build their
// snippets with the SAME `kv()` / `cols()` helpers the renderer uses, so the two
// cannot drift. The seeder additionally asserts every snippet is present and
// fails loudly if one is not.

// ------------------------------------------------------------- formatting ----

/** AED with thousands separators, no decimals: `AED 1,050,000`. */
export function money(n: number): string {
  return `AED ${Math.round(n).toLocaleString("en-US")}`;
}

/** Plain number with thousands separators and a fixed number of decimals. */
export function num(n: number, dp = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** `AED 12.50/sqft` — the way every Dubai service charge is quoted. */
export function psf(n: number, dp = 2): string {
  return `AED ${num(n, dp)}/sqft`;
}

/** `7.43%` */
export function pct(n: number, dp = 2): string {
  return `${(n * 100).toFixed(dp)}%`;
}

/** Square feet converted to square metres, as Dubai OMs quote both. */
export function toSqm(sqft: number): string {
  return num(sqft / 10.7639, 1);
}

/**
 * A label/value line in an OM block. The renderer indents it by two spaces, so
 * a fixture snippet built from `kv()` is a substring of the rendered line.
 */
export function kv(label: string, value: string): string {
  // Pad, then ALWAYS add the gutter, so an over-long label pushes its value
  // right instead of running into it.
  return `${label.padEnd(36, " ")}  ${value}`;
}

/**
 * A fixed-width table row. A negative width right-aligns the cell, which is how
 * a spreadsheet export of a rent roll or a T12 actually reads. Columns are
 * joined with a two-space gutter that is added after padding, so a cell wider
 * than its column shifts the rest of the row rather than colliding with it.
 */
export function cols(cells: Array<string | number>, widths: number[]): string {
  return cells
    .map((cell, i) => {
      const s = String(cell);
      const w = widths[i] ?? 0;
      return w < 0 ? s.padStart(-w, " ") : s.padEnd(w, " ");
    })
    .join("  ")
    .replace(/[ ]+$/, "");
}

/** Wrap prose to `width`, indenting every line. Keeps a teaser readable. */
export function wrap(text: string, width = 92, indent = "  "): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-03-15` → `15-Mar-26`, the format every Dubai tenancy schedule uses. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${MONTH_NAMES[Number(m) - 1]}-${y.slice(2)}`;
}

/** The twelve month headings of the trailing period, ending at `endIso`. */
export function trailingMonths(endIso: string): string[] {
  const [y, m] = endIso.split("-").map(Number);
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    let month = m - 1 - i;
    let year = y;
    while (month < 0) {
      month += 12;
      year -= 1;
    }
    out.push(`${MONTH_NAMES[month]}-${String(year).slice(2)}`);
  }
  return out;
}

// ------------------------------------------------------------- fixture types --

export type DocKind = "om" | "rent_roll" | "t12";

/** One tenancy line, rendered into the rent roll and stored in rent_roll_units. */
export interface SeedTenancy {
  unit: string;
  unitType: string;
  areaSqft: number;
  tenant: string;
  annualRent: number | null;
  cheques: number | null;
  ejari: string | null;
  /** ISO. Null for a vacant unit. */
  leaseStart: string | null;
  leaseEnd: string | null;
  status: "occupied" | "vacant";
  beds?: number | null;
  baths?: number | null;
  marketRent?: number | null;
  confidence?: number;
}

/** How a line's annual total is spread across the twelve monthly columns. */
export type SpreadPattern = "cheque" | "even" | "quarterly" | "semiannual" | "oneoff";

/** One T12 line, rendered into the statement and stored in t12_lines. */
export interface SeedT12Line {
  label: string;
  section: "income" | "opex";
  /** Normalised bucket; the platform rolls these up as `t12_<category>`. */
  category: string;
  /** Twelve-month total, as stated on the document. */
  amount: number;
  pattern: SpreadPattern;
  /** For pattern "cheque": how many instalments land in the year. */
  cheques?: number;
  /** For pattern "oneoff": which of the twelve columns carries it (0-based). */
  monthIndex?: number;
  recurring?: boolean;
  /** Why this line is excluded from stabilised NOI. Implies recurring: false. */
  excludeReason?: string;
  confidence?: number;
}

/** Everything the three generators need. Primitives only — no pre-rendered text. */
export interface DealFacts {
  // --- identity -----------------------------------------------------------
  /** Marketing name on the teaser cover. */
  propertyName: string;
  /** e.g. "Tower B, Unit 1204" or "Half floor, Level 12". */
  unitLabel: string;
  community: string;
  /** Sub-location line, e.g. "District 12, off Al Khail Road". */
  locality: string;
  /** e.g. "Residential apartment — 1 bedroom". */
  assetLine: string;
  /** Label for the headline area, e.g. "Suite area", "BUA", "Net lettable area". */
  areaLabel: string;
  areaSqft: number;
  plotSqft?: number;
  developer: string;
  handover: string;
  buildingAgeYears: number;
  tenure: string;
  /** Free text under the tenure line, e.g. the musataha expiry. */
  tenureNote: string;
  parking: string;
  /** Broker's own two-sentence pitch. */
  pitch: string;

  // --- pricing ------------------------------------------------------------
  price: number;
  pricePsf: number;
  compLow?: number;
  compHigh?: number;

  // --- income -------------------------------------------------------------
  annualRent: number;
  cheques: number;
  rentPsf: number;
  grossYield: number;
  /** Residential only: the DLD Smart Rental Index reference. */
  reraIndexRent?: number;
  /** Commercial only. */
  marketRentPsf?: number;
  waltYears?: number;
  occupancy?: number;
  largestTenantPct?: number;

  // --- operating ----------------------------------------------------------
  serviceChargePsf: number;
  serviceChargeTotal: number;
  /**
   * What the teaser quotes, when the broker is working from a stale budget and
   * the managing agent's statement says something else. Drives the OM only; the
   * T12 always reports the current Mollak-approved figure. This is the hook the
   * "AI read the OM, the reviewer corrected it" demo hangs on.
   */
  quotedServiceChargePsf?: number;
  /** Full sentence, e.g. "Borne by the tenant — Empower account in tenant name". */
  chillerBorneBy: string;
  vatTreatment: string;
  /**
   * Commercial only: the escalation clause note printed on the schedule. Leave
   * undefined where the leases are genuinely silent on indexation.
   */
  escalationNote?: string;

  // --- financing (the teaser's indicative terms) ---------------------------
  buyerProfile: string;
  ltv: number;
  loanAmount: number;
  rateText: string;
  ratePct: number;
  loanTermYears: number;
  ioPeriodYears: number;

  // --- documents ----------------------------------------------------------
  omFilename: string;
  rentRollFilename: string;
  t12Filename: string;
  /** Twelve-month period end for the T12, ISO. */
  t12PeriodEnd: string;
  /** As-at date shown on the rent roll, ISO. */
  rentRollAsAt: string;
  broker: string;
  managingAgent: string;

  tenancies: SeedTenancy[];
  t12Lines: SeedT12Line[];
}

/** A generated document: the whole text plus its per-page / per-sheet segments. */
export interface GeneratedDocument {
  kind: DocKind;
  filename: string;
  mime: string;
  detectedType: string;
  pageCount: number | null;
  sheetCount: number | null;
  text: string;
  segments: Array<{ ordinal: number; pageNo: number | null; sheetName: string | null; content: string }>;
}

const RULE = "-".repeat(96);
const DOUBLE = "=".repeat(96);

const FICTION_NOTICE = [
  "FICTIONAL DEMONSTRATION DOCUMENT. The property, the parties, the tenancies and",
  "every figure below are synthetic and were created to demonstrate underwriting",
  "software. Nothing here is an offer, a valuation, or investment advice.",
].join("\n");

function page(lines: string[]): string {
  return lines.join("\n").replace(/[ ]+\n/g, "\n");
}

function assemble(
  kind: DocKind,
  filename: string,
  parts: Array<{ pageNo: number | null; sheetName: string | null; content: string }>,
): GeneratedDocument {
  const segments = parts.map((p, i) => ({ ordinal: i + 1, pageNo: p.pageNo, sheetName: p.sheetName, content: p.content }));
  const isSheet = parts[0]?.sheetName !== null;
  return {
    kind,
    filename,
    // Honest about the bytes even though the display filename says .pdf/.xlsx.
    mime: "text/plain; charset=utf-8",
    detectedType: "text",
    pageCount: isSheet ? null : parts.length,
    sheetCount: isSheet ? parts.length : null,
    text: segments.map((s) => s.content).join("\n\n"),
    segments,
  };
}

// ----------------------------------------------------------------------- OM --

/**
 * A Dubai broker teaser. Deliberately short and slightly breathless, the way
 * they actually arrive: a summary block, a pricing block, an income block with
 * the gross yield calculated for you, the service charge, and a page of
 * indicative financing and transaction costs.
 */
export function generateOM(f: DealFacts): GeneratedDocument {
  const areaBlock: string[] = [`  ${kv(f.areaLabel, `${num(f.areaSqft)} sqft (${toSqm(f.areaSqft)} sqm)`)}`];
  if (f.plotSqft) {
    areaBlock.push(`  ${kv("Plot area", `${num(f.plotSqft)} sqft (${toSqm(f.plotSqft)} sqm)`)}`);
  }

  const p1 = page([
    DOUBLE,
    `${f.broker.toUpperCase()}`,
    "CONFIDENTIAL INVESTMENT TEASER — FOR THE ADDRESSEE ONLY",
    DOUBLE,
    "",
    f.propertyName.toUpperCase(),
    `${f.unitLabel}`,
    `${f.community}, Dubai, United Arab Emirates`,
    "",
    FICTION_NOTICE,
    "",
    RULE,
    "1.  PROPERTY SUMMARY",
    RULE,
    "",
    `  ${kv("Property", f.propertyName)}`,
    `  ${kv("Unit", f.unitLabel)}`,
    `  ${kv("Community", f.community)}`,
    `  ${kv("Location", f.locality)}`,
    `  ${kv("Emirate", "Dubai, United Arab Emirates")}`,
    `  ${kv("Asset type", f.assetLine)}`,
    ...areaBlock,
    `  ${kv("Tenure", f.tenure)}`,
    `  ${kv("Tenure note", f.tenureNote)}`,
    `  ${kv("Developer", f.developer)}`,
    `  ${kv("Handover", f.handover)}`,
    `  ${kv("Building age at completion", `${f.buildingAgeYears} years`)}`,
    `  ${kv("Parking", f.parking)}`,
    "",
    RULE,
    "2.  PRICING",
    RULE,
    "",
    `  ${kv("Asking price", money(f.price))}`,
    `  ${kv("Price per sqft", psf(f.pricePsf, 0))}`,
    f.compLow !== undefined && f.compHigh !== undefined
      ? `  ${kv("Recent DLD transacted range", `${psf(f.compLow, 0)} to ${psf(f.compHigh, 0)}`)}`
      : `  ${kv("Recent DLD transacted range", "Not published — thin comparable set in this submarket")}`,
    "",
    wrap(f.pitch),
    "",
    `Page 1 of 3`,
  ]);

  const incomeRows: string[] = [
    `  ${kv("Passing rent per annum", money(f.annualRent))}`,
    `  ${kv("Rent per sqft", psf(f.rentPsf, f.rentPsf >= 100 ? 0 : 2))}`,
    `  ${kv("Payment terms", `${f.cheques} cheque${f.cheques === 1 ? "" : "s"} per annum, post-dated`)}`,
    `  ${kv("Gross yield on asking price", pct(f.grossYield))}`,
  ];
  if (f.occupancy !== undefined) {
    incomeRows.push(`  ${kv("Occupancy (by lettable area)", pct(f.occupancy, 2))}`);
  }
  if (f.waltYears !== undefined) {
    incomeRows.push(`  ${kv("WALT to expiry", `${num(f.waltYears, 1)} years`)}`);
  }
  if (f.marketRentPsf !== undefined) {
    incomeRows.push(`  ${kv("Estimated rental value (ERV)", psf(f.marketRentPsf, 0))}`);
  }
  if (f.largestTenantPct !== undefined) {
    incomeRows.push(`  ${kv("Largest tenant share of income", pct(f.largestTenantPct, 1))}`);
  }

  const reraBlock: string[] = [];
  if (f.reraIndexRent !== undefined) {
    const variance = (f.reraIndexRent - f.annualRent) / f.reraIndexRent;
    reraBlock.push(
      "",
      "  RENTAL INDEX POSITION",
      "",
      `  ${kv("DLD Smart Rental Index (RERA)", money(f.reraIndexRent))}`,
      `  ${kv("In-place rent vs index", `${pct(variance, 1)} below index`)}`,
      "",
      "  Note for the purchaser: the tenancy transfers with the unit. Under the",
      "  RERA increase table a renewal of a subsisting tenancy priced between 11%",
      "  and 20% below the index permits an increase of 5% only. The gap to index",
      "  is therefore reversionary over several renewals, not on day one.",
    );
  }

  // A teaser quotes whatever budget the broker has to hand, which is not always
  // the current one. Where the two differ the OM says so, quietly.
  const quotedSc = f.quotedServiceChargePsf ?? f.serviceChargePsf;
  const scStatus =
    f.quotedServiceChargePsf === undefined
      ? "Mollak-approved budget, current year"
      : "As quoted by the vendor — purchaser to verify against the current Mollak statement";

  const p2 = page([
    DOUBLE,
    `${f.propertyName.toUpperCase()} — INCOME AND OPERATING POSITION`,
    DOUBLE,
    "",
    RULE,
    "3.  INCOME",
    RULE,
    "",
    ...incomeRows,
    ...reraBlock,
    "",
    RULE,
    "4.  OPERATING COSTS",
    RULE,
    "",
    `  ${kv("Service charge (OA budget)", `${psf(quotedSc)}/yr`)}`,
    `  ${kv("Service charge per annum", money(quotedSc * f.areaSqft))}`,
    `  ${kv("Service charge status", scStatus)}`,
    `  ${kv("District cooling capacity charge", f.chillerBorneBy)}`,
    `  ${kv("VAT treatment", f.vatTreatment)}`,
    `  ${kv("Managing agent", f.managingAgent)}`,
    "",
    "  There is no annual property tax in Dubai. The Owners Association budget",
    "  billed through Mollak is the dominant recurring cost on this asset and is",
    "  the line a purchaser should verify against the latest issued statement.",
    "",
    `Page 2 of 3`,
  ]);

  const ioLine =
    f.ioPeriodYears > 0
      ? `  ${kv("Amortisation", `${f.ioPeriodYears} years interest-only, then amortising over the balance of the tenor`)}`
      : `  ${kv("Amortisation", "Fully amortising, monthly instalments")}`;

  const p3 = page([
    DOUBLE,
    `${f.propertyName.toUpperCase()} — INDICATIVE FINANCING AND TRANSACTION COSTS`,
    DOUBLE,
    "",
    RULE,
    "5.  INDICATIVE FINANCING",
    RULE,
    "",
    "  Indicative only, from a UAE lender's term sheet on a comparable facility.",
    "  Not a credit approval and not binding on any bank.",
    "",
    `  ${kv("Borrower profile", f.buyerProfile)}`,
    `  ${kv("Loan to value", pct(f.ltv, 0))}`,
    `  ${kv("Indicative loan amount", money(f.loanAmount))}`,
    `  ${kv("Indicative rate", f.rateText)}`,
    `  ${kv("Tenor", `${f.loanTermYears} years`)}`,
    ioLine,
    "",
    RULE,
    "6.  BUYER-SIDE TRANSACTION COSTS (INDICATIVE)",
    RULE,
    "",
    `  ${kv("DLD transfer fee", `4% of price plus AED 580 administration`)}`,
    `  ${kv("Agency commission", "2% of price plus 5% VAT")}`,
    `  ${kv("Registration trustee", "AED 4,200 including VAT")}`,
    `  ${kv("Title deed issuance", "AED 580")}`,
    `  ${kv("Developer / OA NOC", "AED 500 to 5,000 depending on developer")}`,
    `  ${kv("Mortgage registration", "0.25% of the loan plus AED 290")}`,
    "",
    "  All in, a buyer should budget roughly 6% to 7% of the purchase price in",
    "  transaction costs before any bank arrangement fee.",
    "",
    RULE,
    "7.  DISCLAIMER",
    RULE,
    "",
    FICTION_NOTICE,
    "",
    wrap(
      `Prepared by ${f.broker}. Figures are indicative and subject to contract, title ` +
        "verification, a Mollak service charge statement and Ejari inspection.",
    ),
    "",
    `Page 3 of 3`,
  ]);

  return assemble("om", f.omFilename, [
    { pageNo: 1, sheetName: null, content: p1 },
    { pageNo: 2, sheetName: null, content: p2 },
    { pageNo: 3, sheetName: null, content: p3 },
  ]);
}

// ---------------------------------------------------------------- rent roll --

/** Column widths for the tenancy schedule. Negative = right-aligned. */
export const RENT_ROLL_WIDTHS = [10, 26, -11, 34, -17, -13, -7, 16, 11, 11, 9];

export const RENT_ROLL_HEADERS = [
  "Unit",
  "Type",
  "Area (sqft)",
  "Tenant",
  "Annual Rent (AED)",
  "ERV (AED)",
  "Cheques",
  "Ejari No",
  "Lease Start",
  "Lease End",
  "Status",
];

/** One rendered tenancy line. Fixtures use this to build exact snippets. */
export function tenancyRow(t: SeedTenancy): string {
  return cols(
    [
      t.unit,
      t.unitType,
      num(t.areaSqft),
      t.tenant,
      t.annualRent === null ? "—" : num(t.annualRent),
      t.marketRent === null || t.marketRent === undefined ? "—" : num(t.marketRent),
      t.cheques === null ? "—" : String(t.cheques),
      t.ejari ?? "—",
      t.leaseStart ? shortDate(t.leaseStart) : "—",
      t.leaseEnd ? shortDate(t.leaseEnd) : "—",
      t.status === "vacant" ? "VACANT" : "Occupied",
    ],
    RENT_ROLL_WIDTHS,
  );
}

/**
 * Share of passing rent expiring in the single heaviest calendar year.
 *
 * This is the commercial model's `expiry_share` input, and it matters more than
 * WALT: a blended 3.5-year WALT is a completely different asset depending on
 * whether the leases are laddered or all land in the same quarter. The model
 * weights the reversion void, rent-free and letting commission by it.
 */
export function expiryConcentration(tenancies: SeedTenancy[]): number {
  const byYear = new Map<string, number>();
  let total = 0;
  for (const t of tenancies) {
    if (!t.leaseEnd || !t.annualRent) continue;
    const year = t.leaseEnd.slice(0, 4);
    byYear.set(year, (byYear.get(year) ?? 0) + t.annualRent);
    total += t.annualRent;
  }
  if (!total) return 0;
  return Math.max(...byYear.values()) / total;
}

/**
 * A tenancy schedule as a managing agent exports it: one sheet of rows with a
 * footed total, and a second sheet of the notes that never fit in the columns.
 */
export function generateRentRoll(f: DealFacts): GeneratedDocument {
  const letArea = f.tenancies.filter((t) => t.status !== "vacant").reduce((a, t) => a + t.areaSqft, 0);
  const totalArea = f.tenancies.reduce((a, t) => a + t.areaSqft, 0);
  const totalRent = f.tenancies.reduce((a, t) => a + (t.annualRent ?? 0), 0);
  const totalErv = f.tenancies.reduce((a, t) => a + (t.marketRent ?? t.annualRent ?? 0), 0);
  const vacant = f.tenancies.filter((t) => t.status === "vacant");
  const header = cols(RENT_ROLL_HEADERS, RENT_ROLL_WIDTHS);

  const sheet1 = page([
    `${f.propertyName} — Tenancy Schedule`,
    `${f.community}, Dubai`,
    `Prepared by ${f.managingAgent}   ·   As at ${shortDate(f.rentRollAsAt)}`,
    "",
    "FICTIONAL DEMONSTRATION DATA — tenants, Ejari numbers and rents are invented.",
    "",
    header,
    "-".repeat(header.length),
    ...f.tenancies.map(tenancyRow),
    "-".repeat(header.length),
    cols(
      ["TOTAL", "", num(totalArea), `${f.tenancies.length} unit(s)`, num(totalRent), num(totalErv), "", "", "", "", ""],
      RENT_ROLL_WIDTHS,
    ),
    "",
    `  ${kv("Total lettable area", `${num(totalArea)} sqft`)}`,
    `  ${kv("Occupied area", `${num(letArea)} sqft`)}`,
    `  ${kv("Occupancy by area", pct(totalArea > 0 ? letArea / totalArea : 0, 2))}`,
    `  ${kv("Total passing rent", money(totalRent))}`,
    // Passing rent on the LET area, not on total area. Two different numbers
    // whenever anything is vacant, and confusing them is how an underwriting
    // quietly overstates income.
    `  ${kv("Passing rent per occupied sqft", psf(letArea > 0 ? totalRent / letArea : 0))}`,
    `  ${kv("Total ERV (market rent, all units)", money(totalErv))}`,
    `  ${kv("ERV per sqft", psf(totalArea > 0 ? totalErv / totalArea : 0))}`,
    `  ${kv("Largest single-year expiry (by rent)", pct(expiryConcentration(f.tenancies), 1))}`,
    `  ${kv("Vacant units", vacant.length ? vacant.map((v) => v.unit).join(", ") : "None — fully let")}`,
  ]);

  const notes: string[] = [
    `${f.propertyName} — Schedule Notes`,
    "",
    "  1.  All tenancies are registered with Ejari. Registration numbers shown are",
    "      fictional and are for demonstration only.",
    `  2.  Rent is collected in ${f.cheques} post-dated cheque${f.cheques === 1 ? "" : "s"} per annum on the`,
    "      principal tenancy. Cheques are banked on presentation dates agreed at",
    "      signing and held by the managing agent until then.",
  ];

  if (f.reraIndexRent !== undefined) {
    notes.push(
      "  3.  The tenancy transfers to the purchaser on completion. The renewal is",
      "      subject to the RERA increase table measured against the DLD Smart",
      "      Rental Index, not against asking rents or the ERV.",
      "  4.  Renewal regime assumed: existing tenant renews, RERA cap applies.",
    );
  } else {
    notes.push(
      "  3.  Leases are on the standard commercial form with the service charge",
      "      recoverable from tenants pro rata to demised area.",
      "  4.  Security deposits are held by the managing agent in a separate account.",
    );
    notes.push(
      f.escalationNote
        ? `  5.  ${f.escalationNote}`
        : "  5.  The leases are silent on indexation. No contractual escalation is" +
          "\n      recorded against any tenancy on this schedule.",
    );
  }

  if (vacant.length) {
    notes.push(
      "",
      "  VACANCY",
      "",
      ...vacant.map((v) =>
        wrap(
          `${v.unit} (${num(v.areaSqft)} sqft) is vacant and being marketed. No rent is ` +
            "recognised against it in this schedule, and it is excluded from the occupied " +
            "area and from the passing rent per occupied sqft above.",
        ),
      ),
    );
  }

  notes.push(
    "",
    "  This schedule is unaudited and is provided for information only.",
    `  ${f.managingAgent}`,
  );

  return assemble("rent_roll", f.rentRollFilename, [
    { pageNo: null, sheetName: "Tenancy Schedule", content: sheet1 },
    { pageNo: null, sheetName: "Notes", content: page(notes) },
  ]);
}

// ---------------------------------------------------------------------- T12 --

const T12_LABEL_WIDTH = 54;
const T12_MONTH_WIDTH = -9;
const T12_TOTAL_WIDTH = -12;

function t12Widths(): number[] {
  return [T12_LABEL_WIDTH, ...Array<number>(12).fill(T12_MONTH_WIDTH), T12_TOTAL_WIDTH];
}

/**
 * Spread a twelve-month total across the monthly columns the way the cash
 * actually lands. Dubai rent arrives in a handful of cheques, service charges
 * are billed quarterly, insurance annually — a flat 1/12th everywhere is the
 * tell of a fabricated statement.
 */
export function spreadMonthly(line: SeedT12Line): number[] {
  const out = Array<number>(12).fill(0);
  const total = line.amount;

  if (line.pattern === "oneoff") {
    out[Math.min(11, Math.max(0, line.monthIndex ?? 0))] = total;
    return out;
  }

  let slots: number[];
  if (line.pattern === "cheque") {
    const n = Math.max(1, line.cheques ?? 4);
    const step = 12 / n;
    slots = Array.from({ length: n }, (_, i) => Math.round(i * step));
  } else if (line.pattern === "quarterly") {
    slots = [0, 3, 6, 9];
  } else if (line.pattern === "semiannual") {
    slots = [0, 6];
  } else {
    slots = Array.from({ length: 12 }, (_, i) => i);
  }

  const per = Math.round((total / slots.length) * 100) / 100;
  for (const s of slots) out[s] = per;
  // Push the rounding difference into the last populated column so the row
  // foots to the stated total exactly.
  const drift = Math.round((total - out.reduce((a, b) => a + b, 0)) * 100) / 100;
  out[slots[slots.length - 1]] = Math.round((out[slots[slots.length - 1]] + drift) * 100) / 100;
  return out;
}

/** One rendered T12 row. Fixtures use this to build exact snippets. */
export function t12Row(line: SeedT12Line): string {
  const monthly = spreadMonthly(line).map((v) => (v === 0 ? "—" : num(v, 0)));
  return cols([line.label, ...monthly, num(line.amount, 0)], t12Widths());
}

/**
 * A twelve-month collection and operating statement from the managing agent.
 * Two sheets: collections, then operating expenses with the non-recurring items
 * pulled out below the recurring block so the normalisation is visible.
 */
export function generateT12(f: DealFacts): GeneratedDocument {
  const months = trailingMonths(f.t12PeriodEnd);
  const header = cols(["", ...months, "Total"], t12Widths());
  const income = f.t12Lines.filter((l) => l.section === "income");
  const opexRecurring = f.t12Lines.filter((l) => l.section === "opex" && l.recurring !== false && !l.excludeReason);
  const opexExcluded = f.t12Lines.filter((l) => l.section === "opex" && (l.recurring === false || l.excludeReason));

  const totalIncome = income.reduce((a, l) => a + l.amount, 0);
  const totalRecurringOpex = opexRecurring.reduce((a, l) => a + l.amount, 0);
  const totalExcluded = opexExcluded.reduce((a, l) => a + l.amount, 0);

  const sheet1 = page([
    `${f.propertyName} — Collections, twelve months to ${shortDate(f.t12PeriodEnd)}`,
    `${f.community}, Dubai   ·   Prepared by ${f.managingAgent}   ·   AED, unaudited`,
    "",
    "FICTIONAL DEMONSTRATION DATA — no such account exists.",
    "",
    header,
    "-".repeat(header.length),
    ...income.map(t12Row),
    "-".repeat(header.length),
    cols(
      ["TOTAL COLLECTIONS", ...Array<string>(12).fill(""), num(totalIncome, 0)],
      t12Widths(),
    ),
    "",
    "  Cheques are recorded on presentation, not on accrual, which is why the",
    "  monthly pattern follows the tenancy's cheque dates rather than a flat",
    "  twelfth of the annual rent.",
  ]);

  const sheet2 = page([
    `${f.propertyName} — Operating Statement, twelve months to ${shortDate(f.t12PeriodEnd)}`,
    `${f.community}, Dubai   ·   Prepared by ${f.managingAgent}   ·   AED, unaudited`,
    "",
    header,
    "-".repeat(header.length),
    "RECURRING OPERATING EXPENSES",
    ...opexRecurring.map(t12Row),
    "-".repeat(header.length),
    cols(["TOTAL RECURRING OPERATING EXPENSES", ...Array<string>(12).fill(""), num(totalRecurringOpex, 0)], t12Widths()),
    "",
    "NON-RECURRING AND CAPITAL ITEMS — EXCLUDED FROM STABILISED NOI",
    ...opexExcluded.map(t12Row),
    "-".repeat(header.length),
    cols(["TOTAL NON-RECURRING", ...Array<string>(12).fill(""), num(totalExcluded, 0)], t12Widths()),
    "",
    "  EXCLUSION NOTES",
    "",
      ...opexExcluded.map((l) => wrap(`${l.label}: ${l.excludeReason ?? "Non-recurring."}`)),
    "",
    RULE,
    "  TWELVE MONTH SUMMARY",
    RULE,
    "",
    `  ${kv("Total collections", money(totalIncome))}`,
    `  ${kv("Recurring operating expenses", money(totalRecurringOpex))}`,
    `  ${kv("Non-recurring items excluded", money(totalExcluded))}`,
    `  ${kv("Normalised net operating result", money(totalIncome - totalRecurringOpex))}`,
    `  ${kv("Service charge (OA budget)", `${psf(f.serviceChargePsf)}/yr`)}`,
    `  ${kv("Service charge per annum", money(f.serviceChargeTotal))}`,
    "",
    "  Prepared on a cash basis. Excluding the capital and prior-year items above",
    "  is the difference between a stabilised NOI and a cash result, and it is the",
    "  adjustment a purchaser must make before capitalising this income.",
  ]);

  return assemble("t12", f.t12Filename, [
    { pageNo: null, sheetName: "Collections", content: sheet1 },
    { pageNo: null, sheetName: "Operating Statement", content: sheet2 },
  ]);
}

/** All three documents for a deal, in upload order. */
export function generateDocuments(f: DealFacts): GeneratedDocument[] {
  return [generateOM(f), generateRentRoll(f), generateT12(f)];
}
