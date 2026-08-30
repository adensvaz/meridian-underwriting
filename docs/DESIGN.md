# DATUM — Meridian design system

A datum is a surveyor's fixed reference: the known point from which every other
measurement is derived. This product turns a PDF of somebody else's claims into
*your* numbers, and the interface should behave like the instrument that
performs that conversion — dark, precise, unhurried, admitting exactly as much
light as the reading requires.

Colour is used the way a cockpit uses it: as signal, never decoration. Numbers
are the only thing allowed to be large. The register is not "powerful AI"; it is
**a machine that has already checked its own work.**

The audience is an investment committee principal who lives in Excel and
discounts anything that looks like a toy. Design for that person.

## Hard constraints

Hand-written vanilla HTML, CSS and JS. No framework, no component library, no
CDN fonts, no external image assets, no runtime dependencies. Everything is
modern CSS (custom properties, grid, flexbox, clip-path, container queries,
`:has()`), inline SVG, and system font stacks.

---

## 1. Colour

### Dark — the default

```css
--bg-000:#08090B;  /* app chrome, the void behind everything */
--bg-100:#0B0D10;  /* canvas — the page ground */
--bg-200:#101317;  /* surface — plates, cards, tiles */
--bg-300:#161A1F;  /* raised — inputs, table headers, popovers */
--bg-400:#1C2128;  /* hover / active surface */

--hairline:#1E232A;                       /* default 1px structure */
--hairline-strong:#2C333C;                /* section boundaries, focus */
--hairline-glint:rgba(255,255,255,.045);  /* inset top edge = elevation */

--text-1:#E9ECF0;  /* primary — never #fff, pure white vibrates on black */
--text-2:#9AA4B0;  /* secondary — labels, supporting copy */
--text-3:#646E7A;  /* tertiary — units, timestamps, citations */
--text-4:#454E58;  /* disabled, placeholder */

--accent:#7AA7C7;                        /* focus, selection, active only */
--accent-bright:#A6C8E0;                 /* live / computing */
--accent-tint:rgba(122,167,199,.10);

--pos:#5AA98D;  --pos-tint:rgba(90,169,141,.10);   /* jade, not green */
--cau:#C99A4E;  --cau-tint:rgba(201,154,78,.10);   /* brass, not yellow */
--neg:#C86B5E;  --neg-tint:rgba(200,107,94,.10);   /* oxide, not red */
--neu:#8894A2;  --neu-tint:rgba(136,148,162,.10);
```

`bg-200` is the only "material" — one step of lightness reads as elevation on
black, where shadows die. `bg-300` signals *editable*. `hairline-glint` as
`inset 0 1px 0` is the cheapest luxury cue in the system: it reads as a machined
top edge. Semantics sit at 40–50% saturation and are hue-shifted off the
primaries so a table containing all four reads as a system, not a traffic light.

### Light — paper mode, for printed IC packs

```css
--bg-000:#E9E7E2; --bg-100:#F2F0EC; --bg-200:#FBFAF8; --bg-300:#FFFFFF; --bg-400:#F0EEE9;
--hairline:#DCD8D1; --hairline-strong:#BDB8AE; --hairline-glint:rgba(0,0,0,.04);
--text-1:#14171A; --text-2:#4E565F; --text-3:#7C858F; --text-4:#A8AFB6;
--accent:#2E6B8F; --accent-bright:#1F5678; --accent-tint:rgba(46,107,143,.09);
--pos:#1E7A5E; --cau:#8A6512; --neg:#A33F32; --neu:#5A6570;
```

Warm off-white, not `#fff` — drafting paper, and it stops the page glaring.

---

## 2. Typography

```css
--font-text:-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",
  Roboto,"Helvetica Neue",Arial,sans-serif;
--font-display:"SF Pro Display",-apple-system,BlinkMacSystemFont,
  "Segoe UI Variable Display","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--font-mono:ui-monospace,SFMono-Regular,"SF Mono","Cascadia Mono",
  "Segoe UI Mono","Roboto Mono","Liberation Mono",Menlo,monospace;
--font-ar:"SF Arabic","Dubai","Geeza Pro","Segoe UI","Noto Sans Arabic",sans-serif;
```

Global on `:root`: `font-variant-numeric: tabular-nums lining-nums slashed-zero`
plus `font-feature-settings:"tnum" 1,"lnum" 1,"zero" 1`. Every column of figures
must be a rigid rectangle. Proportional numerals in a rent roll are the fastest
way to look amateur.

| Token | Size / LH | Weight | Tracking | Use |
|---|---|---|---|---|
| `display-xl` | 56 / 1.00 | 300 | −0.030em | Hero metric |
| `display-l` | 40 / 1.05 | 300 | −0.025em | Secondary hero |
| `display-m` | 28 / 1.15 | 400 | −0.020em | KPI tile value |
| `title` | 20 / 1.30 | 500 | −0.010em | Section heads |
| `body-l` | 16 / 1.65 | 400 | 0 | AI narrative only |
| `body` | 14 / 1.55 | 400 | 0 | UI copy |
| `dense` | 13 / 1.35 | 400 | 0 | Table cells |
| `caption` | 12 / 1.40 | 450 | +0.005em | Helper text |
| `label` | 11 / 1.20 | 500 | +0.14em, uppercase | Eyebrows, column heads |
| `micro` | 10 / 1.20 | 500 | +0.10em, uppercase, mono | Citations, IDs, tags |

