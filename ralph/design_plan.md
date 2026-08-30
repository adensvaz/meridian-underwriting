# Meridian — design backlog

Ordered by how much each changes the felt quality of the product. Every item
either removes something or makes one existing thing more deliberate. Nothing
here adds ornament — see `docs/CINEMATIC.md` §1.

## Composition

- [x] **The dominant figure.** On the Underwriting tab, price per square foot is
      currently one tile among equals. Promote it: `clamp(64px, 9vw, 132px)`,
      weight 200, `letter-spacing: -0.045em`, set on the left third with at
      least 80px of air on three sides, supporting metrics ranged right. Every
      other tile drops a step in weight to make room. If two things shout,
      neither is heard.
- [x] **Full-bleed section rules.** Dividers currently stop at the container.
      Let them run to the viewport edge. A rule that leaves the frame implies
      the composition continues; one that stops politely implies a box. Single
      cheapest cinematic cue in the system.
- [x] **Un-border the rail.** Remove the left rail's inline-end border and let
      the background step carry the separation. Borders make panels; light makes
      space.
- [x] **The label above the figure.** Move KPI eyebrows above their value with
      12px of space, 10px, `+0.18em`, `--text-3`, mono. The eye should read the
      label then fall into the number. Reversed, the number arrives
      context-free.

## Light

- [x] **Commit to one source.** Add `inset 0 -1px 0 rgba(0,0,0,.25)` to raised
      surfaces so bottom edges fall away, matching the existing top-edge catch.
      Their absence is why plates read as flat rectangles rather than objects.
      Nothing is ever lit from below.
- [x] **The hero light pool.** Behind the dominant figure only:
      `radial-gradient(120% 80% at 20% 0%, rgba(255,255,255,.028), transparent 60%)`.
      At 2.8% it sits below conscious perception — the figure reads as lit, not
      printed. Once per screen. This is the only gradient permitted anywhere.

## Typography

- [x] **Set the hero properly.** Weight 200 at the largest size (300 reads heavy
      past 100px), `-0.045em` tracking, currency prefix at `0.28em` on the cap
      line in `--text-3`, decimals at `0.5em`. The integer carries the meaning.
- [x] **Collapse the middle of the scale.** A screen should use three voices:
      hero, body, label. Audit each screen and demote anything using
      `display-l` or `title` where `body` would do. Ten sizes is a committee.
- [x] **The verdict line.** The narrative headline currently sets like body
      copy. Give it `display-l` at weight 200, measure capped at 34ch, alone
      above a full-bleed hairline with 56px above and below. It is the one
      sentence a principal actually reads.

## Colour

- [x] **Desaturate the healthy state.** Remove green from passing benchmarks and
      positive flags. Health is the absence of alarm, not the presence of green.
      Caution and negative keep their colour and become the only chromatic
      things on screen — one amber rule on a grey page is deafening.
      Test: desaturate a screenshot of a healthy deal. Nothing should change.

## Time

- [x] **Re-cut the underwriting reveal.** Lengthen the empty hold to 400ms.
      Order the arrival by meaning rather than position: hero figure alone for
      300ms, then its baseline rule draws, then everything else at 50ms
      intervals. Nothing moves after it lands — no settling, no secondary
      animation.
- [x] **One breath on sign-in.** After authentication, before the app: the
      wordmark alone on black for 700ms, then rail and canvas draw in. Once per
      session, never again — a title card that repeats is an annoyance. Store
      the flag in `sessionStorage`.
- [x] **Section headings assemble.** → **ICEBOXED, deliberately.** Three
      reasons, in order of weight. (1) Sections are rebuilt on every tab render,
      so "draws on first paint" means it draws on every tab click — which is a
      nav transition, which `DESIGN.md` §4 forbids outright and which this very
      file's icebox already rejects as latency theatre. (2) Scoped instead to
      once per session, it becomes a second, weaker copy of the sign-in breath,
      which already assembles the entire shell rather than just its rules; two
      assembly mechanics is *more*, which is the trap `CINEMATIC.md` §1 names.
      (3) The spec asks for `--hairline-strong` at rest, but section heads sit at
      `--hairline` precisely so the page head at `--hairline-strong` outranks
      them — promoting every section rule would flatten the hierarchy that the
      full-bleed change just made legible. The page already assembles itself
      once, at the only moment it means anything: arrival.

## Sweep

- [x] **Anti-pattern sweep across every screen**, including the new sensitivity,
      solver, collect and mortgage screens: no gradient beyond the hero pool, no
      glow, no card shadow, no radius over 6px, no emoji, no spinner, no
      shimmer, no hover lift, no bounce.
