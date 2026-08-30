// The deal workspace.
//
// One page, client-side routed on location.hash, no framework and no bundler.
// Everything the user sees is built with createElement and textContent: deal
// names, filenames, extracted snippets and narrative prose are all written by
// somebody who is not us, and none of them ever touch innerHTML.

import * as API from "./api.js";
import { renderCollect } from "./collect-admin.js";
import { sensitivitySection } from "./sensitivity.js";
import { solverSection } from "./solver.js";
import {
  EM_DASH,
  areaFragment,
  coerceNumeric,
  countTarget,
  figureFragment,
  formatBytes,
  formatDate,
  formatDateTime,
  formatDurationMs,
  formatValue,
  parseNumeric,
} from "./format.js";
import {
  append,
  button,
  clear,
  dpair,
  el,
  empty,
  frag,
  gauge,
  icon,
  pagePlate,
  pill,
  qs,
  reducedMotion,
  replace,
  sectionHead,
  setLoading,
  sleep,
  tag,
} from "./ui.js";

// --------------------------------------------------------------------- state --

const state = {
  session: null,
  deals: [],
  models: [],
  filter: "",
  density: "default",
  newDealOpen: false,
  detail: null,
  result: null,
  resultError: null,
  narrative: null,
  runId: null,
  overrides: {},
  dd: new Set(),
  justExtracted: false,
  extractionSummaries: null,
  routeToken: 0,
};

const view = qs("#view");

const DUBAI_COMMUNITIES = [
  "Business Bay", "DIFC", "Downtown Dubai", "Dubai Marina", "Dubai Hills Estate",
  "Dubai South", "Jumeirah Village Circle", "Jumeirah Lake Towers", "Palm Jumeirah",
  "Al Quoz", "Deira", "Barsha Heights", "Motor City", "Arabian Ranches",
  "Dubai Silicon Oasis", "Dubai Investments Park", "Mirdif", "Al Furjan",
];

// `market` on a model is a key, not a display name.
const MARKET_LABELS = {
  AE: "AE · United Arab Emirates",
  US: "US · United States",
};

const TABS = [
  ["documents", "Documents"],
  ["review", "Review"],
  ["underwriting", "Underwriting"],
  ["analysis", "Analysis"],
  ["collect", "Collect"],
];

// ---------------------------------------------------------------- formatting --

function currency() {
  return (state.detail && state.detail.deal.currency) || "AED";
}

function fmt(value, format, precision) {
  return formatValue(value, format, currency(), precision);
}

function humanise(key) {
  if (!key) return EM_DASH;
  return String(key).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function figureHost(text, options = {}) {
  const host = el("span");
  host.append(figureFragment(text, options));
  return host;
}

function setFigure(host, text, options = {}) {
  clear(host);
  host.append(figureFragment(text, options));
}

function flash(node) {
  if (!node) return;
  node.classList.remove("cell--flash");
  // Force a reflow so a second edit re-plays the flash.
  void node.offsetWidth;
  node.classList.add("cell--flash");
  setTimeout(() => node.classList.remove("cell--flash"), 460);
}

// A registry of every on-screen figure that depends on a computed value, so a
// live preview can update all of them without rebuilding the page.
const live = {
  values: new Map(),
  projection: [],
  gauges: [],
  reset() {
    this.values.clear();
    this.projection = [];
    this.gauges = [];
  },
};

/**
 * Register a figure against a computed key. One key can drive several places on
 * the page at once — a summary metric appears both in the KPI band and in its
 * group's line table — so entries accumulate rather than replace.
 */
function registerLive(key, entry) {
  if (!key) return;
  const bucket = live.values.get(key);
  if (bucket) bucket.push(entry);
  else live.values.set(key, [entry]);
}

function liveFigure(key, value, format, precision, options = {}) {
  const text = fmt(value, format, precision);
  const host = figureHost(text, options);
  registerLive(key, { host, format, precision, options, last: text });
  return host;
}

function refreshLive(result) {
  if (!result) return;
  for (const [key, entries] of live.values) {
    for (const entry of entries) {
      const next = fmt(result.values[key], entry.format, entry.precision);
      if (next === entry.last) continue;
      entry.last = next;
      setFigure(entry.host, next, entry.options);
      flash(entry.host);
    }
  }

  if (result.projection) {
    const byKey = new Map(result.projection.rows.map((r) => [r.key, r]));
    for (const cell of live.projection) {
      const row = byKey.get(cell.key);
      if (!row) continue;
      const next = fmt(row.values[cell.year], cell.format, cell.precision);
      if (next === cell.last) continue;
      cell.last = next;
      setFigure(cell.host, next);
      flash(cell.host);
    }
  }

  const benchmarks = new Map((result.benchmarks || []).map((b) => [b.key, b]));
  for (const entry of live.gauges) {
    const benchmark = benchmarks.get(entry.key);
    if (!benchmark) continue;
    if (typeof entry.node.setValue === "function") entry.node.setValue(benchmark.value);
    const next = fmt(benchmark.value, entry.format, entry.precision);
    if (next !== entry.last) {
      entry.last = next;
      setFigure(entry.readout, next, { typeset: true });
    }
  }
}

// ------------------------------------------------------------------- routing --

function parseHash() {
  const raw = window.location.hash.replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] !== "deals" || parts.length === 0) return { name: "deals" };
  if (parts.length === 1) return { name: "deals" };
  const tab = TABS.some(([key]) => key === parts[2]) ? parts[2] : "documents";
  return { name: "deal", id: parts[1], tab };
}

function go(hash) {
  if (window.location.hash === hash) route();
  else window.location.hash = hash;
}

async function route() {
  const token = ++state.routeToken;
  const target = parseHash();

  markNav(target);

  try {
    if (target.name === "deals") {
      await showDeals(token);
    } else {
      await showDeal(token, target.id, target.tab);
    }
  } catch (err) {
    if (token !== state.routeToken) return;
    renderFailure(err);
  }
}

function markNav(target) {
  const navDeals = qs("#nav-deals");
  if (navDeals) navDeals.setAttribute("aria-current", target.name === "deals" ? "page" : "false");
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
        el("span", { class: "t-label c-3", text: "Meridian" }),
        el("h1", { class: "t-display-m", text: "Something did not load" }),
      ),
    ),
    el(
      "div",
      { class: "flag" },
      el("div", { class: "flag__title", text: "Error" }),
      el("p", { class: "flag__body", text: err && err.message ? err.message : String(err) }),
      el(
        "div",
        { class: "flag__meta" },
        button("Back to deals", { variant: "secondary", onClick: () => go("#/deals") }),
      ),
    ),
  );
}

// -------------------------------------------------------------- the deal list --

async function showDeals(token) {
  const payload = await API.deals.list();
  if (token !== state.routeToken) return;
  state.deals = payload.deals || [];
  document.title = "Deals — Meridian";
  renderDeals();
  updateDealCount();
}

function updateDealCount() {
  const node = qs("#nav-deal-count");
  if (node) node.textContent = String(state.deals.length);
}

function renderDeals() {
  const newDealButton = button("New deal", {
    variant: "primary",
    iconName: "plus",
    onClick: () => {
      state.newDealOpen = !state.newDealOpen;
      renderDeals();
    },
  });

  const head = el(
    "div",
    { class: "page-head" },
    el(
      "div",
      { class: "page-head__id" },
      el("span", { class: "t-label c-3", text: "Pipeline" }),
      el("h1", { class: "t-display-m", text: "Deals" }),
      el(
        "div",
        { class: "page-head__meta t-caption" },
        el("span", { text: `${state.deals.length} deal${state.deals.length === 1 ? "" : "s"}` }),
        el("span", { text: `${state.models.length} underwriting model${state.models.length === 1 ? "" : "s"}` }),
      ),
    ),
    el("div", { class: "page-head__actions no-print" }, newDealButton),
  );

  replace(
    view,
    head,
    state.newDealOpen ? newDealForm() : null,
    dealToolbar(),
    dealTable(),
  );
}

function newDealForm() {
  const markets = distinct(state.models.map((m) => m.market)).sort();
  const assetTypes = distinct(state.models.map((m) => m.assetType)).sort();
  const depths = distinct(state.models.map((m) => m.depth));

  const name = el("input", { class: "input", id: "nd-name", type: "text", required: true, placeholder: "Marina Gate II — Tower A" });
  const community = el("input", { class: "input", id: "nd-community", type: "text", list: "nd-communities", placeholder: "Business Bay" });
  const communityList = el(
    "datalist",
    { id: "nd-communities" },
    DUBAI_COMMUNITIES.map((c) => el("option", { value: c })),
  );

  const assetSelect = selectField("nd-asset", assetTypes.map((a) => [a, humanise(a)]));
  const marketSelect = selectField("nd-market", markets.map((m) => [m, MARKET_LABELS[m] || m]));
  const depthSelect = selectField(
    "nd-depth",
    (depths.length ? depths : ["quick", "full"]).map((d) => [d, d === "quick" ? "Quick screen" : "Full underwriting"]),
  );
  const tenureSelect = selectField("nd-tenure", [["freehold", "Freehold"], ["leasehold", "Leasehold"]]);

  // Sensible openings rather than whatever sorts first.
  if (assetTypes.includes("residential")) assetSelect.control.value = "residential";
  if (markets.includes("AE")) marketSelect.control.value = "AE";
  if (depths.includes("quick")) depthSelect.control.value = "quick";

  const errorLine = el("p", { class: "f__error", hidden: true, role: "alert" });
  const submit = button("Create deal", { variant: "primary", type: "submit" });

  const form = el(
    "form",
    {
      class: "plate plate--pad no-print",
      on: {
        submit: async (event) => {
          event.preventDefault();
          errorLine.hidden = true;
          const dealName = name.value.trim();
          if (!dealName) {
            errorLine.textContent = "Give the deal a name.";
            errorLine.hidden = false;
            name.focus();
            return;
          }

          const market = marketSelect.control.value;
          const assetType = assetSelect.control.value;
          const depth = depthSelect.control.value;
          const model = pickModel({ market, assetType, depth });

          setLoading(submit, true, "Creating");
          try {
            const payload = await API.deals.create({
              name: dealName,
              community: community.value.trim() || null,
              city: "Dubai",
              assetType,
              tenure: tenureSelect.control.value,
              market,
              depth,
              currency: (model && model.currency) || "AED",
              modelId: model ? model.id : undefined,
            });
            state.newDealOpen = false;
            go(`#/deals/${payload.deal.id}/documents`);
          } catch (err) {
            setLoading(submit, false, "Create deal");
            errorLine.textContent = err.message;
            errorLine.hidden = false;
          }
        },
      },
    },
    sectionHead("New deal", "The model is chosen from your library to match the market, asset type and depth."),
    el(
      "div",
      { class: "grid grid--tight" },
      fieldCell("col-4", "Deal name", name, "nd-name"),
      fieldCell("col-4", "Community", community, "nd-community"),
      fieldCell("col-4", "Asset type", assetSelect.node, "nd-asset"),
      fieldCell("col-4", "Market", marketSelect.node, "nd-market"),
      fieldCell("col-4", "Tenure", tenureSelect.node, "nd-tenure"),
      fieldCell("col-4", "Depth", depthSelect.node, "nd-depth"),
    ),
    communityList,
    errorLine,
    el(
      "div",
      { class: "row row--8", css: { "margin-block-start": "var(--s-16)" } },
      submit,
      button("Cancel", {
        variant: "ghost",
        onClick: () => {
          state.newDealOpen = false;
          renderDeals();
        },
      }),
    ),
  );

  requestAnimationFrame(() => name.focus());
  return form;
}

