# Build Drafts (Part C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save a planned build as a draft and reopen / edit / start it later, so the generated PRD isn't lost when they close New Build.

**Architecture:** A per-tenant drafts store mirroring the existing `prefs` pattern — a control.db table (multitenant, multi-row like `facts`) or a `drafts.json` file (single-tenant), behind `tenantOf(req)`. Pure normalization in a tested `ralph/drafts.mjs`; three `/api/ralph/drafts` routes registered before the `:project` routes; a "Save draft" button in the New Build review step + a Drafts section on the dashboard. Drafts are NOT runs — they never enter `ralphRuns`/the tick, so zero orchestrator risk.

**Tech Stack:** Node (ESM, `node:test`), Express (`server.js`), `node:sqlite` control DB (`saas/db.mjs`/`store.mjs`), React+Vite (`web/`).

## Global Constraints

- Store branch is exactly the prefs pattern: `const tenant = tenantOf(req)` → `if (tenant)` use `saasStore` (control.db) else a JSON file under `DATA_DIR`. Multitenant flag: `MULTITENANT` / `tenantOf(req)` returns null single-tenant.
- `saas/db.mjs` migrations are **append-only**: add a new function to `MIGRATIONS` (a new Migration 5) — never edit an existing one. `openDb(file)` runs pending migrations; it accepts a throwaway path for tests.
- Drafts routes MUST be registered **before** the `/api/ralph/:project` routes (like `/api/ralph/prefs` and `/api/ralph/solo-models`) so `drafts` isn't parsed as a project name.
- A draft's shape (normalized by `normalizeDraft`): `{ name, idea, master, workers, model, outputFormat, project, media, clarify, prd }`; the server adds `id`, `createdAt`, `updatedAt`. `media`/`prd` are opaque objects passed straight to `/api/ralph/start` on launch (the start route already `normalizeMedia`s + `normalizePrd`s them).
- After `server.js` edits: `node --check server.js` + `sudo systemctl restart webtmux`. After `web/src`: `cd web && npm run build` (never commit `web/dist`). New pure modules ship a `*.test.mjs`. Manual-checkpoint repo.

---

### Task 1: Draft normalizer (`ralph/drafts.mjs`)

**Files:**
- Create: `ralph/drafts.mjs`
- Test: `ralph/drafts.test.mjs`

**Interfaces:**
- Produces: `normalizeDraft(input) => {name,idea,master,workers,model,outputFormat,project,media,clarify,prd}` (clamped/sanitized; never throws); `draftListItem(d) => {id,name,outputFormat,stories,updatedAt}` (the summary the list route returns).

- [ ] **Step 1: Write the failing test** — create `ralph/drafts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDraft, draftListItem } from './drafts.mjs';

test('normalizeDraft: clamps + defaults, keeps media/prd as opaque objects', () => {
  const d = normalizeDraft({
    idea: 'a landing page', master: 'claude', workers: ['claude', 'codex', 'codex'],
    model: 'glm-5.2', outputFormat: 'web-app', project: 'my-site',
    media: { image: { enabled: true, cap: 8 } }, prd: { stories: [{ id: 's1' }] },
    clarify: [{ q: 'x', a: 'y' }],
  });
  assert.equal(d.idea, 'a landing page');
  assert.deepEqual(d.workers, ['claude', 'codex']);        // deduped, cap 8
  assert.equal(d.model, 'glm-5.2');
  assert.equal(d.name, 'my-site');                          // name falls back to project
  assert.deepEqual(d.media, { image: { enabled: true, cap: 8 } });
  assert.deepEqual(d.prd, { stories: [{ id: 's1' }] });
  assert.equal(d.clarify.length, 1);
});

test('normalizeDraft: safe on junk — arrays/nulls rejected, strings capped, no throw', () => {
  const d = normalizeDraft({ media: [1, 2], prd: 'nope', workers: 'x', name: 'n'.repeat(200) });
  assert.equal(d.media, null);
  assert.equal(d.prd, null);
  assert.deepEqual(d.workers, []);
  assert.equal(d.name.length, 80);
  assert.deepEqual(normalizeDraft(null).workers, []);       // null input -> defaults
  assert.equal(normalizeDraft(null).outputFormat, 'auto');
});

test('draftListItem: compact summary with story count', () => {
  const item = draftListItem({ id: 'd1', name: 'Site', outputFormat: 'web-app', updatedAt: 5, prd: { stories: [1, 2, 3] }, idea: 'big' });
  assert.deepEqual(item, { id: 'd1', name: 'Site', outputFormat: 'web-app', stories: 3, updatedAt: 5 });
  assert.equal(draftListItem({ id: 'd2', prd: null }).stories, 0);
});
```

