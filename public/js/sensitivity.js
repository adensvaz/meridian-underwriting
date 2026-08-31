// The sensitivity grid on the Underwriting tab.
//
// Every cell is a real model run on the server — nothing here interpolates, and
// nothing here knows a formula. This module's whole job is to take the numbers
// the analysis endpoints return and lay them out so a committee can read them:
// the metric in a dense matrix, the cells that breach a threshold shaded, and
// the base case marked so the reader knows which square is the deal as it
// stands.
//
// Three rules are load-bearing.
//
//   1. A null cell is an em dash, never a zero. The engine returns null for
//      "could not be computed"; rendering that as 0 would read as "this
//      combination destroys the deal", which is a different and much worse
//      claim.
//   2. The cheque-count sensitivity is one-dimensional and is drawn as a row of
//      tiles rather than forced into a 1 x N matrix. It is the Dubai-specific
//      table and it should look deliberate, not like a degenerate grid.
//   3. Axis labels, preset names and threshold notes all originate server-side
//      and go in through textContent. Nothing on this page is built by string
//      concatenation into markup.

import { api } from "./api.js";
import {
  EM_DASH,
  coerceNumeric,
  figureFragment,
  formatDurationMs,
  formatValue,
  parseNumeric,
} from "./format.js";
import {
  append,
  button,
  clear,
  el,
  empty,
  frag,
  icon,
  notice,
  replace,
  sectionHead,
  setLoading,
} from "./ui.js";

const CUSTOM = "__custom";
const NUMERIC_TYPES = new Set(["currency", "percent", "number", "integer"]);

const AROUND_100BPS = [-0.01, -0.005, 0, 0.005, 0.01];
const PLUS_MINUS_10PCT = [0.9, 0.95, 1, 1.05, 1.1];

// ------------------------------------------------------------------ helpers --

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

function selectControl(options, value, onChange) {
  const control = el(
    "select",
    { on: onChange ? { change: () => onChange(control.value) } : undefined },
    options.map((option) =>
      el("option", { value: option.value, text: option.label, disabled: option.disabled }),
    ),
  );
  if (value !== undefined && value !== null) control.value = String(value);
  const caret = icon("caret");
  caret.setAttribute("class", "select__caret");
  const node = el("div", { class: "select" }, control, caret);
  return { node, control };
}

function labelled(text, node) {
  return el("div", { class: "row row--8" }, el("span", { class: "t-label c-3", text }), node);
}

/**
 * Everything this model computes, as metric choices. Derived from the run the
 * page already holds rather than from a second request — a sensitivity metric
 * is by definition a computed key, and those are all on `result`.
 */
function metricOptions(result) {
  const seen = new Map();
  const pools = [result?.summary, result?.lines, result?.returns];
  for (const pool of pools) {
    for (const line of pool || []) {
      if (!line || !line.key || seen.has(line.key)) continue;
      seen.set(line.key, {
        key: line.key,
        label: line.label || line.key,
        format: line.format,
        precision: line.precision,
      });
    }
  }
  return [...seen.values()];
}

/**
 * How many decimal places a percentage needs to be stated exactly. The rounding
 * step is not optional: 0.035 * 100 is 3.4999999999999996 and 0.55 * 100 is
 * 55.00000000000001, so a naive integer test gives "3.50%" beside "55%" on the
 * same axis.
 */
function percentDigits(value) {
  const scaled = Math.round(value * 1e8) / 1e6;
  if (Number.isInteger(scaled)) return 0;
  if (Number.isInteger(Math.round(scaled * 1e7) / 1e6)) return 1;
  return 2;
}

/**
 * One precision for the whole axis — the fewest digits that state every tick on
 * it exactly. A column of figures has to be a rigid rectangle, so 3.5% and 4.0%
 * sit together and neither is padded to 3.50%.
 */
function axisTickPrecision(axis) {
  let digits = 0;
  for (const raw of axis.values || []) {
    const value = coerceNumeric(raw);
    if (value !== null) digits = Math.max(digits, percentDigits(value));
  }
  return digits;
}

/**
 * An axis tick. Input values round-trip through SQLite as text, so a base value
 * arrives as "0.75" and would otherwise print raw beside a column of formatted
 * percentages. `exact` renders a single value on its own terms — the base case
 * in the legend is prose, not a column, and 4.49% must not round to 4.5%.
 */
function axisValueText(axis, raw, currency, options = {}) {
  if (raw === null || raw === undefined) return EM_DASH;
  const value = coerceNumeric(raw);
  if (value === null) return String(raw);

  if (axis.format === "percent") {
    return formatValue(
      value,
      "percent",
      currency,
      options.exact ? percentDigits(value) : axisTickPrecision(axis),
    );
  }
  const format = axis.format || (Number.isInteger(value) ? "integer" : undefined);
  return formatValue(value, format, currency);
}