function fieldCell(colClass, label, control, htmlFor) {
  return el(
    "div",
    { class: `${colClass} f` },
    el("label", { class: "f__label", for: htmlFor, text: label }),
    control,
  );
}

function selectField(id, options) {
  const control = el(
    "select",
    { id },
    options.map(([value, label]) => el("option", { value, text: label })),
  );
  const node = el("div", { class: "select" }, control, iconCaret());
  return { node, control };
}

function iconCaret() {
  const svgNode = icon("caret");
  svgNode.setAttribute("class", "select__caret");
  return svgNode;
}

function distinct(list) {
  return [...new Set(list.filter(Boolean))];
}

function pickModel({ market, assetType, depth }) {
  const pool = state.models;
  return (
    pool.find((m) => m.market === market && m.assetType === assetType && m.depth === depth) ||
    pool.find((m) => m.market === market && m.depth === depth) ||
    pool.find((m) => m.market === market) ||
    pool.find((m) => m.depth === depth) ||
    pool[0] ||
    null
  );
}

function dealToolbar() {
  const search = el("input", {
    class: "input",
    type: "search",
    placeholder: "Filter by name or community",
    value: state.filter,
    "aria-label": "Filter deals",
    css: { "max-inline-size": "280px" },
    on: {
      input: (event) => {
        state.filter = event.target.value;
        const wrap = qs("#deal-table-wrap");
        if (wrap) wrap.replaceWith(dealTable());
      },
    },
  });

  const density = el(
    "div",
    { class: "segmented", role: "group", "aria-label": "Row density" },
    ["compact", "default", "comfortable"].map((mode) =>
      el("button", {
        type: "button",
        text: mode === "default" ? "normal" : mode,
        "aria-pressed": state.density === mode ? "true" : "false",
        on: {
          click: () => {
            state.density = mode;
            renderDeals();
          },
        },
      }),
    ),
  );

  return el("div", { class: "toolbar no-print" }, search, el("div", { class: "spacer" }), density);
}

function filteredDeals() {
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.deals;
  return state.deals.filter(
    (d) =>
      (d.name || "").toLowerCase().includes(needle) ||
      (d.community || "").toLowerCase().includes(needle),
  );
}

const STATUS_TONE = {
  draft: "neu",
  extracted: "neu",
  underwritten: "pos",
  passed: "neg",
  committed: "pos",
};

function dealTable() {
  const rows = filteredDeals();

  const wrap = el("div", {
    id: "deal-table-wrap",
    class: "tbl-wrap",
    dataset: { density: state.density },
  });

  if (!rows.length) {
    wrap.classList.remove("tbl-wrap");
    wrap.append(
      empty(
        state.filter ? "No match" : "No deals yet",
        state.filter
          ? "Nothing in the pipeline matches that filter."
          : "Create a deal, drop in the offering memorandum, rent roll and T12, and run extraction.",
      ),
    );
    return wrap;
  }

  const table = el(
    "table",
    { class: "tbl" },
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-name", scope: "col", text: "Deal" }),
        el("th", { class: "w-tag", scope: "col", text: "Community" }),
        el("th", { class: "w-tag", scope: "col", text: "Asset type" }),
        el("th", { class: "num w-money", scope: "col", text: "Price / sqft" }),
        el("th", { class: "num w-pct", scope: "col", text: "Gross yield" }),
        el("th", { class: "num w-pct", scope: "col", text: "Net yield" }),
        el("th", { class: "num w-pct", scope: "col", text: "DSCR" }),
        el("th", { class: "w-tag", scope: "col", text: "Status" }),
        el("th", { class: "w-date", scope: "col", text: "Updated" }),
      ),
    ),
  );

  const body = el("tbody");
  for (const deal of rows) {
    const metrics = deal.metrics || {};
    const cur = deal.currency || "AED";

    const nameCell = el(
      "td",
      { class: "w-name" },
      el("a", {
        href: `#/deals/${deal.id}/documents`,
        text: deal.name,
        class: "u-truncate",
      }),
    );

    const numeric = (value, format, precision) => {
      const cell = el("td", { class: "num" });
      cell.append(figureFragment(formatValue(value ?? null, format, cur, precision)));
      return cell;
    };

    body.append(
      el(
        "tr",
        null,
        nameCell,
        el("td", { text: deal.community || EM_DASH }),
        el("td", { text: deal.assetType ? humanise(deal.assetType) : EM_DASH }),
        numeric(metrics.pricePerSqft, "per_sqft"),
        numeric(metrics.grossYield, "percent"),
        numeric(metrics.netYield, "percent"),
        numeric(metrics.dscr, "multiple"),
        el("td", null, pill(String(deal.status || "draft").toUpperCase(), STATUS_TONE[deal.status] || "neu")),
        el("td", { class: "num", text: formatDate(deal.updatedAt) }),
      ),
    );
  }

  table.append(body);
  wrap.append(table);
  return wrap;
}

// ------------------------------------------------------------- the workspace --

async function showDeal(token, id, tab) {
  const detail = await API.deals.get(id);
  if (token !== state.routeToken) return;

  state.detail = detail;
  state.narrative = detail.narrative;
  state.runId = detail.run ? detail.run.id : null;
  state.overrides = {};
  state.result = null;
  state.resultError = null;
  if (!state.justExtracted) state.extractionSummaries = null;
  document.title = `${detail.deal.name} — Meridian`;

  // A deal created before its market had a model, or one whose model was
  // deleted, is silently repaired here rather than failing at the first run.
  if (!detail.deal.modelId) {
    const model = pickModel({
      market: detail.deal.market,
      assetType: detail.deal.assetType,
      depth: detail.deal.depth,
    });
    if (model) {
      try {
        const updated = await API.deals.update(id, { modelId: model.id });
        detail.deal.modelId = updated.deal.modelId;
      } catch {
        /* Surfaced below as a missing-model notice. */
      }
    }
  }

  restoreDd();
  await refreshResult({ silent: true });
  if (token !== state.routeToken) return;

  renderDeal(tab);
}

async function refreshResult({ overrides, depth, modelId, silent } = {}) {
  const deal = state.detail && state.detail.deal;
  if (!deal || !deal.modelId) {
    state.resultError = "This deal has no underwriting model selected.";
    return null;
  }
  try {
    const payload = await API.deals.preview(deal.id, {
      overrides: overrides || state.overrides,
      depth: depth || deal.depth,
      modelId: modelId || deal.modelId,
    });
    state.result = payload.result;
    state.resultError = null;
    return payload.result;
  } catch (err) {
    state.resultError = err.message;
    if (!silent) throw err;
    return null;
  }
}

function renderDeal(tab) {
  const deal = state.detail.deal;
  live.reset();

  const head = el(
    "div",
    { class: "page-head" },
    el(
      "div",
      { class: "page-head__id" },
      el(
        "a",
        { class: "t-label c-3 row row--8", href: "#/deals" },
        icon("back"),
        el("span", { text: "All deals" }),
      ),
      el("h1", { class: "t-display-m u-truncate", text: deal.name }),
      el(
        "div",
        { class: "page-head__meta t-caption" },
        el("span", { text: deal.community || "Community not set" }),
        el("span", { text: humanise(deal.assetType) }),
        el("span", { text: deal.tenure ? humanise(deal.tenure) : "Tenure not set" }),
        el("span", { text: deal.currency }),
        el("span", { text: `Updated ${formatDate(deal.updatedAt)}` }),
      ),
    ),
    el(
      "div",
      { class: "page-head__actions no-print" },
      pill(String(deal.status || "draft").toUpperCase(), STATUS_TONE[deal.status] || "neu"),
      exportMenu(deal.id, Boolean(state.runId)),
      button("Print IC pack", { variant: "secondary", iconName: "print", onClick: () => window.print() }),
    ),
  );

  const panel = el("div", { id: "tabpanel" });

  replace(view, head, tabBar(deal.id, tab), panel);
  renderTab(tab, panel);
}

/**
 * The export menu. These are authenticated GET downloads, so they are triggered
 * by navigation on an <a download> and never by fetch — the browser carries the
 * session cookie, reads the Content-Disposition filename the server built, and
 * writes the file itself. Pulling the bytes through fetch would mean rebuilding
 * all of that in JavaScript and getting the filename wrong.
 *
 * Both endpoints export the LATEST PERSISTED RUN, so an un-underwritten deal has
 * nothing to export and the items say so rather than downloading an error page.
 */
