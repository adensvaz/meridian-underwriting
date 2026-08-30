---
name: ralph
description: Run or manage the Ralph Wiggum loop — an autonomous, self-verifying build loop that works a backlog one item at a time behind a hard quality gate. Use when asked to "run the loop", "run ralph", "work the backlog", "keep building until done", to add or reprioritise backlog items, or to diagnose why the loop stalled or went red.
---

# Ralph Wiggum loop

A deliberately dumb loop that produces reliably good work: feed the **same
prompt** to a fresh agent every iteration, have it close **exactly one** backlog
item, and gate every iteration behind a build that must stay green.

The stupidity is the point. Because state lives in files rather than in a
conversation, no iteration depends on remembering the last one — so the loop
survives a context reset, a crash, a session limit, or a machine reboot with no
special handling.

## The pieces

| File | Role |
|---|---|
| `ralph/PROMPT.md` | The unchanging instruction. Architecture map, invariants, quality bar, completion criteria. |
| `ralph/fix_plan.md` | The backlog. `- [ ]` open, `- [x]` done, plus an Icebox for explicitly-out-of-scope work. |
| `ralph/JOURNAL.md` | Append-only record. One line per iteration, plus the sentinel when finished. |
| `ralph/loop.sh` | The driver. |

## Running it

```bash
./ralph/loop.sh                    # until the backlog is clear or MAX_ITERATIONS
MAX_ITERATIONS=5 ./ralph/loop.sh   # bounded run
DRY_RUN=1 ./ralph/loop.sh          # show what it would do, change nothing
```

Always `DRY_RUN=1` first on an unfamiliar tree. It verifies the gate and prints
the next few items without touching anything.

## What makes this one safe to leave running

1. **It refuses to start on red.** A broken build cannot be compounded by piling
   another change on top of it.
2. **It verifies after every iteration** and stops immediately on a regression,
   rather than grinding through nineteen more passes making things worse.
3. **It commits each good iteration**, so a bad one is a single `git revert`.
4. **It detects a stall** — an iteration that ticks nothing and journals nothing
   — and gives up after two in a row, instead of burning the budget in a circle.
5. **The gate includes an architecture check**, not just tests. Tests catch a
   wrong answer; they do not catch a right answer arrived at badly.

## The gate

```bash
npm run arch     # layering, cycles, code smells, product invariants — 0 errors
npm run check    # domain correctness and security invariants
npm run smoke    # end-to-end over real HTTP
npm test         # unit tests
```

Tests alone are not enough for an autonomous loop. Architectural decay is
silent, compounds across iterations, and is how a codebase rots under
automation. `npm run arch` makes the architecture mechanical: dependency
direction, no circular imports, no raw SQL outside the repository layer, no
hard-coded domain constants, no `eval`, size budgets.

## Writing a good backlog item

The loop is only as good as `fix_plan.md`. A weak item produces weak work.

**Weak:** `- [ ] Improve the export`

**Strong:**
```
- [ ] Bind the commercial models' occupancy input to `occupancy_by_area` rather
      than `physical_occupancy`. On a floor of unequal suites those differ
      materially — one vacant 600 sqft suite of 6,800 across five units is 80%
      by count and 91.2% by area — and every recovery line follows the area.
      Requires editing the two model definitions and re-running `npm run seed`.
```

State **what**, **why it matters**, and **where it lands**. The agent has no
memory of the conversation that produced the item.

## Order matters

The loop takes the top-most unchecked item. Put correctness and security above
features, and features above polish. Reprioritise by moving lines, not by adding
priority labels.

## When it stops

- **Sentinel found** — `MVP COMPLETE` is the last line of `JOURNAL.md`. Done.
- **Red build** — inspect `git status`; nothing was committed for that iteration.
- **Stalled twice** — usually the top item is blocked, ambiguous, or already
  done. Rewrite it or move it to the Icebox.
- **Hit MAX_ITERATIONS** — check how many items actually closed; if it is zero,
  the backlog is the problem, not the loop.

## Adapting it to another project

Three things change: the architecture map and invariants in `PROMPT.md`, the
rules in the `arch` script, and the gate commands in `loop.sh`. Everything else
is project-agnostic.

The single highest-value part to port is the **invariants** section — the short
list of things that must never regress. That is what stops an autonomous loop
optimising a feature by quietly dismantling a guarantee.
