// The model editor.
//
// This screen is the argument. An underwriting model here is data — a JSON
// document of inputs, formula strings, projection rows and thresholds — and
// this page lets an analyst read it, fork it and change it. Nothing about a
// cap rate is compiled into the product.
//
// Formulas are validated against the server on every blur, so a broken
// expression fails next to the field that caused it rather than three screens
// later during a run.

import * as API from "./api.js";
import { formatDate, formatDateTime } from "./format.js";
import {
  append,
  button,
  clear,
  el,
  empty,
  frag,
  icon,
  pill,
  qs,
  replace,
  sectionHead,
  setLoading,
  tag,
} from "./ui.js";

const view = qs("#view");

const state = {
  models: [],
  model: null,
  definition: null,
  issues: [],
  dirty: false,
  routeToken: 0,
};

// The `where` strings the validator emits: model, input.<key>, line.<key>,
// projection.<key>, projection.years, return.<key>, summary,
// benchmark.<key>, flag.<id>.
function issuesFor(where) {
  return state.issues.filter((i) => i.where === where);
}

function worstLevel(issues) {
  return issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : null;
}

// ------------------------------------------------------------------ routing --

function parseHash() {
  const raw = window.location.hash.replace(/^#/, "").replace(/^\//, "");
  const id = raw.split("/").filter(Boolean)[0];
  return id ? { name: "model", id } : { name: "list" };
}

function go(hash) {
  if (window.location.hash === hash) route();
  else window.location.hash = hash;
}

async function route() {
  const token = ++state.routeToken;
  const target = parseHash();
  try {
    if (target.name === "list") {
      const payload = await API.models.list();
      if (token !== state.routeToken) return;
      state.models = payload.models || [];
      state.model = null;
      state.definition = null;
      document.title = "Models — Meridian";
      renderList();
    } else {
      const [model, revisions] = await Promise.all([
        API.models.get(target.id),
        API.models.revisions(target.id).catch(() => ({ revisions: [] })),
      ]);
      if (token !== state.routeToken) return;
      state.model = model;
      state.definition = model.definition ? structuredClone(model.definition) : null;
      state.issues = [];
      state.dirty = false;
      document.title = `${model.name} — Meridian`;
      renderEditor(revisions.revisions || []);
    }
  } catch (err) {
    if (token !== state.routeToken) return;
    renderFailure(err);
  }
}

function renderFailure(err) {
  replace(
    view,
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        { class: "page-head__id" },
        el("span", { class: "t-label c-3", text: "Models" }),
        el("h1", { class: "t-display-m", text: "Something did not load" }),
      ),
    ),
    el(
      "div",
      { class: "flag" },
      el("div", { class: "flag__title", text: "Error" }),
      el("p", { class: "flag__body", text: err && err.message ? err.message : String(err) }),
    ),
    el("div", { css: { "margin-block-start": "var(--s-16)" } }, button("All models", { onClick: () => go("#/") })),
  );
}

// --------------------------------------------------------------- model list --

