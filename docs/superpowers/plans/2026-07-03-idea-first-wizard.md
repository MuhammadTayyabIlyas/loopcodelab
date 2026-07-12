# Idea-First New Build Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web/ New Build "wall of fields" with a 4-screen sliding wizard: goal tiles → AI-assisted describe/refine (one combined analyze call, research-grounded) → relevant-fields-only options → existing review step.

**Architecture:** One new pure module (`ralph/analyze.mjs`: family mapping, prompt assembly, response normalization, fallback) + one new route (`POST /api/ralph/analyze`, best-effort like planner grounding) + a presentational components file (`web/src/components/wizard.jsx`) + a resequenced `web/src/pages/NewBuild.jsx`. The start payload, drafts semantics, planner, and orchestrator are unchanged.

**Tech Stack:** Node ESM (`node --test`), Express route in `server/routes/ralph.mjs`, React + Tailwind (light theme) in `web/`.

**Spec:** `docs/superpowers/specs/2026-07-03-idea-first-new-build-design.md`.

## Global Constraints

- Analyze is ADVISORY: timeout (15s), missing key, or unparseable LLM output → the fallback object (`fallback: true`) and the wizard proceeds with today's defaults. Inference can never block or fail a build.
- `RALPH_FORCE_TOOL` set → deterministic stub response, zero LLM/network calls.
- The `/api/ralph/start` body shape does NOT change. Drafts gain ONE additive optional field `formatFamily`; legacy drafts (absent field) must still reopen correctly.
- Light theme only — PowerDVD contributes tile buttons + horizontal slide transitions, no dark mode, no app-wide restyle.
- Route registration: `/api/ralph/analyze` is a fixed path and must register before `/api/ralph/:project` routes in `server/routes/ralph.mjs` (place it right after the existing `/api/ralph/clarify` route).
- Tests: `node --test ralph/analyze.test.mjs` (pure module only; never unit-test `server/`). Syntax: `node --check server.js server/*.mjs server/routes/*.mjs ralph/*.mjs`.
- After editing `web/src`: `cd web && npm run build` must pass. NEVER commit `web/dist`. No `public/` edits in this plan → no sw.js bump.
- After editing `server/*`: `systemctl restart webtmux`, then `journalctl -u webtmux -n 10 --no-pager` shows a clean boot.
- Commit after each task; `git add` specific files only, never `-A` (`.claude/` stays untracked).

---

### Task 1: `ralph/analyze.mjs` — pure analysis logic + tests

**Files:**
- Create: `ralph/analyze.mjs`
- Create: `ralph/analyze.test.mjs`

**Interfaces:**
- Consumes (all existing, all pure): `normalizeMedia(media)`, `withFormatMediaDefaults(media, outputFormat)`, `mediaCapDefaults()` from `ralph/providers.mjs`; `normalizePlatforms(ids)` (accepts array or comma string, falls back to defaults), `DEFAULT_PLATFORMS` from `ralph/social-formats.mjs`; `smartName(idea)` from `ralph/smart-name.mjs`; `clarifyAxesFor(outputFormat)` → `{ axes, cap, contentHeavy }` from `ralph/clarify-axes.mjs`.
- Produces (Task 2 route + Task 4 UI rely on these exact names):
  - `FORMAT_FAMILIES` — `{ [familyId]: { seed, formats, label } }`
  - `familyOf(id) -> familyId` (junk → `'auto'`)
  - `clampHistory(history) -> [{role:'user'|'assistant', text}]` (≤8 msgs, ≤500 chars each)
  - `analyzePrompt({idea, formatFamily, history, current, grounding}) -> messages[]` for `callPlanner`
  - `normalizeAnalysis(raw, {idea, formatFamily}) -> result` (shape below)
  - `fallbackAnalysis(idea, formatFamily) -> result` with `fallback: true`
  - `stubAnalysis(idea, formatFamily) -> result` (deterministic)
  - result shape: `{ fallback, formatFamily, name, outputFormat, media, platforms, questions:[{q, options[]}], brief, note }`

- [ ] **Step 1: Write the failing tests**

