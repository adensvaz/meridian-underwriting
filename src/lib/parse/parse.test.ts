// Tests for the parse layer.
//
// Every fixture is generated programmatically into a temp directory: a real
// .xlsx written by the same library that reads it back (merged banner, three
// junk rows above the header, a formula, a date, a number stored as text), a
// CSV, a TSV, a real multi-page PDF assembled byte by byte, and — the important
// one — an HTML error page saved as "statement.pdf".

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import XLSX from "xlsx";

import { detectFileType } from "./detect.ts";
import { parseDocument } from "./index.ts";
import { parsePdf } from "./pdf.ts";
import { parseSheetWorkbook } from "./sheet.ts";
import { parseDocx } from "./docx.ts";
import { parseTextDocument, htmlToText, extractHtmlTables, decodeEntities } from "./text.ts";
import {
  parseNumber,
  inferHeaders,
  detectHeaderRow,
  classifyColumns,
  isLikelyRentRoll,
  isLikelyT12,
} from "./tables.ts";

let dir = "";

// ----------------------------------------------------------------- fixtures --

/** A minimal but structurally valid PDF with one text run per page. */
function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids: string[] = [];
  let next = 4;

  for (const page of pages) {
    const contentNo = next++;
    const pageNo = next++;
    const escaped = page.replace(/([()\\])/g, "\\$1");
    const stream = `BT /F1 12 Tf 40 750 Td (${escaped}) Tj ET`;
    objects[contentNo] =
      `${contentNo} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
    objects[pageNo] =
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`;
    kids.push(`${pageNo} 0 R`);
  }

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] =
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += objects[i];
  }
  const xrefAt = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    body += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** Rent roll with a merged banner, three junk rows, a formula and a text number. */
function buildRentRollWorkbook(): Buffer {
  const rows: unknown[][] = [
    ["SUNRISE TOWER — RENT ROLL", null, null, null, null, null, null],
    ["Dubai Marina, Dubai, UAE", null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    ["Unit No", "Unit Type", "BUA (Sq Ft)", "Annual Rent (AED)", "No. of Cheques", "Lease Start", "Lease End"],
    ["101", "1BR", 812, 65000, 4, new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2025, 11, 31))],
    ["102", "2BR", 1240, "95,000", 2, new Date(Date.UTC(2025, 2, 15)), new Date(Date.UTC(2026, 2, 14))],
    ["103", "2BR", 1240, 98000, 1, new Date(Date.UTC(2025, 5, 1)), new Date(Date.UTC(2026, 4, 31))],
    ["104", "3BR", 1780, 145000, 4, new Date(Date.UTC(2024, 10, 1)), new Date(Date.UTC(2025, 9, 31))],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  // Merged banner across A1:G1 and A2:G2 — the classic broker export header.
  sheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
  ];
  // A cached formula total. We must read 403000, never "SUM(D5:D8)".
  sheet["D9"] = { t: "n", f: "SUM(D5:D8)", v: 403000 };
  sheet["C9"] = { t: "s", v: "Total" };
  sheet["!ref"] = "A1:G9";

  const t12 = XLSX.utils.aoa_to_sheet([
    ["Account", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Total"],
    ["Gross Potential Rent", 100, 100, 100, 100, 100, 100, 600],
    ["Vacancy Loss", -5, -5, -5, -5, -5, -5, -30],
    ["Total Operating Expenses", -20, -20, -20, -20, -20, -20, -120],
    ["Net Operating Income", 75, 75, 75, 75, 75, 75, 450],
  ]);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Rent Roll");
  XLSX.utils.book_append_sheet(workbook, t12, "Operating Statement");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[]]), "Notes");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer;
}

