# Meridian — design journal

One line per iteration. The three questions, what changed, and what was removed.
Answers are the reasoning, not ceremony. See `docs/CINEMATIC.md` §8.

---

**01 · The dominant figure** (Underwriting, `Marisol Residences, JVC`) —
*Subject?* Everything, therefore nothing: six identical bordered plates in an
even grid, the hero at 56px against 28px neighbours, each plate drawing its own
competing rectangle. *Light?* Nowhere — the `--glint` top edge was there but the
border and fill around it cancelled it, so the plates read as printed
rectangles. *Remove?* The plate. All six of them. **Changed:** `.kpi` lost its
background, border, radius and box-shadow and keeps only the baseline rule it
already had (`.kpi::after`) — the CSS comment claimed "the tile is ruled, not
boxed in" and had never been true. `.band` became a composition rather than a
grid of equals: the dominant figure holds a 44fr left column, the supporting
metrics are ranged right as one group in a new `.band__support` container (the
one structural JS addition), and the space beneath the figure is left empty. The
hero went to `clamp(64px, 9cqi, 132px)` / weight 200 / `-0.045em`; every
supporting figure dropped a step to weight 300. **Removed:** six card borders,
six card fills, six box-shadows, the tiles' inner padding, and the "HEADLINE"
section eyebrow — the model key it carried is already stated twice in the
toolbar directly above it, so it was a label on a label. **Deviation:** the plan
said `9vw`; used `9cqi` instead, because the figure is constrained by its panel,
not the viewport — the rail and page padding are not the figure's business, and
`layout.css` already prefers container queries over viewport media queries.

**02 · Full-bleed section rules** (all app screens) — *Subject?* The hero, now
correctly. *Light?* Still nowhere; that is the next block of items. *Remove?*
The container edge that every divider stopped politely at. **Changed:**
`.page-head` and `.section__head` take `margin-inline: calc(var(--page-px) * -1)`
and add the inset back as padding, so the rule leaves the frame while the
content stays on the page grid. Measured: the head now spans the canvas exactly
(x220 w1060 in a 1280 viewport) with `scrollWidth === clientWidth`, so nothing
overflows. Heads inside a `.plate`, an `.overlay` or a styleguide specimen are
explicitly excluded — a head on a surface belongs to that surface.
**Removed:** the two 32px stubs at either end of every divider in the product.
**Incidental:** stylesheet and entry-script links in `public/*.html` now carry a
`?v=` token. The static server sends `max-age=300` on non-HTML, which made every
CSS edit invisible for five minutes and would have made this loop unverifiable;
the token is the smallest fix inside the files I own and no build step.