function metricText(metric, value, currency) {
  return formatValue(value ?? null, metric.format, currency, metric.precision);
}

function thresholdText(sensitivity, currency) {
  const threshold = sensitivity.threshold;
  if (!threshold) return null;
  const bound = metricText(sensitivity.metric, threshold.value, currency);
  const verb = threshold.direction === "min" ? "below" : "above";
  const source =
    threshold.source === "benchmark" ? "the model's own benchmark" : "the threshold requested";
  return `Shaded — ${sensitivity.metric.label} ${verb} ${bound}, from ${source}.`;
}

function baseText(sensitivity, currency) {
  const { base, row, column } = sensitivity;
  const parts = [];
  parts.push(`${row.label} ${axisValueText(row, row.baseValue, currency, { exact: true })}`);
  if (column) {
    parts.push(`${column.label} ${axisValueText(column, column.baseValue, currency, { exact: true })}`);
  }

  const offGrid = [];
  if (row.baseIndex === null) offGrid.push(row.label.toLowerCase());
  if (column && column.baseIndex === null) offGrid.push(column.label.toLowerCase());

  const head = `Base case — ${parts.join(" x ")}`;
  if (!offGrid.length) {
    return base.value === null
      ? `${head}. The base cell could not be computed.`
      : `${head} = ${metricText(sensitivity.metric, base.value, currency)}.`;
  }
  return `${head}. The base ${offGrid.join(" and ")} ${
    offGrid.length === 1 ? "falls" : "fall"
  } between the values on the grid, so no base cell is marked.`;
}

// ------------------------------------------------------------------- matrix --

function matrixFor(sensitivity, currency) {
  const { row, column, cells, base, metric } = sensitivity;
  const breaches = new Set(sensitivity.breaches.map((b) => `${b.row}:${b.column}`));

  const wrap = el("div", { class: "tbl-wrap sens-wrap", dataset: { density: "compact" } });
  const table = el("table", { class: "tbl sens" });

  const corner = el(
    "th",
    { class: "sens__corner", scope: "col" },
    el("span", { class: "t-micro c-3", text: `Row · ${row.label}` }),
    el("span", { class: "t-micro c-3", text: `Col · ${column.label}` }),
  );

  const headRow = el("tr", null, corner);
  column.values.forEach((value, index) => {
    headRow.append(
      el("th", {
        class: `num sens__head${index === column.baseIndex ? " sens__head--base" : ""}`,
        scope: "col",
        text: axisValueText(column, value, currency),
      }),
    );
  });
  table.append(el("thead", null, headRow));

  const body = el("tbody");
  cells.forEach((line, r) => {
    const tr = el(
      "tr",
      null,
      el("th", {
        class: `num sens__head sens__rowhead${r === base.row ? " sens__head--base" : ""}`,
        scope: "row",
        text: axisValueText(row, row.values[r], currency),
      }),
    );
    line.forEach((value, c) => {
      const isBase = r === base.row && c === base.column;
      const cell = el("td", {
        class: `num sens__cell${breaches.has(`${r}:${c}`) ? " sens__cell--breach" : ""}${
          isBase ? " sens__cell--base" : ""
        }`,
      });
      if (isBase) cell.setAttribute("aria-label", `Base case, ${metricText(metric, value, currency)}`);
      cell.append(figureFragment(metricText(metric, value, currency)));
      tr.append(cell);
    });
    body.append(tr);
  });

  table.append(body);
  wrap.append(table);
  return wrap;
}

// -------------------------------------------------------------------- tiles --

/**
 * A one-dimensional sensitivity. The cheque count is the reason this exists: a
 * Dubai tenancy is paid in post-dated cheques handed over at signing, so fewer
 * cheques means the landlord holds the money earlier and the return moves
 * without the headline rent moving at all. Squeezing that into a 1 x N matrix
 * would bury it.
 */