function exportMenu(dealId, hasRun) {
  const base = `/api/deals/${encodeURIComponent(dealId)}/export`;

  const item = (label, href, note) =>
    el(
      "a",
      { class: "exp__item", href, download: true, role: "menuitem" },
      el("span", { text: label }),
      el("span", { class: "exp__note t-micro", text: note }),
    );

  const menu = el(
    "div",
    { class: "exp__menu overlay", role: "menu", hidden: true },
    hasRun
      ? frag(
          item("Excel workbook", `${base}.xlsx`, "xlsx · 8 sheets"),
          item("Flat CSV", `${base}.csv`, "csv · one row per line"),
        )
      : el("div", { class: "exp__empty t-caption c-3" }, el(
          "span",
          { text: "Run the underwriting first — an export reproduces the numbers that were signed off." },
        )),
  );

  const trigger = button("Export", { variant: "secondary", iconName: "open" });
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  const wrap = el("div", { class: "exp no-print" }, trigger, menu);

  const onDocument = (event) => {
    if (event.type === "keydown" && event.key !== "Escape") return;
    if (event.type === "pointerdown" && wrap.contains(event.target)) return;
    close();
  };

  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocument, true);
    document.removeEventListener("keydown", onDocument, true);
  }

  trigger.addEventListener("click", () => {
    if (!menu.hidden) {
      close();
      return;
    }
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDocument, true);
    document.addEventListener("keydown", onDocument, true);
  });

  // A download navigates, so the menu is dismissed on its way out.
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });

  return wrap;
}

function tabBar(dealId, active) {
  return el(
    "div",
    { class: "segmented no-print", role: "tablist", "aria-label": "Deal sections", css: { "margin-block-end": "var(--s-24)" } },
    TABS.map(([key, label]) =>
      el("button", {
        type: "button",
        role: "tab",
        text: label,
        "aria-pressed": key === active ? "true" : "false",
        "aria-selected": key === active ? "true" : "false",
        on: { click: () => go(`#/deals/${dealId}/${key}`) },
      }),
    ),
  );
}

function renderTab(tab, panel) {
  live.reset();
  clear(panel);
  if (tab === "documents") renderDocuments(panel);
  else if (tab === "review") renderReview(panel);
  else if (tab === "underwriting") renderUnderwriting(panel);
  else if (tab === "collect") renderCollect(panel, collectContext());
  else renderAnalysis(panel);
}

/** What the analysis panels need: the deal, its model, and the current run. */
function analysisContext() {
  const deal = state.detail.deal;
  return {
    dealId: deal.id,
    currency: deal.currency || "AED",
    depth: deal.depth,
    modelId: deal.modelId,
    result: state.result,
  };
}

function collectContext() {
  const deal = state.detail.deal;
  return {
    dealId: deal.id,
    assetType: deal.assetType,
    documents: state.detail.documents || [],
  };
}

// ---------------------------------------------------------------- documents --

const SLOTS = [
  { kind: "om", label: "Offering Memorandum", hint: "PDF or DOCX · the seller's claims" },
  { kind: "rent_roll", label: "Rent Roll", hint: "XLSX or CSV · unit-level rents" },
  { kind: "t12", label: "T12", hint: "XLSX or CSV · trailing twelve months" },
];

function renderDocuments(panel) {
  const deal = state.detail.deal;
  const documents = state.detail.documents || [];
  const scanned = documents.filter((d) => d.isScanned);

  const bank = el("div", { class: "dropbank" }, SLOTS.map((slot) => dropSlot(slot, documents)));

  const extractButton = button("Run extraction", {
    variant: "primary",
    iconName: "scan",
    disabled: documents.length === 0,
    onClick: () => runExtraction(deal.id, panel),
  });

  const notices = el("div", { class: "flag-stack" });
  if (scanned.length) {
    notices.append(
      el(
        "div",
        { class: "flag flag--caution flag--in", css: { "--i": "0" } },
        el("div", { class: "flag__title", text: "Scanned document" }),
        el("p", {
          class: "flag__body",
          text:
            `${scanned.length} uploaded file${scanned.length === 1 ? " has" : "s have"} no extractable text layer. ` +
            "Extraction will find little or nothing in it. Ask the seller for the native file, or re-run OCR before relying on any figure taken from it.",
        }),
        el("div", { class: "flag__meta", text: scanned.map((d) => d.filename).join(" · ") }),
      ),
    );
  }
  if (!API.capabilities().aiExtraction) {
    notices.append(
      el(
        "div",
        { class: "flag flag--dd flag--in", css: { "--i": "1" } },
        el("div", { class: "flag__title", text: "Extraction is not configured" }),
        el("p", {
          class: "flag__body",
          text:
            "This server has no extraction key. Documents are still stored, parsed and paginated, but no figures are " +
            "pulled out of them automatically. Enter the numbers on the Review tab — the model's own defaults are " +
            "already in place, and every one of them is editable.",
        }),
      ),
    );
  }

  append(
    panel,
    el("div", { class: "section" }, sectionHead("Source documents", "Drop a file on a slot, or choose one."), bank),
    documents.length
      ? el("div", { class: "section" }, sectionHead("Uploaded", `${documents.length} file${documents.length === 1 ? "" : "s"}`), documentList(documents))
      : null,
    notices.childElementCount ? el("div", { class: "section" }, notices) : null,
    el(
      "div",
      { class: "section no-print" },
      sectionHead("Extraction", "Reads every document, writes the fields, and reconciles the rent roll against the T12."),
      el("div", { class: "row row--12 row--wrap" }, extractButton, extractionHistory()),
    ),
  );
}

function dropSlot(slot, documents) {
  const existing = documents.filter((d) => d.kind === slot.kind);
  const input = el("input", {
    type: "file",
    id: `file-${slot.kind}`,
    class: "visually-hidden",
    multiple: true,
    accept: ".pdf,.docx,.xlsx,.xls,.csv,.txt",
    on: {
      change: (event) => {
        const files = [...event.target.files];
        event.target.value = "";
        if (files.length) upload(slot.kind, files);
      },
    },
  });

  const node = el(
    "div",
    {
      class: `drop${existing.length ? " drop--filled" : ""}`,
      on: {
        click: (event) => {
          if (event.target.tagName !== "BUTTON") input.click();
        },
        dragover: (event) => {
          event.preventDefault();
          node.classList.add("drop--over");
        },
        dragleave: () => node.classList.remove("drop--over"),
        drop: (event) => {
          event.preventDefault();
          node.classList.remove("drop--over");
          const files = [...(event.dataTransfer ? event.dataTransfer.files : [])];
          if (files.length) upload(slot.kind, files);
        },
      },
    },
    (() => {
      const glyph = icon(existing.length ? "file" : "upload");
      glyph.setAttribute("class", "drop__glyph");
      return glyph;
    })(),
    el("div", { class: "drop__slot", text: slot.label }),
    existing.length
      ? frag(existing.map((d) => el("div", { class: "drop__file", text: d.filename })))
      : el("div", { class: "drop__hint", text: slot.hint }),
    input,
  );

  return node;
}

async function upload(kind, files) {
  const deal = state.detail.deal;
  const form = new FormData();
  for (const file of files) form.append(kind, file, file.name);

  const panel = qs("#tabpanel");
  const banner = el(
    "div",
    { class: "flag flag--dd" },
    el("div", { class: "flag__title", text: "Uploading" }),
    el("p", { class: "flag__body", text: files.map((f) => f.name).join(" · ") }),
  );
  if (panel) panel.prepend(banner);

  try {
    const payload = await API.deals.uploadDocuments(deal.id, form);
    const detail = await API.deals.get(deal.id);
    state.detail = detail;
    const target = qs("#tabpanel");
    if (target) {
      renderTab("documents", target);
      if (payload.warnings && payload.warnings.length) {
        target.prepend(
          el(
            "div",
            { class: "flag flag--caution" },
            el("div", { class: "flag__title", text: "Upload notes" }),
            el("ul", { class: "flag__body" }, payload.warnings.map((w) => el("li", { text: w }))),
          ),
        );
      }
    }
  } catch (err) {
    banner.className = "flag";
    replace(
      banner,
      el("div", { class: "flag__title", text: "Upload failed" }),
      el("p", { class: "flag__body", text: err.message }),
    );
  }
}

function documentList(documents) {
  return el(
    "div",
    { class: "stack stack--8" },
    documents.map((doc) => {
      const meta = [];
      if (doc.pageCount) meta.push(`${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`);
      if (doc.sheetCount) meta.push(`${doc.sheetCount} sheet${doc.sheetCount === 1 ? "" : "s"}`);
      if (doc.detectedType) meta.push(doc.detectedType);

      return el(
        "div",
        { class: "fileplate" },
        icon("file"),
        el("span", { class: "fileplate__name u-truncate", text: doc.filename }),
        tag(String(doc.kind || "auto").replace(/_/g, " "), doc.kindSource === "detected" ? "accent" : undefined),
        doc.isScanned ? tag("Scanned", "manual") : null,
        meta.length ? el("span", { class: "fileplate__size", text: meta.join(" · ") }) : null,
        el("span", { class: "fileplate__size", text: formatBytes(doc.bytes) }),
        el(
          "a",
          { class: "field__action", href: `/api/documents/${encodeURIComponent(doc.id)}/file`, target: "_blank", rel: "noopener", "aria-label": `Open ${doc.filename}` },
          icon("open"),
        ),
        el(
          "button",
          {
            class: "field__action no-print",
            type: "button",
            "aria-label": `Remove ${doc.filename}`,
            on: {
              click: async () => {
                await API.deals.deleteDocument(doc.id);
                state.detail = await API.deals.get(state.detail.deal.id);
                const target = qs("#tabpanel");
                if (target) renderTab("documents", target);
              },
            },
          },
          icon("trash"),
        ),
      );
    }),
  );
}

function extractionHistory() {
  const runs = state.detail.extractions || [];
  if (!runs.length) return null;
  const last = runs[0];
  return el(
    "div",
    { class: "row row--8 t-micro c-3" },
    el("span", { text: `Last pass ${formatDateTime(last.created_at)}` }),
    tag(last.engine || "rules"),
    last.duration_ms ? el("span", { text: formatDurationMs(last.duration_ms) }) : null,
    last.status && last.status !== "ok" ? tag(last.status, "manual") : null,
  );
}

// -------------------------------------------------------- extraction sequence --

const EX_FLOOR_MS = 4200;
const EX_SCAN_START = 640;
const EX_SCAN_DUR = 2400;
const EX_LATCH_START = 900;
const EX_LATCH_STEP = 180;
const EX_STAGE_H = 360;

const EX_STAGES = [
  ["Ingest", 0, 460],
  ["Segment", 460, 640],
  ["Read", 1100, 1800],
  ["Reconcile", 2900, 700],
  ["Validate", 3600, 600],
];