function renderList() {
  const head = el(
    "div",
    { class: "page-head" },
    el(
      "div",
      { class: "page-head__id" },
      el("span", { class: "t-label c-3", text: "Underwriting" }),
      el("h1", { class: "t-display-m", text: "Models" }),
      el(
        "div",
        { class: "page-head__meta t-caption" },
        el("span", { text: `${state.models.length} model${state.models.length === 1 ? "" : "s"}` }),
        el("span", { text: "The methodology is data, not code. Clone one and change it." }),
      ),
    ),
  );

  if (!state.models.length) {
    replace(view, head, empty("No models", "No underwriting models are installed for this account."));
    return;
  }

  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "default" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-name", scope: "col", text: "Model" }),
        el("th", { class: "w-tag", scope: "col", text: "Key" }),
        el("th", { class: "w-tag", scope: "col", text: "Market" }),
        el("th", { class: "w-tag", scope: "col", text: "Asset" }),
        el("th", { class: "w-tag", scope: "col", text: "Depth" }),
        el("th", { class: "num", scope: "col", text: "Version" }),
        el("th", { class: "w-date", scope: "col", text: "Updated" }),
        el("th", { class: "w-tag", scope: "col", text: "Access" }),
        el("th", { class: "w-tag no-print", scope: "col", text: "" }),
      ),
    ),
  );

  const body = el("tbody");
  for (const model of state.models) {
    body.append(
      el(
        "tr",
        null,
        el("td", { class: "w-name" }, el("a", { href: `#/${model.id}`, text: model.name, class: "u-truncate" })),
        el("td", { class: "t-micro c-3", text: model.key }),
        el("td", { text: model.market }),
        el("td", { text: model.assetType }),
        el("td", { text: model.depth }),
        el("td", { class: "num", text: String(model.version) }),
        el("td", { class: "num", text: formatDate(model.updatedAt) }),
        el(
          "td",
          { class: "w-tag" },
          model.isSystem ? pill("READ ONLY", "neu") : pill("EDITABLE", "pos"),
        ),
        el(
          "td",
          { class: "w-tag no-print" },
          el(
            "div",
            { class: "row row--8" },
            button("Clone", { size: "sm", iconName: "plus", onClick: () => cloneModel(model) }),
            model.isSystem
              ? null
              : (() => {
                  const del = button("Delete", { size: "sm", variant: "destructive" });
                  del.addEventListener("click", () => removeModel(model, del));
                  return del;
                })(),
          ),
        ),
      ),
    );
  }

  table.append(body);
  wrap.append(table);
  replace(view, head, wrap);
}

/**
 * Cloning does not stop to ask for a name. It makes the copy and drops you in
 * the editor, where the name is the first editable field — one fewer dialog,
 * and the name is changed in the place that already exists to change it.
 */
async function cloneModel(model) {
  const created = await API.models.clone(model.id, `${model.name} (copy)`);
  go(`#/${created.id}`);
}

/** Two-step, in place. A native confirm() dialog is not part of this system. */
function removeModel(model, trigger) {
  if (trigger.dataset.armed !== "1") {
    trigger.dataset.armed = "1";
    setLoading(trigger, false, "Confirm delete");
    setTimeout(() => {
      if (!trigger.isConnected) return;
      delete trigger.dataset.armed;
      setLoading(trigger, false, "Delete");
    }, 4000);
    return;
  }
  API.models.remove(model.id).then(route);
}

// ------------------------------------------------------------- model editor --

function renderEditor(revisions) {
  const model = state.model;
  const definition = state.definition;
  const editable = Boolean(model.editable);
  ISSUE_SLOTS.clear();

  const noteInput = el("input", {
    class: "input",
    id: "save-note",
    type: "text",
    placeholder: "What changed, and why",
    css: { "max-inline-size": "320px" },
  });

  const saveButton = button("Save model", {
    variant: "primary",
    disabled: !editable,
    onClick: () => saveModel(saveButton, noteInput),
  });

  const validateButton = button("Validate", {
    variant: "secondary",
    iconName: "check",
    onClick: () => validate({ announce: true }),
  });

  const head = el(
    "div",
    { class: "page-head" },
    el(
      "div",
      { class: "page-head__id" },
      el("a", { class: "t-label c-3 row row--8", href: "#/" }, icon("back"), el("span", { text: "All models" })),
      el("h1", { class: "t-display-m u-truncate", text: model.name }),
      el(
        "div",
        { class: "page-head__meta t-caption" },
        el("span", { class: "t-micro c-3", text: model.key }),
        el("span", { text: model.market }),
        el("span", { text: model.assetType }),
        el("span", { text: model.depth }),
        el("span", { text: `v${model.version}` }),
      ),
    ),
    el(
      "div",
      { class: "page-head__actions no-print" },
      model.isSystem ? pill("READ ONLY", "neu") : pill("EDITABLE", "pos"),
      model.isSystem ? button("Clone to edit", { variant: "primary", onClick: () => cloneModel(model) }) : null,
    ),
  );

  replace(view, head);

  if (!definition) {
    view.append(empty("No definition", "This model has no stored definition."));
    return;
  }

  if (model.isSystem) {
    view.append(
      el(
        "div",
        { class: "flag flag--dd flag--in" },
        el("div", { class: "flag__title", text: "Ships with Meridian" }),
        el("p", {
          class: "flag__body",
          text:
            "System models are read-only so there is always a known-good baseline to compare against. " +
            "Clone it — your copy is fully editable, and a broken formula in it can never affect this one.",
        }),
      ),
    );
  }

  const issueRail = el("div", { class: "flag-stack", id: "issue-rail" });
  view.append(el("div", { class: "section" }, issueRail));

  view.append(metaSection(definition, editable));
  view.append(inputsSection(definition, editable));
  view.append(linesSection("Computed lines", definition.lines || [], "line", editable));

  if (definition.projection) {
    view.append(projectionSection(definition, editable));
  }
  if (definition.returns && definition.returns.length) {
    view.append(linesSection("Returns", definition.returns, "return", editable));
  }
  if (definition.benchmarks && definition.benchmarks.length) {
    view.append(benchmarksSection(definition, editable));
  }
  if (definition.flags && definition.flags.length) {
    view.append(flagsSection(definition, editable));
  }

  view.append(
    el(
      "div",
      { class: "section no-print" },
      sectionHead("Save", "A model that does not validate is never persisted."),
      el(
        "div",
        { class: "toolbar" },
        el("label", { class: "t-label c-3", for: "save-note", text: "Note" }),
        noteInput,
        el("div", { class: "spacer" }),
        validateButton,
        saveButton,
      ),
    ),
  );

  view.append(revisionSection(revisions));
  validate({ announce: false });
}