function tilesFor(sensitivity, currency) {
  const { row, cells, base, metric } = sensitivity;
  const breaches = new Set(sensitivity.breaches.map((b) => b.row));
  const cheques = /cheque/i.test(row.key);

  const strip = el("div", { class: "tiles" });
  row.values.forEach((value, index) => {
    const text = axisValueText(row, value, currency);
    const isBase = index === base.row;
    const tile = el("div", {
      class: `tile${isBase ? " tile--base" : ""}${breaches.has(index) ? " tile--breach" : ""}`,
    });
    const figure = el("div", { class: "tile__v" });
    figure.append(figureFragment(metricText(metric, cells[index]?.[0] ?? null, currency), { typeset: true }));
    append(
      tile,
      el("div", {
        class: "tile__k",
        text: cheques ? `${text} ${String(value) === "1" ? "cheque" : "cheques"}` : text,
      }),
      figure,
      isBase ? el("div", { class: "tile__n t-micro", text: "Base case" }) : null,
    );
    strip.append(tile);
  });
  return strip;
}

// ------------------------------------------------------------------- legend --

function legend(sensitivity, currency) {
  const lines = [];
  const shaded = thresholdText(sensitivity, currency);
  if (shaded) lines.push(shaded);
  lines.push(baseText(sensitivity, currency));
  lines.push(
    `${sensitivity.runs} model run${sensitivity.runs === 1 ? "" : "s"} · ${formatDurationMs(
      sensitivity.durationMs,
    )} · every cell computed, none interpolated.`,
  );

  return el(
    "div",
    { class: "sens__legend" },
    lines.map((text) => el("p", { class: "t-caption c-3", text })),
  );
}

function warningFlags(sensitivity) {
  if (!sensitivity.warnings || !sensitivity.warnings.length) return null;
  return el(
    "div",
    { class: "flag-stack", css: { "margin-block-end": "var(--s-16)" } },
    sensitivity.warnings.map((message) =>
      el(
        "div",
        { class: "flag flag--caution" },
        el("div", { class: "flag__title", text: "Note" }),
        el("p", { class: "flag__body", text: message }),
      ),
    ),
  );
}

function renderResult(mount, sensitivity, currency) {
  replace(
    mount,
    warningFlags(sensitivity),
    sensitivity.column ? matrixFor(sensitivity, currency) : tilesFor(sensitivity, currency),
    legend(sensitivity, currency),
  );
}

function renderError(mount, message) {
  replace(mount, notice(message, "neg"));
}

// ------------------------------------------------------------ custom axes --

function unique(values) {
  return [...new Set(values)];
}

/**
 * A default range around the deal's own base value. An integer input is rounded
 * to whole numbers and de-duplicated: an axis that displays "38" while the model
 * actually ran 38.2 is a grid that quietly lies about what it computed, and a
 * small integer scaled by ±10% otherwise produces five identical columns.
 */
function seriesFor(input) {
  const base = coerceNumeric(input.value);
  if (input.type === "percent") {
    if (base === null || base <= 0) return [0, 0.01, 0.02, 0.03, 0.04, 0.05];
    return unique(AROUND_100BPS.map((d) => Math.round((base + d) * 1e6) / 1e6).filter((v) => v > 0));
  }
  if (base === null || base === 0) return [];
  const scaled = PLUS_MINUS_10PCT.map((m) => base * m);
  if (input.type === "integer") return unique(scaled.map((v) => Math.round(v)));
  return unique(scaled.map((v) => (Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 100) / 100)));
}

/**
 * Plain digits, no thousands separators. The separator between values is a
 * comma, so writing 1,050,000 into the same field would make "1" and "050" two
 * separate values on the axis — a grid that ran and meant nothing.
 */
function seriesText(input) {
  return seriesFor(input)
    .map((v) => String(Number(v.toFixed(6))))
    .join(", ");
}

/**
 * An analyst will paste "945,000, 997,500" out of a spreadsheet regardless of
 * what the hint says, so a comma sitting inside a number is collapsed before
 * the string is split on the commas that separate values.
 */
function stripGroupSeparators(raw) {
  let text = String(raw || "");
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
    if (next === text) break;
    text = next;
  }
  return text;
}

function parseSeries(raw, type) {
  return stripGroupSeparators(raw)
    .split(/[,;\n\t]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseNumeric(part, type))
    .filter((v) => v !== null && Number.isFinite(v));
}

