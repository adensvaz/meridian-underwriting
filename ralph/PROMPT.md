# RALPH — Meridian

You are working in `/Users/adenvaz/Documents/Work/AI BUSINESS/Meridian`.

## What this product is

**Meridian** is an AI deal underwriting platform for Dubai / UAE commercial real
estate, serving two jobs:

1. **Investment underwriting** — upload an Offering Memorandum, rent roll and
   T12; extract the inputs with provenance; run a user-editable underwriting
   model; produce a return analysis and an investment committee memo.
2. **Mortgage brokerage** — assess a buyer's affordability against UAE Central
   Bank rules, and collect their KYC and income documents through a tokenised
   upload link that needs no account.

## The architecture, and why it is shaped this way

```
public/          hand-written HTML/CSS/JS. No framework, no build, strict CSP.
                 Receives computed VALUES only — never a formula.
   │  fetch
   ▼
src/routes/      HTTP handlers. Thin. Validate input, call a lib, shape output.
   │             Feature areas register their own routes (export, analysis,
   ▼             admin, collect) so several can be built without collisions.
src/lib/         The product.
   ├ engine/     The formula language and the model runner. PURE — no database,
   │             no network, no transport. This is the one part that must be
   │             trivially testable and perfectly reproducible.
   ├ db/         repo.ts is the ONLY place that speaks SQL.
   ├ auth/       scrypt passwords, server-side sessions, CSRF, throttling.
   ├ parse/      bytes → text, by magic bytes rather than file extension.
   ├ ai/         extraction and narrative, each with a deterministic fallback.
   └ collect.ts  buyer document links.
src/seed/models/ The shipped underwriting models. DATA, not code.
```

**Dependency direction is one-way**: `routes → lib → db`. `npm run arch`
enforces it. A lib importing a route, or the engine importing the database, is a
build failure, not a style opinion.

## Non-negotiables — never regress these

- **Per-user isolation.** Every user-scoped query goes through
  `src/lib/db/repo.ts` and takes an actor. There is no `getDeal(id)`, only
  `getDeal(actor, id)`. Raw SQL in a route is a build failure.
- **No underwriting logic reaches the client.** The browser gets values plus
  presentation metadata. `npm run check` greps every client file against all
  shipped formulas.
- **The model is data.** Formulas live in the database and are evaluated by
  `src/lib/engine/expr.ts`. Never hard-code a cap rate, yield or expense ratio
  into TypeScript. Never introduce `eval` or `new Function`.
- **Absent means absent.** A figure not found is `null`, propagates as `null`,
  and renders as an em dash. Never substitute zero. Never let the AI guess.
- **The no-API-key path must keep working.** Deterministic extraction and a
  rules-based write-up. A firm that will not send documents to a third party is
  a real customer, not a fallback.
- **Invite-only.** No public signup route. Do not add one.
- **The buyer upload link is upload-only.** It must never return a file, list
  what was uploaded, or expose any figure.

## Your loop, every single iteration

1. `cat ralph/fix_plan.md` — read the backlog.
2. Pick **exactly ONE** unchecked item — the top-most `[ ]` unless something
   blocks it. Do not batch. One item per iteration.
3. **Think before you type.** Answer these three, briefly, out loud:
   - Where does this belong? Name the existing module, or justify a new file.
   - What already does something similar? Extend it rather than duplicating it.
   - What could this break? Name the invariant nearest to the change.
4. Implement it fully. No TODOs, no placeholders, no stubs left behind.
5. **Verify.** Run the full gate below and paste the real output.
6. **Review your own diff before ticking.** `git diff`. Ask: would I approve
   this? Is anything here dead, duplicated, or unexplained? Fix it now.
7. Tick the item `[x]` in `ralph/fix_plan.md` and append one line to
   `ralph/JOURNAL.md` — date, item, outcome, evidence.
8. New work you discover goes into `ralph/fix_plan.md` as a new `[ ]` item.
   **Do not do it now.**
9. Stop the iteration.

## The gate

```bash
npm run arch     # architecture and code quality — 0 errors required
npm run check    # engine arithmetic, tenant isolation, formatting, invariants
npm run smoke    # end-to-end over real HTTP
npm test         # unit tests
```

All four must pass. If your change makes a warning count go **up**, either fix
it or say in the journal why it is the right trade.

## Code quality bar

This codebase is read by people evaluating whether to buy it. Match what is
already there.

- **Comments explain WHY, not what.** `// Object.hasOwn, not a bare index:
  inherited keys resolve to something truthy` earns its place. `// loop over
  files` does not.
- **Name the trap.** When you handle a non-obvious case — a pooled Buffer, a
  prototype-chain lookup, a rounding convention — write down what goes wrong
  without the handling. The next reader cannot see the bug you prevented.
- **Prefer extending a module to adding one.** A new file needs a reason.
- **Functions under ~120 lines, files under ~900.** `npm run arch` warns; treat
  a warning as a prompt to think, not a rule to satisfy mechanically.
- **No `any`.** Use `unknown` and narrow.
- **Errors must be actionable.** "Something went wrong" is a bug. Say what
  failed and what the reader can do about it.
- **Honesty in output.** If a number is assumed rather than read, the UI and the
  memo must say so. Never present a default as a finding.

## Hard rules

- Node 26 runs TypeScript natively. **No build step.** Explicit `.ts` extensions
  on relative imports; no `enum`, no `namespace`, no decorators, no parameter
  properties; `import type` for type-only imports.
- Persistence is `node:sqlite` (`DatabaseSync`). No ORM, no native modules.
- **Add no dependencies.** Four is the whole list. If you believe a fifth is
  required, add a backlog item arguing for it instead of installing it.
- The front end is vanilla HTML/CSS/JS. The CSP is `script-src 'self'` — an
  inline `<script>` is silently blocked, so never write one.
- Anything costing API money sits behind an explicit flag or a `--limit`.
- Secrets live in `.env`. Never commit or print a key.
- Follow `docs/DESIGN.md` for anything visual. Its anti-pattern list is binding.
- **Never** tick an item without pasted command output proving it works.
- **Never** rewrite `ralph/fix_plan.md` wholesale. Append and tick only.
- **Never** invent data. Demo data lives in `src/seed/` and is labelled fictional.

## When you are stuck

Do not thrash. If an item is blocked or turns out to be the wrong idea, say so
in the journal, move it to the Icebox with a one-line reason, and pick the next
item. A loop that honestly records "this was the wrong shape" is working
correctly; one that fakes progress is not.

## Completion criteria — the loop ENDS when all are true

- [ ] `npm run arch` reports 0 errors.
- [ ] `npm run check` exits 0 with every check green, including tenant isolation.
- [ ] `npm run smoke` passes end to end over real HTTP.
- [ ] `npm test` passes.
- [ ] `npm run seed` loads the demo deals and `npm run serve` boots clean.
- [ ] Every core journey works in a browser with no console errors and no CSP
      violations: sign in; upload; extract; correct a field; underwrite at both
      depths; generate the narrative; export to Excel; run a sensitivity grid;
      solve a loan; issue a buyer collection link and upload against it.
- [ ] A user can clone a shipped model, edit a formula, save it, and see the
      change in a new run — without touching TypeScript.
- [ ] A deliberately malformed formula is refused at save time, naming the line.
- [ ] `ralph/fix_plan.md` has no unchecked items outside the Icebox.

When all of the above are true, write `MVP COMPLETE` as the final line of
`ralph/JOURNAL.md` and stop.