function buildExtractionStage(documents) {
  const container = el("div", { class: "extract" });
  container.style.setProperty("--pp-h", `${EX_STAGE_H}px`);
  container.style.setProperty("--scan-start", `${EX_SCAN_START}ms`);
  container.style.setProperty("--scan-dur", `${EX_SCAN_DUR}ms`);
  container.style.setProperty("--latch-start", `${EX_LATCH_START}ms`);
  container.style.setProperty("--latch-step", `${EX_LATCH_STEP}ms`);
  container.style.setProperty("--floor", `${EX_FLOOR_MS}ms`);

  const plates = el(
    "div",
    { class: "ex-plates" },
    (documents.length ? documents : [{ filename: "No document", bytes: 0 }]).slice(0, 3).map((doc, i) =>
      el(
        "div",
        { class: "fileplate", css: { "--i": String(i) } },
        icon("file"),
        el("span", { class: "fileplate__name u-truncate", text: doc.filename }),
        el("span", { class: "fileplate__size", text: formatBytes(doc.bytes) }),
      ),
    ),
  );

  const percent = el("span", { class: "stage-read__pct", text: "0%" });
  const readout = el(
    "div",
    { class: "stage-read" },
    el("span", { class: "t-label c-2", text: "Reading the documents" }),
    percent,
  );

  const rail = el(
    "div",
    { class: "stage-rail" },
    EX_STAGES.map(([label, from, dur]) =>
      el(
        "div",
        { class: "stage", css: { "--from": `${from}ms`, "--dur": `${dur}ms` } },
        el("div", { class: "stage__label", text: label }),
        el("div", { class: "stage__track" }, el("div", { class: "stage__fill" })),
      ),
    ),
  );

  const totalPages = documents.reduce((sum, d) => sum + (d.pageCount || d.sheetCount || 1), 0) || 1;
  const counter = el("div", { class: "pp-counter", text: `PAGE 1 / ${totalPages}` });

  const stage = el("div", { class: "pp-stage" }, pagePlate({
    scanStartMs: EX_SCAN_START,
    scanDurMs: EX_SCAN_DUR,
    stageH: EX_STAGE_H,
    padTop: 16,
  }), scanLine(EX_SCAN_START), counter);
  stage.style.setProperty("block-size", `${EX_STAGE_H}px`);

  const latchList = el("div", { class: "latch-list" });
  const latchHost = el(
    "div",
    { class: "stack stack--12" },
    el("div", { class: "t-label c-3", text: "Values found" }),
    latchList,
  );

  container.append(plates, readout, rail, el("div", { class: "ex-split" }, stage, latchHost));

  const controller = {
    node: container,
    startedAt: 0,
    floor: EX_FLOOR_MS,
    running: false,
    timer: null,
    latched: false,

    start() {
      this.startedAt = performance.now();
      this.running = true;
      this.pending = true;
      // Force a style flush so the animations start from the inserted state,
      // rather than deferring to requestAnimationFrame — which never fires
      // while the tab is backgrounded, and would leave the sequence frozen.
      void container.offsetWidth;
      container.classList.add("ex--run");
      this.timer = setInterval(() => this.tick(totalPages, percent, counter, stage), 90);
    },

    elapsed() {
      return performance.now() - this.startedAt;
    },

    tick(pages, pctNode, counterNode, stageNode) {
      const t = this.elapsed();
      pctNode.textContent = `${Math.min(100, Math.round((t / this.floor) * 100))}%`;

      const scanProgress = Math.max(0, Math.min(1, (t - EX_SCAN_START) / EX_SCAN_DUR));
      const page = Math.min(pages, Math.max(1, Math.ceil(scanProgress * pages) || 1));
      counterNode.textContent = `PAGE ${page} / ${pages}`;

      if (!this.pending) return;

      // The API is slower than the pass: advance the counter and re-scan,
      // rather than freezing on a finished animation.
      const scanEnd = EX_SCAN_START + EX_SCAN_DUR;
      if (t > scanEnd + 120 && t - (this.lastRescan || 0) > EX_SCAN_DUR) {
        this.lastRescan = t;
        const fresh = scanLine(0);
        const old = stageNode.querySelector(".scan");
        if (old) old.replaceWith(fresh);
      }
      // Keep the exit beyond the horizon while there is still work to do.
      if (t > this.floor - 900) {
        this.floor += 1500;
        container.style.setProperty("--floor", `${this.floor}ms`);
      }
    },

    settle() {
      this.pending = false;
    },

    latch(items) {
      if (this.latched) return;
      this.latched = true;
      const offset = Math.max(0, EX_LATCH_START - this.elapsed());
      latchList.style.setProperty("--latch-start", `${Math.round(offset)}ms`);
      for (const [index, item] of items.entries()) {
        latchList.append(
          el(
            "div",
            { class: "latch", css: { "--i": String(index) } },
            el("span", { class: "latch__k", text: item.label }),
            el(
              "span",
              { class: "latch__slot" },
              el("span", { class: "latch__caret" }),
              el("span", { class: "latch__v", text: item.value }),
            ),
          ),
        );
      }
    },

    stop() {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      percent.textContent = "100%";
    },
  };

  return controller;
}

function scanLine(startMs) {
  const node = el("div", { class: "scan" });
  node.style.setProperty("--scan-start", `${startMs}ms`);
  return node;
}

function fieldsToLatch(fields) {
  return (fields || [])
    .filter((f) => f.value !== null && f.value !== undefined && f.value !== "")
    .slice(0, 12)
    .map((f) => ({
      label: humanise(f.key),
      value: formatFieldValue(f),
    }));
}

function formatFieldValue(field, cur) {
  const unit = (field.unit || "").toLowerCase();
  const key = field.key || "";
  const raw = field.value;
  if (raw === null || raw === undefined || raw === "") return EM_DASH;
  const value = coerceNumeric(raw);
  if (value === null) return String(raw);
  const money = cur || currency();
  if (unit === "aed" || unit === "usd" || unit === money.toLowerCase()) {
    return formatValue(value, "currency", money);
  }
  if (unit.includes("/sqft")) return formatValue(value, "per_sqft", money);
  if (unit === "%" || unit === "pct" || /_(pct|rate)$/.test(key)) return formatValue(value, "percent", money);
  if (unit === "sqft") return `${formatValue(value, "integer", money)} sqft`;
  if (unit) return `${formatValue(value, Number.isInteger(value) ? "integer" : undefined, money)} ${field.unit}`;
  return formatValue(value, Number.isInteger(value) ? "integer" : undefined, money);
}

async function runExtraction(dealId, panel) {
  // A sequence that is still running when the user navigates away must not
  // drag them back to a deal they have left.
  const token = state.routeToken;
  const sequence = buildExtractionStage(state.detail.documents || []);
  replace(panel, sequence.node);
  sequence.start();

  const request = API.deals.extract(dealId);
  request
    .then((payload) => sequence.latch(fieldsToLatch(payload.fields)))
    .catch(() => sequence.latch([]));

  let payload = null;
  let failure = null;
  try {
    payload = await request;
  } catch (err) {
    failure = err;
  }

  // The work is done, so stop extending the horizon — but the sequence keeps
  // running to its floor. An instant result reads as a lookup, not as an
  // analysis, and a reviewer who sees a lookup stops trusting the numbers.
  sequence.settle();
  await sleep(Math.max(0, sequence.floor + 460 - sequence.elapsed()));
  sequence.stop();

  if (token !== state.routeToken) return;

  if (failure) {
    replace(
      panel,
      el(
        "div",
        { class: "flag" },
        el("div", { class: "flag__title", text: "Extraction failed" }),
        el("p", { class: "flag__body", text: failure.message }),
      ),
    );
    const back = button("Back to documents", {
      variant: "secondary",
      onClick: () => renderTab("documents", panel),
    });
    panel.append(el("div", { css: { "margin-block-start": "var(--s-16)" } }, back));
    return;
  }

  state.extractionSummaries = payload.summaries || [];
  state.detail = await API.deals.get(dealId);
  await refreshResult({ silent: true });
  state.justExtracted = true;
  go(`#/deals/${dealId}/review`);
}

// ------------------------------------------------------------------- review --

function confidenceBand(input) {
  if (input.origin === "user") return "manual";
  if (input.origin === "missing" || input.value === null || input.value === undefined) return "missing";
  const c = typeof input.confidence === "number" ? input.confidence : null;
  if (input.origin === "default") return "default";
  if (c === null) return "high";
  if (c >= 0.8) return "high";
  if (c >= 0.55) return "medium";
  return "low";
}

const BAND_ORDER = { missing: 0, low: 1, default: 2, medium: 3, high: 4, manual: 5 };

function renderReview(panel) {
  const result = state.result;

  if (!result) {
    panel.append(
      empty(
        "Nothing to review yet",
        state.resultError || "Upload the documents and run extraction first.",
        button("Go to documents", { variant: "primary", onClick: () => go(`#/deals/${state.detail.deal.id}/documents`) }),
      ),
    );
    return;
  }

  const host = state.justExtracted ? el("div", { class: "extract ex--run" }) : null;
  if (host) host.style.setProperty("--floor", "0ms");
  const body = host ? el("div", { class: "ex-exit" }) : el("div");
  if (host) {
    host.append(body);
    panel.append(host);
  } else {
    panel.append(body);
  }
  state.justExtracted = false;

  if (state.extractionSummaries && state.extractionSummaries.length) {
    body.append(el("div", { class: "section" }, sectionHead("Extraction pass"), summaryStrip(state.extractionSummaries)));
  }

  const inputs = (result.inputs || []).filter((i) => !i.hidden);
  const groups = new Map();
  for (const input of inputs) {
    const key = input.group || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(input);
  }

  const ordered = [...groups.entries()]
    .map(([name, rows]) => {
      rows.sort((a, b) => BAND_ORDER[confidenceBand(a)] - BAND_ORDER[confidenceBand(b)]);
      const worst = Math.min(...rows.map((r) => BAND_ORDER[confidenceBand(r)]));
      return { name, rows, worst };
    })
    .sort((a, b) => a.worst - b.worst);

  const attention = inputs.filter((i) => BAND_ORDER[confidenceBand(i)] <= 1).length;
  const defaults = inputs.filter((i) => confidenceBand(i) === "default").length;

  const ledgerNote = attention
    ? `${attention} field${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} your eye — sorted to the top`
    : defaults
      ? `${defaults} field${defaults === 1 ? " is" : "s are"} running on a model default — confirm or overwrite`
      : "Every field carries a confident reading";

  body.append(
    el(
      "div",
      { class: "section" },
      sectionHead("Extracted fields", ledgerNote),
      el("div", { class: "stack stack--24" }, ordered.map((group) => ledgerFor(group.name, group.rows))),
    ),
  );

  const units = state.detail.units || [];
  if (units.length) {
    body.append(el("div", { class: "section" }, sectionHead("Rent roll", `${units.length} unit${units.length === 1 ? "" : "s"}`), rentRollTable(units)));
  }

  const t12 = state.detail.t12 || [];
  if (t12.length) {
    body.append(el("div", { class: "section" }, sectionHead("T12", `${t12.length} line${t12.length === 1 ? "" : "s"}`), t12Table(t12)));
  }

  if (!units.length && !t12.length) {
    body.append(
      el(
        "div",
        { class: "section" },
        sectionHead("Rent roll and T12"),
        empty(
          "No unit or expense detail",
          "Extraction did not find a rent roll or a trailing-twelve statement. The model is running on the single-value fields above.",
        ),
      ),
    );
  }
}