Create `ralph/analyze.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT_FAMILIES, familyOf, clampHistory, analyzePrompt,
  normalizeAnalysis, fallbackAnalysis, stubAnalysis,
} from './analyze.mjs';

test('familyOf: known ids pass through, junk/absent -> auto', () => {
  assert.equal(familyOf('video'), 'video');
  assert.equal(familyOf('sheet'), 'sheet');
  assert.equal(familyOf('nonsense'), 'auto');
  assert.equal(familyOf(''), 'auto');
  assert.equal(familyOf(undefined), 'auto');
  for (const fam of Object.values(FORMAT_FAMILIES)) {
    assert.ok(fam.formats.includes(fam.seed), `${fam.label}: seed must be in formats`);
  }
});

test('clampHistory: caps count and length, coerces roles, drops empties', () => {
  const long = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(600) }));
  const out = clampHistory(long);
  assert.equal(out.length, 8);
  assert.ok(out.every((m) => m.text.length === 500));
  assert.ok(out.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.deepEqual(clampHistory([{ role: 'user', text: '' }, { role: 'evil', text: 'hi' }]),
    [{ role: 'user', text: 'hi' }]);
  assert.deepEqual(clampHistory('junk'), []);
});

test('normalizeAnalysis: clamps format to the family, junk fields -> sane result', () => {
  const r = normalizeAnalysis(
    { outputFormat: 'web-app', name: 'X'.repeat(99), media: 'junk', platforms: 'junk', questions: 'junk', brief: 42 },
    { idea: 'a cat dance video', formatFamily: 'video' },
  );
  assert.equal(r.outputFormat, 'social-video'); // web-app not in video family -> seed
  assert.equal(r.fallback, false);
  assert.equal(r.formatFamily, 'video');
  assert.ok(r.name.length <= 32 && r.name.length > 0);
  assert.ok(r.media.image && typeof r.media.image.enabled === 'boolean');
  assert.ok(Array.isArray(r.platforms) && r.platforms.length > 0); // defaults kick in
  assert.deepEqual(r.questions, []);
  assert.equal(typeof r.brief, 'string');
});

test('normalizeAnalysis: social-video result has media enabled + doc family clamps within family', () => {
  const v = normalizeAnalysis({ outputFormat: 'social-video', media: { video: { enabled: false, cap: 1 } }, platforms: ['tiktok', 'bogus'] },
    { idea: 'mj moonwalk tribute', formatFamily: 'video' });
  assert.equal(v.media.video.enabled, true);  // withFormatMediaDefaults floor
  assert.ok(v.media.video.cap >= 2);
  assert.deepEqual(v.platforms, ['tiktok']);
  const d = normalizeAnalysis({ outputFormat: 'pdf' }, { idea: 'annual report', formatFamily: 'doc' });
  assert.equal(d.outputFormat, 'pdf');        // pdf IS in the doc family
  assert.equal(d.platforms, null);            // platforms only for social-video
});

test('normalizeAnalysis: questions capped by the format clarify cap, options sanitized', () => {
  const qs = Array.from({ length: 12 }, (_, i) => ({ q: `Q${i}?`, options: ['a', 'b', 1] }));
  const r = normalizeAnalysis({ outputFormat: 'social-video', questions: qs },
    { idea: 'x', formatFamily: 'video' });
  assert.ok(r.questions.length <= 6); // content-heavy cap
  assert.deepEqual(r.questions[0].options, ['a', 'b', '1']);
  const rs = normalizeAnalysis({ outputFormat: 'google-sheet', questions: qs },
    { idea: 'x', formatFamily: 'sheet' });
  assert.ok(rs.questions.length <= 4); // technical cap
});

test('fallbackAnalysis: deterministic, flagged, family seed, no questions', () => {
  const r = fallbackAnalysis('a cat dance video for tiktok', 'video');
  assert.equal(r.fallback, true);
  assert.equal(r.outputFormat, 'social-video');
  assert.ok(Array.isArray(r.platforms) && r.platforms.length > 0);
  assert.deepEqual(r.questions, []);
  assert.ok(r.name.length > 0 && r.name.length <= 32);
  const w = fallbackAnalysis('a landing page', 'web');
  assert.equal(w.outputFormat, 'web-app');
  assert.equal(w.platforms, null);
  assert.deepEqual(fallbackAnalysis('a landing page', 'web'), w); // deterministic
});

test('stubAnalysis: deterministic, NOT flagged as fallback, has a question', () => {
  const r = stubAnalysis('anything', 'web');
  assert.equal(r.fallback, false);
  assert.ok(r.note.includes('stub'));
  assert.ok(r.questions.length >= 1);
  assert.deepEqual(stubAnalysis('anything', 'web'), r);
});

test('analyzePrompt: messages carry idea, family constraint, grounding, history, current', () => {
  const msgs = analyzePrompt({
    idea: 'a cat dance video',
    formatFamily: 'video',
    history: [{ role: 'user', text: 'make it funnier' }],
    current: { outputFormat: 'social-video', name: 'cat-dance' },
    grounding: 'RESEARCH: cats are popular',
  });
  assert.ok(Array.isArray(msgs) && msgs.length === 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('JSON'));
  const u = msgs[1].content;
  assert.ok(u.includes('a cat dance video'));
  assert.ok(u.includes('social-video'));          // allowed formats listed
  assert.ok(u.includes('RESEARCH: cats are popular'));
  assert.ok(u.includes('make it funnier'));
  assert.ok(u.includes('cat-dance'));             // current config folded in
  const bare = analyzePrompt({ idea: 'x', formatFamily: 'auto' });
  assert.ok(!bare[1].content.includes('Current web research'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ralph/analyze.test.mjs`
Expected: FAIL — `Cannot find module ... analyze.mjs`

- [ ] **Step 3: Write the implementation**

Create `ralph/analyze.mjs`:

