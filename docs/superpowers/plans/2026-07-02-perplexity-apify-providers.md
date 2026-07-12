# Perplexity + Apify as providers (plan)

Two new BYO-key providers that attack the two biggest quality gaps in generated runs:
**stale knowledge** (the planner and workers know nothing past their training cutoff) and
**fake content** (deliverables filled with lorem-ipsum/made-up data instead of real facts).

## Why they make runs better

**Perplexity (Sonar — web-grounded LLM with citations, ~$1/M tokens + ~$5–12/1k requests):**
1. **Grounded PRDs.** The planner (OpenAI) has no web access — "build an app like X" plans on
   hallucinated/stale knowledge of X. A one-call Sonar research pass before planning feeds the
   planner current facts (competitor features, pricing pages, API/library versions) with citations.
2. **Real content in content-heavy deliverables** (docs/slides/web-app copy): cited facts instead
   of invented ones; provenance recorded in DELIVERABLE.md (mirrors the media-provenance rule).
3. **Worker unblock.** Agents wedged on framework/API churn (the #1 cause of REJECT→retry loops on
   niche stacks) can ask one grounded question instead of hallucinating an outdated API.
4. **Brownfield RESEARCH.md enrichment** with current docs for the frameworks found in the code.

**Apify (actor marketplace: run any scraper via one API call):**
1. **Real seed data.** Directory/catalog/dashboard builds ship with actual datasets (Google Maps,
   Amazon, social actors) via `run-sync-get-dataset-items` (single HTTP call, ≤5-min wait) —
   demos read as real products, not placeholders.