function metaSection(definition, editable) {
  const grid = el("div", { class: "grid grid--tight" });

  const bind = (label, key, colClass = "col-4", multiline = false) => {
    const id = `meta-${key}`;
    const control = multiline
      ? el("textarea", { class: "input", id, rows: 4, disabled: !editable })
      : el("input", { class: "input", id, type: "text", disabled: !editable });
    control.value = definition[key] === null || definition[key] === undefined ? "" : String(definition[key]);
    control.addEventListener("change", () => {
      definition[key] = control.value;
      state.dirty = true;
      validate({ announce: false });
    });
    grid.append(
      el(
        "div",
        { class: `${colClass} f` },
        el("label", { class: "f__label", for: id, text: label }),
        control,
      ),
    );
  };

  bind("Model key", "key");
  bind("Name", "name");
  bind("Market", "market");
  bind("Currency", "currency");
  bind("Asset type", "assetType");
  bind("Depth", "depth");
  bind("Description", "description", "col-12", true);
  bind("Methodology", "methodology", "col-12", true);

  const summaryId = "meta-summary";
  const summary = el("input", {
    class: "input t-mono",
    id: summaryId,
    type: "text",
    disabled: !editable,
    value: (definition.summary || []).join(", "),
  });
  summary.addEventListener("change", () => {
    definition.summary = summary.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    state.dirty = true;
    validate({ announce: false });
  });
  grid.append(
    el(
      "div",
      { class: "col-12 f" },
      el("label", { class: "f__label", for: summaryId, text: "Headline KPI keys, in order" }),
      summary,
      el("span", { class: "f__hint", text: "Comma-separated computed keys. These are the tiles at the top of the underwriting tab." }),
      issueSlot("summary"),
    ),
  );

  return el("div", { class: "section" }, sectionHead("Model", "Identity and presentation."), grid);
}

const ISSUE_SLOTS = new Map();

function issueSlot(where) {
  const node = el("span", { class: "f__error", "data-where": where });
  ISSUE_SLOTS.set(where, node);
  return node;
}

