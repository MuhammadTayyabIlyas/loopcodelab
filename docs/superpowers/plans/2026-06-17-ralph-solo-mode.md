# Ralph Solo Mode + Per-Role Model Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Ralph build run "solo" (one master agent, zero workers — it builds every story then reviews/merges/finalizes), and in solo mode split models per role (build on a low-cost model, review+finalize on a top model), with admin-editable per-agent model IDs.

**Architecture:** Pure model-resolution logic lives in a new focused ESM module `ralph/solo-models.mjs` (unit-tested in isolation). `server.js` owns file/env I/O, the admin API, and splicing the resolved `--model <id>` into the three spawn commands; the three `ralph/*.sh` scripts gain an optional `--model` arg. The React SaaS UI drops the "≥1 worker" guard and adds a solo banner + admin model-ID editor. No orchestrator rewrite: the planner already assigns all stories to the master when `workers` is empty (`normalizePrd` clamp, `planner.md:61-62`).

**Tech Stack:** Node 22 ESM, Express, `ws`, bash worker scripts, React 18 + Vite (in `web/`), vanilla-JS PWA (in `public/`).

## Global Constraints

- **Module system is ESM** (`package.json` `"type": "module"`). Use `import`/`export`, not `require`.
- **No linter/formatter and no pre-existing JS test runner.** Use Node's built-in `node --test` for the new module's unit tests. Syntax-gate everything: `node --check server.js`, `bash -n ralph/*.sh`.
- **Solo model defaults:** Claude → build `claude-sonnet-4-6`, review `claude-opus-4-8`. All other agents default to **blank** (= the CLI's own default model; no `--model` passed) until an admin sets them.
- **Model split applies ONLY in solo runs** (`workers.length === 0`). Multi-worker runs are untouched.
- **Never fight a pinned model:** suppress `--model` when the claude agent resolves to a coding plan (which already forces `ANTHROPIC_MODEL`). `glm` is structurally excluded (never a master; uses `direct.mjs` as a worker).
- **Backward compatible:** with no config and no `--model`, behavior is byte-identical to today.
- **PWA cache rule (CLAUDE.md):** any edit under `public/` REQUIRES bumping `VERSION` in `public/sw.js`.
- **Model id charset:** `^[A-Za-z0-9._:/-]{1,100}$` (ids are spliced into a shell command string; reject everything else).
- **React build:** after editing anything in `web/src`, run `cd web && npm run build` (outputs `web/dist`, served at `/app`).
- **Restart to load server changes:** `systemctl restart webtmux` then check `journalctl -u webtmux -f` (safe for live sessions per the `KillMode=process` drop-in).

---

### Task 1: Pure model-resolution module + unit tests

**Files:**
- Create: `ralph/solo-models.mjs`
- Test: `ralph/solo-models.test.mjs`

**Interfaces:**
- Consumes: nothing (pure, no I/O).
- Produces (imported by Task 2 & Task 4):
  - `SOLO_AGENTS: string[]`
  - `SOLO_MODEL_DEFAULTS: { [agent]: { build?: string, review?: string } }`
  - `validModelId(s): boolean`
  - `sanitizeModels(input): { [agent]: { build?, review? } }` — throws `Error` on an invalid id
  - `soloModelsFromEnv(env=process.env): map`
  - `effectiveModels(fileMap, envMap): map`
  - `resolveSoloModel(models, agent, role): string`
  - `soloModelFlag({ solo, agent, role, codingPlan, models }): string` — returns `' --model <id>'` or `''`

- [ ] **Step 1: Write the failing unit tests**

Create `ralph/solo-models.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validModelId, sanitizeModels, soloModelsFromEnv, effectiveModels,
  resolveSoloModel, soloModelFlag, SOLO_MODEL_DEFAULTS, SOLO_AGENTS,
} from './solo-models.mjs';

test('SOLO_AGENTS excludes glm', () => {
  assert.deepEqual(SOLO_AGENTS, ['claude', 'codex', 'qwen', 'gemini']);
});

test('validModelId accepts real ids, rejects junk', () => {
  assert.ok(validModelId('claude-opus-4-8'));
  assert.ok(validModelId('anthropic/claude-3.5'));
  assert.ok(!validModelId('claude; rm -rf /'));
  assert.ok(!validModelId(''));
  assert.ok(!validModelId('a'.repeat(101)));
});

test('sanitizeModels keeps valid, trims, drops blanks/unknowns, throws on bad id', () => {
  const out = sanitizeModels({ claude: { build: ' gpt ', review: '' }, bogus: { build: 'x' } });
  assert.deepEqual(out, { claude: { build: 'gpt' } });
  assert.throws(() => sanitizeModels({ codex: { build: 'bad id!' } }));
});

test('soloModelsFromEnv parses valid JSON or returns {}', () => {
  assert.deepEqual(
    soloModelsFromEnv({ RALPH_SOLO_MODELS: '{"codex":{"build":"gpt-x"}}' }),
    { codex: { build: 'gpt-x' } });
  assert.deepEqual(soloModelsFromEnv({ RALPH_SOLO_MODELS: 'not json' }), {});
  assert.deepEqual(soloModelsFromEnv({}), {});
});

test('effectiveModels merges defaults < file < env', () => {
  const eff = effectiveModels({ claude: { build: 'sonnet-x' } }, { claude: { review: 'opus-y' } });
  assert.equal(eff.claude.build, 'sonnet-x');
  assert.equal(eff.claude.review, 'opus-y');
});

test('effectiveModels populates claude defaults, leaves others absent', () => {
  const eff = effectiveModels({}, {});
  assert.deepEqual(eff.claude, SOLO_MODEL_DEFAULTS.claude);
  assert.equal(eff.codex, undefined);
});

test('resolveSoloModel returns id or empty string', () => {
  const m = { claude: { build: 'b' } };
  assert.equal(resolveSoloModel(m, 'claude', 'build'), 'b');
  assert.equal(resolveSoloModel(m, 'claude', 'review'), '');
  assert.equal(resolveSoloModel(m, 'codex', 'build'), '');
});

test('soloModelFlag: only when solo, configured, not coding-plan', () => {
  const models = { claude: { build: 'claude-sonnet-4-6', review: 'claude-opus-4-8' } };
  assert.equal(soloModelFlag({ solo: true, agent: 'claude', role: 'build', models }), ' --model claude-sonnet-4-6');
  assert.equal(soloModelFlag({ solo: true, agent: 'claude', role: 'review', models }), ' --model claude-opus-4-8');
  assert.equal(soloModelFlag({ solo: false, agent: 'claude', role: 'build', models }), '');
  assert.equal(soloModelFlag({ solo: true, agent: 'claude', role: 'build', codingPlan: true, models }), '');
  assert.equal(soloModelFlag({ solo: true, agent: 'codex', role: 'build', models }), '');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test ralph/solo-models.test.mjs`
Expected: FAIL — `Cannot find module './solo-models.mjs'` (module not created yet).

- [ ] **Step 3: Implement the module**

Create `ralph/solo-models.mjs`:

```js
// Per-agent model selection for SOLO (single-developer) Ralph runs. A solo run is one
// agent that builds every story on a low-cost model and reviews/finalizes on a top
// model. Pure + side-effect free so it unit-tests in isolation; server.js owns the
// file/env I/O and the spawn wiring.

// Agents that can run solo. glm is excluded: it is never a master and runs as a worker
// via direct.mjs (a single-shot API call), so a --model flag does not apply.
export const SOLO_AGENTS = ['claude', 'codex', 'qwen', 'gemini'];

// Built-in defaults. Only Claude is known-good; other agents stay unset (= the CLI's
// own default model, no --model passed) until an admin configures them, so a blank or
// wrong id can never break a build.
export const SOLO_MODEL_DEFAULTS = {
  claude: { build: 'claude-sonnet-4-6', review: 'claude-opus-4-8' },
};

// Ids are not secrets but ARE spliced into a shell command string, so restrict to a
// safe charset (letters, digits, dot, underscore, colon, slash, hyphen).
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
export function validModelId(s) { return typeof s === 'string' && MODEL_ID_RE.test(s); }

// Keep only known agents/roles and valid ids; drop blanks/unknowns. Throws on a present
// but invalid id so the admin PUT can report it.
export function sanitizeModels(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const agent of SOLO_AGENTS) {
    const row = input[agent];
    if (!row || typeof row !== 'object') continue;
    const clean = {};
    for (const role of ['build', 'review']) {
      const v = typeof row[role] === 'string' ? row[role].trim() : '';
      if (v === '') continue;
      if (!validModelId(v)) throw new Error(`Invalid model id for ${agent}.${role}: "${v}"`);
      clean[role] = v;
    }
    if (Object.keys(clean).length) out[agent] = clean;
  }
  return out;
}

// RALPH_SOLO_MODELS env override (JSON, same shape). Best-effort: {} on absence/parse error.
export function soloModelsFromEnv(env = process.env) {
  const raw = env.RALPH_SOLO_MODELS;
  if (!raw) return {};
  try { return sanitizeModels(JSON.parse(raw)); } catch { return {}; }
}

// Merge precedence (lowest -> highest): defaults < file < env, per agent/role.
export function effectiveModels(fileMap = {}, envMap = {}) {
  const out = {};
  for (const agent of SOLO_AGENTS) {
    const merged = {
      ...(SOLO_MODEL_DEFAULTS[agent] || {}),
      ...(fileMap[agent] || {}),
      ...(envMap[agent] || {}),
    };
    if (merged.build || merged.review) out[agent] = merged;
  }
  return out;
}

export function resolveSoloModel(models, agent, role) {
  return (models && models[agent] && models[agent][role]) || '';
}

// The single decision point the spawn builders call. Returns a command fragment
// (' --model <id>') to splice into the CLI invocation, or '' to leave the CLI on its
// default. Suppressed when not solo, or when a coding plan already pins the model.
export function soloModelFlag({ solo, agent, role, codingPlan, models }) {
  if (!solo || codingPlan) return '';
  const id = resolveSoloModel(models, agent, role);
  return id ? ` --model ${id}` : '';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test ralph/solo-models.test.mjs`
Expected: PASS — all tests green, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add ralph/solo-models.mjs ralph/solo-models.test.mjs
git commit -m "feat(ralph): solo-models resolver module + unit tests"
```

---

### Task 2: Server config store + solo-models API

**Files:**
- Modify: `server.js` — imports near top (after line 12), config state near `initSecrets` (~593), boot load (~3693), `GET /api/ralph/solo-models` before the `/api/ralph/:project` routes (just before line 3403's delete route is fine; the existing prefs routes at ~3367 show the "register before :project" pattern), and `PUT /api/admin/solo-models` next to the admin MCP routes (~2691).

**Interfaces:**
- Consumes (from Task 1): `SOLO_AGENTS`, `SOLO_MODEL_DEFAULTS`, `sanitizeModels`, `soloModelsFromEnv`, `effectiveModels`.
- Produces (used by Task 4 & the UI): module-level `soloModelsFile`, `soloModelsEffective()`, `loadSoloModels()`; HTTP `GET /api/ralph/solo-models` → `{ models, saved, defaults, agents }`; `PUT /api/admin/solo-models` body `{ models }` → `{ ok, models }`.

- [ ] **Step 1: Add the import**

In `server.js`, after the existing imports (after line 12 `import fs from 'node:fs/promises';`), add:

```js
import {
  SOLO_AGENTS, SOLO_MODEL_DEFAULTS, sanitizeModels, soloModelsFromEnv, effectiveModels,
} from './ralph/solo-models.mjs';
```

- [ ] **Step 2: Add config file constant, state, and loader**

In `server.js`, right after the `initSecrets` block (after line 596 `}`), add:

```js
// Deployment-wide solo-build model map (admin-managed, like platform MCP servers).
// File holds only what the admin saved; effective view merges defaults < file < env.
const SOLO_MODELS_FILE = path.join(DATA_DIR, 'soloModels.json');
let soloModelsFile = {};
function soloModelsEffective() { return effectiveModels(soloModelsFile, soloModelsFromEnv()); }
async function loadSoloModels() {
  try { soloModelsFile = sanitizeModels(await readJson(SOLO_MODELS_FILE, {})); }
  catch (e) { console.warn('[solo-models] ignoring invalid soloModels.json:', e.message); soloModelsFile = {}; }
}
```

- [ ] **Step 3: Load it at boot**

In `server.js`, after line 3693 `await initSecrets().catch(...)`, add:

```js
await loadSoloModels();
```

- [ ] **Step 4: Add the read route (before the `/api/ralph/:project` routes)**

In `server.js`, immediately above the project-delete route `app.delete('/api/ralph/:project', ...)` (line 3403) — same "register before `:project`" placement the prefs routes use — add:

```js
// Solo-build model map (read-only; ids are not secrets). Registered before the
// :project routes so "solo-models" is never treated as a project name.
app.get('/api/ralph/solo-models', (_req, res) =>
  res.json({ models: soloModelsEffective(), saved: soloModelsFile, defaults: SOLO_MODEL_DEFAULTS, agents: SOLO_AGENTS }));