function customPanel(ctx, onRun) {
  const inputs = (ctx.result?.inputs || []).filter(
    (i) => !i.hidden && NUMERIC_TYPES.has(i.type),
  );

  if (!inputs.length) {
    return {
      node: empty(
        "No numeric inputs",
        "This model declares no currency, percentage or numeric input to build a grid over.",
      ),
      values: () => null,
    };
  }

  const byKey = new Map(inputs.map((i) => [i.key, i]));
  const options = inputs.map((i) => ({ value: i.key, label: i.label }));

  const rowSelect = selectControl(options, inputs[0].key, (key) => {
    rowValues.value = seriesText(byKey.get(key));
  });
  const columnSelect = selectControl(
    [{ value: "", label: "None — one dimension" }, ...options],
    inputs[1] ? inputs[1].key : "",
    (key) => {
      columnValues.value = key ? seriesText(byKey.get(key)) : "";
      columnValues.disabled = !key;
    },
  );

  const rowValues = el("input", {
    class: "input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Row values",
    value: seriesText(inputs[0]),
  });
  const columnValues = el("input", {
    class: "input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Column values",
    value: inputs[1] ? seriesText(inputs[1]) : "",
    disabled: !inputs[1],
  });

  const node = el(
    "div",
    { class: "plate plate--pad no-print", css: { "margin-block-end": "var(--s-16)" } },
    el(
      "div",
      { class: "grid grid--tight" },
      el(
        "div",
        { class: "col-3 f" },
        el("span", { class: "f__label", text: "Row variable" }),
        rowSelect.node,
      ),
      el(
        "div",
        { class: "col-3 f" },
        el("span", { class: "f__label", text: "Row values" }),
        rowValues,
      ),
      el(
        "div",
        { class: "col-3 f" },
        el("span", { class: "f__label", text: "Column variable" }),
        columnSelect.node,
      ),
      el(
        "div",
        { class: "col-3 f" },
        el("span", { class: "f__label", text: "Column values" }),
        columnValues,
      ),
    ),
    el("p", {
      class: "f__hint",
      css: { "margin-block-start": "var(--s-8)" },
      text:
        "Comma-separated. A percentage takes either form — 4.5% and 0.045 both mean 45 basis points over four percent. Eleven values per axis is the server's ceiling.",
    }),
    el(
      "div",
      { class: "row row--8", css: { "margin-block-start": "var(--s-12)" } },
      button("Run grid", { variant: "secondary", iconName: "rerun", onClick: () => onRun() }),
    ),
  );

  return {
    node,
    values() {
      const rowKey = rowSelect.control.value;
      const rowInput = byKey.get(rowKey);
      const row = { key: rowKey, values: parseSeries(rowValues.value, rowInput.type) };
      if (!row.values.length) throw new Error(`Give the row variable "${rowInput.label}" at least one value.`);

      const columnKey = columnSelect.control.value;
      if (!columnKey) return { row, column: null };
      const columnInput = byKey.get(columnKey);
      const column = { key: columnKey, values: parseSeries(columnValues.value, columnInput.type) };
      if (!column.values.length) {
        throw new Error(`Give the column variable "${columnInput.label}" at least one value.`);
      }
      return { row, column };
    },
  };
}

// ------------------------------------------------------------------ the grid --

function buildGrid(ctx, section, presets) {
  // Only the grids that can actually run. Listing "Exit yield x rent growth —
  // unavailable", "Price x rent — unavailable" and "LTV x interest rate —
  // unavailable" to a mortgage broker is four lines of somebody else's
  // vocabulary and nothing they can do with any of it; selecting one could only
  // ever produce an error panel. A shipped grid that cannot run is not an
  // option, so it is not offered.
  const twoD = presets.filter((p) => p.dimensions === 2 && p.available);
  const firstAvailable = twoD[0] || null;

  const presetOptions = [
    ...twoD.map((p) => ({ value: p.key, label: p.label })),
    { value: CUSTOM, label: "Custom grid" },
  ];

  const metrics = metricOptions(ctx.result);
  const metricSelect = metrics.length
    ? selectControl(
        metrics.map((m) => ({ value: m.key, label: m.label })),
        firstAvailable && firstAvailable.metric ? firstAvailable.metric.key : metrics[0].key,
        () => run(),
      )
    : null;

  const mount = el("div");
  const runButton = button("Re-run", { variant: "ghost", iconName: "rerun", onClick: () => run() });

  const presetSelect = selectControl(
    presetOptions,
    firstAvailable ? firstAvailable.key : CUSTOM,
    () => {
      syncMode();
      run();
    },
  );

  const custom = customPanel(ctx, () => run());
  custom.node.hidden = true;

  function selectedPreset() {
    return twoD.find((p) => p.key === presetSelect.control.value) || null;
  }

  function syncMode() {
    const isCustom = presetSelect.control.value === CUSTOM;
    custom.node.hidden = !isCustom;
  }

  async function run() {
    const isCustom = presetSelect.control.value === CUSTOM;
    const preset = selectedPreset();

    if (!isCustom && preset && !preset.available) {
      replace(
        mount,
        empty(
          `${preset.label} does not apply to this model`,
          preset.reason ||
            "The model does not declare the inputs this preset needs. Build the grid by hand instead.",
        ),
      );
      return;
    }

    setLoading(runButton, true, "Running");
    try {
      const body = { depth: ctx.depth, modelId: ctx.modelId };
      if (metricSelect) body.metric = metricSelect.control.value;

      let payload;
      if (isCustom) {
        const axes = custom.values();
        payload = await api.post(`/api/deals/${enc(ctx.dealId)}/sensitivity`, {
          ...body,
          row: axes.row,
          column: axes.column,
          metric: body.metric,
        });
      } else {
        payload = await api.post(`/api/deals/${enc(ctx.dealId)}/sensitivity/preset`, {
          ...body,
          preset: preset.key,
        });
      }
      renderResult(mount, payload.sensitivity, ctx.currency);
    } catch (err) {
      renderError(mount, err.message || String(err));
    } finally {
      setLoading(runButton, false, "Re-run");
    }
  }

  const toolbar = el(
    "div",
    { class: "toolbar no-print" },
    labelled("Grid", presetSelect.node),
    metricSelect ? labelled("Metric", metricSelect.node) : null,
    el("div", { class: "spacer" }),
    runButton,
  );

  replace(
    section,
    sectionHead(
      "Sensitivity",
      twoD.length
        ? "Every cell is a full model run against the saved deal — nothing is interpolated."
        : "None of the shipped grids apply to this model, so build your own over any two of its inputs. Every cell is a full model run — nothing is interpolated.",
    ),
    toolbar,
    custom.node,
    mount,
  );

  syncMode();
  run();
}

