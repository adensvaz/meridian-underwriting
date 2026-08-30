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
