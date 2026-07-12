# Brand & Visual Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ralph ask brand/business discovery questions for content-heavy builds, let users upload brand assets that get committed into the project, and tell workers to use those assets or source free stock images.

**Architecture:** Three additions on top of the existing clarify→plan→start flow. (1) A pure `clarify-axes.mjs` helper drives a format-aware clarify prompt. (2) A pure `assets.mjs` helper + a raw-upload route stages files under a token that is committed into `assets/brand/` at `/start`. (3) A vendored `imagery` skill is injected into worker briefs for visual builds. Spec: `docs/superpowers/specs/2026-06-22-brand-visual-inputs-design.md`.

**Tech Stack:** Node ESM, Express + `ws`, `node --test` for pure helpers, the `public/` vanilla-JS PWA and the `web/` React+Vite SaaS UI.

## Global Constraints

- **Testing convention (from CLAUDE.md):** ONLY pure helper modules are unit-tested, via `node --test ralph/*.test.mjs`. `server.js` binds the port on import and is NOT unit-tested — verify server changes with `node --check server.js` plus targeted manual/`curl` checks and the no-spend stub harness. Put testable logic in `ralph/*.mjs`.
- **Syntax-check before any restart:** `node --check server.js`, `node --check public/js/dashboard.js`.
- **After editing anything in `public/`:** bump `VERSION` in `public/sw.js` (e.g. `webtmux-vN` → `webtmux-v(N+1)`).
- **After editing `web/src`:** `cd web && npm run build` (output `web/dist` is git-ignored — never commit it).
- **Restarting the service:** `systemctl restart webtmux` then check `journalctl -u webtmux -f`. Safe for live sessions.
- **Never commit secrets** or `web/dist`. `git` here is a manual checkpoint repo — commit at the end of each task.
- **`OUTPUT_FORMATS`** (verbatim): `['auto', 'web-app', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable']`.
- **Asset limits** (verbatim): allowed extensions `png jpg jpeg webp gif svg pdf`; ≤ 10 MB per file; ≤ 12 files per build; staging TTL 6 h.
- **`crypto`** is already imported at `server.js:13` (`import crypto from 'node:crypto'`). `fs` is the promises API (`fs.mkdir`, `fs.readFile`, `fs.writeFile`, `fs.rm`, `fs.copyFile`).
- Single-tenant ignores `tenant` (it is `null`); the route guard `tenantOf(req)` returns `null` there. Keep all new logic correct for `tenant === null`.

---

### Task 1: `clarify-axes.mjs` pure helper

**Files:**
- Create: `ralph/clarify-axes.mjs`
- Test: `ralph/clarify-axes.test.mjs`

**Interfaces:**
- Produces: `clarifyAxesFor(outputFormat: string) -> { axes: string[], cap: number, contentHeavy: boolean }`

- [ ] **Step 1: Write the failing test**

```js
// ralph/clarify-axes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clarifyAxesFor } from './clarify-axes.mjs';

test('web-app is content-heavy with cap 6 and brand axes', () => {
  const r = clarifyAxesFor('web-app');
  assert.equal(r.cap, 6);
  assert.equal(r.contentHeavy, true);
  assert.ok(r.axes.some((a) => /brand/i.test(a)));
  assert.ok(r.axes.some((a) => /audience/i.test(a)));
});
test('docx and slides are content-heavy', () => {
  assert.equal(clarifyAxesFor('docx').contentHeavy, true);
  assert.equal(clarifyAxesFor('google-slides').contentHeavy, true);
});
test('sheets are structured but not content-heavy, cap 4', () => {
  const r = clarifyAxesFor('xlsx');
  assert.equal(r.cap, 4);
  assert.equal(r.contentHeavy, false);
});
test('auto and unknown fall back to technical axes, cap 4', () => {
  for (const f of ['auto', 'downloadable', 'zzz', '', undefined]) {
    const r = clarifyAxesFor(f);
    assert.equal(r.cap, 4);
    assert.equal(r.contentHeavy, false);
    assert.ok(r.axes.some((a) => /stack/i.test(a)));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ralph/clarify-axes.test.mjs`
Expected: FAIL — `Cannot find module './clarify-axes.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// ralph/clarify-axes.mjs
// Pure helper: the discovery axes + question cap a clarify pass should use for a
// given output format. No I/O — unit-tested. Drives both the clarify system prompt
// and the clamp on how many questions come back (replacing a hardcoded slice).
const CONTENT_AXES = {
  'web-app': ['brand identity and color palette', 'target audience', 'type of business / industry', 'tone & voice', 'existing brand assets or social media presence', 'key pages / core features'],
  'google-doc': ['target audience', 'tone & voice', 'desired length / depth', 'required sections', 'sources / citations'],
  'docx': ['target audience', 'tone & voice', 'desired length / depth', 'required sections', 'sources / citations'],
  'pdf': ['target audience', 'tone & voice', 'desired length / depth', 'required sections', 'sources / citations'],
  'google-slides': ['target audience', 'number of slides', 'tone & voice', 'visual style'],
  'pptx': ['target audience', 'number of slides', 'tone & voice', 'visual style'],
};
const SHEET_AXES = ['data shape / structure', 'columns / fields', 'calculations', 'source data'];
const TECH_AXES = ['platform / stack', 'must-have features', 'data / persistence', 'styling', 'auth'];

export function clarifyAxesFor(outputFormat) {
  const fmt = String(outputFormat || 'auto').trim();
  if (CONTENT_AXES[fmt]) return { axes: CONTENT_AXES[fmt], cap: 6, contentHeavy: true };
  if (fmt === 'google-sheet' || fmt === 'xlsx') return { axes: SHEET_AXES, cap: 4, contentHeavy: false };
  return { axes: TECH_AXES, cap: 4, contentHeavy: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ralph/clarify-axes.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ralph/clarify-axes.mjs ralph/clarify-axes.test.mjs
git commit -m "feat(ralph): format-aware clarify-axes pure helper"
```

