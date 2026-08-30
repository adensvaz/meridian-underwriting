// DOM helpers. No framework, no template engine, no innerHTML for anything that
// came off the wire — deal names, extracted snippets, narrative text and
// filenames are all written by somebody who is not us.

const SVG_NS = "http://www.w3.org/2000/svg";

// Variadic, and it flattens: append(node, a, b) and append(node, [a, b]) both
// work, so callers never have to remember which shape this wants.
export function append(parent, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      append(parent, ...child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
  return parent;
}

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "css") {
        for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
      } else if (key === "on") {
        for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
      } else if (key === "value") node.value = value;
      else if (key === "checked" || key === "disabled" || key === "selected" || key === "multiple") {
        node[key] = Boolean(value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(node, children);
  return node;
}

export function svg(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.setAttribute("class", value);
      else if (key === "css") {
        for (const [prop, val] of Object.entries(value)) node.style.setProperty(prop, val);
      } else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------- icons --
// Hand-written, 1px stroke, currentColor. No emoji, no sparkles, no wands.

const ICON_PATHS = {
  file: ["M4 1.5h5l3 3v10H4z", "M9 1.5v3h3"],
  upload: ["M8 11.5V2.5", "M5 5.5 8 2.5l3 3", "M2.5 10v3.5h11V10"],
  plus: ["M8 3v10", "M3 8h10"],
  minus: ["M3 8h10"],
  caret: ["M4 6.5 8 10.5l4-4"],
  caretEnd: ["M6.5 4 10.5 8l-4 4"],
  check: ["M3.5 8.5 6.5 11.5 12.5 4.5"],
  back: ["M12.5 8h-9", "M7 3.5 2.5 8 7 12.5"],
  print: ["M4.5 6V2.5h7V6", "M4.5 12H2.5V6.5h11V12h-2", "M4.5 9.5h7v4h-7z"],
  signOut: ["M6.5 2.5h-4v11h4", "M10 5l3 3-3 3", "M13 8H6.5"],
  deals: ["M8 1.5 14.5 5 8 8.5 1.5 5z", "M1.5 8 8 11.5 14.5 8", "M1.5 11 8 14.5 14.5 11"],
  models: ["M2.5 2.5h5v5h-5z", "M8.5 2.5h5v5h-5z", "M2.5 8.5h5v5h-5z", "M8.5 8.5h5v5h-5z"],
  trash: ["M3 4.5h10", "M6.5 4.5v-2h3v2", "M4.5 4.5 5.2 14h5.6l.7-9.5"],
  rerun: ["M13.5 8a5.5 5.5 0 1 1-1.7-3.95", "M13.5 1.8v3.1h-3.1"],
  close: ["M4 4l8 8", "M12 4l-8 8"],
  open: ["M6.5 3.5h-3v9h9v-3", "M9.5 3.5h3v3", "M12.5 3.5 7.5 8.5"],
  search: ["M10.3 10.3 13.5 13.5"],
  tune: ["M2.5 5h11", "M2.5 11h11"],
  scan: ["M2.5 5V2.5H5", "M11 2.5h2.5V5", "M13.5 11v2.5H11", "M5 13.5H2.5V11", "M2.5 8h11"],
  ledger: ["M3.5 2.5h9v11h-9z", "M6 5.5h4", "M6 8h4", "M6 10.5h4"],
};

const ICON_EXTRA = {
  search: [["circle", { cx: 7, cy: 7, r: 4.5 }]],
  tune: [
    ["circle", { cx: 6, cy: 5, r: 1.6 }],
    ["circle", { cx: 10, cy: 11, r: 1.6 }],
  ],
};

// An SVG with no intrinsic size falls back to 300×150, so every icon carries
// width and height attributes. Component CSS (.btn svg, .nav-item svg) still
// wins, because a stylesheet beats a presentation attribute.
export function icon(name, size = 12) {
  const paths = ICON_PATHS[name] || [];
  const node = svg("svg", {
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  });
  for (const [tag, attrs] of ICON_EXTRA[name] || []) node.append(svg(tag, attrs));
  for (const d of paths) node.append(svg("path", { d }));
  return node;
}

// ------------------------------------------------------------------ gauges --
// 96 × 52. 1px arc, ticks every 5°, a 3px segment marking the covenant band,
// and a needle that arrives and stops.

const GAUGE_CX = 48;
const GAUGE_CY = 46;
const GAUGE_R = 40;

function gaugePoint(fraction, radius = GAUGE_R) {
  const theta = ((180 - fraction * 180) * Math.PI) / 180;
  return {
    x: GAUGE_CX + radius * Math.cos(theta),
    y: GAUGE_CY - radius * Math.sin(theta),
  };
}

// The dial spans exactly 180°, so no segment of it is ever a large arc. The
// large-arc flag stays 0; setting it would draw the complement — the 250° of
// circle that is not the gauge.
function arcPath(from, to, radius = GAUGE_R) {
  const a = gaugePoint(from, radius);
  const b = gaugePoint(to, radius);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)}A${radius} ${radius} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

/**
 * Build the threshold gauge for a benchmark. The domain is derived from the
 * thresholds themselves so a DSCR gauge and a net-yield gauge read alike.
 */
export function gauge(benchmark) {
  const { value, good, warn, direction, status } = benchmark;
  const higher = direction !== "lower";

  const anchors = [good, warn].filter((n) => typeof n === "number" && Number.isFinite(n));
  const span = anchors.length ? Math.max(...anchors.map(Math.abs)) : 1;
  const hi = Math.max(span * 1.6, typeof value === "number" ? Math.abs(value) * 1.15 : 0) || 1;
  const lo = 0;

  const toFraction = (n) =>
    typeof n === "number" && Number.isFinite(n) ? clamp01((n - lo) / (hi - lo)) : null;

  const node = svg("svg", {
    class: "gauge",
    viewBox: "0 0 96 52",
    fill: "none",
    "aria-hidden": "true",
    focusable: "false",
  });

  node.append(svg("path", { class: "gauge__arc", d: arcPath(0, 1) }));

  for (let deg = 0; deg <= 180; deg += 5) {
    const fraction = deg / 180;
    const major = deg % 30 === 0;
    const outer = gaugePoint(fraction, GAUGE_R);
    const inner = gaugePoint(fraction, GAUGE_R - (major ? 6 : 3));
    node.append(
      svg("line", {
        class: major ? "gauge__tick gauge__tick--major" : "gauge__tick",
        x1: outer.x.toFixed(2),
        y1: outer.y.toFixed(2),
        x2: inner.x.toFixed(2),
        y2: inner.y.toFixed(2),
      }),
    );
  }

  // The covenant band: the region in which the metric fails its threshold.
  const warnFraction = toFraction(warn);
  if (warnFraction !== null) {
    const from = higher ? 0 : warnFraction;
    const to = higher ? warnFraction : 1;
    if (to - from > 0.002) {
      node.append(svg("path", { class: "gauge__band", d: arcPath(from, to, GAUGE_R - 1.5) }));
    }
  }

  const goodFraction = toFraction(good);
  if (goodFraction !== null) {
    const from = higher ? goodFraction : 0;
    const to = higher ? 1 : goodFraction;
    if (to - from > 0.002) {
      node.append(
        svg("path", { class: "gauge__band gauge__band--pos", d: arcPath(from, to, GAUGE_R - 1.5) }),
      );
    }
  }

  const needle = svg("line", {
    class: "gauge__needle",
    x1: GAUGE_CX,
    y1: GAUGE_CY,
    x2: GAUGE_CX,
    y2: GAUGE_CY - GAUGE_R + 4,
  });
  node.append(needle);
  node.append(svg("circle", { class: "gauge__hub", cx: GAUGE_CX, cy: GAUGE_CY, r: 2 }));

  const degreesFor = (n) => {
    const fraction = toFraction(n);
    return fraction === null ? -90 : fraction * 180 - 90;
  };

  // The needle travels once, on a 700ms mechanical curve with zero overshoot.
  // A later reading moves the same needle rather than rebuilding the dial.
  needle.style.setProperty("--deg", "-90");
  node.setValue = (n) => needle.style.setProperty("--deg", String(degreesFor(n)));

  // A microtask, not a frame callback: requestAnimationFrame does not run in a
  // backgrounded tab, and a needle that never leaves the peg is worse than one
  // that does not animate at all.
  queueMicrotask(() => {
    void node.getBoundingClientRect();
    node.setValue(value);
  });

  if (status) node.setAttribute("data-status", status);
  return node;
}

// -------------------------------------------------------------- page plate --
// An inline-SVG schematic of a document: ~22 horizontal rules standing in for
// text lines, plus a denser block for a table. This is the image people
// describe to colleagues.

const PLATE_W = 260;
const PLATE_H = 328;

// Deterministic widths — the plate must look identical on every run, because a
// schematic that reshuffles reads as decoration rather than as the document.
function pseudoRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * @param {number} scanStartMs when the scan line begins its pass
 * @param {number} scanDurMs   how long the pass takes
 * @param {number} stageH      the height of .pp-stage in px
 * @param {number} padTop      the stage's block padding in px
 */
export function pagePlate({ scanStartMs = 640, scanDurMs = 2400, stageH = 360, padTop = 16 } = {}) {
  const random = pseudoRandom(20260830);
  const node = svg("svg", {
    class: "pp",
    viewBox: `0 0 ${PLATE_W} ${PLATE_H}`,
    preserveAspectRatio: "xMidYMin meet",
    fill: "none",
    "aria-hidden": "true",
    focusable: "false",
  });

  node.append(
    svg("rect", { class: "pp__frame", x: 0.5, y: 0.5, width: PLATE_W - 1, height: PLATE_H - 1 }),
  );

  // The moment the scan line reaches a given y, in ms from sequence start.
  const at = (y) => Math.round(scanStartMs + ((y + padTop) / stageH) * scanDurMs);

  const addLine = (x1, x2, y, cls) =>
    node.append(
      svg("line", {
        class: cls,
        x1,
        x2,
        y1: y,
        y2: y,
        css: { "--at": `${at(y)}ms` },
      }),
    );

  // Masthead
  addLine(24, 150, 26, "pp__rule");
  addLine(24, 104, 36, "pp__line");

  // Body copy — 12 rules of varying width.
  let y = 56;
  for (let i = 0; i < 12; i++) {
    const width = 120 + Math.round(random() * 92);
    addLine(24, 24 + width, y, "pp__line");
    y += 10;
  }

  // The table block — denser, ruled, four columns.
  const tableTop = y + 14;
  node.append(
    svg("rect", {
      class: "pp__rule",
      x: 24,
      y: tableTop,
      width: PLATE_W - 48,
      height: 12,
      css: { "--at": `${at(tableTop)}ms` },
    }),
  );

  const cols = [24, 96, 148, 196, PLATE_W - 24];
  for (let r = 0; r < 8; r++) {
    const rowY = tableTop + 12 + r * 11;
    for (let c = 0; c < 4; c++) {
      const pad = 4;
      node.append(
        svg("line", {
          class: "pp__cell",
          x1: cols[c] + pad,
          x2: cols[c + 1] - pad - (c === 0 ? 0 : Math.round(random() * 12)),
          y1: rowY + 6,
          y2: rowY + 6,
          css: { "--at": `${at(rowY + 6)}ms` },
        }),
      );
    }
  }

  // Closing paragraph.
  let tail = tableTop + 12 + 8 * 11 + 16;
  for (let i = 0; i < 5 && tail < PLATE_H - 16; i++) {
    const width = 110 + Math.round(random() * 100);
    addLine(24, 24 + width, tail, "pp__line");
    tail += 10;
  }

  return node;
}

// ------------------------------------------------------------ small pieces --

export function pill(text, tone) {
  return el(
    "span",
    { class: `pill${tone ? ` pill--${tone}` : ""}` },
    el("span", { class: "pill__dot" }),
    el("span", { text }),
  );
}

export function tag(text, variant) {
  return el("span", { class: `tag${variant ? ` tag--${variant}` : ""}`, text });
}

export function dpair(key, valueNode) {
  return el(
    "div",
    { class: "dpair" },
    el("span", { class: "dpair__k", text: key }),
    el("span", { class: "dpair__v" }, valueNode),
  );
}

export function sectionHead(title, note) {
  return el(
    "div",
    { class: "section__head" },
    el("h2", { class: "section__title t-label", text: title }),
    note ? el("span", { class: "section__note t-caption", text: note }) : null,
  );
}

export function empty(title, body, action) {
  return el(
    "div",
    { class: "empty" },
    el("div", { class: "empty__title", text: title }),
    el("p", { class: "empty__body", text: body }),
    action ? el("div", { class: "empty__act" }, action) : null,
  );
}

export function button(label, { variant = "secondary", size, iconName, onClick, type = "button", disabled } = {}) {
  const node = el("button", {
    class: `btn btn--${variant}${size ? ` btn--${size}` : ""}`,
    type,
    disabled,
    "aria-label": label,
    on: onClick ? { click: onClick } : undefined,
  });
  if (iconName) node.append(icon(iconName));
  node.append(el("span", { text: label }));
  return node;
}

/** Swap a button into its loading state — three pulsing squares, never a ring. */
export function setLoading(btn, loading, label) {
  if (loading) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    const text = label || btn.dataset.label;
    btn.classList.add("btn--loading");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.setAttribute("aria-label", text);
    clear(btn);
    btn.append(el("span", { class: "btn__load" }, el("i"), el("i"), el("i")), el("span", { text }));
  } else {
    const text = label || btn.dataset.label || "";
    btn.classList.remove("btn--loading");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.setAttribute("aria-label", text);
    clear(btn);
    btn.append(el("span", { text }));
  }
  return btn;
}

/**
 * A non-blocking message rail under a page head. Not a toast: it does not
 * slide, it does not stack, and it does not disappear on a timer.
 */
export function notice(message, tone = "neu") {
  return el(
    "div",
    { class: "flag" + (tone === "neg" ? "" : ` flag--${tone === "pos" ? "strength" : tone === "cau" ? "caution" : "dd"}`) },
    el("div", { class: "flag__title", text: tone === "neg" ? "Problem" : tone === "cau" ? "Warning" : "Note" }),
    el("p", { class: "flag__body", text: message }),
  );
}

export function ruleDraw() {
  return el("div", { class: "rule rule--draw" });
}
