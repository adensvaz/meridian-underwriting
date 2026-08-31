// The broker side of buyer document collection.
//
// The API and the buyer's upload page already exist; this is the screen the
// broker works from — create a link, copy it, watch what lands, revoke it.
//
// The single thing this screen must not get wrong: THE TOKEN IS RETURNED ONCE.
// Only its SHA-256 is stored, the list endpoint deliberately omits it, and there
// is no route that can recover it. So the creation result is not a quiet
// confirmation line — it is a full-width plate with the URL in a read-only
// field, a copy button, and a caution flag saying in plain words that closing
// the panel loses the link. A broker who has to re-issue a request because the
// UI was polite about it will not trust the next screen either.
//
// The second thing: coverage is reported honestly. A document is filed under a
// `kind`, and several checklist lines share one kind — an Emirates ID and a
// passport both land as `identity`. That means an arrived document cannot be
// attributed to a specific checklist line, so this screen reports what has
// arrived BY TYPE and says so, rather than inventing a tick against a line that
// may still be outstanding.

import { api } from "./api.js";
import { EM_DASH, formatDate, formatDateTime } from "./format.js";
import {
  append,
  button,
  el,
  empty,
  icon,
  notice,
  pill,
  replace,
  sectionHead,
  setLoading,
  svg,
  tag,
} from "./ui.js";

const STATUS_TONE = { open: "pos", revoked: "neg", expired: "cau", closed: "neu" };

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

function strokeIcon(...paths) {
  const node = svg("svg", {
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  });
  for (const d of paths) node.append(svg("path", { d }));
  return node;
}

function iconCopy() {
  return strokeIcon("M5.5 5.5h8v8h-8z", "M2.5 10.5v-8h8");
}

function selectControl(options, value, onChange) {
  const control = el(
    "select",
    { on: onChange ? { change: () => onChange(control.value) } : undefined },
    options.map((option) => el("option", { value: option.value, text: option.label })),
  );
  if (value !== undefined && value !== null) control.value = String(value);
  const caret = icon("caret");
  caret.setAttribute("class", "select__caret");
  return { node: el("div", { class: "select" }, control, caret), control };
}

function daysUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.ceil(ms / 86400000);
}

/**
 * Kept short deliberately: this sits in a table cell that must not force the
 * row wider than the panel, which would push the revoke control off the edge.
 */
function expiryText(iso) {
  const days = daysUntil(iso);
  if (days === null) return formatDate(iso);
  if (days <= 0) return `${formatDate(iso)} · expired`;
  return `${formatDate(iso)} · ${days}d left`;
}

function expiryLongText(iso) {
  const days = daysUntil(iso);
  if (days === null) return formatDate(iso);
  if (days <= 0) return `${formatDate(iso)} — already expired`;
  return `${formatDate(iso)} — ${days} day${days === 1 ? "" : "s"} from now`;
}

// -------------------------------------------------------------- the token --

/**
 * The one-time link. Everything about this block is arranged so the URL cannot
 * be missed and cannot be assumed recoverable.
 */
