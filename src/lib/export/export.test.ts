// Tests for the Excel and CSV export.
//
// These assert the properties that make the difference between a workbook an
// analyst forwards to their investment committee and one they rebuild by hand:
//
//   * figures are numeric cells with an Excel number format, not strings
//   * a percentage is stored as 0.0743 and DISPLAYS as 7.43%
//   * a null renders blank, never as zero
//   * the rent-roll totals row foots against the units above it
//   * the filename built from a user-supplied deal name cannot carry quotes,
//     path separators or control characters into a response header
//
// Everything is asserted by reading the produced .xlsx back with SheetJS, so
// the test exercises the real serialised artifact rather than the intermediate
// object model.

import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";

import {
  buildWorkbook,
  buildWorkbookModel,
  contentDisposition,
  currencyFormat,
  exportFilename,
  numberFormat,
  safeSheetName,
  sanitiseFilename,
} from "./workbook.ts";
import type { ExportBundle } from "./workbook.ts";
import { buildCsv } from "./csv.ts";
import type { RentRollUnitRow, T12LineRow } from "../db/repo.ts";

// ------------------------------------------------------------------ fixture --

function unit(over: Partial<RentRollUnitRow>): RentRollUnitRow {
  return {
    id: `u-${over.unit_no ?? "x"}`,
    deal_id: "deal-1",
    owner_id: "owner-1",
    ordinal: 1,
    unit_no: null,
    unit_type: null,
    beds: null,
    baths: null,
    area_sqft: null,
    in_place_rent: null,
    market_rent: null,
    cheques: null,
    lease_start: null,
    lease_end: null,
    occupancy_status: "occupied",
    ejari_no: null,
    source_document_id: null,
    source_page: null,
    source_row: null,
    confidence: null,
    edited: 0,
    ...over,
  };
}

function t12Line(over: Partial<T12LineRow>): T12LineRow {
  return {
    id: `t-${over.raw_label ?? "x"}`,
    deal_id: "deal-1",
    owner_id: "owner-1",
    ordinal: 1,
    raw_label: "(unlabelled)",
    section: "opex",
    category: null,
    amount: null,
    months_covered: 12,
    annualized: null,
    is_recurring: 1,
    exclude_reason: null,
    source_document_id: null,
    source_page: null,
    source_row: null,
    confidence: null,
    edited: 0,
    ...over,
  };
}

/**
 * A realistic Business Bay residential run: a 1,050,000 purchase at 78,000
 * passing rent, so gross yield is 0.0742857..., which is the 7.43% the rest of
 * the product quotes.
 */
