# Modular Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the two monoliths — `server.js` (5,877 lines) and `public/js/dashboard.js` (1,662 lines) — into focused modules along their existing section seams, with zero behavior change.

**Architecture:** `server.js` stays the systemd entry point (`ExecStart=/usr/bin/node server.js`) but shrinks to a bootstrap that wires modules in the exact current order. New backend modules live in `server/` (ESM `.mjs`, same style as `ralph/` and `saas/`); each module OWNS its mutable state and exports functions, never raw `let` bindings. Extraction is leaf-first: after every task `server.js` still boots identically, verified by an isolated boot smoke. The dashboard splits into `public/js/dashboard/` feature modules behind the existing `js/dashboard.js` entry path (so `index.html` and `sw.js` SHELL keep working).

**Tech Stack:** Node 20 ESM, Express, ws, node-pty; no build step for backend or `public/`; Vite only for `web/` (untouched).

## Global Constraints

- **Zero behavior change.** No route path, request/response shape, env var name, persisted file format, tmux session naming, or timing (4s/5s intervals) may change.
- **`server.js` remains the entry file** — systemd runs `/usr/bin/node server.js`; do not rename it.
- **Express registration order is load-bearing** and must be preserved exactly: (1) preview Host-routing middleware, (2) `POST /api/billing/webhook` (raw body), (3) `express.json({limit:'256kb'})`, (4) static + React index routes, (5) MULTITENANT auth routes then the auth gate, (6) API routes — with `/api/ralph/prefs|solo-models|media-caps|drafts|tracking` registered BEFORE `/api/ralph/:project` routes, (7) WS upgrade handlers, (8) boot sequence `initSecrets → loadSoloModels → loadRcDevices → applySudoRule(false) → initRalphRuns → initPush → setInterval(monitorTick,5000) → setInterval(ralphTick,4000) → listen`.
- **Module state rule:** every module-level `let`/`Map`/`Set` moves into the module that owns it; other modules access it ONLY through exported functions (or an exported `const` Map/Set mutated in place). Never export a reassignable `let` for others to write.
- **No import cycles.** Layering (lower may not import higher): `config → secrets/projects/tmux/git/skills/rc/push → llm → planner/agents → prefs → ralph-engine → preview/sudo → monitor → routes/* → ws → server.js`. If an extraction would create a cycle, keep the offending function in the higher layer and note it in the task commit message.
- **Work in a git worktree** (superpowers:using-git-worktrees) — `public/` is served from disk live, so in-place edits would ship a half-refactored UI to the user. Symlink `node_modules` from the main checkout into the worktree (`ln -s /var/www/tmux.tayyabcheema.com/node_modules <worktree>/node_modules`).
- Line numbers below are hints as of commit `6393117`; **identify code by symbol name**, and always move declarations **verbatim** (comments included) unless a step says otherwise.
- **Standard verification (referred to as VERIFY below)** — run after every task, from the worktree:

```bash
node --check server.js && for f in server/*.mjs server/routes/*.mjs; do [ -e "$f" ] && node --check "$f"; done
node --test ralph/*.test.mjs 2>&1 | tail -3          # expect: pass, fail 0
SCRATCH=$(mktemp -d)
WEBTMUX_PORT=0 WEBTMUX_DATA=$SCRATCH/data WEBTMUX_PROJECTS_ROOT=$SCRATCH/projects \
  RALPH_FORCE_TOOL=stub timeout 4 node server.js; ec=$?
# expect: "webtmux listening on http://127.0.0.1:0 …" printed, then exit code 124 (timeout)
[ $ec -eq 124 ] && echo BOOT-OK
rm -rf $SCRATCH
```
  The 4s timeout keeps the smoke instance from ever reaching the first `monitorTick` (5s), so its `sessionJanitor` can never touch real tmux sessions. Before the first use (Task 1 Step 0) read `sessionJanitor`/`JANITOR_SH` in `server.js` (~line 3282) and confirm it only kills `r-|rv-|rf-|rd-|app-`-prefixed sessions; if it is broader, add `WEBTMUX_IDLE_MS=999999999` to the smoke env as well.

---

### Task 0: Baseline + worktree

**Files:** none created; worktree setup.

- [ ] **Step 1: Confirm the live service is healthy and no Ralph run is mid-flight**

