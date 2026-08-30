// Tests for the sensitivity grid and the loan sizing solver.
//
// The grid tests run against a synthetic model whose arithmetic is obvious, so
// a failure points at the grid rather than at an underwriting assumption. The
// solver tests do the same and additionally assert the BINDING CONSTRAINT, not
// only the amount: a solver that returns the right number for the wrong reason
// is the one that misleads an analyst, because the reason is what tells them
// whether more equity or more rent fixes the deal.
//
// The last test runs against the shipped Dubai residential model, because the
// cheque-count sensitivity only means anything if it resolves against the real
// input keys the product ships.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runSensitivity, runPreset, resolvePresets, SensitivityError } from "./sensitivity.ts";
import { solveLoanAmount } from "./solver.ts";
import type { RunInput } from "./model.ts";
import type { ModelDefinition } from "./types.ts";
import { dubaiResidentialFull } from "../../seed/models/dubai-residential-full.ts";

// ------------------------------------------------------------ synthetic models --

/** a x b, with a base case of a = 2, b = 3. */
const productModel: ModelDefinition = {
  key: "test-product",
  name: "Product",
  market: "TEST",
  currency: "AED",
  depth: "quick",
  assetType: "test",
  schemaVersion: 1,
  inputs: [
    { key: "a", label: "A", group: "In", type: "number", default: 2 },
    { key: "b", label: "B", group: "In", type: "number", default: 3 },
  ],
  lines: [{ key: "product", label: "Product", group: "Out", formula: "a * b", format: "number" }],
  summary: ["product"],
};

/**
 * A deliberately small lending model: loan is price x LTV, debt service is
 * interest-only, DSCR is NOI over debt service. Every number below is hand
 * checkable, which is the point.
 */
function lendingModel(noi: number): ModelDefinition {
  return {
    key: "test-lending",
    name: "Lending",
    market: "TEST",
    currency: "AED",
    depth: "quick",
    assetType: "test",
    schemaVersion: 1,
    inputs: [
      { key: "price", label: "Price", group: "In", type: "currency", default: 1000000 },
      { key: "ltv", label: "LTV", group: "Debt", type: "percent", default: 0.6 },
      { key: "interest_rate", label: "Rate", group: "Debt", type: "percent", default: 0.05 },
      { key: "noi_input", label: "NOI", group: "In", type: "currency", default: noi },
    ],
    lines: [
      { key: "purchase_price", label: "Purchase price", group: "Out", formula: "price", format: "currency" },
      { key: "noi", label: "NOI", group: "Out", formula: "noi_input", format: "currency" },
      { key: "loan_amount", label: "Loan", group: "Debt", formula: "purchase_price * ltv", format: "currency" },
      {
        key: "annual_debt_service",
        label: "Debt service",
        group: "Debt",
        formula: "loan_amount * interest_rate",
        format: "currency",
      },
      {
        key: "dscr",
        label: "DSCR",
        group: "Debt",
        formula: "if(annual_debt_service > 0, noi / annual_debt_service, null)",
        format: "ratio",
      },
      {
        key: "debt_yield",
        label: "Debt yield",
        group: "Debt",
        formula: "if(loan_amount > 0, noi / loan_amount, null)",
        format: "percent",
      },
    ],
    summary: ["dscr"],
  };
}

/** No LTV, no loan, no DSCR — nothing for the solver to hold on to. */
const noDebtModel: ModelDefinition = {
  key: "test-nodebt",
  name: "No debt",
  market: "TEST",
  currency: "AED",
  depth: "quick",
  assetType: "test",
  schemaVersion: 1,
  inputs: [{ key: "rent", label: "Rent", group: "In", type: "currency", default: 100000 }],
  lines: [{ key: "noi", label: "NOI", group: "Out", formula: "rent * 0.7", format: "currency" }],
  summary: ["noi"],
};

const NO_OVERRIDES = new Map<string, RunInput>();

// -------------------------------------------------------------------- the grid --

test("a 3x3 grid returns nine arithmetically correct cells and marks the base case", () => {
  const result = runSensitivity({
    definition: productModel,
    values: NO_OVERRIDES,
    row: { key: "a", values: [1, 2, 3] },
    column: { key: "b", values: [2, 3, 4] },
    metric: "product",
  });

  assert.equal(result.runs, 9);
  assert.equal(result.cells.length, 3);
  assert.deepEqual(
    result.cells,
    [
      [2, 3, 4],
      [4, 6, 8],
      [6, 9, 12],
    ],
    "every cell must be the product of its row and column value",
  );

  // Base case is a = 2 (index 1), b = 3 (index 1) => 6.
  assert.equal(result.base.row, 1);
  assert.equal(result.base.column, 1);
  assert.equal(result.base.value, 6);
  assert.equal(result.row.baseValue, 2);
  assert.equal(result.column?.baseValue, 3);
});

