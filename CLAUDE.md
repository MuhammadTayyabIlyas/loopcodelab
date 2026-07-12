# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

webtmux is a self-hosted web dashboard + xterm.js terminal over a tmux PTY bridge (see
`README.md`), extended with **Ralph** — an autonomous multi-agent build orchestrator that
turns an idea into a finished, git-tracked project served live at its own subdomain.

## Run / iterate

- Runs as **systemd `webtmux.service`, `User=tmuxweb` (uid 982)** — it MUST be `tmuxweb` so it
  shares the tmux server socket `/tmp/tmux-982` that all sessions (including Ralph's workers)
  live on. The Node app listens only on `127.0.0.1:8090`; **TLS + basic-auth are nginx's job.**
- After editing `server.js`: `systemctl restart webtmux` then `journalctl -u webtmux -f`. Restart is
  safe for live sessions — a `KillMode=process` drop-in (`/etc/systemd/system/webtmux.service.d/`, in
  `/etc`, **not** the repo) stops systemd from killing the shared tmux server. If sessions vanish on a
  restart, that drop-in is missing (default `KillMode=control-group` nukes the whole cgroup).
- After editing anything in `public/`: **bump `VERSION` in `public/sw.js`** (e.g. `webtmux-vN`),
  or the installed PWA serves stale cache-first assets. App JS/CSS are network-first; vendor/icons cache-first.
- Syntax-check before restart: `node --check server.js server/*.mjs server/routes/*.mjs`,
  `node --check public/js/dashboard.js public/js/dashboard/*.js`,
  `bash -n ralph/*.sh`, `node --check ralph/*.mjs` (covers `direct`, `capture-shots`, + the helpers). No linter.
- **Tests** cover the *pure* helpers only, via Node's built-in runner: `node --test ralph/*.test.mjs`
  (single file: `node --test ralph/solo-models.test.mjs`). The `server/` modules are side-effectful
  (only `server.js` binds the port, but modules own live state/timers) and are not directly
  unit-tested — extract pure logic into a focused `ralph/*.mjs` module to test it (pattern:
  `solo-models`, `rc-auth`, `adopt-paths`, `sudo-prune`, `key-test`, `agent-failure`, `smart-name`).
  Beyond units, drive the orchestrator end-to-end with the no-spend stub harness (see last section).
- **React SaaS UI build:** after editing `web/src`, `cd web && npm run build` (Vite → `web/dist`).
  `web/dist` is git-ignored and served from disk — never commit it; no service restart needed for
  `web/`/`public/` static changes (only `server.js` edits need a restart).
- `git` here is a manual checkpoint repo (commit when saving progress). `node_modules`, `*.bak`,
  and `.claude/settings.local.json` (holds local tokens) are git-ignored — never commit secrets.
- **Admin root maintenance shell:** the dashboard's "🔧 Root shell" button (`POST /api/maint-shell`,
  admin-gated in multitenant / basic-auth single-tenant) opens the `maint` tmux session whose pane is
  `exec sudo -s` — a root prompt in the repo dir — for ops (update `~/.webtmux/soloModels.json`, bump
  `public/sw.js` VERSION, `git pull`, `systemctl restart webtmux`). It enables the audited `webtmux-sudo`
  grant on open and auto-revokes it when the session ends (the session-DELETE route + a `deadSudoSessions`
  prune in `monitorTick`). Every open is audited.

## Layout

- **`server.js`** — the ENTRY POINT (systemd runs it) and assembly only (~100 lines). Registration
  ORDER here is load-bearing: preview host middleware + raw-body Stripe webhook before `express.json`;
  the saas auth gate before the API routes; the `/rc` pairing route before `express.static`.
- **`server/`** — the backend modules (each owns its mutable state; others use exported functions):
  `config.mjs` (env/paths/fs/audit/validators) · `secrets.mjs` (secrets.json + every provider-key
  getter) · `tmux.mjs` + `git.mjs` · `projects.mjs` (project dirs/SSH hosts/context scaffold) ·
  `skills.mjs` (skills catalog + MCP config + output formats) · `agents.mjs` (LAUNCHERS, per-agent
  creds/model flags, `ralphEnvPrefix`) · `llm.mjs` (planner call plumbing) · `planner.mjs`
  (planPrd/clarify/normalizePrd) · `prefs.mjs` (prefs/drafts/tracking) · `rc.mjs` + `push.mjs` ·
  **`ralph-engine.mjs`** (the orchestrator: `ralphRuns`, the 4s tick, spawn/supervision/packaging,
  start/adopt — the big one) · `preview.mjs` (subdomain previews + app processes) · `sudo.mjs` ·
  `monitor.mjs` (5s tick + draft timers) · `ws.mjs` (PTY WebSocket bridges) ·
  `routes/{saas,core,ralph,rc}.mjs` (the HTTP surface; in `routes/ralph.mjs` the fixed paths
  register before `/api/ralph/:project`).
- **`public/`** — the **PWA** (one of TWO frontends): `index.html` (dashboard + all Ralph dialogs),
  `js/dashboard.js` (entry) importing `js/dashboard/{sessions,ralph}.js` (session dashboard / Ralph
  UI; import order = execution order), `term.html`/`js/term.js` (xterm client),
  `sw.js`, `css/style.css`, `rc.html`/`js/rc.js`/`rc.sw.js` (phone remote control — see `/rc/`).
- **`web/`** — the **React + Vite + Tailwind SaaS UI** (second frontend), `src/pages/*` + a thin
  `src/api.js` client. Built (`cd web && npm run build`) to `web/dist`, served at `/` and `/app`
  (`server.js`). The SaaS new-build / admin / settings flows live here; the terminal + Ralph dialogs
  live in `public/`. UI behaviour can differ between the two — a bug may be in `web/`, not `public/`.
  The New Build flow is an idea-first 4-screen wizard (goal tiles → AI describe/refine →
  relevant-fields options + Advanced → review): `POST /api/ralph/analyze` (route in
  `routes/ralph.mjs`, pure logic `ralph/analyze.mjs`) does ONE combined inference —
  format/name/media/platforms/questions/brief, Perplexity-grounded when the idea references
  the live web — and is fail-soft: any failure returns a deterministic fallback and the
  wizard proceeds with today's defaults. `RALPH_FORCE_TOOL` → stub analysis. Screen state
  maps to the SAME `/api/ralph/start` body; drafts carry an optional additive `formatFamily`.
- **`saas/`** — multitenant control plane, active **only when `WEBTMUX_MULTITENANT=1`**: `auth.mjs`
  (sessions/`requireAuth`), `store.mjs`+`db.mjs` (SQLite `control.db`: users, workspaces, invites,
  vault keys), `tenants.mjs` (per-unix-user sandboxes; `tenant.wrap(argv)` runs git/tmux AS the
  tenant), `vault.mjs` (AES-GCM provider keys, `WEBTMUX_VAULT_KEY`), `billing.mjs`/`plans.mjs`
  (Stripe, inert unless `STRIPE_*` set). Single-tenant ignores all of this (nginx basic-auth only).