function fixture(over: Partial<ExportBundle> = {}): ExportBundle {
  return {
    deal: {
      id: "deal-1",
      name: 'Marisol "Residences" / Tower B',
      address: "Plot 12, Marasi Drive",
      community: "Business Bay",
      city: "Dubai",
      country: "AE",
      assetType: "residential",
      tenure: "freehold",
      market: "AE",
      currency: "AED",
      status: "review",
    },
    run: {
      id: "run-1",
      createdAt: "2026-08-30T09:15:00.000Z",
      depth: "full",
      modelName: "Dubai residential — full",
      modelKey: "dubai-residential-full",
      modelVersion: 3,
      methodology: "Stabilised year one, service charge treated as landlord cost.",
    },
    result: {
      modelKey: "dubai-residential-full",
      depth: "full",
      currency: "AED",
      inputs: [
        {
          key: "purchase_price",
          label: "Purchase price",
          group: "Acquisition",
          value: 1_050_000,
          type: "currency",
          format: "currency",
          origin: "extracted",
          confidence: 0.92,
          sourceDocumentId: "doc-om",
          sourcePage: 4,
          sourceSnippet: "Asking price AED 1,050,000",
        },
        {
          key: "annual_rent",
          label: "Annual rent",
          group: "Income",
          value: 78_000,
          type: "currency",
          format: "currency",
          origin: "user",
          confidence: null,
          sourceDocumentId: null,
          sourcePage: null,
        },
        {
          // The whole point of the blank-not-zero rule: nobody ever found this.
          key: "service_charge",
          label: "Service charge",
          group: "Costs",
          value: null,
          type: "currency",
          format: "currency",
          origin: "missing",
          confidence: null,
          sourceDocumentId: null,
          sourcePage: null,
        },
        {
          key: "size_sqft",
          label: "Area",
          group: "Property",
          value: 780,
          type: "number",
          origin: "extracted",
          confidence: 0.88,
          sourceDocumentId: "doc-rr",
          sourcePage: 1,
        },
      ],
      lines: [
        {
          key: "noi",
          label: "NOI",
          group: "Returns",
          value: 61_500,
          format: "currency",
          unit: "AED",
        },
        {
          key: "gross_yield",
          label: "Gross yield",
          group: "Returns",
          value: 0.0743,
          format: "percent",
        },
        {
          key: "net_yield",
          label: "Net yield",
          group: "Returns",
          value: 0.0586,
          format: "percent",
        },
        {
          key: "price_per_sqft",
          label: "Price per sqft",
          group: "Property",
          value: 1346.15,
          format: "per_sqft",
        },
        {
          key: "dscr",
          label: "DSCR",
          group: "Debt",
          value: 1.25,
          format: "ratio",
        },
        {
          key: "net_cash_flow",
          label: "Net cash flow after debt",
          group: "Debt",
          value: -12_400,
          format: "currency",
        },
        {
          key: "reserve",
          label: "Reserve",
          group: "Debt",
          // A line the engine could not evaluate. Must stay blank.
          value: null,
          format: "currency",
          error: "service_charge is missing",
        },
      ],
      returns: [
        { key: "levered_irr", label: "Levered IRR", group: "Exit", value: 0.114, format: "percent" },
        { key: "equity_multiple", label: "Equity multiple", group: "Exit", value: 1.68, format: "multiple" },
      ],
      summary: [
        { key: "gross_yield", label: "Gross yield", group: "Returns", value: 0.0743, format: "percent" },
      ],
      projection: {
        years: 3,
        rows: [
          {
            key: "proj_rent",
            label: "Rent",
            format: "currency",
            values: [78_000, 80_340, 82_750],
          },
          {
            key: "proj_noi",
            label: "NOI",
            format: "currency",
            values: [61_500, 63_345, null],
          },
        ],
      },
      benchmarks: [
        {
          key: "gross_yield",
          label: "Gross yield",
          value: 0.0743,
          status: "good",
          good: 0.07,
          warn: 0.055,
          direction: "higher",
          format: "percent",
          note: "Business Bay 1BR comparables",
        },
        {
          key: "dscr",
          label: "DSCR",
          value: 1.25,
          status: "warn",
          good: 1.35,
          warn: 1.2,
          direction: "higher",
          format: "ratio",
        },
      ],
      flags: [
        {
          id: "thin_dscr",
          severity: "amber",
          title: "DSCR is thin",
          detail: "Cover of 1.25× leaves little headroom.",
          metric: "dscr",
          metricValue: 1.25,
        },
      ],
      warnings: [{ level: "warning", key: "service_charge", message: "No service charge was found" }],
      values: {
        noi: 61_500,
        gross_yield: 0.0743,
        net_yield: 0.0586,
        price_per_sqft: 1346.15,
        dscr: 1.25,
        levered_irr: 0.114,
        equity_multiple: 1.68,
        purchase_price: 1_050_000,
        annual_rent: 78_000,
      },
      durationMs: 12,
    },
    units: [
      unit({
        unit_no: "1204", unit_type: "1BR", beds: 1, baths: 1, area_sqft: 780,
        in_place_rent: 78_000, market_rent: 82_000, cheques: 4,
        lease_start: "2026-01-15", lease_end: "2027-01-14", ejari_no: "EJ-2026-004182",
      }),
      unit({
        unit_no: "1206", unit_type: "1BR", beds: 1, baths: 1, area_sqft: 795,
        in_place_rent: 82_000, market_rent: 84_000, cheques: 2,
        lease_start: "2026-03-01", lease_end: "2027-02-28", ejari_no: "EJ-2026-004183",
      }),
      unit({
        unit_no: "1208", unit_type: "2BR", beds: 2, baths: 2, area_sqft: 1_120,
        in_place_rent: null, market_rent: 118_000, cheques: null,
        occupancy_status: "vacant",
      }),
    ],
    t12: [
      t12Line({ raw_label: "Service Charge - Owners Association", category: "service_charge", amount: 33_687, annualized: 33_687 }),
      t12Line({ raw_label: "District Cooling Capacity Charge", category: "chiller_cooling", amount: 9_600, annualized: 9_600 }),
      t12Line({
        raw_label: "Lift Modernisation Special Levy",
        category: "capex",
        amount: 18_000,
        annualized: 18_000,
        is_recurring: 0,
        exclude_reason: "Non-recurring capital levy, excluded from stabilised NOI",
      }),
    ],
    narrative: {
      engine: "rules",
      status: "ok",
      headline: "Priced in line with Business Bay comparables, thin on cover",
      summary: "A 7.43% gross yield on a 780 sqft one-bedroom.",
      strengths: [{ title: "Yield above target", detail: "7.43% against a 7.00% hurdle." }],
      redFlags: [{ title: "DSCR is thin", detail: "Cover of 1.25× leaves little headroom." }],
      ddItems: [{ title: "Obtain the service charge statement", detail: "No figure was found in the pack." }],
    },
    documents: [
      { id: "doc-om", filename: "Marisol OM.pdf" },
      { id: "doc-rr", filename: "rent-roll.xlsx" },
    ],
    generatedAt: "2026-08-30T10:00:00.000Z",
    ...over,
  };
}