**03 · Un-border the rail** (shell, every screen) — *Subject?* The hero.
*Light?* Still nowhere. *Remove?* The 1px seam down the inline-end of the rail,
which was doing the same job as the `--bg-000`→`--bg-100` step and doing it
worse: the step reads as depth, the hairline reads as a panel edge.
**Changed:** dropped `border-inline-end` from `.rail`, and the mirroring
`border-inline-start` from `.inspector` so the system does not contradict itself
on the opposite edge. **Removed:** two hairlines; nothing added. Verified in
both themes — the light-mode step (#E9E7E2 against #F2F0EC) still separates
cleanly without the rule.

**04 · The label above the figure** (KPI band) — *Subject?* The hero. *Light?*
Nowhere yet. *Remove?* One more voice from the type scale. The eyebrow was
already above its value, so this was about making it deliberate rather than
moving it. **Changed:** `.kpi__label` from 11px sans `+0.14em` to 10px mono
`+0.18em` at `--text-3`, and the label-to-figure gap from 8px to 12px on every
tile (the hero's bespoke 12px override is now redundant and gone). A 10px
tracked-out mono legend over a hairline-thin numeral is the whole typographic
idea in `CINEMATIC.md` §3. **Removed:** the `label` (11px) voice from this
component — it now shares `micro` with the rest of the system's legends — and
one redundant CSS override.

**05 · Commit to one source** (every raised surface, both themes) — *Subject?*
The hero. *Light?* Above and slightly behind the viewer — for the first time
consistently. Until now only the top edge agreed with that, and one edge
catching light with nothing answering it is why plates read as printed
rectangles rather than objects. *Remove?* Nothing left that is easy on this
axis; the fix was to complete a statement the system had already half-made.
**Changed:** `--glint` is now
`inset 0 1px 0 var(--hairline-glint), inset 0 -1px 0 var(--edge-fall)`. Because
18 surfaces already reference that one token, the whole product committed in a
single edit — no new rule, no new element, no per-component work. `--edge-fall`
is `rgba(0,0,0,.25)` on the instrument and `rgba(31,28,22,.07)` on paper: 25%
black on `#FBFAF8` would read as a border, which is exactly what the light
source is meant to replace. Nothing is lit from below anywhere.
**Removed:** the one hard-coded copy of the glint (`collect.css` was inlining
`inset 0 1px 0 var(--hairline-glint)` instead of using the token, so the buyer
page would have been the single surface left disagreeing with the light).
**Correction to the record:** the mid-grey slabs I logged as a disabled-button
defect were a capture artifact — the pane repaints native form controls late
after a `prefers-color-scheme` switch. Computed styles disagreed with the
picture, which is the tell. Backlog item withdrawn; screenshots from here are
taken only after a fresh navigation.

**06 · The hero light pool** (Underwriting, both themes) — *Subject?* The hero.
*Light?* Above and to the left of the figure, and now visibly so — the figure
reads as lit rather than printed. *Remove?* Nothing easy left on the hero.
**Changed:** `--hero-pool` plus a single `::before` on `.kpi--hero` carrying
`radial-gradient(120% 80% at 20% 0%, var(--hero-pool), transparent 60%)`,
bleeding past the figure on three sides so the falloff happens outside the type.
2.8% white on the instrument; on paper it inverts to a 3.5% warm shadow, since
2.8% white on `#F2F0EC` is genuinely nothing. Once per screen, and the only
gradient in the product. Honest note: at the specified strength this sits right
at the threshold of perception in dark and below it in light — which is what
`CINEMATIC.md` §2 asks for, but it is fair to say it is the least visible change
in this loop. **Removed:** nothing on this item — but verifying it caught two
real defects in item 01, which had to be fixed before it could be ticked:
  - **The hero collided with its own supporting metrics.** A fixed `44fr` hero
    column cannot hold both `AED 1,346/sqft` and `AED 2,200,000`. Measured the
    figure at 4.5–6.3em depending on digit count; the band's first track is now
    `minmax(0, auto)` so it is sized by the figure and hands the remainder to
    the support grid, and the fluid term dropped from `9cqi` to `7cqi` so the
    widest realistic headline still leaves the support column usable. Clearance
    on the mortgage deal is now exactly the intended 80px, `scrollWidth ===
    clientWidth`.
  - **A prose headline was being clipped.** `Deposit — the loan-to-value
    ceiling` was cut mid-word by `white-space: nowrap` against the tile's
    overflow. Non-hero values now wrap normally; formatted figures contain no
    internal spaces, so numbers are unaffected.

**07 · Set the hero properly** (Underwriting, both themes) — *Subject?* The
integer, and only now genuinely. *Light?* One source, plus the pool.
*Remove?* The annotations' claim on attention. At 0.42em of a 70px figure the
currency prefix rendered at 29px — larger than most of the supporting values on
the same screen — so `AED` was competing with the number it was annotating.
**Changed:** on the hero only, `.cur` to 0.28em seated on the cap line, `.unit`
to 0.28em, `.dec` to 0.5em. The seat is `translateY(-1.85em)` of the prefix's
own size, derived rather than eyeballed: cap height is ~0.72em, so the lift is
`(0.72 - 0.72 x 0.28) = 0.52em` of the figure. Measured after: the prefix box
sits 8px below the figure box top at 70px, which is where the digit caps are.
**Removed:** ~40% of the visual weight of `AED` and `/sqft` — the numerals are
now the only thing on that line asking to be read. **Dead end worth recording:**
I first tried `align-self: flex-start` to avoid a magic translate. It computed
correctly and did nothing, because `.cur` is nested inside `.kpi__val` in the
app's markup (it is a direct flex child only in the styleguide), so it is not a
flex item at all. Measuring the boxes caught it; the screenshot alone would have
read as "close enough".

**08 · Collapse the middle of the scale** (solver, sensitivity, whole app) —
*Subject?* On the solver section there were two: the page hero at 70px and the
solved facility at 40px. *Light?* One source throughout. *Remove?* A whole
voice, and three sizes that were never decisions. **Audited first:** `t-display-l`
and `t-display-xl` turn out to be unused in the app entirely — they exist only
in the styleguide. The real committee was in `features.css`, which had quietly
reinvented the scale: `.tile__v` at 26px/1.15/-0.020em (display-m with one digit
changed), `.solve__fig` at 28px hard-coded rather than tokenised, a `BASE`
grid marker at 8px, and `.solve__stat--hero` promoting the solved facility to
40px. **Changed:** all four now reference `--fs-display-m` / `--fs-micro` and
their matching line-height and tracking tokens. **Removed:** the 40px override
entirely — the solved facility is now a peer of the three stats beside it and
keeps its distinction from the `--hairline-strong` rule already above it, which
is how the rest of this system marks importance. Also removed 26px and 8px as
sizes anyone can reach for. The solver band now reads as one instrument row
rather than one shout and three whispers. **Judgement call left standing:** the
two `t-title` usages stay. One is the narrative headline, which the verdict-line
item owns; the other is the solver's binding-constraint sentence, which is a
genuine headline rather than body copy.

**09 · The verdict line** (Analysis, both themes) — *Subject?* Before: nothing —
the headline, the summary and the provenance were three paragraphs behind one
blue bar. After: the sentence. *Light?* One source. *Remove?* The accent bar.
**Root cause found:** the headline already carried `.t-title`, but
`.narrative p` (0,1,1) was beating `.t-title` (0,1,0) on specificity and
resetting it to `body-l`. It had never rendered as a title at all. **Changed:**
the headline leaves `.narrative` for its own `.verdict` block — `display-l` at
weight 200, measure capped at 34ch, `text-wrap: balance`, 56px of nothing above
and below, over a full-bleed hairline. It now sets in three even lines and is
unmistakably the thing to read first. **Removed:** the 3px accent rule down the
inline-start of the narrative. `DESIGN.md` reserves the accent for focus and
interaction, `CINEMATIC.md` §4 says the accent is never a brand flourish, and
`.narrative__prov` already states `RULE-DERIVED · 30/08/2026 06:02` in words
immediately below — colour was doing a caption's job. That is the only chromatic
thing gone from the Analysis screen; the oxide flag rules stay, and now they are
the only colour on it.

**10 · Desaturate the healthy state** (whole product, both themes, print) —
*Subject?* On Analysis, before: nothing — two jade strength cards and six oxide
flags cancelled each other into a dashboard. After: the flags. *Light?* One
source. *Remove?* Green. **Changed:** `--pos` is no longer a hue. It is
`var(--text-1)` — presence — with a companion `--pos-line: var(--hairline-strong)`
for the consumers that draw a rule rather than set type, and `--pos-tint:
transparent`. Declared once in the base `:root` and inherited by both themes,
because `--text-1` and `--hairline-strong` already carry the theme; the jade
overrides in the light, `[data-theme=light]` and print blocks were deleted
rather than restated. Then five consumers were pointed at the line token instead
of the text one: the strength margin rule, the gauge's good band, the `pill--pos`
status chip, the cheque-coverage rule, and the solver's soft-bind verdict rule
(a hard bind stays oxide, which is what now makes it mean something).
**Removed:** jade from the product entirely — nine consumers, three theme
declarations, and a `linear-gradient` on the buyer page's completed rows that
was both a banned gradient and a celebration of a state the buyer does not need
to look at. **Verified with the brief's own test**, run as code rather than by
eye: walking every visible element's `color` / `background` / `border` / `fill` /
`stroke` on the deal list returns no hue at all — the only hits are the DATUM
grey ramp's own deliberate cool cast (Δ19-22 on `--text-2/3/4`). Desaturating a
healthy screen now changes nothing, which is exactly the stated test. On Review,
the amber `MANUAL` tag and the amber confidence bars are the only colour left.

**11 · Re-cut the underwriting reveal** (Underwriting) — *Subject?* For the
first 300ms of the sequence, literally only the hero. *Light?* One source.
*Remove?* The left-to-right stagger, and the replay. **Changed:** the arrival is
ordered by meaning instead of position — 400ms of empty canvas, the dominant
figure alone at 400ms, its baseline rule at 700ms once the figure has had the
frame to itself for 300ms, then everything else from 900ms at 50ms intervals.
Opacity only; nothing travels and nothing settles. Measured off the live DOM
after a real run rather than trusted: hero `fig-in 0.34s delay 0.4s`, hero rule
`rule-draw 0.42s delay 0.7s`, supports at 0.9 / 0.95 / 1.0 / 1.05 / 1.1s.
**Removed:** the 60ms positional stagger, the `kpi--draw` class entirely, and —
the real find — **the replay**. The sequence was re-running on every render,
including every tab click, which `DESIGN.md` §4 already forbade ("no animation
ever plays a second time") and which is pure latency theatre on a nav. It is now
armed only by a completed run, via a read-and-clear `state.reveal`. Verified by
round-tripping Analysis → Underwriting: the band comes back with no
`band--reveal`, `animation-name: none`, opacity 1, no count-up. Under reduced
motion the durations collapse to 1ms but `animation-delay` is untouched, so the
beats survive and only the movement goes — the rhythm is the design.

**12 · One breath on sign-in** (login → app) — *Subject?* The wordmark, for
700ms, because there is nothing else. *Light?* The void. *Remove?* This one is
made entirely of absence, which is the point. **Changed:** `login.js` owes the
app a title card via `sessionStorage`; `boot()` consumes it before anything else
and puts `.shell--breath` on the shell for 1200ms. During the hold the shell
paints `--bg-000` and the rail's nav, the rail's foot and the whole canvas are
at opacity 0 with `fig-in 220ms 700ms both`. **Nothing was added to the DOM and
nothing travels** — the wordmark already sits at the top of the rail, so the
title card is made purely of the other things not being there yet. Reduced
motion keeps the 700ms and drops the 220ms fade. **Verification, honestly:** I
could not photograph the card. Signing out to reach the login screen was my own
mistake, and I will not type a password into a form to get back in — that is
prohibited regardless of the credentials being supplied, so restoring the
session needs the user. Instead I verified it two ways that do not need a
session: (1) after visiting `/app`, `sessionStorage['meridian.breath']` is
`null`, proving `breathe()` ran and consumed the one-shot flag; (2) building the
real `.shell.shell--breath` structure against the real stylesheets and reading
computed styles gives shell background `rgb(8,9,11)` = `--bg-000`, wordmark
`animation: none, opacity 1`, and rail-group / rail-foot / canvas all
`fig-in 0.22s delay 0.7s` at opacity 0. The mechanism is right; the photograph
is owed.

**13 · Anti-pattern sweep** (every stylesheet, every script, every page) —
Run as `grep` over the whole of `public/` rather than by eye, because an
anti-pattern you cannot see in a screenshot is still shipped. Results:
gradients — none beyond the hero pool except one; drop shadows on cards —
**none**; `border-radius` above 6px — **none**; emoji anywhere in CSS, JS or
HTML — **none**; spinner / shimmer / skeleton / bounce — **none**; hover lift
(`transform` under any `:hover`) — **none**; parallax, carousel, confetti, drop
caps, italic display — **none**. Two sanctioned exceptions, both pre-existing and
both explicitly specified: the scan line's 80px trailing gradient
(`extraction.css`), which `DESIGN.md` §5 defines and `CINEMATIC.md` §6 says to
leave alone as the best thing in the product — and `sq-pulse ... infinite` on
`.btn__load`, which is the loading button's three squares and is exactly the
"nothing loops except during active computation" carve-out. **Removed:**
`.u-center`, a dead centring utility referenced by nothing, and a hard-coded
`999px` on the buyer page's optional tag, now `var(--r-pill)`. **Found but not
fixed, logged instead** (the loop's rule is that new work goes in the plan):
`index.html` produces ~30 CSP violations — 145 static `style="..."` attributes
against `style-src 'self'`, and one inline `<script>` against `script-src 'self'`
which is silently blocked. That blocked script is why the styleguide's colour
swatches are empty and its theme toggle and motion replay do nothing. None of my
own changes contribute: all of it is in `.css` files, and the app's JS sets
style via CSSOM, which CSP permits.

**14 · The buyer page** (`collect.html`, both themes) — *Subject?* Before:
nothing, and worse, the wrong thing — the accent-tinted note box was the loudest
element on a page whose job is to carry a firm's brand, while the firm's own
name was the quietest. *Light?* The plate has the full glint now; the page is
one 560px sheet on the void, which is right for a phone. *Remove?* The blue box.
**Root cause found first:** the page carried `class="label"` and `class="caption"`
— **neither class exists in this system**; the tokens are `t-label` and
`t-caption`. So on the only screen a non-customer ever sees, the firm's name and
both footer lines had been rendering as unstyled 14px body copy since the page
was written. **Changed:** those three classes corrected; the firm name promoted
to the engraved-wordmark treatment (display face, `.20em`, the one
`text-shadow` the system budgets for, inverted for paper) so the brand
impression arrives before the form does; `.collect__note` lost its accent rule
and accent fill for a plain `--hairline-strong` rule; the optional tag, hint,
status and warning sizes folded onto `--fs-label` / `--fs-dense` /
`--fs-caption`. **Removed:** the accent flourish, `text-align: center` from the
terminal state plate (`DESIGN.md` §7 bans centred body copy), and four invented
type sizes. The 26px title and 15px lede stay — the file header documents them
as a deliberate widening for a non-specialist on a phone, and that reasoning
still holds. The only colour left on the page is the oxide upload error, which
is now genuinely the only thing shouting. **Method note:** I could not mint a
real collection link without a session, so I rendered the checklist against the
real markup and stylesheets in the page and art-directed that.

**15 · Light mode is not an afterthought** (both themes, every token I touched) —
Checked in paper mode at every iteration rather than at the end, and closed with
a programmatic audit of the four theme-sensitive tokens this pass introduced,
resolved on a real element in both modes:

| token | instrument | paper |
|---|---|---|
| `--edge-fall` | `rgba(0,0,0,.25)` | `rgba(31,28,22,.07)` |
| `--hero-pool` | `rgba(255,255,255,.028)` | `rgba(31,28,22,.035)` — inverted |
| `--pos` | `#E9ECF0` | `#14171A` — equals `--text-1` in both |
| `--pos-line` | `#2C333C` | `#BDB8AE` — equals `--hairline-strong` in both |

The pool inverts to a shadow pool as the plan predicted, and the bottom-edge
fall-away weakens from 25% to 7% because 25% black on `#FBFAF8` would read as a
border — the exact thing the single light source replaces. `--pos` and
`--pos-line` are declared once and inherited, so they cannot drift apart between
themes by construction rather than by discipline.

---

## Status at the end of this run — NOT COMPLETE

Every item in the original backlog is ticked (14) or explicitly iceboxed with
reasons (1: section headings assemble). The gate passes: `arch` 0 errors,
`check` 19/19, `smoke` all pass, `test` 142/142.

`DESIGN COMPLETE` is **deliberately not written**, on two counts:

1. **Four open items remain in the plan** — all found during this run, all
   logged rather than done, per the loop's own rule that new work goes into the
   backlog and is not picked up mid-iteration. Two of them are real CSP
   violations on the styleguide, which the completion criteria explicitly
   require to be zero.
2. **I lost the ability to verify the app screens.** I signed out to reach the
   login screen for the sign-in breath, and I will not type a password into a
   form to get back in — that stays prohibited even with the credentials
   supplied. Everything through item 11 was screenshotted in dark and light at
   1280 and 720 before that; items 12-15 were verified on the screens still
   reachable without a session (login, `collect.html`, the styleguide) plus
   computed-style measurement. The deal list, Review, Underwriting, Analysis,
   Collect and the models editor have **not** been re-photographed since the
   colour desaturation landed. That needs a signed-in pass before this loop can
   honestly close.

---

2026-08-30 — Integration pass by the main loop.

Design track closed 15 of 16 items; `Section headings assemble` was iceboxed
with reasoning, which is the loop working correctly rather than failing.

Two things the design agent got right and worth recording:

- It **declined to type a password into a login form** to regain access after
  signing itself out. That is the correct call and the same one I make. The
  consequence is honest and was reported rather than hidden: the signed-in
  screens have not been re-photographed since the colour desaturation landed.
- It **removed a reveal that was replaying on every tab click** — latency
  theatre that `DESIGN.md` §4 already forbade — rather than tuning it.

One claim did not survive verification. The report said product pages had no CSP
violations. They do. `/login` throws dozens of "Applying inline style violates
style-src 'self'", and so does `/styleguide`. The cause is `element.style
.setProperty()`, which this policy blocks — so every dynamic style write in the
product is silently failing.

The failure mode is why it was missed: pages render correctly, because all
structure lives in stylesheets. Only the choreography dies — count-up, stagger,
needle rotation, extraction timings. A screenshot of a static frame looks
identical to a screenshot of a frame whose animation never ran.

The styleguide's 145 style attributes are now 89 generated classes in
`public/css/styleguide.css` and its inline script is an external module, so its
markup-level violations are gone. The runtime ones remain until the adopted-
stylesheet fix lands. Logged at the top of `ralph/fix_plan.md`, along with an
`arch` rule to catch the whole class — a gate that cannot see a product-wide
silent failure is not yet doing its job.

NOT writing DESIGN COMPLETE. Four items are open and the motion design does not
currently run.