---

### Task 2: Make `clarifyQuestions` format-aware

**Files:**
- Modify: `server.js` — import (top, near other `ralph/*.mjs` imports), `clarifyQuestions` (`server.js:834-873`), `/api/ralph/clarify` route (`server.js:3231-3235`).

**Interfaces:**
- Consumes: `clarifyAxesFor` from Task 1.
- Produces: `clarifyQuestions(idea, outputFormat = 'auto', tenant = null)`.

- [ ] **Step 1: Add the import**

At the top of `server.js`, next to the existing `import { deadSudoSessions } from './ralph/sudo-prune.mjs';` (line 22), add:

```js
import { clarifyAxesFor } from './ralph/clarify-axes.mjs';
```

- [ ] **Step 2: Rewrite `clarifyQuestions` signature + prompt**

Replace the function header and `sys`/clamp. New signature line (was `async function clarifyQuestions(idea, tenant = null) {`):

```js
async function clarifyQuestions(idea, outputFormat = 'auto', tenant = null) {
  const profileNote = (await loadPrefs(tenant).catch(() => null))?.profileNote || '';
  const { axes, cap, contentHeavy } = clarifyAxesFor(outputFormat);
  const sys = `You are a product analyst scoping a build whose output format is "${outputFormat || 'auto'}". `
    + 'Ask SHORT, high-value clarifying questions, each with 2–4 concrete answer options the user can pick from. '
    + `Cover these discovery axes, but ONLY where the idea does not already answer them: ${axes.join('; ')}. `
    + (contentHeavy
        ? 'This is a content/brand-heavy build: ask about every axis above the idea has NOT already specified, and return at least one question unless the idea fully specifies all axes. Do NOT re-ask an axis the idea already states. '
        : 'Skip anything already obvious from the idea; if the idea is already clear enough, return {"questions":[]}. ')
    + 'Do NOT add an "other"/"something else" option yourself — the UI always provides a free-write escape hatch. '
    + 'Mark EXACTLY ONE option per question with "recommended": true: the sensible default for this idea, biased toward the user\'s learned preferences (below) when an option matches them. '
    + 'Set "multiSelect": true only when several options can sensibly be combined (e.g. "which features?"); otherwise false. '
    + 'Return ONLY JSON: {"questions":[{"q":"...","header":"<=12-char tag","multiSelect":false,"options":[{"label":"short choice","description":"one-line tradeoff","recommended":false}]}]}.';
```

(Leave the `user` line, the `try`/`callPlanner`/`extractJson` block, and the per-question mapping unchanged — EXCEPT the clamp in the next step.)

- [ ] **Step 3: Use the format cap instead of the hardcoded 4**

At `server.js:853`, change:

```js
    return parsed.questions.slice(0, 4).map((q) => {
```

to:

```js
    return parsed.questions.slice(0, cap).map((q) => {
```

- [ ] **Step 4: Pass `outputFormat` through the route**

Replace the `/api/ralph/clarify` route body (`server.js:3231-3235`) with:

```js
app.post('/api/ralph/clarify', async (req, res) => {
  const idea = (req.body?.idea || '').trim();
  const outputFormat = (req.body?.outputFormat || '').trim();
  if (!idea) return res.status(400).json({ error: 'Describe the idea/project.' });
  res.json({ questions: await clarifyQuestions(idea, outputFormat, tenantOf(req)) });
});
```

- [ ] **Step 5: Syntax-check**

Run: `node --check server.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(ralph): format-aware clarify (brand/content discovery, never-skip)"
```

---

### Task 3: `assets.mjs` pure helpers

**Files:**
- Create: `ralph/assets.mjs`
- Test: `ralph/assets.test.mjs`

**Interfaces:**
- Produces:
  - `validateAsset({ name, size }) -> { ok: true } | { ok: false, reason }`
  - `sanitizeAssetName(name) -> string`
  - `assetKind(name) -> 'logo' | 'image' | 'doc'`
  - `stagedAssetManifest(entries) -> string`
  - `staleStagedAssets(entries, now?, ttlMs?) -> string[]` (token strings)
  - `MAX_ASSETS: number` (12)

- [ ] **Step 1: Write the failing test**

