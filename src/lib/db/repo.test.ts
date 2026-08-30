// Repository-layer guarantees.
//
// These test the two promises the product makes about its own data handling
// that are invisible from the outside and easy to break by accident:
//
//   1. A human correction survives re-extraction. If it does not, a reviewer
//      who fixes a misread figure loses that fix the next time anyone presses
//      "extract", silently, and the underwriting reverts to the machine's
//      wrong answer.
//   2. Ownership scoping holds on every path, including the ones added later.
//
// Both run against a throwaway database.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "meridian-repo-"));
process.env.MERIDIAN_DB_OVERRIDE = join(scratch, "repo.db");

const { db, migrate } = await import("./index.ts");
const repo = await import("./repo.ts");

before(() => {
  db();
  migrate();
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeActor(label: string) {
  const org = repo.createOrganization(`${label} Capital`, "AE");
  const user = repo.createUser({
    orgId: org.id,
    // randomUUID, not a clock: users.email is UNIQUE and two actors created in
    // the same millisecond would collide, which is a flaky failure that looks
    // like a real one.
    email: `${label}-${randomUUID()}@x.test`,
    name: label,
  });
  return {
    id: user.id,
    org_id: org.id,
    email: user.email,
    name: label,
    role: "owner",
    status: "active",
  };
}

describe("human corrections survive re-extraction", () => {
  test("a user value is not overwritten when the AI re-extracts the same field", () => {
    const actor = makeActor("A");
    const deal = repo.createDeal(actor, { name: "Correction survival" });

    // First extraction reads the service charge wrongly.
    repo.upsertAiField(deal.id, actor.id, {
      key: "service_charge_budget_psf",
      value: 22,
      confidence: 0.55,
      snippet: "Service charge 22.00 per sq ft",
    });

    let field = repo.listFields(actor, deal.id)[0];
    assert.equal(field.ai_value, "22");
    assert.equal(field.user_value, null);
    assert.equal(field.status, "extracted");

    // The reviewer corrects it from the Mollak statement.
    assert.ok(repo.setUserField(actor, deal.id, "service_charge_budget_psf", 12.5));

    field = repo.listFields(actor, deal.id)[0];
    assert.equal(field.user_value, "12.5");
    assert.equal(field.status, "edited");

    // Someone re-runs extraction. The model reads it wrongly again — this time
    // differently, which is exactly the case that would quietly overwrite.
    repo.upsertAiField(deal.id, actor.id, {
      key: "service_charge_budget_psf",
      value: 24,
      confidence: 0.61,
      snippet: "Service charge 24.00 per sq ft",
    });

    field = repo.listFields(actor, deal.id)[0];
    assert.equal(field.user_value, "12.5", "the human correction must survive");
    assert.equal(field.ai_value, "24", "the new machine reading must still be recorded");
    assert.equal(field.status, "edited", "the row must still read as edited");
  });

  test("clearing a user value falls back to the AI value rather than to nothing", () => {
    const actor = makeActor("B");
    const deal = repo.createDeal(actor, { name: "Revert to machine" });

    repo.upsertAiField(deal.id, actor.id, { key: "price", value: 1_050_000, confidence: 0.94 });
    repo.setUserField(actor, deal.id, "price", 1_100_000);
    assert.equal(repo.listFields(actor, deal.id)[0].user_value, "1100000");

    // The reviewer decides the machine was right after all.
    repo.setUserField(actor, deal.id, "price", null);

    const field = repo.listFields(actor, deal.id)[0];
    assert.equal(field.user_value, null);
    assert.equal(field.ai_value, "1050000", "the AI reading is still there to fall back to");
    assert.equal(field.status, "extracted");
  });

  test("a hand-edited rent-roll row survives re-extraction", () => {
    const actor = makeActor("C");
    const deal = repo.createDeal(actor, { name: "Rent roll survival" });

    repo.replaceRentRoll(deal.id, actor.id, [
      { unit_no: "1204", area_sqft: 780, in_place_rent: 78_000, cheques: 4 },
      { unit_no: "1206", area_sqft: 795, in_place_rent: 82_000, cheques: 2 },
    ]);

    const units = repo.listRentRoll(actor, deal.id);
    assert.equal(units.length, 2);

    // The reviewer fixes a rent the extractor misread.
    assert.ok(repo.updateRentRollUnit(actor, deal.id, units[0].id, { in_place_rent: 81_000 }));

    // Re-extraction replaces only rows nobody has touched.
    repo.replaceRentRoll(deal.id, actor.id, [
      { unit_no: "1206", area_sqft: 795, in_place_rent: 84_000, cheques: 2 },
    ]);

    const after = repo.listRentRoll(actor, deal.id);
    const edited = after.find((u) => u.unit_no === "1204");
    assert.ok(edited, "the hand-edited row must not be deleted by re-extraction");
    assert.equal(edited.in_place_rent, 81_000, "the correction must survive");
    assert.equal(edited.edited, 1);
  });
});

describe("ownership scoping on later-added paths", () => {
  test("a second firm cannot reach the first firm's collection requests or runs", async () => {
    const a = makeActor("D");
    const b = makeActor("E");
    const deal = repo.createDeal(a, { name: "Scoped" });

    const collect = await import("../collect.ts");

    const created = collect.createDocumentRequest(a, deal.id, { recipientName: "Buyer" });
    assert.ok(created, "the owner can create a collection link");

    // B knows the deal id.
    assert.equal(collect.createDocumentRequest(b, deal.id, {}), null, "B must not create a link on A's deal");
    assert.equal(collect.listRequests(b, deal.id).length, 0, "B must not list A's links");
    assert.equal(collect.revokeRequest(b, deal.id, created.id), false, "B must not revoke A's link");

    // And A's own link still works.
    assert.equal(collect.listRequests(a, deal.id).length, 1);
    const resolved = collect.resolveRequestToken(created.token);
    assert.ok(resolved, "a valid token still resolves");
    assert.equal(resolved.deal.id, deal.id);
  });

  test("a revoked collection token stops resolving", async () => {
    const a = makeActor("F");
    const deal = repo.createDeal(a, { name: "Revocation" });
    const collect = await import("../collect.ts");

    const created = collect.createDocumentRequest(a, deal.id, {});
    assert.ok(collect.resolveRequestToken(created.token));

    assert.ok(collect.revokeRequest(a, deal.id, created.id));
    assert.equal(
      collect.resolveRequestToken(created.token),
      null,
      "a revoked token must stop working immediately",
    );
  });
});