/** Reads the produced binary back the way Excel would, keeping number formats. */
function readBack(bundle: ExportBundle) {
  const buffer = buildWorkbook(bundle);
  return {
    buffer,
    wb: XLSX.read(buffer, { type: "buffer", cellNF: true, cellDates: true }),
  };
}

function findRow(ws: XLSX.WorkSheet, column: string, label: string): number | null {
  const range = XLSX.utils.decode_range(ws["!ref"] as string);
  const col = XLSX.utils.decode_col(column);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
    if (cell && String(cell.v) === label) return r;
  }
  return null;
}

function at(ws: XLSX.WorkSheet, address: string): XLSX.CellObject | undefined {
  return ws[address] as XLSX.CellObject | undefined;
}

// -------------------------------------------------------------------- tests --

test("the workbook is a valid xlsx with every expected sheet, in order", () => {
  const { buffer, wb } = readBack(fixture());

  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK", "an xlsx is a zip");
  assert.deepEqual(wb.SheetNames, [
    "Summary",
    "Inputs",
    "Underwriting",
    "Projection",
    "Rent roll",
    "T12",
    "Analysis",
    "Benchmarks",
  ]);

  for (const name of wb.SheetNames) {
    assert.ok(name.length <= 31, `${name} is too long for Excel`);
    assert.ok(!/[[\]:*?/\\]/.test(name), `${name} contains a character Excel forbids`);
  }
});

test("the Projection sheet is omitted when the run has no projection", () => {
  const bundle = fixture();
  const withoutProjection = fixture({
    result: { ...bundle.result, projection: undefined },
  });
  const { wb } = readBack(withoutProjection);
  assert.ok(!wb.SheetNames.includes("Projection"));
  assert.ok(wb.SheetNames.includes("Summary"));
});

test("a currency figure is a NUMBER with a currency format, not a string", () => {
  const { wb } = readBack(fixture());
  const ws = wb.Sheets.Underwriting;

  const row = findRow(ws, "A", "NOI");
  assert.notEqual(row, null, "the NOI line should be on the Underwriting sheet");

  const cell = at(ws, XLSX.utils.encode_cell({ r: row as number, c: 2 }))!;
  assert.equal(cell.t, "n", "a currency cell must be numeric, not text");
  assert.equal(cell.v, 61_500);
  assert.equal(cell.z, '"AED"#,##0;("AED"#,##0)');
  assert.equal(cell.w, "AED61,500", "it must render as currency in Excel");
});

test("a negative currency figure renders in accounting parentheses", () => {
  const { wb } = readBack(fixture());
  const ws = wb.Sheets.Underwriting;

  const row = findRow(ws, "A", "Net cash flow after debt") as number;
  const cell = at(ws, XLSX.utils.encode_cell({ r: row, c: 2 }))!;
  assert.equal(cell.t, "n");
  assert.equal(cell.v, -12_400);
  assert.equal(cell.w, "(AED12,400)");
});

