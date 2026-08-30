# DATUM II — the director's treatment

A second pass over `docs/DESIGN.md`. That document established the instrument:
near-black ground, hairline structure, tabular figures, colour as signal. It is
correct and it stays. This one is about the difference between an interface that
is *well made* and one that is *unforgettable* — and about the trap that sits
directly in front of anyone trying to close that gap.

## The trap

"Cinematic" is almost always mistaken for *more*. More gradient, more glow, more
motion, more atmosphere. Every one of those makes this product worse, and
`DESIGN.md §7` already bans them.

The films this borrows from are not busy. *2001* holds a static frame for ninety
seconds. *Blade Runner 2049* spends most of its runtime on empty rooms and a
single light source. What reads as cinematic in those is not decoration — it is
**composition, light, restraint, and time**. Four things you can have in a
1px-hairline interface and nothing else.

So the rule for this pass, and the one that resolves the tension between
"legendary" and "minimal":

> **Remove until it breaks, then light what remains.**
> Add nothing that is not carrying meaning. Earn one moment per journey.

Every proposal below either takes something away or makes one existing thing
more deliberate. Nothing here adds ornament.

---

## 1. Composition — stop centring things

The current layout is honest but neutral: tiles in an even grid, everything
equally weighted, edges evenly padded. That is a spreadsheet's composition. A
frame has a **subject**.

**The rule of the dominant figure.** On any screen there is exactly one number
that matters most — price per square foot on a Dubai deal, maximum borrowing on
a mortgage assessment, DSCR when the deal is marginal. That figure gets:

- **Scale far past comfort.** 56px is timid. The hero goes to `clamp(64px, 9vw, 132px)`.
- **Air on three sides.** Minimum 80px, ideally more. Emptiness is the most
  expensive material available and it costs nothing to ship.
- **Asymmetric placement.** Not centred. Set on the left third, with the
  supporting figures ranged right — the eye enters at the subject and travels.

Everything else on the screen drops a full step in weight to make room. If two
things are shouting, neither is heard.

**Full-bleed rules.** Section dividers currently stop at the container. Let them
run to the viewport edge. A rule that leaves the frame implies the composition
continues beyond it; a rule that stops politely implies a box. This is the
cheapest cinematic cue in the entire system — one CSS change, and it is the
difference between a document and a frame.

**The crop.** The left rail should feel like the edge of something, not a
sidebar. Remove its right border entirely and let the background step do the
work. Borders make panels; light makes space.

---

## 2. Light — one source, consistently

The system already has `inset 0 1px 0 var(--hairline-glint)` — a top edge
catching light. That implies a light source above. Right now it is the only
thing that does, and nothing else agrees with it.

**Commit to the source.** Light comes from above and slightly behind the viewer.
Therefore:

- Top edges catch (`inset 0 1px 0` at 4.5% white) — already true.
- Bottom edges fall away: `inset 0 -1px 0 rgba(0,0,0,.25)` on raised surfaces.
  Currently absent, and its absence is why plates read as flat rectangles rather
  than as objects.
- Nothing is lit from below. Ever. Under-lighting is the single most reliable
  tell of a designer reaching for "premium".

**The hero pool.** Behind the dominant figure only, a very large, very faint
radial: `radial-gradient(120% 80% at 20% 0%, rgba(255,255,255,.028), transparent 60%)`.
At 2.8% it is below conscious perception — the figure simply looks *lit* rather
than printed. Use it once per screen. Twice and it becomes atmosphere, which is
the thing we are avoiding.

This is the only gradient permitted in the entire product. It is not decoration;
it is a light source.

---

## 3. Typography — push the contrast, not the count

Two faces, one accent, already correct. What is timid is the **ratio**.

Legendary typographic systems have violent contrast between their largest and
smallest voice, and nothing in between competing. Currently the scale steps
politely: 56 / 40 / 28 / 20 / 16 / 14 / 13 / 12 / 11 / 10. Ten sizes is a
committee.

**Collapse the middle.** In practice a screen should use three: the hero, the
body, and the label. `display-l` and `title` earn their place rarely.

**Set the hero properly.**
- Weight 200, not 300, at the largest size. At 100px+, 300 reads heavy.
- `letter-spacing: -0.045em` — tighter than currently specified. Large thin
  numerals need it or they drift apart.
- The currency prefix drops to `0.28em` and `--text-3`, and sits on the cap
  line. It is an annotation, not part of the figure.