function summaryStrip(summaries) {
  return el(
    "div",
    { class: "stack stack--8" },
    summaries.map((s) =>
      el(
        "div",
        { class: "fileplate" },
        icon("file"),
        el("span", { class: "fileplate__name u-truncate", text: s.filename }),
        tag(String(s.kind || "").replace(/_/g, " ")),
        tag(s.engine || "rules", s.ok ? undefined : "manual"),
        el("span", { class: "fileplate__size", text: `${s.fieldCount} fields · ${s.unitCount} units · ${s.t12Count} lines` }),
        el("span", { class: "fileplate__size", text: formatDurationMs(s.durationMs) }),
      ),
    ),
  );
}

function ledgerFor(groupName, rows) {
  const ledger = el(
    "div",
    { class: "ledger" },
    el(
      "div",
      { class: "ledger__head" },
      el("span", { class: "t-label", text: groupName }),
      el("span", { class: "t-label u-end", text: "Value" }),
      el("span", { class: "t-label u-end", text: "Conf" }),
      el("span"),
    ),
  );
  for (const input of rows) ledger.append(fieldRow(input));
  return ledger;
}

function rawEditable(input) {
  const value = input.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (input.type === "percent") return String(Number((value * 100).toFixed(6)));
    return String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function displayValue(input) {
  const value = input.value;
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (input.format) return fmt(value, input.format, input.precision);
  if (input.type === "currency") return fmt(value, "currency");
  if (input.type === "percent") return fmt(value, "percent");
  if (input.type === "integer") return fmt(value, "integer");
  // A count of units or a size in square feet is a whole number and should
  // read as one; only a genuinely fractional figure earns its decimals.
  return fmt(value, "number", Number.isInteger(value) ? 0 : 2);
}

/**
 * The currency is already a prefix on the value, so repeating it as a unit
 * chip would render "AED 2,200,000 AED".
 */
function unitSuffix(input) {
  if (!input.unit) return null;
  if (input.type === "currency" && input.unit.toUpperCase() === currency()) return null;
  if (input.type === "percent" && (input.unit === "%" || input.unit.toLowerCase() === "pct")) return null;
  return input.unit;
}

function parseInputValue(raw, type) {
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === EM_DASH) return null;
  if (type === "boolean") return /^(y|yes|true|1)$/i.test(trimmed);
  if (type === "text" || type === "select" || type === "date") return trimmed;
  return parseNumeric(trimmed, type);
}

/**
 * One ledger row. Confidence is ink density, never a percentage in a pill; the
 * citation lives in reserved space so hovering never reflows the ledger.
 */
function fieldRow(input, options = {}) {
  const band = confidenceBand(input);
  // A model default is not a reading, so it never claims high confidence — it
  // gets the same dashed brass underline a medium-confidence extraction does.
  // A figure the analyst typed claims nothing at all: no meter, no underline.
  const CONF_ATTR = { manual: "manual", default: "medium", missing: "low" };
  const row = el("div", {
    class: `field${band === "manual" ? " field--manual" : ""}`,
    dataset: { conf: CONF_ATTR[band] || band },
  });

  const control = el("input", {
    class: "field__value",
    type: "text",
    value: displayValue(input),
    "aria-label": input.label,
    spellcheck: "false",
    autocomplete: "off",
  });

  const unit = unitSuffix(input);
  const well = el(
    "div",
    { class: "field__well" },
    // When the analyst has overridden the machine, what the machine said stays
    // on the row in micro text. Nothing is quietly replaced.
    band === "manual" && input.aiValue !== null && input.aiValue !== undefined
      ? el("span", {
          class: "field__ai field__unit",
          text: `AI ${formatFieldValue({ key: input.key, unit: input.unit, value: input.aiValue })}`,
        })
      : null,
    control,
    unit ? el("span", { class: "field__unit", text: unit }) : null,
  );

  let manual = band === "manual";
  let meter = manual
    ? el("span", { class: "tag tag--manual field__manual-tag", text: "Manual" })
    : band === "default"
      ? el("span", { class: "tag field__manual-tag", text: "Default" })
      : el(
          "div",
          { class: "conf" },
          el("i", { class: "conf__bar" }),
          el("i", { class: "conf__bar" }),
          el("i", { class: "conf__bar" }),
        );

  const citation = [];
  if (input.sourceDocumentId) {
    const doc = (state.detail.documents || []).find((d) => d.id === input.sourceDocumentId);
    const kind = doc ? String(doc.kind).replace(/_/g, " ") : "doc";
    citation.push(input.sourcePage ? `${kind} · p.${input.sourcePage}` : kind);
  } else if (input.origin === "default") {
    citation.push("model default");
  } else if (input.origin === "missing") {
    citation.push("not found");
  }
  if (input.sourceSnippet) citation.push(String(input.sourceSnippet).slice(0, 90));

  const confirm = el(
    "button",
    {
      class: "field__action no-print",
      type: "button",
      "aria-label": `Confirm ${input.label}`,
      title: "Confirm this reading",
      on: {
        click: async () => {
          await API.deals.confirmField(state.detail.deal.id, input.key);
          row.classList.add("field--committed");
          setTimeout(() => row.classList.remove("field--committed"), 460);
        },
      },
    },
    icon("check"),
  );

  row.append(
    el("div", { class: "field__label", text: input.label }),
    well,
    meter,
    confirm,
    el("div", { class: "field__cite", text: citation.join(" · ") || " " }),
  );

  let committed = displayValue(input);
  let reverting = false;

  control.addEventListener("focus", () => {
    control.value = rawEditable(input);
    control.select();
  });

  control.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      control.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      reverting = true;
      control.value = committed;
      control.blur();
    }
  });

  if (options.onLive) {
    let handle = null;
    control.addEventListener("input", () => {
      if (handle) clearTimeout(handle);
      handle = setTimeout(() => {
        const parsed = parseInputValue(control.value, input.type);
        options.onLive(input.key, parsed);
      }, 420);
    });
  }

  control.addEventListener("blur", async () => {
    if (reverting) {
      reverting = false;
      control.value = committed;
      if (options.onLive) options.onLive(input.key, undefined);
      return;
    }

    const parsed = parseInputValue(control.value, input.type);
    const unchanged =
      (parsed === null && (input.value === null || input.value === undefined)) ||
      String(parsed) === String(input.value);

    if (unchanged) {
      control.value = committed;
      return;
    }

    try {
      await API.deals.patchFields(state.detail.deal.id, [{ key: input.key, value: parsed }]);
      input.value = parsed;
      input.origin = "user";
      committed = displayValue(input);
      control.value = committed;

      // The meter is swapped for a MANUAL tag: no confidence is claimed for a
      // figure a human typed. The well flashes for 400ms; the number does not
      // animate, because the user is the one who changed it.
      row.classList.add("field--manual", "field--committed");
      row.dataset.conf = "manual";
      setTimeout(() => row.classList.remove("field--committed"), 460);

      if (!manual) {
        const tagNode = el("span", { class: "tag tag--manual field__manual-tag", text: "Manual" });
        meter.replaceWith(tagNode);
        meter = tagNode;
        manual = true;
      }

      if (options.onCommit) await options.onCommit(input.key, parsed);
    } catch (err) {
      control.setAttribute("aria-invalid", "true");
      control.value = committed;
      setTimeout(() => control.removeAttribute("aria-invalid"), 2000);
      console.error("field commit failed", err);
    }
  });

  return row;
}

// ------------------------------------------------- rent roll and T12 tables --

/**
 * A dense-table cell that is also the edit surface. It shows the formatted
 * figure at rest — a column of numbers has to stay a rigid rectangle — and the
 * raw value the moment it takes focus, so nothing has to be un-typed.
 */
function editableCell(current, { align = "end", onCommit, parse, display }) {
  const cell = el("td", { class: align === "end" ? "num" : "" });
  const raw = () => (current === null || current === undefined ? "" : String(current));
  const shown = () => (display ? display(current) : raw());

  const control = el("input", {
    class: "field__value",
    type: "text",
    value: shown(),
    autocomplete: "off",
    spellcheck: "false",
  });
  if (align !== "end") control.style.setProperty("text-align", "start");
  control.style.setProperty("block-size", "calc(var(--row-h) - 8px)");

  let reverting = false;

  control.addEventListener("focus", () => {
    control.value = raw();
    control.select();
  });

  control.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      control.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      reverting = true;
      control.blur();
    }
  });

  control.addEventListener("blur", async () => {
    if (reverting) {
      reverting = false;
      control.value = shown();
      return;
    }

    const next = parse ? parse(control.value) : control.value;
    if (String(next) === String(current)) {
      control.value = shown();
      return;
    }

    try {
      await onCommit(next);
      current = next;
      control.value = shown();
      flash(cell);
    } catch (err) {
      control.value = shown();
      control.setAttribute("aria-invalid", "true");
      setTimeout(() => control.removeAttribute("aria-invalid"), 2000);
      console.error("cell commit failed", err);
    }
  });

  cell.append(control);
  return cell;
}

function sum(list) {
  const numbers = list.filter((n) => typeof n === "number" && Number.isFinite(n));
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) : null;
}