test("a percentage round-trips as 0.0743 and displays as 7.43%", () => {
  const { wb } = readBack(fixture());
  const ws = wb.Sheets.Underwriting;

  const row = findRow(ws, "A", "Gross yield") as number;
  const cell = at(ws, XLSX.utils.encode_cell({ r: row, c: 2 }))!;

  assert.equal(cell.t, "n");
  // Stored unscaled: multiplying by 100 before writing would make every
  // downstream Excel formula wrong by two orders of magnitude.
  assert.equal(cell.v, 0.0743);
  assert.equal(cell.z, "0.00%");
  assert.equal(cell.w, "7.43%");
});

test("ratios, areas and per-sqft figures carry their own formats", () => {
  const { wb } = readBack(fixture());

  const uw = wb.Sheets.Underwriting;
  const dscr = at(uw, XLSX.utils.encode_cell({ r: findRow(uw, "A", "DSCR") as number, c: 2 }))!;
  assert.equal(dscr.t, "n");
  assert.equal(dscr.z, '0.00"×"');
  assert.equal(dscr.w, "1.25×");

  const psf = at(uw, XLSX.utils.encode_cell({ r: findRow(uw, "A", "Price per sqft") as number, c: 2 }))!;
  assert.equal(psf.z, '"AED"#,##0.00"/sqft"');
  assert.equal(psf.w, "AED1,346.15/sqft");

  const rr = wb.Sheets["Rent roll"];
  const area = at(rr, XLSX.utils.encode_cell({ r: findRow(rr, "A", "1204") as number, c: 4 }))!;
  assert.equal(area.t, "n");
  assert.equal(area.z, '#,##0" sqft"');
  assert.equal(area.w, "780 sqft");
});

test("a null input is a BLANK cell, never a zero", () => {
  const { wb } = readBack(fixture());

  const inputs = wb.Sheets.Inputs;
  const row = findRow(inputs, "C", "service_charge") as number;
  assert.notEqual(row, null);

  const value = at(inputs, XLSX.utils.encode_cell({ r: row, c: 3 }));
  assert.equal(value, undefined, "a missing input must not be written as 0");

  // The provenance still has to say why it is blank.
  const origin = at(inputs, XLSX.utils.encode_cell({ r: row, c: 6 }))!;
  assert.equal(origin.v, "missing");

  // Same rule on a computed line that could not be evaluated...
  const uw = wb.Sheets.Underwriting;
  const reserveRow = findRow(uw, "A", "Reserve") as number;
  assert.equal(at(uw, XLSX.utils.encode_cell({ r: reserveRow, c: 2 })), undefined);
  assert.equal(at(uw, XLSX.utils.encode_cell({ r: reserveRow, c: 4 }))!.v, "service_charge is missing");

  // ...and inside the projection, where a gap in a year must not read as zero.
  const proj = wb.Sheets.Projection;
  const noiRow = findRow(proj, "A", "NOI") as number;
  assert.equal(at(proj, XLSX.utils.encode_cell({ r: noiRow, c: 3 }))!.v, 63_345);
  assert.equal(at(proj, XLSX.utils.encode_cell({ r: noiRow, c: 4 })), undefined);
});

test("the rent-roll totals row foots against its units", () => {
  const bundle = fixture();
  const { wb } = readBack(bundle);
  const ws = wb.Sheets["Rent roll"];

  const totalsRow = findRow(ws, "A", `Total — ${bundle.units.length} units`);
  assert.notEqual(totalsRow, null, "there must be a totals row");

  const expectedArea = bundle.units.reduce((s, u) => s + (u.area_sqft ?? 0), 0);
  const expectedInPlace = bundle.units.reduce((s, u) => s + (u.in_place_rent ?? 0), 0);
  const expectedMarket = bundle.units.reduce((s, u) => s + (u.market_rent ?? 0), 0);

  const area = at(ws, XLSX.utils.encode_cell({ r: totalsRow as number, c: 4 }))!;
  const inPlace = at(ws, XLSX.utils.encode_cell({ r: totalsRow as number, c: 5 }))!;
  const market = at(ws, XLSX.utils.encode_cell({ r: totalsRow as number, c: 6 }))!;

  assert.equal(area.v, expectedArea, "2,695 sqft across three units");
  assert.equal(inPlace.v, expectedInPlace, "160,000 of passing rent — the vacant unit contributes nothing");
  assert.equal(market.v, expectedMarket);
  assert.equal(area.t, "n");
  assert.equal(inPlace.t, "n");

  // The vacant unit's in-place rent is blank, not zero, so the total above is
  // a sum of what was actually recorded.
  const vacantRow = findRow(ws, "A", "1208") as number;
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: vacantRow, c: 5 })), undefined);
});

