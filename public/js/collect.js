// The buyer's upload page.
//
// This is the only page in the product used by someone who is not a customer.
// It is therefore written for a stressed person on a phone who was sent a link
// by their mortgage broker and has no idea what any of this is: one screen, no
// account, no jargon, and each row tells them exactly what to send and why.
//
// The token lives in the URL. Everything here is upload-only — there is no
// endpoint this page could call that would read a file back.

const token = location.pathname.split("/").filter(Boolean).pop() ?? "";

const el = (id) => document.getElementById(id);

function showState(title, body) {
  el("plate").hidden = true;
  const state = el("state");
  state.hidden = false;
  el("stateTitle").textContent = title;
  el("stateBody").textContent = body;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.25");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  if (name === "tick") p.setAttribute("d", "M3 8.5l3.2 3.2L13 5");
  else if (name === "plus") p.setAttribute("d", "M8 3.5v9M3.5 8h9");
  else p.setAttribute("d", "M8 1.8l6 3v4c0 3.2-2.4 5-6 5.4-3.6-.4-6-2.2-6-5.4v-4z");
  svg.appendChild(p);
  return svg;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

// One row per requested document. State lives on the row, not in a global,
// so an upload failing for one item never disturbs another.
function buildRow(item, maxMb) {
  const li = document.createElement("li");
  li.className = "checklist__item";
  li.dataset.key = item.key;

  const head = document.createElement("div");
  head.className = "checklist__head";

  const label = document.createElement("span");
  label.className = "checklist__label";
  label.textContent = item.label;
  head.appendChild(label);

  if (!item.required) {
    const opt = document.createElement("span");
    opt.className = "checklist__optional";
    opt.textContent = "if you have it";
    head.appendChild(opt);
  }

  const hint = document.createElement("p");
  hint.className = "checklist__hint";
  hint.textContent = item.hint;

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.className = "checklist__input";
  input.id = `f_${item.key}`;
  // Deliberately permissive: a buyer photographing an Emirates ID on a phone
  // produces a HEIC, and rejecting it at the picker is a support call.
  input.accept = ".pdf,.jpg,.jpeg,.png,.heic,.webp,.xlsx,.xls,.csv,.doc,.docx";

  const button = document.createElement("label");
  button.className = "btn btn--secondary checklist__btn";
  button.setAttribute("for", input.id);
  button.appendChild(icon("plus"));
  button.appendChild(document.createTextNode(" Choose files"));

  const status = document.createElement("p");
  status.className = "checklist__status";

  input.addEventListener("change", () => {
    if (input.files && input.files.length) send(item, input.files, li, status, button);
  });

  li.append(head, hint, button, input, status);
  return li;
}

async function send(item, files, row, status, button) {
  const form = new FormData();
  let tooBig = null;
  for (const file of files) {
    if (file.size > maxBytes) {
      tooBig = file.name;
      break;
    }
    form.append(item.key, file, file.name);
  }
  form.append(`${item.key}_item`, item.key);

  if (tooBig) {
    row.dataset.state = "error";
    status.textContent = `"${tooBig}" is larger than ${maxMb} MB. Try photographing it at a lower resolution, or send it as a PDF.`;
    return;
  }

  row.dataset.state = "sending";
  status.textContent = `Sending ${files.length} file${files.length === 1 ? "" : "s"}…`;
  button.setAttribute("aria-disabled", "true");

  try {
    const res = await fetch(`/api/collect/${encodeURIComponent(token)}/documents`, {
      method: "POST",
      body: form,
    });
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      row.dataset.state = "error";
      status.textContent = data?.error ?? "That did not send. Check your connection and try again.";
      button.removeAttribute("aria-disabled");
      return;
    }

    row.dataset.state = "done";
    const head = row.querySelector(".checklist__head");
    if (head && !head.querySelector(".checklist__tick")) {
      const tick = document.createElement("span");
      tick.className = "checklist__tick";
      tick.appendChild(icon("tick"));
      head.appendChild(tick);
    }
    const names = (data?.files ?? []).join(", ");
    status.textContent = names ? `Received: ${names}` : data?.message ?? "Received.";
    button.textContent = "";
    button.appendChild(icon("plus"));
    button.appendChild(document.createTextNode(" Add another"));
    button.removeAttribute("aria-disabled");

    // A scanned document still uploads; the warning tells the buyer why they
    // may be asked again rather than leaving them to find out later.
    if (Array.isArray(data?.warnings) && data.warnings.length) {
      const warn = document.createElement("p");
      warn.className = "checklist__warn";
      warn.textContent = data.warnings[0];
      row.appendChild(warn);
    }
  } catch {
    row.dataset.state = "error";
    status.textContent = "That did not send. Check your connection and try again.";
    button.removeAttribute("aria-disabled");
  }
}

let maxMb = 40;
let maxBytes = 40 * 1024 * 1024;

async function start() {
  if (!token) {
    showState("This link is not valid", "Ask whoever sent it to you for a new one.");
    return;
  }

  let data;
  try {
    const res = await fetch(`/api/collect/${encodeURIComponent(token)}`);
    data = await res.json().catch(() => null);
    if (!res.ok) {
      showState(
        "This link is not valid",
        data?.error ?? "It may have expired. Ask whoever sent it to you for a new one.",
      );
      return;
    }
  } catch {
    showState("Could not load this page", "Check your connection and refresh.");
    return;
  }

  maxMb = data.maxFileMb ?? 40;
  maxBytes = maxMb * 1024 * 1024;

  el("firm").textContent = data.firmName ?? "Your adviser";
  el("title").textContent = data.recipientName
    ? `${data.recipientName}, please send these documents`
    : "Please send these documents";

  const who = data.requestedBy ? `${data.requestedBy} at ${data.firmName}` : data.firmName;
  const ref = data.reference ? ` for ${data.reference}` : "";
  el("lede").textContent =
    `${who} needs the following${ref} to assess your mortgage. ` +
    `You do not need an account — choose each file below and it sends straight away. ` +
    `A clear photo taken on your phone is fine for most of these.`;

  if (data.message) {
    const note = el("message");
    note.hidden = false;
    note.textContent = data.message;
  }

  const list = el("checklist");
  for (const item of data.checklist ?? []) list.appendChild(buildRow(item, maxMb));

  el("expiry").textContent = `This link stops working on ${formatDate(data.expiresAt)}.`;
}

start();