```js
// ralph/assets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAsset, sanitizeAssetName, assetKind, stagedAssetManifest, staleStagedAssets, MAX_ASSETS } from './assets.mjs';

test('validateAsset accepts allowed types under the size cap', () => {
  assert.equal(validateAsset({ name: 'logo.png', size: 1000 }).ok, true);
  assert.equal(validateAsset({ name: 'brand.PDF', size: 1000 }).ok, true);
});
test('validateAsset rejects bad type, empty, and oversize', () => {
  assert.equal(validateAsset({ name: 'evil.exe', size: 10 }).ok, false);
  assert.equal(validateAsset({ name: 'noext', size: 10 }).ok, false);
  assert.equal(validateAsset({ name: 'a.png', size: 0 }).ok, false);
  assert.equal(validateAsset({ name: 'a.png', size: 11 * 1024 * 1024 }).ok, false);
});
test('sanitizeAssetName strips paths and unsafe chars', () => {
  assert.equal(sanitizeAssetName('../../etc/passwd.png'), 'passwd.png');
  assert.equal(sanitizeAssetName('my logo!.png'), 'my_logo_.png');
  assert.equal(sanitizeAssetName('...'), 'asset');
  assert.equal(sanitizeAssetName(''), 'asset');
});
test('assetKind classifies', () => {
  assert.equal(assetKind('company-logo.svg'), 'logo');
  assert.equal(assetKind('guide.pdf'), 'doc');
  assert.equal(assetKind('hero.jpg'), 'image');
});
test('stagedAssetManifest renders names, kinds, notes', () => {
  assert.equal(
    stagedAssetManifest([{ name: 'logo.png', kind: 'logo' }, { name: 'h.jpg', kind: 'image', note: 'hero' }]),
    'logo.png (logo); h.jpg (image: hero)');
});
test('staleStagedAssets returns tokens past the TTL', () => {
  const now = 1_000_000_000;
  const ttl = 6 * 60 * 60 * 1000;
  const entries = [
    { token: 'old', createdAt: now - ttl - 1 },
    { token: 'fresh', createdAt: now - 10 },
    { token: 'bad', createdAt: NaN },
  ];
  assert.deepEqual(staleStagedAssets(entries, now, ttl), ['old']);
});
test('MAX_ASSETS is 12', () => assert.equal(MAX_ASSETS, 12));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ralph/assets.test.mjs`
Expected: FAIL — `Cannot find module './assets.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// ralph/assets.mjs
// Pure helpers for staged brand-asset uploads. No I/O — unit-tested. The route layer
// does the fs writes; these decide what's allowed, safe filenames, the planner
// manifest line, and which staging dirs are stale.
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_ASSETS = 12;       // per build

export function validateAsset({ name = '', size = 0 } = {}) {
  const dot = String(name).lastIndexOf('.');
  const ext = dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : '';
  if (!name || dot < 0 || !ALLOWED_EXT.has(ext)) {
    return { ok: false, reason: `Unsupported file type (allowed: ${[...ALLOWED_EXT].join(', ')}).` };
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'Empty file.' };
  if (size > MAX_BYTES) return { ok: false, reason: 'File exceeds 10 MB.' };
  return { ok: true };
}

export function sanitizeAssetName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'asset';
}

export function assetKind(name = '') {
  const n = String(name).toLowerCase();
  if (/logo/.test(n)) return 'logo';
  return n.endsWith('.pdf') ? 'doc' : 'image';
}

export function stagedAssetManifest(entries = []) {
  return entries
    .map((e) => `${e.name} (${e.kind || assetKind(e.name)}${e.note ? `: ${e.note}` : ''})`)
    .join('; ');
}

export function staleStagedAssets(entries = [], now = Date.now(), ttlMs = 6 * 60 * 60 * 1000) {
  return entries
    .filter((e) => e && Number.isFinite(e.createdAt) && now - e.createdAt > ttlMs)
    .map((e) => e.token);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ralph/assets.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ralph/assets.mjs ralph/assets.test.mjs
git commit -m "feat(ralph): pure helpers for staged brand-asset uploads"
```

---

### Task 4: `POST /api/ralph/assets` route + staging dir + loader

**Files:**
- Modify: `server.js` — imports, a `STAGED_ASSETS_DIR` const (near `DATA_DIR`, `server.js:46`), a `loadStagedAssets` helper, and the upload route (place it directly after the `/api/ralph/clarify` route, ~`server.js:3235`).

**Interfaces:**
- Consumes: `validateAsset`, `sanitizeAssetName`, `assetKind`, `MAX_ASSETS` from Task 3; `crypto` (`server.js:13`); `tenantOf`, `express`, `fs`, `path`.
- Produces: `loadStagedAssets(token, tenant) -> Promise<{ dir, meta } | null>`; the `POST /api/ralph/assets` endpoint returning `{ assetToken, assets: [{ name, kind, size, note }] }`.

- [ ] **Step 1: Add imports + const**

Next to the Task 2 import, add:

```js
import { validateAsset, sanitizeAssetName, assetKind, stagedAssetManifest, staleStagedAssets, MAX_ASSETS } from './ralph/assets.mjs';
```