Headline numbers are `--font-display` at weight **300**. Thin at large size is
what reads as instrument rather than pitch deck. Never bold a big number; if it
needs emphasis, make it bigger or give it more air.

**Currency** is a prefix, `0.42em`, `--text-3`, `letter-spacing:.08em`, raised to
cap height: `AED 12,480,000`. Compact form: `AED 12.48` with `m` at `0.38em`.

**Decimals** go in a `<span class="dec">` at `0.62em`, `--text-2` — the integer
carries the meaning, the decimal is a footnote. `8.42%` sets `8` full size and
`.42` reduced.

**Negatives** use accounting parentheses, never a hyphen: `(1,240,500)`. Colour
them `--neg` only when the sign carries judgement (variance, cash shortfall). An
expense line is not a failure — leave it `--text-1`.

---

## 3. Layout

12 columns, `max-width:1680px`, gutter 24px, page padding 32/24/16px. Shell is a
fixed 220px left rail on `--bg-000`, fluid canvas on `--bg-100`, optional 360px
right inspector. Panels use container queries so a KPI band collapses 4-up to
2-up without viewport media queries.

Spacing scale (4px base): `2,4,6,8,12,16,20,24,32,40,56,80`.

Radii: `--r-sm:2px` (inputs, tags), `--r-md:3px` (plates, buttons), `--r-lg:6px`
(modals). Nothing above 6px except status pills at `999px`. Large radii read as
consumer software; this should feel milled.

Everything is 1px `--hairline`. Emphasis moves to `--hairline-strong`, never to
2px — except the left-margin flag rule, the only deliberate 2px line in the
system.

**Elevation on dark**, in priority order: background lightness step → hairline →
`box-shadow: inset 0 1px 0 var(--hairline-glint)` → and *only* for true
overlays, `0 24px 64px -16px rgba(0,0,0,.72)` over a
`backdrop-filter:blur(14px) saturate(.85)` scrim. Do not put drop shadows on
cards; on `#0B0D10` they are invisible and they cost the crispness that sells
the look.

**Density.** Table wrappers carry `data-density="compact|default|comfortable"`
swapping `--row-h` (28/32/40px) and `--cell-px` (8/12/16px). Rows get a 1px rule
at 4% opacity, every fifth at 8% — subtle banding that lets the eye track across
14 columns without zebra striping. Numeric columns right-align. Column
min-widths are set by the widest plausible figure so numbers never reflow when
data changes.

---

## 4. Motion

```css
--e-out:cubic-bezier(.16,1,.3,1);      /* entrances, reveals */
--e-inout:cubic-bezier(.65,0,.35,1);   /* moves, sequences */
--e-precise:cubic-bezier(.4,0,.2,1);   /* state changes */
--e-mech:cubic-bezier(.33,0,0,1);      /* needles, gauges — no overshoot */
--t-state:90ms; --t-hover:140ms; --t-panel:220ms;
--t-reveal:340ms; --t-count:640ms; --t-beat:1100ms;
```

**Animates:** hairlines drawing in, numbers counting up on first reveal,
confidence gauges filling, needles, panel entry, hover/press, the extraction
sequence.

**Never animates:** table rows on sort/filter/paginate; a number that changed
because the *user* edited it (flash the cell background instead); focus rings;
nav transitions; anything on scroll; anything with overshoot or bounce; skeleton
shimmer; spinners of any kind. Nothing loops except during active computation,
and no animation ever plays a second time.

Honour `prefers-reduced-motion`: drop the choreography, keep the information.

---

## 5. The extraction sequence

Extraction is dead time and it must feel like competence. It is the hero moment.

- `0–240ms` — the three filename plates rise 6px, hairlines go solid.
- `240–640ms` — canvas splits. Left 40% becomes the **page plate**: an inline SVG
  schematic of a document — a 1px `--hairline-strong` rectangle holding ~22
  horizontal rules of varying width standing in for text lines, plus a denser
  block for a table. It draws top-to-bottom via `clip-path: inset(0 0 100% 0)` →
  `inset(0)` over 400ms, `--e-out`.
- `640ms →` — the **scan line**: a 1px `--accent-bright` rule with an 80px
  trailing gradient travels top→bottom over 2400ms at **linear** timing. Constant
  rate is what makes it read as a mechanism. Rules the scan has passed switch
  from `--hairline` to `--text-3` instantly, not faded.
- `900ms →` — on the right, extracted values **latch** in at 180ms intervals: no
  fade, label in `label` style, value in mono, preceded by a 1ch block caret that
  blinks once and is replaced. Latching, not typing.
