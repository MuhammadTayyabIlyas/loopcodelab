# Story-Level Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-03-story-editing-design.md` — edit/regenerate merged stories (rebuild-on-top), hand-written story adds, and per-story start timers, with the spec's §5 UX copy verbatim.

**Architecture:** New pure helper module `ralph/story-ops.mjs` (unit-tested) feeds two routes in `server/routes/ralph.mjs` (extended `story-edit`, new `story-add`) that reuse the Revise lifecycle (`revision: true`, phase → `building`, auto re-finalize). Scheduling is a two-line gate in the existing 4s tick — no new timers. UI: `web/` BuildDetail gets the dialogs/buttons/chips; the PWA gets display-only labels.

**Tech Stack:** Node 20 ESM (`node --test` for the pure module), Express routes, React 18 + Tailwind (`web/`, Vite build), vanilla ES modules (`public/`).

## Global Constraints

- **UX copy is spec, not suggestion:** every user-facing string comes verbatim from spec §5 (`docs/superpowers/specs/2026-07-03-story-editing-design.md`). Consistent verbs: "Regenerate" everywhere; the chip action is "▶ Start now", never "cancel".
- **Invariants (spec §6):** only the orchestrator writes `prd.json` (on `main`, committed); no planner/LLM call in any of these paths; `maxAttempts`/`workerPasses` untouched; `reverted` stays uneditable.
- Schedule clamp: `[now + 15s, now + 30d]` (mirrors `ralph/drafts.mjs` `MIN/MAX_START_DELAY_MS`); invalid `startAt` → `null` (= start immediately).
- `revision: true` on: regenerated merged stories (always) and manual adds **iff `run.phase` was `done`/`failed`/`push_failed` at add time**.
- Work in a git worktree (superpowers:using-git-worktrees) — `public/` is served from disk live. Symlink deps: `ln -s /var/www/tmux.tayyabcheema.com/node_modules <wt>/node_modules && ln -s /var/www/tmux.tayyabcheema.com/web/node_modules <wt>/web/node_modules`.
- After `public/` changes: bump `public/sw.js` VERSION → `webtmux-v44` (once, in the PWA task). After `web/src` changes: `cd web && npm run build`.
- **Deploy requires a service restart this time** (server code changes) — Task 8 only; check for in-flight runs first (`grep -l '"phase": *"\(building\|reviewing\|finalizing\|delivering\|windows-delivering\|researching\)"' /home/tmuxweb/.webtmux/ralph/*.json`).
- **Standard VERIFY** (after every server-touching task):

```bash
node --check server.js server/*.mjs server/routes/*.mjs && node --test ralph/*.test.mjs 2>&1 | grep -E "^# (pass|fail)"
SCRATCH=$(mktemp -d); WEBTMUX_PORT=0 WEBTMUX_DATA=$SCRATCH/data WEBTMUX_PROJECTS_ROOT=$SCRATCH/projects \
  RALPH_FORCE_TOOL=stub timeout 4 node server.js >$SCRATCH/o 2>&1; ec=$?; grep -q listening $SCRATCH/o && [ $ec -eq 124 ] && echo BOOT-OK; rm -rf $SCRATCH
```
- Isolated e2e harness (Tasks 5/7): start with `WEBTMUX_PORT=18093 WEBTMUX_DATA=$SCRATCH/data WEBTMUX_PROJECTS_ROOT=$SCRATCH/projects RALPH_FORCE_TOOL=stub RALPH_FAKE_REMOTE=$SCRATCH/remote.git nohup node server.js > $SCRATCH/server.log 2>&1 &` after `git init --bare -q $SCRATCH/remote.git`; export `GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local`. **Kill the server pid and confirm `ss -ltn | grep 18093` is empty when done — harness leaks are a known failure.** Headless Chromium: `/opt/ms-playwright/chromium-1228/chrome-linux64/chrome`, playwright at `/var/www/tmux.tayyabcheema.com/node_modules/playwright-core/index.mjs`, `args: ['--no-sandbox']`.
- Line numbers reference `main@0aa8ad1`; locate by quoted code, not number. Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `ralph/story-ops.mjs` — pure helpers (TDD)

**Files:**
- Create: `ralph/story-ops.mjs`
- Test: `ralph/story-ops.test.mjs`