```bash
systemctl is-active webtmux && curl -sf http://127.0.0.1:8090/healthz
ls /home/tmuxweb/.webtmux/ralph/*.json 2>/dev/null | head   # note any runs; check none are in a building phase:
grep -l '"phase": *"\(building\|reviewing\|finalizing\|delivering\|windows-delivering\|researching\)"' /home/tmuxweb/.webtmux/ralph/*.json 2>/dev/null
```
Expected: `active`, healthz `{"ok":true}`-ish, and no in-flight phases. If a run IS in flight, pause here and wait (or ask the user) — do not restart the service mid-build later in Task 16.

- [ ] **Step 2: Record baseline**

```bash
node --test ralph/*.test.mjs 2>&1 | tail -3    # all pass
wc -l server.js public/js/dashboard.js         # 5877 / 1662
git rev-parse HEAD                              # baseline sha
```

- [ ] **Step 3: Create the worktree** via superpowers:using-git-worktrees (branch `refactor/modular-split`), then symlink `node_modules` in and re-run the test suite there.

- [ ] **Step 4: Run VERIFY once in the worktree** (this validates the smoke harness itself against unmodified code). If BOOT-OK fails on pristine code, fix the harness expectations, not the code.

---

### Task 1: `server/config.mjs` — env, paths, fs helpers, validators, audit

**Files:**
- Create: `server/config.mjs`
- Modify: `server.js` (delete moved code, add import)

**Interfaces:**
- Produces (exports): `HOST, PORT, HOME, PROJECTS_ROOT, DATA_DIR, STAGED_ASSETS_DIR, VAPID_FILE, SUBS_FILE, AUDIT_FILE, SECRETS_FILE, RALPH_DIR, REPO_ROOT, readJson, writeJson, validName, validProject, PROJECT_RE, audit, within, MT_ON, MULTITENANT, ADMIN_EMAILS, isAdminEmail, BASE_DOMAIN, DASHBOARD_HOST`

**Move (verbatim) from `server.js`:** the constants block at lines 56–77 (`HOST…RALPH_DIR`), `readJson`, `writeJson`, `NAME_RE`/`validName`, `PROJECT_RE`/`validProject`, `audit()` (~line 644 with its banner comment), `within()` (~line 3361), `MT_ON` (~line 402), `MULTITENANT`/`ADMIN_EMAILS`/`isAdminEmail` (~lines 3645–3649), `BASE_DOMAIN`/`DASHBOARD_HOST` (~lines 3354–3355).

- [ ] **Step 1: Create the module.** Header shape (body = moved code):

