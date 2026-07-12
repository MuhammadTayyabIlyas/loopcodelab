# Token-Plan Multi-Model Coding Agents (Part A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a build's `claude` agent run on any Alibaba token-plan text model (qwen / glm / kimi / deepseek / minimax) — reusing the existing `sk-sp-…` `qwenApiKey` with no re-paste — chosen per build, alongside the existing OpenRouter path.

**Architecture:** Add one `tokenplan` entry to the existing `CLAUDE_PLAN_PRESETS` (claude CLI → `ANTHROPIC_BASE_URL=…/apps/anthropic`). A new pure `ralph/providers.mjs` holds the extensible model registry + key-resolution helper (reuse the qwen key for the token plan). The `web/` Settings preset picker and per-run model field are already data-driven, so UI work is minimal (a suggestions datalist + a `public/` model select). This is the foundation Plan 2 (media generation) extends.

**Tech Stack:** Node 22 (ESM, built-in `node:test`), Express + `ws` (`server.js`), React+Vite (`web/`), vanilla-JS PWA (`public/`).

## Global Constraints

- Pure logic lives in `ralph/*.mjs` with a sibling `ralph/*.test.mjs` (Node built-in runner). `server.js` is side-effectful — do not unit-test it; extract logic into `ralph/providers.mjs` and test there.
- Model ids are shell-spliced → must pass `validModelId` (charset `[A-Za-z0-9._:/-]`, from `ralph/solo-models.mjs`). All token-plan ids used here comply (`qwen3.7-max`, `glm-5.2`, `kimi-k2.7-code`, `deepseek-v4-pro`, `MiniMax-M2.5`).
- `WEBTMUX_MULTITENANT=1` is ON — credentials resolve from the tenant vault, then `secrets.json`.
- After editing `server.js`: `node --check server.js`, then `sudo systemctl restart webtmux` (safe; `killmode.conf` protects sessions).
- After editing anything in `public/`: bump `VERSION` in `public/sw.js` (currently `webtmux-v37` → `webtmux-v38`).
- After editing `web/src`: `cd web && npm run build` (output `web/dist`, git-ignored).
- Token-plan facts (verified): Anthropic base `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` answers `POST /v1/messages` (200, Bearer) but **404s `GET /v1/models`**. Key `sk-sp-…` = `secrets.qwenApiKey`.
- `git` is a manual-checkpoint repo — the `git commit` steps are local checkpoints (no push).

---

### Task 1: Provider registry module (`ralph/providers.mjs`)

**Files:**
- Create: `ralph/providers.mjs`
- Test: `ralph/providers.test.mjs`

**Interfaces:**
- Produces:
  - `TOKEN_PLAN_TEXT_MODELS: {id,label}[]`, `TOKEN_PLAN_IMAGE_MODELS: {id,label}[]`
  - `planModelsFor(presetId: string) => {id,label}[]` (copy; `[]` for presets without a curated list)
  - `planModelsMap() => { [presetId]: {id,label}[] }`
  - `resolveClaudePlanKey(v: {preset?,key?}, opts?: {qwenKey?}) => string`
  - `tokenPlanAnthropicBase(secrets?: object, env?: object) => string` (no trailing slash)

- [ ] **Step 1: Write the failing test**