function tokenPlate(created, onDone) {
  const field = el("input", {
    class: "input token__field",
    type: "text",
    readonly: true,
    spellcheck: "false",
    value: created.url,
    "aria-label": "Collection link",
  });

  const status = el("span", { class: "t-caption c-3", role: "status" });

  const copy = button("Copy link", { variant: "primary", onClick: async () => {
    field.focus();
    field.select();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(created.url);
        status.textContent = "Copied to the clipboard.";
        return;
      }
      throw new Error("no clipboard");
    } catch {
      status.textContent = "The link is selected — press Ctrl/Cmd+C to copy it.";
    }
  } });
  copy.prepend(iconCopy());

  return el(
    "div",
    { class: "plate plate--pad token" },
    el(
      "div",
      { class: "flag flag--caution", css: { "margin-block-end": "var(--s-16)" } },
      el("div", { class: "flag__title", text: "Shown once" }),
      el("p", {
        class: "flag__body",
        text:
          created.note ||
          "This link is shown once and cannot be recovered. Only its hash is stored. Copy it and send it to the buyer now — if it is lost, issue a new request.",
      }),
    ),
    el("div", { class: "t-label c-3", text: "Collection link" }),
    el("div", { class: "token__row" }, field, copy),
    el("div", { class: "row row--16 row--wrap", css: { "margin-block-start": "var(--s-12)" } }, status),
    el(
      "div",
      { class: "kv-strip", css: { "margin-block-start": "var(--s-20)" } },
      el(
        "div",
        { class: "dpair" },
        el("span", { class: "dpair__k", text: "Expires" }),
        el("span", { class: "dpair__v", text: expiryLongText(created.expiresAt) }),
      ),
      el(
        "div",
        { class: "dpair" },
        el("span", { class: "dpair__k", text: "Items requested" }),
        el("span", { class: "dpair__v", text: String((created.checklist || []).length) }),
      ),
    ),
    el(
      "div",
      { class: "row row--8", css: { "margin-block-start": "var(--s-20)" } },
      button("Done — I have copied it", { variant: "secondary", onClick: onDone }),
      el("a", {
        class: "btn btn--ghost",
        href: created.url,
        target: "_blank",
        rel: "noopener",
        text: "Open the buyer's page",
      }),
    ),
  );
}

// ------------------------------------------------------------ the checklist --

function checklistPreview(items) {
  const list = el("div", { class: "check-list" });
  for (const item of items) {
    list.append(
      el(
        "div",
        { class: "check-item" },
        el(
          "div",
          { class: "row row--8 row--wrap" },
          el("span", { class: "check-item__label", text: item.label }),
          item.required ? tag("Required", "accent") : tag("If applicable"),
          tag(String(item.kind).replace(/_/g, " ")),
        ),
        el("p", { class: "check-item__hint t-caption c-3", text: item.hint }),
      ),
    );
  }
  return list;
}

// ------------------------------------------------------------- the new form --

