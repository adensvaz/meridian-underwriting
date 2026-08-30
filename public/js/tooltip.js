// Plain English, on demand.
//
// Every input and every computed line in a model carries `help` text written
// for somebody who does not underwrite for a living. Until now the UI rendered
// none of it, so "Debt burden ratio" arrived on screen as jargon aimed at
// exactly the reader least equipped to decode it.
//
// This surfaces that text without adding anything to the page at rest. The only
// affordance is a 1px dotted underline under a label that was already there;
// the explanation itself lives in one shared popover that is invisible until
// asked for. Nothing new is drawn, nothing moves, nothing is coloured.
//
// Three constraints shape the implementation more than taste does:
//
//   1. `style-src 'self'` is on, and this app has an open defect where every
//      `element.style.setProperty()` is blocked silently — the write appears to
//      succeed in JS and never reaches the pixels. So the popover's position is
//      written through a *constructed stylesheet* (`replaceSync` on a sheet in
//      `document.adoptedStyleSheets`), which CSP does not police because there
//      is no inline source to check. Verified in the browser, not assumed.
//   2. The trigger is a real `<button>` in the tab order with `aria-describedby`
//      pointing at the popover, so this works for a keyboard, a screen reader
//      and a broker tapping an iPad — not only for a mouse hovering.
//   3. Help text is model-authored content arriving over the wire. It goes in
//      through `textContent`. Never `innerHTML`, not once, not for anything.

const POPOVER_ID = "help-popover";

/** Keep-out from the viewport edge, and the gap between trigger and popover. */
const GUTTER = 8;
const OFFSET = 6;

let popover = null;
let sheet = null;
let openTrigger = null;
/** True when the reader committed — clicked or tapped — rather than passed over. */
let pinned = false;
/** Where the trigger sat when the popover was placed. See onViewportShift. */
let anchor = null;

/**
 * A label that explains itself.
 *
 * With no help text this is exactly the element the caller would have written
 * by hand, so a model line that carries no `help` costs nothing: no button, no
 * underline, no listener, no change in the DOM at all.
 */
export function helpLabel(tag, className, text, help) {
  if (!help) {
    const plain = document.createElement(tag);
    if (className) plain.className = className;
    plain.textContent = text;
    return plain;
  }

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = className ? `${className} tip` : "tip";
  trigger.textContent = text;
  attachHelp(trigger, help);
  return trigger;
}

/**
 * Wires an existing `<button>` as a help trigger. Exported for the cases where
 * the caller already owns the element and only needs the behaviour.
 */
export function attachHelp(trigger, help) {
  if (!help) return trigger;

  const text = String(help);

  trigger.addEventListener("pointerenter", (event) => {
    // A tap fires pointerenter too. Let `click` own that gesture, so a tap does
    // not open and immediately toggle shut.
    if (event.pointerType === "touch") return;
    if (!pinned) open(trigger, text, false);
  });

  trigger.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "touch") return;
    if (openTrigger === trigger && !pinned) close();
  });

  // Focus is the keyboard's hover. It opens unpinned so that tabbing away
  // closes it, which is what a keyboard reader expects.
  trigger.addEventListener("focus", () => {
    if (openTrigger !== trigger) open(trigger, text, false);
  });

  trigger.addEventListener("blur", () => {
    if (openTrigger === trigger && !pinned) close();
  });

  // Click and tap both land here. A committed open stays open until dismissed.
  trigger.addEventListener("click", () => {
    if (openTrigger === trigger && pinned) close();
    else open(trigger, text, true);
  });

  return trigger;
}

// ------------------------------------------------------------------ popover --

function ensurePopover() {
  if (popover) return popover;

  popover = document.createElement("div");
  popover.id = POPOVER_ID;
  popover.className = "help-pop t-caption";
  popover.setAttribute("role", "tooltip");
  document.body.appendChild(popover);

  // The only channel for a dynamic style write that survives `style-src 'self'`.
  // If the browser has no constructed-stylesheet support the popover keeps its
  // stylesheet default — pinned to the block-end of the viewport — which is
  // legible and in-frame everywhere, just not anchored.
  if (typeof CSSStyleSheet === "function") {
    try {
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      sheet = null;
    }
  }

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  // A popover anchored to a rect that has moved is worse than no popover.
  window.addEventListener("scroll", onViewportShift, true);
  window.addEventListener("resize", onViewportShift);

  return popover;
}

function open(trigger, text, commit) {
  const pop = ensurePopover();

  if (openTrigger && openTrigger !== trigger) openTrigger.removeAttribute("aria-describedby");

  // Model-authored content. textContent, always.
  pop.textContent = text;
  openTrigger = trigger;
  pinned = commit;

  // Measured while the popover is laid out at the stylesheet's default corner
  // with its measure already capped, so the reading is stable before it is
  // placed. Then position, then reveal — never the other way round, or the
  // first frame paints in the wrong place.
  place(trigger, pop);
  pop.classList.add("is-open");

  // One shared popover means the description must follow the trigger rather
  // than sit on all of them at once, where it would describe whichever label
  // was read last.
  trigger.setAttribute("aria-describedby", POPOVER_ID);
}

function close() {
  if (!openTrigger) return;
  openTrigger.removeAttribute("aria-describedby");
  openTrigger = null;
  pinned = false;
  anchor = null;
  if (popover) popover.classList.remove("is-open");
}

/**
 * Closes on a scroll or resize that actually moved the label — not on the one
 * the browser itself performs.
 *
 * Tabbing to an off-screen trigger scrolls it into view and *then* fires focus,
 * so the scroll event lands after the popover is already placed. Closing
 * unconditionally would mean a keyboard reader could never reach an explanation
 * below the fold: it would open and vanish in the same frame. Comparing the
 * trigger's rect against where it sat when placed distinguishes the browser's
 * own scroll (no movement left to observe) from the reader's (movement).
 */
function onViewportShift() {
  if (!openTrigger || !anchor) return;
  const rect = openTrigger.getBoundingClientRect();
  if (rect.top === anchor.top && rect.left === anchor.left) return;
  close();
}

/**
 * Anchored under the label, flipped above when the page runs out, and clamped
 * so it can never leave the viewport — the case that matters is a broker
 * holding an iPad at 375px, where an unclamped popover walks straight off the
 * inline edge.
 */
function place(trigger, pop) {
  const rect = trigger.getBoundingClientRect();
  anchor = { top: rect.top, left: rect.left };
  if (!sheet) return;

  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let top = rect.bottom + OFFSET;
  if (top + height > vh - GUTTER) {
    const above = rect.top - OFFSET - height;
    top = above >= GUTTER ? above : Math.max(GUTTER, vh - GUTTER - height);
  }

  // Logical, so this is still correct in Arabic. `inset-inline-start` measures
  // from the right edge under RTL, which is what the trigger's own start edge
  // is there too.
  const rtl = getComputedStyle(document.documentElement).direction === "rtl";
  const wanted = rtl ? vw - rect.right : rect.left;
  const limit = Math.max(GUTTER, vw - GUTTER - width);
  const start = Math.min(Math.max(wanted, GUTTER), limit);

  sheet.replaceSync(
    `#${POPOVER_ID}{inset-block-start:${Math.round(top)}px;inset-inline-start:${Math.round(start)}px}`,
  );
}

function onKeydown(event) {
  if (event.key !== "Escape" || !openTrigger) return;
  const trigger = openTrigger;
  close();
  // Escape must not strand the focus ring on an element whose description just
  // vanished.
  trigger.focus();
}

function onPointerDown(event) {
  if (!openTrigger) return;
  if (openTrigger.contains(event.target)) return;
  close();
}
