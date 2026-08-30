# Journal

Append one line per Ralph iteration: date, item, outcome, evidence. Do not
rewrite earlier entries.

---

2026-08-30 — Initial build. Engine, auth, data layer, document parsing, AI
extraction and narrative, API, four shipped underwriting models, design system,
front end, six seeded demo deals.

Verified: `npm run check` 18/18 · `npm run smoke` 28/28 over real HTTP ·
`npm run test` 85/85 · all four page routes serve 200 with no server errors ·
six seeded deals compute gross yields matching hand-checked targets exactly
(7.43 / 6.36 / 5.16 / 8.61 / 8.02 / 8.45%) · 112/112 provenance snippets found
verbatim in stored document text.

Defects found and fixed during the build, recorded because each one looked like
working software from the outside:

- Prototype pollution in the formula engine: `constructor` resolved through
  `Object.prototype` and evaluated instead of being rejected. Same flaw in the
  operator table, the function table and the static MIME map. All lookups now go
  through `Object.hasOwn`.
- `pdf-parse` silently mis-parsing every small PDF. Node pools Buffers under
  4 KB into a shared 64 KB slab; pdf.js re-wraps the typed array as
  `new value.constructor(value.buffer)`, producing a view over the whole pool,
  so xref offsets landed on unrelated memory. Every small PDF would have been
  reported as "scanned". Fixed by copying into a Uint8Array that owns its buffer.
- Model input keys not matching the platform's rent-roll derivation keys, so
  uploaded figures silently fell back to model defaults — a plausible number on
  screen with no relationship to the document. Fixed with an explicit
  `derivedFrom` binding, plus coalescing total-valued inputs for the three
  models whose income inputs are rates rather than totals.
- Streaming a document file crashed the process. The router checked
  `writableEnded`, which is still false while a file pipes, so it wrote a second
  set of headers onto a committed response. Now checks `headersSent`, and both
  file streams handle their own errors.
- `??` mixed with `&&` without parentheses — rejected by Node's type stripper,
  so the server did not boot at all.
- Flag prose guessed at number format, rendering a DSCR of 0.99 as "98.8%x", and
  due-diligence text was never interpolated so it emitted a raw
  `{dscr_covenant}` placeholder into the memo.
- A shipped formula used as placeholder text in the model editor, readable from
  the static bundle without an account.
- Container queries that targeted their own container, so no panel ever
  collapsed responsively; and a spacing token that did not exist, silently
  voiding eight declarations.

Next: work the backlog in `ralph/fix_plan.md`, top item first. The extraction
accuracy harness is the top item and should stay there — no accuracy claim can
be made until it exists.