- **`ralph/`** — vendored loop + prompts the orchestrator runs in tmux sessions: `ralph.sh` (worker
  loop), `ralph-review.sh` (master review), `ralph-finalize.sh` (master finalize), `ralph-research.sh`
  (brownfield research), `ralph-deliver.sh` (flutter-app build→APK→Drive delivery), `direct.mjs` (glm
  worker — see below), `capture-shots.mjs` (store screenshots), `prompt.md`/`planner.md`/`review.md`/
  `finalize.md`/`research.md`, `stub-tool.sh`, `skills/<id>/SKILL.md` (vendored skill catalog — see
  Skills below), and the **pure, unit-tested helper modules** (each with a `*.test.mjs`): `solo-models`,
  `rc-auth`, `adopt-paths`, `sudo-prune`, `clarify-axes` (clarify discovery), `assets` (brand uploads),
  `provider-usage` (Settings live-balance configs — Moonshot/OpenRouter/DeepSeek; `GET /api/keys/:provider/usage`),
  `key-test` (per-provider auth-validity probe behind the Settings **Test** button; `GET /api/keys/:provider/test`),
  `agent-failure` (tell a worker that died on a 401/credential error apart from one that wrote bad code),
  `smart-name` (`smartName` distils a short project slug from the idea; `previewSafeProject` caps `<project>--<tenant>` to ≤63 chars),
  and the Flutter pipeline `flutter-env` / `flutter-deliver` / `store-submit` / `screenshots` / `feature-graphic`.

## Secrets & state (outside the repo)

- `~/.webtmux/` (= `/home/tmuxweb/.webtmux/`, owned by `tmuxweb`): `secrets.json` (OpenAI key+model,
  GitHub token), `vapid.json`, `subscriptions.json`, `audit.log`, `ralph/<project>.json` (one
  persisted run per project), `preferences.json` (learned user prefs — see below), and
  `skills/anthropic/` (optional clone of the skills repo). Override the dir with `WEBTMUX_DATA`.
- Generated projects live in `~/.webtmux/../projects/` → `/home/tmuxweb/projects/<project>` (`PROJECTS_ROOT`).
  `regenerateProjectIndex` writes `INDEX.md` + `projects.json` there (an agent-facing index of every
  run with guiding anchors), rebuilt on every state change, on delete, and on boot.
- Wildcard-cert DNS-01 hook token: `/root/.secrets/hostinger.token`; certbot hooks in `/etc/letsencrypt/hostinger/`.
- **GitHub tokens must be able to CREATE repos** (`ensureRemote` does `POST /user/repos`), or runs end
  `push_failed`: classic PAT with `repo` scope, or fine-grained with All repositories + Contents RW +
  **Administration RW**. Tenant runs use the tenant's vault key (`PUT /api/keys/github`, `control.db`
  `api_keys`, AES-GCM with `WEBTMUX_VAULT_KEY`) before falling back to `secrets.json`. Recovery: fix
  the token → dashboard **Doctor** button (re-creates remote, re-pushes). See README "GitHub token
  requirements".

## Ralph orchestrator (the core subsystem)

A run builds a whole project from one prompt. Roles: **planner** = OpenAI (`callOpenAI`, model from
secrets) splits the idea into `prd.json` stories and assigns each to a CLI agent; **workers** build
stories in parallel; **master** (one CLI agent) reviews each branch, integrates, and finalizes.

Flow (`startRalphRun` → `ralphTick`, a single 4s `setInterval` loop over the in-memory `ralphRuns` map):

1. **Init**: `git init` a fresh repo, OpenAI plans `prd.json`, commit it; create the GitHub repo +
   push the scaffold up front (`ensureRemote`/`gitPushRef`, best-effort — never fatal).
2. **Per story**: a **git worktree on branch `prd/<id>`** (parallel isolation) + a worker tmux session
   running `ralph.sh`. The worker writes `.ralph/<id>.exit` when done (sentinel the tick polls).
3. **Reap → review**: tick reaps the exit file → master review session writes `.ralph/<id>.verdict`
   (`ACCEPT`/`REJECT`). ACCEPT → merge branch into `main` (`gitMergeBranch`, aborts on conflict) + push.
   REJECT or merge-conflict → retry the story on the current `main` (up to `maxAttempts`).
4. **Finalize**: all stories merged → master finalize (`ralph-finalize.sh`, PASS/FAIL) → `ensureReadme`
   → final push → phase `done`. Any failure path is bounded.

**Mid-build supervision + MASTER.md**: the tick checkpoints slow stories (`WEBTMUX_CHECKPOINT_MS`, 6m,
max 2/story) — a one-shot LLM call (master persona, tenant credential, `callPlanner`) sees the worker's
pane and replies continue / steer (note → worktree `.ralph/steer.md`, which `prompt.md` tells the worker
to read) / restart (respawn with direction; branch commits survive). Workers escalate design forks to
`./.ralph/question.md` (answered into `.ralph/answer.md`; the worker never blocks). Everything is
journaled in the per-build `MASTER.md` logbook (`<run>/.ralph/MASTER.md`, rendered by `writeMasterLog`
on every persist from structured `run.masterLog`): status board + rulings + steering + learnings.
Supervision calls READ the log (consistent rulings, no re-derivation) and new worker briefs inherit
standing rulings (`masterNotesForBrief`). Skipped for glm + `RALPH_FORCE_TOOL`. UI "Master log" tab;
`GET /api/ralph/masterlog?project=`.

Key invariants when changing this code:
- Workers **never edit `prd.json`** — the orchestrator owns it on `main` (else every branch conflicts).
  `progress.txt` uses a `merge=union` gitattribute for the same reason.
- **`story.phaseSince` + `RALPH_STALL_MS` (8m)**: a story stuck building/reviewing past it (agent hung
  or wrote no sentinel) is reaped and retried — this is the only thing that stops a dead agent hanging a run.
- Review/finalize scripts must **always write their verdict/result** (`|| true`) so a tool failure can't hang the tick.
- **`initRalphRuns()` at boot** re-registers in-progress runs into `ralphRuns`; otherwise a restart
  orphans them (the tick only iterates the in-memory map). `loadRun` re-registers on demand.
