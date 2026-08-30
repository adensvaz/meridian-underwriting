// npm run check — the acceptance harness.
//
// This is the script a buyer runs to satisfy themselves the thing works. It
// exercises the claims the product actually makes, in particular the two that
// matter commercially: that the underwriting arithmetic is right, and that one
// user cannot reach another user's data.
//
// It runs against a temporary database so it never touches real deals.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "../lib/env.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
let failures = 0;

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (!ok) failures++;
}

function check(name: string, fn: () => string): void {
  try {
    record(name, true, fn());
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

async function checkAsync(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await fn());
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function near(actual: number | null, expected: number, tolerance: number, label: string): void {
  assert(actual !== null && Number.isFinite(actual), `${label}: got ${actual}`);
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ≈${expected}, got ${actual.toFixed(6)}`,
  );
}

// -------------------------------------------------------------- environment --

check("Node version supports native TypeScript and node:sqlite", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert(major > 22 || (major === 22 && minor >= 6), `Node ${process.versions.node} is too old — need 22.6+`);
  return `Node ${process.versions.node}`;
});

check("node:sqlite is available and writable", () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-check-"));
  try {
    const database = new DatabaseSync(join(dir, "t.db"));
    database.exec("CREATE TABLE t (a INTEGER, b TEXT)");
    database.prepare("INSERT INTO t VALUES (?, ?)").run(1, "x");
    const row = database.prepare("SELECT a, b FROM t").get() as { a: number; b: string };
    assert(row.a === 1 && row.b === "x", "round-trip failed");
    database.close();
    return "DatabaseSync round-trip OK";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("Schema is legal SQL and applies cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-schema-"));
  try {
    const database = new DatabaseSync(join(dir, "s.db"));
    database.exec(readFileSync(resolve(ROOT, "src/lib/db/schema.sql"), "utf8"));
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const required = [
      "organizations", "users", "sessions", "underwriting_models", "deals",
      "documents", "document_segments", "extracted_fields", "rent_roll_units",
      "t12_lines", "underwriting_runs", "narratives", "audit_log",
    ];
    for (const table of required) {
      assert(tables.some((t) => t.name === table), `missing table: ${table}`);
    }
    database.close();
    return `${tables.length} tables created`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ formula engine --

await checkAsync("Formula language: arithmetic, precedence and percent literals", async () => {
  const { compile, evaluate } = await import("../lib/engine/expr.ts");
  const run = (src: string, scope: Record<string, unknown> = {}) =>
    evaluate(compile(src), { lookup: (n) => (n in scope ? (scope[n] as never) : undefined) });

  assert(run("2 + 3 * 4") === 14, "precedence wrong");
  assert(run("(2 + 3) * 4") === 20, "parentheses wrong");
  assert(run("2 ^ 3 ^ 2") === 512, "^ must be right-associative");
  assert(run("5%") === 0.05, "percent literal wrong");
  // Excel convention, deliberately — see the note in expr.ts. The users of this
  // language underwrite in spreadsheets and the two must agree.
  assert(run("-2 ^ 2") === 4, "unary minus must bind tighter than ^, as in Excel");
  assert(run("-2 ^ 3") === -8, "odd exponent of a negative base");
  assert(run("10 / 4") === 2.5, "division wrong");
  assert(run("a * b", { a: 3, b: 7 }) === 21, "identifier lookup wrong");
  return "precedence, associativity and percent literals correct";
});

await checkAsync("Formula language: division by zero yields null, never Infinity", async () => {
  const { compile, evaluate } = await import("../lib/engine/expr.ts");
  const run = (src: string) => evaluate(compile(src), { lookup: () => undefined });
  assert(run("1 / 0") === null, "1/0 must be null");
  assert(run("div(1, 0)") === null, "div(1,0) must be null");
  return "no Infinity can enter a computed line";
});

await checkAsync("Formula language: null propagates instead of becoming zero", async () => {
  const { compile, evaluate } = await import("../lib/engine/expr.ts");
  const scope: Record<string, unknown> = { rent: 100000, service_charge: null };
  const run = (src: string) =>
    evaluate(compile(src), { lookup: (n) => (n in scope ? (scope[n] as never) : undefined) });

  assert(run("rent - service_charge") === null, "a missing input must not silently become 0");
  assert(run("ifnull(service_charge, 0)") === 0, "ifnull must supply the default");
  assert(run("rent - ifnull(service_charge, 0)") === 100000, "explicit default must work");
  assert(run("sum(rent, service_charge)") === 100000, "sum must skip nulls");
  return "missing data stays visibly missing";
});

await checkAsync("Formula language: rejects code execution attempts", async () => {
  const { compile } = await import("../lib/engine/expr.ts");
  const hostile = [
    "constructor",                       // bare identifier is fine, but...
    "process.exit(1)",                   // unknown function
    "require('fs')",                     // unknown function
    "globalThis.x",                      // unknown identifier at eval time
    "a = 5",                             // assignment
    "(function(){})()",                  // not callable syntax
    "__proto__.polluted",
  ];
  let rejected = 0;
  for (const src of hostile) {
    try {
      const ast = compile(src);
      // Parsing may succeed for a bare reference; evaluation must then fail
      // because the name resolves to nothing.
      const { evaluate } = await import("../lib/engine/expr.ts");
      evaluate(ast, { lookup: () => undefined });
    } catch {
      rejected++;
    }
  }
  assert(rejected === hostile.length, `only ${rejected}/${hostile.length} hostile inputs were rejected`);
  return `${rejected}/${hostile.length} code-execution attempts rejected`;
});

await checkAsync("Finance functions match spreadsheet conventions", async () => {
  const { FUNCTIONS, irrOf } = await import("../lib/engine/expr.ts");

  // AED 787,500 at 4.49% nominal over 25 years, monthly.
  const monthlyRate = 0.0449 / 12;
  const payment = FUNCTIONS.pmt.apply([monthlyRate, 300, 787500]) as number;
  near(payment, 4372, 25, "pmt() monthly payment");

  // Balance after 5 years of that loan.
  const balance = FUNCTIONS.balance.apply([monthlyRate, 300, 787500, 60]) as number;
  assert(balance < 787500 && balance > 650000, `balance() implausible: ${balance}`);

  // IRR of a textbook stream: -1000 then 5 x 300.
  const irr = irrOf([-1000, 300, 300, 300, 300, 300]);
  near(irr, 0.1524, 0.002, "irr()");

  // NPV at the IRR must be ~0 — the two must agree.
  const npvAtIrr = FUNCTIONS.npv.apply([irr as number, -1000, 300, 300, 300, 300, 300]) as number;
  near(npvAtIrr, 0, 0.5, "npv() at the IRR");

  return `pmt ${payment.toFixed(2)}/mo, IRR ${(irr! * 100).toFixed(2)}%, NPV at IRR ≈ 0`;
});

await checkAsync("Engine: dependency order, projection and series aggregation", async () => {
  const { runModel, validateModel } = await import("../lib/engine/model.ts");
  const definition = {
    key: "check_model",
    name: "Check model",
    market: "AE",
    currency: "AED",
    depth: "full" as const,
    assetType: "residential",
    schemaVersion: 1,
    inputs: [
      { key: "price", label: "Price", group: "Property", type: "currency" as const, default: 1_000_000 },
      { key: "rent", label: "Rent", group: "Income", type: "currency" as const, default: 80_000 },
      { key: "opex", label: "Opex", group: "Costs", type: "currency" as const, default: 20_000 },
      { key: "hold", label: "Hold", group: "Exit", type: "integer" as const, default: 5 },
      { key: "growth", label: "Growth", group: "Exit", type: "percent" as const, default: 0.03 },
    ],
    lines: [
      { key: "noi", label: "NOI", group: "Returns", formula: "rent - opex", format: "currency" as const },
      { key: "gross_yield", label: "Gross yield", group: "Returns", formula: "rent / price", format: "percent" as const },
      { key: "net_yield", label: "Net yield", group: "Returns", formula: "noi / price", format: "percent" as const },
    ],
    projection: {
      years: "hold",
      rows: [
        {
          key: "proj_rent",
          label: "Rent",
          formula: "year == 1 ? rent : prev.proj_rent * (1 + growth)",
          format: "currency" as const,
        },
        { key: "proj_noi", label: "NOI", formula: "proj_rent - opex", format: "currency" as const },
      ],
    },
    returns: [
      { key: "total_noi", label: "Total NOI", group: "Returns", formula: 'series_sum("proj_noi")', format: "currency" as const },
      { key: "exit_noi", label: "Exit NOI", group: "Returns", formula: 'series_last("proj_noi")', format: "currency" as const },
    ],
    summary: ["noi", "gross_yield", "net_yield"],
  };

  const issues = validateModel(definition as never);
  assert(!issues.some((i) => i.level === "error"), `validation errors: ${JSON.stringify(issues)}`);

  const result = runModel({ definition: definition as never, values: new Map() });

  near(result.values.noi as number, 60_000, 0.01, "NOI");
  near(result.values.gross_yield as number, 0.08, 1e-9, "gross yield");
  near(result.values.net_yield as number, 0.06, 1e-9, "net yield");

  assert(result.projection?.years === 5, "projection should run 5 years");
  const rents = result.projection!.rows.find((r) => r.key === "proj_rent")!.values as number[];
  near(rents[0], 80_000, 0.01, "projection year 1 rent");
  near(rents[4], 80_000 * Math.pow(1.03, 4), 0.01, "projection year 5 rent compounding");

  const expectedTotal = rents.reduce((a, b) => a + b, 0) - 20_000 * 5;
  near(result.values.total_noi as number, expectedTotal, 0.01, "series_sum over the projection");

  return `NOI 60,000, yields 8.00%/6.00%, 5-year projection compounds and aggregates correctly`;
});

await checkAsync("Engine: a cyclic model is rejected, not run", async () => {
  const { validateModel } = await import("../lib/engine/model.ts");
  const cyclic = {
    key: "cyclic", name: "Cyclic", market: "AE", currency: "AED",
    depth: "quick" as const, assetType: "residential", schemaVersion: 1,
    inputs: [],
    // `a` references `b`, which is declared later — validation walks in
    // declaration order, so this is caught as an unknown reference.
    lines: [
      { key: "a", label: "A", group: "g", formula: "b + 1" },
      { key: "b", label: "B", group: "g", formula: "a + 1" },
    ],
    summary: [],
  };
  const issues = validateModel(cyclic as never);
  assert(issues.some((i) => i.level === "error"), "a self-referential model must not validate");
  return "circular references are refused at save time";
});

// ------------------------------------------------------------- shipped models --

await checkAsync("Shipped underwriting models validate", async () => {
  const { SYSTEM_MODELS } = await import("../seed/models/index.ts");
  const { validateModel } = await import("../lib/engine/model.ts");

  assert(SYSTEM_MODELS.length > 0, "no models are shipped");
  const problems: string[] = [];
  for (const model of SYSTEM_MODELS) {
    const errors = validateModel(model).filter((i) => i.level === "error");
    for (const e of errors) problems.push(`${model.key} → ${e.where}: ${e.message}`);
  }
  assert(problems.length === 0, `\n    ${problems.join("\n    ")}`);
  return `${SYSTEM_MODELS.length} models validate: ${SYSTEM_MODELS.map((m) => m.key).join(", ")}`;
});

await checkAsync("Shipped Dubai model produces plausible figures", async () => {
  const { SYSTEM_MODELS } = await import("../seed/models/index.ts");
  const { runModel } = await import("../lib/engine/model.ts");

  const model = SYSTEM_MODELS.find((m) => m.market === "AE" && m.depth === "quick");
  assert(model, "no Dubai quick model is shipped");

  // Every input falls back to its declared default, so this exercises the
  // defaults as shipped rather than a hand-fed happy path.
  const result = runModel({ definition: model!, values: new Map() });

  const blocking = result.warnings.filter((w) => w.level === "blocking");
  assert(blocking.length === 0, `model defaults leave required inputs unset: ${blocking.map((w) => w.message).join("; ")}`);

  const gross = result.values.gross_yield;
  assert(
    typeof gross === "number" && gross > 0.02 && gross < 0.20,
    `gross yield from defaults is implausible: ${gross}`,
  );
  return `defaults produce a ${((gross as number) * 100).toFixed(2)}% gross yield with no blocking gaps`;
});

// Regression guard for a bug that looked exactly like working software: a model
// whose input key did not match the platform's derivation key silently fell
// back to its default, so the screen showed a plausible number that had nothing
// to do with the uploaded rent roll. Every shipped model must bind the figures
// it expects the rent roll and T12 to supply.
await checkAsync("Rent-roll and T12 derivations reach every shipped model", async () => {
  const { SYSTEM_MODELS } = await import("../seed/models/index.ts");
  const { deriveFromTables } = await import("../lib/underwrite.ts");

  // The canonical keys the platform produces from the tables.
  const derived = deriveFromTables(
    [
      {
        id: "u1", deal_id: "d", owner_id: "o", ordinal: 1, unit_no: "1204",
        unit_type: "1BR", beds: 1, baths: 1, area_sqft: 780, in_place_rent: 78_000,
        market_rent: 82_000, cheques: 4, lease_start: null, lease_end: null,
        occupancy_status: "occupied", ejari_no: null, source_document_id: null,
        source_page: null, source_row: 1, confidence: 0.95, edited: 0,
      },
    ] as never,
    [
      {
        id: "t1", deal_id: "d", owner_id: "o", ordinal: 1,
        raw_label: "Service Charge - Owners Association", section: "opex",
        category: "service_charge", amount: 9_750, months_covered: 12,
        annualized: 9_750, is_recurring: 1, exclude_reason: null,
        source_document_id: null, source_page: null, source_row: 1,
        confidence: 0.9, edited: 0,
      },
    ] as never,
  );

  assert(derived.values.annual_rent === 78_000, `annual_rent derivation: ${derived.values.annual_rent}`);
  assert(derived.values.size_sqft === 780, `size_sqft derivation: ${derived.values.size_sqft}`);
  assert(derived.values.cheque_count === 4, `cheque_count derivation: ${derived.values.cheque_count}`);
  assert(derived.values.t12_opex_total === 9_750, `t12_opex_total: ${derived.values.t12_opex_total}`);

  const available = new Set(Object.keys(derived.values));
  const unbound: string[] = [];

  for (const model of SYSTEM_MODELS) {
    // Every input claiming a derivation must name one the platform emits,
    // otherwise the binding is a typo that fails silently at runtime.
    for (const input of model.inputs) {
      if (input.derivedFrom && !available.has(input.derivedFrom)) {
        // t12_<category> keys only appear when that category is present, so
        // only flag bindings outside the t12_ namespace.
        if (!input.derivedFrom.startsWith("t12_")) {
          unbound.push(`${model.key}.${input.key} → "${input.derivedFrom}" is not a derivation the platform produces`);
        }
      }
    }
    // And every model must actually bind rent and area, or an uploaded rent
    // roll cannot move its numbers at all. Rent may come through either the
    // headline total or the in-place total — both are canonical.
    const bound = new Set(model.inputs.map((i) => i.derivedFrom ?? i.key));
    if (!bound.has("annual_rent") && !bound.has("in_place_rent_total")) {
      unbound.push(`${model.key} binds nothing to the rent-roll rent total`);
    }
    if (!bound.has("size_sqft")) {
      unbound.push(`${model.key} binds nothing to the rent-roll area total`);
    }
  }

  assert(unbound.length === 0, `\n    ${unbound.join("\n    ")}`);
  return `${SYSTEM_MODELS.length} models bind rent, area and cheque count to the table derivations`;
});

// Flag prose goes straight into an investment committee memo. An unsubstituted
// "{dscr_covenant}" or a "0.99×x" makes the whole document look unfinished, and
// neither is caught by validation because both are valid strings.
await checkAsync("Flag and benchmark prose renders cleanly", async () => {
  const { SYSTEM_MODELS } = await import("../seed/models/index.ts");
  const { runModel } = await import("../lib/engine/model.ts");

  const offences: string[] = [];
  let inspected = 0;

  for (const model of SYSTEM_MODELS) {
    // Run twice: once on defaults, once on a stressed case, so the pessimistic
    // flags fire too and their text gets inspected.
    const stressed = new Map<string, { key: string; value: number; origin: "user" }>();
    for (const key of ["ltv", "interest_rate"]) {
      if (model.inputs.some((i) => i.key === key)) {
        stressed.set(key, { key, value: key === "ltv" ? 0.8 : 0.075, origin: "user" });
      }
    }

    for (const values of [new Map(), stressed]) {
      const result = runModel({ definition: model, values: values as never });
      for (const flag of result.flags) {
        inspected++;
        for (const [label, text] of [["detail", flag.detail], ["dd", flag.dd ?? ""]] as const) {
          if (/\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(text)) {
            offences.push(`${model.key}/${flag.id} ${label}: unsubstituted placeholder — ${text.match(/\{[^}]+\}/)![0]}`);
          }
          // The ratio formatter emits "×"; a literal "x" after it doubles up.
          if (/×x\b/.test(text)) {
            offences.push(`${model.key}/${flag.id} ${label}: doubled ratio suffix "×x"`);
          }
          if (/\bNaN\b|\bInfinity\b|\bundefined\b|\[object Object\]/.test(text)) {
            offences.push(`${model.key}/${flag.id} ${label}: leaked a raw JS value`);
          }
        }
      }
    }
  }

  assert(offences.length === 0, `\n    ${offences.slice(0, 12).join("\n    ")}`);
  return `${inspected} rendered flags across ${SYSTEM_MODELS.length} models, no placeholders or malformed units`;
});

// The product promises that a firm unwilling to send deal packs to a
// third-party model can still run the tool end to end. That promise is
// worthless if the no-key path extracts nothing, so it is tested.
await checkAsync("Extraction works with no API key configured", async () => {
  const { parseDocument } = await import("../lib/parse/index.ts");
  const { ruleBasedExtraction } = await import("../lib/ai/fallback.ts");
  const { SYSTEM_MODELS } = await import("../seed/models/index.ts");

  const model = SYSTEM_MODELS.find((m) => m.key === "dubai-residential-quick")!;

  const rentRoll =
    "Unit,Type,Area (sqft),Annual Rent (AED),Cheques,Ejari No,Status\n" +
    "1204,1BR,780,78000,4,EJ-2026-004182,Occupied\n" +
    "1206,1BR,795,82000,2,EJ-2026-004183,Occupied\n" +
    "1208,2BR,1120,0,,,Vacant\n" +
    "TOTAL,,2695,160000,,,\n";

  const parsedRent = await parseDocument(Buffer.from(rentRoll), "rentroll.csv", "rent_roll");
  const rentPayload = ruleBasedExtraction(parsedRent, model);

  assert(rentPayload.units?.length === 3, `expected 3 tenancies, got ${rentPayload.units?.length}`);
  const totalRent = (rentPayload.units ?? []).reduce((s, u) => s + (u.in_place_rent ?? 0), 0);
  assert(totalRent === 160_000, `rents must sum to 160,000, got ${totalRent}`);
  // The TOTAL line is not a tenancy and must not be double-counted.
  assert(
    !(rentPayload.units ?? []).some((u) => /total/i.test(u.unit_no ?? "")),
    "the TOTAL row was read as a tenancy",
  );
  assert(
    (rentPayload.units ?? []).filter((u) => u.occupancy_status === "vacant").length === 1,
    "the vacant unit was not identified",
  );
  assert((rentPayload.units ?? [])[0].cheques === 4, "cheque count was not read");
  assert((rentPayload.units ?? [])[0].ejari_no === "EJ-2026-004182", "Ejari number was not read");

  const t12 =
    "Label,Total\nINCOME,\nBase Rental Income,160000\nEXPENSES,\n" +
    "Service Charge - Owners Association,33687\nDistrict Cooling Capacity Charge,9600\n" +
    "Property Management Fee,9600\nBuilding Insurance,1900\n" +
    "Lift Modernisation Special Levy,18000\nLegal Settlement - Unit 1208,7500\n";

  const parsedT12 = await parseDocument(Buffer.from(t12), "t12.csv", "t12");
  const t12Payload = ruleBasedExtraction(parsedT12, model);
  const lines = t12Payload.t12_lines ?? [];

  assert(lines.length >= 7, `expected at least 7 statement lines, got ${lines.length}`);
  const categorised = (label: string) => lines.find((l) => l.raw_label.includes(label))?.category;
  assert(categorised("Service Charge") === "service_charge", "service charge not categorised");
  assert(categorised("District Cooling") === "chiller_cooling", "chiller charge not categorised");
  assert(categorised("Building Insurance") === "insurance", "insurance not categorised");

  // Non-recurring items must be excluded from a stabilised NOI, with a reason.
  const excluded = lines.filter((l) => !l.is_recurring);
  assert(excluded.length === 2, `expected 2 non-recurring exclusions, got ${excluded.length}`);
  assert(
    excluded.every((l) => (l.exclude_reason ?? "").length > 10),
    "every exclusion must state why",
  );

  return `${rentPayload.units!.length} tenancies and ${lines.length} statement lines read deterministically, ${excluded.length} non-recurring items excluded`;
});

// --------------------------------------------------------------- credentials --

await checkAsync("Password hashing round-trips and rejects wrong passwords", async () => {
  const { hashPassword, verifyPassword, checkPasswordPolicy } = await import("../lib/auth/password.ts");

  const stored = await hashPassword("correct horse battery staple");
  assert(await verifyPassword("correct horse battery staple", stored), "valid password must verify");
  assert(!(await verifyPassword("Correct horse battery staple", stored)), "wrong password must fail");
  assert(!(await verifyPassword("", stored)), "empty password must fail");
  assert(stored.hash.length === 128, "expected a 64-byte hex digest");

  // Two hashes of the same password must differ — proves the salt is per-hash.
  const second = await hashPassword("correct horse battery staple");
  assert(second.hash !== stored.hash, "identical passwords must not produce identical hashes");

  assert(!checkPasswordPolicy("short").ok, "a 5-character password must be rejected");
  assert(!checkPasswordPolicy("passwordpassword").ok, "a common word must be rejected");
  assert(checkPasswordPolicy("tuesday granite lamp 41").ok, "a good passphrase must be accepted");

  return "scrypt verifies, salts per-hash, policy enforced";
});

// -------------------------------------------------------------- ISOLATION ----
// The single most important requirement in the brief.

await checkAsync("TENANT ISOLATION: one user cannot reach another user's data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-iso-"));
  const previousDb = process.env.MERIDIAN_DB_OVERRIDE;
  try {
    // Point the repo at a scratch database by loading a fresh module graph.
    process.env.MERIDIAN_DB_OVERRIDE = join(dir, "iso.db");

    const { db: openDb, migrate } = await import("../lib/db/index.ts");
    openDb();
    migrate();

    const repo = await import("../lib/db/repo.ts");

    const orgA = repo.createOrganization("Firm A", "AE");
    const orgB = repo.createOrganization("Firm B", "AE");
    const userA = repo.createUser({ orgId: orgA.id, email: `a-${Date.now()}@x.test`, name: "A" });
    const userB = repo.createUser({ orgId: orgB.id, email: `b-${Date.now()}@x.test`, name: "B" });

    const actorA = { id: userA.id, org_id: orgA.id, email: userA.email, name: "A", role: "owner", status: "active" };
    const actorB = { id: userB.id, org_id: orgB.id, email: userB.email, name: "B", role: "owner", status: "active" };

    const dealA = repo.createDeal(actorA, { name: "Confidential Deal A" });
    repo.setUserField(actorA, dealA.id, "purchase_price", 1_050_000);

    // B knows A's deal id — the exact "change the id in the URL" attack.
    assert(repo.getDeal(actorB, dealA.id) === undefined, "B could read A's deal by id");
    assert(repo.listDeals(actorB).length === 0, "A's deal appeared in B's list");
    assert(repo.listFields(actorB, dealA.id).length === 0, "B could read A's extracted fields");
    assert(repo.listRentRoll(actorB, dealA.id).length === 0, "B could read A's rent roll");
    assert(repo.listT12(actorB, dealA.id).length === 0, "B could read A's T12");
    assert(repo.listDocuments(actorB, dealA.id).length === 0, "B could list A's documents");
    assert(repo.latestRun(actorB, dealA.id) === undefined, "B could read A's underwriting run");

    // Writes must fail too, not just reads.
    assert(repo.setUserField(actorB, dealA.id, "purchase_price", 1) === false, "B could WRITE to A's deal");
    assert(repo.updateDeal(actorB, dealA.id, { name: "hijacked" }) === undefined, "B could rename A's deal");
    assert(repo.deleteDeal(actorB, dealA.id).length === 0, "B could delete A's deal");

    // And A's data is untouched after all of that.
    const stillThere = repo.getDeal(actorA, dealA.id);
    assert(stillThere?.name === "Confidential Deal A", "A's deal was damaged by B's attempts");

    return "7 read paths and 3 write paths correctly denied across tenants";
  } finally {
    if (previousDb === undefined) delete process.env.MERIDIAN_DB_OVERRIDE;
    else process.env.MERIDIAN_DB_OVERRIDE = previousDb;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- architecture --

// The client must never be able to reach the underwriting logic without an
// account. Stated precisely, because the naive version of this rule is wrong:
//
//   * The model EDITOR legitimately sends and receives formulas — that is the
//     whole point of a user-editable engine — but only over the authenticated
//     API, for a model the caller is entitled to read.
//   * What must never happen is a formula from a SHIPPED model being baked into
//     the static bundle, where an anonymous visitor could just read it.
//
// So the test is not "no formula appears in client code". It is "no shipped
// model's formula appears in client code", plus no server imports and no
// inline script.
await checkAsync("Shipped underwriting logic is absent from the client bundle", async () => {
  const { SYSTEM_MODELS } = await import("../seed/models/index.ts");
  const publicDir = resolve(ROOT, "public");

  // Every non-trivial formula the product ships. Short ones ("0", a bare key)
  // carry no methodology and would only produce false positives.
  const shippedFormulas = new Set<string>();
  for (const model of SYSTEM_MODELS) {
    const sources = [
      ...model.lines.map((l) => l.formula),
      ...(model.returns ?? []).map((r) => r.formula),
      ...(model.projection?.rows ?? []).map((r) => r.formula),
      ...(model.flags ?? []).map((f) => f.when),
    ];
    for (const src of sources) {
      const normalised = src.replace(/\s+/g, " ").trim();
      if (normalised.length > 12) shippedFormulas.add(normalised);
    }
  }
  assert(shippedFormulas.size > 50, `only ${shippedFormulas.size} formulas collected — is the corpus right?`);

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry)) files.push(full);
    }
  };
  walk(publicDir);
  assert(files.length > 0, "no client files found — is public/ populated?");

  const offences: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(publicDir.length + 1);

    // Reaching into the server tree from the browser bundle.
    if (/from\s+["'][^"']*\/src\//.test(source) || /import\s*\(\s*["'][^"']*\/src\//.test(source)) {
      offences.push(`${relative} imports from src/`);
    }
    // A shipped model's methodology baked into the static bundle.
    const collapsed = source.replace(/\s+/g, " ");
    for (const formula of shippedFormulas) {
      if (collapsed.includes(formula)) {
        offences.push(`${relative} embeds a shipped formula: "${formula.slice(0, 60)}"`);
        break;
      }
    }
    // An inline <script> would be blocked by the CSP anyway; catching it here
    // turns a silently dead page into a failed build.
    if (relative !== "index.html" && /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(source)) {
      offences.push(`${relative} has an inline <script>, which the CSP blocks`);
    }
  }

  assert(offences.length === 0, `\n    ${offences.join("\n    ")}`);
  return `${files.length} client files checked against ${shippedFormulas.size} shipped formulas — none leaked`;
});

// ---------------------------------------------------------------- formatting --

await checkAsync("Dubai formatting conventions", async () => {
  const { formatCurrency, formatPercent, formatArea, formatValue, formatPerSqft } =
    await import("../lib/format.ts");

  assert(formatCurrency(12_480_000) === "AED 12,480,000", `got ${formatCurrency(12_480_000)}`);
  assert(formatCurrency(-1_240_500) === "(AED 1,240,500)", `negatives must use parentheses, got ${formatCurrency(-1_240_500)}`);
  assert(formatPercent(0.0743) === "7.43%", `got ${formatPercent(0.0743)}`);
  assert(formatPerSqft(1346) === "AED 1,346.00/sqft", `got ${formatPerSqft(1346)}`);
  assert(formatArea(1320).startsWith("1,320 sqft ("), `got ${formatArea(1320)}`);
  assert(formatValue(null, "currency") === "—", "null must render as an em dash, never as zero");
  assert(formatValue(0, "currency") === "AED 0", "zero must render as zero");

  return "symbol-first AED, parenthesised negatives, sqft with sqm, null as em dash";
});

// -------------------------------------------------------------------- report --

const width = Math.max(...checks.map((c) => c.name.length)) + 2;
console.log("");
for (const c of checks) {
  const mark = c.ok ? "  ok  " : " FAIL ";
  console.log(`${mark} ${c.name.padEnd(width)} ${c.detail}`);
}
console.log("");
console.log(`${checks.length - failures}/${checks.length} checks passed`);

if (failures) {
  console.log(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
}