```js
// ralph/analyze.mjs
// Pure logic for the idea-first New Build wizard's combined analyze step:
// goal-family mapping, LLM prompt assembly, response normalization, and the
// fail-soft fallback. The route (server/routes/ralph.mjs) owns the LLM +
// grounding calls; everything here is deterministic and unit-tested.
import { normalizeMedia, withFormatMediaDefaults, mediaCapDefaults } from './providers.mjs';
import { normalizePlatforms, DEFAULT_PLATFORMS } from './social-formats.mjs';
import { smartName } from './smart-name.mjs';
import { clarifyAxesFor } from './clarify-axes.mjs';

// Goal tile -> format family. `seed` is what renders instantly when the tile
// is tapped; `formats` is the set the LLM may pick within that family.
// Mirrored by the web/ wizard tiles (web/src/components/wizard.jsx FAMILIES).
export const FORMAT_FAMILIES = {
  video: { seed: 'social-video', formats: ['social-video'], label: 'Video' },
  web: { seed: 'web-app', formats: ['web-app'], label: 'Website / Web app' },
  mobile: { seed: 'flutter-app', formats: ['flutter-app'], label: 'Mobile app' },
  doc: { seed: 'google-doc', formats: ['google-doc', 'docx', 'pdf'], label: 'Document' },
  sheet: { seed: 'google-sheet', formats: ['google-sheet', 'xlsx'], label: 'Spreadsheet' },
  slides: { seed: 'google-slides', formats: ['google-slides', 'pptx'], label: 'Presentation' },
  auto: {
    seed: 'auto',
    formats: ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc',
      'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'],
    label: 'Anything',
  },
};

export function familyOf(id) {
  const key = String(id || '').trim();
  return FORMAT_FAMILIES[key] ? key : 'auto';
}

const MAX_HISTORY = 8;
const MAX_MSG = 500;
export function clampHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY)
    .map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      text: String(m?.text || '').slice(0, MAX_MSG),
    }))
    .filter((m) => m.text);
}

// Two messages for callPlanner: a fixed system persona and one user turn
// carrying the idea + family constraint + optional grounding/history/current.
export function analyzePrompt({ idea, formatFamily, history = [], current = null, grounding = '' } = {}) {
  const famKey = familyOf(formatFamily);
  const fam = FORMAT_FAMILIES[famKey];
  const axes = clarifyAxesFor(fam.seed);
  const system = 'You are the intake assistant for an autonomous software/media build system. '
    + 'Given a user idea, decide the best deliverable format, a short project name, which media '
    + 'generation kinds the build needs, target platforms (social video only), the clarifying '
    + 'questions worth asking, and a refined one-paragraph brief. '
    + 'Reply ONLY JSON: {"name":"<kebab, <=32 chars>","outputFormat":"<id>",'
    + '"media":{"image":{"enabled":bool,"cap":n},"video":{"enabled":bool,"cap":n},"audio":{"enabled":bool,"cap":n}},'
    + '"platforms":["<id>"...],"questions":[{"q":"...","options":["...",...]}],'
    + '"brief":"<refined brief>","note":"<one line on what you inferred and why>"}';
  const parts = [
    `Idea: ${idea}`,
    `Allowed outputFormat values (pick ONE): ${fam.formats.join(', ')}`,
    `Question axes to consider (ask at most ${axes.cap}, only ones the idea leaves open):\n${axes.axes.map((a) => `- ${a}`).join('\n')}`,
  ];
  if (famKey === 'video') {
    parts.push('Platform ids: tiktok, instagram-reel, instagram-feed, youtube-short, youtube, linkedin.');
  }
  if (current) parts.push(`Current config (the user may be refining it): ${JSON.stringify(current)}`);
  if (grounding) parts.push(`Current web research:\n${grounding}`);
  const h = clampHistory(history);
  if (h.length) parts.push(`Refinement conversation so far:\n${h.map((m) => `${m.role}: ${m.text}`).join('\n')}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function normalizeAnalysis(raw, { idea, formatFamily } = {}) {
  const famKey = familyOf(formatFamily);
  const fam = FORMAT_FAMILIES[famKey];
  const outputFormat = fam.formats.includes(raw?.outputFormat) ? raw.outputFormat : fam.seed;
  const name = String(raw?.name || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || smartName(String(idea || ''));
  const media = withFormatMediaDefaults(
    normalizeMedia(raw?.media && typeof raw.media === 'object' ? raw.media : mediaCapDefaults()),
    outputFormat,
  );
  const platforms = outputFormat === 'social-video' ? normalizePlatforms(raw?.platforms) : null;
  const cap = clarifyAxesFor(outputFormat).cap;
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .map((q) => ({
      q: String(q?.q || (typeof q === 'string' ? q : '')).slice(0, 300),
      options: Array.isArray(q?.options) ? q.options.slice(0, 6).map((o) => String(o).slice(0, 80)) : [],
    }))
    .filter((q) => q.q)
    .slice(0, cap);
  return {
    fallback: false,
    formatFamily: famKey,
    name,
    outputFormat,
    media,
    platforms,
    questions,
    brief: String(raw?.brief || idea || '').slice(0, 2000),
    note: String(raw?.note || '').slice(0, 300),
  };
}

// Deterministic result when the LLM can't run — the wizard renders today's
// defaults and the build proceeds exactly as before. Never throws.
export function fallbackAnalysis(idea, formatFamily) {
  const famKey = familyOf(formatFamily);
  const fam = FORMAT_FAMILIES[famKey];
  return {
    fallback: true,
    formatFamily: famKey,
    name: smartName(String(idea || '')),
    outputFormat: fam.seed,
    media: withFormatMediaDefaults(mediaCapDefaults(), fam.seed),
    platforms: fam.seed === 'social-video' ? [...DEFAULT_PLATFORMS] : null,
    questions: [],
    brief: String(idea || '').slice(0, 2000),
    note: '',
  };
}

// RALPH_FORCE_TOOL stub: same deterministic base, but shaped like a REAL
// analysis (fallback:false + one question) so the wizard's happy path is
// exercised by the no-spend harness.
export function stubAnalysis(idea, formatFamily) {
  return {
    ...fallbackAnalysis(idea, formatFamily),
    fallback: false,
    note: 'stub analysis (RALPH_FORCE_TOOL)',
    questions: [{ q: 'Stub: who is the audience?', options: ['everyone', 'a niche'] }],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ralph/analyze.test.mjs`
Expected: all tests PASS, pristine output. Also run `node --test ralph/*.test.mjs` — everything else still passes.

- [ ] **Step 5: Commit**

```bash
git add ralph/analyze.mjs ralph/analyze.test.mjs
git commit -m "feat(ralph): analyze module — family mapping, prompt, normalization, fail-soft fallback for the idea-first wizard"
```

---

### Task 2: `POST /api/ralph/analyze` route + drafts `formatFamily` passthrough

**Files:**
- Modify: `server/routes/ralph.mjs` (imports at top; new route right AFTER the existing `/api/ralph/clarify` route, ~line 129)
- Modify: `ralph/drafts.mjs` (one additive field in `normalizeDraft`)
- Modify: `ralph/drafts.test.mjs` (one test)

**Interfaces:**
- Consumes: everything Task 1 produced; `clarifyQuestions/planPrd/groundIdea` from `server/planner.mjs` (`groundIdea(idea, outputFormat, tenant) -> string`); `shouldGround(idea, outputFormat) -> bool` from `ralph/research.mjs`; `callPlanner(messages, {json, tenant})` + `extractJson(raw)` from `server/llm.mjs`; `tenantOf(req)` already imported in this routes file from `../ralph-engine.mjs`.
- Produces: `POST /api/ralph/analyze {idea, formatFamily?, history?, current?}` → Task 1 result shape (Task 4's `api.analyze` consumes it). `normalizeDraft` output gains optional `formatFamily`.

- [ ] **Step 1: Write the failing drafts test**

In `ralph/drafts.mjs`'s test file `ralph/drafts.test.mjs`, add:

```js
test('normalizeDraft: formatFamily is additive and junk-safe', () => {
  const d = normalizeDraft({ name: 'x', idea: 'y', formatFamily: 'video' });
  assert.equal(d.formatFamily, 'video');
  const junk = normalizeDraft({ name: 'x', idea: 'y', formatFamily: 'bogus' });
  assert.equal(junk.formatFamily, 'auto');
  const legacy = normalizeDraft({ name: 'x', idea: 'y' });
  assert.equal(legacy.formatFamily, null);
});
```

Run: `node --test ralph/drafts.test.mjs` — Expected: FAIL (`formatFamily` undefined).

- [ ] **Step 2: Implement the drafts field**

In `ralph/drafts.mjs`: add the import and one line inside `normalizeDraft`'s returned object (next to the existing `outputFormat` field):

```js
import { familyOf } from './analyze.mjs';
```

```js
    formatFamily: d?.formatFamily ? familyOf(d.formatFamily) : null,
```

Run: `node --test ralph/drafts.test.mjs` — Expected: PASS (all tests, old + new).

- [ ] **Step 3: Add the route**

In `server/routes/ralph.mjs`:

Extend the existing planner import (line ~40) and add the new imports next to the other `../../ralph/` imports:

```js
import { planPrd, clarifyQuestions, groundIdea } from '../planner.mjs';
import { callPlanner, extractJson } from '../llm.mjs';
import { shouldGround } from '../../ralph/research.mjs';
import {
  FORMAT_FAMILIES, familyOf, clampHistory, analyzePrompt,
  normalizeAnalysis, fallbackAnalysis, stubAnalysis,
} from '../../ralph/analyze.mjs';
```

(If `callPlanner`/`extractJson` are already imported in this file, keep the single import — do not duplicate.)

Directly AFTER the `/api/ralph/clarify` route handler's closing `});`, add:

```js
  // Idea-first wizard: ONE combined inference call — deliverable format, short
  // name, media needs, platforms, clarify questions, refined brief. Optionally
  // grounded in live web research (same suggest-only Perplexity pipe as the
  // planner). Best-effort by construction: any failure returns the
  // deterministic fallback — inference can never block a build.
  app.post('/api/ralph/analyze', async (req, res) => {
    const idea = String(req.body?.idea || '').trim().slice(0, 4000);
    const formatFamily = familyOf(req.body?.formatFamily);
    if (!idea) return res.status(400).json({ error: 'idea is required' });
    if (process.env.RALPH_FORCE_TOOL) return res.json(stubAnalysis(idea, formatFamily));
    const tenant = tenantOf(req);
    const timeout = (p, ms) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error('analyze timeout')), ms)),
    ]);
    try {
      const seed = FORMAT_FAMILIES[formatFamily].seed;
      const grounding = shouldGround(idea, seed) ? await groundIdea(idea, seed, tenant) : '';
      const messages = analyzePrompt({
        idea,
        formatFamily,
        history: clampHistory(req.body?.history),
        current: req.body?.current && typeof req.body.current === 'object' ? req.body.current : null,
        grounding,
      });
      const raw = await timeout(callPlanner(messages, { json: true, tenant }), 15_000);
      const parsed = extractJson(raw);
      res.json(parsed ? normalizeAnalysis(parsed, { idea, formatFamily }) : fallbackAnalysis(idea, formatFamily));
    } catch {
      res.json(fallbackAnalysis(idea, formatFamily));
    }
  });
```

- [ ] **Step 4: Verify and restart**

```bash
node --check server.js server/*.mjs server/routes/*.mjs ralph/analyze.mjs ralph/drafts.mjs
node --test ralph/analyze.test.mjs ralph/drafts.test.mjs
systemctl restart webtmux
journalctl -u webtmux -n 10 --no-pager   # expect "webtmux listening on http://127.0.0.1:8090", no stack traces
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"idea":"x"}' http://127.0.0.1:8090/api/ralph/analyze
```
Expected: curl prints `401` (multitenant session gate — proves the route is registered and gated, not 404).

- [ ] **Step 5: Commit**

```bash
git add server/routes/ralph.mjs ralph/drafts.mjs ralph/drafts.test.mjs
git commit -m "feat(api): POST /api/ralph/analyze — combined wizard inference (grounded, fail-soft) + draft formatFamily"
```

---

### Task 3: wizard components + API client + slide CSS

**Files:**
- Create: `web/src/components/wizard.jsx`
- Modify: `web/src/api.js` (one line, next to `clarify:` at line ~39)
- Modify: `web/src/index.css` (slide keyframes at the end of the file)

**Interfaces:**
- Produces (Task 4 consumes): `FAMILIES` (array of `{id, icon, label, hint, ask, chips[]}` — ids match Task 1 `FORMAT_FAMILIES` keys), `familyForFormat(outputFormat) -> familyId`, `<GoalScreen onPick={(fam) => …} />`, `<Slide k={screenKey} dir={'fwd'|'back'}>…</Slide>`, `api.analyze(body)`.

- [ ] **Step 1: Add the API client line**

In `web/src/api.js`, next to `clarify:`:

```js
  analyze: (body) => req('POST', '/api/ralph/analyze', body),
```

- [ ] **Step 2: Create the components file**

Create `web/src/components/wizard.jsx`:

```jsx
// Presentational pieces for the idea-first New Build wizard: goal tiles
// (PowerDVD-style large cards, light theme) and the slide-transition wrapper.
// All state lives in pages/NewBuild.jsx — these are dumb components.

// Mirrors ralph/analyze.mjs FORMAT_FAMILIES (ids must match exactly).
export const FAMILIES = [
  { id: 'video', icon: '🎬', label: 'Video', hint: 'Story video for TikTok, Reels, Shorts, YouTube', ask: 'What kind of video?', chips: ['Promo', 'Story / tribute', 'Product demo', 'Explainer'] },
  { id: 'web', icon: '🌐', label: 'Website / Web app', hint: 'Landing page, SaaS tool, dashboard, store', ask: 'What kind of website or app?', chips: ['Landing page', 'SaaS tool', 'Dashboard', 'Online store'] },
  { id: 'mobile', icon: '📱', label: 'Mobile app', hint: 'Flutter app — Android + web preview', ask: 'What kind of mobile app?', chips: ['Utility', 'Social', 'Tracker', 'Game'] },
  { id: 'doc', icon: '📄', label: 'Document', hint: 'Report, proposal, guide — Doc / Word / PDF', ask: 'What kind of document?', chips: ['Report', 'Proposal', 'Guide'] },
  { id: 'sheet', icon: '📊', label: 'Spreadsheet', hint: 'Model, tracker, analysis — Sheet / Excel', ask: 'What kind of spreadsheet?', chips: ['Financial model', 'Tracker', 'Analysis'] },
  { id: 'slides', icon: '📽️', label: 'Presentation', hint: 'Pitch deck, slides — Slides / PowerPoint', ask: 'What kind of presentation?', chips: ['Pitch deck', 'Training', 'Portfolio'] },
  { id: 'auto', icon: '✨', label: 'Anything else', hint: 'Describe it — the planner picks the format', ask: 'What do you want to build?', chips: [] },
];

const FORMAT_TO_FAMILY = {
  'social-video': 'video', 'web-app': 'web', 'flutter-app': 'mobile',
  'google-doc': 'doc', docx: 'doc', pdf: 'doc',
  'google-sheet': 'sheet', xlsx: 'sheet',
  'google-slides': 'slides', pptx: 'slides',
};
export function familyForFormat(outputFormat) {
  return FORMAT_TO_FAMILY[outputFormat] || 'auto';
}

// Horizontal slide-in wrapper: remounts on `k` change so the CSS animation
// replays; dir 'back' slides from the left instead.
export function Slide({ k, dir = 'fwd', children }) {
  return (
    <div key={k} data-dir={dir} className="wizard-slide">
      {children}
    </div>
  );
}

export function GoalScreen({ onPick }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">What do you want to build?</h2>
      <p className="mt-1 text-sm text-muted">Pick a goal — everything else is inferred from your idea and stays editable.</p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {FAMILIES.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onPick(f)}
            className="card group flex flex-col items-start gap-2 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-glow"
          >
            <span className="text-3xl">{f.icon}</span>
            <span className="text-sm font-semibold">{f.label}</span>
            <span className="text-xs text-muted">{f.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the slide keyframes**

Append to `web/src/index.css` (top level, after the existing `@layer` blocks):

```css
/* New Build wizard: horizontal slide between screens (PowerDVD-style). */
.wizard-slide { animation: wizard-in 0.25s ease both; }
.wizard-slide[data-dir='back'] { animation-name: wizard-in-back; }
@keyframes wizard-in { from { opacity: 0; transform: translateX(48px); } to { opacity: 1; transform: translateX(0); } }
@keyframes wizard-in-back { from { opacity: 0; transform: translateX(-48px); } to { opacity: 1; transform: translateX(0); } }
```

- [ ] **Step 4: Build check**

Run: `cd web && npm run build`
Expected: clean build (the new file compiles even though nothing imports it yet).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/wizard.jsx web/src/api.js web/src/index.css
git commit -m "feat(web): wizard components — goal tiles, slide transitions, analyze client"
```

---

### Task 4: NewBuild.jsx — the 4-screen wizard

**Files:**
- Modify: `web/src/pages/NewBuild.jsx` (resequence; current file is ~545 lines, steps at lines ~273-290 (badges), 289 (step 1 configure), 433 (step 2 clarify), 472 (step 3 review))

**Interfaces:**
- Consumes: `FAMILIES`, `familyForFormat`, `Slide`, `GoalScreen` from `../components/wizard.jsx`; `api.analyze` from Task 3; the analyze result shape from Task 1.
- Produces: the SAME `/api/ralph/start` body as today (`{name, idea, master, workers, model, outputFormat, project, media, clarify, prd, platforms, mediaModels}`) + drafts now also carry `formatFamily`.

This task RESEQUENCES the existing page. The existing field blocks (media caps rows, media model selects, worker checkboxes, model override input, master select, name input, brand assets tray, plan review table) are MOVED, not rewritten — keep their JSX and state bindings intact unless a change is listed below.

- [ ] **Step 1: New state + navigation skeleton**

At the top of the component, replace the current `step` state (`useState(1)`) with:

```jsx
  const [screen, setScreen] = useState('goal'); // goal | describe | options | review
  const [navDir, setNavDir] = useState('fwd');
  const [family, setFamily] = useState(null);   // FAMILIES entry
  const [analysis, setAnalysis] = useState(null); // last analyze result
  const [chatLog, setChatLog] = useState([]);   // [{role, text}] for refine history
  const [chatMsg, setChatMsg] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
```

Navigation helper (place next to the other handlers):

```jsx
  const go = (next) => {
    const order = ['goal', 'describe', 'options', 'review'];
    setNavDir(order.indexOf(next) >= order.indexOf(screen) ? 'fwd' : 'back');
    setScreen(next);
  };
```

Update the step badges header (lines ~273-290) to the four labels, highlighting by `screen`:

```jsx
      <div className="flex items-center gap-2 text-xs">
        {[['goal', '1 · Goal'], ['describe', '2 · Describe'], ['options', '3 · Options'], ['review', '4 · Review']].map(([id, label]) => (
          <span key={id} className={screen === id ? 'badge bg-accent/15 text-accent' : 'badge bg-panel2 text-muted'}>{label}</span>
        ))}
      </div>
```

- [ ] **Step 2: Screen 1 — Goal**

Render block (replaces the old `step === 1` opening; the old configure fields move to Screen 3 in Step 4 below):

```jsx
      {screen === 'goal' && (
        <Slide k="goal" dir={navDir}>
          <GoalScreen onPick={(f) => { setFamily(f); setOutputFormat(null); go('describe'); }} />
        </Slide>
      )}
```

(`setOutputFormat(null)` here means "not yet inferred" — the analyze call or its fallback sets it; `outputFormat` state already exists.)

- [ ] **Step 3: Screen 2 — Describe & refine**

The analyze handler (new, next to the existing `doPlan`-style handlers). It serves both the Analyze button and the refine chat:

```jsx
  async function runAnalyze(extraMsg) {
    if (!idea.trim() || analyzing) return;
    setAnalyzing(true);
    const history = extraMsg ? [...chatLog, { role: 'user', text: extraMsg }] : chatLog;
    if (extraMsg) setChatLog(history);
    try {
      const r = await api.analyze({
        idea: idea.trim(),
        formatFamily: family?.id || 'auto',
        history,
        current: analysis ? { name: slug || analysis.name, outputFormat, media, platforms } : null,
      });
      setAnalysis(r);
      setOutputFormat(r.outputFormat);
      setMedia(r.media);
      if (r.platforms) setPlatforms(r.platforms);
      if (!slug) setSlug(r.name);
      setQuestions(r.questions.map((q) => ({ q: q.q, options: q.options })));
      setPicks({});
      if (extraMsg && r.note) setChatLog((l) => [...l, { role: 'assistant', text: r.note }]);
    } catch {
      setAnalysis({ fallback: true, note: '' });
      setOutputFormat(family?.id ? (FAMILIES.find((f) => f.id === family.id), family.id === 'video' ? 'social-video' : family.id === 'web' ? 'web-app' : family.id === 'mobile' ? 'flutter-app' : 'auto') : 'auto');
    } finally { setAnalyzing(false); }
  }
```

Render block. The clarify-questions JSX is the EXISTING step-2 questions/picks block (currently at lines ~433-470) moved inside this screen unchanged; the brand-assets tray is the existing component moved here from the old configure step:

```jsx
      {screen === 'describe' && family && (
        <Slide k="describe" dir={navDir}>
          <button className="btn-ghost text-xs" onClick={() => go('goal')}>← Change goal</button>
          <h2 className="mt-2 text-lg font-semibold">{family.ask}</h2>
          {family.chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {family.chips.map((c) => (
                <button key={c} type="button" className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => setIdea((v) => (v ? `${v} — ${c.toLowerCase()}` : `A ${c.toLowerCase()}: `))}>{c}</button>
              ))}
            </div>
          )}
          <textarea className="prompt-area mt-3" rows={4} value={idea}
            onChange={(e) => setIdea(e.target.value)} placeholder="Describe it in a sentence or two…" />

          {/* existing brand-assets tray JSX moves here, unchanged */}

          <button className="btn btn-primary mt-3" disabled={!idea.trim() || analyzing} onClick={() => runAnalyze()}>
            {analyzing ? 'Analyzing…' : analysis ? 'Re-analyze' : 'Analyze idea'}
          </button>

          {analysis && (
            <div className="card mt-4">
              {analysis.fallback
                ? <p className="text-xs text-muted">Smart analysis unavailable — using sensible defaults (everything stays editable on the next screen).</p>
                : (<>
                  <p className="text-sm"><b>{slug || analysis.name}</b> · {outputFormat}{analysis.platforms ? ` · ${analysis.platforms.join(', ')}` : ''}</p>
                  {analysis.note && <p className="mt-1 text-xs text-muted">{analysis.note}</p>}
                  {analysis.brief && analysis.brief !== idea.trim() && <p className="mt-2 text-xs">{analysis.brief}</p>}
                </>)}

              {/* existing clarify questions/picks JSX moves here, unchanged */}

              <div className="mt-3 flex gap-2">
                <input className="input flex-1" placeholder='Refine with AI — e.g. "also Instagram", "brainstorm this idea"'
                  value={chatMsg} onChange={(e) => setChatMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && chatMsg.trim()) { runAnalyze(chatMsg.trim()); setChatMsg(''); } }} />
                <button className="btn-ghost text-xs" disabled={analyzing || !chatMsg.trim()}
                  onClick={() => { runAnalyze(chatMsg.trim()); setChatMsg(''); }}>Send</button>
              </div>
              {chatLog.length > 0 && (
                <div className="mt-2 space-y-1 text-xs text-muted">
                  {chatLog.slice(-4).map((m, i) => <p key={i}><b>{m.role === 'user' ? 'You' : 'AI'}:</b> {m.text}</p>)}
                </div>
              )}
            </div>
          )}

          <div className="mt-4">
            <button className="btn btn-primary" disabled={!idea.trim()}
              onClick={() => { if (!analysis) runAnalyze(); go('options'); }}>
              Continue →
            </button>
          </div>
        </Slide>
      )}
```

- [ ] **Step 4: Screen 3 — Options (relevant fields + Advanced)**

The old configure-step field blocks move here, grouped by relevance. Visibility map (exact):

```jsx
  const fam = family?.id || familyForFormat(outputFormat);
  const show = {
    platforms: outputFormat === 'social-video',
    mediaFull: fam === 'video',                       // image+video+audio toggle rows
    mediaImagesOnly: fam === 'web' || fam === 'mobile',
    workers: fam === 'web' || fam === 'mobile',
    formatSelect: fam === 'auto',
  };
```

Render structure (each `{/* … */}` marker is an EXISTING JSX block moved verbatim from the old step-1 configure body — keep its bindings):

```jsx
      {screen === 'options' && (
        <Slide k="options" dir={navDir}>
          <button className="btn-ghost text-xs" onClick={() => go('describe')}>← Back</button>
          <h2 className="mt-2 text-lg font-semibold">Options</h2>
          <p className="mt-1 text-sm text-muted">Pre-filled from your idea — adjust anything, or open Advanced for the rest.</p>

          {/* project name input (existing) — always */}
          {/* master agent select (existing) — always */}
          {show.formatSelect && (/* output format select (existing) */)}
          {show.platforms && (/* platform checkboxes (existing, from Task-8 work) */)}
          {show.mediaFull && (/* all three media cap rows (existing) */)}
          {show.mediaImagesOnly && (/* the images cap row ONLY (existing row JSX for image) */)}
          {show.workers && (/* worker agent checkboxes (existing) */)}

          <details className="card mt-4">
            <summary className="cursor-pointer text-sm font-semibold">Advanced</summary>
            <div className="mt-3 space-y-4">
              {!show.formatSelect && (/* output format select (existing) */)}
              {/* per-run model override input (existing) */}
              {/* media model pickers — all four selects (existing) */}
              {!show.workers && (/* worker checkboxes (existing) */)}
              {!show.mediaFull && (/* media cap rows not shown above (existing) */)}
            </div>
          </details>

          <div className="mt-4">
            <button className="btn btn-primary" onClick={generatePlan /* the existing plan-generation handler, renamed if needed */}>
              Generate plan →
            </button>
          </div>
        </Slide>
      )}
```

Wire the existing plan handler so it (a) uses `analysis?.brief || idea` as the idea it sends, (b) no longer calls `api.clarify` (questions came from analyze; keep the clarify-answer assembly exactly as today from `questions` + `picks`), and (c) then `go('review')`.

- [ ] **Step 5: Screen 4 — Review + draft round-trip**

- Wrap the existing step-3 review JSX in `{screen === 'review' && (<Slide k="review" dir={navDir}> … </Slide>)}` — contents unchanged.
- In the draft-save body add `formatFamily: family?.id || null`.
- In the draft-reopen effect: after restoring fields, set `setFamily(FAMILIES.find((f) => f.id === (d.formatFamily || familyForFormat(d.outputFormat))) || FAMILIES.at(-1)); setScreen('options');` — a reopened draft lands directly on Options with everything restored (legacy drafts without `formatFamily` derive it from their outputFormat).
- The `?prefill`/`pendingFormat` initial-state path (if present) keeps working: it seeds `idea`/format state; the wizard still starts at `goal`.

- [ ] **Step 6: Build + manual walkthrough**

```bash
cd web && npm run build
```
Expected: clean. Then walk the live UI (`/app/new`): Goal tile 🎬 → describe "a cat dance video" → Analyze (real call; or fallback message if no planner key) → Continue → Options shows name/platforms/media/master + Advanced → Generate plan → Review renders. Reopen an existing old draft from the dashboard → lands on Options with its fields.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/NewBuild.jsx
git commit -m "feat(web): idea-first New Build wizard — goal tiles, AI describe/refine, relevant-fields options + Advanced"
```

---

### Task 5: docs + final verification sweep

**Files:**
- Modify: `CLAUDE.md` (web/ frontend bullet in the Layout section)

**Interfaces:** none new.

- [ ] **Step 1: CLAUDE.md note**

In the `web/` Layout bullet, after the sentence about the SaaS new-build flow, add:

```markdown
  The New Build flow is an idea-first 4-screen wizard (goal tiles → AI describe/refine →
  relevant-fields options + Advanced → review): `POST /api/ralph/analyze` (route in
  `routes/ralph.mjs`, pure logic `ralph/analyze.mjs`) does ONE combined inference —
  format/name/media/platforms/questions/brief, Perplexity-grounded when the idea references
  the live web — and is fail-soft: any failure returns a deterministic fallback and the
  wizard proceeds with today's defaults. `RALPH_FORCE_TOOL` → stub analysis. Screen state
  maps to the SAME `/api/ralph/start` body; drafts carry an optional additive `formatFamily`.
```

- [ ] **Step 2: Full verification sweep**

```bash
node --check server.js server/*.mjs server/routes/*.mjs ralph/*.mjs
node --test ralph/*.test.mjs        # all pass
cd web && npm run build && cd ..
git status --short                  # web/dist and .claude/ untracked/ignored, nothing unexpected
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: idea-first wizard — analyze endpoint + wizard flow in CLAUDE.md"
```

---

## Self-review notes (done while writing)

- Spec coverage: goal tiles (T3/T4), describe+chips+assets+analyze+refine chat (T4 S3), combined grounded call (T2), relevant-fields map + Advanced (T4 S4), review unchanged (T4 S5), fail-soft + stub (T1/T2), drafts additive field (T2/T4), slide transitions light theme (T3), CLAUDE.md (T5). PWA port + theming: out of scope per spec.
- The clarify endpoint stays untouched (PWA keeps using it); the wizard gets questions from analyze instead.
- `normalizeAnalysis` name sanitization duplicates a slug regex rather than importing `slugify` (server-side, not pure) — deliberate; `smartName` remains the fallback.