- **Two caps** (don't recombine): `maxAttempts` (master review→retry cycles) vs `workerPasses`
  (`ralph.sh --max`, self-retries per spawn).
- **Project names are slugified** (`slugify`) so they are valid DNS labels for the preview subdomain.
  Two follow-on rules (`ralph/smart-name.mjs`, both routes `/api/ralph/plan` + `/start`): a blank name is
  **smart-named** from the idea (`smartName` — short, meaningful, ≤32 chars; do NOT slugify the whole prompt),
  and the slug is then capped by `previewSafeProject` so the preview host `<project>--<tenant>.<domain>` fits
  in **one 63-char DNS label** (RFC 1035). The budget is across BOTH parts — a 63-char project + `--<tenant>`
  is 80 chars and the hostname never resolves (this exact bug made a long-named build's preview unreachable).

### Agents
Keys come from `LAUNCHERS`/`VALID_AGENTS`: `claude`, `codex`, `qwen`, `gemini`, `glm`, `kimi`, `grok`, `vibe`.
**BytePlus one-key rule:** a single ARK key covers the whole account — the glm agent (coding base
`/api/coding/v3`), the `byteplus` claude-plan preset (`/api/coding`, blank-key resolves from the
glm/ark vault keys), and Seedance video (ModelArk `/api/v3`). Cross-reuse is wired (glm↔ark vault
fallbacks). **Billing trap:** `/api/v3` does NOT draw from the Coding Plan (bills pay-as-you-go) —
coding traffic must stay on `/api/coding*`; only video belongs on `/api/v3`. Curated plan models:
`BYTEPLUS_CODING_MODELS` (providers.mjs — `ark-code-latest` auto mode, glm-5.1/4.7, kimi-k2.5,
dola-seed, seed-code, gpt-oss-120b).
Workers run in bypass/yolo mode (`RALPH_BYPASS=0` disables it). **glm = the `claude` CLI on GLM-5.1 via
BytePlus**; it is unreliable in the agentic loop, so it is **blocked as master** and runs as a worker
via a **direct single-shot API call** (`ralph/direct.mjs` → `{files:[{path,content}]}`), not the agentic
CLI. **kimi** (Moonshot Kimi Code CLI) and **grok** (xAI Grok Build CLI) are their OWN binaries in
`/usr/local/bin` (installed via their vendor scripts, NOT npm/claude) and ARE master-capable. Prefer
claude/codex/kimi as master. A failed run surfaces an `attention` block; `POST /api/ralph/swap`
reassigns an agent (a story mid-build, or master when idle) and retries.

**Adding/maintaining an agent — the per-CLI quirks that bite:** each agent's launch line lives in
`ralph.sh` (worker) AND **all three** master scripts `ralph-review.sh` / `ralph-finalize.sh` /
`ralph-research.sh`. A new agent missing from the master scripts' `case "$TOOL"` falls through to
`*) unknown tool` → no verdict written → **every story silently REJECTs** even though the worker built
fine. So a new agent touches: `LAUNCHERS` (`server/agents.mjs` + `public/js/dashboard/sessions.js`), `AGENT_CRED_PROVIDERS`,
`VAULT_PROVIDERS`, `tenantAgentCreds`, `runModelFlag`, the four `ralph*.sh`, and the web/+public UIs.
The agent's own CLI must be installed **globally + world-readable in `/usr/local/bin`** — tenant
sandboxes run as `wt_*` unix users, so a binary under `/root` (or a symlink into a private home) won't
run: grok needed its real binary copied there; kimi/vibe install to an explicit world-readable dir
(`KIMI_INSTALL_DIR=/usr/local`, `UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin`).
Invocation differs per CLI and is easy to get wrong: claude/codex pipe the prompt on **stdin**, but
gemini/qwen/kimi/grok/vibe take it as a `-p "<arg>"`. Autonomy flags differ: claude/glm
`--dangerously-skip-permissions`, codex `--sandbox danger-full-access`, gemini/qwen `--yolo`, grok
`--always-approve --no-auto-update`, and **kimi takes NO bypass flag** — `kimi -p` is autonomous by
default and ERRORS on `--yolo`/`--auto` ("Cannot combine --prompt with --yolo"). kimi's key lives in
`~/.kimi-code/config.toml` (written by `tenantAgentCreds`, NOT shell env; the `[models.*]` block needs
`max_context_size`); grok reads `XAI_API_KEY` from the env and must be pinned to `--model grok-build-0.1`
(the bare `grok-build` alias 404s on some accounts); **vibe** (Mistral Vibe Code CLI, installed via
`uv tool install mistral-vibe`) reads `MISTRAL_API_KEY`, has no `--model` flag (config-based default
`mistral-vibe-cli-latest`), and needs `--trust` for non-interactive runs — `vibe --yolo --trust -p`.
kimi/grok also support a subscription device-login (`kimi login` / `grok login --device-auth`,
detected via `CLI_LOGIN_FILES`). **qwen needs `OPENAI_BASE_URL`, not just the key:** `tenantAgentCreds`
sets `OPENAI_BASE_URL=qwenBaseUrl()` + `OPENAI_MODEL` alongside `DASHSCOPE_API_KEY`/`OPENAI_API_KEY` —
without the base URL the qwen-code CLI aborts headless with **"No auth type is selected"** (it infers
the `openai` auth type from the base URL's presence), and an Alibaba **monthly-token-plan** key
(`sk-sp-…`, host `token-plan.<region>.maas.aliyuncs.com/compatible-mode/v1`) **401s the default
DashScope endpoint** — so the base URL is load-bearing twice. All three qwen surfaces must agree on it:
planner (`qwenBaseUrl()`), worker (`tenantAgentCreds`), and the Settings **Test** probe (`key-test.mjs`
`buildKeyProbe(..,{baseUrl})`, else it hardcodes `dashscope-intl` and mis-reports a valid token-plan key
as invalid). **Token-plan coding agents:** the `tokenplan` `CLAUDE_PLAN_PRESET` runs the claude CLI against the Alibaba
token-plan Anthropic base (`…/apps/anthropic`) so ONE `sk-sp-…` key powers qwen/glm/kimi/deepseek/minimax as
the claude agent (model picked per build). It **reuses** the stored `qwen` key — `claudePlanOf` resolves a
blank-key `{preset:'tokenplan'}` plan from `get('qwen')`/`qwenKey()`, and the `claude-plan` PUT allows a blank
key for this preset only. Its Settings **Test** uses a `POST /v1/messages` ping (these hosts 404 `GET /v1/models`).
Curated model ids live in `ralph/providers.mjs` (`TOKEN_PLAN_TEXT_MODELS`), surfaced via `/api/keys` `planModels`.

### Media generation (image/video/audio in deliverables)
Ralph builds can generate media into visual deliverables via vendored, agent-invoked helpers (like the
imagery skill): `ralph/gen-image.mjs` (token-plan MaaS, reuse the qwen key), `ralph/gen-video.mjs`
(BytePlus ModelArk/Seedance, `ark` vault key), `ralph/gen-audio.mjs` (`--type music` → Suno `suno` key /
`--type voiceover` → ElevenLabs `elevenlabs` key). Pure logic + parsers are in `ralph/media-gen.mjs`
(tested); fs/http in `ralph/media-runtime.mjs`. Per-kind opt-in + cap (`run.media`, defaults image on/8,
video off/2, audio off/3) is injected into worker sessions by `ralphEnvPrefix` as `RALPH_*` env +
`RALPH_GEN_*` paths; `writeRalphBrief` states the budget and injects the media skill for `VISUAL_OUTPUT`
formats. Helpers are **stub-aware** (`RALPH_FORCE_TOOL` → deterministic placeholder, no spend). New vault
creds: `ark`/`suno`/`elevenlabs` (Settings + Admin "Media generation" cards). Call shapes proven in
`/home/wt_tayyabcheema777/projects/video/backend/app/services/generation_service.py`.
Media-aware planning (Part A): the planner receives the build's media budget and may
add an optional per-story `media: {image,video,audio}` count; `normalizePrd` runs
`applyMediaPlan` (`ralph/providers.mjs`) to sanitize it and clamp the per-kind TOTAL
across the whole PRD to the cap (disabled kinds → 0). The counts are editable per story
in the `web/` review step (read-only in the PWA confirm dialog) and `writeRalphBrief`
tells each worker exactly what to generate for its story.

**Grok Imagine media provider (subscription-powered).** The grok CLI device-login JWT
(`~/.grok/auth.json`, read fresh per spawn via `grokLoginKey` — it rotates) authenticates
api.x.ai's imagine models on the plan's Imagine credits (verified live 2026-07-02: real image +
real MP4 through the helpers; **undocumented xAI behavior — helpers fail soft**). `gen-image`/
`gen-video` take `RALPH_IMAGE_PROVIDER`/`RALPH_VIDEO_PROVIDER=grok` (image `images/generations`;
video `videos/generations` → poll `/videos/{id}`, pending/done/expired/failed, duration 1–15s).
Selection in `ralphEnvPrefix`: `secrets.imageProvider/videoProvider='grok'` (or
`WEBTMUX_IMAGE/VIDEO_PROVIDER`) prefers grok; else paid keys (token-plan image / ark video) win
and grok is the no-key fallback. THIS deployment: `videoProvider=grok` (replaces pay-per-second
Seedance), images stay token-plan.

**Credential validity vs. presence (a recurring footgun).** `sandboxLogins`/`missingAgentCreds` only check
that a credential FILE/vault key EXISTS, not that it works — so a dead key can read as "signed in" and a valid
login under a renamed file can read as "not connected" (CLIs rename creds: `CLI_LOGIN_FILES` values may be a
**list** of candidate filenames — e.g. gemini's `oauth_creds.json` → `gemini-credentials.json` — matched by
`loginExistsTest`). Two guards: the Settings **Test** button (`GET /api/keys/:provider/test`, `ralph/key-test.mjs`
— a cheap auth-only probe, no LLM spend; for github it also reports token scopes), and at runtime `agent-failure.mjs`
`detectAuthFailure` — a worker that exits with ZERO commits and a 401/`Invalid Authentication`/`not logged in`
pane is labeled an **auth failure** (reroute to the next agent, or fail with "check the API key in Settings")
instead of the misleading "did not meet acceptance criteria" reject that a dead key used to produce. Kimi's
config also shows the trap: a stale `[providers.kimi]` API key shadowed a valid `managed:kimi-code` subscription —
fix was pointing `default_model` at the subscription model, not the dead-key model.
**Platform keys vs. the tenant vault (admin Settings).** Multitenant Settings reflects only the per-tenant
vault (`listProviderKeys`), so the admin saw `secrets.json` keys builds fall back to (e.g. the token-plan
`qwenApiKey`) as "not connected" even though they work. `GET /api/keys` now appends admin-only, display-only
"connected · platform" entries for platform-supplied providers not already in the vault (`ralph/platform-keys.mjs`
`platformKeyEntries(platformKeyValues(), have, isAdminEmail)`), and the **Test** route falls back to the platform
key for the admin (`platformSecretFor`). BYO tenants get nothing (strict-BYO preserved); a real vault key wins.

**Research & data providers (perplexity/apify — Phases A+B of their plan).** Two BYO vault keys
(Settings + Admin "Research & data" cards; platform fallbacks `secrets.perplexityApiKey`/`apifyToken`):
`perplexity` powers **planner grounding** — `planPrd` calls `groundIdea` (one cheap Sonar call,
`search_context_size: low`, 15s timeout) and folds a cited "current-web research" block into the
planner prompt when `shouldGround(idea, fmt)` says the idea references the live world (content-heavy
formats, or URLs/"like X"/market markers). **Suggest-only and best-effort by construction**: no key,
timeout, API error, or `RALPH_FORCE_TOOL` → `''` and planning proceeds unchanged — never let grounding
block or fail a plan. Pure logic in `ralph/research.mjs` (tested).
Perplexity's Test is a minimal POST ping (no GET /models exists; **`max_tokens` must be ≥16** or it
400s and reads as an invalid key) — `KEY_TESTS` supports POST probes.
**Phase C worker helpers (media-gen pattern, live-smoke proven):** `$RALPH_GEN_RESEARCH "question"
[out.md]` → cited live answer (Sonar; default cap 5/build) and `$RALPH_FETCH_DATA` → real datasets
into `data/` (Apify; default cap 2/build — scrapes spend credits). fetch-data has TWO modes:
`--actor <user/name>` runs a store actor via `run-sync-get-dataset-items` (prefer this), and
`--create <name> --source <main.js>` **authors + deploys a PRIVATE actor on the user's account**
(SOURCE_FILES: Dockerfile/package.json/agent-written main.js → platform build → run; re-`--create`
with the same name updates+rebuilds, so agents can iterate). Pure logic (`normalizeResearchBudget`,
`parseFetchDataArgs`, `runSyncUrl`, `actorScaffoldFiles`, `createActorPayload`) in `ralph/research.mjs`
(tested); CLIs `ralph/gen-research.mjs`/`fetch-data.mjs` share media-runtime's count file (one
`.ralph/media-count.json` per build bounds research/data along with media kinds) and are stub-aware
(exit 3 = skipped: disabled/cap/no key → the skill tells the agent to fall back gracefully).
`run.research = normalizeResearchBudget(null)` at start; `ralphEnvPrefix` injects helper paths +
caps + keys (key presence = the opt-in); `writeRalphBrief` injects the vendored `web-research` /
`real-data` skills ONLY when the tenant has the matching key (`researchKeysFor`). Phase D (Apify
MCP) still pending — see `docs/superpowers/plans/2026-07-02-perplexity-apify-providers.md`.

**Subscription tracking (Settings "Track" dialog).** Every Settings provider card has a 📋 Track
button → a dialog for the user's planning notes on that subscription: start/end dates (days-left on
the card, warn <7d), peak/off-peak hours, current usage, notes, and a dashboard link. Display-only
metadata — never a secret, never gates a build; the credential stays in the vault. Pure validation in
`ralph/sub-tracking.mjs` (tested: real-calendar dates, http(s)-only links, all-empty → delete);
per-tenant map in control.db `tracking` (migration 6) / `~/.webtmux/tracking.json` single-tenant;
`GET/PUT/DELETE /api/tracking(/:provider)`. UI is `web/` Settings only (`TrackDialog`; AgentCard's
optional `tracking`/`onTrack` props — Admin doesn't pass them, so no button there).

**Social-video output format (Phase 1).** `social-video` ∈ `OUTPUT_FORMATS`: a ~30s story
video rendered per platform. Pure specs/arg-builders/storyboard recipe in `ralph/social-formats.mjs`
(tested), local composition CLI `ralph/compose-media.mjs` (`$RALPH_COMPOSE`, ffmpeg — free, bounded
by RALPH_COMPOSE_CAP/MB not spend; agents write a declarative `storyboard.json` and call the `story`
one-shot + `gallery` for the preview page — never raw ffmpeg), skill `ralph/skills/social-video/SKILL.md`, verification
`ralph/media-validate.mjs` → `run.mediaReport` (advisory, checkPwaCompliance pattern). Per-build
`platforms` + `mediaModels` (pickers in web/ NewBuild; `normalizeMediaModels` gates; env
overrides ride the existing RALPH_*_MODEL vars). Outputs `output/<name>-<platform>.mp4` + a
root index.html gallery on the preview subdomain. No-spend e2e: `bash docs/ops/social-video-stub-e2e.sh`.

**Deployment default agent + per-run model.** `WEBTMUX_DEFAULT_AGENT` (e.g. `kimi`) seeds the New Build
pickers (exposed via `/api/keys` `defaultAgent`) so a single-agent deployment doesn't push users at
agents they can't use; the UI also falls back to whatever the user has connected. A `model` field on
`/api/ralph/start` (`run.model`, `validModelId`-gated) overrides the model for one build — spliced as
`--model` for raw-key agents, baked into kimi's config.toml, suppressed when a claude coding plan
already pins `ANTHROPIC_MODEL`.

**Solo mode (single developer).** A run with a master and **zero workers** is allowed for
any master: `normalizePrd` clamps every story's `assignee` to the master (planner already
permits this), so the one agent builds each story and also reviews/merges/finalizes. In solo
mode the orchestrator splits models per role — **build** on a low-cost model, **review +
finalize** on a top model — via `soloModelFlag` (`ralph/solo-models.mjs`) spliced as `--model`
into the worker/review/finalize scripts. Defaults: claude build `claude-sonnet-4-6`, review
`claude-opus-4-8`; other agents use their CLI default until an admin sets ids. Suppressed for
glm and for a claude coding plan (which already pins `ANTHROPIC_MODEL`). Admin-managed map:
`~/.webtmux/soloModels.json` (env override `RALPH_SOLO_MODELS`), `GET /api/ralph/solo-models`,
`PUT /api/admin/solo-models`, edited in the Admin page.