```js
// server/config.mjs — deployment constants, data paths, tiny fs helpers, audit log.
// Everything here is env-derived or pure; no imports from other server/ modules.
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// …moved declarations, each `const`/`function` gaining `export`…
```
`__dirname` in moved code becomes `REPO_ROOT` (it was the repo root — `server.js` sits at the top level). Grep `server.js` for every remaining `__dirname` use and replace with `REPO_ROOT` imported from config (keep `const __dirname` in `server.js` only if something path-relative still needs it — it shouldn't).

- [ ] **Step 2: Wire `server.js`:** add `import { HOST, PORT, … } from './server/config.mjs';` listing exactly the names `server.js` still references; delete the moved declarations.
- [ ] **Step 3: VERIFY** (all three parts).
- [ ] **Step 4: Commit** `refactor(server): extract config.mjs — paths, env, fs helpers, audit`

---

### Task 2: `server/secrets.mjs` — secrets store + every key getter

**Files:**
- Create: `server/secrets.mjs`
- Modify: `server.js`

**Interfaces:**
- Consumes: `config.mjs` (`DATA_DIR`, `SECRETS_FILE`, `readJson`, `writeJson`)
- Produces: `initSecrets, getSecrets, updateSecrets(patch)`, all getters `openaiKey, openaiModel, githubToken, firebaseConfig, googlePlayKey, codemagicToken, arkKey, arkBaseUrl, sunoKey, sunoBaseUrl, elevenLabsKey, elevenLabsVoice, qwenKey, qwenBaseUrl, qwenModel, qwenImageModel, perplexityKey, apifyToken, platformKeyValues, GLM_API_KEY, GLM_BASE_URL, GLM_MODEL, KIMI_MODEL, GROK_MODEL`, plus `soloModelsEffective, loadSoloModels, setSoloModels, mediaCapsEffective, setMediaCaps`

**Move:** `let secrets` + `initSecrets` (~653), getter block ~702–732, GLM/KIMI/GROK getters ~1519–1531, `SOLO_MODELS_FILE`/`soloModelsFile`/`soloModelsEffective`/`loadSoloModels` (~660–677), `MEDIA_CAPS_FILE`/`mediaCapsFile`/`mediaCapsEffective` (~665–670).

- [ ] **Step 1: Find every direct `secrets.` access left in `server.js`** — `grep -n 'secrets\.' server.js`. Known ones: `secrets.imageProvider`/`secrets.videoProvider` (in `ralphEnvPrefix`) and whatever the single-tenant Settings PUT writes. For reads add narrow getters (e.g. `export const imageProvider = () => secrets.imageProvider || '';`); for writes add `export async function updateSecrets(patch) { Object.assign(secrets, patch); await writeJson(SECRETS_FILE, secrets); }` — match whatever persistence the current route code does (if the current code does NOT persist, `updateSecrets` must not either; mirror it exactly).
- [ ] **Step 2: Create the module** (owns `let secrets = {}`, `soloModelsFile`, `mediaCapsFile`; exports only functions). Where routes previously reassigned `soloModelsFile`/`mediaCapsFile` directly (admin PUT routes ~4010–4028), export `setSoloModels(map)` / `setMediaCaps(map)` that assign + persist exactly as the route code did, and call those from the routes.
- [ ] **Step 3: Wire imports, delete moved code, VERIFY.**
- [ ] **Step 4: Commit** `refactor(server): extract secrets.mjs — secrets store + provider key getters`

---

### Task 3: `server/tmux.mjs` + `server/git.mjs`

**Files:**
- Create: `server/tmux.mjs`, `server/git.mjs`
- Modify: `server.js`

**Interfaces:**
- Consumes: `config.mjs`; `saas/tenants.mjs` (already imported by `server.js` — move that import along)
- `tmux.mjs` produces: `tenantUserFromDir, tenantUserFromArgs, wrapAsTenantUser, tmux, listSessions, projectFromCwd, paneTail, statsForSessions, paneSignature`
- `git.mjs` produces: `git, isGitRepo, ensureProjectDir, gitInitProject, gitCommitAll, gitAddWorktree, gitRemoveWorktree, gitMergeBranch, gitRevertMerge, WORKTREES_SUBDIR`

**Move:** tmux group ~402–420 + 537–642 + `paneSignature` (~1344); git group = the `// --- Git: per-project repos …` banner section ~422–536.

- [ ] **Step 1: Create both modules** (git.mjs has no tmux dependency; tmux.mjs none on git).
- [ ] **Step 2: Wire, delete, VERIFY.**
- [ ] **Step 3: Commit** `refactor(server): extract tmux.mjs + git.mjs helpers`

---

### Task 4: `server/projects.mjs` + `server/skills.mjs`

**Files:**
- Create: `server/projects.mjs`, `server/skills.mjs`
- Modify: `server.js`

**Interfaces:**
- `projects.mjs` produces: `listProjects, resolveProjectDir, listSshHosts, SSH_HOST_RE, contextTemplate, scaffoldContext, CONTEXT_FILE, PROVIDER_FILES`
- `skills.mjs` produces: `MCP_GATEWAY, mcpServersFor, mcpCapabilitiesFor, writeMcpConfig, OUTPUT_FORMATS, OUTPUT_SKILL, OUTPUT_TOOLS, ensureSkillsRepo, loadSkillsCatalog, getSkillMd`

**Move:** projects group ~91–137 (minus validators already in config) + 332–400 + `projectFromCwd` stays in tmux (done in Task 3); skills/MCP group ~139–290.

- [ ] **Step 1:** Check `mcpServersFor(tenant)`'s dependencies (~144) — if it reads admin-registered MCP servers from `saas/store.mjs` or a local file, move that state with it into `skills.mjs` and export a setter for the admin routes (`setMcpServers` or equivalent matching current mutation).
- [ ] **Step 2: Create both modules, wire, delete, VERIFY.**
- [ ] **Step 3: Commit** `refactor(server): extract projects.mjs + skills.mjs`

---

### Task 5: `server/llm.mjs` + `server/planner.mjs`

**Files:**
- Create: `server/llm.mjs`, `server/planner.mjs`
- Modify: `server.js`

**Interfaces:**
- `llm.mjs` produces: `callChat, callOpenAI, callAnthropicChat, planViaClaudeCli, tenantPlannerCall, callPlanner, extractJson, PLANNER_CLAUDE_MODEL` (consumes secrets getters)
- `planner.mjs` produces: `detectEnvironment, groundIdea, planPrd, clarifyQuestions, normalizePrd, ENV_TOOLS` (consumes llm.mjs, skills.mjs `OUTPUT_FORMATS`, `ralph/clarify-axes.mjs`, `ralph/research.mjs` bits, secrets)

**Move:** ~737–843 into llm.mjs; ~844–1040 into planner.mjs. The `envCache`/`skillCache`-style caches move with their owners.

- [ ] **Step 1: Create llm.mjs, wire, VERIFY, commit** `refactor(server): extract llm.mjs — chat/planner call plumbing`
- [ ] **Step 2: Create planner.mjs, wire, VERIFY, commit** `refactor(server): extract planner.mjs — PRD planning, clarify, normalize`

---

### Task 6: `server/prefs.mjs` — preferences, drafts, tracking stores

**Files:**
- Create: `server/prefs.mjs`
- Modify: `server.js`

**Interfaces:**
- Produces: `loadPrefs, savePrefs, recordPrefSignal, recordOutcome, stashPlannedPrd, recordPrdEditSignal, refreshProfileNote, distillPrefs, loadDraftsList, saveDraftFor, deleteDraftFor, loadTracking, saveTracking`
- Consumes: config, llm.mjs (`callOpenAI` inside `refreshProfileNote`), `saas/store.mjs` for multitenant branches.

**Move:** ~1041–1110 and ~1160–1308, **except** `draftTimerTick`, `startScheduledDraft`, `startingDrafts`, `lastDraftScan` (~1111–1159) — those depend on `startRunFromRequest` (ralph engine) and would create a cycle; leave them in `server.js` for now (Task 11 moves them to `monitor.mjs`).

- [ ] **Step 1: Create, wire, VERIFY.**
- [ ] **Step 2: Commit** `refactor(server): extract prefs.mjs — preferences/drafts/tracking stores`

---

### Task 7: `server/agents.mjs` — launcher table + agent credentials/env

**Files:**
- Create: `server/agents.mjs`
- Modify: `server.js`

**Interfaces:**
- Produces: `LAUNCHERS, VALID_AGENTS, DEFAULT_AGENT, resolveLaunch, CLAUDE_PLAN_PRESETS, AGENT_CRED_PROVIDERS, tenantKey, claudePlanOf, missingAgentKeys, CLI_LOGIN_FILES, sandboxLogins, missingAgentCreds, tenantAgentCreds, credFileLines, agentHasCodingPlan, runModelFlag, grokLoginKey, ralphEnvPrefix, researchKeysFor`
- Consumes: config, secrets, skills (`MCP_GATEWAY`?), `ralph/solo-models.mjs`, `ralph/providers.mjs`, `ralph/flutter-env.mjs`.

**Move:** ~292–330 (LAUNCHERS…resolveLaunch) and ~1591–1904 (presets through `researchKeysFor`). Note `ralphEnvPrefix` references `RALPH_GEN_*` path constants (~1321–1327) — move those constants here too or (better) inline them from `RALPH_DIR` via `path.join(RALPH_DIR, 'gen-image.mjs')` etc., exactly as today.

- [ ] **Step 1: Create, wire, VERIFY.**
- [ ] **Step 2: Commit** `refactor(server): extract agents.mjs — launchers + per-agent creds/env`

---

### Task 8: `server/rc.mjs` + `server/push.mjs`

**Files:**
- Create: `server/rc.mjs`, `server/push.mjs`
- Modify: `server.js`

**Interfaces:**
- `rc.mjs` produces: `loadRcDevices, saveRcDevices, listRcDevices, addRcDevice, removeRcDevice, rcPairTokens, rcDeviceFromReq, rcTenantSlug, requireDevice` (owns `rcDevices` array — routes that read/mutate it get accessor functions matching their current operations; find them with `grep -n 'rcDevices' server.js`)
- `push.mjs` produces: `initPush, sendPush, sendPushTo, pushReady, vapidPublicKey` (owns `vapid` + subscription store; the boot log line uses `pushReady()`; `/api/push/key` uses `vapidPublicKey()`)

**Move:** RC block ~678–700; push block ~3207–3253 (plus the subscription add/remove logic the `/api/push/*` routes use — export functions for whatever they mutate).

- [ ] **Step 1: Create both, wire, VERIFY.**
- [ ] **Step 2: Commit** `refactor(server): extract rc.mjs + push.mjs`

---

### Task 9: `server/ralph-engine.mjs` — the orchestrator

**Files:**
- Create: `server/ralph-engine.mjs`
- Modify: `server.js`

**Interfaces:**
- Produces: `ralphRuns` (exported `const Map`, mutated in place), `RALPH_STATE_DIR, ralphSessionName, previewUrlFor, runSummary, persistRun, regenerateProjectIndex, writeMasterLog, mlogLearn, revent, masterNotesForBrief, answerWorkerQuestion, writeRalphBrief, launchRalphSession, spawnWorker, spawnReview, spawnFinalize, spawnDelivery, spawnWindowsDelivery, spawnResearch, checkPwaCompliance, prepareWindowsInstaller, prepareWindowsStore, writeDeliverable, ensureRemote, gitPushRef, gitPushExisting, rehydrateTenant, initRalphRuns, loadRun, ensureReadme, killProjectSessions, autoReroute, ralphTick, notifyRalphDone, commitStagedAssets, loadStagedAssets, startRalphRun, adoptRalphRun, startRunFromRequest, masterLogText, stageFirebaseConfig` — export exactly the set `server.js`'s remaining code (routes, monitor, ws) references; keep everything else module-private.
- Consumes: everything from Tasks 1–8 plus the existing `ralph/*.mjs` imports (move each `ralph/*` import from `server.js` here if only engine code uses it; leave shared ones in both files' import lists as needed).

**Move:** the whole `// --- Ralph orchestrator engine ---` region ~1309–3206 (minus what Tasks 3/7 already took), **plus** `loadStagedAssets` (~4231) and `startRunFromRequest` (~4329) from the routes region — both are engine logic (`startRunFromRequest` is the documented non-HTTP start path used by the draft timer).

This is the largest move (~1,900 lines). Do it in two commits to keep each reviewable:

- [ ] **Step 1: Move the supervision + brief + spawn + index block** (`paneSignature`-adjacent helpers ~1333–1517 not already moved, `previewUrlFor` … `spawnResearch`, `writeMasterLog` group, `runSummary`/`persistRun`, `regenerateProjectIndex`/`renderProjectIndexMd`, `readExitCode`, packaging helpers `checkPwaCompliance`/`prepareWindows*`/`writeDeliverable`). VERIFY. Commit `refactor(server): extract ralph-engine.mjs (1/2) — spawn, supervision, packaging`
- [ ] **Step 2: Move the run-lifecycle block** (`ensureRemote` … `adoptRalphRun`, `ralphTick`, `ralphRuns`, `initRalphRuns`, `loadRun`, `startRunFromRequest`, `loadStagedAssets`). VERIFY. Commit `refactor(server): extract ralph-engine.mjs (2/2) — tick, lifecycle, start/adopt`
- [ ] **Step 3: Deeper split judgment call (default NO):** only if the packaging helpers (`checkPwaCompliance`, `prepareWindowsInstaller`, `prepareWindowsStore`, `writeDeliverable`) turn out not to call `persistRun`/engine state, move them to `server/ralph-packaging.mjs`. If they do call back into the engine, leave them — a cycle is worse than a 1,900-line engine module.

---

### Task 10: `server/preview.mjs` + `server/sudo.mjs`

**Files:**
- Create: `server/preview.mjs`, `server/sudo.mjs`
- Modify: `server.js`

**Interfaces:**
- `preview.mjs` produces: `servePreview`, `previewHostMiddleware(req,res,next)` (the current inline `app.use` handler ~3559 extracted verbatim into a named exported function), plus module-private: web-root detection, file browser, zip streaming, app-process runner (`ensureAppRunning`/`proxyToApp` + port state). Also export `stopIdleApps`-style hooks ONLY if `monitorTick` calls into app-process state (check `grep -n 'appProcs\|APP_IDLE' server.js`).
- `sudo.mjs` produces: `applySudoRule` + the sudo-session tracking state that `monitorTick`'s `deadSudoSessions` prune and the `/api/sessions/:name/sudo` + `/api/maint-shell` routes share (find with `grep -n 'applySudoRule\|sudoSessions\|webtmux-sudo' server.js`; export accessors matching current use).

**Move:** preview region ~3351–3548; sudo helpers near ~5415.

- [ ] **Step 1: Create both, wire (`app.use(previewHostMiddleware)` stays first in the chain), VERIFY.**
- [ ] **Step 2: Commit** `refactor(server): extract preview.mjs + sudo.mjs`

---

### Task 11: `server/monitor.mjs` — background ticks

**Files:**
- Create: `server/monitor.mjs`
- Modify: `server.js`

**Interfaces:**
- Produces: `monitorTick, draftTimerTick` (only what the boot `setInterval`s need; `sessionJanitor`, `pruneStagedAssets`, `startScheduledDraft`, `startingDrafts`, `lastDraftScan` stay private)
- Consumes: tmux, prefs (drafts), push, sudo, ralph-engine (`startRunFromRequest`), `ralph/sudo-prune.mjs`, `ralph/assets.mjs`.

**Move:** ~3254–3350 plus the deferred draft-timer block ~1111–1159.

- [ ] **Step 1: Create, wire, VERIFY.**
- [ ] **Step 2: Commit** `refactor(server): extract monitor.mjs — monitorTick + draft timer`

---

### Task 12: Route modules + `server/ws.mjs`; `server.js` becomes the bootstrap

**Files:**
- Create: `server/routes/saas.mjs`, `server/routes/core.mjs`, `server/routes/ralph.mjs`, `server/routes/rc.mjs`, `server/ws.mjs`
- Modify: `server.js`

**Interfaces (each route file exports one registrar):**
- `saas.mjs`: `registerBillingWebhook(app)` (the ~3582 raw-body route — MUST be callable before `express.json`) and `registerSaasRoutes(app)` (the whole `if (MULTITENANT) { … }` block ~3650–4102: auth, gate, keys/vault, cli-login, usage/test, billing, admin, mcp). Keep the `if (MULTITENANT)` INSIDE the registrar so single-tenant stays byte-identical.
- `core.mjs`: `registerCoreRoutes(app)` — `/healthz`, `/api/sessions*` (incl. sudo, rename, duplicate, window, detach, delete), `/api/status`, `/api/ssh-hosts`, `/api/projects*`, `/api/maint-shell`, `/api/push/*`, `/api/rc/pair-token`, `/api/rc/devices*`, `/api/audit`.
- `ralph.mjs`: `registerRalphRoutes(app)` — every `/api/ralph/*` route and `/api/tracking*`, **preserving today's registration order within the file** (the `prefs`/`drafts`/`solo-models`/`media-caps`/`tracking` routes come before `/api/ralph/:project` — copy the block top-to-bottom and this holds automatically).
- `rc.mjs`: `registerRcRoutes(app)` — the `/rc/*` block ~5647–5750 (pages, sw, push, status, answer/steer/continue/swap/restart).
- `ws.mjs`: `attachWebSockets(server)` — the upgrade handler + both `wss`/`rcWss` connection handlers ~5751–5870, verbatim.

- [ ] **Step 1: Move route blocks top-to-bottom into the four files.** Each file imports what its handlers use from the Task 1–11 modules (the handlers' bodies are unchanged — only identifier sourcing moves to imports). The few helpers used by exactly one route block (e.g. `fail(res,code,msg)` in the saas block) move with their block.
- [ ] **Step 2: Rewrite `server.js` as the bootstrap.** Target shape (~120 lines):

```js
// server.js — entry point. Assembly ORDER here is load-bearing; see each module for logic.
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { HOST, PORT, REPO_ROOT } from './server/config.mjs';
import { previewHostMiddleware } from './server/preview.mjs';
import { registerBillingWebhook, registerSaasRoutes } from './server/routes/saas.mjs';
import { registerCoreRoutes } from './server/routes/core.mjs';
import { registerRalphRoutes } from './server/routes/ralph.mjs';
import { registerRcRoutes } from './server/routes/rc.mjs';
import { attachWebSockets } from './server/ws.mjs';
import { initSecrets, loadSoloModels, qwenKey, qwenModel, openaiKey, openaiModel } from './server/secrets.mjs';
import { loadRcDevices } from './server/rc.mjs';
import { applySudoRule } from './server/sudo.mjs';
import { initRalphRuns, ralphTick } from './server/ralph-engine.mjs';
import { initPush, pushReady } from './server/push.mjs';
import { monitorTick } from './server/monitor.mjs';

const app = express();
app.use(previewHostMiddleware);                    // 1. project-preview host routing (before body parsing)
registerBillingWebhook(app);                       // 2. Stripe webhook needs the raw body
app.use(express.json({ limit: '256kb' }));         // 3.
/* 4. static + index routes — moved verbatim from the old ~3604–3638 block */
registerSaasRoutes(app);                           // 5. auth + gate BEFORE the API surface
registerCoreRoutes(app);
registerRalphRoutes(app);
registerRcRoutes(app);

const server = http.createServer(app);
attachWebSockets(server);
/* boot sequence + intervals + listen — moved verbatim from the old tail */
```
The static/index block (~3604–3638) and the boot tail stay in `server.js` verbatim (they ARE the assembly).

- [ ] **Step 3: VERIFY**, then additionally exercise routes against the smoke instance: rerun the smoke with `WEBTMUX_PORT=18090` and `timeout 6`, and inside the window `curl -sf localhost:18090/healthz && curl -sf localhost:18090/api/sessions && curl -sf localhost:18090/ -H 'Host: tmux.tayyabcheema.com' | head -c 200`.
- [ ] **Step 4: Commit** `refactor(server): route modules + ws.mjs; server.js is now a thin bootstrap`

---

### Task 13: Stub e2e — prove the orchestrator end-to-end

**Files:** none (verification only).

- [ ] **Step 1:** Read `docs/ops/flutter-stub-e2e.sh` and run it from the worktree: `bash docs/ops/flutter-stub-e2e.sh`. Expected: the scripted run reaches `done` with stub tools; script exits 0.
- [ ] **Step 2:** Run `bash docs/ops/draft-timer-stub-e2e.sh` and `bash docs/ops/windows-store-stub-e2e.sh`. Expected: both pass as they do on the baseline (if unsure, run each on the baseline checkout first to capture expected output).
- [ ] **Step 3:** Kill any leftover `r-|rv-|rf-|rd-|app-` tmux sessions the harnesses left behind (each script documents its own cleanup).
- [ ] **Step 4: Commit** nothing; note results in the final summary.

---

### Task 14: Split `public/js/dashboard.js`

**Files:**
- Create: `public/js/dashboard/util.js`, `public/js/dashboard/sessions.js`, `public/js/dashboard/ralph.js`
- Modify: `public/js/dashboard.js` (becomes the entry that imports the three), `public/sw.js`, `public/index.html` (no change expected — verify only)

**Interfaces:**
- `util.js`: pure/shared helpers — `fmtAgo, shortPath, esc, seenKey, isNew, markSeen, suggestName, urlB64ToUint8Array` plus any identifier used by BOTH halves (find them: extract lines 811+ to a scratch file and grep it for each top-half identifier).
- `sessions.js`: everything from the top of the file through the PWA-install block (~line 810): LAUNCHERS mirror, session cards/sheet/dialogs, projects panel, context editor, ssh hosts, health poll, push-notification UI, MCP picker, audit. Exports only what `ralph.js` or the entry needs.
- `ralph.js`: the Ralph UI (~line 811 to EOF): asset uploads, clarify/confirm dialogs, status dialog, master log tab, drafts, swap, windows/apk/submit buttons.
- `dashboard.js` (entry): `import './dashboard/util.js'; import { initDashboard } from './dashboard/sessions.js'; import { initRalphUi } from './dashboard/ralph.js';` + whatever top-level init calls currently run at module load (wrap each half's load-time statements in an exported `init*()` called from the entry, in the SAME order they execute today).

Shared mutable state (`sessionsCache`, `tool`, `sshHost`, …) stays inside `sessions.js`; if `ralph.js` reads any of it, export a getter — do NOT export `let` bindings for writing.

- [ ] **Step 1: Split the file** as above; `node --check public/js/dashboard.js public/js/dashboard/*.js`.
- [ ] **Step 2: Update the service worker:** bump `VERSION` in `public/sw.js` to `webtmux-v42` and add `'/js/dashboard/util.js', '/js/dashboard/sessions.js', '/js/dashboard/ralph.js'` to `SHELL`.
- [ ] **Step 3: Browser smoke** (worktree instance on port 18090 with real data dirs NOT wired — use scratch): load `http://localhost:18090/` with the Playwright MCP browser; expected: session cards render, "＋ New" dialog opens with agent buttons, Ralph "🤖 Build" dialog opens, no console errors.
- [ ] **Step 4: Commit** `refactor(pwa): split dashboard.js into dashboard/{util,sessions,ralph}.js; sw v42`

---

### Task 15: Dedup + naming cleanups (conservative)

**Files:**
- Modify: `server/config.mjs`, `server/ralph-engine.mjs`, `server/preview.mjs`, `server/ws.mjs`

- [ ] **Step 1: Unify the three static-output-dir lists.** `PWA_STATIC_DIRS` and `WIN_STATIC_DIRS` are identical (`['build/web','dist','build','out','public','.']`); `WEB_ROOT_CANDIDATES` is the same minus `'.'`. In `config.mjs`:

```js
// Where a finished build's static web output can live, in probe order.
export const STATIC_OUTPUT_DIRS = ['build/web', 'dist', 'build', 'out', 'public', '.'];
export const WEB_ROOT_CANDIDATES = STATIC_OUTPUT_DIRS.filter((d) => d !== '.');
```
Replace the three local copies with imports. VERIFY.

- [ ] **Step 2: Rename opaque internals (module-private only):** `revent` → `recordRunEvent`, `mlogLearn` → `recordMasterLearning` (update the export list from Task 9 if routes use them), and the `ws_` shadow variable in the rcWss handler → `workspaceRow`. `grep -rn 'revent\|mlogLearn' server/ server.js` afterward: zero stale references. VERIFY.
- [ ] **Step 3: Do-NOT-touch list (documented decisions, not omissions):**
  - `LAUNCHERS` mirror in the dashboard — intentional display-only copy that keeps the GLM credential server-side; deduping would ship it to the browser.
  - `callChat` vs `callAnthropicChat` — different wire protocols, not duplication.
  - The per-tenant JSON store trio (prefs/drafts/tracking) — each has a distinct multitenant branch; a generic abstraction would obscure more than it saves (YAGNI).
- [ ] **Step 4: Commit** `refactor: dedupe static-dir lists, clarify internal names`

---

### Task 16: Docs, merge, live verification

**Files:**
- Modify: `CLAUDE.md` (the `## Layout` bullet for `server.js`, and the syntax-check line), `README.md` (only if it describes the single-file layout)

- [ ] **Step 1: Update `CLAUDE.md`:** rewrite the `server.js` layout bullet to describe the bootstrap + `server/` modules (one line per module, same terse style), and change the syntax-check line to `node --check server.js server/*.mjs server/routes/*.mjs public/js/dashboard.js public/js/dashboard/*.js`. Commit `docs: CLAUDE.md reflects the modular server/ layout`.
- [ ] **Step 2: Final worktree check:** full VERIFY + `cd web && npm run build` (should be untouched/green) + re-run Task 13's flutter stub e2e once more.
- [ ] **Step 3: Re-check the live box for in-flight runs** (same grep as Task 0 Step 1). If clear: merge the branch to `main` (fast-forward from the main checkout), then `systemctl restart webtmux`.
- [ ] **Step 4: Live verification:**

```bash
journalctl -u webtmux -n 20 --no-pager        # expect the normal "webtmux listening…" line, no stack traces
curl -sf http://127.0.0.1:8090/healthz
curl -sf http://127.0.0.1:8090/api/sessions | head -c 300
curl -sf -H 'Host: tmux.tayyabcheema.com' http://127.0.0.1:8090/ | head -c 200
tmux -S /tmp/tmux-982/default ls 2>/dev/null || sudo -u tmuxweb tmux ls   # pre-existing sessions survived the restart
```
Also load the dashboard in the Playwright browser via the public URL if reachable, confirm the PWA updates to `webtmux-v42` and renders.
- [ ] **Step 5: Remove the worktree**, confirm `git log` on main shows the series, and write the final summary (what moved where, what was deliberately left alone, verification evidence).

---

## Self-Review Notes

- **Coverage:** user goals 1–2 → Tasks 1–12, 14; goal 3 → Task 15; goal 4 → VERIFY in every task + Tasks 13/16; goal 5 → Task 15 Step 2 + module names; goal 6 → routes/* vs engine/services split; goal 7 → Task 9 Step 3 and Task 15 Step 3 explicitly cap the ambition; goal 8 → module headers only; goal 9 → Tasks 13, 14 Step 3, 16; goal 10 → Task 16 Step 5.
- **Known risk concentrations:** module-level mutable state (handled by the ownership rule), Express order (pinned in Global Constraints and the Task 12 skeleton), the smoke harness touching real tmux (bounded by the 4s timeout + janitor pre-check).
- **Deliberately out of scope:** `web/` React pages (moderate size, already page-per-file), `saas/` and `ralph/` modules (already clean and tested), shell scripts, any API/protocol change, rotating the committed GLM fallback key (flag to the user in the summary — it's a behavior question, not a refactor step).