// -------------------------------------------------------- cheque structure --

function buildCheque(ctx, section, preset) {
  if (!preset) {
    clear(section);
    return;
  }

  // A model with no cheque count has no cheque structure to vary. Rendering a
  // "Cheque structure · Dubai-specific" heading over an explanation of why it
  // cannot run puts post-dated rent cheques in front of a mortgage applicant
  // who is not letting anything to anybody — and in front of a US multifamily
  // deal, where the instrument does not exist either.
  if (!preset.available) {
    clear(section);
    return;
  }

  const metrics = metricOptions(ctx.result);
  const metricSelect = metrics.length
    ? selectControl(
        metrics.map((m) => ({ value: m.key, label: m.label })),
        preset.metric ? preset.metric.key : metrics[0].key,
        () => run(),
      )
    : null;

  const mount = el("div");
  const runButton = button("Re-run", { variant: "ghost", iconName: "rerun", onClick: () => run() });

  async function run() {
    setLoading(runButton, true, "Running");
    try {
      const body = { preset: preset.key, depth: ctx.depth, modelId: ctx.modelId };
      if (metricSelect) body.metric = metricSelect.control.value;
      const payload = await api.post(`/api/deals/${enc(ctx.dealId)}/sensitivity/preset`, body);
      renderResult(mount, payload.sensitivity, ctx.currency);
    } catch (err) {
      renderError(mount, err.message || String(err));
    } finally {
      setLoading(runButton, false, "Re-run");
    }
  }

  replace(
    section,
    sectionHead("Cheque structure", preset.description),
    el(
      "div",
      { class: "toolbar no-print" },
      metricSelect ? labelled("Metric", metricSelect.node) : null,
      el("div", { class: "spacer" }),
      runButton,
    ),
    mount,
  );

  run();
}

// --------------------------------------------------------------------- api --

/**
 * @param {{dealId:string, currency:string, depth:string, modelId:string, result:object}} ctx
 * @returns {DocumentFragment} the grid section and the cheque section
 *
 * A fragment rather than a wrapper element on purpose: `.section:first-child`
 * zeroes the top margin, and a wrapper would make the grid the first child of
 * itself — collapsing the 40px that separates it from the panel above.
 */
export function sensitivitySection(ctx) {
  const gridSection = el("div", { class: "section" }, sectionHead("Sensitivity", "Resolving the presets for this model"));
  const chequeSection = el("div", { class: "section" });
  const host = frag(gridSection, chequeSection);

  (async () => {
    try {
      const query = `depth=${enc(ctx.depth)}${ctx.modelId ? `&modelId=${enc(ctx.modelId)}` : ""}`;
      const payload = await api.get(`/api/deals/${enc(ctx.dealId)}/sensitivity/presets?${query}`);
      const presets = payload.presets || [];
      buildGrid(ctx, gridSection, presets);
      buildCheque(ctx, chequeSection, presets.find((p) => p.key === "cheque_count"));
    } catch (err) {
      replace(gridSection, sectionHead("Sensitivity"), notice(err.message || String(err), "neg"));
      clear(chequeSection);
    }
  })();

  return host;
}