```

- [ ] **Step 5: Add the admin write route**

In `server.js`, right after `app.delete('/api/admin/mcp/:id', ...)` (line 2691), add:

```js
app.put('/api/admin/solo-models', async (req, res) => {
  let clean;
  try { clean = sanitizeModels(req.body?.models); }
  catch (e) { return fail(res, 400, e.message); }
  await writeJson(SOLO_MODELS_FILE, clean);
  soloModelsFile = clean;
  audit({ adminSoloModels: Object.keys(clean), by: req.auth?.user?.email });
  res.json({ ok: true, models: soloModelsEffective() });
});
```

- [ ] **Step 6: Syntax-check**

Run: `node --check server.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Verify wiring at runtime (read route is unauthenticated/open)**

Restart and curl the read route (works in single-tenant/open mode; in multitenant it needs a session cookie — if so, skip the curl and rely on the Task 1 unit tests + `node --check`, then verify via the UI in Task 6).

Run:
```bash
systemctl restart webtmux
curl -s http://127.0.0.1:8090/api/ralph/solo-models | head -c 400; echo
```
Expected: JSON containing `"claude":{"build":"claude-sonnet-4-6","review":"claude-opus-4-8"}` under `models`, and `"agents":["claude","codex","qwen","gemini"]`.

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat(ralph): solo-models config store + GET/PUT API"
```

---

### Task 3: `--model` flag in the three worker/master scripts

**Files:**
- Modify: `ralph/ralph.sh` (arg parse ~16-26, bypass/run_tool ~76-86)
- Modify: `ralph/ralph-review.sh` (arg parse 6-11, run_master 35-45)
- Modify: `ralph/ralph-finalize.sh` (arg parse 6-10, run_master 32-42)

**Interfaces:**
- Consumes: a new optional `--model <id>` argument (passed by Task 4).
- Produces: each CLI is invoked with `--model <id>` when set; identical to today when unset. `glm`/`stub` ignore it.

- [ ] **Step 1: Add `--model` to `ralph/ralph.sh`**

Change the declaration line (16) from:
```sh
TOOL=""; STORY=""; DIR="."; MAX=3; PROMPT_FILE=""
```
to:
```sh
TOOL=""; STORY=""; DIR="."; MAX=3; PROMPT_FILE=""; MODEL=""
```

Add a case to the arg loop (inside the `case "$1" in` block, after the `--prompt` line 23):
```sh
    --model)  MODEL="$2";       shift 2;;
