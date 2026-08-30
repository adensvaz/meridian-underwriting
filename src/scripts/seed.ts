// npm run seed — populate a demo account with six fully worked Dubai deals.
//
//   npm run seed
//   npm run seed -- --password 'tuesday granite lamp 41'
//   npm run seed -- --reset            # rebuild the six deals from scratch
//   npm run seed -- --email me@firm.ae --name "Aden" --org "Meridian Demo"
//
// What this produces, per deal: three documents on disk with page/sheet
// segments, extracted fields with provenance and varied confidence, a rent
// roll, a twelve-month operating statement with the non-recurring lines marked
// and excluded, a completed underwriting run and a saved narrative.
//
// NO API KEY IS REQUIRED. generateNarrative() falls back to the deterministic
// rules engine when ANTHROPIC_API_KEY is unset, which is exactly what a demo
// run on a laptop with no key should do.
//
// EVERY DEAL IS FICTIONAL. See the header of src/seed/deals/index.ts. The
// statement is also written into each deal's `notes` column so it is visible in
// the product itself, not only in the source.
//
// Re-running is safe: a deal whose name already exists is skipped rather than
// duplicated, and an existing demo user is reused. --reset deletes the six
// seeded deals (and their files) first.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { db, migrate } from "../lib/db/index.ts";
import { env } from "../lib/env.ts";
import { installSystemModels } from "../seed/install.ts";
import { checkPasswordPolicy, hashPassword } from "../lib/auth/password.ts";
import * as repo from "../lib/db/repo.ts";
import { deriveFromTables, underwriteDeal } from "../lib/underwrite.ts";
import type { RentRollUnitRow, T12LineRow } from "../lib/db/repo.ts";
import { generateNarrative } from "../lib/ai/narrative.ts";
import { aiAvailable } from "../lib/ai/client.ts";
import { SEED_DEALS, SEED_DEAL_NAMES } from "../seed/deals/index.ts";
import type { SeedDeal, SeedField } from "../seed/deals/index.ts";
import { cols, generateDocuments, money, num, pct } from "../seed/deals/documents.ts";
import type { GeneratedDocument } from "../seed/deals/documents.ts";
import type { AuthenticatedUser } from "../lib/auth/session.ts";
import type { ModelDefinition } from "../lib/engine/types.ts";

// ------------------------------------------------------------------- args ----

function arg(name: string): string | undefined {
  const prefixed = `--${name}`;
  const index = process.argv.indexOf(prefixed);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`${prefixed}=`));
  return inline ? inline.slice(prefixed.length + 1) : undefined;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** A generated password that satisfies the policy. Loops because the policy
 *  rejects anything containing the account's local part or a common word. */
function generatePassword(email: string): string {
  for (let i = 0; i < 64; i++) {
    const candidate = randomBytes(18).toString("base64url");
    if (checkPasswordPolicy(candidate, email).ok) return candidate;
  }
  throw new Error("could not generate a policy-compliant password");
}

// ------------------------------------------------------------- verification --

/**
 * The fixtures claim a snippet is quotable from a document. If it is not, the
 * provenance drawer opens on nothing and the demo's central promise — every
 * number points back at the page it came from — is a lie. So this is a hard
 * failure, not a warning.
 */
function verifySnippets(deal: SeedDeal, docs: Map<string, GeneratedDocument>): string[] {
  const problems: string[] = [];
  for (const field of deal.fields) {
    const doc = docs.get(field.doc);
    if (!doc) {
      problems.push(`${field.key}: cites a "${field.doc}" document that was not generated`);
      continue;
    }
    const segment = doc.segments.find((s) =>
      field.page !== undefined ? s.pageNo === field.page : s.sheetName === field.sheet,
    );
    if (!segment) {
      problems.push(
        `${field.key}: cites ${field.doc} ${field.page !== undefined ? `page ${field.page}` : `sheet "${field.sheet}"`} which does not exist`,
      );
      continue;
    }
    if (!segment.content.includes(field.snippet)) {
      problems.push(`${field.key}: snippet not found in ${doc.filename} — ${JSON.stringify(field.snippet)}`);
    }
  }
  return problems;
}