function paintIssues() {
  for (const [where, node] of ISSUE_SLOTS) {
    const issues = issuesFor(where);
    const level = worstLevel(issues);
    node.textContent = issues.map((i) => i.message).join(" · ");
    node.style.setProperty("color", level === "warning" ? "var(--cau)" : "var(--neg)");

    const owner = node.closest("tr") || node.closest(".f");
    if (!owner) continue;
    const field = owner.querySelector(".formula-src") || owner.querySelector(".field__value, .input");
    if (!field) continue;
    // A 1px oxide rule under the offending field. Never a shake, never a badge.
    if (level === "error") {
      field.setAttribute("aria-invalid", "true");
      field.style.setProperty("box-shadow", "inset 0 -1px 0 var(--neg)");
    } else {
      field.removeAttribute("aria-invalid");
      field.style.removeProperty("box-shadow");
    }
  }

  const rail = qs("#issue-rail");
  if (!rail) return;
  clear(rail);

  const errors = state.issues.filter((i) => i.level === "error");
  const warnings = state.issues.filter((i) => i.level === "warning");

  if (errors.length) {
    rail.append(
      el(
        "div",
        { class: "flag flag--in" },
        el("div", { class: "flag__title", text: `${errors.length} error${errors.length === 1 ? "" : "s"}` }),
        el("ul", { class: "flag__body" }, errors.map((i) => el("li", { text: `${i.where} — ${i.message}` }))),
      ),
    );
  }
  if (warnings.length) {
    rail.append(
      el(
        "div",
        { class: "flag flag--caution flag--in", css: { "--i": "1" } },
        el("div", { class: "flag__title", text: `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` }),
        el("ul", { class: "flag__body" }, warnings.map((i) => el("li", { text: `${i.where} — ${i.message}` }))),
      ),
    );
  }
  if (!errors.length && !warnings.length) {
    rail.append(
      el(
        "div",
        { class: "flag flag--strength flag--in" },
        el("div", { class: "flag__title", text: "Validates" }),
        el("p", { class: "flag__body", text: "Every formula compiles and every reference resolves." }),
      ),
    );
  }
}

function cellInput(value, { mono, disabled, onChange, placeholder, className } = {}) {
  const control = el("input", {
    class: `field__value${mono ? " t-mono" : ""}${className ? ` ${className}` : ""}`,
    type: "text",
    value: value === null || value === undefined ? "" : String(value),
    disabled,
    placeholder,
    autocomplete: "off",
    spellcheck: "false",
  });
  control.style.setProperty("text-align", "start");
  control.addEventListener("change", () => onChange(control.value));
  control.addEventListener("blur", () => validate({ announce: false }));
  return control;
}

function textCell(value, options) {
  return el("td", null, cellInput(value, options));
}

function inputsSection(definition, editable) {
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "comfortable" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-tag", scope: "col", text: "Key" }),
        el("th", { class: "w-name", scope: "col", text: "Label" }),
        el("th", { class: "w-tag", scope: "col", text: "Group" }),
        el("th", { class: "w-tag", scope: "col", text: "Type" }),
        el("th", { class: "w-tag", scope: "col", text: "Unit" }),
        el("th", { class: "w-tag", scope: "col", text: "Default" }),
        el("th", { class: "w-tag", scope: "col", text: "Source" }),
        el("th", { class: "w-name", scope: "col", text: "Issue" }),
        el("th", { class: "no-print", scope: "col", text: "" }),
      ),
    ),
  );

  const body = el("tbody");
  const buildRow = (input) => {
    const row = el("tr");
    row.append(
      textCell(input.key, { mono: true, disabled: !editable, onChange: (v) => { input.key = v.trim(); state.dirty = true; } }),
      textCell(input.label, { disabled: !editable, onChange: (v) => { input.label = v; state.dirty = true; } }),
      textCell(input.group, { disabled: !editable, onChange: (v) => { input.group = v; state.dirty = true; } }),
      textCell(input.type, { disabled: !editable, onChange: (v) => { input.type = v.trim(); state.dirty = true; } }),
      textCell(input.unit, { disabled: !editable, onChange: (v) => { input.unit = v.trim() || undefined; state.dirty = true; } }),
      textCell(input.default, {
        mono: true,
        disabled: !editable,
        onChange: (v) => {
          input.default = coerce(v, input.type);
          state.dirty = true;
        },
      }),
      textCell(input.source, { disabled: !editable, onChange: (v) => { input.source = v.trim() || undefined; state.dirty = true; } }),
      el("td", { class: "w-name" }, issueSlot(`input.${input.key}`)),
      el(
        "td",
        { class: "no-print" },
        editable
          ? el(
              "button",
              {
                class: "field__action",
                type: "button",
                "aria-label": `Remove ${input.key}`,
                on: {
                  click: () => {
                    definition.inputs.splice(definition.inputs.indexOf(input), 1);
                    row.remove();
                    state.dirty = true;
                    validate({ announce: false });
                  },
                },
              },
              icon("trash"),
            )
          : null,
      ),
    );
    return row;
  };

  for (const input of definition.inputs || []) body.append(buildRow(input));
  table.append(body);
  wrap.append(table);

  const add = editable
    ? button("Add input", {
        size: "sm",
        iconName: "plus",
        onClick: () => {
          const fresh = { key: "new_input", label: "New input", group: "Assumptions", type: "number" };
          definition.inputs = definition.inputs || [];
          definition.inputs.push(fresh);
          body.append(buildRow(fresh));
          state.dirty = true;
          validate({ announce: false });
        },
      })
    : null;

  return el(
    "div",
    { class: "section" },
    sectionHead("Inputs", "Extraction and the reviewer fill these. Everything downstream is derived from them."),
    wrap,
    add ? el("div", { class: "row row--8 no-print", css: { "margin-block-start": "var(--s-12)" } }, add) : null,
  );
}