```

After the bypass block (after line 73 `fi`), add:
```sh
# Optional per-role model (set by the orchestrator in solo runs). Empty => CLI default.
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")
```

In `run_tool()` (lines 77-83), update the claude/codex/gemini/qwen lines to splice the flag (leave `glm` and `stub` unchanged):
```sh
    claude) printf '%s' "$PROMPT_TEXT" | claude $bypass_flag "${model_flag[@]}" --print ;;
    glm)    node "$SCRIPT_DIR/direct.mjs" --story "$STORY" --dir "$DIR" ;;
    codex)  printf '%s' "$PROMPT_TEXT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
    gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT_TEXT" ;;
    qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT_TEXT" ;;
```

> Note: `"${model_flag[@]}"` on an empty array is safe under `set -u` on bash ≥ 4.4 (deploy box is bash 5).

- [ ] **Step 2: Add `--model` to `ralph/ralph-review.sh`**

Change line 6 from:
```sh
TOOL=""; STORY=""; DIR="."; BRANCH=""; VERDICT_FILE=""
```
to:
```sh
TOOL=""; STORY=""; DIR="."; BRANCH=""; VERDICT_FILE=""; MODEL=""
```

Add to the arg loop (line 10, after `--verdict`):
```sh
  --model) MODEL="$2"; shift 2;;