function rentRollTable(units) {
  const dealId = state.detail.deal.id;

  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "compact" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-unit", scope: "col", text: "Unit" }),
        el("th", { class: "w-tag", scope: "col", text: "Type" }),
        el("th", { class: "num", scope: "col", text: "Beds" }),
        el("th", { class: "num w-area", scope: "col", text: "Area" }),
        el("th", { class: "num w-money", scope: "col", text: "In-place rent" }),
        el("th", { class: "num w-money", scope: "col", text: "Market rent" }),
        el("th", { class: "num", scope: "col", text: "Cheques" }),
        el("th", { class: "w-date", scope: "col", text: "Lease end" }),
        el("th", { class: "w-tag", scope: "col", text: "Status" }),
        el("th", { class: "w-tag", scope: "col", text: "Ejari" }),
      ),
    ),
  );

  const body = el("tbody");
  const patch = (unitId, key) => async (value) => {
    await API.deals.patchUnit(dealId, unitId, { [key]: value });
  };

  for (const unit of units) {
    const areaCell = el("td", { class: "num w-area" });
    areaCell.append(areaFragment(unit.area_sqft));

    body.append(
      el(
        "tr",
        null,
        editableCell(unit.unit_no, { align: "start", onCommit: patch(unit.id, "unit_no") }),
        editableCell(unit.unit_type, { align: "start", onCommit: patch(unit.id, "unit_type") }),
        editableCell(unit.beds, {
          onCommit: patch(unit.id, "beds"),
          parse: (v) => parseNumeric(v),
          display: (v) => fmt(v, "integer"),
        }),
        areaCell,
        editableCell(unit.in_place_rent, {
          onCommit: patch(unit.id, "in_place_rent"),
          parse: (v) => parseNumeric(v),
          display: (v) => fmt(v, "currency"),
        }),
        editableCell(unit.market_rent, {
          onCommit: patch(unit.id, "market_rent"),
          parse: (v) => parseNumeric(v),
          display: (v) => fmt(v, "currency"),
        }),
        editableCell(unit.cheques, {
          onCommit: patch(unit.id, "cheques"),
          parse: (v) => parseNumeric(v),
          display: (v) => fmt(v, "integer"),
        }),
        el("td", { class: "w-date", text: unit.lease_end ? formatDate(unit.lease_end) : EM_DASH }),
        el("td", { class: "w-tag" }, pill(String(unit.occupancy_status || "occupied").toUpperCase(), (unit.occupancy_status || "occupied") === "vacant" ? "cau" : "pos")),
        el("td", { class: "w-tag t-micro c-3", text: unit.ejari_no || EM_DASH }),
      ),
    );
  }

  const areaTotal = sum(units.map((u) => u.area_sqft));
  const inPlaceTotal = sum(units.map((u) => u.in_place_rent));
  const marketTotal = sum(units.map((u) => u.market_rent ?? u.in_place_rent));

  const totalArea = el("td", { class: "num w-area" });
  totalArea.append(areaFragment(areaTotal));

  table.append(body);
  table.append(
    el(
      "tfoot",
      null,
      el(
        "tr",
        null,
        el("td", { text: `${units.length} unit${units.length === 1 ? "" : "s"}` }),
        el("td"),
        el("td"),
        totalArea,
        numericFoot(inPlaceTotal, "currency"),
        numericFoot(marketTotal, "currency"),
        el("td"),
        el("td"),
        el("td"),
        el("td"),
      ),
    ),
  );

  wrap.append(table);

  const modelGross = state.result ? state.result.values.annual_rent ?? state.result.values.gross_rent : null;
  const foots = modelGross === null || modelGross === undefined || inPlaceTotal === null
    ? null
    : Math.abs(modelGross - inPlaceTotal) < Math.max(1, Math.abs(inPlaceTotal) * 0.005);

  const reconciliation = el(
    "p",
    { class: "t-caption c-3", css: { "margin-block-start": "var(--s-8)" } },
    el("span", { text: "Sum of in-place rents " }),
    figureFragment(fmt(inPlaceTotal, "currency")),
    el("span", { text: foots === null ? " — no gross rent computed yet." : foots ? " foots to the gross rent the model uses." : " does not match the model's gross rent " }),
    foots === false ? figureFragment(fmt(modelGross, "currency")) : null,
    foots === false ? el("span", { text: " — a field override is taking precedence." }) : null,
  );

  return frag(wrap, reconciliation);
}

function numericFoot(value, format) {
  const cell = el("td", { class: "num" });
  cell.append(figureFragment(fmt(value, format)));
  return cell;
}

function t12Table(lines) {
  const dealId = state.detail.deal.id;
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "compact" } });
  const table = el("table", { class: "tbl" });

  table.append(
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-name", scope: "col", text: "Line" }),
        el("th", { class: "w-tag", scope: "col", text: "Section" }),
        el("th", { class: "w-tag", scope: "col", text: "Category" }),
        el("th", { class: "num w-money", scope: "col", text: "Amount" }),
        el("th", { class: "num", scope: "col", text: "Months" }),
        el("th", { class: "num w-money", scope: "col", text: "Annualised" }),
        el("th", { class: "w-tag", scope: "col", text: "Treatment" }),
      ),
    ),
  );

  const annualise = (line) => {
    if (typeof line.annualized === "number") return line.annualized;
    if (typeof line.amount !== "number") return null;
    const months = line.months_covered > 0 ? line.months_covered : 12;
    return (line.amount / months) * 12;
  };

  const patch = (lineId, key) => async (value) => {
    await API.deals.patchT12(dealId, lineId, { [key]: value });
  };

  const body = el("tbody");
  for (const line of lines) {
    const annualised = el("td", { class: "num w-money" });
    annualised.append(figureFragment(fmt(annualise(line), "currency")));

    const excluded = Boolean(line.exclude_reason) || line.is_recurring === 0;

    body.append(
      el(
        "tr",
        null,
        editableCell(line.raw_label, { align: "start", onCommit: patch(line.id, "raw_label") }),
        el("td", { class: "w-tag t-micro c-3", text: line.section ? String(line.section).toUpperCase() : EM_DASH }),
        el("td", { class: "w-tag t-micro c-3", text: line.category ? String(line.category).replace(/_/g, " ").toUpperCase() : EM_DASH }),
        editableCell(line.amount, {
          onCommit: patch(line.id, "amount"),
          parse: (v) => parseNumeric(v),
          display: (v) => fmt(v, "currency"),
        }),
        editableCell(line.months_covered, {
          onCommit: patch(line.id, "months_covered"),
          parse: (v) => parseNumeric(v),
          display: (v) => (v === null || v === undefined ? EM_DASH : `${fmt(v, "integer")} mo`),
        }),
        annualised,
        el(
          "td",
          { class: "w-tag" },
          excluded
            ? pill("EXCLUDED", "cau")
            : pill("RECURRING", "neu"),
        ),
      ),
    );
  }

  const recurring = lines.filter((l) => l.is_recurring === 1 && !l.exclude_reason);
  const opexTotal = sum(recurring.filter((l) => l.section === "opex").map(annualise));
  const incomeTotal = sum(recurring.filter((l) => l.section === "income").map(annualise));

  table.append(body);
  table.append(
    el(
      "tfoot",
      null,
      el(
        "tr",
        null,
        el("td", { text: "Recurring operating expenses" }),
        el("td"),
        el("td"),
        el("td"),
        el("td"),
        numericFoot(opexTotal, "currency"),
        el("td"),
      ),
      incomeTotal === null
        ? null
        : el(
            "tr",
            null,
            el("td", { text: "Recurring income" }),
            el("td"),
            el("td"),
            el("td"),
            el("td"),
            numericFoot(incomeTotal, "currency"),
            el("td"),
          ),
    ),
  );

  wrap.append(table);

  const modelOpex = state.result ? state.result.values.total_opex ?? state.result.values.opex : null;
  const note = el(
    "p",
    { class: "t-caption c-3", css: { "margin-block-start": "var(--s-8)" } },
    el("span", { text: "Recurring opex lines sum to " }),
    figureFragment(fmt(opexTotal, "currency")),
    modelOpex === null || modelOpex === undefined
      ? el("span", { text: "." })
      : frag(
          el("span", { text: ", against a modelled total operating expense of " }),
          figureFragment(fmt(modelOpex, "currency")),
          el("span", { text: ". The difference is the model's own assumptions — management fee, irrecoverable VAT and reserves." }),
        ),
  );

  return frag(wrap, note);
}

// -------------------------------------------------------------- underwriting --

function renderUnderwriting(panel) {
  const deal = state.detail.deal;
  const result = state.result;

  const depthToggle = el(
    "div",
    { class: "segmented no-print", role: "group", "aria-label": "Underwriting depth" },
    [["quick", "Quick"], ["full", "Full"]].map(([value, label]) =>
      el("button", {
        type: "button",
        text: label,
        "aria-pressed": deal.depth === value ? "true" : "false",
        on: {
          click: async () => {
            if (deal.depth === value) return;
            deal.depth = value;
            await refreshResult({ depth: value, silent: true });
            renderTab("underwriting", panel);
          },
        },
      }),
    ),
  );

  const modelSelect = selectField(
    "uw-model",
    (state.detail.models || []).map((m) => [m.id, `${m.name}${m.isSystem ? " · system" : ""}`]),
  );
  modelSelect.control.value = deal.modelId || "";
  modelSelect.control.addEventListener("change", async () => {
    deal.modelId = modelSelect.control.value;
    await API.deals.update(deal.id, { modelId: deal.modelId });
    await refreshResult({ silent: true });
    renderTab("underwriting", panel);
  });

  const runButton = button("Run underwriting", {
    variant: "primary",
    iconName: "rerun",
    onClick: async () => {
      setLoading(runButton, true, "Running");
      try {
        const payload = await API.deals.underwrite(deal.id, { depth: deal.depth, modelId: deal.modelId });
        state.result = payload.result;
        state.runId = payload.runId;
        state.overrides = {};
        state.detail = await API.deals.get(deal.id);
        // Arm the reveal. Only a completed run earns it.
        state.reveal = true;
        renderDeal("underwriting");
      } catch (err) {
        setLoading(runButton, false, "Run underwriting");
        panel.prepend(
          el(
            "div",
            { class: "flag" },
            el("div", { class: "flag__title", text: "Could not run" }),
            el("p", { class: "flag__body", text: err.message }),
          ),
        );
      }
    },
  });

  panel.append(
    el(
      "div",
      { class: "toolbar no-print" },
      el("span", { class: "t-label c-3", text: "Depth" }),
      depthToggle,
      el("span", { class: "t-label c-3", text: "Model" }),
      el("div", { css: { "min-inline-size": "260px" } }, modelSelect.node),
      el("div", { class: "spacer" }),
      state.runId ? el("span", { class: "t-micro c-3", text: `Run ${state.runId.slice(0, 8)}` }) : null,
      runButton,
    ),
  );

  if (!result) {
    panel.append(
      empty(
        "No underwriting yet",
        state.resultError || "Select a model and run the underwriting.",
      ),
    );
    return;
  }

  panel.append(kpiBand(result));

  const blocking = (result.warnings || []).filter((w) => w.level === "blocking");
  if (blocking.length) {
    panel.append(
      el(
        "div",
        { class: "section" },
        el(
          "div",
          { class: "flag-stack" },
          blocking.map((w, i) =>
            el(
              "div",
              { class: "flag flag--in", css: { "--i": String(i) } },
              el("div", { class: "flag__title", text: "Missing input" }),
              el("p", { class: "flag__body", text: w.message }),
            ),
          ),
        ),
      ),
    );
  }

  panel.append(computedLines(result));

  if (result.projection) panel.append(projectionTable(result.projection));
  if (result.benchmarks && result.benchmarks.length) panel.append(benchmarkPanel(result));

  panel.append(solverSection(analysisContext()));
  panel.append(sensitivitySection(analysisContext()));

  panel.append(assumptionsPanel(result, panel));
}