test("the T12 sheet separates the NOI total from the all-lines total", () => {
  const { wb } = readBack(fixture());
  const ws = wb.Sheets.T12;

  const included = findRow(ws, "A", "Total — included in NOI") as number;
  const all = findRow(ws, "A", "Total — all statement lines") as number;

  // 33,687 + 9,600 recurring; the 18,000 special levy is excluded from NOI but
  // still present in the all-lines total.
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: included, c: 5 }))!.v, 43_287);
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: all, c: 5 }))!.v, 61_287);

  const levyRow = findRow(ws, "A", "Lift Modernisation Special Levy") as number;
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: levyRow, c: 6 }))!.v, "No");
  assert.match(String(at(ws, XLSX.utils.encode_cell({ r: levyRow, c: 7 }))!.v), /Non-recurring/);
});

test("the Summary sheet carries the property, the model and the headline metrics", () => {
  const { wb } = readBack(fixture());
  const ws = wb.Sheets.Summary;

  const value = (label: string) => {
    const r = findRow(ws, "A", label);
    return r === null ? undefined : at(ws, XLSX.utils.encode_cell({ r, c: 1 }));
  };

  assert.equal(value("Deal")!.v, 'Marisol "Residences" / Tower B');
  assert.equal(value("Community")!.v, "Business Bay");
  assert.equal(value("City")!.v, "Dubai");
  assert.equal(value("Asset type")!.v, "residential");
  assert.equal(value("Tenure")!.v, "freehold");
  assert.equal(value("Currency")!.v, "AED");
  assert.equal(value("Model")!.v, "Dubai residential — full");
  assert.equal(value("Model version")!.v, 3);
  assert.ok(value("Run timestamp") !== undefined, "the run must be timestamped");

  // Headline metrics keep their numeric types and formats.
  assert.equal(value("Purchase price")!.v, 1_050_000);
  assert.equal(value("Purchase price")!.t, "n");
  assert.equal(value("Gross yield")!.w, "7.43%");
  assert.equal(value("NOI")!.v, 61_500);
  assert.equal(value("DSCR")!.w, "1.25×");
  assert.equal(value("IRR")!.w, "11.40%");
  assert.equal(value("Equity multiple")!.w, "1.68×");
  assert.equal(value("Price per sqft")!.v, 1346.15);
});

test("the Inputs sheet carries provenance for every input", () => {
  const { wb } = readBack(fixture());
  const ws = wb.Sheets.Inputs;

  const header = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, range: 0 })[0];
  assert.deepEqual(header.slice(0, 11), [
    "Group", "Label", "Key", "Value", "Unit", "Type",
    "Origin", "Confidence", "Source document", "Page", "Source snippet",
  ]);

  const row = findRow(ws, "C", "purchase_price") as number;
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: row, c: 6 }))!.v, "extracted");
  const confidence = at(ws, XLSX.utils.encode_cell({ r: row, c: 7 }))!;
  assert.equal(confidence.t, "n");
  assert.equal(confidence.v, 0.92);
  assert.equal(confidence.w, "92%");
  // The document id is resolved to a filename — a UUID proves nothing to a
  // reader checking where a number came from.
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: row, c: 8 }))!.v, "Marisol OM.pdf");
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: row, c: 9 }))!.v, 4);

  const userRow = findRow(ws, "C", "annual_rent") as number;
  assert.equal(at(ws, XLSX.utils.encode_cell({ r: userRow, c: 6 }))!.v, "user");
});