### Brownfield: adopt an existing project
Besides greenfield (`/api/ralph/start`), Ralph adopts an EXISTING local directory. Dashboard
"📥 Adopt existing" browses the server fs (`GET /api/ralph/fs-list`, read-only, path-policy
gated by `ralph/adopt-paths.mjs`) and picks a dir; `POST /api/ralph/adopt {project,sourcePath,
master}` validates + copies it in (`git clone` if a repo, else `cp -a` + `gitInitProject`;
original untouched) and runs a one-shot read-only **research pass** (`spawnResearch` →
`ralph/ralph-research.sh` + `ralph/research.md`) that commits `RESEARCH.md`. Phases:
`researching` → `awaiting`. Then `POST /api/ralph/instruct {project,idea}` plans with
RESEARCH.md as context (brownfield block in `planner.md`) and hands off to the normal build
flow. `GET /api/ralph/research` returns RESEARCH.md. Path denylist + read-only research are
the guardrails (agents run in bypass on the adopted code, as in greenfield).

**SSH source (remote server):** the adopt dialog's Local | Remote toggle also adopts a project
on another server. Remote browse (`GET /api/ralph/ssh-list?host=&path=`) runs `ssh <host> 'cd …
&& pwd && ls'` where `host` is an allowlisted `~/.ssh/config` alias (`listSshHosts`, injection-safe);
the remote path is single-quoted for the remote shell (`shRemoteQuote`). Adopt with
`source:{type:'ssh',host,path}` clones (`git clone <host>:<path>`) or `rsync -s -e ssh`es the
remote in (read-only on the source), then runs the same research → instruct → build flow; results
go to a NEW GitHub repo. Keys live in `~/.ssh/config` (no new secrets). Single-tenant intended.