test("a base case that is off the grid is reported as off the grid, not snapped to a neighbour", () => {
  const result = runSensitivity({
    definition: productModel,
    values: NO_OVERRIDES,
    row: { key: "a", values: [10, 20] },
    column: { key: "b", values: [2, 3] },
    metric: "product",
  });
  assert.equal(result.base.row, null);
  assert.equal(result.base.value, null);
  assert.equal(result.base.column, 1);
});

test("a grid larger than 11x11 is rejected", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
  assert.equal(twelve.length, 12);

  assert.throws(
    () =>
      runSensitivity({
        definition: productModel,
        values: NO_OVERRIDES,
        row: { key: "a", values: twelve },
        column: { key: "b", values: [1, 2] },
        metric: "product",
      }),
    (err: unknown) =>
      err instanceof SensitivityError && /limited to 11 values/.test((err as Error).message),
  );

  // And the total, not only each axis: 11 x 11 is the ceiling at 121 runs.
  const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
  const ok = runSensitivity({
    definition: productModel,
    values: NO_OVERRIDES,
    row: { key: "a", values: eleven },
    column: { key: "b", values: eleven },
    metric: "product",
  });
  assert.equal(ok.runs, 121);
});

test("an unknown input key is rejected rather than run", () => {
  assert.throws(
    () =>
      runSensitivity({
        definition: productModel,
        values: NO_OVERRIDES,
        row: { key: "__proto__", values: [1, 2] },
        metric: "product",
      }),
    (err: unknown) => err instanceof SensitivityError && /is not an input of this model/.test((err as Error).message),
  );

  assert.throws(
    () =>
      runSensitivity({
        definition: productModel,
        values: NO_OVERRIDES,
        row: { key: "a", values: [1, 2] },
        column: { key: "not_a_real_input", values: [1, 2] },
        metric: "product",
      }),
    (err: unknown) => err instanceof SensitivityError && /not an input of this model/.test((err as Error).message),
  );

  // A metric the model does not compute is rejected on the same principle.
  assert.throws(
    () =>
      runSensitivity({
        definition: productModel,
        values: NO_OVERRIDES,
        row: { key: "a", values: [1, 2] },
        metric: "toString",
      }),
    (err: unknown) => err instanceof SensitivityError && /is not a computed value/.test((err as Error).message),
  );
});

test("a percentage axis given whole numbers is rejected rather than silently rescaled", () => {
  const model: ModelDefinition = {
    ...productModel,
    inputs: [
      { key: "a", label: "A", group: "In", type: "percent", default: 0.05 },
      { key: "b", label: "B", group: "In", type: "number", default: 3 },
    ],
  };
  assert.throws(
    () =>
      runSensitivity({
        definition: model,
        values: NO_OVERRIDES,
        row: { key: "a", values: [4.5, 5.5] },
        metric: "product",
      }),
    (err: unknown) => err instanceof SensitivityError && /takes decimals/.test((err as Error).message),
  );
});

test("a cell that cannot be computed is null, never zero", () => {
  const model: ModelDefinition = {
    ...productModel,
    lines: [{ key: "product", label: "Product", group: "Out", formula: "a / b", format: "number" }],
  };
  const result = runSensitivity({
    definition: model,
    values: NO_OVERRIDES,
    row: { key: "a", values: [10] },
    column: { key: "b", values: [0, 2] },
    metric: "product",
  });
  assert.equal(result.cells[0][0], null, "10 / 0 must be blank, not zero");
  assert.equal(result.cells[0][1], 5);
});

test("cells breaching a threshold are reported so the UI can shade them", () => {
  const result = runSensitivity({
    definition: productModel,
    values: NO_OVERRIDES,
    row: { key: "a", values: [1, 2, 3] },
    column: { key: "b", values: [2, 3, 4] },
    metric: "product",
    threshold: { direction: "min", value: 6 },
  });
  // Products below 6: (1,2)=2 (1,3)=3 (1,4)=4 (2,2)=4.
  assert.deepEqual(result.breaches, [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 0, column: 2 },
    { row: 1, column: 0 },
  ]);
  assert.equal(result.threshold?.source, "requested");
});

// ------------------------------------------------------------------ the solver --