// ---- a real .docx, built as a STORED (uncompressed) zip -------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12); // 2000-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 30); // extra + comment lengths
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);

    offset += local.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function para(text: string, style?: string): string {
  const props = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function cell(text: string): string {
  return `<w:tc><w:tcPr/>${para(text)}</w:tc>`;
}

function buildDocx(): Buffer {
  const table =
    "<w:tbl><w:tblPr/>" +
    `<w:tr>${["Unit No", "Unit Type", "Annual Rent (AED)", "No. of Cheques"].map(cell).join("")}</w:tr>` +
    `<w:tr>${["101", "1BR", "65,000", "4"].map(cell).join("")}</w:tr>` +
    `<w:tr>${["102", "2BR", "95,000", "2"].map(cell).join("")}</w:tr>` +
    `<w:tr>${["103", "2BR", "98,000", "1"].map(cell).join("")}</w:tr>` +
    "</w:tbl>";

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${W_NS}><w:body>` +
    para("Sunrise Tower Offering Memorandum", "Heading1") +
    para("Dubai Marina, Dubai, UAE. Purchase price AED 265,000,000.") +
    para("Rent Roll Summary", "Heading2") +
    para("Four representative units are shown below.") +
    table +
    "</w:body></w:document>";

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles ${W_NS}>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>` +
    "</w:styles>";

  return buildZip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        "</Types>",
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        "</Relationships>",
    ],
    [
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    ],
    ["word/styles.xml", styles],
    ["word/document.xml", document],
  ]);
}

const HTML_ERROR_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>403 Forbidden</title></head>
<body>
  <h1>Access denied</h1>
  <p>You need to sign in to download this document.</p>
  <table>
    <tr><th>Field</th><th>Value</th></tr>
    <tr><td>Reference</td><td>DXB-2025-118</td></tr>
  </table>