### Skills, tools & deliverable format
**PWA-by-default (web-app builds).** Every `web-app` build ships an installable PWA: `writeRalphBrief`
injects the vendored `pwa-baseline` skill (`ralph/skills/pwa-baseline/SKILL.md`) into the worker AND
finalize briefs (manifest + service worker + icons + offline fallback, all brand-derived — no hardcoding).
At finalize PASS, `checkPwaCompliance(run)` scans the built static output and records `run.pwa`
(`{compliant, missing, warnings}`) using the pure `ralph/pwa-validate.mjs` validator — **advisory only, it
never fails a build**. This makes every web app browser-installable and is the prerequisite for the later
Store PWA packaging path (see `docs/superpowers/specs/2026-07-01-pwa-default-windows-packaging-design.md`).

The planner also assigns each story `skills`, `tools`, and an `outputType`, and the run carries a
project-level `outputFormat` (`OUTPUT_FORMATS`, chosen up front). **Skills are injected, not installed:**
`loadSkillsCatalog()` reads vendored `ralph/skills/*/SKILL.md` (plus an optional shallow clone of
github.com/anthropics/skills), and `writeRalphBrief` concatenates the assigned skills' text + an
MCP-tools note + the output intent into `.ralph/skills.md`, handed to the worker via `RALPH_SKILLS_FILE`
(read by `ralph.sh`) — so skills work for **every** agent, not just claude. When a story has `tools`,
`writeMcpConfig` wires that worktree to the MCP gateway (`MCP_GATEWAY`: Google Docs/Sheets/Slides/Drive,
Gmail, Calendar). `OUTPUT_SKILL`/`OUTPUT_TOOLS` map the chosen format to the skill+tools the finalize
pass uses to produce the deliverable (a file, or a live Google link recorded in `DELIVERABLE.md`).
- **The MCP config carries the gateway key**, so generated repos gitignore `.claude/.codex/.qwen/.gemini`
  (set in `gitInitProject`) — a worker must never commit them.
- `normalizePrd` re-sanitizes these (`tools` ∈ `MCP_CAPABILITIES`, `outputType` ∈ `OUTPUT_FORMATS`);
  they round-trip through `prd.json`, `prdFileShape`, and the **editable** confirm dialog. glm workers
  use `direct.mjs` (no MCP) — the `google-workspace` skill tells them to fall back to a downloadable file.

### Brand & visual inputs (clarify + assets + imagery)
- **Format-aware clarify.** `clarifyQuestions(idea, outputFormat, tenant)` builds its prompt from
  `ralph/clarify-axes.mjs` (`clarifyAxesFor` → `{axes, cap, contentHeavy}`): content-heavy formats
  (`web-app`/docs/slides) ask brand/audience/business discovery (cap 6) and must NOT skip an unanswered
  axis; sheets/auto stay technical (cap 4). The `public/` PWA clarify dialog uses it; the **`web/` React
  SaaS new-build flow has no clarify step** (idea → plan → review), so discovery questions surface only
  in the PWA today.
