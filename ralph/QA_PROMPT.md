# RALPH — Meridian, logical QA track

You are working in `/Users/adenvaz/Documents/Work/AI BUSINESS/Meridian`.

You are not building features and you are not restyling anything. Your single
job is to find places where the product **says or asks something that does not
make sense for the situation the user is actually in** — and to fix them.

## The bug class you are hunting

This product does two different jobs through one set of screens:

| | Underwriting a property | Assessing a buyer for a mortgage |
|---|---|---|
| The subject is | an asset | a person |
| Documents come from | the seller | the buyer |
| Documents are | Offering Memorandum, rent roll, T12 | Emirates ID, salary certificate, bank statements, liability letters |
| Key concepts | tenure, service charge, cap rate, NOI | debt burden ratio, LTV cap, cash to complete |
| Money question | what does this asset yield? | how much can this person borrow? |

The property flow was built first. **Every screen therefore defaults to
property assumptions, and each one that leaks into the mortgage flow is a
defect.** Two already found and fixed, which tells you the shape of the rest:

- The Documents tab asked a mortgage applicant for an Offering Memorandum, a
  rent roll and a T12 — documents that do not exist in that transaction.
- The deal header printed `Tenure not set` on a mortgage case. Tenure is a
  property-title concept and means nothing about a buyer.

These are not cosmetic. A broker who sees the tool ask for a T12 on a mortgage
concludes it does not understand their business, and they are right to.

## Your loop, every iteration

1. `cat ralph/qa_plan.md` — read the backlog.
2. Pick **exactly ONE** unchecked item, or if the backlog is empty, run a sweep
   (below) and file what you find as new items — then stop. Filing is progress.
3. **Reproduce it first.** Open the actual screen in the browser on both a
   property deal and a mortgage case and see the difference. A defect you have
   not seen is a guess.
4. Fix it. Prefer deriving the right behaviour from data that already exists —
   `deal.assetType`, the model definition, the checklists in
   `src/lib/collect.ts` — over adding a second hardcoded list that can drift.
5. Verify: the gate, plus a screenshot of the same screen in **both** flows.
6. Tick the item and append one line to `ralph/qa_journal.md` saying what a user
   would have seen and what they see now.
7. Anything else you noticed goes into `ralph/qa_plan.md` as a new `[ ]`.

## The sweep

When the backlog is empty, walk every screen in **both** flows and ask four
questions of everything on it:

1. **Does this label mean anything in this flow?** "Tenure", "T12", "rent roll",
   "cap rate", "NOI", "service charge" on a mortgage case. "Debt burden ratio",
   "cash to complete" on an investment case.
2. **Is this asking for something that exists?** A document, a figure, a party.
3. **Does this instruction make sense to follow?** "Ask the seller for the
   native file" is nonsense when there is no seller yet.
4. **Would a professional in this flow recognise their own workflow?** Ask it
   about a Dubai mortgage broker specifically, not a generic user.

Screens: deal list · New deal (both modes) · Documents · Review · Underwriting ·
Analysis · Collect · the buyer page · Models · Export (the workbook sheet names
and headings) · the printed IC pack · every empty state · every error message.

**The exports and the printed pack matter as much as the screens.** A workbook
with a "Rent roll" sheet on a mortgage assessment is the same defect, and it is
the artefact that gets emailed to a client.

## Rules

- **Do not rename a concept to dodge the problem.** If a mortgage case has no
  meaningful tenure, suppress it — do not relabel tenure as something vaguer so
  it reads acceptably in both.
- **Do not add a hardcoded second list** where the right answer can be derived
  from the case type and existing data.
- **Do not change a number, a formula or a threshold.** This track fixes what is
  said and asked, never what is computed. A wrong number is a different backlog.
- Never `innerHTML` with server data. No inline `<script>` — the CSP blocks it.
- `element.style.setProperty()` is blocked by `style-src 'self'` in this app.
  Use classes or a constructed stylesheet.
- Logical CSS properties only. RTL-ready.

## The gate

```bash
npm run arch && npm run check && npm run smoke && npm test
```

Plus, for every fix, the same screen seen in both flows with no console errors.

## Completion

When `ralph/qa_plan.md` has no unchecked items and a full sweep has produced
nothing new, write `QA CLEAN` as the final line of `ralph/qa_journal.md`.

Being unable to sign in is a legitimate blocker — say so in the journal rather
than guessing at what a screen shows, and never attempt to authenticate.