```

After the bypass block (after line 34 `esac; fi`), add:
```sh
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")
```

Update `run_master()` claude/codex/gemini/qwen lines (leave `glm` unchanged — it pins GLM-5.1):
```sh
    claude) printf '%s' "$PROMPT" | claude $bypass_flag "${model_flag[@]}" --print ;;
    glm)    printf '%s' "$PROMPT" | ANTHROPIC_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/coding" \
              ANTHROPIC_API_KEY="${GLM_API_KEY:-}" claude --model GLM-5.1 $bypass_flag --print ;;
    codex)  printf '%s' "$PROMPT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
    gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
    qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
```

- [ ] **Step 3: Add `--model` to `ralph/ralph-finalize.sh`**

Change line 6 from:
```sh
TOOL=""; DIR="."; RESULT_FILE=""
```
to:
```sh
TOOL=""; DIR="."; RESULT_FILE=""; MODEL=""
```

Add to the arg loop (line 9, after `--result`):
```sh
  --model) MODEL="$2"; shift 2;;
```

After the bypass block (after line 31 `esac; fi`), add:
```sh
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")
```

Update `run_master()` claude/codex/gemini/qwen lines (leave `glm` unchanged):
```sh
    claude) printf '%s' "$PROMPT" | claude $bypass_flag "${model_flag[@]}" --print ;;
    glm)    printf '%s' "$PROMPT" | ANTHROPIC_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/coding" \
              ANTHROPIC_API_KEY="${GLM_API_KEY:-}" claude --model GLM-5.1 $bypass_flag --print ;;
    codex)  printf '%s' "$PROMPT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
    gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
    qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