test("the Analysis and Benchmarks sheets carry the write-up and the gradings", () => {
  const { wb } = readBack(fixture());

  const analysis = wb.Sheets.Analysis;
  const headline = findRow(analysis, "A", "Headline") as number;
  assert.match(
    String(at(analysis, XLSX.utils.encode_cell({ r: headline, c: 1 }))!.v),
    /Business Bay comparables/,
  );
  assert.notEqual(findRow(analysis, "A", "Strength"), null);
  assert.notEqual(findRow(analysis, "A", "Red flag"), null);
  assert.notEqual(findRow(analysis, "A", "Due diligence"), null);
  assert.notEqual(findRow(analysis, "A", "Flag (amber)"), null);

  const benchmarks = wb.Sheets.Benchmarks;
  const dscr = findRow(benchmarks, "A", "DSCR") as number;
  assert.equal(at(benchmarks, XLSX.utils.encode_cell({ r: dscr, c: 1 }))!.w, "1.25×");
  assert.equal(at(benchmarks, XLSX.utils.encode_cell({ r: dscr, c: 2 }))!.w, "1.35×");
  assert.equal(at(benchmarks, XLSX.utils.encode_cell({ r: dscr, c: 3 }))!.w, "1.20×");
  assert.equal(at(benchmarks, XLSX.utils.encode_cell({ r: dscr, c: 5 }))!.v, "Warn");

  const yieldRow = findRow(benchmarks, "A", "Gross yield") as number;
  assert.equal(at(benchmarks, XLSX.utils.encode_cell({ r: yieldRow, c: 5 }))!.v, "Pass");
});

test("every sheet freezes its header row and sets column widths", () => {
  const wb = buildWorkbookModel(fixture());

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name] as Record<string, unknown>;
    assert.equal(ws["!freeze"], "A2", `${name} does not freeze its header row`);
    const cols = ws["!cols"] as Array<{ wch: number }> | undefined;
    assert.ok(cols && cols.length > 0, `${name} has no column widths`);
    assert.ok(
      cols!.every((c) => typeof c.wch === "number" && c.wch >= 6),
      `${name} has a column too narrow to read`,
    );
  }
});

test("the serialised workbook actually contains frozen panes", () => {
  const buffer = buildWorkbook(fixture());
  const container = (XLSX as unknown as {
    CFB: { read: (b: Buffer, o: { type: string }) => unknown; find: (c: unknown, p: string) => { content: Uint8Array } | null };
  }).CFB;

  const cfb = container.read(buffer, { type: "buffer" });
  const sheet1 = container.find(cfb, "/xl/worksheets/sheet1.xml");
  assert.ok(sheet1, "sheet1.xml should be in the package");
  const xml = Buffer.from(sheet1!.content).toString("utf8");
  assert.match(xml, /<pane [^>]*ySplit="1"[^>]*state="frozen"/);
});

// --------------------------------------------------------------- filenames --

test("the filename sanitiser strips separators, quotes and control characters", () => {
  assert.equal(sanitiseFilename("Marisol/Residences"), "Marisol Residences");
  assert.equal(sanitiseFilename("Marisol\\Residences"), "Marisol Residences");
  assert.equal(sanitiseFilename('Marisol "Residences"'), "Marisol Residences");
  assert.equal(sanitiseFilename("Marisol 'Residences'"), "Marisol Residences");

  // Control characters, including the CR/LF that would inject a header.
  const hostile = `Tower${String.fromCharCode(13)}${String.fromCharCode(10)}Set-Cookie: a=b`;
  const cleaned = sanitiseFilename(hostile);
  assert.ok(!/[\r\n]/.test(cleaned), "CR and LF must not survive");
  assert.equal(cleaned, "Tower Set-Cookie: a=b".replace(":", ""));

  assert.ok(!sanitiseFilename(`a${String.fromCharCode(0)}b`).includes(String.fromCharCode(0)));

  // Traversal, reserved characters and hidden-file tricks.
  assert.equal(sanitiseFilename("../../etc/passwd"), "etc passwd");
  assert.equal(sanitiseFilename(".hidden"), "hidden");
  assert.equal(sanitiseFilename("a:b*c?d<e>f|g"), "a b c d e f g");

  // Nothing usable left over: never an empty filename.
  assert.equal(sanitiseFilename('"""'), "meridian-export");
  assert.equal(sanitiseFilename("   "), "meridian-export");
  assert.equal(sanitiseFilename(""), "meridian-export");

  assert.ok(sanitiseFilename("x".repeat(500)).length <= 80);
});

