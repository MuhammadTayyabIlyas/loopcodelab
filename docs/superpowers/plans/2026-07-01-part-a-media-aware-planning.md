# Media-Aware Planning (Part A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the planner media-aware — it plans generated media into stories (per-kind counts, shown & editable in the confirm dialog before you commit spend), the counts are clamped to the build's per-kind budget across the whole PRD, and each worker is told exactly what to generate for its story.

**Architecture:** One pure, unit-tested helper (`applyMediaPlan`) does the per-story sanitize + across-PRD clamp; it is called from `normalizePrd`. `planPrd` feeds the media budget into the planner prompt and asks for an optional per-story `media` object. `writeRalphBrief` turns a story's `media` into a concrete "generate exactly N of each enabled kind" instruction for the worker. The `web/` review step renders editable per-kind counts with a running total vs the cap; the `public/` PWA shows them read-only (they round-trip through the confirm dialog, which sends the PRD as-is).

**Tech Stack:** Node (ESM, `node:test`), Express, React + Vite (`web/`), vanilla ES module (`public/`).

## Global Constraints

- **Per-kind budget is authoritative.** The build's media budget is `run.media` = `{image:{enabled,cap}, video:{enabled,cap}, audio:{enabled,cap}}` (`normalizeMedia`, `ralph/providers.mjs`). Planned per-story counts may never exceed the cap **summed across the whole PRD**, and a **disabled** kind gets **zero** everywhere. Counts are integers `0..20` (same charset/range as `clampCap`).
- **Suggest-only, reviewable.** Planned media is a default the user edits at confirm; nothing is generated at plan time. The server re-clamps on `/start` (the user may have lowered a cap after planning).
- **Part 0 already shipped** — the imagery skill + planner already carry the ONE-consistent-style-descriptor + placement + alt-text rules. Part A only decides *how many* of *which kind* per story; it does not re-specify prompt quality.
- **Backend is the source of truth** — the clamp lives in `normalizePrd`, so BOTH frontends (and the worker brief) get correct media regardless of what a client sends.
- **After editing `public/`**: bump `VERSION` in `public/sw.js`. **After editing `web/src`**: `cd web && npm run build`. `server.js` edits need `systemctl restart webtmux`; `ralph/*.mjs` + `planner.md` are read fresh per build (no restart).
- Syntax-check gates: `node --check server.js`, `node --check public/js/dashboard.js`, `node --test ralph/*.test.mjs`.
- Manual-checkpoint repo — commit only in each task's commit step.

---

### Task 1: `applyMediaPlan` — pure per-story sanitize + across-PRD clamp

**Files:**
- Modify: `ralph/providers.mjs` (append after `normalizeMedia`, the last export)
- Test: `ralph/providers.test.mjs` (append)

**Interfaces:**
- Consumes: `normalizeMedia(media)` (already in the file).
- Produces: `applyMediaPlan(stories, media) -> Story[]` — returns a NEW array; each story keeps all its fields, with `media` replaced by a clamped `{image?,video?,audio?}` of positive integer counts, or `media` **omitted** when the story has no positive counts. Deterministic: walks stories in array order, giving each story up to what remains of each kind's cap. Disabled kinds → 0. Later tasks call this from `normalizePrd`.

- [ ] **Step 1: Write the failing tests.** Append to `ralph/providers.test.mjs`:

