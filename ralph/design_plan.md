# Meridian — design backlog

Ordered by how much each changes the felt quality of the product. Every item
either removes something or makes one existing thing more deliberate. Nothing
here adds ornament — see `docs/CINEMATIC.md` §1.

## Composition

- [ ] **The dominant figure.** On the Underwriting tab, price per square foot is
      currently one tile among equals. Promote it: `clamp(64px, 9vw, 132px)`,
      weight 200, `letter-spacing: -0.045em`, set on the left third with at
      least 80px of air on three sides, supporting metrics ranged right. Every
      other tile drops a step in weight to make room. If two things shout,
      neither is heard.
- [ ] **Full-bleed section rules.** Dividers currently stop at the container.
      Let them run to the viewport edge. A rule that leaves the frame implies
      the composition continues; one that stops politely implies a box. Single
      cheapest cinematic cue in the system.
- [ ] **Un-border the rail.** Remove the left rail's inline-end border and let
      the background step carry the separation. Borders make panels; light makes
      space.
- [ ] **The label above the figure.** Move KPI eyebrows above their value with
      12px of space, 10px, `+0.18em`, `--text-3`, mono. The eye should read the
      label then fall into the number. Reversed, the number arrives
      context-free.

## Light

- [ ] **Commit to one source.** Add `inset 0 -1px 0 rgba(0,0,0,.25)` to raised
      surfaces so bottom edges fall away, matching the existing top-edge catch.
      Their absence is why plates read as flat rectangles rather than objects.
      Nothing is ever lit from below.
- [ ] **The hero light pool.** Behind the dominant figure only:
      `radial-gradient(120% 80% at 20% 0%, rgba(255,255,255,.028), transparent 60%)`.
      At 2.8% it sits below conscious perception — the figure reads as lit, not
      printed. Once per screen. This is the only gradient permitted anywhere.

## Typography

- [ ] **Set the hero properly.** Weight 200 at the largest size (300 reads heavy
      past 100px), `-0.045em` tracking, currency prefix at `0.28em` on the cap
      line in `--text-3`, decimals at `0.5em`. The integer carries the meaning.
- [ ] **Collapse the middle of the scale.** A screen should use three voices:
      hero, body, label. Audit each screen and demote anything using
      `display-l` or `title` where `body` would do. Ten sizes is a committee.
- [ ] **The verdict line.** The narrative headline currently sets like body
      copy. Give it `display-l` at weight 200, measure capped at 34ch, alone
      above a full-bleed hairline with 56px above and below. It is the one
      sentence a principal actually reads.

## Colour

- [ ] **Desaturate the healthy state.** Remove green from passing benchmarks and
      positive flags. Health is the absence of alarm, not the presence of green.
      Caution and negative keep their colour and become the only chromatic
      things on screen — one amber rule on a grey page is deafening.
      Test: desaturate a screenshot of a healthy deal. Nothing should change.

## Time

- [ ] **Re-cut the underwriting reveal.** Lengthen the empty hold to 400ms.
      Order the arrival by meaning rather than position: hero figure alone for
      300ms, then its baseline rule draws, then everything else at 50ms
      intervals. Nothing moves after it lands — no settling, no secondary
      animation.
- [ ] **One breath on sign-in.** After authentication, before the app: the
      wordmark alone on black for 700ms, then rail and canvas draw in. Once per
      session, never again — a title card that repeats is an annoyance. Store
      the flag in `sessionStorage`.
- [ ] **Section headings assemble.** Extend the margin-rule mechanic to every
      section heading as a 1px `--hairline-strong` drawing on first paint. The
      page should assemble itself rather than appear.

## Sweep

- [ ] **Anti-pattern sweep across every screen**, including the new sensitivity,
      solver, collect and mortgage screens: no gradient beyond the hero pool, no
      glow, no card shadow, no radius over 6px, no emoji, no spinner, no
      shimmer, no hover lift, no bounce.
- [ ] **The buyer page deserves the same care.** `collect.html` is the only
      screen a non-customer sees, and it is currently the plainest. It should
      feel like the firm that sent it — same light, same restraint, wider
      measure. It is a brand impression before it is a form.
- [ ] **Light mode is not an afterthought.** Every change above must be checked
      in paper mode. The hero light pool inverts to a shadow pool; the
      bottom-edge fall-away weakens. Verify both, do not assume.

## Icebox

- Animated page transitions. Nav should be instant; motion between routes is
  latency theatre.
- A custom typeface. No downloaded assets, and the system stacks are correct.
- Dark/light auto-switching on time of day. Cute, and it would fight the
  viewer's explicit choice.