</body>
</html>
`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "meridian-parse-"));

  await writeFile(join(dir, "sunrise-rent-roll.xlsx"), buildRentRollWorkbook());
  await writeFile(join(dir, "statement.pdf"), HTML_ERROR_PAGE, "utf8");
  await writeFile(
    join(dir, "t12.csv"),
    [
      "Sunrise Tower — Trailing 12 Operating Statement",
      "For the period ended 30 June 2025",
      "",
      "Account,Jan,Feb,Mar,Apr,May,Jun,Total",
      "Gross Potential Rent,\"1,200,000\",\"1,200,000\",\"1,200,000\",\"1,200,000\",\"1,200,000\",\"1,200,000\",\"7,200,000\"",
      "Vacancy Loss,\"(60,000)\",\"(60,000)\",\"(60,000)\",\"(60,000)\",\"(60,000)\",\"(60,000)\",\"(360,000)\"",
      "Service Charge,\"(180,000)\",\"(180,000)\",\"(180,000)\",\"(180,000)\",\"(180,000)\",\"(180,000)\",\"(1,080,000)\"",
      "Net Operating Income,\"960,000\",\"960,000\",\"960,000\",\"960,000\",\"960,000\",\"960,000\",\"5,760,000\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "units.tsv"),
    ["Unit\tType\tSq Ft\tAnnual Rent", "201\t1BR\t790\t62000", "202\t2BR\t1180\t89000"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "offering.pdf"),
    buildPdf([
      "SUNRISE TOWER OFFERING MEMORANDUM Dubai Marina investment summary and the offering",
      "Property overview: 120 residential units, purchase price AED 265,000,000, asking price on request",
      "Financial summary: net operating income AED 18,400,000 and effective gross income AED 24,100,000",
    ]),
  );
  await writeFile(join(dir, "scan.pdf"), buildPdf(["", " ", ""]));
  await writeFile(join(dir, "notes.md"), "# Deal notes\n\nSee the OM.\n\n## Risks\n\n- Lease rollover\n");
  await writeFile(join(dir, "summary.docx"), buildDocx());
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------ magic bytes vs extension --

describe("detectFileType: magic bytes beat the extension", () => {
  test("an HTML error page named .pdf is detected as HTML, not PDF", async () => {
    const buf = await readFile(join(dir, "statement.pdf"));
    const result = await detectFileType(buf, "statement.pdf");

    assert.equal(result.type, "html");
    assert.equal(result.mime, "text/html");
    assert.ok(result.confidence >= 0.9, `confidence too low: ${result.confidence}`);
    assert.equal(result.extension, "pdf");
    assert.equal(result.extensionMismatch, true);
    assert.match(result.reason, /content-sniff/);
    assert.match(result.reason, /html/i);
    assert.match(result.reason, /filename claims \.pdf/);
  });

  test("parseDocument refuses to treat the lying .pdf as a scanned PDF", async () => {
    const buf = await readFile(join(dir, "statement.pdf"));
    const parsed = await parseDocument(buf, "statement.pdf");

    assert.equal(parsed.ok, true);
    assert.equal(parsed.type, "html");
    assert.equal(parsed.isScanned, false);
    assert.equal(parsed.pageCount, undefined);
    assert.ok(
      parsed.warnings.some((w) => /extension.*ignored|does not match|\.pdf extension/i.test(w)),
      `expected an extension-mismatch warning, got ${JSON.stringify(parsed.warnings)}`,
    );
    const text = parsed.segments.map((s) => s.content).join("\n");
    assert.match(text, /Access denied/);
  });

  test("a real PDF is detected by its %PDF header", async () => {
    const buf = await readFile(join(dir, "offering.pdf"));
    const result = await detectFileType(buf, "offering.pdf");
    assert.equal(result.type, "pdf");
    assert.equal(result.extensionMismatch, false);
    assert.match(result.reason, /magic-bytes/);
  });

  test("an xlsx renamed to .pdf is still detected as a workbook", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const result = await detectFileType(buf, "rentroll.pdf");
    assert.equal(result.type, "xlsx");
    assert.equal(result.extensionMismatch, true);
    assert.match(result.reason, /zip-entry/);
    assert.match(result.reason, /xl\//);
  });

  test("csv and tsv are told apart by their delimiter, not their name", async () => {
    const csv = await detectFileType(await readFile(join(dir, "t12.csv")), "t12.dat");
    assert.equal(csv.type, "csv");
    assert.match(csv.reason, /comma/);

    const tsv = await detectFileType(await readFile(join(dir, "units.tsv")), "units.dat");
    assert.equal(tsv.type, "tsv");
    assert.match(tsv.reason, /tab/);
  });

  test("empty and binary buffers are named, not guessed", async () => {
    const empty = await detectFileType(Buffer.alloc(0), "deal.pdf");
    assert.equal(empty.type, "empty");
    assert.match(empty.reason, /magic-bytes/);

    const png = await detectFileType(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      "rentroll.xlsx",
    );
    assert.equal(png.type, "image");
    assert.equal(png.extensionMismatch, true);
  });

  test("markdown falls back to the extension only when the bytes are ambiguous", async () => {
    const ambiguous = Buffer.from("Just one ordinary sentence with no structure at all.\n");
    const asMd = await detectFileType(ambiguous, "notes.md");
    assert.equal(asMd.type, "markdown");
    assert.match(asMd.reason, /extension-tiebreak/);

    const asTxt = await detectFileType(ambiguous, "notes.txt");
    assert.equal(asTxt.type, "text");
    assert.match(asTxt.reason, /content-sniff/);
  });
});

// --------------------------------------------------------------- numbers --

describe("parseNumber", () => {
  const cases: Array<[unknown, number | null]> = [
    ["AED 1,250,000", 1250000],
    ["1,250,000", 1250000],
    ["1250000", 1250000],
    ["(4,200)", -4200],
    ["(4200)", -4200],
    ["-4,200", -4200],
    ["4,200-", -4200],
    ["6.5%", 0.065],
    ["(6.5%)", -0.065],
    ["1.2M", 1200000],
    ["1.2m", 1200000],
    ["850k", 850000],
    ["1.4bn", 1400000000],
    ["-", null],
    ["–", null],
    ["n/a", null],
    ["N/A", null],
    ["#DIV/0!", null],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
    ["٠١٢٣٤٥٦٧٨٩", 123456789],
    ["١,٢٥٠,٠٠٠", 1250000],
    ["٦٫٥%", 0.065],
    ["1 250 000", 1250000],
    ["1 250 000", 1250000],
    ["AED 1 250 000.50", 1250000.5],
    ["1.250.000", 1250000],
    ["1.250,75", 1250.75],
    ["72,000", 72000],
    ["0", 0],
    ["0.0", 0],
    [0, 0],
    [-3.5, -3.5],
    ["1,250 sq ft", 1250],
    ["AED 95,000 per annum", 95000],
    ["3 bedrooms", null],
    ["see attached", null],
    [true, null],
    [new Date(), null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input instanceof Date ? "Date" : input)} → ${expected}`, () => {
      const actual = parseNumber(input);
      if (expected === null) {
        assert.equal(actual, null);
      } else {
        assert.ok(actual !== null, "expected a number, got null");
        assert.ok(Number.isFinite(actual), "must never be NaN or Infinity");
        assert.ok(
          Math.abs(actual - expected) < 1e-9,
          `expected ${expected}, got ${actual}`,
        );
      }
    });
  }

  test("never returns NaN, and never a silent zero", () => {
    for (const junk of ["abc", "-", "n/a", "", "  ", "#REF!", "TBD", "vacant"]) {
      const value = parseNumber(junk);
      assert.equal(value, null, `${junk} should be null, got ${value}`);
      assert.ok(!Number.isNaN(value as unknown as number));
    }
  });

  test("percent can be returned verbatim when asked", () => {
    assert.equal(parseNumber("6.5%", { percentAsFraction: false }), 6.5);
  });
});