```js
test('applyMediaPlan: coerces per-story counts, drops disabled kinds, omits empty media', () => {
  const media = { image: { enabled: true, cap: 8 }, video: { enabled: false, cap: 2 }, audio: { enabled: false, cap: 3 } };
  const out = applyMediaPlan([
    { id: 's1', media: { image: 3, video: 2, audio: '1' } }, // video disabled -> dropped; audio disabled -> dropped
    { id: 's2', media: { image: 0 } },                        // no positive -> media omitted
    { id: 's3' },                                             // no media -> stays without media
  ], media);
  assert.deepEqual(out[0].media, { image: 3 });   // enabled kind kept; disabled kinds gone
  assert.equal('media' in out[1], false);          // zero-count -> omitted
  assert.equal('media' in out[2], false);          // absent stays absent
  assert.equal(out[0].id, 's1');                   // other fields preserved
});

test('applyMediaPlan: clamps the per-kind TOTAL across the whole PRD to the cap, in order', () => {
  const media = { image: { enabled: true, cap: 4 }, video: { enabled: true, cap: 1 }, audio: { enabled: false, cap: 3 } };
  const out = applyMediaPlan([
    { id: 's1', media: { image: 3, video: 1 } },
    { id: 's2', media: { image: 3, video: 1 } }, // image budget has 1 left -> gets 1; video budget spent -> 0
    { id: 's3', media: { image: 2 } },           // image budget spent -> media omitted
  ], media);
  assert.deepEqual(out[0].media, { image: 3, video: 1 });
  assert.deepEqual(out[1].media, { image: 1 });   // clamped to remaining; video dropped (cap already used)
  assert.equal('media' in out[2], false);
});

test('applyMediaPlan: null/garbage media budget and non-array stories are safe', () => {
  assert.deepEqual(applyMediaPlan(null, { image: { enabled: true, cap: 8 } }), []);
  // null budget -> normalizeMedia defaults (image on/8, video off, audio off)
  const out = applyMediaPlan([{ id: 's1', media: { image: 2, video: 5 } }], null);
  assert.deepEqual(out[0].media, { image: 2 }); // video off by default -> dropped
  // per-count clamp to 0..20
  const big = applyMediaPlan([{ id: 's1', media: { image: 999 } }], { image: { enabled: true, cap: 20 } });
  assert.deepEqual(big[0].media, { image: 20 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/providers.test.mjs 2>&1 | tail -8`
Expected: FAIL — `applyMediaPlan is not defined` (import error) or the three new tests error.

- [ ] **Step 3: Add the `applyMediaPlan` export.** Append to `ralph/providers.mjs` (after the closing `}` of `normalizeMedia`):

```js
// The three generatable media kinds, in the fixed order the clamp walks.
const MEDIA_KINDS = ['image', 'video', 'audio'];
// Sanitize each story's planner/client-supplied `media` hint and clamp the
// per-kind TOTAL across ALL stories to the build's budget, so a plan can never
// exceed the spend the user approved. Disabled kinds are dropped everywhere.
// Deterministic: walks stories in order, giving each what's left of each cap.
// Pure — returns a new array; a story with no positive counts loses its `media`.
export function applyMediaPlan(stories, media) {
  const budget = normalizeMedia(media);
  const remaining = {};
  for (const k of MEDIA_KINDS) remaining[k] = budget[k]?.enabled ? clampCap(budget[k].cap) : 0;
  return (Array.isArray(stories) ? stories : []).map((s) => {
    const raw = (s && typeof s.media === 'object' && !Array.isArray(s.media)) ? s.media : {};
    const plan = {};
    for (const k of MEDIA_KINDS) {
      const give = Math.min(clampCap(raw[k]), remaining[k]);
      if (give > 0) { plan[k] = give; remaining[k] -= give; }
    }
    const { media: _drop, ...rest } = s || {};
    return Object.keys(plan).length ? { ...rest, media: plan } : rest;
  });
}
```

Note: `clampCap` already exists in the file (`const clampCap = (n) => Math.max(0, Math.min(20, Math.floor(Number(n))|| 0));`) and coerces to `0..20`. Reuse it — do not add a second clamp.

- [ ] **Step 4: Add the import in the test file.** In `ralph/providers.test.mjs`, add `applyMediaPlan` to the existing import from `./providers.mjs` (find the line importing `normalizeMedia`/`mediaCapDefaults` and add `applyMediaPlan,` to that list).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/providers.test.mjs 2>&1 | tail -5`
Expected: PASS — `# fail 0`.

