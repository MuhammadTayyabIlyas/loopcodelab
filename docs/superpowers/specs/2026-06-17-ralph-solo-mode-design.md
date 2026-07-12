# Ralph Solo Mode + Per-Role Model Split — Design

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** Claude (pair) + tayyabcheema777

## 1. Problem & goal

Today a Ralph build **requires at least one worker agent** distinct from the master.
The SaaS UI hard-blocks a Claude-only run (`web/src/pages/NewBuild.jsx:75` →
`"Pick at least one worker agent."`), even though the server and orchestrator already
support zero workers. A solo developer — one agent that both builds and reviews —
cannot be launched.

We want a **production-grade "solo" (single-developer) mode**:

1. A run with a master and **no separate workers** is allowed for **any** master
   (claude, codex, qwen, gemini). The single agent builds every story, then reviews,
   merges, and finalizes it as master.
2. To keep cost down and review quality up, solo mode uses a **per-role model split**:
   - **Build** stories on the agent's **second-best (lower-cost)** model.
   - **Review + finalize** on the agent's **top** model.
   For Claude: build = `claude-sonnet-4-6`, review = `claude-opus-4-8`.
3. Because model names change frequently, an **admin-managed UI** edits the per-agent
   `{build, review}` model IDs without a redeploy. Claude ships with sane defaults;
   any agent left unconfigured runs its CLI's default model for both roles (no split,
   no breakage).

Non-goals (explicitly out of scope): per-story model overrides, model split for
**multi-agent** (non-solo) runs, per-tenant model IDs, automatic model discovery.

## 2. Why this is safe to build (grounding in current code)

These facts were verified against the working tree (commit `6e7cf2c`):

- **Server already allows zero workers.** `/api/ralph/plan` (`server.js:2902`) and
  `/api/ralph/start` (`server.js:2927`) validate only that each worker is a *valid*
  agent — neither requires ≥1. The block is purely client-side in the React app.
- **Orchestrator already assigns to the master.** `planPrd` builds
  `roster = [master, ...workers]` (`server.js:732`); with no workers that is
  `[master]`. `normalizePrd` (`server.js:847`) clamps any unknown `assignee` to the
  master. `planner.md:61-62` explicitly permits assigning stories to the master. So a
  zero-worker PRD has every story assigned to the master — already valid and merge-safe.
- **One injection point for env/launch.** Every worker/review/finalize command is
  assembled through `ralphEnvPrefix(agent, run)` (`server.js:1415`) plus the per-script
  invocation in `spawnWorker`/`spawnReview`/`spawnFinalize` (`server.js:1631/1660/1676`).
- **All four CLIs accept `-m/--model`.** Verified via `--help`: `claude --model`,
  `codex exec -m/--model`, `gemini -m/--model`, `qwen -m/--model`. So a uniform
  `--model <id>` flag threaded through `ralph/ralph.sh`, `ralph/ralph-review.sh`,
  `ralph/ralph-finalize.sh` works for all agents.
- **Persistence + admin gating precedents exist.** `readJson`/`writeJson`
  (`server.js:47/51`) for config files in `DATA_DIR`. Admin routes are gated by
  `requireAdmin` (`server.js:2636`); **platform MCP servers** (`/api/admin/mcp`,
  `server.js:2683`) are the exact precedent for *deployment-wide, admin-managed* config.

**Consequence:** no orchestrator rewrite. The change is (a) relax one UI guard,
(b) thread a resolved model through the three spawn paths and three shell scripts,
(c) add a small admin config store + API + UI.

## 3. Definitions

- **Solo run:** `isSolo(run) === (run.workers || []).length === 0`. The master may be
  any valid master agent (glm excluded — it cannot be master). All stories are assigned
  to the master; the master also reviews/merges/finalizes.
- **Role:** `'build'` (worker pass on a story branch) vs `'review'` (master review of a
  branch **and** the finalize pass). Finalize is treated as a review-role task (top model).
- **Model resolution:** `soloModel(agent, role)` → a model id string, or `''` meaning
  "omit `--model`, use the CLI default."

## 4. Component design

### 4.1 Model-ID config store (server)

A new deployment-wide config file, `DATA_DIR/soloModels.json`:

```json
{
  "claude": { "build": "claude-sonnet-4-6", "review": "claude-opus-4-8" },
  "codex":  { "build": "", "review": "" },
  "qwen":   { "build": "", "review": "" },
  "gemini": { "build": "", "review": "" }
}
```

- Loaded at boot into an in-memory `soloModels` object (mirrors how `secrets` loads),
  merged over **built-in defaults** so Claude is always populated even if the file is
  absent. Reloaded on every successful PUT.
- **Resolution precedence** (highest first): env override → config file → built-in
  default → `''`. Env override is a single JSON blob `RALPH_SOLO_MODELS` (same shape) so
  ops can inject without the UI, consistent with the codebase's "env overrides file" idiom.
- Only keys in `VALID_AGENTS` minus `glm` are honored; unknown keys ignored. Model id
  strings are validated: trimmed, length ≤ 100, charset `[A-Za-z0-9._:/-]` (slash allows
  ids like `anthropic/claude-3.5`; rejects shell
  metacharacters — defense in depth even though values are passed as argv, not via shell).