- **Brand asset upload.** Optional tray (PWA clarify dialog; web/ Configure step) uploads one file per
  request to `POST /api/ralph/assets` (`express.raw` octet-stream, `?name=`/`?token=`/`?note=`), validated
  + sanitized by `ralph/assets.mjs` (png/jpg/jpeg/webp/gif/svg/pdf, ≤10 MB, ≤12). Staged under
  `~/.webtmux/staged-assets/<token>/` (`meta.json` carries tenant slug for scoping); `monitorTick` prunes
  dirs older than 6 h (`staleStagedAssets`). `/api/ralph/plan` folds the manifest into the planner
  context; `startRalphRun` commits the files to `<repo>/assets/brand/` + `MANIFEST.md` (`commitStagedAssets`).
- **Imagery skill.** Vendored `ralph/skills/imagery/SKILL.md` (auto-discovered) tells any agent to use
  `assets/brand/` first, else free stock (`UNSPLASH_ACCESS_KEY`/`PEXELS_API_KEY`, else keyless
  placeholders) with good alt text. `writeRalphBrief` injects it for visual outputs (`web-app`,
  `google-slides`, `pptx`). It now also carries the AI media helpers (`$RALPH_GEN_IMAGE/VIDEO/AUDIO`, Plan 2)
  and the output-quality rules: one consistent project **style descriptor** reused across prompts, prompt
  structure subject→setting→style→lighting→technical, web-hero / one-image-per-slide placement, informative
  `alt` ≤125 chars vs decorative `alt=""`, and model+prompt provenance in `DELIVERABLE.md` (spec:
  `docs/superpowers/specs/2026-07-01-media-quality-backlog-design.md` Part 0). `getSkillMd` reads the file
  fresh per build, so skill edits take effect without a restart.

### Windows installer + Microsoft Store (web-app, Phases 2a/2b/3)
A finished `web-app` build can be packaged as a **Windows desktop installer** (Tauri) and a
**Microsoft Store package** (Electron appx). Both **build on a GitHub Actions `windows-latest`
runner**, never on this box, and both are proven against real Actions runs + the full UI flow
(installer e2e 2026-07-02: button → Actions 10m30s → real 1.9 MB PE32 `.exe` on Drive).
- **Installer (2a+2b):** `POST /api/ralph/windows/installer` (buttons in BOTH UIs — `web/` BuildDetail
  and the PWA status dialog; gated `web-app`+`done`) → `prepareWindowsInstaller` writes the Tauri
  `src-tauri/` scaffold + `windows-package.yml` + `WINDOWS-INSTALLER.md` (pure gens in
  `ralph/windows-scaffold.mjs`), pushes, then enters **`windows-delivering`** — `spawnWindowsDelivery`
  runs `ralph/ralph-windows-deliver.sh` (app-user; `GH_TOKEN` = tenant token) which dispatches/polls
  the Action, downloads the `windows-installer` artifact, and shares the `.exe` to Drive via the
  privileged **`webtmux-artifact-share`** wrapper; the tick reaps `.ralph/windows-deliver.json` →
  `DELIVERABLE.md` (link+QR) → push + Web Push → `run.windows.installer.shareLink`.
- **Store (Phase 3):** `POST /api/ralph/windows/store` — packaging `electron` (default, automated)
  scaffolds a `store-electron/` wrapper + `windows-store.yml` (pure gens in `ralph/windows-store.mjs`;
  robocopy stages the web output, `electron-builder --win appx` builds an **unsigned** appx — the
  Store re-signs uploads free) and reuses the same `windows-delivering` flow with
  `run.windowsDeliverKind='store'` (deliver script `--kind store` → `windows-store` artifact,
  `*.appx/*.msix`) → `run.windows.store.shareLink`. Packaging `pwa` is a **validated manual step**
  (PWABuilder has NO packaging CLI/API — pwa-builder/pwabuilder#5470): it only writes
  `SUBMISSION-WINDOWS.md` pointing at pwabuilder.com + the preview URL. `POST /api/ralph/windows/submit`
  refreshes the reserve-first Partner Center checklist and best-effort wires the OPTIONAL
  `windows-signing` cert as Actions secrets (`WINDOWS_CERT_BASE64/_PASSWORD`; installer sideloading
  only — Store needs no signing). **Fail-closed identity gate** (`validateStoreInput`): Partner Center
  identityName + `CN=…` publisher + display name (≠ product name), from the request or the
  `windows-store` vault key. The `store-electron/` wrapper must NOT use `build/` as buildResources
  (web apps build into `./build`) — it uses `build-res/`. A delivery failure never fails the build.
  Stub-aware; isolated no-spend e2e: `bash docs/ops/windows-store-stub-e2e.sh`.
**Ops prerequisite:** install the host helper — `sudo install -m 0755 docs/ops/webtmux-artifact-share.sh
/usr/local/sbin/webtmux-artifact-share` + the `tmuxweb` sudoers line (see the script header; allowlist
covers `.exe/.msi/.apk/.aab/.appx/.msix`); the tenant github token needs `workflow`+`actions:write` scope.
Vault: `windows-store` {identityName, publisher, publisherDisplayName}, `windows-signing` {pfxBase64,
password} (Settings + Admin "Windows desktop & Store" cards). Known deferred Minor: the deliver script's
run-id discovery grabs the latest dispatch of that workflow — two CONCURRENT deliveries on one repo could
watch each other's runs (deliveries on one run are phase-gated, so this needs two separate builds sharing
a repo).

### Flutter app builds (`flutter-app` output format)
A first-class output format that builds a **Flutter app (Android + web)**. The build/preview/APK
delivery is Android + web (this box is headless Linux — no local iOS build); **iOS ships only as a
store-submission scaffold** (Codemagic cloud-macOS CI), not an in-loop build.
- **Plumbing (additive):** `flutter-app` ∈ `OUTPUT_FORMATS`; `OUTPUT_SKILL['flutter-app']='flutter-deliverable'`;
  in `VISUAL_OUTPUT` so the `imagery` skill auto-injects. Mirrored in both UIs (`web/` `FORMATS`, the PWA
  `<select>` + `ralphOutputFormats`). Vendored skills: `ralph/skills/{flutter-app,flutter-deliverable,firebase}/SKILL.md`.
- **Clarify:** `clarify-axes.mjs` has a `flutter-app` content-heavy entry (cap 6) incl. the **Firebase/backend
  question** (accounts / cloud sync / push → wire Firebase, else local-only). The **`web/` React flow now has a
  clarify step** (Configure → Clarify → Review), folding answers into `api.plan` like the PWA.
- **Toolchain access (`ralph/flutter-env.mjs`):** shared `/opt/flutter` + `/opt/android-sdk` (already installed).
  `flutterEnvAssignments` (spliced into `ralphEnvPrefix` for flutter runs) sets per-runner `PUB_CACHE`/`GRADLE_USER_HOME`
  under `$HOME` + the SDK PATH. Host setup is `docs/ops/flutter-tenant-access.sh` (idempotent, admin-run):
  `git safe.directory /opt/flutter` (else non-owner flutter hits "dubious ownership") + a **`flutterbuild` group**
  (setgid on `bin/cache`) so `wt_*` tenants can write Flutter's engine stamps. `provision-tenant.sh` auto-enrolls
  new tenants. **Group changes need new processes** — restart `webtmux` (and note the long-lived tmux server may
  predate enrollment; the delivery script uses `sg flutterbuild` to sidestep that).