**Interfaces (Produces):**
- `clampStoryStart(startAt, now)` → `number|null` — finite number → clamped to `[now+15_000, now+2_592_000_000]`; anything else (null/NaN/string/Infinity) → `null`.
- `normalizeNewStory(input, existingIds, validAgents)` → `{ story }` or `{ error }` — story: `{ id, title, description, acceptanceCriteria, assignee, deps, branch, status: 'todo', iterations: 0 }`; `assignee` is `input.agent` or `null` (caller defaults it to the run's master); `id` = `s<maxNumericSuffix+1>`; `branch` = `prd/<id>`.
- `editKind(status)` → `'regenerate'` (merged) | `null` (reverted) | `'edit'` (anything else).

- [ ] **Step 1: Write the failing tests** — `ralph/story-ops.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampStoryStart, normalizeNewStory, editKind, MIN_STORY_DELAY_MS, MAX_STORY_DELAY_MS } from './story-ops.mjs';

const NOW = 1_700_000_000_000;
const AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'glm', 'kimi', 'grok', 'vibe'];

test('clampStoryStart: floors to now+15s', () => {
  assert.equal(clampStoryStart(NOW + 1000, NOW), NOW + MIN_STORY_DELAY_MS);
});
test('clampStoryStart: caps at now+30d', () => {
  assert.equal(clampStoryStart(NOW + 90 * 86_400_000, NOW), NOW + MAX_STORY_DELAY_MS);
});
test('clampStoryStart: passes a sane value through', () => {
  assert.equal(clampStoryStart(NOW + 3_600_000, NOW), NOW + 3_600_000);
});
test('clampStoryStart: junk -> null (start immediately)', () => {
  for (const junk of [null, undefined, NaN, Infinity, 'tomorrow', {}]) {
    assert.equal(clampStoryStart(junk, NOW), null, String(junk));
  }
});

test('normalizeNewStory: happy path shapes a queued story', () => {
  const { story, error } = normalizeNewStory(
    { title: 'Add CSV export', description: 'Export the table as CSV', acceptanceCriteria: ['a CSV downloads'], agent: 'codex', deps: ['s1'] },
    ['s1', 's2'], AGENTS);
  assert.equal(error, undefined);
  assert.deepEqual(story, {
    id: 's3', title: 'Add CSV export', description: 'Export the table as CSV',
    acceptanceCriteria: ['a CSV downloads'], assignee: 'codex', deps: ['s1'],
    branch: 'prd/s3', status: 'todo', iterations: 0,
  });
});
test('normalizeNewStory: id survives non-contiguous ids', () => {
  const { story } = normalizeNewStory({ title: 't' }, ['s1', 's7', 'weird'], AGENTS);
  assert.equal(story.id, 's8');
});
test('normalizeNewStory: title required', () => {
  assert.match(normalizeNewStory({ title: '  ' }, [], AGENTS).error, /title/i);
});
test('normalizeNewStory: clamps lengths and list sizes', () => {
  const { story } = normalizeNewStory(
    { title: 'x'.repeat(300), description: 'y'.repeat(5000), acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `c${i}` + 'z'.repeat(600)) },
    [], AGENTS);
  assert.equal(story.title.length, 200);
  assert.equal(story.description.length, 4000);
  assert.equal(story.acceptanceCriteria.length, 20);
  assert.equal(story.acceptanceCriteria[0].length, 500);
});
test('normalizeNewStory: unknown agent rejected, missing agent -> null assignee', () => {
  assert.match(normalizeNewStory({ title: 't', agent: 'gpt9' }, [], AGENTS).error, /agent/i);
  assert.equal(normalizeNewStory({ title: 't' }, [], AGENTS).story.assignee, null);
});
test('normalizeNewStory: deps filtered to existing ids', () => {
  const { story } = normalizeNewStory({ title: 't', deps: ['s1', 'nope', 42] }, ['s1'], AGENTS);
  assert.deepEqual(story.deps, ['s1']);
});

test('editKind: merged->regenerate, reverted->null, rest->edit', () => {
  assert.equal(editKind('merged'), 'regenerate');
  assert.equal(editKind('reverted'), null);
  for (const s of ['todo', 'building', 'review', 'failed', 'blocked', 'skipped']) assert.equal(editKind(s), 'edit');
});
```

- [ ] **Step 2: Run to verify failure.** `node --test ralph/story-ops.test.mjs` — expected: FAIL (module not found).
- [ ] **Step 3: Implement** `ralph/story-ops.mjs`:

```js
// ralph/story-ops.mjs — pure logic for story-level editing: schedule clamping,
// manual-story validation, and the edit/regenerate/blocked decision per status.
// (Spec: docs/superpowers/specs/2026-07-03-story-editing-design.md)

export const MIN_STORY_DELAY_MS = 15_000;                    // floor: a beat to change your mind
export const MAX_STORY_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (mirrors draft timers)

// Epoch-ms start time for a story, clamped; anything non-finite -> null (= start now).
export function clampStoryStart(startAt, now) {
  const t = Number(startAt);
  if (!Number.isFinite(t)) return null;
  return Math.min(now + MAX_STORY_DELAY_MS, Math.max(now + MIN_STORY_DELAY_MS, t));
}

// Validate + shape a hand-written story. Caller owns run-level defaults
// (assignee -> run.master) and flags (revision), which need run state.
export function normalizeNewStory(input, existingIds, validAgents) {
  const title = String(input?.title || '').trim().slice(0, 200);
  if (!title) return { error: 'A story needs a title.' };
  const agent = String(input?.agent || '').trim();
  if (agent && !validAgents.includes(agent)) return { error: 'Invalid agent.' };
  const ids = Array.isArray(existingIds) ? existingIds : [];
  const n = Math.max(0, ...ids.map((i) => Number(/^s(\d+)$/.exec(String(i))?.[1] || 0))) + 1;
  const id = `s${n}`;
  return {
    story: {
      id,
      title,
      description: String(input?.description || '').slice(0, 4000),
      acceptanceCriteria: (Array.isArray(input?.acceptanceCriteria) ? input.acceptanceCriteria : [])
        .map((c) => String(c).slice(0, 500)).filter(Boolean).slice(0, 20),
      assignee: agent || null,
      deps: (Array.isArray(input?.deps) ? input.deps : []).filter((d) => ids.includes(d)),
      branch: `prd/${id}`,
      status: 'todo',
      iterations: 0,
    },
  };
}

// What an edit request means for a story in this status.
// merged -> rebuild-on-top regeneration; reverted -> refused (its code is gone
// from main — a "regenerate" would lie); everything else -> plain edit.
export function editKind(status) {
  if (status === 'merged') return 'regenerate';
  if (status === 'reverted') return null;
  return 'edit';
}
```

- [ ] **Step 4: Run to verify pass.** `node --test ralph/story-ops.test.mjs` — expected: all pass, 0 fail. Then the full suite: `node --test ralph/*.test.mjs` — expected: 206 + new, 0 fail.
- [ ] **Step 5: Commit** `feat(ralph): story-ops helpers — schedule clamp, manual-story shape, edit/regenerate decision`

---

### Task 2: Extend `story-edit` — regenerate merged stories + `startAt`

**Files:**
- Modify: `server/routes/ralph.mjs` (the `app.post('/api/ralph/story-edit', …)` handler, ~line 779; the `app.post('/api/ralph/skip', …)` handler ~line 740; the import block)

**Interfaces:**
- Consumes: `editKind`, `clampStoryStart` from `../../ralph/story-ops.mjs` (Task 1).
- Produces: `story-edit` accepts `{ startAt?: number|null }` and merged stories; sets `story.revision`, `story.startAt`. (Tasks 4/6 rely on those two story fields, exactly those names.)

- [ ] **Step 1: Import the helpers.** In `server/routes/ralph.mjs`'s import block add:

```js
import { editKind, clampStoryStart, normalizeNewStory } from '../../ralph/story-ops.mjs';
```
(`normalizeNewStory` is used by Task 3 — importing it now is harmless and saves a conflict.)

- [ ] **Step 2: Rewrite the guard + add the regenerate branch.** In the `story-edit` handler, replace:

```js
    if (['merged', 'reverted'].includes(st.status)) return res.status(409).json({ error: `Story is already ${st.status} — use Revise to change shipped work.` });
```
with:
```js
    const kind = editKind(st.status);
    if (!kind) return res.status(409).json({ error: 'This story was reverted — add a new story instead.' });
    if (kind === 'regenerate') {
      // Rebuild-on-top (spec §"Approach A"): only when the run isn't mid-flight.
      if (['building', 'researching', 'awaiting'].includes(run.phase)) return res.status(409).json({ error: 'A build is already in progress.' });
      if (['finalizing', 'delivering', 'windows-delivering'].includes(run.phase)) return res.status(409).json({ error: 'The build is finishing up — try again in a minute, or pause it first.' });
    }
```
Then, after the existing title/description/acceptanceCriteria/agent patching block, replace the in-flight-stop + re-queue block:
```js
    // Stop any in-flight attempt; re-queue so the next spawn uses the new text.
    if (['building', 'review'].includes(st.status)) {
```
…keep that block unchanged, and directly AFTER it (before `if (st.status !== 'todo') {`) insert:
```js
    if (kind === 'regenerate') {
      // Fresh branch off the CURRENT main — the old one still points at the
      // pre-merge tip. The merge commit itself is untouched (history preserved).
      await gitRemoveWorktree(run.dir, st.id).catch(() => {});
      await git(run.dir, ['branch', '-D', st.branch]).catch(() => {});
      st.revision = true; // diff-focused master review (the Revise machinery)
    }
```
Replace the phase-reset line:
```js
    if (run.phase === 'failed') { run.phase = 'building'; run.error = null; }
```
with:
```js
    if (['failed', 'done', 'push_failed'].includes(run.phase)) { run.phase = 'building'; run.error = null; }
```

- [ ] **Step 3: `startAt` handling.** After the agent-patching block (before the in-flight-stop block), insert:

```js
    // Optional schedule: a number is clamped to [now+15s, now+30d]; an explicit
    // null clears it (the UI's "Start now"); absent leaves it untouched.
    if ('startAt' in (req.body || {})) {
      st.startAt = req.body.startAt === null ? null : clampStoryStart(req.body.startAt, Date.now());
    }
```

- [ ] **Step 4: Event copy per spec §5.** Replace the two `recordMasterLearning`/`recordRunEvent` lines with:

```js
    recordMasterLearning(run, `${st.id} ${kind === 'regenerate' ? 'regeneration requested' : 'instructions edited'} by the user${agent ? ` (agent → ${agent})` : ''}`);
    recordRunEvent(run, kind === 'regenerate'
      ? `↻ you asked for ${st.id} to be redone — rebuilding on the current app${st.startAt ? ` (⏰ starts ${new Date(st.startAt).toLocaleString()})` : ''}`
      : `✏ you edited ${st.id}${agent ? ` and handed it to ${agent}` : ''} — rebuilding with the new instructions${st.startAt ? ` (⏰ starts ${new Date(st.startAt).toLocaleString()})` : ''}`);
```

- [ ] **Step 5: Skip clears the timer.** In the `skip` handler, next to `st.error = null;` add:

```js
    st.startAt = null; // abandoning a scheduled story cancels its timer
```

- [ ] **Step 6: VERIFY** (Global Constraints block) — expected: all pass / 0 fail (206 existing + the new story-ops tests), BOOT-OK.
- [ ] **Step 7: Commit** `feat(ralph): story-edit regenerates merged stories (rebuild-on-top) + optional startAt`

---

### Task 3: `POST /api/ralph/story-add`

**Files:**
- Modify: `server/routes/ralph.mjs` — new route registered **directly after the `story-edit` handler** (fixed path, already before `/api/ralph/:project` routes).

**Interfaces:**
- Consumes: `normalizeNewStory`, `clampStoryStart` (imported in Task 2); existing route-file imports (`loadRun`, `tenantOf`, `VALID_AGENTS`, `missingAgentCreds`, `missingKeysError`, `prdFileShape`, `gitCommitAll`, `recordPrefSignal`, `recordMasterLearning`, `recordRunEvent`, `ralphRuns`, `persistRun`, `ralphTick`, `runSummary`, `audit`, `validProject`, `fs`, `path`).
- Produces: `POST /api/ralph/story-add {project, title, description?, acceptanceCriteria?, agent?, deps?, startAt?}` → `runSummary(run)`.

- [ ] **Step 1: Add the route:**

```js
  // Hand-written story — no planner call. Queued like any other story; on a
  // finished build it's a revision (the agent changes the existing app, and the
  // master reviews the diff). Allowed mid-build too (just another todo); only
  // the finalize/deliver window is closed (those briefs are already written).
  app.post('/api/ralph/story-add', async (req, res) => {
    const project = (req.body?.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (['finalizing', 'delivering', 'windows-delivering'].includes(run.phase)) {
      return res.status(409).json({ error: 'The build is finishing up — try again in a minute, or pause it first.' });
    }
    if (['researching', 'awaiting'].includes(run.phase)) {
      return res.status(409).json({ error: 'This project has no plan yet — give it instructions first.' });
    }
    const wasFinished = ['done', 'failed', 'push_failed'].includes(run.phase);
    const { story, error } = normalizeNewStory(req.body, run.stories.map((s) => s.id), VALID_AGENTS);
    if (error) return res.status(400).json({ error });
    story.assignee = story.assignee || run.master;
    {
      const missing = await missingAgentCreds(tenantOf(req), [story.assignee]);
      if (missing.length) return res.status(400).json({ error: missingKeysError(missing) });
    }
    story.revision = wasFinished; // diff-focused review only when the app already shipped
    story.startAt = 'startAt' in (req.body || {}) && req.body.startAt !== null
      ? clampStoryStart(req.body.startAt, Date.now()) : null;
    run.stories.push(story);
    if (wasFinished) { run.phase = 'building'; run.error = null; }
    await fs.writeFile(path.join(run.dir, 'prd.json'), JSON.stringify(prdFileShape(run), null, 2)).catch(() => {});
    await gitCommitAll(run.dir, `plan: add ${story.id} (manual)`).catch(() => {});
    recordPrefSignal({ type: 'story-add', project: run.project, idea: story.title.slice(0, 240) }, run.tenant || null).catch(() => {});
    recordMasterLearning(run, `${story.id} added by hand by the user (assignee ${story.assignee})`);
    recordRunEvent(run, `＋ you added ${story.id} — ${story.startAt ? `starts at ${new Date(story.startAt).toLocaleString()} ⏰` : 'building it now'}`);
    ralphRuns.set(run.key, run);
    await persistRun(run);
    ralphTick().catch(() => {});
    audit({ ralph: run.project, story: story.id, added: true });
    res.json(runSummary(run));
  });
```

- [ ] **Step 2: VERIFY** — expected: suite green, BOOT-OK.
- [ ] **Step 3: Commit** `feat(ralph): story-add — hand-written stories, no planner round-trip`

---

### Task 4: Engine — tick schedule gate + `runSummary` fields

**Files:**
- Modify: `server/ralph-engine.mjs` — the step-3 spawn loop (~line 1267) and the `runSummary` stories projection (~line 340).

**Interfaces:**
- Consumes: `story.startAt` (Tasks 2/3). `sendPush`/`sendPushRun` already imported in this module.
- Produces: `runSummary().stories[i].startAt: number|null` and `.revision: boolean` (Tasks 6/7 render these).

- [ ] **Step 1: Gate + fire notification.** In the spawn loop, after `if (story.status !== 'todo') continue;` and the dependency checks (keep their order — a scheduled story with a failed dep should still flip to `blocked` immediately), insert the gate directly before the `buildingNow >= parallelCap` line:

```js
          if (story.startAt && story.startAt > Date.now()) continue; // ⏰ scheduled — not due yet
```
And change the spawn call block from:
```js
          try { await spawnWorker(run, story); buildingNow++; changed = true; }
```
to:
```js
          if (story.startAt) { // due now — announce the timer fired, then clear it
            story.startAt = null;
            recordRunEvent(run, `⏰ ${story.id} started on schedule`);
            sendPush({ title: `⏰ ${run.project}: story ${story.id} started`, body: 'Your scheduled rebuild is running.', tag: `ralph-${run.project}`, url: '/' }).catch(() => {});
            sendPushRun(run, { title: `${run.project}: story ${story.id} started ⏰`, body: 'Your scheduled rebuild is running.' }).catch(() => {});
          }
          try { await spawnWorker(run, story); buildingNow++; changed = true; }
```

- [ ] **Step 2: `runSummary` story fields.** In the stories projection, extend the first line:

```js
      id: s.id, title: s.title, assignee: s.assignee, status: s.status,
      startAt: s.startAt || null, revision: !!s.revision,
```

- [ ] **Step 3: VERIFY** — suite green, BOOT-OK.
- [ ] **Step 4: Commit** `feat(ralph): per-story start timer — tick gate + fire push; startAt/revision in runSummary`

---

### Task 5: Stub e2e — the three spec scenarios

**Files:** none (verification; write the script to your scratch dir, not the repo).

- [ ] **Step 1: Start the isolated harness** (Global Constraints block, port 18093) and create a finished run:

```bash
curl -s -X POST http://127.0.0.1:18093/api/ralph/start -H 'Content-Type: application/json' -d '{
 "project":"storyops","idea":"a demo app","master":"claude","workers":[],
 "prd":{"project":"storyops","description":"demo","stories":[{"id":"s1","title":"home page","description":"a page","acceptanceCriteria":["renders"],"assignee":"claude","deps":[]}]}}'
for i in $(seq 1 30); do p=$(curl -s "http://127.0.0.1:18093/api/ralph/status?project=storyops" | node -pe 'JSON.parse(require("fs").readFileSync(0)).phase'); [ "$p" = done ] && break; sleep 2; done; echo "phase=$p"   # expected: done
```

- [ ] **Step 2: Scenario 1 — manual add on a finished build:**

```bash
curl -s -X POST http://127.0.0.1:18093/api/ralph/story-add -H 'Content-Type: application/json' \
  -d '{"project":"storyops","title":"about page","description":"an about page","acceptanceCriteria":["exists"]}' | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); r.phase + " " + r.stories.length + " rev=" + r.stories[1].revision'
# expected: "building 2 rev=true"; then poll as in Step 1 → done again
```

- [ ] **Step 3: Scenario 2 — regenerate a merged story:**

```bash
curl -s -X POST http://127.0.0.1:18093/api/ralph/story-edit -H 'Content-Type: application/json' \
  -d '{"project":"storyops","story":"s1","description":"a BETTER page"}' | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); r.phase + " " + r.stories[0].status + " rev=" + r.stories[0].revision'
# expected: "building todo rev=true"; poll → done; confirm git log in $SCRATCH/projects/storyops has a NEW s1 merge and the original one intact (git -C … log --oneline | grep -c "s1" ≥ 2)
```

- [ ] **Step 4: Scenario 3 — scheduled add fires + Start-now clears:**

```bash
NOW=$(date +%s%3N)
curl -s -X POST http://127.0.0.1:18093/api/ralph/story-add -H 'Content-Type: application/json' \
  -d "{\"project\":\"storyops\",\"title\":\"footer\",\"startAt\":$((NOW+20000))}" >/dev/null
sleep 8; curl -s "http://127.0.0.1:18093/api/ralph/status?project=storyops" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); const s=r.stories.at(-1); s.status + " startAt=" + (s.startAt ? "set" : "null")'
# expected after 8s: "todo startAt=set" (the 15s floor holds it)
sleep 16; curl -s "http://127.0.0.1:18093/api/ralph/status?project=storyops" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); const s=r.stories.at(-1); s.status'
# expected: "building" (or later); poll → done. Then repeat with startAt +1h and POST story-edit {"story":"s4","startAt":null} → next poll shows it building (Start now works).
```

- [ ] **Step 5: 409 guards:** while a fresh add is `building`, `story-edit` on a merged story must return `{"error":"A build is already in progress."}`; kill the harness (confirm port clear), note results. No commit (verification only).

---

### Task 6: Web UI — BuildDetail dialogs, buttons, chips, copy

**Files:**
- Modify: `web/src/api.js` (~line 68), `web/src/pages/BuildDetail.jsx` (StoryEditDialog ~60–110; stories cards ~520–545; phase header area ~422)

**Interfaces:**
- Consumes: `startAt`/`revision` on summary stories (Task 4); `api.addStory` → route from Task 3.
- Produces: UI only.

- [ ] **Step 1: api.js** — after `editStory`:

```js
  addStory: (project, body) => req('POST', '/api/ralph/story-add', { project, ...body }),
```

- [ ] **Step 2: Schedule parsing + agents list.** In BuildDetail.jsx replace `const EDIT_AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'glm'];` with:

```js
// Same deliberate client-side mirror as the PWA's RALPH_AGENTS — the server
// re-validates against VALID_AGENTS either way.
const ALL_AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'kimi', 'grok', 'vibe', 'glm'];

// "2h" / "30m" / "1d" (relative) or "22:00" (next occurrence) -> epoch ms.
// '' -> null (start now). Unparseable -> NaN (caller shows the inline error).
function parseStartInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i.exec(s);
  if (rel) {
    const u = rel[2][0].toLowerCase();
    return Date.now() + Number(rel[1]) * (u === 'm' ? 60_000 : u === 'd' ? 86_400_000 : 3_600_000);
  }
  const abs = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (abs) {
    const d = new Date(); d.setHours(+abs[1], +abs[2], 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return NaN;
}
const fmtIn = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
```

- [ ] **Step 3: Generalize the dialog.** Rework `StoryEditDialog` into `StoryDialog({ project, story, mode, onClose, onSaved })` where `mode` ∈ `'edit' | 'regenerate' | 'add'` (`story` is `null` for add). Keep the existing field layout and add the schedule input; full component:

```jsx
const DIALOG_COPY = {
  edit: { title: (id) => `✏ Edit ${id}`, note: 'Saving stops the current attempt and rebuilds this story with the new instructions.', cta: 'Save & rebuild story' },
  regenerate: { title: (id) => `↻ Regenerate ${id}`, note: 'Rebuilds this story on top of the current app using your edited instructions, then re-checks and re-publishes the build. The previous version stays in git history — use Revert instead if you just want it gone.', cta: 'Regenerate story' },
  add: { title: () => '＋ Add story', note: 'Describe one self-contained change. It builds like any other story — on a finished build the agent changes the existing app rather than starting over.', cta: 'Add & build' },
};
function StoryDialog({ project, story, mode, defaultAgent, onClose, onSaved }) {
  const [title, setTitle] = useState(story?.title || '');
  const [description, setDescription] = useState(story?.description || '');
  const [criteria, setCriteria] = useState((story?.acceptanceCriteria || []).join('\n'));
  const [agent, setAgent] = useState(story?.assignee || defaultAgent || 'claude');
  const [startRaw, setStartRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const C = DIALOG_COPY[mode];

  async function save() {
    const startAt = parseStartInput(startRaw);
    if (Number.isNaN(startAt)) { setErr("Couldn't read that time — use 2h, 30m, 1d, or a clock time like 22:00."); return; }
    setBusy(true); setErr('');
    const body = {
      title, description,
      acceptanceCriteria: criteria.split('\n').map((c) => c.trim()).filter(Boolean),
      ...(startAt !== null ? { startAt } : {}),
    };
    try {
      if (mode === 'add') await api.addStory(project, { ...body, agent });
      else await api.editStory(project, story.id, { ...body, agent: agent !== story.assignee ? agent : undefined });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-slate-900/30 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold">{C.title(story?.id)}</h3>
        <p className="mt-1 text-xs text-muted">{C.note}{mode === 'edit' && story?.status === 'building' ? ' (it is building right now)' : ''}</p>
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
        <div className="mt-3 space-y-3">
          <div><label className="label">Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><label className="label">Instructions</label>
            <textarea className="input min-h-[110px]" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div><label className="label">Acceptance criteria (one per line)</label>
            <textarea className="input min-h-[80px] font-mono text-xs" value={criteria} onChange={(e) => setCriteria(e.target.value)} /></div>
          <div><label className="label">Agent</label>
            <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
              {ALL_AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select></div>
          <div><label className="label">Start (optional)</label>
            <input className="input" placeholder="now — or 2h, 30m, 1d, or 22:00" value={startRaw} onChange={(e) => setStartRaw(e.target.value)} />
            <p className="mt-1 text-[11px] text-muted">Runs on the server at that time — you don't need to keep this page open. Handy for off-peak hours on a subscription plan.</p></div>
        </div>
        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary flex-1" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Saving…' : C.cta}</button>
        </div>
      </div>
    </div>
  );
}
```
Update the state + render sites: `const [dialog, setDialog] = useState(null); // { mode, story } | null`, the render `{dialog && <StoryDialog project={project} story={dialog.story} mode={dialog.mode} defaultAgent={run?.master} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}`, and replace the old `setEditStory(s)` call with `setDialog({ mode: 'edit', story: s })`.

- [ ] **Step 4: Story cards — always-visible actions, Regenerate, chip, Add, hint.** In the stories map (~520): change the actions wrapper `className` from `"mt-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100"` to `"mt-2 flex flex-wrap gap-1.5"`. Keep Edit/Skip for `!settled`; add for merged rows (inside the same map, after the `!settled` block):

```jsx
                    {s.status === 'merged' && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button className="btn-ghost px-2 py-0.5 text-[11px]" title="Rebuild this story on the current app with new instructions"
                          onClick={() => setDialog({ mode: 'regenerate', story: s })}>↻ Regenerate</button>
                      </div>
                    )}
                    {s.startAt && (
                      <div className="mt-2 flex items-center gap-1.5" title={`Starts automatically at ${new Date(s.startAt).toLocaleString()}. "Start now" begins immediately; Skip abandons it.`}>
                        <span className="badge bg-panel2 text-muted">⏰ in {fmtIn(s.startAt - Date.now())}</span>
                        <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => api.editStory(project, s.id, { startAt: null }).then(load)}>▶ Start now</button>
                      </div>
                    )}
                    {s.revision && <span className="mt-1 inline-block text-[10px] text-muted">↻ revision</span>}
```
Above the list, change the heading block to add the button + finished-build hint:
```jsx
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Stories</h2>
              {!['finalizing', 'delivering', 'windows-delivering', 'researching', 'awaiting'].includes(run.phase) && (
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ mode: 'add', story: null })}>＋ Add story</button>
              )}
            </div>
            {['done', 'failed', 'push_failed'].includes(run.phase) && (
              <p className="mb-2 text-[11px] text-muted">Regenerate any story with new instructions, add a new one, or revert a merged one — the build re-checks and re-publishes itself afterwards.</p>
            )}
```

- [ ] **Step 5: Waiting-phase line.** Where the run phase renders in the header area (~line 422 block), extend the phase text: when `run.phase === 'building'` and no story is `building`/`review` and some story has a future `startAt`, append — compute `const nextAt = Math.min(...run.stories.filter((s) => s.startAt).map((s) => s.startAt));` and render `building · waiting for a scheduled story (⏰ in {fmtIn(nextAt - Date.now())})` in place of the bare phase label.

- [ ] **Step 6: Build + probe.** `cd web && npm run build` (expect `✓ built`). Against the Task-5-style harness with a finished `storyops` run: headless probe at 390×844 asserts (a) an Edit button is visible without hover on a non-settled story fixture OR (on the finished run) `↻ Regenerate` is visible on a merged row, (b) `＋ Add story` present, (c) the hint line's exact text renders, (d) after adding a story with `startAt` +1h via the API, the ⏰ chip and "▶ Start now" render, and clicking Start now flips the story to building on the next poll. Kill the harness; port clear.
- [ ] **Step 7: Commit** `feat(web): story regenerate/add/schedule UI — always-visible actions, spec §5 copy`

---

### Task 7: PWA labels + sw v44

**Files:**
- Modify: `public/js/dashboard/ralph.js` (~line 512, status-dialog story rows), `public/sw.js` (VERSION)

- [ ] **Step 1: Labels.** In the story-row `innerHTML` (the `ralphStatusStories.replaceChildren(...)` map), after the `iterations` span add:

```js
      (st.revision ? `<span class="tag">↻ revision</span>` : '') +
      (st.startAt ? `<span class="tag">⏰ in ${fmtDur(Math.max(0, st.startAt - Date.now()))}</span>` : '') +
```
(`fmtDur` already exists in this module.)

- [ ] **Step 2: Bump** `public/sw.js` → `const VERSION = 'webtmux-v44';`
- [ ] **Step 3: Check.** `node --check public/js/dashboard/ralph.js` (exit 0). Quick probe: on the harness's finished run with one scheduled story, open `/legacy`, open the build's status dialog, assert the `⏰ in` tag renders.
- [ ] **Step 4: Commit** `feat(pwa): scheduled/revision labels on story rows; sw v44`

---

### Task 8: Merge + deploy + live verification

**Files:** none (deploy).

- [ ] **Step 1:** Full check in the worktree: `node --check server.js server/*.mjs server/routes/*.mjs public/js/dashboard.js public/js/dashboard/*.js && node --test ralph/*.test.mjs 2>&1 | grep -E "^# (pass|fail)"` — expected: all pass / 0 fail (206 existing + the new story-ops tests).
- [ ] **Step 2:** Remove the two `node_modules` symlinks; from the main checkout `git merge --ff-only <branch>`; rebuild live bundle `cd /var/www/tmux.tayyabcheema.com/web && npm run build`.
- [ ] **Step 3:** **Restart required** (server code changed): confirm no in-flight runs (Global Constraints grep — the known stale `building` record from 2026-06-21 doesn't count; its tmux server is gone), then `systemctl restart webtmux && journalctl -u webtmux -n 5 --no-pager` — expect the normal listening line.
- [ ] **Step 4:** Live spot-checks: `curl -sf http://127.0.0.1:8090/healthz`; `curl -s http://127.0.0.1:8090/sw.js | grep -o webtmux-v44`; mint a temp admin session (memory: `revise-efficiency-plan` trick, revoke after) and `curl -s -X POST …/api/ralph/story-add -d '{"project":"nonexistent",…}'` → 404 JSON (route live); optional: full scenario on a real finished build only if the user asks.
- [ ] **Step 5:** Remove the worktree; update memory (`story editing shipped` note + MEMORY.md line); report.

---

## Self-Review Notes

- **Spec coverage:** §1 helpers → Task 1; §2 server (edit/regen/add/gate/runSummary/skip-clears) → Tasks 2–4; §3 web UI incl. every §5 string → Task 6 (copy embedded verbatim in `DIALOG_COPY`, hint, chip tooltip, inline error, waiting line); §4 PWA + v44 → Task 7; §5 event/push strings → Tasks 2–4; §6 invariants → constraints + guard code; Testing section → Tasks 1, 5, 6.6, 7.3.
- **Deviation from spec, intentional:** the dialog's agent list is a hardcoded 8-agent mirror (the PWA's existing pattern) rather than fetched from `/api/keys` — the server re-validates and credential-checks either way; noted in code comment.
- **Type consistency check:** `story.startAt` (epoch ms | null) and `story.revision` (bool) are the only new cross-task fields; producers (Tasks 2/3) and consumers (4/6/7) use exactly those names. `editKind`/`clampStoryStart`/`normalizeNewStory` signatures match between Task 1 tests, implementation, and Task 2/3 call sites.
- **Cleanup discipline:** every harness step ends with kill + port-clear check (18093), the failure mode observed in previous executions.