function coerce(raw, type) {
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  if (type === "boolean") return /^(y|yes|true|1)$/i.test(trimmed);
  if (type === "text" || type === "select" || type === "date") return trimmed;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : trimmed;
}

function linesSection(title, lines, wherePrefix, editable) {
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "comfortable" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-tag", scope: "col", text: "Key" }),
        el("th", { class: "w-name", scope: "col", text: "Label" }),
        el("th", { class: "w-tag", scope: "col", text: "Group" }),
        el("th", { class: "w-tag", scope: "col", text: "Unit" }),
        el("th", { class: "w-tag", scope: "col", text: "Format" }),
        el("th", { scope: "col", text: "Formula" }),
        el("th", { class: "w-name", scope: "col", text: "Issue" }),
        el("th", { class: "no-print", scope: "col", text: "" }),
      ),
    ),
  );

  const body = el("tbody");
  const buildRow = (line) => {
    const row = el("tr");
    const formulaCell = el("td");
    const formula = cellInput(line.formula, {
      mono: true,
      disabled: !editable,
      className: "formula-src",
      placeholder: "income - expenses",
      onChange: (v) => {
        line.formula = v;
        state.dirty = true;
      },
    });
    formula.style.setProperty("min-inline-size", "420px");
    formulaCell.append(formula);

    row.append(
      textCell(line.key, { mono: true, disabled: !editable, onChange: (v) => { line.key = v.trim(); state.dirty = true; } }),
      textCell(line.label, { disabled: !editable, onChange: (v) => { line.label = v; state.dirty = true; } }),
      textCell(line.group, { disabled: !editable, onChange: (v) => { line.group = v; state.dirty = true; } }),
      textCell(line.unit, { disabled: !editable, onChange: (v) => { line.unit = v.trim() || undefined; state.dirty = true; } }),
      textCell(line.format, { disabled: !editable, onChange: (v) => { line.format = v.trim() || undefined; state.dirty = true; } }),
      formulaCell,
      el("td", { class: "w-name" }, issueSlot(`${wherePrefix}.${line.key}`)),
      el(
        "td",
        { class: "no-print" },
        editable
          ? el(
              "button",
              {
                class: "field__action",
                type: "button",
                "aria-label": `Remove ${line.key}`,
                on: {
                  click: () => {
                    lines.splice(lines.indexOf(line), 1);
                    row.remove();
                    state.dirty = true;
                    validate({ announce: false });
                  },
                },
              },
              icon("trash"),
            )
          : null,
      ),
    );
    return row;
  };

  for (const line of lines) body.append(buildRow(line));
  table.append(body);
  wrap.append(table);

  const add = editable
    ? button("Add line", {
        size: "sm",
        iconName: "plus",
        onClick: () => {
          const fresh = { key: "new_line", label: "New line", group: "Computed", formula: "0" };
          lines.push(fresh);
          body.append(buildRow(fresh));
          state.dirty = true;
          validate({ announce: false });
        },
      })
    : null;

  return el(
    "div",
    { class: "section" },
    sectionHead(title, "Formula source. Declared order is evaluation order — a line must exist before it is referenced."),
    wrap,
    add ? el("div", { class: "row row--8 no-print", css: { "margin-block-start": "var(--s-12)" } }, add) : null,
  );
}