// ---------------------------------------------------------------- sheets --

describe("sheet parsing", () => {
  test("merged cells are unmerged into every covered cell", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const result = await parseSheetWorkbook(buf, "xlsx");

    assert.equal(result.ok, true);
    const sheet = result.sheets.find((s) => s.name === "Rent Roll");
    assert.ok(sheet, "Rent Roll sheet missing");
    assert.ok(sheet.mergedRanges >= 2, "expected merge ranges to have been present");

    const banner = sheet.rows[0]!;
    assert.equal(banner.length, 7);
    for (let c = 0; c < 7; c++) {
      assert.equal(
        banner[c],
        "SUNRISE TOWER — RENT ROLL",
        `column ${c} of the merged banner was not filled`,
      );
    }
    assert.equal(sheet.rows[1]![6], "Dubai Marina, Dubai, UAE");
  });

  test("header row is inferred beneath three junk rows", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const result = await parseSheetWorkbook(buf, "xlsx");
    const sheet = result.sheets.find((s) => s.name === "Rent Roll")!;

    assert.equal(sheet.headerRowIndex, 3);
    assert.deepEqual(sheet.rows[sheet.headerRowIndex], [
      "Unit No", "Unit Type", "BUA (Sq Ft)", "Annual Rent (AED)",
      "No. of Cheques", "Lease Start", "Lease End",
    ]);

    const inferred = inferHeaders(sheet.rows);
    assert.equal(inferred.headerRowIndex, 3);
    assert.deepEqual(inferred.headers, [
      "unit_no", "unit_type", "bua_sq_ft", "annual_rent_aed",
      "no_of_cheques", "lease_start", "lease_end",
    ]);
  });

  test("formulas resolve to the cached value, dates to ISO, text numbers stay text", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const result = await parseSheetWorkbook(buf, "xlsx");
    const sheet = result.sheets.find((s) => s.name === "Rent Roll")!;

    // Row 8 (0-based) is the totals row carrying =SUM(D5:D8).
    const totals = sheet.rows[8]!;
    assert.equal(totals[3], "403000");
    assert.ok(!totals.some((c) => c.includes("SUM(")), "a formula string leaked into the rows");

    assert.equal(sheet.rows[4]![5], "2025-01-01");
    assert.equal(sheet.rows[4]![6], "2025-12-31");
    assert.equal(sheet.rows[5]![3], "95,000"); // number stored as text, untouched
    assert.equal(parseNumber(sheet.rows[5]![3]), 95000);
  });

  test("multiple sheets, including a completely empty one", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const result = await parseSheetWorkbook(buf, "xlsx");

    assert.equal(result.sheets.length, 3);
    assert.deepEqual(result.sheets.map((s) => s.name), ["Rent Roll", "Operating Statement", "Notes"]);
    assert.deepEqual(result.sheets.map((s) => s.index), [0, 1, 2]);

    const empty = result.sheets[2]!;
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.csv, "");
    assert.equal(empty.headerRowIndex, -1);
    assert.ok(result.warnings.some((w) => /empty/i.test(w)));
  });

  test("usedRange and csv are populated", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const result = await parseSheetWorkbook(buf, "xlsx");
    const sheet = result.sheets[0]!;
    assert.match(sheet.usedRange, /^A1:[A-Z]+\d+$/);
    assert.match(sheet.csv, /Unit No,Unit Type/);
    // Commas inside a value must be quoted, not split the column.
    assert.match(sheet.csv, /"95,000"/);
  });

  test("csv and tsv go through the same path", async () => {
    const csv = await parseSheetWorkbook(await readFile(join(dir, "t12.csv")), "csv");
    assert.equal(csv.ok, true);
    assert.equal(csv.sheets.length, 1);
    assert.equal(csv.sheets[0]!.headerRowIndex, 3);

    const tsv = await parseSheetWorkbook(await readFile(join(dir, "units.tsv")), "tsv");
    assert.equal(tsv.ok, true);
    assert.deepEqual(tsv.sheets[0]!.rows[0], ["Unit", "Type", "Sq Ft", "Annual Rent"]);
    assert.equal(tsv.sheets[0]!.headerRowIndex, 0);
  });
});

