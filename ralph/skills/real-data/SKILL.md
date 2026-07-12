---
name: real-data
description: Fill data-driven deliverables with REAL datasets via $RALPH_FETCH_DATA (Apify, budgeted) — run a store scraper, or author + deploy a private custom actor when no store actor fits — instead of lorem-ipsum placeholders.
---

# Real data (Apify)

A data helper is available: it runs a scraper on the Apify platform and writes the resulting
dataset into the repo. An app or deck demo built on real rows reads like a product; one built on
"Item 1, Item 2" reads like a mockup.

## When to use it

- The deliverable is data-driven (directory, catalog, dashboard, comparison, market slide) and
  needs believable content.
- Realistic fixtures for tests are hard to hand-write.

**Budget:** very limited runs per build (scrapes spend the user's Apify credits; exit code 3 =
skipped — then write realistic seed data by hand instead). Plan ONE well-aimed fetch, not several.

## Finding the right actor

If the **Apify MCP** tools are wired into this session (stories planned with `web-data`), use them
to search the store, read an actor's documentation and exact input schema, and browse the live web
(RAG browser) BEFORE running anything. Discovery via MCP is free; **running actors goes through
`$RALPH_FETCH_DATA` only** (it enforces the data budget — never start runs via MCP).

## Mode 1 — run a store actor (PREFER THIS)

Thousands of maintained scrapers exist (Google Maps, Amazon, Instagram, TikTok, generic web
scraper…). Pick the obvious one for the data you need:

```sh
node "$RALPH_FETCH_DATA" --actor apify/google-maps-scraper \
  --input '{"searchStringsArray":["boat rental karachi"],"maxCrawledPlacesPerSearch":30}' \
  --max-items 30 --out data/places.json
```

- `--actor` is `<user>/<name>` from apify.com/store. Each actor documents its input JSON — keep the
  input minimal and set the actor's own "max results" field when it has one.
- Output: a JSON array written to `--out` (default `data/<actor>.json`). Commit it.

## Mode 2 — create a custom actor (only when NO store actor fits)

You can author a scraper and the helper deploys it as a PRIVATE actor on the user's account,
builds it on the platform, runs it, and collects the dataset:

```sh
node "$RALPH_FETCH_DATA" --create <project>-scraper --source scrapers/main.js \
  --input '{"startUrl":"https://example.com/list"}' --max-items 100 --out data/items.json
```

Write `scrapers/main.js` as a standard Apify actor (ESM; `apify` v3 + `crawlee` are installed):

```js
import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';
await Actor.init();
const { startUrl } = await Actor.getInput();
const crawler = new CheerioCrawler({
  async requestHandler({ $, request }) {
    await Actor.pushData({ url: request.url, title: $('h1').first().text().trim() });
  },
});
await crawler.run([startUrl]);
await Actor.exit();
```

- Name must be lowercase-with-hyphens. Re-running `--create` with the same name updates the actor's
  source and rebuilds (iterate if the first version returns bad rows). A failed platform build
  prints a console link — fix `main.js` and retry ONCE, then fall back to hand-written seed data.

## Rules

- **Respect the source**: scrape only public pages, keep volumes small (`--max-items` low), and
  don't collect personal data beyond what the deliverable genuinely needs.
- Record provenance in DELIVERABLE.md: which actor, what input, when, how many rows.
- Commit the dataset under `data/` — the app must work offline from the committed rows (never
  fetch from Apify at the app's own runtime).
- Never print or commit the Apify token; the helper reads it from the environment.