Create `ralph/providers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validModelId } from './solo-models.mjs';
import {
  TOKEN_PLAN_TEXT_MODELS, TOKEN_PLAN_IMAGE_MODELS,
  planModelsFor, planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase,
} from './providers.mjs';

test('token-plan model lists are non-empty and every id is a valid (shell-safe) model id', () => {
  assert.ok(TOKEN_PLAN_TEXT_MODELS.length >= 5);
  assert.ok(TOKEN_PLAN_IMAGE_MODELS.length >= 2);
  for (const m of [...TOKEN_PLAN_TEXT_MODELS, ...TOKEN_PLAN_IMAGE_MODELS]) {
    assert.ok(validModelId(m.id), `invalid model id: ${m.id}`);
    assert.equal(typeof m.label, 'string');
  }
  const ids = TOKEN_PLAN_TEXT_MODELS.map((m) => m.id);
  for (const want of ['qwen3.7-max', 'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'MiniMax-M2.5'])
    assert.ok(ids.includes(want), `missing ${want}`);
});

test('planModelsFor returns a curated list for tokenplan, empty for free-text presets, and a copy', () => {
  const list = planModelsFor('tokenplan');
  assert.ok(list.length >= 5);
  list.push({ id: 'x', label: 'x' });                 // mutate the copy…
  assert.notEqual(planModelsFor('tokenplan').length, list.length); // …source unaffected
  assert.deepEqual(planModelsFor('openrouter'), []);
  assert.deepEqual(planModelsFor('nope'), []);
});

test('planModelsMap exposes tokenplan and returns deep copies', () => {
  const map = planModelsMap();
  assert.ok(Array.isArray(map.tokenplan));
  map.tokenplan[0].id = 'MUT';
  assert.notEqual(planModelsMap().tokenplan[0].id, 'MUT');
});

test('resolveClaudePlanKey reuses the qwen key ONLY for a blank tokenplan key', () => {
  assert.equal(resolveClaudePlanKey({ preset: 'tokenplan', key: '' }, { qwenKey: 'sk-sp-Z' }), 'sk-sp-Z');
  assert.equal(resolveClaudePlanKey({ preset: 'tokenplan', key: 'explicit' }, { qwenKey: 'sk-sp-Z' }), 'explicit');
  assert.equal(resolveClaudePlanKey({ preset: 'zai', key: '' }, { qwenKey: 'sk-sp-Z' }), ''); // no reuse for other presets
  assert.equal(resolveClaudePlanKey({ preset: 'openrouter', key: 'k' }), 'k');
  assert.equal(resolveClaudePlanKey(null), '');
});

test('tokenPlanAnthropicBase: default host, no trailing slash, env + secrets overrides', () => {
  assert.equal(tokenPlanAnthropicBase(), 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic');
  assert.equal(tokenPlanAnthropicBase({ qwenAnthropicBaseUrl: 'https://x.example/apps/anthropic/' }, {}),
    'https://x.example/apps/anthropic');
  assert.equal(tokenPlanAnthropicBase({}, { WEBTMUX_QWEN_ANTHROPIC_BASE: 'https://env.example/apps/anthropic' }),
    'https://env.example/apps/anthropic');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test ralph/providers.test.mjs`
Expected: FAIL — `Cannot find module './providers.mjs'`.

- [ ] **Step 3: Write the module**

Create `ralph/providers.mjs`:

```js
// Extensible provider/model registry for the token-plan integration. Data-first:
// adding a provider is a registry entry, not new plumbing. Pure (no I/O) → unit-tested.
// Plan 2 (media generation) extends this with image/video/audio adapters.

// Alibaba MaaS monthly token-plan models, reachable via ONE sk-sp key over both the
// OpenAI-compatible (/compatible-mode/v1) and Anthropic (/apps/anthropic) bases.
export const TOKEN_PLAN_TEXT_MODELS = [
  { id: 'qwen3.7-max',      label: 'Qwen3.7 Max' },
  { id: 'qwen3.7-plus',     label: 'Qwen3.7 Plus' },
  { id: 'glm-5.2',          label: 'GLM-5.2' },
  { id: 'glm-5.1',          label: 'GLM-5.1' },
  { id: 'kimi-k2.7-code',   label: 'Kimi K2.7 Code' },
  { id: 'deepseek-v4-pro',  label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'MiniMax-M2.5',     label: 'MiniMax M2.5' },
];

// Image models (used by Plan 2; defined here so the registry is the single source).
export const TOKEN_PLAN_IMAGE_MODELS = [
  { id: 'qwen-image-2.0',     label: 'Qwen-Image 2.0 (fast)' },
  { id: 'qwen-image-2.0-pro', label: 'Qwen-Image 2.0 Pro' },
  { id: 'wan2.7-image',       label: 'Wan 2.7 Image (fast)' },
  { id: 'wan2.7-image-pro',   label: 'Wan 2.7 Image Pro' },
];

// coding-plan preset id -> curated New Build model list. Presets absent here
// (openrouter/custom/zai/…) keep the free-text model field (any id).
const PLAN_MODELS = { tokenplan: TOKEN_PLAN_TEXT_MODELS };

export function planModelsFor(presetId) {
  const list = PLAN_MODELS[presetId];
  return list ? list.map((m) => ({ ...m })) : [];
}

export function planModelsMap() {
  const out = {};
  for (const id of Object.keys(PLAN_MODELS)) out[id] = planModelsFor(id);
  return out;
}

// The token-plan preset REUSES the qwen credential: a stored claude-plan of
// {preset:'tokenplan'} may have a blank key; resolve it from the qwen key so the
// user never re-pastes sk-sp-…. Every other preset uses its own pasted key.
export function resolveClaudePlanKey(v, { qwenKey = '' } = {}) {
  if (v && v.preset === 'tokenplan' && !v.key) return qwenKey || '';
  return (v && v.key) || '';
}

// Default Anthropic base for the token plan (region ap-southeast-1). Overridable
// via env WEBTMUX_QWEN_ANTHROPIC_BASE or secrets.qwenAnthropicBaseUrl.
export function tokenPlanAnthropicBase(secrets = {}, env = {}) {
  return String(
    env.WEBTMUX_QWEN_ANTHROPIC_BASE || secrets.qwenAnthropicBaseUrl
    || 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
  ).replace(/\/+$/, '');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test ralph/providers.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ralph/providers.mjs ralph/providers.test.mjs
git commit -m "feat(providers): token-plan model registry + claude-plan key reuse helper"
```