2. **Brand/competitor input** at clarify/plan time (scrape the user's existing site for copy/brand).
3. **Realistic test fixtures** for worker-written tests.
4. **MCP path exists** (Apify's official MCP server) — fits the existing `writeMcpConfig` wiring,
   so agents can discover actors as tools without new plumbing.

## Phases

- **A — providers in Settings (ship first, small):** `VAULT_PROVIDERS` += `perplexity`, `apify`;
  PUT shape checks; Settings+Admin "Research & data" card group (📋 Track comes free via AgentCard);
  `key-test.mjs` probes — apify: `GET /v2/users/me?token=` (free), perplexity: minimal
  `POST /chat/completions` ping (no models-list endpoint; same POST-ping pattern as token-plan);
  `provider-usage.mjs`: apify monthly usage via `/v2/users/me/limits`; platform-key admin parity.
- **B — planner grounding (perplexity):** pure `ralph/research.mjs` (prompt shape, citation parse,
  caps) + a one-call research pass folded into planner context when a key is present (like the
  brownfield RESEARCH.md block). Suggest-only; failure never blocks planning; stub-aware.
- **C — worker helpers (media-gen pattern):** `$RALPH_RESEARCH "q"` (sonar, per-run cap, default
  on/5 when key present) + `$RALPH_FETCH_DATA --actor <id> --input <json> --max-items N` (apify,
  default off/2 — scrapes spend platform credits), injected via `ralphEnvPrefix`; vendored skills
  `web-research` + `real-data` (cite sources, commit data + provenance, cap items, respect ToS).
  Both stub-aware (`RALPH_FORCE_TOOL` → deterministic fixtures).
- **D (optional) — Apify MCP:** `MCP_CAPABILITIES` += `web-data`; `writeRalphBrief` wires Apify's
  MCP server for stories that request it.

## Status + next-session pickup (updated 2026-07-02)

**ALL PHASES SHIPPED** — A+B (`4faf5bc`), C (`91e773a`), D (Apify MCP): providers in Settings/Admin with Test probes + apify live
balance; `groundIdea` folded into `planPrd` (suggest-only, never blocks, stub-skipped). Pure
logic in `ralph/research.mjs` (tested); POST-probe support added to `ralph/key-test.mjs`.

**Real-key smoke DONE 2026-07-02:** both keys connected + Test valid (perplexity probe fixed —
Sonar requires `max_tokens >= 16`, a smaller ping 400s and read as "invalid key"). A live
`groundIdea`-shaped Sonar call on "an app like Airbnb for renting boats in Karachi" returned
excellent cited grounding (market size, real local competitors, expected features incl.
JazzCash/EasyPaisa, current library versions) — grounded planning is live.

**Apify Actors API surface (browsed 2026-07-02, for Phase C):**
- Run + collect in ONE call: `POST /v2/acts/{actorId}/run-sync-get-dataset-items` (≤5-min wait)
  — the `$RALPH_FETCH_DATA` workhorse; async `POST /v2/acts/{id}/runs` + `GET /v2/actor-runs/{id}`
  (+ `/log`, `/abort`) for longer scrapes if ever needed.
- **`POST /v2/acts/{id}/validate-input`** — validate an actor input WITHOUT spending credits;
  use it as the fail-closed gate in the helper before any paid run.
- Discovery: `GET /v2/store` (search public actors) — could back a future "pick a scraper" UI
  or planner hint; `GET /v2/acts` lists the user's own actors.
- **`POST /v2/acts` (Create Actor)** with `sourceType: SOURCE_FILES` — agents could author +
  deploy CUSTOM scrapers programmatically (versions/builds APIs included). Powerful but a
  Phase-C+ decision: a generated scraper spends credits and can fail in ways a store actor
  won't; if added, gate behind its own per-run cap and prefer store actors first.

**Phase C SHIPPED 2026-07-02 (`91e773a`) — as checklist below, plus create-mode:** `$RALPH_FETCH_DATA
--create <name> --source <main.js>` authors + deploys a PRIVATE actor on the user's account
(user-requested; live-smoke proven: created, platform-built, ran, returned rows, deleted).
Remaining: **Phase D** (Apify MCP as `web-data` capability) + New Build UI toggles for the
research/data budgets (server accepts future `research` input via normalizeResearchBudget).

**Phase C checklist (as built):**
1. Pure `ralph/research-helpers.mjs` (or extend research.mjs): CLI arg parsing + caps for
   `$RALPH_RESEARCH "question"` (perplexity, default on/5 per run when key present) and
   `$RALPH_FETCH_DATA --actor <id> --input <json> --max-items N` (apify
   `run-sync-get-dataset-items`, 5-min sync cap, default off/2 — spends platform credits). TDD.
2. Runtime CLIs `ralph/gen-research.mjs` + `ralph/fetch-data.mjs` (fs/http; key via env, never
   argv), **stub-aware** (`RALPH_FORCE_TOOL` → deterministic fixture output).
3. `ralphEnvPrefix` injects `RALPH_GEN_RESEARCH`/`RALPH_FETCH_DATA` + caps as `RALPH_*` env
   (mirror `RALPH_GEN_IMAGE`); `run.research` budget object like `run.media` (normalize +
   UI toggle in New Build later).
4. Vendored skills `ralph/skills/web-research/SKILL.md` + `real-data/SKILL.md`: when to use,
   cite sources, commit datasets under `data/` with provenance in DELIVERABLE.md, cap items,
   respect site ToS. Injected by `writeRalphBrief` when the key exists (like media skills).
5. Stub e2e extension + CLAUDE.md update.

**Phase D SHIPPED 2026-07-02:** `apifyMcpServer` row (mcp.apify.com, streamable HTTP + Bearer,
handshake verified) appended by `mcpServersFor` when a key exists → planner sees `web-data` and
assigns it per-story; tools preconfigured to DISCOVERY only (actors/docs/RAG browser) — runs stay
on `$RALPH_FETCH_DATA` so the data budget holds. Remaining nice-to-have: New Build budget UI.

## Guardrails (same discipline as media gen)

Per-run caps with off-by-default for paid scrapes; cheap auth-only Test probes; per-story budgets
plannable later via the `applyMediaPlan` pattern; agent-facing helpers never receive the raw key
in argv (env only); generated repos already gitignore agent config dirs that would carry tokens.