```js
const SOLO_MODEL_DEFAULTS = { claude: { build: 'claude-sonnet-4-6', review: 'claude-opus-4-8' } };
function soloModel(agent, role) { /* env JSON → soloModels[agent][role] → default → '' */ }
```

### 4.2 Model injection (server → scripts)

- **`spawnWorker`** (`server.js:1631`): when `isSolo(run)`, resolve
  `model = soloModel(story.assignee, 'build')` and append `--model <model>` to the
  `ralph.sh` invocation when non-empty.
- **`spawnReview`** (`server.js:1660`) and **`spawnFinalize`** (`server.js:1676`): when
  `isSolo(run)`, resolve `model = soloModel(run.master, 'review')` and append `--model`
  to the `ralph-review.sh`/`ralph-finalize.sh` invocation.
- Model id is passed as a **separate argv token** (the scripts read `--model "$2"`), so
  it never participates in shell word-splitting. The validation in §4.1 is belt-and-braces.

**Coding-plan / GLM guard.** The override is suppressed when it would fight an
already-pinned model:
- If the resolved agent credential is a **claude coding plan** (`claudePlanOf` →
  `plan.model`, set as `ANTHROPIC_MODEL` at `server.js:1388`), skip `--model` — the
  plan's model wins (e.g. Z.ai/Kimi/BytePlus proxies that only serve one model id).
- `glm` is never a solo agent (not a valid master, and as a worker it uses `direct.mjs`),
  so it is structurally excluded; no special-case needed beyond not configuring it.

### 4.3 Shell scripts (`ralph/*.sh`)

Add an optional `--model <id>` arg to all three scripts. Each builds a `model_flag`
array, empty unless set, and passes it with the correct flag per CLI:

```sh
MODEL=""
# in arg parse: --model) MODEL="$2"; shift 2;;
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")

# per-tool, e.g.:
claude) printf '%s' "$PROMPT_TEXT" | claude $bypass_flag "${model_flag[@]}" --print ;;
codex)  printf '%s' "$PROMPT_TEXT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT_TEXT" ;;
qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT_TEXT" ;;
```

`glm` and `stub` ignore `--model`. Validate with `bash -n ralph/*.sh`. No `--model`
passed → byte-identical behavior to today (backward compatible).

### 4.4 Admin API (server)

Mirror the platform-MCP admin pattern (`server.js:2683`), gated by the existing
`app.use('/api/admin', requireAdmin)`:

- `GET /api/admin/solo-models` → `{ models: <effective map>, defaults: SOLO_MODEL_DEFAULTS, agents: [...] }`
  (effective = file merged over defaults, so the UI shows what will actually be used).
- `PUT /api/admin/solo-models` → body `{ models: { <agent>: { build, review } } }`;
  validates ids (§4.1), writes `soloModels.json` via `writeJson`, refreshes the in-memory
  map, returns the new effective map. Audited via `audit({ adminSoloModels: ... })`.

Single-tenant note: in pure single-tenant mode the `/api/admin/*` block may not mount
(no auth). The `RALPH_SOLO_MODELS` env override and editing `soloModels.json` directly
remain available there. **(Open decision — see §8.)**

### 4.5 Admin UI (`web/src/pages/Admin.jsx` + `web/src/api.js`)

New "Solo build models" card in the Admin page: a small table, one row per agent
(claude/codex/qwen/gemini), two text inputs (Build model / Review model) seeded from
`GET /api/admin/solo-models`, a Save button calling `PUT`. Placeholder text shows the
default (or "CLI default" when blank). Inline validation mirrors the server. New
`api.js` methods: `adminSoloModels()` / `adminSetSoloModels(models)`.

### 4.6 New-build UI unblock (`web/src/pages/NewBuild.jsx`)

- Replace the hard guard at line 75. Allow `workers.length === 0`.
- When `workers.length === 0`, render a **solo banner**: "Solo mode — `<master>` builds
  and reviews on its own." If master is claude (or any agent with configured ids), add:
  "Builds on `<build model>`, reviews on `<review model>`." (Pull from a lightweight
  `GET /api/admin/solo-models` if available; otherwise show the generic line.)
- Keep the existing missing-credential check (`missingKeys`) — solo still needs the
  master's credential.

### 4.7 PWA parity (`public/js/dashboard.js`, `public/sw.js`)

The PWA has no worker-count guard, but it filters the master out of the worker set
(`dashboard.js:1001`), so a solo selection already yields `workers: []` and works. Add
the same solo hint near the agent chips, and **bump `VERSION` in `public/sw.js`
(v28 → v29)** so the cached module refreshes (per CLAUDE.md).

## 5. Data flow (solo run)

```
NewBuild (workers=[]) ──POST /api/ralph/plan──▶ planPrd(roster=[master])
   └─ normalizePrd clamps every story.assignee = master
POST /api/ralph/start ─▶ run.workers=[]  (isSolo=true)
ralphTick:
  per story ─▶ spawnWorker   ─▶ ralph.sh --tool <master> --model <build-model>
  reap ──────▶ spawnReview    ─▶ ralph-review.sh --tool <master> --model <review-model>
              ACCEPT → merge → push ;  REJECT/conflict → retry on main
  all merged ─▶ spawnFinalize ─▶ ralph-finalize.sh --tool <master> --model <review-model>
              PASS → readme → push → done
```