- Throughout — a **stage rail** across the top:
  `INGEST · SEGMENT · READ · RECONCILE · VALIDATE`, each an 11px tracked label
  over a 1px track filled by `scaleX`. Completed stages go `--text-2`, the active
  one `--text-1`.
- **Floor: 4200ms.** An instant result reads as a lookup, not an analysis. If the
  API is slower, advance the page counter and re-scan.
- **Exit:** the scan completes its pass, the plate dims to 30% over 220ms, the
  review ledger enters.

Under reduced motion this becomes a static step list with a text percentage;
values still latch.

---

## 6. Signature moments

**The scan plate.** Above. Pure inline SVG plus one absolutely-positioned
gradient div. This is the image people describe to colleagues.

**Numbers that count up, in CSS.** A registered custom property keeps it cheap
and interruptible:

```css
@property --n { syntax:'<integer>'; inherits:false; initial-value:0; }
.kpi__val::after { counter-reset:n var(--n); content:counter(n); }
.kpi--in { animation:count var(--t-count) cubic-bezier(.2,.8,.2,1) both; }
@keyframes count { from{--n:0} to{--n:var(--target)} }
```

Stagger tiles 60ms via `animation-delay:calc(var(--i)*60ms)`. Swap to the
formatted string on `animationend` — the roll shows raw digits, the settled value
shows `AED 12,480,000`.

**Confidence as ink density, not a badge.** Three 2×10px bars in the row's right
gutter plus a semantic underline on the value: high = solid 1px
`--hairline-strong`, 3 bars `--text-2`; medium = 1px dashed, 2 bars `--cau`;
low = 1px dotted, 1 bar, and the cell takes `--cau-tint`. Hover reveals the
citation in `micro`: `OM · p.14 · tbl 3`. No percentages, no coloured pills, no
robot iconography.

**The margin rule.** A flag never pops. It *scores the page*: a 2px `--neg` rule
in a reserved 16px left gutter, drawn `scaleY(0)→1` from the top over 260ms,
while the flag's label animates `letter-spacing` from `-0.02em` to `0.14em` — the
words open like a title card. Strengths use `--pos`, DD items `--neu`, identical
mechanics. No toast, no icon, no shake.

**The threshold gauge.** DSCR, net yield and exit yield get a 96×52px inline-SVG
semicircular gauge: 1px `--hairline-strong` arc, ticks every 5°, a 3px `--neg`
segment marking the covenant band, and a 1px needle on
`transition:transform 700ms var(--e-mech)`. Zero overshoot — a needle that
bounces is a toy; a needle that arrives and stops is an instrument.

---

## 7. Anti-patterns

Never: gold or bronze gradients; glassmorphism; purple→blue AI gradients; glowing
borders; neon; drop shadows on cards; emoji in product chrome; radii over 6px;
pill buttons; illustrated empty states; mascots; sparkle/wand icons for AI;
typewriter streaming in finished output; spinners; shimmer skeletons; confetti;
sliding bouncing toasts; hover lift on cards; parallax; carousels; stock skyline
or marble imagery; drop caps; italic display type; centred body copy;
proportional numerals in a table; hyphen-minus for negative currency;
"AI-powered" as visible UI text; confidence-as-percentage-in-a-pill; pure `#000`
or `#FFF`; more than one accent hue on a screen; more than one animated element
at a time outside the extraction sequence; any number rendered without its unit.

---

## 8. Gulf considerations

The buyer has seen every gold-gradient pitch deck in the Gulf and discounts it.
**Signal premium through precision, not ornament.** The luxury cues are optical
alignment of number columns, a hero figure with 80px of air, hairlines that are
genuinely 1px on retina, the machined `inset 0 1px 0` top edge, and typography
that never uses a default weight where a considered one would do. Reserve exactly
one moment of ornament — the engraved wordmark, `color:var(--text-2)` with
`text-shadow:0 1px 0 rgba(255,255,255,.05)`. That is the whole budget.

**Local correctness is the real prestige.** `AED 12,480,000` / `AED 12.48m`,
never `12,480,000 AED` in English UI, never `$`. Areas in sq ft primary with sq m
secondary in `--text-3` — every rent roll here mixes them and getting it right is
worth more than any flourish. Real taxonomy in filters: DIFC, Business Bay, JVC,
Dubai South, Al Quoz; freehold vs leasehold; Ejari status; service charge per
sq ft. Dates DD/MM/YYYY. UAE weekend is Sat–Sun.

**RTL readiness from day one.** Logical properties exclusively —
`margin-inline-start`, `padding-inline`, `inset-inline-start`,
`border-inline-end`, `text-align:start|end`. Never `left`/`right` in layout CSS.
Financial figures stay LTR regardless of direction: wrap numeric cells in
`<span dir="ltr" style="unicode-bidi:isolate">` and align with an explicit
`text-align:right`, so `(1,240,500)` never scrambles its parentheses. And
critically `[lang="ar"]{letter-spacing:0!important;line-height:1.75}` —
letter-spacing breaks Arabic letter joining, and every tracked `label` token in
this system would otherwise render as gibberish. Budget 25–35% extra horizontal
space for Arabic labels.
