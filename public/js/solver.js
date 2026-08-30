// The loan sizing solver panel on the Underwriting tab.
//
// In the model the loan is an input: you say 75% LTV and the engine tells you
// the DSCR. A lender does the opposite — it fixes the constraints and solves for
// the largest facility that clears all of them. This panel asks the lender's
// question.
//
// The headline is deliberately NOT the number. "AED 654,625" tells an analyst
// nothing they can act on; "DSCR-bound at 1.25x" tells them that more equity
// will not help and only more rent or a cheaper rate will. So the binding
// constraint is set as the verdict and the amount sits underneath it as
// supporting evidence, which is the inverse of how a dashboard would do it and
// the right way round for the reader.
//
// Infeasible is never rendered as zero. The server returns loanAmount: null with
// a reason when no positive facility clears cover, and a zero there would read
// as "an all-cash purchase satisfies your DSCR covenant".

import { api } from "./api.js";
import { EM_DASH, figureFragment, formatValue, parseNumeric } from "./format.js";
import { append, button, el, notice, replace, sectionHead, setLoading } from "./ui.js";

const DEFAULT_MAX_LTV = 0.75;
const DEFAULT_MIN_DSCR = 1.25;

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

/**
 * The context metrics the solver echoes back are computed keys, so the model's
 * own line definition is the authority on how to render each one. Guessing is
 * the fallback, not the plan.
 */
function formatsFrom(result) {
  const map = new Map();
  for (const pool of [result?.summary, result?.lines, result?.returns]) {
    for (const line of pool || []) {
      if (line && line.key && !map.has(line.key)) map.set(line.key, line);
    }
  }
  return map;
}