- The decimal drops to `0.5em`. `1,346` matters; `.15` does not.

**The label as counterweight.** 10px, `+0.18em` tracking, `--text-3`, uppercase,
mono. Set it *above* the figure with 12px of space, not below. The eye reads the
label, then falls into the number. Reversed, the number arrives context-free.

That pairing — a 120px hairline-thin figure over a 10px tracked-out mono label —
is the entire typographic idea. It is enough.

---

## 4. Colour — spend less

The palette is already restrained. Go further.

**Achromatic by default.** A screen in a healthy state should be *entirely*
grey. Green for "good" is a habit, not a signal — if everything that passes is
green, green stops meaning anything and the screen reads as a dashboard.

Revised rule:
- **Positive states get no colour.** They get presence: full-weight text, a
  solid hairline. Health is the absence of alarm.
- **Caution and negative get colour**, and are consequently the only chromatic
  things on screen. One amber rule on a grey page is deafening.
- The accent is for **focus and interaction only** — never decoration, never a
  brand flourish.

The test: screenshot any screen and desaturate it. If it loses nothing, the
colour was decoration. On a healthy deal, nothing should change at all.

---

## 5. Time — the pause is the effect

The extraction sequence is already the strongest moment. The reveal is not, and
it should be the equal.

**The underwriting reveal, re-cut.** Currently: fade out, 220ms hold, tiles
stagger in, numbers count. Correct instinct, timid execution.

- **Lengthen the silence to 400ms.** An empty canvas for four-tenths of a second
  is uncomfortable to build and is exactly why it lands. Confidence is
  legible as willingness to wait.
- **Order the arrival by meaning, not by position.** The hero figure first,
  alone, for 300ms. Then its baseline rule draws. Then everything else at 50ms
  intervals. The current left-to-right stagger is decoration; meaning-ordered
  arrival is direction.
- **Nothing moves after it lands.** No settling, no bounce, no secondary
  animation. The frame comes to rest and stays.

**One breath on sign-in.** After authentication, before the app: the wordmark
alone on black, 700ms, then the rail and canvas draw in. Once per session, never
again. This is the title card, and a title card that repeats is an annoyance.

**Reduced motion keeps the pacing.** Under `prefers-reduced-motion` the holds
remain and the movement is removed — elements appear at the same beats without
travelling. The rhythm is the design; the movement is only its delivery.

---

## 6. The five signature frames

Not effects. Frames — moments a person could describe to a colleague.

**I. The scan plate.** Already built. Unchanged. It is the best thing here.

**II. The dominant figure.** A 120px hairline numeral, lit from above, with a
10px tracked label over it and 80px of nothing around it. Ships on the
Underwriting tab and the mortgage assessment.

**III. The margin rule.** Already specified — a 2px semantic rule drawn top-down
in a reserved gutter while the title's letter-spacing opens. Currently only on
flag cards. **Extend it to every section heading** as a 1px `--hairline-strong`
that draws on first paint. The page assembles itself.

**IV. The threshold needle.** Already specified. One change: it arrives from
zero over 700ms with `--e-mech` and **stops dead**. No overshoot, no settle. A
needle that bounces is a toy; a needle that arrives and stops is an instrument.

**V. The verdict line.** New, and the one addition this pass makes. When the
narrative renders, its headline sets alone above a full-bleed hairline at
`display-l`, 200 weight, measure capped at 34ch, with 56px above and below. One
sentence, treated like a title card. It is the sentence a principal will
actually read, and currently it is styled the same as body copy.

---

## 7. What this pass must not do

- No new colour. No new gradient beyond the single hero pool.
- No illustration, no iconography beyond the existing 1px line set.
- No animation on anything that is not the extraction sequence, the reveal, the
  needle, or a hairline drawing in once.
- No change to the data tables. Dense financial rows are already right, and
  making them "cinematic" would make them worse. **The tables are the product;
  restraint there is the discipline that earns drama elsewhere.**
- No new font. No downloaded asset. No dependency.

---

## 8. The bar

Screenshot any screen and ask three questions:

1. **What is the subject?** If the answer is "everything", the composition has
   failed.
2. **Where is the light coming from?** If the answer is "nowhere", it is a
   diagram, not a frame.
3. **What would I remove?** If there is an easy answer, remove it and ask again.

A screen passes when the third question has no easy answer left.
