# RALPH — Meridian

You are working in `/Users/adenvaz/Documents/Work/AI BUSINESS/Meridian`.

## Mission

Harden a working MVP of **Meridian**, an AI-powered commercial real estate deal
underwriting platform for the Dubai / UAE market.

The core loop the product must deliver:

1. A user uploads an Offering Memorandum, a rent roll and a T12.
2. AI extracts the underwriting inputs, with a source citation and an honest
   confidence for every figure.
3. Those inputs populate a customisable underwriting model.
4. The user reviews and corrects the extracted data before it is finalised.
5. The engine outputs a value / return analysis.
6. The system writes an analyst narrative: strengths, red flags, DD questions.
7. The same engine serves a fast "quick" pass and a detailed "full" pass.

## Non-negotiables — never regress these

- **Per-user isolation.** Every user-scoped query goes through `src/lib/db/repo.ts`
  and takes an actor. There must be no unscoped read of a deal, document, field,
  rent roll, T12, run or narrative. `npm run check` proves this and must stay green.
- **No underwriting logic reaches the client.** The browser receives computed
  values with presentation metadata. It never receives a formula. Anything under
  `public/` importing from `src/` is a defect.
- **The model is data, not code.** Formulas live in the database and are
  evaluated by `src/lib/engine/expr.ts`. Never hard-code a cap rate, a yield or
  an expense ratio into a TypeScript file.
- **Absent means absent.** A figure that was not found is null and renders as an
  em dash. Never substitute zero, and never let the AI guess a number the
  document does not contain.
- **Invite-only.** There is no public signup route. Do not add one.

## Your loop, every single iteration

1. `cat ralph/fix_plan.md` — read the backlog.
2. Pick **exactly ONE** unchecked item (top-most `[ ]` unless something blocks
   it). Do not batch. One item per iteration.
3. Implement it fully.
4. **Verify it.** Run `npm run check` plus whatever targeted command proves the
   item works. Paste the real output.
5. Tick the item `[x]` in `ralph/fix_plan.md` and append one line to
   `ralph/JOURNAL.md` (date, item, outcome, evidence).
6. New work you discover goes into `ralph/fix_plan.md` as a new `[ ]` item — do
   NOT do it now.
7. Stop the iteration.

## Hard rules

- **Never** tick an item without pasted command output proving it works.
- **Never** rewrite `ralph/fix_plan.md` wholesale. Append and tick only.
- **Never** invent data. Demo data lives in `src/seed/` and is labelled fictional.
- Node 26 runs TypeScript natively. **No build step.** Therefore:
  - explicit `.ts` extensions in relative imports,
  - no `enum`, no `namespace`, no decorators, no parameter properties,
  - `import type { X } from "..."` for type-only imports.
- Persistence is `node:sqlite` (`DatabaseSync`). No native modules, no ORM.
- The front end is hand-written vanilla HTML/CSS/JS. No framework, no CDN, no
  build. The CSP is `script-src 'self'` — an inline `<script>` will be blocked.
- Anything that costs API money sits behind an explicit flag or a `--limit`.
- Secrets live in `.env` only. Never commit or print a key.
- Follow `docs/DESIGN.md` for anything visual. Its anti-pattern list is binding.

## Completion criteria (the loop ENDS when all are true)

- [ ] `npm run check` exits 0 with every check green, including tenant isolation.
- [ ] `npm run test` passes.
- [ ] `npm run seed` loads the demo deals and `npm run serve` boots clean.
- [ ] Logging in, uploading three documents, extracting, correcting a field,
      underwriting at both depths and generating a narrative all work in a browser.
- [ ] The deal list shows headline metrics for every seeded deal.
- [ ] A user can clone a shipped model, edit a formula, save it, and see the
      change reflected in a new run — without touching any TypeScript.
- [ ] A deliberately malformed formula is refused at save time with a message
      naming the offending line.
- [ ] No console errors and no CSP violations on any page.
- [ ] `ralph/fix_plan.md` has no unchecked items outside the "Icebox" section.

When all of the above are checked, write `MVP COMPLETE` as the final line of
`ralph/JOURNAL.md` and stop.