---

### Task 2: Token-plan preset + key reuse in `server.js`

**Files:**
- Modify: `server.js` (import ~line 29; `CLAUDE_PLAN_PRESETS` ~1392-1403; `claudePlanOf` ~1419-1428; PUT `/api/keys/:provider` claude-plan validation ~3172-3181)

**Interfaces:**
- Consumes: `resolveClaudePlanKey`, `tokenPlanAnthropicBase` (Task 1); existing `qwenKey()` (server.js:676).
- Produces: a `tokenplan` preset the claude agent can run on; `claudePlanOf` returns a resolved `{baseUrl,key,authVar,model}` when the stored plan is `{preset:'tokenplan'}` with a blank key.

- [ ] **Step 1: Add the import**

Find (server.js:29):
```js
import { buildKeyProbe, buildPlanProbe, interpretProbe } from './ralph/key-test.mjs';
```
Add immediately after:
```js
import { planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase } from './ralph/providers.mjs';
```

- [ ] **Step 2: Add the `tokenplan` preset**

Find (server.js:1398, inside `CLAUDE_PLAN_PRESETS`):
```js
  qwencode:   { label: 'Qwen (DashScope)', baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'qwen3.6-plus' },
```
Add a line immediately after it:
```js
  tokenplan:  { label: 'Alibaba Token Plan (Qwen/GLM/Kimi/DeepSeek/MiniMax)', baseUrl: tokenPlanAnthropicBase(secrets, process.env), authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'qwen3.7-max' },
```

- [ ] **Step 3: Make `claudePlanOf` resolve the token-plan key from qwen**

Find (server.js:1419-1428):
```js
function claudePlanOf(get) {
  const raw = get('claude-plan');
  if (!raw) return null;
  let v; try { v = JSON.parse(raw); } catch { return null; }
  const p = CLAUDE_PLAN_PRESETS[v.preset] || CLAUDE_PLAN_PRESETS.custom;
  const baseUrl = String(v.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !v.key) return null;
  return { baseUrl, key: v.key, authVar: v.authVar || p.authVar, model: v.model || p.model || '' };
}
```
Replace with:
```js
function claudePlanOf(get) {
  const raw = get('claude-plan');
  if (!raw) return null;
  let v; try { v = JSON.parse(raw); } catch { return null; }
  const p = CLAUDE_PLAN_PRESETS[v.preset] || CLAUDE_PLAN_PRESETS.custom;
  const baseUrl = String(v.baseUrl || p.baseUrl || '').replace(/\/+$/, '');
  // The tokenplan preset reuses the qwen credential when its key is blank.
  const key = resolveClaudePlanKey(v, { qwenKey: get('qwen') || qwenKey() });
  if (!baseUrl || !key) return null;
  return { baseUrl, key, authVar: v.authVar || p.authVar, model: v.model || p.model || '' };
}
```