function humanise(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function figureCell(label, text, options = {}) {
  const value = el("div", { class: "solve__fig" });
  value.append(figureFragment(text, { typeset: true }));
  return el(
    "div",
    { class: `solve__stat${options.hero ? " solve__stat--hero" : ""}` },
    el("div", { class: "t-label c-3", text: label }),
    value,
    options.sub ? el("div", { class: "t-caption c-3", text: options.sub }) : null,
  );
}

function contextStrip(solution, result) {
  const entries = Object.entries(solution.metrics || {}).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return null;

  const formats = formatsFrom(result);
  const strip = el("div", { class: "kv-strip", css: { "margin-block-start": "var(--s-20)" } });
  for (const [key, value] of entries) {
    const line = formats.get(key);
    const text = formatValue(value, line && line.format, solution.currency, line && line.precision);
    const host = el("span", { class: "dpair__v" });
    host.append(figureFragment(text));
    strip.append(
      el(
        "div",
        { class: "dpair" },
        el("span", { class: "dpair__k", text: (line && line.label) || humanise(key) }),
        host,
      ),
    );
  }
  return el(
    "div",
    { css: { "margin-block-start": "var(--s-32)" } },
    el("div", { class: "t-label c-3", text: "At the solved facility" }),
    strip,
  );
}

function verdict(solution) {
  const binding = solution.binding;
  const block = el("div", { class: `solve__verdict${solution.feasible ? "" : " solve__verdict--hard"}` });
  append(
    block,
    el("div", { class: "t-label c-3", text: solution.feasible ? "Binding constraint" : "No facility" }),
    el("div", {
      class: "solve__label t-title",
      text: binding ? binding.label : "Unconstrained",
    }),
    el("p", {
      class: "solve__detail t-body u-measure",
      text: solution.feasible
        ? binding
          ? binding.detail
          : "No constraint binds — the facility is limited only by the amount requested."
        : solution.reason || "This deal does not support debt at these constraints.",
    }),
  );
  return block;
}

function figures(solution, result) {
  const cur = solution.currency || "AED";
  const constraints = solution.constraints || {};
  const dscrLine = formatsFrom(result).get("dscr");

  const band = el(
    "div",
    { class: "solve__band" },
    figureCell(
      "Facility",
      solution.loanAmount === null ? EM_DASH : formatValue(solution.loanAmount, "currency", cur, 0),
      { hero: true, sub: `Solved to the nearest ${formatValue(solution.tolerance, "currency", cur, 0)}` },
    ),
    figureCell("Loan to value", solution.ltv === null ? EM_DASH : formatValue(solution.ltv, "percent", cur, 1), {
      sub: `Ceiling ${formatValue(constraints.maxLtv, "percent", cur, 0)}`,
    }),
    figureCell(
      "DSCR",
      solution.dscr === null ? EM_DASH : formatValue(solution.dscr, "multiple", cur, (dscrLine && dscrLine.precision) ?? 2),
      { sub: `Covenant ${formatValue(constraints.minDscr, "multiple", cur, 2)}` },
    ),
    figureCell(
      "Debt yield",
      solution.debtYield === null ? EM_DASH : formatValue(solution.debtYield, "percent", cur, 2),
      {
        sub:
          constraints.minDebtYield === null || constraints.minDebtYield === undefined
            ? "No floor applied"
            : `Floor ${formatValue(constraints.minDebtYield, "percent", cur, 2)}`,
      },
    ),
  );
  return band;
}

function renderSolution(mount, solution, result) {
  if (!solution.available) {
    replace(mount, notice(solution.reason || "This model cannot be sized.", "cau"));
    return;
  }

  const warnings = (solution.warnings || []).map((message) =>
    el(
      "div",
      { class: "flag flag--caution", css: { "margin-block-start": "var(--s-16)" } },
      el("div", { class: "flag__title", text: "Note" }),
      el("p", { class: "flag__body", text: message }),
    ),
  );

  replace(
    mount,
    el(
      "div",
      { class: "plate plate--pad solve" },
      verdict(solution),
      figures(solution, result),
      contextStrip(solution, result),
      el("p", {
        class: "t-caption c-3",
        css: { "margin-block-start": "var(--s-16)" },
        text: `Solved by re-running the model ${solution.iterations} time${
          solution.iterations === 1 ? "" : "s"
        } against a price of ${formatValue(solution.price, "currency", solution.currency, 0)} — the same code that produces the underwriting, not an inverted formula.`,
      }),
    ),
    ...warnings,
  );
}

function rateField(id, label, value, hint) {
  const control = el("input", {
    class: "input",
    id,
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    value,
  });
  return {
    control,
    node: el(
      "div",
      { class: "col-3 f" },
      el("label", { class: "f__label", for: id, text: label }),
      control,
      el("span", { class: "f__hint", text: hint }),
    ),
  };
}

/**
 * @param {{dealId:string, currency:string, depth:string, modelId:string, result:object}} ctx
 * @returns {HTMLElement} the solver section
 */
export function solverSection(ctx) {
  const mount = el("div");

  const ltv = rateField("solve-ltv", "Maximum LTV", formatValue(DEFAULT_MAX_LTV, "percent", ctx.currency, 0), "Regulatory or credit-policy ceiling.");
  const dscr = rateField("solve-dscr", "Minimum DSCR", DEFAULT_MIN_DSCR.toFixed(2), "UAE banks underwrite investment lending to 1.25x.");
  const debtYield = rateField("solve-dy", "Minimum debt yield", "", "Optional. Leave blank to size on LTV and cover alone.");

  const solveButton = button("Solve", { variant: "primary", iconName: "tune", onClick: () => solve() });

  async function solve() {
    const maxLtv = parseNumeric(ltv.control.value, "percent");
    const minDscr = parseNumeric(dscr.control.value);
    const minDebtYield = parseNumeric(debtYield.control.value, "percent");

    if (maxLtv === null || minDscr === null) {
      replace(mount, notice("A maximum LTV and a minimum DSCR are both required.", "cau"));
      return;
    }

    setLoading(solveButton, true, "Solving");
    try {
      const payload = await api.post(`/api/deals/${enc(ctx.dealId)}/solve-loan`, {
        maxLtv,
        minDscr,
        minDebtYield: minDebtYield === null ? undefined : minDebtYield,
        depth: ctx.depth,
        modelId: ctx.modelId,
      });
      renderSolution(mount, payload.solution, ctx.result);
    } catch (err) {
      replace(mount, notice(err.message || String(err), "neg"));
    } finally {
      setLoading(solveButton, false, "Solve");
    }
  }

  const form = el(
    "div",
    { class: "plate plate--pad no-print", css: { "margin-block-end": "var(--s-16)" } },
    el("div", { class: "grid grid--tight" }, ltv.node, dscr.node, debtYield.node),
    el("div", { class: "row row--8", css: { "margin-block-start": "var(--s-16)" } }, solveButton),
  );

  const section = el(
    "div",
    { class: "section" },
    sectionHead(
      "Loan sizing",
      "Solve the largest facility that clears every constraint, and name the one that binds.",
    ),
    form,
    mount,
  );

  solve();
  return section;
}