- [ ] **Step 6: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add ralph/providers.mjs ralph/providers.test.mjs
git commit -m "feat(providers): applyMediaPlan — per-story media sanitize + across-PRD clamp"
```

---

### Task 2: Wire media into the planner + `normalizePrd` (+ both call sites)

**Files:**
- Modify: `server.js` — `planPrd` (~line 829), `normalizePrd` (~line 920), the `/api/ralph/plan` route (~line 3739), `startRalphRun` (~line 2602/2617/2618)
- Modify: `ralph/planner.md` (the story-shape example + the Skills/tools/output section)

**Interfaces:**
- Consumes: `applyMediaPlan` (Task 1), `normalizeMedia`/`mediaCapsEffective` (already imported/defined).
- Produces: `planPrd({..., media})` and `normalizePrd(prd, {..., media})` now accept an optional `media` budget; `normalizePrd` runs `applyMediaPlan` so every returned story carries a clamped `media` (or none). The planner prompt gains a media-budget block and requests an optional per-story `media` object.

- [ ] **Step 1: Import `applyMediaPlan`.** In `server.js`, find the existing import from `./ralph/providers.mjs` (line ~30):

```js
import { planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase, mediaCredentialIds, mediaCapDefaults, normalizeMedia } from './ralph/providers.mjs';
```

Add `applyMediaPlan` to it:

```js
import { planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase, mediaCredentialIds, mediaCapDefaults, normalizeMedia, applyMediaPlan } from './ralph/providers.mjs';
```

- [ ] **Step 2: Teach `normalizePrd` to clamp per-story media.** In `server.js`, change the `normalizePrd` signature (line ~920) to accept `media`:

Find:
```js
function normalizePrd(prd, { idea, master, workers, outputFormat, mcpCaps = null }) {
```
Replace with:
```js
function normalizePrd(prd, { idea, master, workers, outputFormat, mcpCaps = null, media = null }) {
```

Then, inside the `stories: prd.stories.map((s, i) => {` block, add a `media` pass-through to the returned story object. Find the tail of the returned object:
```js
        status: 'todo',
        branch: `prd/${id}`,
        iterations: 0,
        passes: false,
      };
    }),
  };
}
```
Replace with (adds `media` pass-through, then clamps the whole array):
```js
        status: 'todo',
        branch: `prd/${id}`,
        iterations: 0,
        passes: false,
        // Optional per-story media plan (image/video/audio counts); sanitized +
        // clamped to the build budget across the whole PRD by applyMediaPlan below.
        media: (s.media && typeof s.media === 'object' && !Array.isArray(s.media)) ? s.media : undefined,
      };
    }),
  };
  out.stories = applyMediaPlan(out.stories, media);
  return out;
}
```
And change the `return {` that opens that object (line ~934) to `const out = {`:

Find:
```js
  return {
    project: String(prd.project || 'project'),
    description: String(prd.description || ''),
    outputFormat: fmt,
    idea, master, workers,
    stories: prd.stories.map((s, i) => {
```
Replace with:
```js
  const out = {
    project: String(prd.project || 'project'),
    description: String(prd.description || ''),
    outputFormat: fmt,
    idea, master, workers,
    stories: prd.stories.map((s, i) => {
```

- [ ] **Step 3: Feed the media budget to the planner + pass it to `normalizePrd`.** In `planPrd` (line ~829), change the signature to accept `media`:

Find:
```js
async function planPrd({ idea, master, workers, answers, outputFormat, tenant = null, research = '' }) {
```
Replace with:
```js
async function planPrd({ idea, master, workers, answers, outputFormat, tenant = null, research = '', media = null }) {
```

Then, just BEFORE the `const user = ` assignment (line ~847), build a media-budget line:
```js
  // Media-aware planning: tell the planner which generatable media kinds are
  // enabled for this build and their caps, so it can plan a per-story `media`
  // object the user reviews before any spend. Disabled kinds are omitted.
  const mediaBudget = normalizeMedia(media);
  const mediaEnabled = ['image', 'video', 'audio'].filter((k) => mediaBudget[k]?.enabled && mediaBudget[k].cap > 0);
  const mediaLine = mediaEnabled.length
    ? mediaEnabled.map((k) => `${k} up to ${mediaBudget[k].cap}`).join(', ')
    : '';
```

Then, inside the `const user = ` template, add the media block right after the output-format line. Find:
```js
    `Project output format the user picked up front: ${fmt}\n\n` +
```
Replace with:
```js
    `Project output format the user picked up front: ${fmt}\n\n` +
    (mediaLine
      ? `Generated-media budget for THIS build (per-kind TOTAL across ALL stories — these are the ONLY kinds you may plan; generate NOTHING for a kind not listed): ${mediaLine}.\n`
        + `For each story whose deliverable genuinely benefits from generated media (a hero image, one figure per slide, a short intro video, a voiceover), add an OPTIONAL "media" object to that story: {"image":<n>,"video":<n>,"audio":<n>} with small, purposeful counts for the ENABLED kinds only. Keep the per-kind total within the caps above; omit "media" for stories that need none. All imagery must share the project's ONE consistent visual style.\n\n`
      : `Generated media is OFF for this build — do NOT add a "media" object to any story.\n\n`) +
```

Finally, pass `media` to `normalizePrd` at the end of `planPrd`. Find:
```js
  return normalizePrd(prd, { idea, master, workers, outputFormat: fmt, mcpCaps: mcpCapabilitiesFor(tenant) });
```
Replace with:
```js
  return normalizePrd(prd, { idea, master, workers, outputFormat: fmt, mcpCaps: mcpCapabilitiesFor(tenant), media });
```

- [ ] **Step 4: Pass media from the `/api/ralph/plan` route.** In the plan route (line ~3724-3739), read `media` from the body (falling back to the deploy default so the PWA — which sends none — still plans media at the deployment budget). Find:
```js
  const outputFormat = (req.body?.outputFormat || '').trim();
  const assetToken = (req.body?.assetToken || '').toString();
```
Replace with:
```js
  const outputFormat = (req.body?.outputFormat || '').trim();
  const assetToken = (req.body?.assetToken || '').toString();
  // Per-build media budget the plan should be aware of; blank body -> deploy default.
  const media = normalizeMedia(req.body?.media || mediaCapsEffective());
```
Then find:
```js
    const prd = await planPrd({ idea, master, workers, answers: answersForPlan, outputFormat, tenant });
```
Replace with:
```js
    const prd = await planPrd({ idea, master, workers, answers: answersForPlan, outputFormat, tenant, media });
```

- [ ] **Step 5: Re-clamp on start + plan-at-start.** In `startRalphRun` (line ~2615-2618), normalize the media once and thread it through both PRD paths. Find:
```js
  // A client-supplied prd (replay/test) skips the OpenAI planner.
  const prd = prdInput
    ? normalizePrd(prdInput, { idea, master, workers, outputFormat, mcpCaps: mcpCapabilitiesFor(tenant) })
    : await planPrd({ idea, master, workers, outputFormat, tenant });
```
Replace with:
```js
  // Per-build media budget (defaults when absent). Re-clamped into the PRD here so
  // a client that edited the caps down after planning can't exceed the new budget.
  const runMedia = normalizeMedia(media);
  // A client-supplied prd (replay/test) skips the OpenAI planner.
  const prd = prdInput
    ? normalizePrd(prdInput, { idea, master, workers, outputFormat, mcpCaps: mcpCapabilitiesFor(tenant), media: runMedia })
    : await planPrd({ idea, master, workers, outputFormat, tenant, media: runMedia });
```
Then update the `run` object to reuse `runMedia`. Find:
```js
    media: normalizeMedia(media), // per-build media caps/toggles (image/video/audio)
```
Replace with:
```js
    media: runMedia, // per-build media caps/toggles (image/video/audio)
```

- [ ] **Step 6: Document the per-story `media` field in the planner.** In `ralph/planner.md`, add `media` to the story-shape example. Find:
```
      "outputType": "<how this story's result is presented — see formats below>",
      "priority": 1,
```
Replace with:
```
      "outputType": "<how this story's result is presented — see formats below>",
      "media": { "image": 0, "video": 0, "audio": 0 },
      "priority": 1,
```
Then, in the "Skills, tools and output (IMPORTANT):" section, after the `outputType:` bullet (the one ending `…choose the most fitting type per story.`), add a new bullet:
```
  - `media`: OPTIONAL per-story generated-media plan. When the user message states a
    media budget, add `{"image":<n>,"video":<n>,"audio":<n>}` counts (enabled kinds
    only, small and purposeful — a hero image, one figure per slide, a short intro
    video, a voiceover) to the stories that genuinely benefit. Keep each kind's TOTAL
    across all stories within the stated caps; omit `media` for stories that need none.
    Omit it entirely when the message says generated media is OFF.
```

- [ ] **Step 7: Syntax + regression check**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --check server.js && echo "server ok"
node --test ralph/*.test.mjs 2>&1 | tail -3
grep -n '"media"' ralph/planner.md
```
Expected: `server ok`; `# fail 0`; the planner shows the `media` example line.

- [ ] **Step 8: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add server.js ralph/planner.md
git commit -m "feat(planner): media-aware planning — per-story media budget + clamp in normalizePrd"
```

---

### Task 3: Tell each worker exactly what media to generate for its story

**Files:**
- Modify: `server.js` — `writeRalphBrief` (~line 1839/1871), `spawnWorker` (~line 1944)

**Interfaces:**
- Consumes: `story.media` (set by Task 2 via `normalizePrd`), `run.media` (build budget).
- Produces: `writeRalphBrief(dir, tool, {..., storyMedia})` — when `storyMedia` has positive counts, the brief tells the worker to generate exactly that many of each enabled kind for this story (within the build budget note that already exists).

- [ ] **Step 1: Add the `storyMedia` param + brief section.** In `writeRalphBrief` (line ~1839), add `storyMedia = null` to the destructured options. Find:
```js
async function writeRalphBrief(dir, tool, { skills = [], tools = [], outputType, outputFormat, finalize = false, mcp = null, masterNotes = '', media = null }) {
```
Replace with:
```js
async function writeRalphBrief(dir, tool, { skills = [], tools = [], outputType, outputFormat, finalize = false, mcp = null, masterNotes = '', media = null, storyMedia = null }) {
```

Then, in the media section (line ~1871-1875), append a per-story target after the build-budget note. Find:
```js
  if (wantsMedia && media) {
    const on = (k) => media[k]?.enabled ? `on (up to ${media[k].cap})` : 'off';
    parts.push(`## Media budget for this build\nGenerated media is: image ${on('image')}, video ${on('video')}, audio ${on('audio')}.\n`
      + `Use the media helpers from the imagery skill only for the enabled kinds and within budget; otherwise use brand assets, stock, or a placeholder.`);
  }
```
Replace with:
```js
  if (wantsMedia && media) {
    const on = (k) => media[k]?.enabled ? `on (up to ${media[k].cap})` : 'off';
    parts.push(`## Media budget for this build\nGenerated media is: image ${on('image')}, video ${on('video')}, audio ${on('audio')}.\n`
      + `Use the media helpers from the imagery skill only for the enabled kinds and within budget; otherwise use brand assets, stock, or a placeholder.`);
    // Per-story plan (Part A): the planner budgeted specific counts for THIS story.
    const planned = storyMedia && typeof storyMedia === 'object'
      ? ['image', 'video', 'audio'].filter((k) => storyMedia[k] > 0).map((k) => `${k} ×${storyMedia[k]}`)
      : [];
    if (planned.length) {
      parts.push(`## Media planned for THIS story\nThe plan budgeted generated media for this story: ${planned.join(', ')}.\n`
        + `Generate that many (a sensible number is fine if the layout needs slightly fewer), embed them per the imagery skill's placement rules with good alt text, and record each in DELIVERABLE.md. Reuse the project's ONE consistent visual style.`);
    }
  }
```

- [ ] **Step 2: Pass `story.media` from `spawnWorker`.** In `spawnWorker` (line ~1944), add `storyMedia` to the `writeRalphBrief` call. Find:
```js
  const briefFile = await writeRalphBrief(wt, story.assignee, {
    skills: story.skills || [], tools: story.tools || [],
    outputType: story.outputType, outputFormat: run.outputFormat,
    mcp: mcpServersFor(run.tenant || null),
    masterNotes: masterNotesForBrief(run),
    media: run.media,
  }).catch(() => '');
```
Replace with:
```js
  const briefFile = await writeRalphBrief(wt, story.assignee, {
    skills: story.skills || [], tools: story.tools || [],
    outputType: story.outputType, outputFormat: run.outputFormat,
    mcp: mcpServersFor(run.tenant || null),
    masterNotes: masterNotesForBrief(run),
    media: run.media, storyMedia: story.media || null,
  }).catch(() => '');
```

- [ ] **Step 3: Syntax check**

Run: `cd /var/www/tmux.tayyabcheema.com && node --check server.js && echo ok`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add server.js
git commit -m "feat(brief): worker brief states the per-story media plan"
```

---

### Task 4: Editable per-story media in the `web/` review step

**Files:**
- Modify: `web/src/pages/NewBuild.jsx`

**Interfaces:**
- Consumes: `media` (build budget state), `plan.prd.stories[].media` (from Task 2).
- Produces: number inputs per enabled kind on each story in step 3 that mutate `plan.prd.stories[i].media`; a running total per kind vs the cap; `media` is sent to `api.plan` so the planner is media-aware.

- [ ] **Step 1: Send the media budget to the planner.** In `doPlan` (line ~173), add `media` to the plan body. Find:
```js
      const res = await api.plan({ idea: idea.trim(), project: slug, master, workers, outputFormat, assetToken, answers: answers || '' });
```
Replace with:
```js
      const res = await api.plan({ idea: idea.trim(), project: slug, master, workers, outputFormat, assetToken, answers: answers || '', media });
```

- [ ] **Step 2: Add the media edit helper + totals.** Just after the `const stories = plan?.prd?.stories || [];` line (line ~208), add:
```jsx
  const enabledKinds = ['image', 'video', 'audio'].filter((k) => media[k]?.enabled);
  const mediaTotals = { image: 0, video: 0, audio: 0 };
  for (const s of stories) for (const k of enabledKinds) mediaTotals[k] += (s.media?.[k] || 0);
  function setStoryMedia(i, kind, n) {
    setPlan((p) => {
      if (!p?.prd) return p;
      const v = Math.max(0, Math.min(20, parseInt(n, 10) || 0));
      const nextStories = p.prd.stories.map((s, idx) => {
        if (idx !== i) return s;
        const m = { ...(s.media || {}) };
        if (v > 0) m[kind] = v; else delete m[kind];
        return { ...s, media: Object.keys(m).length ? m : undefined };
      });
      return { ...p, prd: { ...p.prd, stories: nextStories } };
    });
  }
```

- [ ] **Step 3: Show a running-total banner in step 3.** In the step-3 header card, after the badges row (find the block ending with the `model.trim()` badge and its closing `</div>`):
```jsx
              {model.trim() && <span className="badge bg-panel2 text-muted">model: {model.trim()}</span>}
            </div>
          </div>
```
Replace with:
```jsx
              {model.trim() && <span className="badge bg-panel2 text-muted">model: {model.trim()}</span>}
            </div>
            {enabledKinds.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {enabledKinds.map((k) => {
                  const over = mediaTotals[k] > media[k].cap;
                  return (
                    <span key={k} className={`badge ${over ? 'bg-danger/15 text-danger' : 'bg-panel2 text-muted'}`}>
                      {k}: {mediaTotals[k]}/{media[k].cap}{over ? ' ⚠ over budget — will be trimmed' : ''}
                    </span>
                  );
                })}
              </div>
            )}
```

- [ ] **Step 4: Add per-story number inputs.** In the story card render (step 3), find the deps/outputType row:
```jsx
                {(s.deps?.length > 0 || s.outputType) && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                    {s.outputType && s.outputType !== 'auto' && <span className="badge bg-panel2">→ {s.outputType}</span>}
                    {s.deps?.length > 0 && <span className="badge bg-panel2">after {s.deps.join(', ')}</span>}
                  </div>
                )}
```
Replace with:
```jsx
                {(s.deps?.length > 0 || s.outputType) && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                    {s.outputType && s.outputType !== 'auto' && <span className="badge bg-panel2">→ {s.outputType}</span>}
                    {s.deps?.length > 0 && <span className="badge bg-panel2">after {s.deps.join(', ')}</span>}
                  </div>
                )}
                {enabledKinds.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span className="opacity-70">media:</span>
                    {enabledKinds.map((k) => (
                      <label key={k} className="flex items-center gap-1">
                        {k}
                        <input type="number" min="0" max="20" className="input !py-0.5 w-14 text-xs"
                          value={s.media?.[k] || 0}
                          onChange={(e) => setStoryMedia(i, k, e.target.value)} />
                      </label>
                    ))}
                  </div>
                )}
```

- [ ] **Step 5: Build the web UI**

Run: `cd /var/www/tmux.tayyabcheema.com/web && npm run build 2>&1 | tail -4`
Expected: Vite build succeeds (`✓ built`), no errors.

- [ ] **Step 6: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add web/src/pages/NewBuild.jsx
git commit -m "feat(web): editable per-story media plan + running total in review"
```

---

### Task 5: Read-only planned media in the PWA confirm dialog + docs

**Files:**
- Modify: `public/js/dashboard.js` (`renderRalphConfirm`, ~line 1205-1240)
- Modify: `public/sw.js` (VERSION bump)
- Modify: `CLAUDE.md` (media-generation section — one sentence)

**Interfaces:**
- Consumes: `st.media` (round-trips through `prd` — the dialog sends `ralphPending` as-is).
- Produces: a read-only per-story media line in the PWA confirm dialog (editing stays a `web/` feature per the spec).

- [ ] **Step 1: Render planned media read-only.** In `renderRalphConfirm` (line ~1205), inside the `.map((st) => {` body, after the tools field (`tlWrap`) is built and before `row.append(...)`, add a media line. Find:
```js
    const tlWrap = document.createElement('div'); tlWrap.className = 'ralph-field';
    tlWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'tools' }));
    tlWrap.append(...ralphMcpTools.map((id) => toggleChip(id, st.tools, id, 'MCP tool')));

    row.append(head, outWrap, skWrap, tlWrap);
    return row;
```
Replace with:
```js
    const tlWrap = document.createElement('div'); tlWrap.className = 'ralph-field';
    tlWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'tools' }));
    tlWrap.append(...ralphMcpTools.map((id) => toggleChip(id, st.tools, id, 'MCP tool')));

    // Planned generated media for this story (read-only here — edit in the web app).
    const planned = (st.media && typeof st.media === 'object')
      ? ['image', 'video', 'audio'].filter((k) => st.media[k] > 0).map((k) => `${k} ×${st.media[k]}`)
      : [];
    const extra = [];
    if (planned.length) {
      const mdWrap = document.createElement('div'); mdWrap.className = 'ralph-field';
      mdWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'media' }));
      mdWrap.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: planned.join(', ') }));
      extra.push(mdWrap);
    }

    row.append(head, outWrap, skWrap, tlWrap, ...extra);
    return row;
```

- [ ] **Step 2: Bump the service-worker version.** In `public/sw.js`, find:
```js
const VERSION = 'webtmux-v38';
```
Replace with:
```js
const VERSION = 'webtmux-v39';
```

- [ ] **Step 3: Syntax check**

Run: `cd /var/www/tmux.tayyabcheema.com && node --check public/js/dashboard.js && echo ok`
Expected: `ok`.

- [ ] **Step 4: Note media-aware planning in CLAUDE.md.** In the "### Media generation" subsection, find the sentence that begins `Per-kind opt-in + cap (\`run.media\`, defaults image on/8, ...` and append to that paragraph:
```
Media-aware planning (Part A): the planner receives the build's media budget and may
add an optional per-story `media: {image,video,audio}` count; `normalizePrd` runs
`applyMediaPlan` (`ralph/providers.mjs`) to sanitize it and clamp the per-kind TOTAL
across the whole PRD to the cap (disabled kinds → 0). The counts are editable per story
in the `web/` review step (read-only in the PWA confirm dialog) and `writeRalphBrief`
tells each worker exactly what to generate for its story.
```

- [ ] **Step 5: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add public/js/dashboard.js public/sw.js CLAUDE.md
git commit -m "feat(pwa): show planned media per story; docs(CLAUDE.md): media-aware planning"
```

---

## Self-Review

- **Spec coverage (Part A):**
  - *Feed the budget to the planner* → Task 2 Step 3 (media-budget block in `planPrd` user prompt) + Step 4 (plan route passes `media`, PWA falls back to deploy default). ✓
  - *Per-story `media` hint, sanitized in `normalizePrd`, clamped to the per-kind cap across the whole PRD* → Task 1 (`applyMediaPlan`) + Task 2 Step 2 (`normalizePrd` calls it). ✓
  - *Worker generates exactly those assets* → Task 3 (`writeRalphBrief` per-story section) + `spawnWorker` passes `story.media`. ✓
  - *Reviewable in the confirm dialog — editable chips per story with a running total vs the cap* → Task 4 (web/, number inputs + totals banner with over-budget flag). ✓ Read-only in PWA → Task 5. ✓
  - *Final development unchanged shape (assets land, deliverable references them, DELIVERABLE.md logs provenance) but pre-approved* → unchanged; the imagery skill (Part 0) already handles embedding + provenance; the per-story brief points at it. ✓
  - *Touches planner.md, planPrd, normalizePrd, writeRalphBrief, web/ confirm dialog (+ optionally public/)* → all covered. ✓
- **Placeholder scan:** none — every step gives the exact find/replace text and full code.
- **Type consistency:** `applyMediaPlan(stories, media)` returns `Story[]` with `media?: {image?,video?,audio?}` (positive ints) — consumed identically in `normalizePrd`, `writeRalphBrief` (`storyMedia[k] > 0`), web/ (`s.media?.[k]`), and PWA (`st.media[k] > 0`). `media` budget shape `{[kind]:{enabled,cap}}` is `normalizeMedia`'s output everywhere. `clampCap` (0..20) is reused, not redefined. ✓
- **Note:** The clamp is deterministic (array order), so what the user sees in the review equals what the server produces on `/start` when caps are unchanged; lowering a cap after planning re-trims on start (Task 2 Step 5) and the web banner flags an over-budget total before that happens.
