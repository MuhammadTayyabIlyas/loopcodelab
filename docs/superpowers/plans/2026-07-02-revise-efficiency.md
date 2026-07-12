# Revise Efficiency (fewer wasted reject/retry cycles) Implementation Plan

> **STATUS: SHIPPED 2026-07-02** (commits 4296fbb, 4d39363, 562743f). Live-verified on
> hello-card: "change the card headline to WELCOME BACK — nothing else" → ONE story,
> 3 acceptance criteria, `revision: true`, NO media, `--revision 1` on the review command,
> **merged on attempt 1**, done in 2m50s post-to-live (vs ~12 min with a reject/retry for
> the comparable morning revise). Review pass itself took 27s (diff-focused) vs ~3 min.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/ralph/revise` runs converge in one attempt: proportional stories from the planner, no surprise media, and a master review that judges the diff and rejects only with concrete evidence.

**Architecture:** Three coordinated, revision-scoped changes. (1) The revise route appends explicit story-shape rules to the planner `research` header and tags added stories `revision: true`. (2) A pure, unit-tested module `ralph/revise-scope.mjs` deterministically strips story media the instruction never asked for. (3) `spawnReview` forwards the revision flag to `ralph-review.sh`, which appends a diff-focused review addendum (`ralph/review-revision.md`) to the master prompt. Greenfield builds are untouched.

**Tech Stack:** Node (ESM `.mjs` pure module + node:test), bash (`ralph-review.sh`), prompt markdown (`ralph/review-revision.md`), `server.js` (Express route + spawn helpers).

## Global Constraints

- Scope is **revisions only** — greenfield planning/review behaviour must not change (user decision 2026-07-02).
- Pure logic goes in a focused `ralph/*.mjs` module with a `*.test.mjs` (repo TDD pattern: solo-models, sub-tracking, …). `server.js` is not unit-testable.
- Syntax gates before restart: `node --check server.js`, `node --check ralph/revise-scope.mjs`, `bash -n ralph/ralph-review.sh`, `node --test ralph/revise-scope.test.mjs`, then full `node --test ralph/*.test.mjs` (199 tests pass as of 2026-07-02 — must stay green).
- `server.js` edits need `systemctl restart webtmux`; `ralph/*.sh` and `ralph/*.md` edits do NOT (read fresh per spawn).
- Review/finalize scripts must always write a verdict (`|| true` pattern) — never add an early exit above the verdict write in `ralph-review.sh`.
- Workers never edit `prd.json`; the orchestrator owns it.

**Context already shipped (2026-07-02, do not redo):** the reject-reason extraction in `ralph-review.sh:58` was a broken sed that errored on every reject, masking every reason as "did not meet acceptance criteria". It is fixed (grep + sed pipeline) and committed. Reject reasons now reach the events feed, `MASTER.md`, and the retry brief (`RALPH_REVIEW_NOTE` in `spawnWorker`) — this plan builds on that.

**Motivating incident:** hello-card revise "retheme to Good Bye" (2026-07-02). The planner expanded one instruction into 8 acceptance criteria (README, HTML validation, 320–1920px responsive sweep, light/dark polish) **plus `media: {image: 2}`** nobody asked for; the master rejected a complete-looking attempt 1 with a (then-masked) reason; total wall-clock doubled to ~12 min.

---

### Task 1: `ralph/revise-scope.mjs` — pure revision-scoping helpers (TDD)

**Files:**
- Create: `ralph/revise-scope.mjs`
- Test: `ralph/revise-scope.test.mjs`

**Interfaces:**
- Produces: `REVISE_PLANNER_RULES` (string constant), `mentionsMediaKinds(idea) -> {image: boolean, video: boolean, audio: boolean}`, `clampReviseMedia(stories, idea) -> stories` (mutates + returns the same array). Task 2 imports all three into `server.js`.

- [ ] **Step 1: Write the failing test**

```js
// ralph/revise-scope.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVISE_PLANNER_RULES, mentionsMediaKinds, clampReviseMedia } from './revise-scope.mjs';

test('REVISE_PLANNER_RULES states the caps the planner must follow', () => {
  assert.match(REVISE_PLANNER_RULES, /at most 4/i);
  assert.match(REVISE_PLANNER_RULES, /ONE story/);
  assert.match(REVISE_PLANNER_RULES, /Do NOT assign story media/i);
});

test('mentionsMediaKinds: plain retheme instruction mentions nothing', () => {
  assert.deepEqual(
    mentionsMediaKinds('change the hero section palette to dusk colors'),
    { image: false, video: false, audio: false },
  );
});

test('mentionsMediaKinds: detects each kind independently', () => {
  assert.deepEqual(
    mentionsMediaKinds('add a new hero image and a background video'),
    { image: true, video: true, audio: false },
  );
  assert.equal(mentionsMediaKinds('add a voiceover to the intro').audio, true);
  assert.equal(mentionsMediaKinds('generate a new logo').image, true);
  assert.equal(mentionsMediaKinds('add background music').audio, true);
});

test('mentionsMediaKinds: case-insensitive, tolerates empty/null idea', () => {
  assert.equal(mentionsMediaKinds('Add A New PHOTO gallery').image, true);
  assert.deepEqual(mentionsMediaKinds(''), { image: false, video: false, audio: false });
  assert.deepEqual(mentionsMediaKinds(null), { image: false, video: false, audio: false });
});

test('clampReviseMedia: strips media kinds the instruction never mentioned', () => {
  const stories = [{ id: 's2', media: { image: 2 } }];
  clampReviseMedia(stories, 'retheme the card to Good Bye');
  assert.equal(stories[0].media, undefined);
});

test('clampReviseMedia: keeps kinds the instruction asks for, drops the rest', () => {
  const stories = [{ id: 's2', media: { image: 2, video: 1 } }];
  clampReviseMedia(stories, 'swap the hero image for a sunset photo');
  assert.deepEqual(stories[0].media, { image: 2 });
});

test('clampReviseMedia: stories without media pass through untouched', () => {
  const stories = [{ id: 's2', title: 'x' }];
  const out = clampReviseMedia(stories, 'add a video');
  assert.equal(out, stories);
  assert.equal(stories[0].media, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ralph/revise-scope.test.mjs`
Expected: FAIL — `Cannot find module '.../ralph/revise-scope.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// ralph/revise-scope.mjs
// Pure revision-scoping helpers for /api/ralph/revise (server.js).
// A revision edits a FINISHED app: stories must be proportional to the
// instruction, and media generation must be explicitly asked for — the
// motivating bug was a one-line retheme that got 8 acceptance criteria
// plus media:{image:2} and burned a full reject/retry cycle.

// Appended to the revise planner's `research` context (planPrd). Prompt-level
// on purpose: instructing the planner degrades gracefully; code-truncating
// its output can drop the requested change itself.
export const REVISE_PLANNER_RULES = `Revision story rules (MANDATORY):
- Prefer ONE story unless the instruction lists clearly independent changes.
- Acceptance criteria: at most 4 per story, and they must test ONLY the
  requested change plus exactly one regression criterion ("everything not
  mentioned still works and the app still builds/renders").
- Do NOT add criteria about README updates, HTML validation, responsive
  sweeps, light/dark polish, or accessibility audits unless the instruction
  asks for them.
- Do NOT assign story media (image/video/audio counts) unless the instruction
  explicitly asks for new imagery, video, or audio.`;

const KIND_RE = {
  image: /\b(image|images|imagery|photo|photos|picture|pictures|illustration|graphic|logo|icon|banner|artwork)\b/i,
  video: /\b(video|videos|animation|clip|footage)\b/i,
  audio: /\b(audio|music|sound|soundtrack|voiceover|voice-over|narration|jingle)\b/i,
};

// Which media kinds does the revision instruction actually ask for?
export function mentionsMediaKinds(idea) {
  const s = String(idea || '');
  return {
    image: KIND_RE.image.test(s),
    video: KIND_RE.video.test(s),
    audio: KIND_RE.audio.test(s),
  };
}

// Deterministic guard behind REVISE_PLANNER_RULES: even if the planner
// assigns media anyway, strip kinds the instruction never mentioned
// (media = spend + one more thing a strict reviewer can reject on).
export function clampReviseMedia(stories, idea) {
  const asked = mentionsMediaKinds(idea);
  for (const story of stories || []) {
    if (!story || typeof story.media !== 'object' || !story.media) continue;
    const kept = {};
    for (const [kind, n] of Object.entries(story.media)) {
      if (asked[kind] && Number(n) > 0) kept[kind] = n;
    }
    if (Object.keys(kept).length) story.media = kept;
    else delete story.media;
  }
  return stories;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ralph/revise-scope.test.mjs`
Expected: PASS (7 tests)

Run: `node --test ralph/*.test.mjs`
Expected: all pass (199 existing + 7 new)

- [ ] **Step 5: Commit**

```bash
git add ralph/revise-scope.mjs ralph/revise-scope.test.mjs
git commit -m "feat(revise): revise-scope helpers — planner rules constant + deterministic media clamp"
```

---

### Task 2: Wire the revise route — rules in the planner context, clamp + `revision: true` on added stories

**Files:**
- Modify: `server.js` (the `/api/ralph/revise` handler, currently at ~line 4637; the `research` template at ~4665; the `added` mapping at ~4672. Line numbers drift — locate with `grep -n "This is a REVISION" server.js`)

**Interfaces:**
- Consumes: `REVISE_PLANNER_RULES`, `clampReviseMedia` from `ralph/revise-scope.mjs` (Task 1).
- Produces: revise-added stories carry `revision: true` — Task 3's `spawnReview` reads that flag. (The flag persists automatically: `run.stories` is serialized whole by `persistRun`; `prdFileShape`/`normalizePrd` are not in this path for already-added stories.)

- [ ] **Step 1: Add the import**

Alongside the existing `ralph/*.mjs` imports at the top of `server.js` (grep `from './ralph/` for the block):

```js
import { REVISE_PLANNER_RULES, clampReviseMedia } from './ralph/revise-scope.mjs';
```

- [ ] **Step 2: Append the rules to the planner research context**

In the revise handler, change:

```js
    const research = `This is a REVISION of the finished app below. Change ONLY what the instruction asks; keep everything else working.\n\nFile tree:\n${tree.join('\n')}\n\nREADME.md:\n${readme.slice(0, 2500)}\n\nDELIVERABLE.md:\n${deliver.slice(0, 1500)}`;
```

to:

```js
    const research = `This is a REVISION of the finished app below. Change ONLY what the instruction asks; keep everything else working.\n\n${REVISE_PLANNER_RULES}\n\nFile tree:\n${tree.join('\n')}\n\nREADME.md:\n${readme.slice(0, 2500)}\n\nDELIVERABLE.md:\n${deliver.slice(0, 1500)}`;
```

(Rules go BEFORE the file tree so they aren't buried under 150 tree lines.)

- [ ] **Step 3: Tag + clamp the added stories**

Change the `added` mapping:

```js
    const added = planned.stories.map((s) => {
      const id = idMap[s.id];
      return { ...s, id, branch: `prd/${id}`, deps: (s.deps || []).map((d) => idMap[d]).filter(Boolean), status: 'todo', iterations: 0 };
    });
```

to:

```js
    const added = planned.stories.map((s) => {
      const id = idMap[s.id];
      // revision: true => spawnReview switches the master to diff-focused review.
      return { ...s, id, branch: `prd/${id}`, deps: (s.deps || []).map((d) => idMap[d]).filter(Boolean), status: 'todo', iterations: 0, revision: true };
    });
    // Planner rules say "no unrequested media"; this enforces it deterministically.
    clampReviseMedia(added, idea);
```

- [ ] **Step 4: Syntax check**

Run: `node --check server.js`
Expected: no output (clean)

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(revise): proportional planner rules + media clamp + revision flag on added stories"
```

---

### Task 3: Revision-aware master review — flag through `spawnReview` → `ralph-review.sh` → prompt addendum

**Files:**
- Create: `ralph/review-revision.md`
- Modify: `ralph/ralph-review.sh` (arg parse at lines 6–11, `PROMPT` assembly at line 27)
- Modify: `server.js` `spawnReview` (~line 2223; the `cmd` template ending `--verdict ${verdict}${modelFlag}`)

**Interfaces:**
- Consumes: `story.revision` set by Task 2.
- Produces: `ralph-review.sh --revision 1` appends `review-revision.md` to the master prompt. No verdict-format change — the existing `<verdict>ACCEPT</verdict>` / `<verdict>REJECT: reason</verdict>` contract is untouched.

- [ ] **Step 1: Write the prompt addendum**

```markdown
<!-- ralph/review-revision.md — appended to review.md when ralph-review.sh gets --revision 1 -->
## Revision review — this story revises a FINISHED, already-accepted app

Judge the DIFF against the story's instruction — not the whole app against a
fresh production bar. The app already passed review once; your job is to check
the *change*.

- Verify the requested change is present and correct (`git diff main...<branch>`).
- Still run the build/smoke gates from step 3 — a broken build or blank page is
  an automatic REJECT, exactly as before.
- REJECT only with concrete evidence: a failing command plus its key error
  line, or a named acceptance criterion plus what you observed instead. If you
  cannot verify a criterion by inspecting the diff or running a gate, do NOT
  reject on it.
- Pre-existing imperfections OUTSIDE the diff are NOT grounds to reject —
  mention them in prose if notable, then ACCEPT.
```

- [ ] **Step 2: Parse `--revision` in `ralph-review.sh` and append the addendum**

Change line 6 and the arg loop:

```bash
TOOL=""; STORY=""; DIR="."; BRANCH=""; VERDICT_FILE=""; MODEL=""; REVISION=""
while [[ $# -gt 0 ]]; do case "$1" in
  --tool) TOOL="$2"; shift 2;; --story) STORY="$2"; shift 2;;
  --dir) DIR="$2"; shift 2;; --branch) BRANCH="$2"; shift 2;;
  --verdict) VERDICT_FILE="$2"; shift 2;; --model) MODEL="$2"; shift 2;;
  --revision) REVISION="$2"; shift 2;; *) shift;;
esac; done
```

And directly after the existing `PROMPT=` line (line 27):

```bash
PROMPT="$HEADER"$'\n\n'"$(cat "$SCRIPT_DIR/review.md" 2>/dev/null)"
# Revision stories get a diff-focused addendum: judge the change, reject only
# with concrete evidence (see review-revision.md).
if [[ -n "$REVISION" ]]; then
  PROMPT="$PROMPT"$'\n\n'"$(cat "$SCRIPT_DIR/review-revision.md" 2>/dev/null)"
fi
```

- [ ] **Step 3: Pass the flag from `spawnReview`**

In `server.js` `spawnReview`, change:

```js
  const cmd = `${flutterGradleCapCmd(run)}mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_REVIEW_SH} --tool ${run.master} ` +
    `--story ${story.id} --dir ${wt} --branch ${story.branch} --verdict ${verdict}${modelFlag}`;
```

to:

```js
  const revFlag = story.revision ? ' --revision 1' : '';
  const cmd = `${flutterGradleCapCmd(run)}mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_REVIEW_SH} --tool ${run.master} ` +
    `--story ${story.id} --dir ${wt} --branch ${story.branch} --verdict ${verdict}${revFlag}${modelFlag}`;
```

- [ ] **Step 4: Syntax checks**

Run: `bash -n ralph/ralph-review.sh && node --check server.js && node --test ralph/*.test.mjs`
Expected: all clean / all tests pass

- [ ] **Step 5: Commit**

```bash
git add ralph/review-revision.md ralph/ralph-review.sh server.js
git commit -m "feat(revise): diff-focused revision review — --revision flag + review-revision.md addendum"
```

---

### Task 4: Deploy + live verification on a real revise

**Files:**
- None created — deploy + observe. (Restart is needed because Tasks 2–3 touched `server.js`.)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Restart the service**

```bash
systemctl restart webtmux && journalctl -u webtmux -n 20 --no-pager
```

Expected: clean boot, `initRalphRuns` re-registers runs, no import errors.

- [ ] **Step 2: Stub-level sanity (no spend)**

The revise path has no dedicated stub harness; the cheap check is the pure seam plus prompt assembly:

```bash
node --test ralph/revise-scope.test.mjs
cat ralph/review.md ralph/review-revision.md | grep -c "Revision review"
```

Expected: tests pass; grep prints `1` (the addendum exists and concatenates cleanly after review.md, which is exactly what the script does).

- [ ] **Step 3: Live verification (small real spend, ~5 min)**

Revise a finished toy build (hello-card / grok-media-test) with a one-liner, e.g. "change the card headline to WELCOME BACK — nothing else":

- `POST /api/ralph/revise` (UI ✎ Revise tab), then watch `~/.webtmux/ralph/<tenant>--<project>.json` events.
- **Success criteria:** the added story has ≤4 acceptance criteria, `revision: true`, and NO `media` field; the review session command line contains `--revision 1` (visible in `journalctl` sudo lines); the story merges on **attempt 1**; if it does get rejected, the events feed shows the master's real one-line reason (not "did not meet acceptance criteria").

- [ ] **Step 4: Checkpoint commit + docs**

```bash
git add -A docs/
git commit -m "docs(plan): revise-efficiency — mark shipped, record live-verify results"
```

Also update the memory file `ralph-clarify-orchestration-roadmap.md` (or add a `revise-efficiency` memory) noting the shipped behaviour, per the repo's memory convention.

---

## Explicitly out of scope (deferred by design, 2026-07-02)

- **Greenfield planning/review changes** — revisit after watching greenfield reject rates ("revisions only" user decision).
- **Fast-path tiny revisions** (skip/cheapen the agentic review for small diffs) — biggest wall-clock win but removes the safety net; reconsider only if revise still feels slow after this ships.
- **429 backoff on rate-limited stories** — separate concern, noted in the perplexity/apify plan pickup list.