- [ ] **Step 4: Allow a blank key when storing the `tokenplan` plan**

Find (server.js:3174):
```js
      if (!p?.key) return fail(res, 400, 'Coding plan needs the provider API key.');
```
Replace with:
```js
      // tokenplan reuses the stored qwen key — a blank key is valid (resolved server-side).
      if (!p?.key && p?.preset !== 'tokenplan') return fail(res, 400, 'Coding plan needs the provider API key.');
```

- [ ] **Step 5: Syntax-check**

Run: `node --check server.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(server): tokenplan coding-plan preset reusing the qwen key"
```

---

### Task 3: Expose curated model lists on `GET /api/keys`

**Files:**
- Modify: `server.js` (the `res.json({...})` in `GET /api/keys` ~3120-3126)

**Interfaces:**
- Consumes: `planModelsMap` (Task 1).
- Produces: `GET /api/keys` now returns `planModels: { tokenplan: [{id,label},…] }` for the UI dropdowns.

- [ ] **Step 1: Add `planModels` to the response**

Find (server.js:3123):
```js
      planPresets: Object.entries(CLAUDE_PLAN_PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model })),
```
Add a line immediately after:
```js
      planModels: planModelsMap(), // curated per-preset model lists for the New Build dropdown
```

- [ ] **Step 2: Syntax-check**

Run: `node --check server.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): expose planModels on /api/keys"
```

---

### Task 4: Key-test probe for `/apps/anthropic` hosts

**Files:**
- Modify: `ralph/key-test.mjs` (`buildPlanProbe` ~40-48)
- Modify: `server.js` (the probe `fetch` in `GET /api/keys/:provider/test` ~3227)
- Test: `ralph/key-test.test.mjs`

**Interfaces:**
- `buildPlanProbe(plan)` may now return `{ url, headers, method?, body? }` — a `POST /v1/messages` ping for `/apps/anthropic` bases (which 404 `GET /v1/models`), else the existing `GET /v1/models`.

- [ ] **Step 1: Write the failing test**

Add to `ralph/key-test.test.mjs` (after the existing `buildPlanProbe` test at line ~48):

```js
test('buildPlanProbe: /apps/anthropic hosts probe via POST /v1/messages (GET /v1/models 404s there)', () => {
  const p = buildPlanProbe({ baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', key: 'sk-sp-x', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'glm-5.2' });
  assert.equal(p.url, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages');
  assert.equal(p.method, 'POST');
  assert.equal(p.headers.Authorization, 'Bearer sk-sp-x');
  const body = JSON.parse(p.body);
  assert.equal(body.model, 'glm-5.2');
  assert.ok(body.max_tokens >= 1 && Array.isArray(body.messages));
  // A normal Anthropic-compatible base still uses GET /v1/models (no method).
  const q = buildPlanProbe({ baseUrl: 'https://api.z.ai/api/anthropic', key: 'k', authVar: 'ANTHROPIC_AUTH_TOKEN' });
  assert.equal(q.url, 'https://api.z.ai/api/anthropic/v1/models');
  assert.equal(q.method, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test ralph/key-test.test.mjs`
Expected: FAIL — the token-plan probe currently returns `…/v1/models` with no `method`.

- [ ] **Step 3: Update `buildPlanProbe`**