```

- [ ] **Step 4: Syntax-check all three scripts**

Run: `bash -n ralph/ralph.sh ralph/ralph-review.sh ralph/ralph-finalize.sh`
Expected: no output, exit code 0.

- [ ] **Step 5: Functional check — arg parsing tolerates `--model` (stub ignores it)**

Run:
```bash
tmp=$(mktemp -d); ( cd "$tmp" && git init -q && RALPH_FORCE_TOOL=stub bash /var/www/tmux.tayyabcheema.com/ralph/ralph.sh --tool stub --story T1 --dir "$tmp" --model some-model --max 1 ) ; echo "exit=$?"; rm -rf "$tmp"
```
Expected: the stub runs (prints stub output) and `exit=0` — confirms `--model` is parsed without error and ignored by the stub path.

- [ ] **Step 6: Commit**

```bash
git add ralph/ralph.sh ralph/ralph-review.sh ralph/ralph-finalize.sh
git commit -m "feat(ralph): optional --model passthrough in worker/review/finalize scripts"
```

---

### Task 4: Inject the resolved model into the spawn commands

**Files:**
- Modify: `server.js` — import (extend Task 2's import), `isSolo`/`agentHasCodingPlan` helpers (near `ralphEnvPrefix` ~1415), and the three command builders `spawnWorker` (1645), `spawnReview` (1669), `spawnFinalize` (1689).

**Interfaces:**
- Consumes (from Task 1): `soloModelFlag`; (from Task 2): `soloModelsEffective`; existing `claudePlanOf`, `tenantKey`.
- Produces: solo runs invoke the scripts with `--model <build>` (workers) / `--model <review>` (review+finalize); non-solo and coding-plan runs are unchanged.

- [ ] **Step 1: Extend the import with `soloModelFlag`**

In `server.js`, update the Task 2 import to also bring in `soloModelFlag`:

```js
import {
  SOLO_AGENTS, SOLO_MODEL_DEFAULTS, sanitizeModels, soloModelsFromEnv, effectiveModels,
  soloModelFlag,
} from './ralph/solo-models.mjs';
```

- [ ] **Step 2: Add `isSolo` + `agentHasCodingPlan` helpers**

In `server.js`, immediately before `function ralphEnvPrefix(agent, run) {` (line 1415), add:

```js
// A solo run = one master, no separate workers. The master builds every story (clamped
// by normalizePrd) and also reviews/finalizes — so the model split applies.
const isSolo = (run) => (run?.workers || []).length === 0;
// True only when the claude agent resolves to a coding plan, which already pins
// ANTHROPIC_MODEL (tenantAgentCreds) — don't fight it with --model.
function agentHasCodingPlan(agent, run) {
  if (agent !== 'claude') return false;
  const get = (p) => tenantKey(run, p);
  return !!claudePlanOf(get);
}
```

- [ ] **Step 3: Inject build model in `spawnWorker`**

In `server.js`, inside `spawnWorker` replace the `cmd` assembly (lines 1645-1646):

```js
  const cmd = `mkdir -p .ralph && ${noteEnv}${skillsEnv}${ralphEnvPrefix(story.assignee, run)}bash ${RALPH_SH} --tool ${story.assignee} ` +
    `--story ${story.id} --dir ${wt} --max ${run.workerPasses || 1}; echo $? > .ralph/${story.id}.exit`;
```

with:

```js
  const modelFlag = soloModelFlag({
    solo: isSolo(run), agent: story.assignee, role: 'build',
    codingPlan: agentHasCodingPlan(story.assignee, run), models: soloModelsEffective(),
  });
  const cmd = `mkdir -p .ralph && ${noteEnv}${skillsEnv}${ralphEnvPrefix(story.assignee, run)}bash ${RALPH_SH} --tool ${story.assignee} ` +
    `--story ${story.id} --dir ${wt} --max ${run.workerPasses || 1}${modelFlag}; echo $? > .ralph/${story.id}.exit`;
```

- [ ] **Step 4: Inject review model in `spawnReview`**

In `server.js`, inside `spawnReview` replace the `cmd` assembly (lines 1669-1670):

```js
  const cmd = `mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_REVIEW_SH} --tool ${run.master} ` +
    `--story ${story.id} --dir ${wt} --branch ${story.branch} --verdict ${verdict}`;
```

with:

```js
  const modelFlag = soloModelFlag({
    solo: isSolo(run), agent: run.master, role: 'review',
    codingPlan: agentHasCodingPlan(run.master, run), models: soloModelsEffective(),
  });
  const cmd = `mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_REVIEW_SH} --tool ${run.master} ` +
    `--story ${story.id} --dir ${wt} --branch ${story.branch} --verdict ${verdict}${modelFlag}`;
```

- [ ] **Step 5: Inject review model in `spawnFinalize`**

In `server.js`, inside `spawnFinalize` replace the `cmd` assembly (lines 1689-1690):

```js
  const cmd = `mkdir -p .ralph && ${skillsEnv}${ralphEnvPrefix(run.master, run)}bash ${RALPH_FINALIZE_SH} --tool ${run.master} ` +
    `--dir ${run.dir} --result ${result}`;
```

with:

```js
  const modelFlag = soloModelFlag({
    solo: isSolo(run), agent: run.master, role: 'review',
    codingPlan: agentHasCodingPlan(run.master, run), models: soloModelsEffective(),
  });
  const cmd = `mkdir -p .ralph && ${skillsEnv}${ralphEnvPrefix(run.master, run)}bash ${RALPH_FINALIZE_SH} --tool ${run.master} ` +
    `--dir ${run.dir} --result ${result}${modelFlag}`;
```

- [ ] **Step 6: Syntax-check**

Run: `node --check server.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Integration — drive a solo run end-to-end with stubs (no spend)**

Per CLAUDE.md "Testing Ralph without spend": add a systemd drop-in setting `RALPH_FORCE_TOOL=stub` and `RALPH_FAKE_REMOTE=/tmp/solo-bare.git`, `daemon-reload`, restart. Then:

```bash
git init --bare /tmp/solo-bare.git
curl -s -X POST http://127.0.0.1:8090/api/ralph/start \
  -H 'Content-Type: application/json' \
  -d '{"project":"solo-smoke","idea":"hello","master":"claude","workers":[],
       "prd":{"project":"solo-smoke","summary":"t","stories":[
         {"id":"S1","title":"a","assignee":"claude","deps":[]},
         {"id":"S2","title":"b","assignee":"claude","deps":[]}]}}'
# poll until done
for i in $(seq 1 30); do sleep 4; \
  curl -s "http://127.0.0.1:8090/api/ralph/status?project=solo-smoke" \
  | grep -o '"phase":"[a-z]*"'; done
```
Expected: every story `assignee` is `claude`, the run progresses building → finalizing → `"phase":"done"`. (Stub ignores `--model`; this validates the **solo flow** — that zero workers builds, reviews, merges, finalizes.) The `soloModelFlag` logic itself is covered by Task 1 unit tests.

- [ ] **Step 8: Tear down the test harness**

```bash
# remove the drop-in, daemon-reload, restart, then:
for s in $(tmux ls 2>/dev/null | grep -oE '^(r|rv|rf|app)-solo-smoke[^:]*'); do tmux kill-session -t "$s"; done
rm -rf /tmp/solo-bare.git
curl -s -X DELETE http://127.0.0.1:8090/api/ralph/solo-smoke >/dev/null
```
Expected: drop-in gone, no leftover `r-/rv-/rf-/app-` sessions.

- [ ] **Step 9: Commit**

```bash
git add server.js
git commit -m "feat(ralph): per-role model split injected into solo spawn commands"
```

---

### Task 5: Unblock solo in the React new-build form + solo banner

**Files:**
- Modify: `web/src/api.js` (add two methods)
- Modify: `web/src/pages/NewBuild.jsx` (remove guard at line 75; add solo banner in step 1)

**Interfaces:**
- Consumes: `GET /api/ralph/solo-models` (Task 2).
- Produces: a build with `workers: []` can be planned and started; a banner explains solo mode.

- [ ] **Step 1: Add API client methods**

In `web/src/api.js`, inside the `export const api = { ... }` object, after the `start:` line, add:

```js
  soloModels: () => req('GET', '/api/ralph/solo-models'),
  setSoloModels: (models) => req('PUT', '/api/admin/solo-models', { models }),
```

- [ ] **Step 2: Remove the worker-required guard**

In `web/src/pages/NewBuild.jsx`, delete line 75 entirely:

```js
    if (!workers.length) return setErr('Pick at least one worker agent.');
```

(Leave the `missingKeys` check on the next line intact.)

- [ ] **Step 3: Load solo models on mount**

In `web/src/pages/NewBuild.jsx`, add state + effect near the other `useState`/`useEffect` (after the `providers`/`cliLogins` effect, ~line 52):

```js
  const [soloModels, setSoloModels] = useState({});
  useEffect(() => { api.soloModels().then((d) => setSoloModels(d.models || {})).catch(() => {}); }, []);
```

- [ ] **Step 4: Render the solo banner**

In `web/src/pages/NewBuild.jsx`, inside the `{step === 1 && (` form, immediately after the closing `</div>` of the "Worker agents" block (after line 167's `</div>` that closes the worker card section — specifically just before the `</div>` that closes `<div className="card space-y-5">` at line 168), add:

```jsx
            {workers.length === 0 && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
                <b>Solo mode.</b> <span className="text-accent">{master}</span> builds every story and reviews its own work — no separate workers.
                {soloModels[master]?.build && (
                  <> Builds on <code>{soloModels[master].build}</code>, reviews on <code>{soloModels[master].review || 'its default model'}</code>.</>
                )}
              </div>
            )}
```

- [ ] **Step 5: Build the React app**

Run: `cd web && npm run build`
Expected: Vite build succeeds, writes `web/dist`, no errors.

- [ ] **Step 6: Manual verification**

Open `/app` → New build. Select master `claude`, then deselect all worker chips. Expected: the **Solo mode** banner appears showing "Builds on `claude-sonnet-4-6`, reviews on `claude-opus-4-8`", and "Generate plan →" proceeds (no "Pick at least one worker agent" error). The PRD preview shows every story assigned to `claude`.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.js web/src/pages/NewBuild.jsx web/dist
git commit -m "feat(web): allow solo builds (zero workers) + solo-mode banner"
```

---

### Task 6: Admin model-ID editor

**Files:**
- Modify: `web/src/pages/Admin.jsx` (add a "Solo build models" section)

**Interfaces:**
- Consumes: `api.soloModels()` (read) and `api.setSoloModels(models)` (write, admin-only) from Task 5.
- Produces: admin can edit per-agent build/review model IDs; saved to `soloModels.json`.

- [ ] **Step 1: Load solo models into Admin state**

In `web/src/pages/Admin.jsx`, add state after the existing `useState` declarations (after `const [msg, setMsg] = useState('');`, line 24):

```js
  const [solo, setSolo] = useState({ models: {}, saved: {}, agents: [], defaults: {} });
```

In the `load` function (lines 25-29), add a line:

```js
    api.soloModels().then(setSolo).catch(() => {});
```

- [ ] **Step 2: Add a controlled-edit handler + save**

In `web/src/pages/Admin.jsx`, after the `copy` function (line 41), add:

```js
  const setSoloField = (agent, role, value) =>
    setSolo((s) => ({ ...s, saved: { ...s.saved, [agent]: { ...(s.saved[agent] || {}), [role]: value } } }));
  const saveSolo = () => run('solo', async () => {
    await api.setSoloModels(solo.saved);
    setMsg('Saved solo build models.');
  });
```

- [ ] **Step 3: Render the editor section**

In `web/src/pages/Admin.jsx`, add a new `<section>` right before the closing `</div>` of the page container (after the Users `</section>`, before the final `</div>` at line ~ the component's end):

```jsx
      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Solo build models</h2>
            <p className="text-xs text-muted">Used only for solo builds (no workers): build on the cheaper model, review on the top model. Blank = the agent's CLI default.</p>
          </div>
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy === 'solo'} onClick={saveSolo}>Save models</button>
        </div>
        <div className="card overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2 text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-4 py-2">Agent</th><th className="px-4 py-2">Build model</th><th className="px-4 py-2">Review model</th></tr>
            </thead>
            <tbody>
              {(solo.agents || []).map((a) => (
                <tr key={a} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{a}</td>
                  <td className="px-4 py-2">
                    <input className="input !py-1 text-xs font-mono" value={solo.saved?.[a]?.build || ''}
                      placeholder={solo.defaults?.[a]?.build || 'CLI default'}
                      onChange={(e) => setSoloField(a, 'build', e.target.value)} />
                  </td>
                  <td className="px-4 py-2">
                    <input className="input !py-1 text-xs font-mono" value={solo.saved?.[a]?.review || ''}
                      placeholder={solo.defaults?.[a]?.review || 'CLI default'}
                      onChange={(e) => setSoloField(a, 'review', e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
```

- [ ] **Step 4: Build the React app**

Run: `cd web && npm run build`
Expected: Vite build succeeds, no errors.

- [ ] **Step 5: Manual verification (admin account)**

Open `/app` → Admin. Expected: a "Solo build models" table with rows claude/codex/qwen/gemini, claude inputs placeholdered with `claude-sonnet-4-6` / `claude-opus-4-8`. Set codex build = `gpt-x`, click "Save models", reload — the value persists. Confirm an invalid id (e.g. `bad id!`) returns the server's 400 error message in the banner.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Admin.jsx web/dist
git commit -m "feat(web): admin editor for per-agent solo build/review models"
```

---

### Task 7: PWA solo hint + service-worker bump + docs

**Files:**
- Modify: `public/js/dashboard.js` (solo hint near the agent chips)
- Modify: `public/sw.js` (bump `VERSION`)
- Modify: `CLAUDE.md` (document solo mode)

**Interfaces:**
- Consumes: nothing new (the PWA already permits zero workers).
- Produces: PWA shows a solo hint; cache refreshes; docs updated.

- [ ] **Step 1: Add a solo hint in the PWA**

In `public/js/dashboard.js`, at the end of `renderRalphAgents()` (after the `ralphWorkersEl.replaceChildren(...)` call, before the closing `}` at line 918), add:

```js
  const soloNote = document.getElementById('ralph-solo-note');
  if (soloNote) {
    const workers = [...ralphWorkerSet].filter((w) => w !== ralphMaster);
    soloNote.hidden = workers.length !== 0;
    soloNote.textContent = `Solo mode — ${ralphMaster} builds every story and reviews its own work (no separate workers).`;
  }
```

- [ ] **Step 2: Add the hint element to the dialog markup**

In `public/index.html`, find the Ralph start dialog's worker-chips container (the element whose id is `ralph-workers`) and add, immediately after that element's closing tag:

```html
<p id="ralph-solo-note" class="muted" hidden></p>
```

(If the exact location is unclear, search `index.html` for `id="ralph-workers"` and place the `<p>` as its next sibling.)

- [ ] **Step 3: Bump the service-worker version**

In `public/sw.js` line 4, change:
```js
const VERSION = 'webtmux-v28';
```
to:
```js
const VERSION = 'webtmux-v29';
```

- [ ] **Step 4: Syntax-check the PWA JS**

Run: `node --check public/js/dashboard.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Document solo mode in CLAUDE.md**

In `CLAUDE.md`, under the "### Agents" section (after the paragraph ending "…reassigns an agent (a story mid-build, or master when idle) and retries."), add:

```markdown

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
```

- [ ] **Step 6: Commit**

```bash
git add public/js/dashboard.js public/index.html public/sw.js CLAUDE.md
git commit -m "feat(pwa): solo-mode hint + sw v29; docs(CLAUDE): solo mode"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §4.1 config store + defaults + precedence + validation | Task 1 (logic) + Task 2 (file/env/state) |
| §4.2 injection + coding-plan/glm guard | Task 1 (`soloModelFlag`) + Task 4 (wiring, `agentHasCodingPlan`, `isSolo`) |
| §4.3 scripts `--model` | Task 3 |
| §4.4 admin API (GET/PUT) | Task 2 (note: GET moved to `/api/ralph/solo-models` read-only; PUT stays admin — see §8.1 resolution below) |
| §4.5 admin UI editor | Task 6 |
| §4.6 new-build unblock + banner | Task 5 |
| §4.7 PWA parity + sw bump | Task 7 |
| §6 error handling (bad id → stall reaper; coding-plan; backward compat) | Task 1 validation + Task 4 guard; unchanged-when-unset verified in Task 3/4 |
| §7 security (charset, argv) | Task 1 `validModelId` + Task 3 flag |
| §9 testing (stub harness, unit, config API) | Task 1 unit, Task 3 stub-arg, Task 4 stub integration, Task 6 manual |
| §10 file-by-file | All tasks; `CLAUDE.md` in Task 7 |

**Open-decision resolutions (spec §8):**
- §8.1 single-tenant admin surface → **GET made read-only at `/api/ralph/solo-models`** (any caller) so the new-build banner is accurate even for non-admins; **PUT stays `/api/admin/solo-models`** (admin-gated). Single-tenant write path remains the env override / direct file edit. (Refinement on the spec; functionally within scope.)
- §8.2 finalize model → **review/top model** (Task 4 Step 5 uses `role: 'review'`).
- §8.3 banner shows resolved ids → **yes**, via the read endpoint (Task 5 Step 4).

**2. Placeholder scan:** No "TBD/TODO/handle edge cases/similar to Task N". Every code step shows complete code. The only soft locator is Task 7 Step 2 ("search index.html for `id="ralph-workers"`") — acceptable because the dialog markup wasn't quoted in this plan; the search target is exact.

**3. Type consistency:** `soloModelFlag({ solo, agent, role, codingPlan, models })` signature identical in Task 1 (def + tests) and Task 4 (calls). `effectiveModels(fileMap, envMap)` / `sanitizeModels(input)` / `soloModelsEffective()` names consistent across Tasks 1–2–4. API method names `soloModels`/`setSoloModels` consistent across Tasks 5–6. Endpoint paths consistent: read `GET /api/ralph/solo-models`, write `PUT /api/admin/solo-models`.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-ralph-solo-mode.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