function projectionSection(definition, editable) {
  const projection = definition.projection;
  const yearsId = "proj-years";
  const years = el("input", {
    class: "input t-mono",
    id: yearsId,
    type: "text",
    disabled: !editable,
    value: String(projection.years),
    css: { "max-inline-size": "220px" },
  });
  years.addEventListener("change", () => {
    const n = Number(years.value);
    projection.years = Number.isFinite(n) && years.value.trim() !== "" ? n : years.value.trim();
    state.dirty = true;
    validate({ announce: false });
  });

  const section = linesSection("Projection rows", projection.rows || [], "projection", editable);
  const header = el(
    "div",
    { class: "f", css: { "margin-block-end": "var(--s-16)" } },
    el("label", { class: "f__label", for: yearsId, text: "Years — a number, or an input key" }),
    years,
    issueSlot("projection.years"),
  );
  section.insertBefore(header, section.children[1]);
  return section;
}

function benchmarksSection(definition, editable) {
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "default" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-tag", scope: "col", text: "Key" }),
        el("th", { class: "w-name", scope: "col", text: "Label" }),
        el("th", { class: "w-tag", scope: "col", text: "Direction" }),
        el("th", { class: "num w-pct", scope: "col", text: "Good" }),
        el("th", { class: "num w-pct", scope: "col", text: "Warn" }),
        el("th", { class: "w-name", scope: "col", text: "Issue" }),
      ),
    ),
  );

  const body = el("tbody");
  for (const b of definition.benchmarks) {
    body.append(
      el(
        "tr",
        null,
        textCell(b.key, { mono: true, disabled: !editable, onChange: (v) => { b.key = v.trim(); state.dirty = true; } }),
        textCell(b.label, { disabled: !editable, onChange: (v) => { b.label = v; state.dirty = true; } }),
        textCell(b.direction, { disabled: !editable, onChange: (v) => { b.direction = v.trim(); state.dirty = true; } }),
        textCell(b.good, { mono: true, disabled: !editable, onChange: (v) => { b.good = Number(v); state.dirty = true; } }),
        textCell(b.warn, { mono: true, disabled: !editable, onChange: (v) => { b.warn = Number(v); state.dirty = true; } }),
        el("td", { class: "w-name" }, issueSlot(`benchmark.${b.key}`)),
      ),
    );
  }

  table.append(body);
  wrap.append(table);
  return el("div", { class: "section" }, sectionHead("Thresholds", "Presentational only — a benchmark colours a tile, it never changes a number."), wrap);
}

function flagsSection(definition, editable) {
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "comfortable" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-tag", scope: "col", text: "Id" }),
        el("th", { class: "w-tag", scope: "col", text: "Severity" }),
        el("th", { class: "w-name", scope: "col", text: "Title" }),
        el("th", { scope: "col", text: "Condition" }),
        el("th", { class: "w-name", scope: "col", text: "Issue" }),
      ),
    ),
  );

  const body = el("tbody");
  for (const flag of definition.flags) {
    const condition = cellInput(flag.when, {
      mono: true,
      disabled: !editable,
      className: "formula-src",
      onChange: (v) => {
        flag.when = v;
        state.dirty = true;
      },
    });
    condition.style.setProperty("min-inline-size", "360px");

    body.append(
      el(
        "tr",
        null,
        textCell(flag.id, { mono: true, disabled: !editable, onChange: (v) => { flag.id = v.trim(); state.dirty = true; } }),
        textCell(flag.severity, { disabled: !editable, onChange: (v) => { flag.severity = v.trim(); state.dirty = true; } }),
        textCell(flag.title, { disabled: !editable, onChange: (v) => { flag.title = v; state.dirty = true; } }),
        el("td", null, condition),
        el("td", { class: "w-name" }, issueSlot(`flag.${flag.id}`)),
      ),
    );
  }

  table.append(body);
  wrap.append(table);
  return el(
    "div",
    { class: "section" },
    sectionHead("Deal flags", "Deterministic conditions. These fire before any write-up and are handed to it as established fact."),
    wrap,
  );
}