- **Delivery (T6, the tricky boundary) — the APK is now ON-DEMAND:** finalize PASS → phase `done` immediately
  (the web preview is already built by finalize, served from `build/web`). The installable APK + Drive link/QR
  is a **user-triggered** step: `POST /api/ralph/apk` (the **"Create APK"** button on a finished build, placed
  BEFORE "Submit to Play") enters the **`delivering`** phase and spawns `ralph/ralph-deliver.sh` **as the app
  user** (no tenant prefix on the session name) — it builds `flutter build web` + `flutter build apk --release`
  (**debug-signed by default → installable for testing**), then uploads the APK via **`sudo /usr/local/sbin/webtmux-apk-share`**.
  **Firebase apps need `android/app/google-services.json`** (the `com.google.gms.google-services` Gradle plugin
  requires it; the web build doesn't — it uses `firebase_options.dart`). When Firebase was connected via CLI
  login (no pasted config in the vault), `ensureAndroidFirebaseConfig` fetches it with the tenant's `firebase`
  CLI (`firebase apps:sdkconfig android`) into `.ralph/google-services.json` before the build — without it
  `flutter build apk` fails. (`spawnDelivery` resolves the script dir before `cd`, so `capture-shots.mjs` runs
  regardless of how `$0` is passed.)
  **The APK is built ONLY here, never at finalize** — this box has ~8G RAM and Flutter's default Gradle heap is `-Xmx8G`,
  so an uncapped build OOM-kills it. The script writes a capped `$GRADLE_USER_HOME/gradle.properties` (`-Xmx1536m`,
  `org.gradle.daemon=false`, `workers.max=2`, `kotlin.daemon.jvmargs=-Xmx1g`) and serializes the apk build with
  `flock /tmp/webtmux-flutter-build.lock` so concurrent deliveries can't pile up. (The `flutter-deliverable` skill tells
  the finalize agent to do web-only — the apk is the orchestrator's job.) **Same OOM applies to WORKERS:** an agent
  running `flutter build apk` mid-story spawns the 8G daemon too, so `flutterGradleCapCmd` prepends the capped
  `gradle.properties` to every flutter-app worker/review/finalize session, the `flutter-app` skill says workers verify
  with `flutter build web` only (never apk), and `FLUTTER_MAX_PARALLEL` (default 2, `WEBTMUX_FLUTTER_MAX_PARALLEL`)
  caps how many flutter workers build at once. Without these a single build OOM-kills the box (found by the first real run).
  That wrapper exists because the Drive OAuth tokens are `www-data`-owned and the uploader lives under `/root` —
  it runs the bundled `share-apk-to-drive.mjs` as root and **chowns `tokens.json` back to www-data**. The tick reaps
  `.ralph/deliver.json` → writes `DELIVERABLE.md` (install link + QR) → push + Web Push. A delivery failure does NOT
  fail the build (the web preview is already live). **Stub-aware:** `RALPH_FORCE_TOOL` → `--stub` simulates the link.
- **Credentials (per-tenant, empty by default):** `VAULT_PROVIDERS` += `firebase` (google-services.json),
  `google-play` (service-account JSON), `codemagic` (iOS API token). Single-tenant fallbacks `firebaseConfig()`/
  `googlePlayKey()`/`codemagicToken()` (env → `secrets.json`). UI: Settings + Admin "Mobile app & backend" card group.
  `gitInitProject` ignores `*.jks`/`key.properties`/`google-services.json`/`*service-account*.json` — never commit them.
- **Firebase connects two ways (preferred = CLI):** a **terminal sign-in** like the agent CLIs —
  `firebase login --no-localhost` via the `cli-login` flow (`CLI_LOGIN_CMDS`/`CLI_LOGIN_FILES['firebase']` →
  `~/.config/configstore/firebase-tools.json`, detected by `sandboxLogins` → "connected"); builds then auto-wire with
  `flutterfire configure` (the `firebase` skill drives it; firebase CLI is world-installed, dart on PATH, `$HOME/.pub-cache/bin`
  added to the build PATH). OR a pasted `google-services.json` → `stageFirebaseConfig` writes it to `<dir>/.ralph/google-services.json`
  (worker/finalize/deliver) and the skill / `ralph-deliver.sh` copy it into `android/app/`. `firebase_options.dart` is committable
  (public config); `google-services.json` is not. The `firebase` skill **auto-provisions per the clarify requirements**
  (reuse/create project → `flutterfire configure` → `firestore:databases:create` + deployed locked rules); a **Firebase MCP
  server** (`firebase experimental:mcp`, built into firebase-tools) is wired into the build when the `firebase` skill is active
  (`writeRalphBrief` adds a stdio server; `writeMcpConfig` now supports stdio `{command,args}`), so the agent can manage
  project/Firestore/rules/auth. Enabling auth **sign-in providers** is the one non-CLI step (Console toggle or the MCP);
  `projects:create` is quota-limited so prefer reuse.
- **Store submission (separate, user-triggered):** `POST /api/ralph/submit {project,store:'play'|'ios',track?,bundleId?}`
  — "scaffold CI, manual submit", modeled on the **proven apkipa pipeline** (`ralph/store-submit.mjs`):
  - **play** → `.github/workflows/play-release.yml` (monotonic versionCode `run_number+10`, analyze/test gates,
    `r0adkll/upload-google-play`, `vars.PLAY_PACKAGE_NAME`) + `SUBMISSION-PLAY.md`. Runs on the user's own GitHub Actions.
  - **ios** → `codemagic.yaml` (Codemagic `mac_mini_m2`, **managed App Store Connect signing** via the
    `CodemagicAppStoreKey` integration, `submit_to_testflight`) + `SUBMISSION-IOS.md`. Runs on Codemagic.
  Both commit + push; production release stays manual. `run.submit` is keyed by store (`{play,ios}`).
  - **play auto-wires GitHub Actions secrets** so the workflow runs with no manual GitHub setup:
    `ensureUploadKeystore` generates/persists a stable per-tenant upload key (`flutter-signing` vault
    / `~/.webtmux/flutter-signing.json`), then `setGithubSecrets` (`ralph/github-secrets.mjs` + `gh
    secret/variable set`, value piped via stdin, using the tenant's `github` token) sets
    `PLAY_SERVICE_ACCOUNT_JSON` + `ANDROID_KEYSTORE_BASE64`/`*_PASSWORD`/`*_ALIAS` + `PLAY_PACKAGE_NAME`.
    Best-effort: a token without **Secrets** write → those land in `submit.play.secrets.failed` and the
    checklist's manual fallback applies. The two irreducible manual gates stay (create app + first .aab; invite SA).
  "Create APK" (on-demand build, before submit) / "Submit to Play" / "Submit to App Store" / "Install APK"
  buttons on a finished build (`web/` BuildDetail).
  Reference for the exact prereqs: `/srv/apkipa/my_counter_app` (`play-release.yml`, `codemagic.yaml`, `IOS_BUILD_PLAN.md`).
- **Store screenshots (auto):** the delivery pass also runs `ralph/capture-shots.mjs` (best-effort) — a
  headless Chromium (playwright-core + shared browser at `/opt/ms-playwright`) drives the Flutter `build/web`
  at store device viewports (`ralph/screenshots.mjs`: Play phone 1080×1920 / 7″ tablet; iOS 6.5″ 1242×2688 /
  iPad 2048×2732) and writes PNGs to `store-assets/` (committed with `DELIVERABLE.md`). Default = home screen;
  a finalize-written `.ralph/shots.json` (`[{name,path}]`, login-free routes) captures app-specific screens.
  It also composes the Play **1024×500 feature graphic** (`ralph/feature-graphic.mjs` — an HTML banner rendered
  by the same headless Chromium; branded via `.ralph/feature-graphic.json` `{name,tagline,bg,accent,icon}`) →
  `store-assets/feature-1024x500.png`. This is the method proven on apkipa (which did it ad-hoc via the Playwright MCP).
- **Host helpers installed (outside the repo):** `/usr/local/sbin/webtmux-apk-share` + `/etc/sudoers.d/tmuxweb-apk-share`;
  `flutterbuild` group + `git safe.directory`; shared chromium at `/opt/ms-playwright` (world-readable). Re-apply via
  `docs/ops/flutter-tenant-access.sh`, `docs/ops/playwright-shots-setup.sh`, + the `webtmux-apk-share.sh` install line.
  **Not yet smoke-tested with a real Drive upload / real multitenant flutter build** — do that post-deploy.

### Learned preferences (cross-project memory)
`~/.webtmux/preferences.json` records the user's choices (`recordPrefSignal` on start / swap / run-done),
distills them deterministically (`distillPrefs`, recency-weighted) plus one OpenAI pass on completion
(`refreshProfileNote`). **Suggest-only:** prefs seed the start-dialog defaults and inject a `profileNote`
into the planner, but the confirm step always shows so the user can override (which re-feeds the loop).
`GET/PUT/DELETE /api/ralph/prefs` (defined before the `:project` routes so `prefs` isn't a project name).

**Build drafts.** A saved New Build (config + generated PRD) a user can reopen/edit/start later — per-tenant
like prefs (control.db `drafts` table, migration 5, multitenant / `~/.webtmux/drafts.json` single-tenant;
pure `ralph/drafts.mjs` `normalizeDraft`). `GET/POST/DELETE /api/ralph/drafts` (+ `GET /drafts/:id`),
registered before the `:project` routes. Drafts are NOT runs — they never enter `ralphRuns`/the tick; the
New Build review step's "Save draft" persists one, the dashboard "Drafts" section reopens it (`/new?draft=<id>`),
and "Start" posts it to `/api/ralph/start` (which `normalizeMedia`/`normalizePrd`s the stored `media`/`prd`).
**Draft start timer (one-shot scheduled start).** `POST /api/ralph/drafts/:id/schedule {delayMs}` (clamp
15s–30d, `scheduleAt`; DELETE cancels) persists `startAt` ON the draft (ChatGPT-tasks/Claude-routines
pattern: server clock fires it, the browser need not be open). `draftTimerTick` (called from the 5s
`monitorTick`, self-throttled to a 15s scan) finds due drafts (`dueDrafts` / saas `listAllDueDrafts` across
workspaces), rebuilds the tenant ctx from the workspace row, **consumes the timer BEFORE starting** (a crash
can't refire), then calls `startRunFromRequest` — the extracted body of `/api/ralph/start` (validation, plan
gates, credential remap, learning signals), so scheduled and manual starts behave identically (`draftStartBody`
maps draft→body; timer fields never leak). Success → draft deleted + Web Push "⏰ Timer fired"; failure →
draft kept with `startError` (shown on the dashboard card) + push. UI: ⏰ button on the `web/` dashboard
draft card (prompt "2h/30m/1d"), countdown, ⏰✕ cancel. In-flight `startingDrafts` set guards double-fire.
No-spend e2e: `bash docs/ops/draft-timer-stub-e2e.sh`.

## Phone remote control (`/rc/`)

Supervise a running master from your phone. Dashboard "📱 Remote" mints a one-time
pairing token rendered as a QR of `/rc?t=…`; scanning it mints a **hashed, revocable
device token** (`~/.webtmux/rc-devices.json`, cookie `rc_dev`, path `/rc`). Everything
phone-facing lives under **`/rc/`** — nginx exempts that prefix from basic-auth
(`docs/ops/nginx-rc.conf`) and the Node app gates it with the device token
(`requireDevice`, `ralph/rc-auth.mjs`). `/rc/ws` is a **read-only** pane whose tmux
session name is derived server-side (never client-supplied), so a device only sees its
own tenant's master sessions. Supervise actions (`/rc/api/{answer,steer,restart,continue,
swap}`) reuse the orchestrator's `.ralph/answer.md`/`.ralph/steer.md`/swap internals.
Web Push (existing VAPID pipeline) fires on needs-input/attention/done to paired devices;
`public/rc.sw.js` opens `/rc/#/<project>` on tap. iOS needs Add-to-Home-Screen for push.
The feature is inert until the nginx block is applied and a device is paired.

## Project preview / hosting

nginx wildcard vhost `*.tayyabcheema.com` → webtmux. A Host-routing middleware (before `express.json`,
so server-app bodies proxy raw) serves `<project>.tayyabcheema.com`: **static** build output
(`build/web`→`dist`→`build`→`out`→`public`→root `index.html`, SPA fallback) → **server app** (`webtmux.json`
`{type:server,command,install}`, or `package.json` `start`, or python `app.py` — run in tmux session
`app-<project>` on a 9000–9100 port, reverse-proxied, idle-stopped after 15m) → **file browser** (with
`?zip` download). Wildcard TLS is a Let's Encrypt cert via Hostinger DNS-01 (auto-renews).

## Testing Ralph without spend (important)

Drive the orchestrator end-to-end with no API cost or real CLIs via env on the service
(systemd drop-in `/etc/systemd/system/webtmux.service.d/*.conf`, then `daemon-reload`+restart):
- `RALPH_FORCE_TOOL=stub` — every worker/review/finalize uses deterministic stubs (auto-COMPLETE/ACCEPT/PASS).
- `RALPH_FAKE_REMOTE=/path/to/bare.git` — pushes to a local bare repo instead of GitHub.
- `POST /api/ralph/start` accepts a `prd` object to skip the OpenAI planner (deterministic stories/deps).

Always tear the drop-in down and kill leftover `r-/rv-/rf-/rd-/app-` tmux sessions after testing
(`rd-` = the flutter-app delivery pass). For a ready-made flutter-app run-through, `docs/ops/flutter-stub-e2e.sh`
spins up a fully isolated stub instance (own port / data / projects dir + fake git remote) end-to-end.