/**
 * Every fixture key must be an input the deal's model actually declares. The
 * engine ignores unknown keys silently, so without this check a typo shows up
 * as a plausible-looking wrong number rather than as an error.
 */
function verifyKeys(deal: SeedDeal, definition: ModelDefinition): string[] {
  const known = new Set((definition.inputs ?? []).map((i) => i.key));
  const problems: string[] = [];
  for (const f of deal.fields) {
    if (!known.has(f.key)) problems.push(`extracted field "${f.key}" is not an input of ${definition.key}`);
  }
  for (const u of deal.userFields) {
    if (!known.has(u.key)) problems.push(`user field "${u.key}" is not an input of ${definition.key}`);
  }
  return problems;
}

/**
 * The trap this exists to catch.
 *
 * Several model inputs carry a `derivedFrom` pointing at a figure the platform
 * computes from the rent roll and the T12 — `size_sqft` and `nla_sqft` from the
 * summed areas, `cheque_count` from the modal cheque count, `occupancy` from
 * occupied UNITS over total units, `in_place_rent` from the summed rents.
 * src/lib/underwrite.ts ranks those derivations ABOVE an AI-extracted value, so
 * a fixture that disagrees with its own tenancy rows is silently overruled and
 * the demo shows a number nobody wrote down.
 *
 * Rather than reimplement that logic, run the real `deriveFromTables` over the
 * fixture and compare. A disagreement is only allowed where the fixture also
 * supplies a user override, because a user value outranks the derivation and
 * the disagreement is then the point (see Meridian Court's occupancy).
 */
function verifyDerivations(deal: SeedDeal, definition: ModelDefinition): string[] {
  const problems: string[] = [];

  const units = deal.facts.tenancies.map((t, i) => ({
    id: `seed-${i}`,
    area_sqft: t.areaSqft,
    in_place_rent: t.annualRent,
    market_rent: t.marketRent ?? null,
    cheques: t.cheques,
    occupancy_status: t.status,
  })) as unknown as RentRollUnitRow[];

  const t12Rows = deal.facts.t12Lines.map((l, i) => ({
    id: `seed-${i}`,
    section: l.section,
    category: l.category,
    amount: l.amount,
    months_covered: 12,
    annualized: l.amount,
    is_recurring: l.recurring === false || l.excludeReason ? 0 : 1,
    exclude_reason: l.excludeReason ?? null,
  })) as unknown as T12LineRow[];

  const derived = deriveFromTables(units, t12Rows).values;
  const overridden = new Set(deal.userFields.map((u) => u.key));

  for (const input of definition.inputs ?? []) {
    const derivationKey = (input as { derivedFrom?: string }).derivedFrom ?? input.key;
    if (!Object.hasOwn(derived, derivationKey)) continue;

    const derivedValue = derived[derivationKey];
    const claimed = deal.fields.find((f) => f.key === input.key)?.value;
    if (claimed === undefined || derivedValue === null || derivedValue === undefined) continue;
    if (overridden.has(input.key)) continue;

    const differs =
      typeof claimed === "number" && typeof derivedValue === "number"
        ? Math.abs(claimed - derivedValue) > Math.max(0.5, Math.abs(derivedValue) * 1e-6)
        : String(claimed) !== String(derivedValue);

    if (differs) {
      problems.push(
        `${input.key} is extracted as ${claimed} but the platform derives ${derivedValue} from the ` +
          `rent roll / T12 (via "${derivationKey}"). The derivation outranks extraction, so the ` +
          `fixture value would be silently discarded — fix the tables or add a user override.`,
      );
    }
  }

  return problems;
}

// -------------------------------------------------------------- seeding one --

interface SeededSummary {
  name: string;
  community: string;
  model: string;
  depth: string;
  documents: number;
  fields: number;
  units: number;
  t12: number;
  price: number | null;
  grossYield: number | null;
  netYield: number | null;
  dscr: number | null;
  flags: number;
  narrativeEngine: string;
}