- [ ] **Step 2: Run to verify fail** — `node --test ralph/drafts.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `ralph/drafts.mjs`:

```js
// Pure normalizer for a saved New Build draft (config + generated PRD). The server
// adds id/createdAt/updatedAt and persists it (per-tenant DB or a JSON file); on
// launch the draft's media/prd are handed to /api/ralph/start unchanged (which
// normalizeMedia/normalizePrd them). Pure → unit-tested.
const str = (v, n, def = '') => String(v ?? def).slice(0, n);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;

export function normalizeDraft(input) {
  const d = input || {};
  return {
    name: str(d.name || d.project || 'Untitled draft', 80),
    idea: str(d.idea, 8000),
    master: str(d.master || 'claude', 20),
    workers: Array.isArray(d.workers)
      ? [...new Set(d.workers.map((w) => str(w, 20)).filter(Boolean))].slice(0, 8) : [],
    model: str(d.model, 80),
    outputFormat: str(d.outputFormat || 'auto', 20),
    project: str(d.project, 63),
    media: obj(d.media),
    clarify: Array.isArray(d.clarify) ? d.clarify.slice(0, 8) : [],
    prd: obj(d.prd),
  };
}

export function draftListItem(d) {
  return {
    id: d.id,
    name: d.name || 'Untitled draft',
    outputFormat: d.outputFormat || 'auto',
    stories: Array.isArray(d.prd?.stories) ? d.prd.stories.length : 0,
    updatedAt: d.updatedAt || 0,
  };
}
```

- [ ] **Step 4: Run to verify pass** — `node --test ralph/drafts.test.mjs` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ralph/drafts.mjs ralph/drafts.test.mjs
git commit -m "feat(drafts): pure draft normalizer + list-item summary"
```

---

### Task 2: Control-DB drafts table + store (multitenant)

**Files:**
- Modify: `saas/db.mjs` (append Migration 5 to `MIGRATIONS`, before the closing `];`)
- Modify: `saas/store.mjs` (add `listDrafts`/`saveDraft`/`deleteDraft`)
- Test: `saas/drafts-store.test.mjs`

**Interfaces:**
- Consumes: `db`, `newId`, `now` (from `./db.mjs`). Produces: `listDrafts(workspaceId) => draft[]` (each merges the stored JSON + `id`/`updatedAt`, newest first), `saveDraft(workspaceId, id|null, obj) => id` (upsert by id), `deleteDraft(workspaceId, id)`.