// ---------------------------------------------------------------- tables --

describe("header inference and column classification", () => {
  test("header row is found under three junk rows in a bare array", () => {
    const rows = [
      ["Sunrise Tower", "", "", ""],
      ["Rent roll as at 30 June 2025", "", "", ""],
      ["", "", "", ""],
      ["Unit", "Beds", "Annual Rent", "Lease End"],
      ["101", "1", "65000", "2025-12-31"],
      ["102", "2", "95000", "2026-03-14"],
      ["103", "2", "98000", "2026-05-31"],
    ];
    assert.equal(detectHeaderRow(rows), 3);
    assert.equal(inferHeaders(rows).headerRowIndex, 3);
  });

  test("Dubai rent-roll vocabulary is classified", () => {
    const rows = [
      ["Unit No", "Unit Type", "BUA (Sq Ft)", "Annual Rent (AED)", "No. of Cheques", "Ejari No", "Tenant Name", "Lease Start", "Lease End", "Status"],
      ["101", "1BR", "812", "65,000", "4", "E-1001", "A. Khan", "2025-01-01", "2025-12-31", "Occupied"],
      ["102", "2BR", "1240", "95,000", "2", "E-1002", "B. Ali", "2025-03-15", "2026-03-14", "Occupied"],
    ];
    const roles = classifyColumns(rows, 0).map((c) => c.role);
    assert.deepEqual(roles, [
      "unit_no", "unit_type", "area_sqft", "annual_rent", "cheques",
      "ejari", "tenant", "lease_start", "lease_end", "status",
    ]);
  });

  test("US rent-roll vocabulary is classified", () => {
    const rows = [
      ["Unit", "Sq Ft", "Market Rent", "Monthly Rent", "Lease Expiration", "Charge Code"],
      ["1A", "790", "62000", "5200", "12/31/2025", "RENT"],
      ["1B", "1180", "89000", "7400", "03/14/2026", "RENT"],
    ];
    const roles = classifyColumns(rows, 0).map((c) => c.role);
    assert.deepEqual(roles, [
      "unit_no", "area_sqft", "annual_rent", "monthly_rent", "lease_end", "label",
    ]);
  });

  test("column content is inspected when the header is unhelpful", () => {
    const rows = [
      ["", "", ""],
      ["101", "2025-01-01", "AED 65,000"],
      ["102", "2025-03-15", "AED 95,000"],
      ["103", "2025-06-01", "AED 98,000"],
      ["104", "2024-11-01", "AED 145,000"],
    ];
    const columns = classifyColumns(rows, 0);
    assert.equal(columns[1]!.role, "lease_start");
    assert.equal(columns[1]!.evidence, "content");
    assert.equal(columns[2]!.role, "amount");
    assert.equal(columns[2]!.evidence, "content");
  });

  test("isLikelyRentRoll / isLikelyT12 separate the two document shapes", () => {
    const rentRoll = [
      ["Unit No", "Unit Type", "Annual Rent (AED)", "No. of Cheques", "Lease End"],
      ["101", "1BR", "65,000", "4", "2025-12-31"],
      ["102", "2BR", "95,000", "2", "2026-03-14"],
      ["103", "2BR", "98,000", "1", "2026-05-31"],
    ];
    const t12 = [
      ["Account", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Total"],
      ["Gross Potential Rent", "1", "1", "1", "1", "1", "1", "1", "7"],
      ["Vacancy Loss", "(1)", "(1)", "(1)", "(1)", "(1)", "(1)", "(1)", "(7)"],
      ["Net Operating Income", "1", "1", "1", "1", "1", "1", "1", "7"],
    ];

    assert.equal(isLikelyRentRoll(rentRoll), true);
    assert.equal(isLikelyT12(rentRoll), false);
    assert.equal(isLikelyT12(t12), true);
    assert.equal(isLikelyRentRoll([["a"], ["b"]]), false);
  });
});

// ------------------------------------------------------------------- PDF --

describe("pdf parsing", () => {
  test("text comes out per page with real page numbers", async () => {
    const buf = await readFile(join(dir, "offering.pdf"));
    const result = await parsePdf(buf);

    assert.equal(result.ok, true, result.error);
    assert.equal(result.pageCount, 3);
    assert.equal(result.pages.length, 3);
    assert.deepEqual(result.pages.map((p) => p.pageNo), [1, 2, 3]);
    assert.equal(result.meta.extraction, "pagerender");
    assert.match(result.pages[0]!.text, /OFFERING MEMORANDUM/);
    assert.match(result.pages[1]!.text, /265,000,000/);
    assert.match(result.pages[2]!.text, /18,400,000/);
    assert.equal(result.hasTextLayer, true);
    assert.equal(result.isScanned, false);
  });

  test("an image-only PDF is flagged as scanned instead of returning nothing", async () => {
    const buf = await readFile(join(dir, "scan.pdf"));
    const result = await parsePdf(buf);

    assert.equal(result.ok, true, result.error);
    assert.equal(result.pageCount, 3);
    assert.equal(result.isScanned, true);
    assert.equal(result.hasTextLayer, false);
    assert.ok(result.meta.charsPerPage < 50);
    assert.ok(result.meta.warnings.some((w) => /scanned|image-only/i.test(w)));
  });

  test("a Buffer whose ArrayBuffer is shared still parses (pdf.js pooling trap)", async () => {
    // Buffer.from(string) allocates out of Node's shared 8 KB pool, so
    // byteOffset is non-zero. pdf.js re-wraps `value.buffer`, which would read
    // unrelated memory unless pdf.ts copies first.
    const pdf = buildPdf(["Pooled buffer page with enough words to count as a text layer"]);
    const pooled = Buffer.from(pdf.toString("latin1"), "latin1");
    assert.ok(pooled.byteOffset > 0 || pooled.buffer.byteLength > pooled.length);

    const result = await parsePdf(pooled);
    assert.equal(result.ok, true, result.error);
    assert.match(result.pages[0]!.text, /Pooled buffer page/);
  });
});

// ------------------------------------------------------------ text / html --

describe("text and html", () => {
  test("entities decode and block structure survives as newlines", () => {
    const text = htmlToText(
      "<div><h2>Rent &amp; Service Charge</h2><p>AED&nbsp;1,250,000</p><p>Net&#8212;Operating</p></div>",
    );
    assert.match(text, /Rent & Service Charge/);
    assert.match(text, /AED 1,250,000/);
    assert.match(text, /Net—Operating/);
    assert.ok(text.split("\n").length >= 3, `expected block breaks, got ${JSON.stringify(text)}`);
  });

  test("script and style content is dropped", () => {
    const text = htmlToText("<style>p{color:red}</style><p>Keep</p><script>alert(1)</script>");
    assert.equal(text, "Keep");
  });

  test("numeric and named entities", () => {
    assert.equal(decodeEntities("&amp;&lt;&gt;&#65;&#x42;&notarealentity;"), "&<>AB&notarealentity;");
  });

  test("html tables are extracted with colspan expanded", () => {
    const tables = extractHtmlTables(
      "<table><tr><th colspan='2'>Rent</th></tr><tr><td>101</td><td>65,000</td></tr></table>",
    );
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0]![0], ["Rent", "Rent"]);
    assert.deepEqual(tables[0]![1], ["101", "65,000"]);
  });

  test("markdown is segmented by heading", async () => {
    const result = await parseTextDocument(await readFile(join(dir, "notes.md")), "markdown");
    assert.equal(result.ok, true);
    assert.deepEqual(result.sections.map((s) => s.heading), ["Deal notes", "Risks"]);
    assert.deepEqual(result.sections.map((s) => s.level), [1, 2]);
  });
});