async function seedDeal(actor: AuthenticatedUser, seed: SeedDeal): Promise<SeededSummary> {
  const modelRow = repo.findModelByKey(actor, seed.modelKey);
  if (!modelRow) {
    throw new Error(
      `model "${seed.modelKey}" is not installed. Available: ` +
        repo.listModels(actor).map((m) => m.key).join(", "),
    );
  }
  const definition = repo.getModelDefinition(actor, modelRow.id);
  if (!definition) throw new Error(`model "${seed.modelKey}" has no readable definition`);

  const keyProblems = verifyKeys(seed, definition);
  const derivationProblems = verifyDerivations(seed, definition);
  if (keyProblems.length || derivationProblems.length) {
    throw new Error(`${seed.name} fixture is inconsistent:\n    ${[...keyProblems, ...derivationProblems].join("\n    ")}`);
  }

  const generated = generateDocuments(seed.facts);
  const byKind = new Map(generated.map((g) => [g.kind, g]));
  const snippetProblems = verifySnippets(seed, byKind);
  if (snippetProblems.length) {
    throw new Error(`${seed.name} provenance is broken:\n    ${snippetProblems.join("\n    ")}`);
  }

  const deal = repo.createDeal(actor, {
    name: seed.name,
    address: seed.address,
    community: seed.community,
    city: seed.city,
    country: seed.country,
    asset_type: seed.assetType,
    tenure: seed.tenure,
    market: seed.market,
    currency: seed.currency,
    status: "review",
    depth: seed.depth,
    model_id: modelRow.id,
    notes: seed.notes,
  });

  // ---- documents -------------------------------------------------------
  //
  // Synthetic text stand-ins, not real PDF/XLSX binaries. The display filename
  // is the plausible one a broker would send; the bytes, the mime type and
  // detected_type say text/plain because that is what they honestly are.
  // `bytes` MUST equal the real file length — the download route sends it as
  // content-length.

  const documentIds = new Map<string, string>();
  const dir = join(env.uploadDir, deal.id);
  mkdirSync(dir, { recursive: true });

  for (const generatedDoc of generated) {
    const buffer = Buffer.from(generatedDoc.text, "utf8");
    const storagePath = join(dir, `${repo.id()}.txt`);
    mkdirSync(dirname(storagePath), { recursive: true });
    writeFileSync(storagePath, buffer, { mode: 0o600 });

    const row = repo.createDocument(actor, deal.id, {
      kind: generatedDoc.kind,
      kind_source: "user",
      filename: generatedDoc.filename,
      mime: generatedDoc.mime,
      detected_type: generatedDoc.detectedType,
      bytes: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      storage_path: storagePath,
      page_count: generatedDoc.pageCount,
      sheet_count: generatedDoc.sheetCount,
      has_text_layer: 1,
      is_scanned: 0,
      status: "parsed",
      error: null,
    });
    if (!row) throw new Error(`could not record ${generatedDoc.filename}`);
    documentIds.set(generatedDoc.kind, row.id);

    repo.saveSegments(deal.id, row.id, generatedDoc.segments);

    repo.createExtraction(deal.id, actor.id, {
      documentId: row.id,
      kind: generatedDoc.kind,
      engine: "rules",
      promptVersion: "seed-fixture",
      status: "ok",
      raw: { note: "Seeded demo fixture — fields written directly, not inferred at runtime." },
      durationMs: 0,
    });
  }

  // ---- extracted fields -------------------------------------------------

  const resolveDoc = (field: SeedField): string | null => documentIds.get(field.doc) ?? null;

  for (const field of seed.fields) {
    repo.upsertAiField(deal.id, actor.id, {
      key: field.key,
      value: field.value,
      unit: field.unit ?? null,
      confidence: field.confidence,
      documentId: resolveDoc(field),
      page: field.page ?? null,
      sheet: field.sheet ?? null,
      snippet: field.snippet,
    });
  }

  // Reviewer input. Where an ai_value already exists this reads as a
  // correction and the review screen shows both; where it does not, it is an
  // analyst assumption the documents never stated.
  for (const userField of seed.userFields) {
    repo.setUserField(actor, deal.id, userField.key, userField.value, userField.note);
  }

  // ---- rent roll and T12 -------------------------------------------------

  const rentRollDocId = documentIds.get("rent_roll") ?? null;
  repo.replaceRentRoll(
    deal.id,
    actor.id,
    seed.facts.tenancies.map((t, i) => ({
      ordinal: i + 1,
      unit_no: t.unit,
      unit_type: t.unitType,
      beds: t.beds ?? null,
      baths: t.baths ?? null,
      area_sqft: t.areaSqft,
      in_place_rent: t.annualRent,
      market_rent: t.marketRent ?? null,
      cheques: t.cheques,
      lease_start: t.leaseStart,
      lease_end: t.leaseEnd,
      occupancy_status: t.status,
      ejari_no: t.ejari,
      source_document_id: rentRollDocId,
      source_row: i + 2, // row 1 is the header
      confidence: t.confidence ?? 0.92,
    })),
  );

  const t12DocId = documentIds.get("t12") ?? null;
  repo.replaceT12(
    deal.id,
    actor.id,
    seed.facts.t12Lines.map((line, i) => ({
      ordinal: i + 1,
      raw_label: line.label,
      section: line.section,
      category: line.category,
      amount: line.amount,
      months_covered: 12,
      annualized: line.amount,
      is_recurring: line.recurring === false || line.excludeReason ? 0 : 1,
      exclude_reason: line.excludeReason ?? null,
      source_document_id: t12DocId,
      source_row: i + 2,
      confidence: line.confidence ?? 0.9,
    })),
  );

  // ---- underwrite and write up ------------------------------------------

  const outcome = underwriteDeal(actor, deal.id, { depth: seed.depth });

  const narrative = await generateNarrative({
    dealName: deal.name,
    community: deal.community,
    assetType: deal.asset_type,
    currency: deal.currency,
    result: outcome.result,
    modelName: outcome.modelName,
  });

  repo.saveNarrative(outcome.runId, deal.id, actor.id, {
    engine: narrative.engine,
    model: narrative.engine === "ai" ? env.model : null,
    status: narrative.error ? "fallback" : "ok",
    headline: narrative.headline,
    summary: narrative.summary,
    strengths: narrative.strengths,
    redFlags: narrative.redFlags,
    ddItems: narrative.ddItems,
    error: narrative.error ?? null,
  });

  repo.audit(actor, "deal.seeded", "deal", deal.id, { model: seed.modelKey, depth: seed.depth });

  const v = outcome.result.values;
  const number = (key: string): number | null => (typeof v[key] === "number" ? (v[key] as number) : null);

  return {
    name: deal.name,
    community: deal.community ?? "—",
    model: outcome.modelName,
    depth: outcome.result.depth,
    documents: generated.length,
    fields: seed.fields.length,
    units: seed.facts.tenancies.length,
    t12: seed.facts.t12Lines.length,
    price: number("purchase_price"),
    grossYield: number("gross_yield"),
    netYield: number("net_yield"),
    dscr: number("dscr"),
    flags: outcome.result.flags.length,
    narrativeEngine: narrative.engine,
  };
}