function newRequestForm(ctx, checklists, onCreated, onCancel) {
  const defaultKind = ctx.assetType === "mortgage" ? "mortgage" : "acquisition";

  const name = el("input", { class: "input", id: "cl-name", type: "text", placeholder: "Ahmed K" });
  const reference = el("input", {
    class: "input",
    id: "cl-ref",
    type: "text",
    placeholder: "Marina Gate II — 2BR",
  });
  const message = el("textarea", {
    class: "input",
    id: "cl-msg",
    rows: "3",
    placeholder: "Anything the buyer should know. 500 characters.",
    css: { "block-size": "auto", "padding-block": "var(--s-8)" },
  });
  const ttl = el("input", { class: "input", id: "cl-ttl", type: "text", value: "14" });

  const kindSelect = selectControl(
    [
      { value: "mortgage", label: "Mortgage — buyer documents" },
      { value: "acquisition", label: "Acquisition — property documents" },
    ],
    defaultKind,
    () => syncPreview(),
  );

  const employmentSelect = selectControl(
    [
      { value: "salaried", label: "Salaried" },
      { value: "self_employed", label: "Self-employed" },
    ],
    "salaried",
    () => syncPreview(),
  );

  const employmentField = el(
    "div",
    { class: "col-4 f" },
    el("label", { class: "f__label", for: "cl-emp", text: "Employment" }),
    employmentSelect.node,
    el("span", {
      class: "f__hint",
      text: "A salaried applicant is never asked for a trade licence.",
    }),
  );
  employmentSelect.control.id = "cl-emp";

  const previewHost = el("div");
  const errorLine = el("p", { class: "f__error", hidden: true, role: "alert" });
  const submit = button("Create link", { variant: "primary", onClick: () => create() });

  function currentItems() {
    if (kindSelect.control.value === "acquisition") return checklists.acquisition || [];
    // The payload is nested residency-first, because what a buyer is asked for
    // depends on where they live before it depends on how they earn: a
    // non-resident holds no Emirates ID whether salaried or self-employed.
    const byResidency = checklists.mortgage || {};
    const byEmployment = byResidency[ctx.residency] || byResidency.expat_resident || {};
    const byPurchase = byEmployment[employmentSelect.control.value] || {};
    return byPurchase[ctx.purchase || "ready"] || byPurchase.ready || [];
  }

  function syncPreview() {
    const mortgage = kindSelect.control.value === "mortgage";
    employmentField.hidden = !mortgage;
    const items = currentItems();
    replace(
      previewHost,
      el("div", { class: "t-label c-3", text: `The buyer will be asked for ${items.length} item${items.length === 1 ? "" : "s"}` }),
      checklistPreview(items),
    );
  }

  async function create() {
    errorLine.hidden = true;
    const days = Number(String(ttl.value).trim());
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      errorLine.textContent = "The link must live between 1 and 90 days.";
      errorLine.hidden = false;
      return;
    }

    setLoading(submit, true, "Creating");
    try {
      const created = await api.post(`/api/deals/${enc(ctx.dealId)}/collect`, {
        recipientName: name.value.trim() || undefined,
        reference: reference.value.trim() || undefined,
        message: message.value.trim() || undefined,
        kind: kindSelect.control.value,
        employment: employmentSelect.control.value,
        ttlDays: days,
      });
      onCreated(created);
    } catch (err) {
      setLoading(submit, false, "Create link");
      errorLine.textContent = err.message || String(err);
      errorLine.hidden = false;
    }
  }

  const form = el(
    "div",
    { class: "plate plate--pad no-print" },
    sectionHead("New collection link", "Upload-only. The buyer needs no account and can read nothing back."),
    el(
      "div",
      { class: "grid grid--tight" },
      el(
        "div",
        { class: "col-4 f" },
        el("label", { class: "f__label", for: "cl-name", text: "Recipient" }),
        name,
        el("span", { class: "f__hint", text: "Shown on the buyer's page so the link looks expected." }),
      ),
      el(
        "div",
        { class: "col-4 f" },
        el("label", { class: "f__label", for: "cl-ref", text: "Reference" }),
        reference,
        el("span", { class: "f__hint", text: "The buyer sees this. Never put a figure in it." }),
      ),
      el(
        "div",
        { class: "col-4 f" },
        el("label", { class: "f__label", for: "cl-kind", text: "Checklist" }),
        kindSelect.node,
      ),
      employmentField,
      el(
        "div",
        { class: "col-4 f" },
        el("label", { class: "f__label", for: "cl-ttl", text: "Valid for (days)" }),
        ttl,
        el("span", { class: "f__hint", text: "1 to 90. The link dies on its own." }),
      ),
      el(
        "div",
        { class: "col-12 f" },
        el("label", { class: "f__label", for: "cl-msg", text: "Message" }),
        message,
      ),
    ),
    errorLine,
    el("div", { class: "rule", css: { "margin-block": "var(--s-20)" } }),
    previewHost,
    el(
      "div",
      { class: "row row--8", css: { "margin-block-start": "var(--s-20)" } },
      submit,
      button("Cancel", { variant: "ghost", onClick: onCancel }),
    ),
  );

  kindSelect.control.id = "cl-kind";
  syncPreview();
  return form;
}

// ------------------------------------------------------------ the requests --