// ------------------------------------------------------------------ DOCX --

describe("docx parsing", () => {
  test("a .docx is detected from its zip parts", async () => {
    const result = await detectFileType(await readFile(join(dir, "summary.docx")), "summary.docx");
    assert.equal(result.type, "docx");
    assert.match(result.reason, /zip-entry/);
    assert.match(result.reason, /word\//);
  });

  test("text, heading sections and tables all come out", async () => {
    const result = await parseDocx(await readFile(join(dir, "summary.docx")));

    assert.equal(result.ok, true, result.error);
    assert.match(result.text, /Sunrise Tower Offering Memorandum/);
    assert.match(result.text, /265,000,000/);

    assert.deepEqual(result.sections.map((s) => s.heading), [
      "Sunrise Tower Offering Memorandum",
      "Rent Roll Summary",
    ]);
    assert.deepEqual(result.sections.map((s) => s.level), [1, 2]);
    assert.match(result.sections[1]!.content, /representative units/);

    assert.equal(result.tables.length, 1);
    const table = result.tables[0]!;
    assert.equal(table.headerRowIndex, 0);
    assert.deepEqual(table.rows[0], ["Unit No", "Unit Type", "Annual Rent (AED)", "No. of Cheques"]);
    assert.deepEqual(table.columns.map((c) => c.role), [
      "unit_no", "unit_type", "annual_rent", "cheques",
    ]);
  });

  test("parseDocument segments a .docx by section and keeps its tables", async () => {
    const parsed = await parseDocument(await readFile(join(dir, "summary.docx")), "summary.docx");

    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.type, "docx");
    assert.equal(parsed.hasTextLayer, true);
    assert.equal(parsed.isScanned, false);
    assert.ok(parsed.segments.length >= 2);
    assert.ok(parsed.segments.every((s) => s.kind === "section"));
    assert.deepEqual(parsed.segments.map((s) => s.ordinal), parsed.segments.map((_, i) => i));
    assert.ok(parsed.segments.every((s) => s.pageNo === undefined && s.sheetName === undefined));
    assert.equal(parsed.tables?.length, 1);
  });
});