- [ ] **Step 1: Write the failing test** — create `saas/drafts-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';

// The store functions read the process-wide db() singleton; to test against a
// throwaway DB we open one and exercise the same SQL the store uses.
test('drafts table: migration creates it, upsert + list + delete work', () => {
  const file = path.join(os.tmpdir(), `drafts-${process.pid}-${Math.floor(performance.now())}.db`);
  const db = openDb(file);
  // a workspace row is required by the FK
  db.prepare('INSERT INTO workspaces(id,slug,unix_user,created_at) VALUES(?,?,?,?)')
    .run('ws1', 'w', 'wt_w', 1);
  const ins = db.prepare(`INSERT INTO drafts(id,workspace_id,json,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`);
  ins.run('d1', 'ws1', JSON.stringify({ name: 'A' }), 10);
  ins.run('d1', 'ws1', JSON.stringify({ name: 'A2' }), 20); // upsert
  ins.run('d2', 'ws1', JSON.stringify({ name: 'B' }), 30);
  const rows = db.prepare('SELECT id,json,updated_at FROM drafts WHERE workspace_id=? ORDER BY updated_at DESC').all('ws1');
  assert.deepEqual(rows.map((r) => r.id), ['d2', 'd1']);           // newest first
  assert.equal(JSON.parse(rows[1].json).name, 'A2');               // upsert replaced
  db.prepare('DELETE FROM drafts WHERE workspace_id=? AND id=?').run('ws1', 'd2');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM drafts WHERE workspace_id=?').get('ws1').c, 1);
});
```

- [ ] **Step 2: Run to verify fail** — `node --test saas/drafts-store.test.mjs` → FAIL (`no such table: drafts`).

- [ ] **Step 3a: Add Migration 5** — in `saas/db.mjs`, find the closing `];` of the `MIGRATIONS` array (after the last migration function) and insert a new entry right before it:

```js
  // Migration 5: build drafts — a saved New Build (config + generated PRD) a user
  // can reopen/edit/start later. Multi-row per workspace; wiped with the workspace.
  (db) => db.exec(`
    CREATE TABLE drafts (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      json         TEXT NOT NULL,           -- normalized draft (config + prd)
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_drafts_ws ON drafts(workspace_id, updated_at);
  `),
```

- [ ] **Step 3b: Add the store functions** — in `saas/store.mjs`, after the prefs/facts block, add:

```js
// --- build drafts (per-tenant; multi-row) ------------------------------------
export function listDrafts(workspaceId) {
  return db().prepare('SELECT id,json,updated_at FROM drafts WHERE workspace_id=? ORDER BY updated_at DESC')
    .all(workspaceId)
    .map((r) => { try { return { ...JSON.parse(r.json), id: r.id, updatedAt: r.updated_at }; } catch { return null; } })
    .filter(Boolean);
}
export function saveDraft(workspaceId, id, obj) {
  const draftId = id || newId();
  db().prepare(`INSERT INTO drafts(id,workspace_id,json,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
    .run(draftId, workspaceId, JSON.stringify(obj), now());
  return draftId;
}
export const deleteDraft = (workspaceId, id) =>
  db().prepare('DELETE FROM drafts WHERE workspace_id=? AND id=?').run(workspaceId, id);
```

- [ ] **Step 4: Run to verify pass** — `node --test saas/drafts-store.test.mjs` → PASS; `node --check saas/db.mjs && node --check saas/store.mjs`.

- [ ] **Step 5: Commit**

```bash
git add saas/db.mjs saas/store.mjs saas/drafts-store.test.mjs
git commit -m "feat(drafts): control.db drafts table (migration 5) + store CRUD"
```

---

### Task 3: Server persistence + `/api/ralph/drafts` routes

**Files:**
- Modify: `server.js` (import `ralph/drafts.mjs`; add `DRAFTS_FILE` + `loadDraftsList`/`saveDraftFor`/`deleteDraftFor` near the prefs helpers; register 4 routes just before the `:project` routes)

**Interfaces:**
- Consumes: `normalizeDraft`, `draftListItem` (Task 1); `saasStore.listDrafts/saveDraft/deleteDraft` (Task 2); existing `tenantOf`, `readJson`, `writeJson`, `DATA_DIR`, `crypto`, `fail`.
- Produces: `GET /api/ralph/drafts` (list summaries), `GET /api/ralph/drafts/:id` (full draft), `POST /api/ralph/drafts` (save/upsert → `{id}`), `DELETE /api/ralph/drafts/:id`.

- [ ] **Step 1: Import the helper** — add near the other `./ralph/*.mjs` imports at the top of `server.js`:

```js
import { normalizeDraft, draftListItem } from './ralph/drafts.mjs';
```

- [ ] **Step 2: Add the persistence helpers** — near the prefs file helpers (search `const PREFS_FILE =`), add after them:

```js
// Build drafts: per-tenant DB (multi-row) in multitenant, a JSON file otherwise
// (object keyed by id). Mirrors the prefs file-vs-tenant split.
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
async function loadDraftsList(tenant) {
  if (tenant) { try { return saasStore.listDrafts(tenant.id); } catch { return []; } }
  const map = await readJson(DRAFTS_FILE, {});
  return Object.entries(map).map(([id, d]) => ({ ...d, id }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function saveDraftFor(tenant, id, draft) {
  const ts = Date.now();
  if (tenant) return saasStore.saveDraft(tenant.id, id || null, { ...draft, updatedAt: ts });
  const map = await readJson(DRAFTS_FILE, {});
  const draftId = id || crypto.randomUUID();
  map[draftId] = { ...draft, updatedAt: ts, createdAt: map[draftId]?.createdAt || ts };
  await writeJson(DRAFTS_FILE, map);
  return draftId;
}
async function deleteDraftFor(tenant, id) {
  if (tenant) { try { saasStore.deleteDraft(tenant.id, id); } catch { /* best-effort */ } return; }
  const map = await readJson(DRAFTS_FILE, {});
  delete map[id];
  await writeJson(DRAFTS_FILE, map);
}
```

- [ ] **Step 3: Register the routes** — find the comment marking the prefs/solo-models routes registered before `:project` (search `so "prefs" is never treated as a project name` / `so "solo-models" is never`). Immediately after the solo-models GET route, add:

```js
// Build drafts (before the :project routes so "drafts" isn't parsed as a project).
app.get('/api/ralph/drafts', async (req, res) => {
  res.json({ drafts: (await loadDraftsList(tenantOf(req))).map(draftListItem) });
});
app.get('/api/ralph/drafts/:id', async (req, res) => {
  const d = (await loadDraftsList(tenantOf(req))).find((x) => x.id === req.params.id);
  if (!d) return fail(res, 404, 'Draft not found.');
  res.json({ draft: d });
});
app.post('/api/ralph/drafts', async (req, res) => {
  const draft = normalizeDraft(req.body?.draft || req.body);
  const id = await saveDraftFor(tenantOf(req), (req.body?.id || '').toString() || null, draft);
  res.json({ ok: true, id });
});
app.delete('/api/ralph/drafts/:id', async (req, res) => {
  await deleteDraftFor(tenantOf(req), req.params.id);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Syntax check** — `node --check server.js` → no output.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(server): drafts persistence (file/DB) + /api/ralph/drafts routes"
```

---

### Task 4: `web/` API client fns

**Files:**
- Modify: `web/src/api.js` (add `drafts`/`draft`/`saveDraft`/`deleteDraft` near `soloModels`)

- [ ] **Step 1: Add the client functions** — after the `mediaCaps`/`setMediaCaps` lines in `web/src/api.js`:

```js
  drafts: () => req('GET', '/api/ralph/drafts'),
  draft: (id) => req('GET', `/api/ralph/drafts/${encodeURIComponent(id)}`),
  saveDraft: (body) => req('POST', '/api/ralph/drafts', body),
  deleteDraft: (id) => req('DELETE', `/api/ralph/drafts/${encodeURIComponent(id)}`),
```

- [ ] **Step 2: Build** — `cd web && npm run build` (must succeed).

- [ ] **Step 3: Commit**

```bash
git add web/src/api.js
git commit -m "feat(web): drafts api client"
```

---

### Task 5: New Build — Save draft + reopen

**Files:**
- Modify: `web/src/pages/NewBuild.jsx` (a `draftId` state; a `saveDraft` handler; a "💾 Save draft" button in the step-3 button row `:386`; a mount effect that loads a `?draft=<id>` into state)

**Interfaces:**
- Consumes: `api.saveDraft`/`api.draft` (Task 4). Reuses existing state `idea/master/workers/model/outputFormat/media/plan/picks/project`.

- [ ] **Step 1: Track the draft id + a save handler.** In `web/src/pages/NewBuild.jsx`, add near the other `useState`s (after `planModels`):

```jsx
  const [draftId, setDraftId] = useState(null); // set when this build was reopened from / saved as a draft
```
Add a handler next to `doStart`:
```jsx
  async function saveDraft() {
    setErr('');
    try {
      const clarify = questions.map((q, i) => ({ q: q.q, a: picks[i] })).filter((c) => c.a);
      const { id } = await api.saveDraft({
        id: draftId || undefined,
        draft: { name: (slug || idea.trim().slice(0, 40) || 'Untitled draft'), idea: idea.trim(), master, workers, model: model.trim(), outputFormat, project: slug, media, clarify, prd: plan?.prd },
      });
      setDraftId(id);
      setErr('Saved as draft ✓'); // reuse the message area as a lightweight toast
    } catch (e) { setErr(e.message); }
  }
```

- [ ] **Step 2: Add the button** — in the step-3 button row (currently `← Edit` + `🚀 Start build`), change:

```jsx
          <div className="flex gap-3">
            <button className="btn-ghost" onClick={() => setStep(1)} disabled={busy}>← Edit</button>
            <button className="btn-primary flex-1 py-3" onClick={doStart} disabled={busy}>{busy ? 'Starting…' : '🚀 Start build'}</button>
          </div>
```
to:
```jsx
          <div className="flex gap-3">
            <button className="btn-ghost" onClick={() => setStep(1)} disabled={busy}>← Edit</button>
            <button className="btn-ghost" onClick={saveDraft} disabled={busy}>💾 Save draft</button>
            <button className="btn-primary flex-1 py-3" onClick={doStart} disabled={busy}>{busy ? 'Starting…' : '🚀 Start build'}</button>
          </div>
```

- [ ] **Step 3: Reopen a draft on mount** — add a `useEffect` (after the existing key/mediaCaps-loading effect) that reads `?draft=<id>` from the hash query and hydrates state:

```jsx
  useEffect(() => {
    const q = window.location.hash.split('?')[1] || '';
    const id = new URLSearchParams(q).get('draft');
    if (!id) return;
    api.draft(id).then(({ draft: d }) => {
      if (!d) return;
      setDraftId(d.id);
      setIdea(d.idea || ''); setMaster(d.master || 'claude'); setWorkers(d.workers || []);
      setModel(d.model || ''); setOutputFormat(d.outputFormat || 'auto'); setProject(d.project || '');
      if (d.media) setMedia(d.media);
      if (d.prd) { setPlan({ prd: d.prd }); setStep(3); }
    }).catch(() => {});
  }, []);
```

- [ ] **Step 4: Build** — `cd web && npm run build`.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/NewBuild.jsx
git commit -m "feat(web): save + reopen build drafts in New Build"
```

---

### Task 6: Dashboard — Drafts section

**Files:**
- Modify: `web/src/pages/Dashboard.jsx` (fetch drafts; a "Drafts" section above the builds list; reopen → `go('/new?draft=<id>')`; delete)

**Interfaces:**
- Consumes: `api.drafts`/`api.deleteDraft` (Task 4), `go` (from `../App.jsx`, already imported).

- [ ] **Step 1: Fetch drafts.** In `web/src/pages/Dashboard.jsx`, add state + load next to `builds`:

```jsx
  const [drafts, setDrafts] = useState([]);
```
Extend the existing `load` to also fetch drafts (it currently sets `builds`):
```jsx
  const load = () => {
    api.builds().then((d) => setBuilds(d.runs || [])).catch(() => {});
    api.drafts().then((d) => setDrafts(d.drafts || [])).catch(() => {});
  };
```
Add a delete handler near the other handlers:
```jsx
  const removeDraft = (id) => api.deleteDraft(id).then(load).catch(() => {});
```

- [ ] **Step 2: Render the Drafts section** — immediately BEFORE the `{/* Builds list */}` section, add:

```jsx
      {drafts.length > 0 && (
        <section className="mx-auto max-w-6xl px-6 pb-4">
          <h3 className="mb-4 text-sm font-semibold text-muted uppercase tracking-wide">
            Drafts <span className="ml-1 text-slate-500">({drafts.length})</span>
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((d) => (
              <div key={d.id} className="card flex items-center justify-between gap-3 py-4">
                <button className="min-w-0 text-left" onClick={() => go(`/new?draft=${encodeURIComponent(d.id)}`)}>
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="mt-1 text-xs text-muted">{d.outputFormat} · {d.stories} stor{d.stories === 1 ? 'y' : 'ies'}</p>
                </button>
                <button className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => removeDraft(d.id)} title="Delete draft">✕</button>
              </div>
            ))}
          </div>
        </section>
      )}
```

- [ ] **Step 3: Build** — `cd web && npm run build`.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Dashboard.jsx
git commit -m "feat(web): drafts section on the dashboard (reopen + delete)"
```

---

### Task 7: Docs + integration verification

**Files:**
- Modify: `CLAUDE.md` (one note in the Ralph section)

- [ ] **Step 1: Full suite** — `cd /var/www/tmux.tayyabcheema.com && node --test ralph/*.test.mjs saas/*.test.mjs 2>&1 | tail -3` → `# fail 0`.

- [ ] **Step 2: Restart + live check** (as controller after merge):
```bash
node --check server.js && sudo systemctl restart webtmux && sleep 2 && systemctl is-active webtmux
# unauth 401 in multitenant = route registered
curl -s -o /dev/null -w "GET /api/ralph/drafts -> HTTP %{http_code}\n" http://127.0.0.1:8090/api/ralph/drafts
```
Expected: `active`, and `401` (multitenant gate) — confirms the route exists.

- [ ] **Step 3: Document.** In `CLAUDE.md`, add a sentence to the learned-preferences / routes area (near the `GET/PUT/DELETE /api/ralph/prefs` note):
```md
**Build drafts.** A saved New Build (config + generated PRD) a user can reopen/edit/start later — per-tenant
like prefs (control.db `drafts` table multitenant / `~/.webtmux/drafts.json` single-tenant; `ralph/drafts.mjs`
`normalizeDraft`). `GET/POST/DELETE /api/ralph/drafts` (registered before the `:project` routes). Drafts are
NOT runs — they never enter `ralphRuns`/the tick; "Start" posts the draft to `/api/ralph/start`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): document build drafts"
```

---

## Self-Review
- **Spec coverage (Part C):** per-tenant store (DB + file) → Tasks 2–3. Captures idea/master/workers/model/outputFormat/media/clarify/prd → Task 1 `normalizeDraft` + Task 5 save payload. Routes GET/POST/DELETE → Task 3. Save-draft button + reopen → Task 5. Drafts list/reopen/delete → Task 6. Start reuses `/api/ralph/start` → Task 5 (unchanged). Not-a-run → the store never touches `ralphRuns`. ✓
- **Placeholder scan:** none — full code for the module, store, routes, and both UI edits.
- **Type consistency:** the draft shape from `normalizeDraft` (Task 1) is what `saveDraftFor` persists (Task 3) and what Task 5's payload sends and Task 5's reopen reads; `draftListItem` (Task 1) is the list shape Task 6 renders (`name`/`outputFormat`/`stories`/`id`). `saveDraft(workspaceId,id,obj)` signature matches between Task 2 (store) and Task 3 (caller).
- **Read-first note:** Task 3 Step 3's exact insertion point is "after the solo-models GET route" — confirm that anchor (search `/api/ralph/solo-models`) before editing; Task 2 Step 3a appends after the LAST `MIGRATIONS` entry — confirm it becomes Migration index 5 (`user_version` 5).