function requestTable(ctx, requests, onChanged) {
  const wrap = el("div", { class: "tbl-wrap", dataset: { density: "default" } });
  const table = el(
    "table",
    { class: "tbl" },
    el(
      "thead",
      null,
      el(
        "tr",
        null,
        el("th", { class: "w-tag", scope: "col", text: "Recipient" }),
        el("th", { class: "w-tag", scope: "col", text: "Reference" }),
        el("th", { class: "w-tag", scope: "col", text: "Status" }),
        el("th", { class: "num", scope: "col", text: "Items" }),
        el("th", { class: "num", scope: "col", text: "Uploads" }),
        el("th", { class: "w-date", scope: "col", text: "Last upload" }),
        el("th", { class: "w-date", scope: "col", text: "Expires" }),
        el("th", { class: "w-tag no-print", scope: "col", text: "" }),
      ),
    ),
  );

  const body = el("tbody");
  for (const request of requests) {
    const action = el("td", { class: "w-tag no-print" });
    if (request.status === "open") {
      const revoke = el(
        "button",
        { class: "btn btn--destructive btn--sm", type: "button" },
        el("span", { text: "Revoke" }),
      );
      let armed = false;
      let timer = null;
      revoke.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          revoke.lastChild.textContent = "Confirm";
          timer = setTimeout(() => {
            armed = false;
            revoke.lastChild.textContent = "Revoke";
          }, 4000);
          return;
        }
        if (timer) clearTimeout(timer);
        setLoading(revoke, true, "Revoking");
        try {
          await api.del(`/api/deals/${enc(ctx.dealId)}/collect/${enc(request.id)}`);
          await onChanged();
        } catch (err) {
          setLoading(revoke, false, "Revoke");
          console.error("revoke failed", err);
        }
      });
      action.append(revoke);
    }

    body.append(
      el(
        "tr",
        null,
        el("td", { class: "w-tag u-truncate cl-cell", text: request.recipientName || EM_DASH }),
        el("td", { class: "w-tag u-truncate cl-cell", text: request.reference || EM_DASH }),
        el(
          "td",
          { class: "w-tag" },
          pill(String(request.status).toUpperCase(), STATUS_TONE[request.status] || "neu"),
        ),
        el("td", { class: "num", text: String((request.checklist || []).length) }),
        el("td", { class: "num", text: String(request.uploadCount ?? 0) }),
        el("td", { class: "w-date", text: request.lastUploadAt ? formatDateTime(request.lastUploadAt) : EM_DASH }),
        el("td", { class: "w-date", text: expiryText(request.expiresAt) }),
        action,
      ),
    );
  }

  table.append(body);
  wrap.append(table);
  return wrap;
}

// -------------------------------------------------------------- coverage --

/**
 * What has arrived, by document type. Deliberately NOT a per-item completion
 * state: several checklist lines share one `kind`, so a type holding one file
 * says nothing about which of its lines is satisfied. Saying "2 of 9 complete"
 * here would be a number this data cannot support.
 */
function coveragePanel(ctx, requests, itemsByKey) {
  const wanted = new Set();
  for (const request of requests) {
    if (request.status === "revoked") continue;
    for (const key of request.checklist || []) wanted.add(key);
  }

  const items = [...wanted].map((key) => itemsByKey.get(key)).filter(Boolean);
  if (!items.length) {
    return empty(
      "Nothing requested yet",
      "Create a collection link and the checklist it asks for will be tracked here against the documents on the deal.",
    );
  }

  const byKind = new Map();
  for (const item of items) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, []);
    byKind.get(item.kind).push(item);
  }

  const documents = ctx.documents || [];
  const stack = el("div", { class: "stack stack--12" });

  for (const [kind, lines] of byKind) {
    const matched = documents.filter((d) => d.kind === kind);
    const row = el("div", { class: `cov${matched.length ? " cov--has" : ""}` });
    append(
      row,
      el(
        "div",
        { class: "cov__head" },
        el("span", { class: "cov__kind t-micro", text: String(kind).replace(/_/g, " ") }),
        el("span", {
          class: "t-caption c-3",
          text: `${matched.length} document${matched.length === 1 ? "" : "s"} of this type on the deal`,
        }),
      ),
      el(
        "div",
        { class: "cov__lines" },
        lines.map((item) =>
          el(
            "div",
            { class: "row row--8 row--wrap" },
            el("span", { class: "t-caption c-2", text: item.label }),
            item.required ? tag("Required", "accent") : null,
          ),
        ),
      ),
      matched.length
        ? el(
            "div",
            { class: "cov__files" },
            matched.map((doc) => el("span", { class: "cov__file t-micro", text: doc.filename })),
          )
        : null,
    );
    stack.append(row);
  }

  return el(
    "div",
    null,
    el("p", {
      class: "t-caption c-3 u-measure",
      css: { "margin-block-end": "var(--s-16)" },
      text:
        "Uploads are filed by document type, not by checklist line — an Emirates ID and a passport both arrive as identity. A type holding a file therefore does not prove the line beside it is satisfied, so this reports what has arrived by type and the raw upload count per link. It is not a completion state.",
    }),
    stack,
  );
}