After the `DATA_DIR` definition (`server.js:46`), add:

```js
const STAGED_ASSETS_DIR = path.join(DATA_DIR, 'staged-assets'); // pre-/start brand uploads, keyed by token
```

- [ ] **Step 2: Add the `loadStagedAssets` helper**

Place above the routes (e.g. just before the `/api/ralph/clarify` route at `server.js:3231`):

```js
// Load a staged-asset token's metadata, scoped to the caller's tenant. null if the
// token is missing/expired or belongs to a different tenant.
async function loadStagedAssets(token, tenant) {
  const t = String(token || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
  if (!t) return null;
  const dir = path.join(STAGED_ASSETS_DIR, t);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (meta.tenant !== (tenant?.slug || null)) return null;
    return { dir, meta };
  } catch { return null; }
}
```

- [ ] **Step 3: Add the upload route**

Directly after the `/api/ralph/clarify` route, add:

```js
// Stage one uploaded brand asset (octet-stream body, filename in ?name) under a token.
// Repeated calls with the same ?token accumulate. Validated + sanitized here; the files
// are committed into the repo at /start (commitStagedAssets). Best-effort, optional.
app.post('/api/ralph/assets', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  const tenant = tenantOf(req);
  const rawName = (req.query?.name || '').toString();
  const note = (req.query?.note || '').toString().slice(0, 120);
  let token = (req.query?.token || '').toString().replace(/[^a-f0-9]/g, '').slice(0, 32);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const v = validateAsset({ name: rawName, size: buf.length });
  if (!v.ok) return res.status(400).json({ error: v.reason });
  try {
    if (!token) token = crypto.randomBytes(16).toString('hex');
    const dir = path.join(STAGED_ASSETS_DIR, token);
    await fs.mkdir(dir, { recursive: true });
    const metaPath = path.join(dir, 'meta.json');
    let meta = { token, tenant: tenant?.slug || null, createdAt: Date.now(), files: [] };
    try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { /* new token */ }
    if (meta.tenant !== (tenant?.slug || null)) return res.status(403).json({ error: 'Token belongs to another account.' });
    if (meta.files.length >= MAX_ASSETS) return res.status(400).json({ error: `At most ${MAX_ASSETS} assets per build.` });
    let name = sanitizeAssetName(rawName);
    const taken = new Set(meta.files.map((f) => f.name));
    if (taken.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 2; while (taken.has(`${stem}-${i}${ext}`)) i++;
      name = `${stem}-${i}${ext}`;
    }
    await fs.writeFile(path.join(dir, name), buf);
    meta.files.push({ name, kind: assetKind(name), size: buf.length, note });
    await fs.writeFile(metaPath, JSON.stringify(meta));
    res.json({ assetToken: token, assets: meta.files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 4: Syntax-check**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 5: Manual smoke (local)**

With the service running (`systemctl restart webtmux`), in single-tenant:

```bash
printf 'PNGDATA' > /tmp/t.png
curl -s -X POST --data-binary @/tmp/t.png -H 'Content-Type: application/octet-stream' \
  'http://127.0.0.1:8090/api/ralph/assets?name=logo.png&note=brand'
```

Expected: JSON like `{"assetToken":"<32hex>","assets":[{"name":"logo.png","kind":"logo","size":7,"note":"brand"}]}`. Verify `~/.webtmux/staged-assets/<token>/logo.png` and `meta.json` exist.
Also verify a bad type is rejected: `curl ... ?name=x.exe` → `400` with the unsupported-type reason.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(ralph): POST /api/ralph/assets stages brand uploads by token"
```

---

### Task 5: Prune abandoned staging dirs in `monitorTick`

**Files:**
- Modify: `server.js` — add a `pruneStagedAssets` function and call it in `monitorTick` immediately after the sudo-prune block (`server.js:2470-2471`), which runs BEFORE the no-subscribers early return at `server.js:2472`.

**Interfaces:**
- Consumes: `staleStagedAssets` (Task 3), `STAGED_ASSETS_DIR` (Task 4).

- [ ] **Step 1: Add the prune helper**

Place just above `async function monitorTick()` (`server.js:2463`):

```js
// Remove staged-asset upload dirs older than the TTL (a New Build dialog opened,
// files staged, never started). Pure helper decides which; we rm them. Best-effort.
async function pruneStagedAssets() {
  let names;
  try { names = await fs.readdir(STAGED_ASSETS_DIR); } catch { return; }
  const entries = [];
  for (const token of names) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(STAGED_ASSETS_DIR, token, 'meta.json'), 'utf8'));
      entries.push({ token, createdAt: m.createdAt });
    } catch { entries.push({ token, createdAt: 0 }); } // unreadable → treat as stale
  }
  for (const token of staleStagedAssets(entries, Date.now())) {
    await fs.rm(path.join(STAGED_ASSETS_DIR, token), { recursive: true, force: true }).catch(() => {});
  }
}
```

- [ ] **Step 2: Call it from `monitorTick`**

After `server.js:2471` (`if (dead.length) { ... reconcileSudo().catch(() => {}); }`), add:

```js
  pruneStagedAssets().catch(() => {}); // sweep abandoned upload dirs (before the no-subscribers return)
```

- [ ] **Step 3: Syntax-check**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(ralph): prune stale staged-asset dirs in monitorTick"
```

---

### Task 6: Thread the asset manifest into `/api/ralph/plan`

**Files:**
- Modify: `server.js` — `/api/ralph/plan` route (`server.js:3237-3259`).

**Interfaces:**
- Consumes: `loadStagedAssets` (Task 4), `stagedAssetManifest` (Task 3), existing `planPrd`.

- [ ] **Step 1: Read `assetToken` and build the planner context**

In the `/api/ralph/plan` route, after the line `const outputFormat = (req.body?.outputFormat || '').trim();` (`server.js:3242`), add:

```js
  const assetToken = (req.body?.assetToken || '').toString();
```

Then inside the `try` block, replace the planning line (`server.js:3250`):

```js
    const prd = await planPrd({ idea, master, workers, answers, outputFormat, tenant });
```

with:

```js
    let answersForPlan = answers;
    const staged = await loadStagedAssets(assetToken, tenant);
    if (staged && staged.meta.files.length) {
      answersForPlan = (answers ? answers + '\n\n' : '')
        + `User-provided brand assets (committed to the repo at assets/brand/): ${stagedAssetManifest(staged.meta.files)}. Use these brand assets in the build.`;
    }
    const prd = await planPrd({ idea, master, workers, answers: answersForPlan, outputFormat, tenant });
```

- [ ] **Step 2: Syntax-check**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(ralph): planner sees staged brand assets via assetToken"
```

---

### Task 7: Commit staged assets into the repo at `/start`

**Files:**
- Modify: `server.js` — `startRalphRun` signature + body (`server.js:2281`, `2302`), a `commitStagedAssets` helper, and the `/api/ralph/start` route (`server.js:3272`, `3325`).

**Interfaces:**
- Consumes: `loadStagedAssets` (Task 4), existing `gitCommitAll`.
- Produces: `commitStagedAssets(dir, assetToken, tenant) -> Promise<void>`; `startRalphRun({ ..., assetToken })`.

- [ ] **Step 1: Add the `commitStagedAssets` helper**

Place just above `async function startRalphRun(` (`server.js:2281`):