// ------------------------------------------------------------ parseDocument --

describe("parseDocument", () => {
  test("a corrupt buffer returns ok:false and does not throw", async () => {
    const corrupt = Buffer.from("%PDF-1.7\nthis is not remotely a pdf\n%%EOF");
    const parsed = await parseDocument(corrupt, "broken.pdf");

    assert.equal(parsed.ok, false);
    assert.equal(parsed.type, "pdf");
    assert.equal(typeof parsed.error, "string");
    assert.ok((parsed.error ?? "").length > 0);
    assert.deepEqual(parsed.segments, []);
  });

  test("a truncated zip claiming to be xlsx fails cleanly", async () => {
    const real = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const parsed = await parseDocument(real.subarray(0, 400), "rent-roll.xlsx");
    assert.equal(parsed.ok, false);
    assert.equal(typeof parsed.error, "string");
  });

  test("nothing throws for a spread of hostile inputs", async () => {
    const inputs: Array<[Buffer, string]> = [
      [Buffer.alloc(0), "empty.pdf"],
      [Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), "binary.xlsx"],
      [Buffer.from("PKgarbage"), "archive.docx"],
      [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "legacy.xls"],
      [Buffer.from("%PDF-1.4\n"), "stub.pdf"],
      [Buffer.from("���"), "mojibake.txt"],
    ];
    for (const [buf, name] of inputs) {
      const parsed = await parseDocument(buf, name);
      assert.equal(typeof parsed.ok, "boolean", `${name} did not return a result`);
      assert.ok(Array.isArray(parsed.segments));
      assert.ok(Array.isArray(parsed.warnings));
      if (!parsed.ok) assert.equal(typeof parsed.error, "string");
    }
  });

  test("a workbook yields one segment per sheet with provenance", async () => {
    const buf = await readFile(join(dir, "sunrise-rent-roll.xlsx"));
    const parsed = await parseDocument(buf, "sunrise-rent-roll.xlsx");

    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.type, "xlsx");
    assert.equal(parsed.sheetCount, 3);
    assert.equal(parsed.segments.length, 3);
    assert.deepEqual(parsed.segments.map((s) => s.ordinal), [0, 1, 2]);
    assert.ok(parsed.segments.every((s) => s.kind === "sheet"));
    assert.deepEqual(parsed.segments.map((s) => s.sheetName), [
      "Rent Roll", "Operating Statement", "Notes",
    ]);
    assert.ok(parsed.segments.every((s) => s.pageNo === undefined));
    assert.equal(parsed.guessedKind, "rent_roll");

    const table = parsed.tables?.find((t) => t.sheetName === "Rent Roll");
    assert.ok(table, "no table produced for the rent roll sheet");
    assert.equal(table.headerRowIndex, 3);
    assert.ok(table.columns.some((c) => c.role === "cheques"));
    assert.ok(table.columns.some((c) => c.role === "annual_rent"));
    assert.ok(table.columns.some((c) => c.role === "lease_end"));

    // The trailing "Operating Statement" tab must not rename the whole upload.
    assert.ok(parsed.tables?.some((t) => t.sheetName === "Operating Statement"));
  });

  test("a PDF yields one segment per page with page numbers", async () => {
    const buf = await readFile(join(dir, "offering.pdf"));
    const parsed = await parseDocument(buf, "Sunrise Tower OM.pdf");

    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.type, "pdf");
    assert.equal(parsed.pageCount, 3);
    assert.equal(parsed.hasTextLayer, true);
    assert.equal(parsed.isScanned, false);
    assert.deepEqual(parsed.segments.map((s) => s.pageNo), [1, 2, 3]);
    assert.ok(parsed.segments.every((s) => s.kind === "page"));
    assert.equal(parsed.guessedKind, "om");
  });

  test("a scanned PDF is reported as scanned, with a usable message", async () => {
    const buf = await readFile(join(dir, "scan.pdf"));
    const parsed = await parseDocument(buf, "scan.pdf");

    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.isScanned, true);
    assert.equal(parsed.hasTextLayer, false);
    assert.ok(parsed.warnings.some((w) => /scanned/i.test(w)));
  });

  test("guessedKind: a T12 csv is recognised from its contents", async () => {
    const buf = await readFile(join(dir, "t12.csv"));
    const parsed = await parseDocument(buf, "export-2025-06.csv");
    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.type, "csv");
    assert.equal(parsed.guessedKind, "t12");
  });

  test("guessedKind falls back to the filename, then to the declared kind", async () => {
    const bland = Buffer.from("Some notes about the deal that say nothing structural.\n");
    const byName = await parseDocument(bland, "Marina Heights Offering Memorandum.txt");
    assert.equal(byName.guessedKind, "om");

    const byDeclared = await parseDocument(bland, "notes.txt", "rent_roll");
    assert.equal(byDeclared.guessedKind, "rent_roll");
  });

  test("a declared kind that contradicts the contents produces a warning", async () => {
    const buf = await readFile(join(dir, "t12.csv"));
    const parsed = await parseDocument(buf, "export.csv", "rent_roll");
    assert.equal(parsed.guessedKind, "t12");
    assert.ok(
      parsed.warnings.some((w) => /uploaded as "rent_roll"/.test(w)),
      `expected a contradiction warning, got ${JSON.stringify(parsed.warnings)}`,
    );
  });

  test("text is capped and truncation is warned about rather than blowing up", async () => {
    const buf = await readFile(join(dir, "offering.pdf"));
    const parsed = await parseDocument(buf, "offering.pdf", undefined, { maxChars: 40 });

    assert.equal(parsed.ok, true, parsed.error);
    const total = parsed.segments.reduce((n, s) => n + s.content.length, 0);
    assert.ok(total <= 40, `expected <= 40 chars, got ${total}`);
    assert.ok(parsed.warnings.some((w) => /truncat/i.test(w)));
  });

  test("unsupported-but-identified formats explain themselves", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 7),
    ]);
    const parsed = await parseDocument(png, "rent roll.png");
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? "", /image/i);
  });
});