// --------------------------------------------------------------------- api --

/**
 * Fill the Collect tab.
 *
 * @param {HTMLElement} panel
 * @param {{dealId:string, assetType:string, residency:string, purchase:string, documents:Array}} ctx
 */
export async function renderCollect(panel, ctx) {
  const head = el("div", { class: "section" }, sectionHead("Collection links", "Loading"));
  replace(panel, head);

  let checklists;
  let requests;
  try {
    const [checklistPayload, listPayload] = await Promise.all([
      api.get("/api/collect/checklists"),
      api.get(`/api/deals/${enc(ctx.dealId)}/collect`),
    ]);
    checklists = checklistPayload;
    requests = listPayload.requests || [];
  } catch (err) {
    replace(panel, el("div", { class: "section" }, sectionHead("Collection links"), notice(err.message || String(err), "neg")));
    return;
  }

  // Every item across every combination, so a request issued under one profile
  // still renders its labels after the profile changes.
  const itemsByKey = new Map();
  // Three nested axes — residency, employment, purchase type — flattened so a
  // request issued under any combination still renders its labels.
  const everyMortgageItem = Object.values(checklists.mortgage || {}).flatMap((byEmployment) =>
    Object.values(byEmployment || {}).flatMap((byPurchase) =>
      Array.isArray(byPurchase) ? byPurchase : Object.values(byPurchase || {}).flat(),
    ),
  );
  for (const item of [...everyMortgageItem, ...(checklists.acquisition || [])]) {
    if (!itemsByKey.has(item.key)) itemsByKey.set(item.key, item);
  }

  let mode = "list";
  let created = null;

  const refresh = async () => {
    const payload = await api.get(`/api/deals/${enc(ctx.dealId)}/collect`);
    requests = payload.requests || [];
    draw();
  };

  function draw() {
    const newButton = button("New link", {
      variant: "primary",
      iconName: "plus",
      onClick: () => {
        mode = "new";
        created = null;
        draw();
      },
    });

    const listSection = el(
      "div",
      { class: "section" },
      sectionHead(
        "Collection links",
        `${requests.length} link${requests.length === 1 ? "" : "s"} issued for this deal`,
      ),
      requests.length
        ? requestTable(ctx, requests, refresh)
        : empty(
            "No links yet",
            "Create one to send the buyer a checklist they can upload against without an account.",
          ),
      el("p", {
        class: "t-caption c-3 u-measure",
        css: { "margin-block-start": "var(--s-12)" },
        text:
          "The link itself is not stored — only its SHA-256. It cannot be shown again from this list; a lost link is re-issued, never retrieved.",
      }),
    );

    const top =
      mode === "new"
        ? el(
            "div",
            { class: "section" },
            newRequestForm(
              ctx,
              checklists,
              (result) => {
                created = result;
                mode = "created";
                // refresh() redraws once it has the new list, so the token
                // plate is painted exactly once and never replaced under the
                // user's cursor while they are copying the link.
                refresh().catch(() => draw());
              },
              () => {
                mode = "list";
                draw();
              },
            ),
          )
        : mode === "created" && created
          ? el(
              "div",
              { class: "section" },
              tokenPlate(created, () => {
                mode = "list";
                created = null;
                draw();
              }),
            )
          : el(
              "div",
              { class: "toolbar no-print" },
              el("span", { class: "t-label c-3", text: "Buyer document collection" }),
              el("span", {
                class: "t-caption c-3",
                text: "One link, one checklist, upload only. The buyer never gets an account.",
              }),
              el("div", { class: "spacer" }),
              newButton,
            );

    replace(
      panel,
      top,
      listSection,
      el(
        "div",
        { class: "section" },
        sectionHead("What has arrived", "By document type — see the note below"),
        coveragePanel(ctx, requests, itemsByKey),
      ),
    );
  }

  draw();
}