Find (ralph/key-test.mjs:40-48):
```js
export function buildPlanProbe(plan) {
  if (!plan?.baseUrl || !plan?.key) return null;
  const base = String(plan.baseUrl).replace(/\/+$/, '');
  const headers = { 'anthropic-version': '2023-06-01' };
  // authVar mirrors how the agent CLI sends the credential to this endpoint.
  if (plan.authVar === 'ANTHROPIC_API_KEY') headers['x-api-key'] = plan.key;
  else headers.Authorization = `Bearer ${plan.key}`;
  return { url: `${base}/v1/models`, headers };
}
```
Replace with:
```js
export function buildPlanProbe(plan) {
  if (!plan?.baseUrl || !plan?.key) return null;
  const base = String(plan.baseUrl).replace(/\/+$/, '');
  const headers = { 'anthropic-version': '2023-06-01' };
  // authVar mirrors how the agent CLI sends the credential to this endpoint.
  if (plan.authVar === 'ANTHROPIC_API_KEY') headers['x-api-key'] = plan.key;
  else headers.Authorization = `Bearer ${plan.key}`;
  // Alibaba /apps/anthropic hosts (token-plan, DashScope qwencode) 404 GET /v1/models
  // ("Not support") — probe auth with a minimal messages ping instead.
  if (/\/apps\/anthropic$/.test(base)) {
    headers['Content-Type'] = 'application/json';
    return {
      url: `${base}/v1/messages`, headers, method: 'POST',
      body: JSON.stringify({ model: plan.model || 'qwen3.7-max', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    };
  }
  return { url: `${base}/v1/models`, headers };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test ralph/key-test.test.mjs`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Honor `method`/`body` in the /test route**

Find (server.js:3227):
```js
      const r = await fetch(probe.url, { headers: probe.headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
```
Replace with:
```js
      const r = await fetch(probe.url, { method: probe.method || 'GET', headers: probe.headers, body: probe.body, signal: ctrl.signal }).finally(() => clearTimeout(timer));
```

- [ ] **Step 6: Syntax-check**

Run: `node --check server.js && node --check ralph/key-test.mjs`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add ralph/key-test.mjs ralph/key-test.test.mjs server.js
git commit -m "feat(key-test): messages-ping probe for /apps/anthropic coding plans"
```

---

### Task 5: `web/` New Build — token-plan model suggestions

**Files:**
- Modify: `web/src/pages/NewBuild.jsx` (model input ~244-246; add a keys fetch)

**Interfaces:**
- Consumes: `GET /api/keys` `planModels.tokenplan` (Task 3), `api.keys()` (`web/src/api.js:25`).
- Produces: the per-run model `<input>` gains a `<datalist>` of token-plan model ids (still free-text, so OpenRouter ids keep working).

- [ ] **Step 1: Fetch planModels on mount**

In `web/src/pages/NewBuild.jsx`, add near the other `useState` declarations (after line 55, `const [assetError, setAssetError] = useState('');`):
```jsx
  const [planModels, setPlanModels] = useState([]); // token-plan model suggestions for the model field
```
Add a `useEffect` right after the state block (before the handler functions, e.g. after line 55). If `api` is not yet imported in this file, it is (used as `api.plan`/`api.start`); reuse it:
```jsx
  useEffect(() => {
    api.keys().then((d) => setPlanModels((d.planModels && d.planModels.tokenplan) || [])).catch(() => {});
  }, []);
```
If `useEffect` is not in the React import at the top of the file, add it: change `import { useState } from 'react';` to `import { useState, useEffect } from 'react';` (match the file's existing import style).

- [ ] **Step 2: Attach a datalist to the model input**

Find (web/src/pages/NewBuild.jsx:244-246):
```jsx
              <label className="label">Model for this run <span className="opacity-60">(optional)</span></label>
              <input className="input" placeholder="e.g. x-ai/grok-code-fast-1 — blank uses your connected default"
                value={model} onChange={(e) => setModel(e.target.value)} />