function kpiBand(result) {
  const summary = (result.summary || []).slice(0, 6);
  if (!summary.length) return el("div");

  const benchmarks = new Map((result.benchmarks || []).map((b) => [b.key, b]));
  const band = el("div", { class: "band" });
  // The band is a composition, not a row of equals. The dominant figure holds
  // the left of the frame alone; every supporting metric is ranged right as one
  // group, which is why they need a container of their own.
  const support = el("div", { class: "band__support" });

  // The reveal is earned by a run, not by a tab click. Read-and-clear, so it
  // plays exactly once and a later re-render of the same result is instant.
  const reveal = state.reveal === true;
  state.reveal = false;
  if (reveal) band.classList.add("band--reveal");

  summary.forEach((cv, index) => {
    const text = fmt(cv.value, cv.format, cv.precision);
    const tile = el("div", { class: `kpi${index === 0 ? " kpi--hero" : ""}` });
    tile.style.setProperty("--i", String(index));

    const fmtSpan = el("span", { class: "kpi__fmt" });
    fmtSpan.append(figureFragment(text, { typeset: true }));
    registerLive(cv.key, {
      host: fmtSpan,
      format: cv.format,
      precision: cv.precision,
      options: { typeset: true },
      last: text,
    });

    // The figure already carries its unit, so the sub line is reserved for
    // something the figure cannot say: the threshold it is judged against.
    const benchmark = benchmarks.get(cv.key);
    const subText = benchmark
      ? `${benchmark.direction === "lower" ? "Target ≤" : "Target ≥"} ${fmt(benchmark.good, cv.format, cv.precision)}`
      : "";

    // The local helper, not Element.append — the native one stringifies a null
    // child into the literal text "null".
    append(
      tile,
      el("div", { class: "kpi__label", text: cv.label }),
      el("div", { class: "kpi__figure" }, el("span", { class: "kpi__val" }, fmtSpan)),
      subText ? el("div", { class: "kpi__sub", text: subText }) : null,
    );

    const target = countTarget(typeof cv.value === "number" ? cv.value : 0);
    tile.style.setProperty("--target", String(target));
    if (reveal && !reducedMotion() && target > 0) {
      tile.classList.add("kpi--in");
      const settle = () => tile.classList.remove("kpi--in");
      tile.addEventListener("animationend", (event) => {
        if (event.animationName === "count") settle();
      });
      // The formatted value is hidden while the digits roll. If the roll never
      // finishes — a backgrounded tab freezes the timeline — the figure would
      // stay invisible, and a KPI band with no numbers in it is a broken
      // product. This guarantees the settled value appears either way. The
      // floor tracks the re-cut beats: last tile lands at 850 + 5x50, plus the
      // count's own 640ms, plus headroom.
      setTimeout(settle, 2000 + index * 50);
    }

    (index === 0 ? band : support).append(tile);
  });

  band.append(support);

  // No section head. The model and the run id are already stated in the toolbar
  // directly above, so a "Headline" eyebrow over the headline figure was a
  // label on a label. The figure carries its own.
  return el("div", { class: "section" }, band);
}

function computedLines(result) {
  const all = [...(result.lines || []), ...(result.returns || [])].filter((l) => !l.hidden);
  if (!all.length) return el("div");

  const groups = new Map();
  for (const line of all) {
    const key = line.group || "Computed";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }

  const stack = el("div", { class: "stack stack--24" });
  for (const [name, lines] of groups) {
    const wrap = el("div", { class: "tbl-wrap", dataset: { density: "default" } });
    const table = el("table", { class: "tbl" });
    table.append(
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          el("th", { class: "w-name", scope: "col", text: name }),
          el("th", { class: "num w-money", scope: "col", text: "Value" }),
        ),
      ),
    );
    const body = el("tbody");
    for (const line of lines) {
      const cell = el("td", { class: "num w-money" });
      cell.append(liveFigure(line.key, line.value, line.format, line.precision, { judgement: true }));
      const labelCell = el("td", { class: "w-name" }, el("span", { text: line.label }));
      if (line.emphasis === "hero" || line.emphasis === "strong") {
        labelCell.firstChild.className = "c-1";
        cell.classList.add("c-1");
      } else if (line.emphasis === "muted") {
        labelCell.firstChild.className = "c-3";
      }
      if (line.error) {
        labelCell.append(el("span", { class: "tag tag--manual", text: "error" }));
        labelCell.title = line.error;
      }
      body.append(el("tr", null, labelCell, cell));
    }
    table.append(body);
    wrap.append(table);
    stack.append(wrap);
  }

  return el("div", { class: "section" }, sectionHead("Computed lines", "Values only — the formulas stay on the server."), stack);
}

function projectionTable(projection) {
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "compact" } });
  const table = el("table", { class: "tbl" });

  const headRow = el("tr", null, el("th", { class: "w-name", scope: "col", text: "Line" }));
  for (let year = 1; year <= projection.years; year++) {
    headRow.append(el("th", { class: "num w-money", scope: "col", text: `Yr ${year}` }));
  }
  table.append(el("thead", null, headRow));

  const body = el("tbody");
  for (const row of projection.rows) {
    const tr = el("tr", null, el("td", { class: "w-name", text: row.label }));
    row.values.forEach((value, index) => {
      const text = fmt(value, row.format, row.precision);
      const host = figureHost(text, { judgement: true });
      live.projection.push({ key: row.key, year: index, format: row.format, precision: row.precision, host, last: text });
      const cell = el("td", { class: "num w-money" });
      if (row.emphasis === "hero" || row.emphasis === "strong") cell.classList.add("c-1");
      cell.append(host);
      tr.append(cell);
    });
    body.append(tr);
  }

  table.append(body);
  wrap.append(table);
  return el(
    "div",
    { class: "section" },
    sectionHead("Projection", `${projection.years}-year hold`),
    wrap,
  );
}

const BENCH_TONE = { good: "pos", warn: "cau", bad: "neg", unknown: "neu" };

function benchmarkPanel(result) {
  const benchmarks = result.benchmarks || [];
  const grid = el("div", { class: "grid grid--tight" });

  // A benchmark names a computed key, so the line that produced the number is
  // the authority on how to render it. Guessing is the fallback, not the plan.
  const computed = new Map(
    [...(result.lines || []), ...(result.returns || []), ...(result.summary || [])].map((l) => [l.key, l]),
  );

  for (const benchmark of benchmarks) {
    const line = computed.get(benchmark.key);
    const format = (line && line.format) || inferFormat(benchmark);
    const text = fmt(benchmark.value, format, line && line.precision);
    const readout = figureHost(text, { typeset: true });
    const node = gauge(benchmark);
    live.gauges.push({
      key: benchmark.key,
      node,
      readout,
      format,
      precision: line && line.precision,
      last: text,
    });

    grid.append(
      el(
        "div",
        { class: "col-4 plate plate--pad" },
        el("div", { class: "t-label c-3", text: benchmark.label }),
        el(
          "div",
          { class: "gauge-cell", css: { "margin-block-start": "var(--s-12)" } },
          node,
          el(
            "div",
            { class: "gauge-cell__read" },
            el("div", { class: "gauge-cell__val" }, readout),
            el("div", {
              class: "gauge-cell__cov",
              text: `${benchmark.direction === "lower" ? "≤" : "≥"} ${fmt(benchmark.good, format)} target · ${fmt(benchmark.warn, format)} floor`,
            }),
          ),
        ),
        el("div", { class: "row row--8", css: { "margin-block-start": "var(--s-12)" } },
          pill(String(benchmark.status).toUpperCase(), BENCH_TONE[benchmark.status] || "neu")),
        benchmark.note ? el("p", { class: "t-caption c-3", css: { "margin-block-start": "var(--s-8)" }, text: benchmark.note }) : null,
      ),
    );
  }

  return el("div", { class: "section" }, sectionHead("Thresholds", "Covenant bands are marked on the arc."), grid);
}

function inferFormat(benchmark) {
  const unit = (benchmark.unit || "").toLowerCase();
  const key = (benchmark.key || "").toLowerCase();
  if (unit === "%" || unit === "percent") return "percent";
  if (unit.includes("yr") || unit.includes("year") || key.includes("payback")) return "years";
  if (unit === "x" || unit === "×" || unit === "ratio") return "multiple";
  if (unit === "aed" || unit === "usd") return "currency";
  if (typeof benchmark.value === "number" && Math.abs(benchmark.value) < 1 && benchmark.value !== 0) return "percent";
  return "multiple";
}

/**
 * Editing an assumption here recalculates the whole model server-side and
 * writes the new numbers into the page in place. Nothing is rebuilt, nothing
 * re-runs extraction, and no number that changed because the user changed it
 * ever animates — it flashes.
 */