test("the solver finds the LTV bound when DSCR is slack", () => {
  // NOI 100,000. At 75% LTV the loan is 750,000, debt service 37,500,
  // DSCR 2.67 — comfortably clear of 1.25, so leverage is what binds.
  const solution = solveLoanAmount({
    definition: lendingModel(100000),
    values: NO_OVERRIDES,
    maxLtv: 0.75,
    minDscr: 1.25,
  });

  assert.equal(solution.available, true);
  if (!solution.available) return;
  assert.equal(solution.feasible, true);
  assert.equal(solution.loanAmount, 750000);
  assert.equal(solution.binding?.code, "ltv");
  assert.equal(solution.binding?.label, "LTV-bound at 75%");
  assert.ok(solution.dscr !== null && solution.dscr > 2.6, `DSCR should be slack, got ${solution.dscr}`);
});

test("the solver finds the DSCR bound when cover binds", () => {
  // NOI 30,000 at a 1.25x covenant supports debt service of 24,000, which at
  // 5% is a loan of 480,000 — well inside the 750,000 the LTV ceiling allows.
  const solution = solveLoanAmount({
    definition: lendingModel(30000),
    values: NO_OVERRIDES,
    maxLtv: 0.75,
    minDscr: 1.25,
  });

  assert.equal(solution.available, true);
  if (!solution.available) return;
  assert.equal(solution.feasible, true);
  assert.equal(solution.binding?.code, "dscr");
  assert.equal(solution.binding?.label, "DSCR-bound at 1.25x");
  assert.ok(
    solution.loanAmount !== null && Math.abs(solution.loanAmount - 480000) <= 1000,
    `expected ~480,000 within the AED 1,000 tolerance, got ${solution.loanAmount}`,
  );
  // The answer must actually satisfy the covenant, not merely approach it.
  assert.ok(solution.dscr !== null && solution.dscr >= 1.25, `solved DSCR ${solution.dscr} breaches the covenant`);
});

test("the solver reports the debt yield bound when that is the tightest test", () => {
  // NOI 100,000, LTV ceiling 750,000. A 15% debt yield floor caps the loan at
  // 666,667 — tighter than both the 75% LTV and the 1.25x cover test.
  const solution = solveLoanAmount({
    definition: lendingModel(100000),
    values: NO_OVERRIDES,
    maxLtv: 0.75,
    minDscr: 1.25,
    minDebtYield: 0.15,
  });

  assert.equal(solution.available, true);
  if (!solution.available) return;
  assert.equal(solution.binding?.code, "debt_yield");
  assert.ok(
    solution.loanAmount !== null && Math.abs(solution.loanAmount - 666667) <= 1000,
    `expected ~666,667, got ${solution.loanAmount}`,
  );
});

test("the solver says unfundable rather than returning zero as a solution", () => {
  // A negative NOI — opex exceeding income, which happens on a vacant unit
  // with a full service charge — cannot service any facility at any size.
  // Note the discipline being tested: a small positive NOI IS fundable, just
  // at a small facility, and the solver must not confuse the two cases.
  const solution = solveLoanAmount({
    definition: lendingModel(-5000),
    values: NO_OVERRIDES,
    maxLtv: 0.75,
    minDscr: 1.25,
  });

  assert.equal(solution.available, true);
  if (!solution.available) return;
  assert.equal(solution.feasible, false);
  assert.equal(solution.loanAmount, null, "an unfundable deal must not report a loan of 0");
  assert.equal(solution.binding?.code, "dscr");
  assert.match(solution.reason ?? "", /No loan can be sized/);
});

test("the solver reports unavailable, and does not throw, when a model lacks the keys", () => {
  const solution = solveLoanAmount({ definition: noDebtModel, values: NO_OVERRIDES });
  assert.equal(solution.available, false);
  if (solution.available) return;
  assert.match(solution.reason, /no loan amount or LTV input/);

  // A model with an LTV but no DSCR line is equally unsolvable, for a
  // different reason, and must say which.
  const noDscr: ModelDefinition = {
    ...lendingModel(100000),
    lines: lendingModel(100000).lines.filter((l) => l.key !== "dscr"),
    summary: [],
  };
  const second = solveLoanAmount({ definition: noDscr, values: NO_OVERRIDES });
  assert.equal(second.available, false);
  if (second.available) return;
  assert.match(second.reason, /no DSCR line/);
});

test("a higher LTV lowers DSCR — the solver's monotonicity assumption holds", () => {
  const grid = runSensitivity({
    definition: lendingModel(100000),
    values: NO_OVERRIDES,
    row: { key: "ltv", values: [0.5, 0.6, 0.7] },
    metric: "dscr",
  });
  const values = grid.cells.map((row) => row[0]);
  assert.ok(values.every((v) => v !== null));
  assert.ok(
    (values[0] as number) > (values[1] as number) && (values[1] as number) > (values[2] as number),
    `DSCR must fall as LTV rises, got ${values.join(", ")}`,
  );
});