```
Replace with:
```jsx
              <label className="label">Model for this run <span className="opacity-60">(optional)</span></label>
              <input className="input" list="tokenplan-models" placeholder="blank uses your connected default — or pick/type a model"
                value={model} onChange={(e) => setModel(e.target.value)} />
              <datalist id="tokenplan-models">
                {planModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </datalist>
```

- [ ] **Step 3: Build the web UI**

Run: `cd web && npm run build`
Expected: Vite build succeeds, writes `web/dist` (no type/lint errors).

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/NewBuild.jsx
git commit -m "feat(web): token-plan model suggestions in New Build"
```

---

### Task 6: `public/` Ralph dialog — optional per-run model select

**Files:**
- Modify: `public/index.html` (Ralph dialog, after the output-format `<select>` ~167)
- Modify: `public/js/dashboard.js` (payload assembly ~1045)
- Modify: `public/sw.js` (VERSION ~4)

**Interfaces:**
- Produces: the Ralph dialog posts `model` in the `/api/ralph/start` body when a non-blank model is chosen. The `<select>` mirrors `TOKEN_PLAN_TEXT_MODELS` (client mirror, like `LAUNCHERS`).

- [ ] **Step 1: Add the model `<select>` to the dialog**

Find (public/index.html:167, the close of the output-format select):
```html
      </select>
```
(the one immediately after the `downloadable` option). Add right after it:
```html
      <label class="field-label" for="ralph-model">Model <small>(optional — blank uses the agent’s connected default)</small></label>
      <select id="ralph-model" class="num-input" style="width:auto">
        <option value="">Connected default</option>
        <option value="qwen3.7-max">Qwen3.7 Max (token plan)</option>
        <option value="qwen3.7-plus">Qwen3.7 Plus (token plan)</option>
        <option value="glm-5.2">GLM-5.2 (token plan)</option>
        <option value="glm-5.1">GLM-5.1 (token plan)</option>
        <option value="kimi-k2.7-code">Kimi K2.7 Code (token plan)</option>
        <option value="deepseek-v4-pro">DeepSeek V4 Pro (token plan)</option>
        <option value="deepseek-v4-flash">DeepSeek V4 Flash (token plan)</option>
        <option value="MiniMax-M2.5">MiniMax M2.5 (token plan)</option>
      </select>
```

- [ ] **Step 2: Include `model` in the start payload**

Find (public/js/dashboard.js:1035-1045). Add a read near the other field reads (after line 1041, `const outputFormat = ralphOutput.value || 'auto';`):
```js
  const model = (document.getElementById('ralph-model')?.value || '').trim();
```
Then find (line 1045):
```js
  ralphPending = { project, idea, master: ralphMaster, workers, maxAttempts, workerPasses, bypass, outputFormat };
```
Replace with:
```js
  ralphPending = { project, idea, master: ralphMaster, workers, maxAttempts, workerPasses, bypass, outputFormat, model: model || undefined };
```

- [ ] **Step 3: Bump the service-worker cache version**

Find (public/sw.js:4):
```js
const VERSION = 'webtmux-v37';
```
Replace with:
```js
const VERSION = 'webtmux-v38';
```

- [ ] **Step 4: Syntax-check**

Run: `node --check public/js/dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/dashboard.js public/sw.js
git commit -m "feat(pwa): optional per-run model select in the Ralph dialog"
```

---

### Task 7: Docs + integration verification

**Files:**
- Modify: `CLAUDE.md` (Agents / credential section)

- [ ] **Step 1: Document the preset in CLAUDE.md**

In `CLAUDE.md`, find the paragraph that begins `**qwen needs \`OPENAI_BASE_URL\`, not just the key:**` (added earlier this session, in the Agents section). Add a new sentence at its end:
```md
**Token-plan coding agents:** the `tokenplan` `CLAUDE_PLAN_PRESET` runs the claude CLI against the Alibaba
token-plan Anthropic base (`…/apps/anthropic`) so ONE `sk-sp-…` key powers qwen/glm/kimi/deepseek/minimax as
the claude agent (model picked per build). It **reuses** the stored `qwen` key — `claudePlanOf` resolves a
blank-key `{preset:'tokenplan'}` plan from `get('qwen')`/`qwenKey()`, and the `claude-plan` PUT allows a blank
key for this preset only. Its Settings **Test** uses a `POST /v1/messages` ping (these hosts 404 `GET /v1/models`).
Curated model ids live in `ralph/providers.mjs` (`TOKEN_PLAN_TEXT_MODELS`), surfaced via `/api/keys` `planModels`.
```

- [ ] **Step 2: Run the full pure-module test suite**

Run: `node --test ralph/providers.test.mjs ralph/key-test.test.mjs`
Expected: PASS (all tests, 0 fail).

- [ ] **Step 3: Restart the service**

Run: `node --check server.js && sudo systemctl restart webtmux && sleep 2 && systemctl is-active webtmux`
Expected: `active`.

- [ ] **Step 4: Verify the preset is offered and the key is reused (live)**

Run (as the admin tenant — replace the cookie/session as appropriate for the deployment; single-tenant curl shown):
```bash
# Confirm the tokenplan preset + model list are exposed
curl -s http://127.0.0.1:8090/api/keys | python3 -c "import json,sys; d=json.load(sys.stdin); print('tokenplan preset:', any(p['id']=='tokenplan' for p in d.get('planPresets',[]))); print('planModels.tokenplan count:', len((d.get('planModels') or {}).get('tokenplan',[])))"
```
Expected: `tokenplan preset: True` and a non-zero model count.

- [ ] **Step 5: Verify `ANTHROPIC_MODEL` is set from a per-run model (stub build)**

Connect the plan for the test tenant, then start a stub build selecting `glm-5.2`, and confirm the worker session env carries `ANTHROPIC_MODEL=glm-5.2`:
```bash
# 1) store a blank-key tokenplan plan (reuses qwenApiKey)
curl -s -X PUT http://127.0.0.1:8090/api/keys/claude-plan -H 'Content-Type: application/json' \
  -d '{"key":"{\"preset\":\"tokenplan\",\"key\":\"\"}"}'
# 2) start a stub build (RALPH_FORCE_TOOL=stub on the service) with master=claude, model=glm-5.2
curl -s -X POST http://127.0.0.1:8090/api/ralph/start -H 'Content-Type: application/json' \
  -d '{"project":"tp-smoke","idea":"hello world page","master":"claude","workers":[],"model":"glm-5.2","prd":{"outputFormat":"web-app","stories":[{"id":"s1","title":"home","assignee":"claude"}]}}'
# 3) inspect the worker/master tmux session env for the model
sleep 5; tmux -S /tmp/tmux-982/default list-sessions | grep -E 'tp-smoke|r-|rv-'
# capture the pane / launch line and confirm ANTHROPIC_MODEL=glm-5.2 appears in the spawned command
```
Expected: the spawned claude command includes `ANTHROPIC_MODEL='glm-5.2'` (from `tenantAgentCreds` → `claudePlanOf`). Tear down: `tmux -S /tmp/tmux-982/default kill-session -t <name>` for any `tp-smoke`/`r-`/`rv-` sessions, and `curl -s -X DELETE http://127.0.0.1:8090/api/ralph/tp-smoke`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): document the tokenplan coding-plan preset"
```

---

## Self-Review

**Spec coverage (Part A rows of the spec):**
- Preset in `CLAUDE_PLAN_PRESETS` → Task 2. ✓
- Key reuse from `qwenApiKey` (no re-paste) → Task 1 (`resolveClaudePlanKey`) + Task 2 (`claudePlanOf`, PUT validation). ✓
- Curated model list on `/api/keys` → Task 1 (`planModelsMap`) + Task 3. ✓
- `web/` connect flow → already data-driven (no code); model picker → Task 5. ✓
- `public/` per-run model → Task 6. ✓
- key-test for the preset → Task 4 (messages-ping; `GET /v1/models` 404 verified). ✓
- Docs → Task 7. ✓
- Registry foundation for Plan 2 → Task 1 (`TOKEN_PLAN_IMAGE_MODELS` defined). ✓

**Placeholder scan:** none — every code step shows exact code; every command has expected output.

**Type consistency:** `resolveClaudePlanKey(v, {qwenKey})`, `planModelsMap()`, `planModelsFor(id)`, `tokenPlanAnthropicBase(secrets,env)`, `buildPlanProbe(plan)→{url,headers,method?,body?}` used identically across tasks and their tests.

**Out of scope (→ Plan 2):** media generation (image/video/audio), the `ark`/`suno`/`elevenlabs` credentials, media caps/toggles, `ralph/media-gen.mjs` + helpers, the media skill. `TOKEN_PLAN_IMAGE_MODELS` is defined here but unused until Plan 2.