test("the content-disposition header is safe and carries a UTF-8 form", () => {
  const filename = exportFilename('Marisol "Residences" / Tower B', "xlsx");
  assert.equal(filename, "Marisol Residences Tower B underwriting.xlsx");

  const header = contentDisposition(filename);
  assert.ok(header.startsWith('attachment; filename="'));
  assert.ok(!/[\r\n]/.test(header));
  assert.match(header, /filename\*=UTF-8''/);

  // A non-Latin name still produces a header with no raw non-ASCII bytes.
  const arabic = contentDisposition(exportFilename("برج مريسول", "xlsx"));
  assert.ok(!/[^\x20-\x7e]/.test(arabic), "the header must be ASCII-safe");
  assert.match(arabic, /filename\*=UTF-8''%/);
});

test("sheet names are made legal for Excel", () => {
  assert.equal(safeSheetName("Rent roll"), "Rent roll");
  assert.equal(safeSheetName("A/B:C*D?E[F]G"), "A B C D E F G");
  assert.equal(safeSheetName("x".repeat(60)).length, 31);
  assert.equal(safeSheetName(""), "Sheet");
});

// -------------------------------------------------------- format primitives --

test("number formats follow the Dubai conventions", () => {
  assert.equal(currencyFormat("AED"), '"AED"#,##0;("AED"#,##0)');
  assert.equal(currencyFormat("USD", 2), '"USD"#,##0.00;("USD"#,##0.00)');
  // A currency that is not a plain code cannot be smuggled into a format string.
  assert.equal(currencyFormat('A"ED'), '"AED"#,##0;("AED"#,##0)');

  assert.equal(numberFormat("percent", "AED"), "0.00%");
  assert.equal(numberFormat("percent", "AED", 1), "0.0%");
  assert.equal(numberFormat("ratio", "AED"), '0.00"×"');
  assert.equal(numberFormat("multiple", "AED"), '0.00"×"');
  assert.equal(numberFormat("years", "AED"), '0.0" yrs"');
  assert.equal(numberFormat("integer", "AED"), "#,##0");
  assert.equal(numberFormat("currency", "AED"), '"AED"#,##0;("AED"#,##0)');
  // Undeclared: a bare rate is still read as a rate, matching formatValue().
  assert.equal(numberFormat(undefined, "AED", undefined, 0.0743), "0.00%");
  assert.equal(numberFormat(undefined, "AED", undefined, 250_000), "#,##0");
});

// --------------------------------------------------------------------- CSV --

test("the CSV is flat, quoted correctly and keeps raw numbers", () => {
  const csv = buildCsv(fixture());
  const lines = csv.split("\r\n");

  assert.ok(csv.startsWith("﻿"), "Excel needs the BOM to read UTF-8");
  assert.equal(
    lines[0].replace("﻿", ""),
    "section,group,key,label,value,formatted,unit,origin,confidence,source_document,source_page,note",
  );

  const priceRow = lines.find((l) => l.includes(",purchase_price,"))!;
  assert.ok(priceRow.includes(",1050000,"), "the raw value must be an unformatted number");
  assert.ok(priceRow.includes('"AED 1,050,000"'), "the formatted column uses the Dubai convention");
  assert.ok(priceRow.includes(",extracted,"), "provenance travels with the figure");

  const yieldRow = lines.find((l) => l.startsWith("line,Returns,gross_yield,"))!;
  assert.ok(yieldRow.includes(",0.0743,"), "a rate stays unscaled");
  assert.ok(yieldRow.includes(",7.43%,"));

  // A missing figure is empty in both columns, not zero.
  const missingRow = lines.find((l) => l.includes(",service_charge,"))!;
  assert.ok(missingRow.includes(",,,"), "a null must be blank");
  assert.ok(!/,0,/.test(missingRow), "a null must never become 0");

  // Every computed line and input is present, one row each.
  const bundle = fixture();
  const expected =
    1 + bundle.result.inputs.length + bundle.result.lines.length + bundle.result.returns.length;
  assert.equal(lines.filter((l) => l.length > 0).length, expected);
});

test("the CSV neutralises a formula-injection attempt in a label", () => {
  const bundle = fixture();
  const hostile = fixture({
    result: {
      ...bundle.result,
      lines: [
        {
          key: "hostile",
          label: '=HYPERLINK("http://evil.test","click")',
          group: "Returns",
          value: 1,
          format: "number",
        },
      ],
      returns: [],
    },
  });

  const csv = buildCsv(hostile);
  assert.ok(csv.includes(`"'=HYPERLINK`), "a leading = must be neutralised before Excel sees it");
  assert.ok(!/,=HYPERLINK/.test(csv));
});