// ------------------------------------------------- the shipped Dubai model --

test("cheque-count sensitivity returns five results on the Dubai residential model", () => {
  const result = runPreset({
    definition: dubaiResidentialFull,
    values: NO_OVERRIDES,
    preset: "cheque_count",
  });

  assert.equal(result.column, null, "the cheque preset is one-dimensional");
  assert.equal(result.runs, 5);
  assert.equal(result.cells.length, 5);
  assert.deepEqual(result.row.values, [1, 2, 4, 6, 12]);
  assert.equal(result.row.key, "cheque_count");
  assert.ok(
    result.cells.every((row) => row.length === 1 && typeof row[0] === "number"),
    `every cheque structure must produce a value, got ${JSON.stringify(result.cells)}`,
  );

  // The base case is 4 cheques, the Dubai default, at index 2.
  assert.equal(result.base.row, 2);

  // Fewer cheques means the landlord holds the cash earlier, so the return
  // improves without the headline rent moving. If this ever inverts, the
  // cheque-timing benefit has been signed backwards.
  const oneCheque = result.cells[0][0] as number;
  const twelveCheques = result.cells[4][0] as number;
  assert.ok(
    oneCheque > twelveCheques,
    `one cheque (${oneCheque}) must beat twelve (${twelveCheques}) on ${result.metric.label}`,
  );
});

test("presets resolve against the shipped Dubai model's actual input keys", () => {
  const presets = resolvePresets(dubaiResidentialFull, NO_OVERRIDES);
  const byKey = new Map(presets.map((p) => [p.key, p]));

  // The model calls it exit_cap_rate, not exit_yield. The preset must still
  // resolve — that is the whole point of candidate keys.
  const exit = byKey.get("exit_yield_x_rent_growth");
  assert.ok(exit?.available, `exit yield preset unavailable: ${exit?.reason}`);
  assert.equal(exit?.row?.key, "exit_cap_rate");
  assert.equal(exit?.column?.key, "market_rent_growth");
  // Base 5.5%, 100bps either side.
  assert.deepEqual(exit?.row?.values, [0.045, 0.05, 0.055, 0.06, 0.065]);
  assert.equal(exit?.row?.baseIndex, 2);

  const ltv = byKey.get("ltv_x_rate");
  assert.ok(ltv?.available);
  assert.equal(ltv?.metric?.key, "dscr");
  assert.deepEqual(ltv?.row?.values, [0.5, 0.55, 0.6, 0.65, 0.7, 0.75]);

  const price = byKey.get("price_x_rent");
  assert.ok(price?.available);
  assert.equal(price?.row?.key, "price");
  assert.equal(price?.column?.key, "in_place_rent");
});

test("a preset that a model cannot support is reported unavailable, not thrown", () => {
  const presets = resolvePresets(productModel, NO_OVERRIDES);
  assert.equal(presets.length > 0, true);
  assert.ok(presets.every((p) => !p.available), "the synthetic model supports no preset");
  for (const preset of presets) {
    assert.equal(typeof preset.reason, "string");
    assert.ok((preset.reason ?? "").length > 0);
  }

  assert.throws(
    () => runPreset({ definition: productModel, values: NO_OVERRIDES, preset: "ltv_x_rate" }),
    (err: unknown) => err instanceof SensitivityError && /does not apply to this model/.test((err as Error).message),
  );
  assert.throws(
    () => runPreset({ definition: dubaiResidentialFull, values: NO_OVERRIDES, preset: "not_a_preset" }),
    (err: unknown) => err instanceof SensitivityError && /is not a known preset/.test((err as Error).message),
  );
});

test("a higher exit yield lowers the IRR on the shipped Dubai model", () => {
  const result = runPreset({
    definition: dubaiResidentialFull,
    values: NO_OVERRIDES,
    preset: "exit_yield_x_rent_growth",
  });
  assert.equal(result.metric.key, "levered_irr");

  const columnIndex = result.column ? Math.floor(result.column.values.length / 2) : 0;
  const irrs = result.cells.map((row) => row[columnIndex]);
  assert.ok(irrs.every((v) => typeof v === "number"), `expected an IRR in every row, got ${irrs.join(", ")}`);
  for (let i = 1; i < irrs.length; i++) {
    assert.ok(
      (irrs[i] as number) < (irrs[i - 1] as number),
      `a wider exit yield must lower the IRR: row ${i} (${irrs[i]}) is not below row ${i - 1} (${irrs[i - 1]})`,
    );
  }
});