function assumptionsPanel(result, panel) {
  const inputs = (result.inputs || []).filter((i) => !i.hidden);
  const groups = new Map();
  for (const input of inputs) {
    const key = input.group || "Assumptions";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(input);
  }

  const onLive = async (key, value) => {
    if (value === undefined) delete state.overrides[key];
    else state.overrides[key] = value;
    const next = await refreshResult({ silent: true });
    if (next) refreshLive(next);
  };

  const onCommit = async (key) => {
    delete state.overrides[key];
    const next = await refreshResult({ silent: true });
    if (next) refreshLive(next);
  };

  const stack = el("div", { class: "stack stack--24" });
  for (const [name, rows] of groups) {
    const ledger = el(
      "div",
      { class: "ledger" },
      el(
        "div",
        { class: "ledger__head" },
        el("span", { class: "t-label", text: name }),
        el("span", { class: "t-label u-end", text: "Value" }),
        el("span", { class: "t-label u-end", text: "Conf" }),
        el("span"),
      ),
    );
    for (const input of rows) ledger.append(fieldRow(input, { onLive, onCommit }));
    stack.append(ledger);
  }

  return el(
    "div",
    { class: "section no-print" },
    sectionHead("Assumptions", "Type a new figure — every dependent number above updates."),
    stack,
  );
}

// ----------------------------------------------------------------- analysis --

const FLAG_CLASS = {
  red: "flag",
  amber: "flag flag--caution",
  info: "flag flag--dd",
  positive: "flag flag--strength",
};

// The flag title is an 11px tracked uppercase label. That is a title card, not
// a paragraph — an overlong one is demoted into the body so it stays readable.
const TITLE_MAX = 56;

function cardCopy(item, fallbackTitle) {
  const title = String(item.title || "").trim();
  const detail = String(item.detail || "").trim();
  if (title.length <= TITLE_MAX) return { title, body: detail };
  return { title: fallbackTitle, body: detail ? `${title} ${detail}` : title };
}

/**
 * A metric footer renders through the format its own computed line declares,
 * so a DSCR reads "0.96×" and never "96.45%".
 */
function metricText(key) {
  const result = state.result;
  if (!result) return EM_DASH;
  const line = [...(result.lines || []), ...(result.returns || []), ...(result.summary || [])].find(
    (l) => l.key === key,
  );
  return fmt(result.values[key], line && line.format, line && line.precision);
}

function renderAnalysis(panel) {
  const narrative = state.narrative;
  const result = state.result;

  const generate = button(narrative ? "Regenerate analysis" : "Generate analysis", {
    variant: narrative ? "secondary" : "primary",
    iconName: "rerun",
    disabled: !state.runId,
    onClick: async () => {
      setLoading(generate, true, "Writing");
      try {
        const payload = await API.runs.narrative(state.runId);
        state.narrative = payload;
        renderTab("analysis", panel);
      } catch (err) {
        setLoading(generate, false, "Generate analysis");
        panel.prepend(
          el(
            "div",
            { class: "flag" },
            el("div", { class: "flag__title", text: "Could not write the analysis" }),
            el("p", { class: "flag__body", text: err.message }),
          ),
        );
      }
    },
  });

  panel.append(
    el(
      "div",
      { class: "toolbar no-print" },
      el("span", { class: "t-label c-3", text: state.runId ? "Analysis" : "Run the underwriting first" }),
      el("div", { class: "spacer" }),
      generate,
    ),
  );

  if (!narrative) {
    panel.append(
      empty(
        "No write-up yet",
        state.runId
          ? "Generate the analysis to get the headline, the strengths, the red flags and the due-diligence list."
          : "Run the underwriting on the previous tab, then generate the analysis.",
      ),
    );
  } else {
    // The headline leaves the narrative block. Inside it, `.narrative p` was
    // overriding `.t-title` on specificity and setting the one sentence a
    // principal actually reads as body copy. It is a title card, so it is
    // composed as one.
    const verdict = el(
      "div",
      { class: "verdict" },
      el("p", { class: "verdict__line", text: narrative.headline }),
    );

    const block = el(
      "div",
      { class: "narrative" },
      ...String(narrative.summary || "")
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((para) => el("p", { text: para })),
      el(
        "div",
        { class: "narrative__prov" },
        el("span", { text: narrative.engine === "ai" ? "Generated" : "Rule-derived" }),
        el("span", { text: formatDateTime(narrative.createdAt || new Date().toISOString()) }),
        narrative.status && narrative.status !== "ok" ? el("span", { text: String(narrative.status) }) : null,
      ),
    );
    panel.append(el("div", { class: "section" }, sectionHead("Analysis"), verdict, block));
  }

  let stagger = 0;
  const cardStack = (title, items, className, options = {}) => {
    if (!items || !items.length) return null;
    const stack = el("div", { class: "flag-stack" });
    for (const item of items) {
      const copy = cardCopy(item, options.fallbackTitle || title);
      const card = el("div", { class: `${className} flag--in` });
      card.style.setProperty("--i", String(stagger++));
      card.append(el("div", { class: "flag__title", text: copy.title }));
      card.append(el("p", { class: "flag__body", text: copy.body }));

      const meta = el("div", { class: "flag__meta" });
      if (item.metric) {
        meta.append(el("span", { text: humanise(item.metric) }));
        if (result && result.values[item.metric] !== undefined) {
          meta.append(el("span", { text: " · " }));
          meta.append(figureFragment(metricText(item.metric)));
        }
      }
      if (options.checkbox) {
        const id = `dd-${stagger}`;
        const box = el("input", {
          type: "checkbox",
          id,
          checked: state.dd.has(item.title),
          on: {
            change: (event) => {
              if (event.target.checked) state.dd.add(item.title);
              else state.dd.delete(item.title);
              persistDd();
            },
          },
        });
        card.append(el("label", { class: "check", for: id, css: { "margin-block-start": "var(--s-8)" } }, box, el("span", { class: "t-caption c-3", text: "Cleared" })));
      }
      if (meta.childElementCount) card.append(meta);
      stack.append(card);
    }
    return el("div", { class: "section" }, sectionHead(title, `${items.length}`), stack);
  };

  const flagsFromEngine = (result && result.flags) || [];
  const engineCards = flagsFromEngine.length
    ? el(
        "div",
        { class: "section" },
        sectionHead("Model flags", "Deterministic — these fire from the numbers, not from prose."),
        el(
          "div",
          { class: "flag-stack" },
          flagsFromEngine.map((flag, i) => {
            const copy = cardCopy(flag, flag.severity === "positive" ? "Strength" : "Model flag");
            const card = el("div", { class: `${FLAG_CLASS[flag.severity] || "flag"} flag--in` });
            card.style.setProperty("--i", String(i));
            card.append(el("div", { class: "flag__title", text: copy.title }));
            card.append(el("p", { class: "flag__body", text: copy.body }));
            if (flag.metric) {
              const meta = el(
                "div",
                { class: "flag__meta" },
                el("span", { text: humanise(flag.metric) }),
                el("span", { text: " · " }),
              );
              meta.append(figureFragment(metricText(flag.metric)));
              card.append(meta);
            }
            return card;
          }),
        ),
      )
    : null;

  if (engineCards) panel.append(engineCards);

  if (narrative) {
    append(
      panel,
      cardStack("Strengths", narrative.strengths, "flag flag--strength", { fallbackTitle: "Strength" }),
      cardStack("Red flags", narrative.redFlags, "flag", { fallbackTitle: "Red flag" }),
      cardStack("Due diligence", narrative.ddItems, "flag flag--dd", {
        checkbox: true,
        fallbackTitle: "Due diligence",
      }),
    );
  }
}

function ddStorageKey() {
  return `meridian.dd.${state.detail ? state.detail.deal.id : "none"}`;
}

function persistDd() {
  try {
    window.localStorage.setItem(ddStorageKey(), JSON.stringify([...state.dd]));
  } catch {
    /* Private browsing; the checkbox still works for this session. */
  }
}

function restoreDd() {
  state.dd = new Set();
  try {
    const raw = window.localStorage.getItem(ddStorageKey());
    if (raw) state.dd = new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
}

// -------------------------------------------------------------------- print --

/**
 * The IC pack. The print stylesheet already strips the chrome and reflows the
 * band and the tables; what paper needs and the screen does not is a masthead
 * and a stamp, so those are built for the print event and removed after it.
 */
function wirePrint() {
  let head = null;
  let foot = null;

  window.addEventListener("beforeprint", () => {
    if (!state.detail || head) return;
    const deal = state.detail.deal;
    const today = formatDate(new Date().toISOString());

    head = el(
      "div",
      { class: "ic-sheet__head" },
      el(
        "div",
        null,
        el("div", { class: "ic-sheet__title", text: deal.name }),
        el("div", {
          class: "ic-sheet__sub",
          text: [deal.community, deal.city, humanise(deal.assetType), deal.tenure ? humanise(deal.tenure) : null]
            .filter(Boolean)
            .join(" · "),
        }),
      ),
      el(
        "div",
        { class: "ic-sheet__stamp" },
        el("div", { text: "Meridian · Investment Committee pack" }),
        el("div", { text: `${today} · ${deal.currency}` }),
      ),
    );

    foot = el(
      "div",
      { class: "ic-sheet__foot" },
      el("span", { text: `${deal.name} · ${deal.currency}` }),
      el("span", { text: state.runId ? `Run ${state.runId.slice(0, 8)}` : "No persisted run" }),
      el("span", { text: `Printed ${today}` }),
    );

    view.prepend(head);
    view.append(foot);
  });

  window.addEventListener("afterprint", () => {
    if (head) head.remove();
    if (foot) foot.remove();
    head = null;
    foot = null;
  });
}

// --------------------------------------------------------------------- boot --

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

// One breath on sign-in: the wordmark alone on the void, then the rail and the
// canvas draw in. No new element and no travel — the wordmark is already where
// it belongs; everything else is simply not there yet. Once per session.
function breathe() {
  let owed = false;
  try {
    owed = window.sessionStorage.getItem("meridian.breath") === "1";
    if (owed) window.sessionStorage.removeItem("meridian.breath");
  } catch {
    /* No storage, no title card. It is a grace note, not a requirement. */
  }
  if (!owed) return;
  const shell = document.querySelector(".shell");
  if (!shell) return;
  shell.classList.add("shell--breath");
  setTimeout(() => shell.classList.remove("shell--breath"), 1200);
}

async function boot() {
  breathe();
  await API.requireSession();
  paintRail();

  try {
    const payload = await API.models.list();
    state.models = payload.models || [];
  } catch {
    state.models = [];
  }

  window.addEventListener("hashchange", route);
  wirePrint();

  if (!window.location.hash) window.location.hash = "#/deals";
  await route();
}

boot().catch((err) => {
  console.error(err);
  renderFailure(err);
});
