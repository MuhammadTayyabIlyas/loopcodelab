---
name: web-research
description: Answer factual/technical questions with LIVE cited web facts via $RALPH_GEN_RESEARCH (budgeted) instead of guessing from training data — current API/library versions, real product facts, market claims.
---

# Web research (cited, live)

A research helper is available: it answers ONE question with current, cited facts from a live web
search. Use it whenever being wrong would cost an iteration — do NOT guess about things that change
over time.

## When to use it

- A library/framework/API you are about to depend on: current major version, breaking changes,
  the correct current endpoint/call shape.
- Real-world facts going INTO the deliverable (product names, prices, competitor features,
  statistics for docs/slides copy) — never invent these.
- An error message from an external service you don't recognize.

## When NOT to use it

- Things you already know confidently and that don't churn (language syntax, classic algorithms).
- Questions about THIS repo (read the code instead).
- Repeating a question — reuse your earlier answer; the budget is per BUILD, not per story.

## How

```sh
node "$RALPH_GEN_RESEARCH" "your specific question" [research/notes.md]
```

- Prints a concise cited answer (`[1] https://…` sources). The optional second arg also saves it.
- **Budget:** limited calls per build (exit code 3 = skipped: disabled, budget spent, or no key).
  When skipped, proceed on your own knowledge and note the uncertainty in `progress.txt`.
- Ask ONE specific question per call ("current stable Next.js major + app-router data fetching
  API" — not "tell me about Next.js").

## Rules

- Facts from research that land in the deliverable MUST keep their citation: put the source URL in
  the content where appropriate (docs/slides) or in DELIVERABLE.md provenance (apps).
- Trust the researched answer over your training data for names, versions, and current facts.
- Never put secrets in questions; questions may be logged.