```js
// Copy a token's staged brand assets into <repo>/assets/brand/, write MANIFEST.md,
// commit, and delete the staging dir. No-op if the token is missing/empty/expired.
// fs writes are app-side; the commit is tenant-wrapped by gitCommitAll under MT.
async function commitStagedAssets(dir, assetToken, tenant) {
  const staged = await loadStagedAssets(assetToken, tenant);
  if (!staged || !staged.meta.files.length) return;
  const brandDir = path.join(dir, 'assets', 'brand');
  await fs.mkdir(brandDir, { recursive: true });
  const lines = ['# Brand assets', '', 'User-provided assets committed for this build:', ''];
  for (const f of staged.meta.files) {
    await fs.copyFile(path.join(staged.dir, f.name), path.join(brandDir, f.name)).catch(() => {});
    lines.push(`- \`assets/brand/${f.name}\` — ${f.kind}${f.note ? `: ${f.note}` : ''}`);
  }
  await fs.writeFile(path.join(brandDir, 'MANIFEST.md'), lines.join('\n') + '\n');
  await gitCommitAll(dir, 'assets: add user-provided brand assets');
  await fs.rm(staged.dir, { recursive: true, force: true }).catch(() => {});
}
```

- [ ] **Step 2: Accept `assetToken` in `startRalphRun` and call the helper**

Change the signature (`server.js:2281`) to add `assetToken = null`:

```js
async function startRalphRun({ project, idea, master, workers, maxAttempts = 3, workerPasses = 1, bypass = true, outputFormat, model = null, prd: prdInput, tenant = null, assetToken = null }) {
```

After the prd/progress commit line (`server.js:2302`, `await gitCommitAll(dir, 'plan: add prd.json and progress log');`), add:

```js
  await commitStagedAssets(dir, assetToken, tenant).catch(() => {}); // best-effort; never block the build
```

- [ ] **Step 3: Pass `assetToken` from the `/api/ralph/start` route**

In the `/api/ralph/start` route, after `const outputFormat = (req.body?.outputFormat || '').trim();` (`server.js:3272`), add:

```js
  const assetToken = (req.body?.assetToken || '').toString();
```

Then in the `startRalphRun({ ... })` call (`server.js:3325`), add `assetToken` to the argument object:

```js
    const run = await startRalphRun({ project, idea, master, workers, maxAttempts, workerPasses, bypass, outputFormat, model, prd, tenant, assetToken });
```

- [ ] **Step 4: Syntax-check**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(ralph): commit staged brand assets to assets/brand at start"
```

---

### Task 8: Imagery skill + brief wiring

**Files:**
- Create: `ralph/skills/imagery/SKILL.md`
- Modify: `server.js` — `writeRalphBrief` (`server.js:1701-1711`).

**Interfaces:**
- Consumes: `loadSkillsCatalog` auto-discovers `ralph/skills/*/SKILL.md` (no registration needed); `writeRalphBrief` already receives `outputFormat` at both call sites (`server.js:1765`, `1812`).

- [ ] **Step 1: Create the imagery skill**

```markdown
---
name: imagery
description: Use brand assets the user provided, else source free stock images, with good alt text.
---

# Imagery

When the project needs images (hero shots, product photos, icons, backgrounds), follow
this order:

1. **Use the user's brand assets first.** Check `assets/brand/` and read
   `assets/brand/MANIFEST.md`. Use the provided logo and images, and match the brand
   colors named there. Reference them by relative path so the built site/app serves them.

2. **If imagery is needed and none was provided, use FREE stock images.**
   - If `UNSPLASH_ACCESS_KEY` or `PEXELS_API_KEY` is set in the environment, fetch
     relevant, correctly-licensed images from that provider and attribute them.
   - Otherwise use keyless placeholders — `https://picsum.photos/seed/<slug>/<w>/<h>`
     for photos, or generate a simple inline SVG placeholder for logos/illustrations.
   - Always write descriptive, specific `alt` text.

3. **Never** hotlink paid or copyrighted images, and never embed credentials in URLs.
   Record the source (provider + query or URL) for each non-placeholder image in
   `DELIVERABLE.md` so provenance is auditable.

> (Future) AI image generation will plug in here as an additional source when no suitable
> stock image exists; until then, prefer a tasteful placeholder over a wrong image.
```

- [ ] **Step 2: Inject imagery into briefs for visual builds**

In `writeRalphBrief`, replace the skills loop header. Change (`server.js:1706-1707`):

```js
  const seen = new Set();
  for (const id of skills) {
```

to:

```js
  const VISUAL_OUTPUT = new Set(['web-app', 'google-slides', 'pptx']);
  const briefSkills = VISUAL_OUTPUT.has(outputFormat) ? ['imagery', ...skills] : skills;
  const seen = new Set();
  for (const id of briefSkills) {
```

- [ ] **Step 3: Verify the skill is discoverable**

Run:

```bash
node --check server.js
node -e "import('./server.js').catch(()=>{})" 2>/dev/null || true
grep -R "name: imagery" ralph/skills/imagery/SKILL.md
```

Expected: `node --check` exits 0; the `grep` prints the frontmatter line. (The catalog is read at runtime by `loadSkillsCatalog`; the file's presence under `ralph/skills/imagery/` is sufficient — `findSkillFiles` picks up any `SKILL.md`.)

- [ ] **Step 4: Commit**

```bash
git add ralph/skills/imagery/SKILL.md server.js
git commit -m "feat(ralph): imagery skill (brand assets -> free stock) injected for visual builds"
```

---

### Task 9: `public/` PWA — asset tray + format-aware clarify + assetToken

**Files:**
- Modify: `public/index.html` — the `#ralph-clarify-dlg` dialog (`public/index.html:189`).
- Modify: `public/js/dashboard.js` — clarify call (`:1022`), `doPlan` (`:1093`), clarify submit (`:1109`), start fetch (`:1210`).
- Modify: `public/sw.js` — bump `VERSION`.

**Interfaces:**
- Consumes: `POST /api/ralph/clarify {idea, outputFormat}`, `POST /api/ralph/assets`, `POST /api/ralph/plan {..., assetToken}`, `POST /api/ralph/start {..., assetToken}`.
- Produces: a module-level `ralphAssetToken` carried from clarify-submit through plan and start.

- [ ] **Step 1: Add the asset tray markup**

Read `public/index.html` around `#ralph-clarify-dlg` (`:189`). Inside the clarify `<form id="ralph-clarify-form">`, just before its action buttons, add:

```html
<div class="clarify-q" id="ralph-asset-tray">
  <div class="field-label">Brand assets (optional)</div>
  <div class="clarify-opt-desc">Logo, brand images, or a brand guide. PNG/JPG/WEBP/GIF/SVG/PDF, ≤10 MB each, up to 12.</div>
  <input type="file" id="ralph-asset-input" multiple accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,image/*,application/pdf">
  <ul id="ralph-asset-list"></ul>
  <div class="clarify-error" id="ralph-asset-error" hidden></div>
</div>
```

- [ ] **Step 2: Pass `outputFormat` to clarify**

In `public/js/dashboard.js`, change the clarify fetch body (`:1023`) from:

```js
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea }),
```

to:

```js
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea, outputFormat }),
```

- [ ] **Step 3: Add upload state + handler**

Near the other `ralph*` module vars (e.g. after `const ralphClarifyError = ...`, `:835`), add:

```js
let ralphAssetToken = null;             // set by uploads in the clarify dialog
const ralphAssetEls = () => ({
  input: document.getElementById('ralph-asset-input'),
  list: document.getElementById('ralph-asset-list'),
  error: document.getElementById('ralph-asset-error'),
});
async function uploadRalphAsset(file) {
  const qs = new URLSearchParams({ name: file.name });
  if (ralphAssetToken) qs.set('token', ralphAssetToken);
  const res = await fetch(`/api/ralph/assets?${qs.toString()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  ralphAssetToken = data.assetToken;
  return data.assets || [];
}
function renderRalphAssets(assets) {
  const { list } = ralphAssetEls();
  if (!list) return;
  list.replaceChildren(...assets.map((a) => {
    const li = document.createElement('li');
    li.textContent = `${a.name} (${a.kind})`;
    return li;
  }));
}
```

Wire the input inside `openClarify` (so it resets per dialog) — at the end of `openClarify` before `ralphClarifyDlg.showModal();` (`:1088`), add:

```js
  ralphAssetToken = null;
  const { input, list, error } = ralphAssetEls();
  if (list) list.replaceChildren();
  if (error) error.hidden = true;
  if (input) {
    input.value = '';
    input.onchange = async () => {
      error.hidden = true;
      try {
        let assets = [];
        for (const f of [...input.files]) assets = await uploadRalphAsset(f);
        renderRalphAssets(assets);
      } catch (err) { error.textContent = err.message; error.hidden = false; }
      input.value = '';
    };
  }
```

- [ ] **Step 4: Send `assetToken` to plan and start**

In `doPlan` (`:1094`), add `assetToken` to the body:

```js
    body: JSON.stringify({ idea: ralphPending.idea, master: ralphPending.master, workers: ralphPending.workers, answers: answers || '', outputFormat: ralphPending.outputFormat, assetToken: ralphAssetToken }),
```

In the start fetch (`:1210`), add `assetToken: ralphAssetToken` to the JSON body object (alongside the existing `project`, `idea`, `clarify`, etc.). Read the surrounding object literal and insert the field.

- [ ] **Step 5: Bump the service worker version**

In `public/sw.js`, increment `VERSION` (e.g. `webtmux-v33` → `webtmux-v34`).

- [ ] **Step 6: Syntax-check**

Run: `node --check public/js/dashboard.js`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/js/dashboard.js public/sw.js
git commit -m "feat(ui): brand asset tray + format-aware clarify in dashboard PWA"
```

---

### Task 10: `web/` React SaaS — mirror in NewBuild

**Files:**
- Modify: `web/src/api.js` — `clarify`, `plan` already exist (`web/src/api.js:35-36`); add `uploadAsset`.
- Modify: `web/src/pages/NewBuild.jsx` — pass `outputFormat` to clarify, add an asset tray, thread `assetToken` into plan + start.

**Interfaces:**
- Consumes: the same endpoints as Task 9.

- [ ] **Step 1: Add `uploadAsset` to the API client + outputFormat to clarify**

In `web/src/api.js`, change the `clarify` line (`:35`) to accept `outputFormat`, and add an `uploadAsset` helper:

```js
  clarify: (idea, outputFormat) => req('POST', '/api/ralph/clarify', { idea, outputFormat }),
  uploadAsset: async (file, token) => {
    const qs = new URLSearchParams({ name: file.name });
    if (token) qs.set('token', token);
    const res = await fetch(`/api/ralph/assets?${qs.toString()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data; // { assetToken, assets }
  },
```

(If `req`/the client uses a base URL or auth header, mirror it in `uploadAsset` — read the top of `web/src/api.js` for the `req` implementation and match its `credentials`/headers/base-URL handling.)

- [ ] **Step 2: Add asset state + tray to NewBuild**

In `web/src/pages/NewBuild.jsx`, add state near the other `useState` hooks (after the `outputFormat` state, `:42`):

```jsx
  const [assetToken, setAssetToken] = useState(null);
  const [assets, setAssets] = useState([]);
  const [assetError, setAssetError] = useState('');
  const onAssetPick = async (e) => {
    setAssetError('');
    try {
      let token = assetToken; let list = assets;
      for (const f of [...e.target.files]) {
        const data = await api.uploadAsset(f, token);
        token = data.assetToken; list = data.assets;
      }
      setAssetToken(token); setAssets(list);
    } catch (err) { setAssetError(err.message); }
    e.target.value = '';
  };
```

Add the tray near the output-format select (`:177`), e.g. below it:

```jsx
  <div className="mt-3">
    <label className="text-sm text-muted">Brand assets (optional)</label>
    <input type="file" multiple
      accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,image/*,application/pdf"
      onChange={onAssetPick} className="block mt-1" />
    {assets.length > 0 && (
      <ul className="text-xs text-muted mt-1">{assets.map((a) => <li key={a.name}>{a.name} ({a.kind})</li>)}</ul>
    )}
    {assetError && <div className="text-red-400 text-xs mt-1">{assetError}</div>}
  </div>
```

- [ ] **Step 3: Thread outputFormat + assetToken into clarify/plan/start**

- Where NewBuild calls `api.clarify(...)`, pass `outputFormat`: `api.clarify(idea.trim(), outputFormat)`.
- In the `api.plan({ ... })` call (`:103`), add `assetToken`.
- In the `api.start({ ... })` body (`:115`), add `assetToken`.

Read each call site and insert the field into the existing object.

- [ ] **Step 4: Build**

Run: `cd web && npm run build`
Expected: Vite build succeeds, writes `web/dist` (git-ignored).

- [ ] **Step 5: Commit**

```bash
git add web/src/api.js web/src/pages/NewBuild.jsx
git commit -m "feat(web): brand asset tray + format-aware clarify in NewBuild"
```

---

### Task 11: Docs + end-to-end stub-harness verification

**Files:**
- Modify: `CLAUDE.md` (document the asset flow + imagery skill), `README.md` (optional: Unsplash/Pexels env keys).

- [ ] **Step 1: Document in CLAUDE.md**

In the Ralph section (near "Skills, tools & deliverable format"), add a short paragraph: the New Build clarify step is format-aware (`ralph/clarify-axes.mjs`) and asks brand/content discovery for content-heavy formats; users may upload brand assets (staged via `POST /api/ralph/assets` under a token in `~/.webtmux/staged-assets/`, pruned after 6 h, committed to `<repo>/assets/brand/` + `MANIFEST.md` at `/start`); the vendored `imagery` skill tells workers to use those assets or source free stock images (`UNSPLASH_ACCESS_KEY`/`PEXELS_API_KEY`, else placeholders).

- [ ] **Step 2: Run all pure-helper tests**

Run: `node --test ralph/clarify-axes.test.mjs ralph/assets.test.mjs`
Expected: all tests PASS.

- [ ] **Step 3: End-to-end via the stub harness (no spend)**

Add a systemd drop-in `/etc/systemd/system/webtmux.service.d/stub.conf` with `RALPH_FORCE_TOOL=stub` and `RALPH_FAKE_REMOTE=/tmp/fake.git` (`git init --bare /tmp/fake.git` first), `daemon-reload`, restart. Then:

```bash
# 1) stage an asset
TOK=$(curl -s -X POST --data-binary @/tmp/t.png -H 'Content-Type: application/octet-stream' \
  'http://127.0.0.1:8090/api/ralph/assets?name=logo.png&note=brand' | python3 -c 'import sys,json;print(json.load(sys.stdin)["assetToken"])')
# 2) start a deterministic web-app run with a fixed prd + the token
curl -s -X POST 'http://127.0.0.1:8090/api/ralph/start' -H 'Content-Type: application/json' \
  -d "{\"project\":\"brandtest\",\"idea\":\"a small shop site\",\"master\":\"claude\",\"workers\":[],\"outputFormat\":\"web-app\",\"assetToken\":\"$TOK\",\"prd\":{\"stories\":[{\"id\":\"s1\",\"title\":\"home\",\"description\":\"home page\",\"acceptanceCriteria\":[\"renders\"],\"assignee\":\"claude\"}]}}"
```

Expected: in `/home/tmuxweb/projects/brandtest`, `assets/brand/logo.png` and `assets/brand/MANIFEST.md` are committed; the worker's `.ralph/skills.md` contains the imagery skill text; the staging dir `~/.webtmux/staged-assets/$TOK` is gone.

- [ ] **Step 4: Tear down the harness**

Remove `/etc/systemd/system/webtmux.service.d/stub.conf`, `daemon-reload`, restart. Kill any leftover `r-/rv-/rf-/app-` tmux sessions. Delete the `brandtest` run.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: format-aware clarify, brand assets, imagery skill"
```

---

## Self-Review

**Spec coverage:**
- Feature 1 (format-aware clarify) → Tasks 1, 2. Skip-covered + never-skip-for-content → Task 2 Step 2 prompt. Cap 6/4 → Task 1. ✓
- Feature 2 (asset upload, Approach A): pure helpers → Task 3; route + staging → Task 4; prune → Task 5; planner manifest → Task 6; commit at /start → Task 7; UIs → Tasks 9, 10. ✓
- Feature 3 (imagery skill) → Task 8. Stock-only, AI-gen deferred → SKILL.md content. ✓
- Both frontends → Tasks 9 (public) + 10 (web). ✓
- Testing (pure helpers + stub harness) → Tasks 1, 3, 11. ✓
- Error handling (optional/best-effort, expired token, prune) → Tasks 4–7 use `.catch`/no-op paths; expired token → `loadStagedAssets` returns null → silent skip. ✓

**Placeholder scan:** No TBD/TODO-as-work. The one "(Future)" line in the imagery SKILL.md is intentional product copy (AI-gen is an explicit out-of-scope follow-up), not an unfinished step.

**Type consistency:** `assetToken` (string) and `assets: [{name, kind, size, note}]` are consistent across the route (Task 4), `loadStagedAssets`/`commitStagedAssets` (Tasks 4, 7), and both UIs (Tasks 9, 10). `clarifyAxesFor` returns `{axes, cap, contentHeavy}` and is consumed exactly that way in Task 2. `staleStagedAssets` takes `[{token, createdAt}]` and returns `token[]` — matched by `pruneStagedAssets` (Task 5).

**Note on frontend tasks (9, 10):** the exact object-literal insertion points (start fetch body, NewBuild plan/start calls) require reading the surrounding code; the fields to add are specified verbatim. This is the one place the implementer reads context rather than getting a full file rewrite — appropriate given the size of those files.