// -------------------------------------------------------------------- main ---

async function main(): Promise<void> {
  db();
  migrate();
  const installed = installSystemModels();

  const email = (arg("email") ?? "demo@meridian.ae").trim().toLowerCase();
  const name = arg("name") ?? "Meridian Demo";
  const orgName = arg("org") ?? "Meridian Demo Investments";

  let password = arg("password") ?? "";
  let generated = false;
  if (!password) {
    password = generatePassword(email);
    generated = true;
  }

  const policy = checkPasswordPolicy(password, email);
  if (!policy.ok) {
    console.error(`\nThat password was rejected:\n  ${policy.problems.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }

  // ---- account ----------------------------------------------------------

  let userRow = repo.findUserByEmail(email);
  let passwordIsKnown = true;

  if (userRow) {
    if (arg("password")) {
      repo.setUserPassword(userRow.id, await hashPassword(password));
      console.log(`reusing existing account ${email} — password reset from --password`);
    } else {
      passwordIsKnown = false;
      console.log(`reusing existing account ${email} — password left unchanged`);
    }
  } else {
    const org = repo.createOrganization(orgName, "AE");
    const creds = await hashPassword(password);
    userRow = repo.createUser({
      orgId: org.id,
      email,
      name,
      role: "owner",
      status: "active",
      passwordHash: creds.hash,
      passwordSalt: creds.salt,
      passwordAlgo: creds.algo,
    });
    console.log(`created organisation "${org.name}" and account ${email}`);
  }

  const actor: AuthenticatedUser = {
    id: userRow.id,
    org_id: userRow.org_id,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role,
    status: userRow.status,
  };

  console.log(`${installed} underwriting model(s) installed`);

  // ---- optional reset ---------------------------------------------------

  if (flag("reset")) {
    let removed = 0;
    for (const dealName of SEED_DEAL_NAMES) {
      for (const existing of repo.listDeals(actor, { includeArchived: true, limit: 500 })) {
        if (existing.name !== dealName) continue;
        const docs = repo.deleteDeal(actor, existing.id);
        for (const doc of docs) rmSync(doc.storage_path, { force: true });
        rmSync(join(env.uploadDir, existing.id), { recursive: true, force: true });
        removed++;
      }
    }
    console.log(`--reset: removed ${removed} previously seeded deal(s) and their documents`);
  }

  // ---- deals ------------------------------------------------------------

  const existingNames = new Set(repo.listDeals(actor, { includeArchived: true, limit: 500 }).map((d) => d.name));
  const summaries: SeededSummary[] = [];
  let skipped = 0;

  for (const seed of SEED_DEALS) {
    if (existingNames.has(seed.name)) {
      console.log(`  skip    ${seed.name} — already present (use --reset to rebuild)`);
      skipped++;
      continue;
    }
    const summary = await seedDeal(actor, seed);
    summaries.push(summary);
    console.log(
      `  seeded  ${summary.name.padEnd(34)} ${summary.documents} docs · ${summary.fields} fields · ` +
        `${summary.units} unit(s) · ${summary.t12} T12 lines · ${summary.flags} flag(s)`,
    );
  }

  // ---- report -----------------------------------------------------------

  if (summaries.length) {
    const widths = [34, 30, -16, -8, -8, -8, -6];
    const header = cols(["Deal", "Community", "Price", "Gross", "Net", "DSCR", "Flags"], widths);
    console.log("");
    console.log(header);
    console.log("-".repeat(header.length));
    for (const s of summaries) {
      console.log(
        cols(
          [
            s.name,
            s.community,
            s.price === null ? "—" : money(s.price),
            s.grossYield === null ? "—" : pct(s.grossYield),
            s.netYield === null ? "—" : pct(s.netYield),
            s.dscr === null ? "—" : `${num(s.dscr, 2)}x`,
            String(s.flags),
          ],
          widths,
        ),
      );
    }
  }

  console.log("");
  console.log(`${summaries.length} deal(s) seeded, ${skipped} skipped.`);
  console.log(
    `narrative engine: ${aiAvailable() ? "ai (ANTHROPIC_API_KEY is set)" : "rules (no ANTHROPIC_API_KEY — deterministic write-up)"}`,
  );
  console.log("");
  console.log("Sign in with:");
  console.log(`  email     ${email}`);
  if (passwordIsKnown) {
    console.log(`  password  ${password}`);
    if (generated) console.log("\n  ^ Generated and shown once. Re-run with --password to set your own.");
  } else {
    console.log("  password  (unchanged — re-run with --password '...' to set a new one)");
  }
  console.log("\nStart the server with:  npm run serve");
}

main().catch((err) => {
  console.error("\nseed failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