- [x] **The buyer page deserves the same care.** `collect.html` is the only
      screen a non-customer sees, and it is currently the plainest. It should
      feel like the firm that sent it — same light, same restraint, wider
      measure. It is a brand impression before it is a form.
- [x] **Light mode is not an afterthought.** Every change above must be checked
      in paper mode. The hero light pool inverts to a shadow pool; the
      bottom-edge fall-away weakens. Verify both, do not assume.

## Found while working

- [x] ~~The disabled button is unreadable in both themes.~~ **Withdrawn — not
      real.** The mid-grey slabs I saw over buttons and ledger inputs were a
      screenshot-capture artifact: the browser pane repaints native form
      controls late after a `prefers-color-scheme` switch, so a capture taken
      immediately after the switch shows UA defaults. Confirmed by reading
      computed styles (`.field__well` was `#FFFFFF`, not grey) and by
      re-capturing after a clean document load. `.btn:disabled` is
      `--bg-200` + `--text-4`, which is what `DESIGN.md` §1 assigns to
      disabled. Method note: always capture after a fresh navigation, never
      straight after `resize_window`.
- [ ] **The deal list has no subject either.** Nine rows in a bordered plate with
      a filter bar; the `STATUS` column is clipped at 1280 and the whole table is
      one undifferentiated block. Apply the same treatment: un-box the plate, let
      the table rules bleed, and let the page head carry the frame.
- [ ] **The styleguide is a dead page and violates the CSP.** `index.html` ends
      with an inline `<script>` that `script-src 'self'` blocks silently, so the
      colour swatches (`#sw-ground`, `#sw-struct`, `#sw-text`, `#sw-sem`) render
      empty and the theme toggle, "Reset states" and "Replay motion" do nothing.
      Fix: move the script verbatim to `public/js/styleguide.js` and load it with
      `<script type="module" src="/js/styleguide.js">`. This is exactly the
      failure mode the design prompt warns about, sitting in the design system's
      own reference page.
- [ ] **145 inline `style="..."` attributes in `index.html`** each trip
      `style-src 'self'`, producing ~30 console errors on the styleguide. Most
      are one-off specimen tweaks (`--i`, `--at`, `margin-block-start`). Fold the
      repeated ones into utility classes and move the specimen-specific ones into
      a small `sg-*` block. Product pages are already clean — `app.html`,
      `login.html`, `models.html` and `collect.html` have zero inline styles
      between them.
- [ ] **Two seed deals render as bare community codes.** `JVC` and `QAl` show an
      em dash for every figure and no community. Not a design fault — flag to the
      correctness loop rather than styling around it.

## Icebox

- Animated page transitions. Nav should be instant; motion between routes is
  latency theatre.
- A custom typeface. No downloaded assets, and the system stacks are correct.
- Dark/light auto-switching on time of day. Cute, and it would fight the
  viewer's explicit choice.

## Explain every field (round 2)

The audience is not a finance person. Every label on screen — "Debt burden
ratio", "Loan to value achieved", "Binding constraint" — is jargon to the person
who most needs to understand it. Every input and every summary line on the
mortgage model now carries plain-English `help` text, and the UI renders none of
it.

- [ ] **Surface `help` as a tooltip on every metric and field label.** The data
      is already there — `ComputedValue.help` and `InputDef.help` come through
      the API on every line. Attach it to the KPI tile eyebrow, the computed-line
      rows, the review-screen field labels and the assumptions panel.
      Requirements, all binding:
      - Trigger on **hover AND focus AND tap**. A broker on an iPad must get it.
      - Keyboard reachable: the trigger is a real `<button>` in the tab order
        with `aria-describedby`, not a `title` attribute and not a `div`.
      - Dismiss on Escape and on outside click.
      - Positioned so it never leaves the viewport at 375px.
      - Restrained per `DESIGN.md`: a 1px dotted underline on the label as the
        only affordance, popover on `--bg-300` with a hairline, `caption` type,
        measure capped at 44ch. No icon, no question-mark circle, no animation
        beyond a 90ms fade.
- [ ] **A plain-language subtitle under each headline metric.** The tooltip is
      for the curious; the tile should carry a short line for everyone. Six to
      ten words under the value — "the most a bank will lend", "everything
      needed in cash on the day". Derive it from the first clause of `help`
      rather than authoring a second copy that can drift.
- [ ] **`Tenure not set` appears on a mortgage case.** Visible in the deal
      header beside "Dubai Marina · Mortgage". Tenure is a property-title
      concept and means nothing for a buyer assessment. Suppress the whole
      metadata item when the deal's asset type is `mortgage`, rather than
      printing "not set".
- [ ] **Group labels need the same treatment.** "Borrowing capacity",
      "Cash to complete", "Affordability" head the computed sections and are
      not self-explanatory to a first-time reader.