function revisionSection(revisions) {
  if (!revisions.length) {
    return el("div", { class: "section" }, sectionHead("History"), empty("No revisions", "This model has not been edited since it was created."));
  }

  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "compact" } });
  const table = el("table", { class: "tbl" });
  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "num", scope: "col", text: "Version" }),
        el("th", { class: "w-date", scope: "col", text: "Saved" }),
        el("th", { class: "w-name", scope: "col", text: "Note" }),
      ),
    ),
  );
  const body = el("tbody");
  for (const revision of revisions) {
    body.append(
      el(
        "tr",
        null,
        el("td", { class: "num", text: `v${revision.version}` }),
        el("td", { class: "num", text: formatDateTime(revision.created_at) }),
        el("td", { class: "w-name", text: revision.note || "—" }),
      ),
    );
  }
  table.append(body);
  wrap.append(table);
  return el("div", { class: "section" }, sectionHead("History", `${revisions.length} revision${revisions.length === 1 ? "" : "s"}`), wrap);
}

// -------------------------------------------------------- validate and save --

let validateHandle = null;

function validate({ announce }) {
  if (validateHandle) clearTimeout(validateHandle);
  validateHandle = setTimeout(async () => {
    if (!state.definition) return;
    try {
      const payload = await API.models.validate(state.definition);
      state.issues = payload.issues || [];
      paintIssues();
      if (announce && payload.ok) {
        const rail = qs("#issue-rail");
        if (rail) rail.scrollIntoView({ block: "nearest" });
      }
    } catch (err) {
      state.issues = [{ level: "error", where: "model", message: err.message }];
      paintIssues();
    }
  }, announce ? 0 : 220);
}

async function saveModel(saveButton, noteInput) {
  if (!state.model || !state.model.editable) return;
  setLoading(saveButton, true, "Saving");
  try {
    await API.models.save(state.model.id, state.definition, noteInput.value.trim() || undefined);
    state.dirty = false;
    // Re-read the model so the version, the revision list and the canonical
    // definition all come from the server rather than from local optimism.
    await route();
  } catch (err) {
    setLoading(saveButton, false, "Save model");
    // 422 carries the validator's issues in `detail`, keyed by the same
    // `where` strings the inline slots are registered under.
    state.issues =
      err.status === 422 && Array.isArray(err.detail)
        ? err.detail
        : [{ level: "error", where: "model", message: err.message }];
    paintIssues();
    const rail = qs("#issue-rail");
    if (rail) rail.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
}

// -------------------------------------------------------------------- boot --

function paintRail() {
  const user = API.currentUser();
  const railUser = qs("#rail-user");
  const railOrg = qs("#rail-org");
  if (railUser && user) railUser.textContent = user.email;
  if (railOrg && user) railOrg.textContent = user.name;

  const navDeals = qs("#nav-deals");
  if (navDeals && !navDeals.querySelector("svg")) navDeals.prepend(icon("deals"));
  const navModels = qs("#nav-models");
  if (navModels && !navModels.querySelector("svg")) navModels.prepend(icon("models"));

  const signOut = qs("#sign-out");
  if (signOut) signOut.addEventListener("click", () => API.logout());
}

async function boot() {
  await API.requireSession();
  paintRail();
  window.addEventListener("hashchange", route);
  await route();
}

boot().catch((err) => {
  console.error(err);
  renderFailure(err);
});