## 6. Error handling & edge cases

- **Bad/stale model id** (e.g. admin typo). The CLI errors; the worker writes a non-zero
  exit / no `COMPLETE`, the existing **stall reaper** (`RALPH_STALL_MS`, CLAUDE.md
  invariant) reaps and retries. Bounded by `maxAttempts`. Surfaced in the run's events
  and `MASTER.md`. Mitigation: server-side id validation + per-agent default-until-set so
  the blast radius is one misconfigured agent, not all runs.
- **Coding-plan tenant.** `--model` suppressed (§4.2); the plan's fixed model is used.
- **glm.** Excluded structurally.
- **Self-review weakness.** Inherent to one agent, mitigated by the split (top model
  reviews second-best model's work). Documented; not a blocker.
- **Concurrency on `soloModels.json`.** Single-process Node; PUT is last-writer-wins,
  acceptable for low-frequency admin edits. Write is whole-file via `writeJson`.
- **Backward compatibility.** No config file + no env → Claude uses built-in defaults,
  all other agents use CLI defaults, and existing multi-worker runs are untouched
  (model injection only fires when `isSolo`). Scripts behave identically without `--model`.

## 7. Security

- Admin API behind `requireAdmin`; model ids are not secrets but are deployment-wide.
- Model id charset validation rejects shell metacharacters; values pass as argv tokens,
  not through a shell string, so no injection vector via the model field.
- No new secrets written to `soloModels.json`; it is safe to commit to backups (but lives
  in `DATA_DIR`, outside the repo, like other state).

## 8. Open decisions (resolve during review)

1. **Single-tenant admin surface.** `/api/admin/*` is gated by SaaS auth. For a pure
   single-tenant deploy with no login, should the model-IDs UI live (a) only in the SaaS
   Admin page (env/file fallback single-tenant), or (b) also be exposed in the PWA behind
   a local-only guard? Recommendation: (a) for now — matches platform-MCP precedent.
2. **Finalize model.** Spec uses the **review/top** model for finalize. Confirm (vs. the
   build/cheaper model). Recommendation: keep top model (finalize is a quality gate).
3. **Solo banner model display.** Show resolved model ids in NewBuild (one extra GET) vs.
   a generic "uses your configured solo models" line. Recommendation: show ids when the
   admin endpoint is reachable, generic otherwise.

## 9. Testing (no API spend)

Per CLAUDE.md "Testing Ralph without spend":

- **Syntax:** `node --check server.js`, `bash -n ralph/*.sh`, build the React app
  (`npm run build` in `web/`).
- **Solo orchestration (stub):** drop-in `RALPH_FORCE_TOOL=stub` +
  `RALPH_FAKE_REMOTE=/tmp/bare.git`; `POST /api/ralph/start` with a deterministic `prd`
  and `workers: []`. Assert: every story `assignee === master`, the run reaches `done`,
  branches merge. (Stub ignores `--model`, so this validates solo *flow*.)
- **Model injection (unit):** assert the command strings built by
  `spawnWorker`/`spawnReview`/`spawnFinalize` contain `--model <build>` / `--model <review>`
  when `isSolo` and a config is set, and **no** `--model` when unset or coding-plan.
- **Config API:** PUT then GET `/api/admin/solo-models`; assert validation rejects a bad
  id and that the effective map merges over defaults.
- **Teardown:** remove the drop-in, kill leftover `r-/rv-/rf-/app-` tmux sessions.

## 10. File-by-file change list

| File | Change |
|---|---|
| `server.js` | `SOLO_MODEL_DEFAULTS`, `soloModels` load + `loadSoloModels()`, `soloModel(agent,role)`, `isSolo(run)`; thread model into `spawnWorker`/`spawnReview`/`spawnFinalize` with coding-plan guard; `GET/PUT /api/admin/solo-models`. |
| `ralph/ralph.sh` | `--model` arg + `model_flag` for claude/codex/gemini/qwen. |
| `ralph/ralph-review.sh` | `--model` arg + `model_flag`. |
| `ralph/ralph-finalize.sh` | `--model` arg + `model_flag`. |
| `web/src/pages/NewBuild.jsx` | Remove worker-required guard; solo banner. |
| `web/src/pages/Admin.jsx` | "Solo build models" editor card. |
| `web/src/api.js` | `adminSoloModels` / `adminSetSoloModels`. |
| `public/js/dashboard.js` | Solo hint near agent chips. |
| `public/sw.js` | Bump `VERSION` v28 → v29. |
| `CLAUDE.md` | Document solo mode + model split + `soloModels.json`. |

## 11. Rollout

1. Land server + scripts (backward compatible; no behavior change until a solo run starts).
2. Land admin config + UI.
3. Land NewBuild unblock + PWA hint (+ sw bump).
4. Verify with the stub harness; then a real Claude solo smoke build.
