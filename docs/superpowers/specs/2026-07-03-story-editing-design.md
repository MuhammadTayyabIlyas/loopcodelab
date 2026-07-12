# Story-Level Editing: Edit / Regenerate / Add / Schedule Individual Stories — Design

**Date:** 2026-07-03 · **Status:** approved approach (A: rebuild-on-top), spec for implementation planning

## Problem

A user who dislikes ONE story's outcome in a build today has no direct path:
- Mid-build stories can be edited (`POST /api/ralph/story-edit` + the BuildDetail ✏ Edit dialog), but the buttons are hover-revealed (`opacity-0 group-hover`) — invisible on touch devices.
- **Merged stories on a finished build cannot be edited or rebuilt at all** — the server returns 409 "use Revise", which forces a planner round-trip (and Revert is a separate manual step).
- Adding a story requires the Revise planner even when the user knows exactly what they want.
- There is no way to time a story's (re)build — e.g. run it during off-peak subscription hours (the Track dialog already records those hours; nothing consumes them).

## What exists and is reused (decision: Approach A, rebuild-on-top)

Regenerating a merged story does **not** touch git history. The story re-queues as a
**revision**: the worker builds on the current `main` (the old code is present), and
`revision: true` switches the master to the diff-focused review that shipped with
Revise. The run re-enters `building`, re-merges, **re-finalizes, and re-pushes** —
exactly the lifecycle `POST /api/ralph/revise` already drives
(`server/routes/ralph.mjs:385`). Revert stays a separate explicit undo. The
revert-then-rebuild alternative was rejected: merge-commit reverts conflict when later
stories built on the code, and a conflicted revert leaves the run in a state the tick
cannot recover.

Reused rails:
- `story-edit`'s kill-in-flight → reset-to-`todo` → `ralphTick()` machinery.
- Revise's `revision: true` diff-review flag and `phase = 'building'` re-entry (finalize re-runs automatically when all stories are resolved — engine tick step 4).
- The draft start-timer pattern for scheduling (server clock fires it; push notification on fire) — applied per story, but WITHOUT a new tick: the existing 4s `ralphTick` spawn gate simply skips not-yet-due stories.

## Design

### 1. Pure helpers — `ralph/story-ops.mjs` (+ `story-ops.test.mjs`)

Per the repo's testing pattern (pure logic in a focused `ralph/*.mjs`):
- `normalizeNewStory(input, existingIds, validAgents)` → `{ story } | { error }` — validates/clamps a manual story: `title` (required, ≤200), `description` (≤4000), `acceptanceCriteria` (string[], each ≤500, ≤20), optional `agent` ∈ validAgents, optional `deps` ⊆ existingIds; assigns `id = s<N+1>`, `branch = prd/<id>`, `status: 'todo'`, `iterations: 0`.
- `clampStoryStart(startAt, now)` → `number | null` — accepts an epoch-ms number; clamps to `[now + 15s, now + 30d]` (same bounds as draft `scheduleAt`); anything invalid → `null` (= start immediately).
- `canEditStory(status)` / `isRegenerate(status)` — `merged` → regenerate path; `reverted` stays uneditable (its code is gone from main; a regenerate would be a lie — use Add story); everything non-settled → plain edit.

### 2. Server: extend `story-edit`, add `story-add`, gate the tick

**`POST /api/ralph/story-edit` (extended, back-compatible):**
- Accepts `merged` stories when the run is NOT `building`/`finalizing`/`delivering` (same guard as Revise). For a merged story: delete the stale `prd/<id>` branch (`git branch -D`, best-effort) so the worktree branches **fresh off current main**, set `revision: true`, reset `status: 'todo'`, `iterations: 0`, phase → `building`. The old merge commit is untouched.
- `reverted` stories remain 409 (message: "This story was reverted — add a new story instead.").
- New optional field `startAt` (epoch ms): stored via `clampStoryStart` as `story.startAt`; `startAt: null` explicitly clears an existing schedule (the UI's cancel ✕).
- Event/log lines distinguish "edited" vs "regenerating" vs "scheduled for <time>".

**`POST /api/ralph/story-add`** `{project, title, description, acceptanceCriteria?, agent?, deps?, startAt?}`:
- Guard: 409 only while `finalizing`/`delivering`/`windows-delivering` (the finalize/deliver briefs are already written); adding during `building` is allowed — the new story is just another `todo` the tick picks up. Agent defaults to the run's master; credential-checked via `missingAgentCreds` like story-edit.
- `normalizeNewStory` shapes it; `revision: true` **iff `run.phase` was `done`/`failed` at add time** (the app exists, review should be diff-focused); `false` when adding mid-build. No per-story `media` plan (planner-owned; manual stories generate no media).
- Push story, phase → `building`, write `prd.json` (`prdFileShape`), `gitCommitAll('plan: add <id> (manual)')`, `recordPrefSignal({type:'story-add', …})`, persist, kick tick. Returns `runSummary(run)`.

**Tick gate (one line + clear-on-spawn), `server/ralph-engine.mjs` step 3 (~line 1268):**
```js
if (story.status !== 'todo') continue;
if (story.startAt && story.startAt > Date.now()) continue;   // ⏰ not due yet
```
On spawn: `story.startAt = null` and push "⏰ <project>: scheduled story <id> started" (`sendPush` + `sendPushRun`, the draft-timer pattern).
**Semantics (deliberate):** a scheduled story keeps the run in `building` until it fires — the re-finalize must come after the rebuild, so the run truthfully stays "in progress" (the UI shows why via the ⏰ chip). Stall detection is unaffected (`agentStalled`/hard-cap only examine `building`/`review` stories, never `todo`). Paused runs already spawn nothing; pause + schedule compose naturally (fires only once unpaused AND due).

**`runSummary` stories** gain `startAt` and `revision` (both currently omitted from the per-story projection) so both UIs can render chips. Persistence needs no work: `persistRun` serializes whole story objects to the run-state JSON (which `initRalphRuns`/`loadRun` restore), so `startAt`/`revision` survive restarts; `prd.json` (`prdFileShape`, the agent-facing file) intentionally stays unchanged — agents don't need scheduling metadata.

### 3. Web UI (`web/src/pages/BuildDetail.jsx`, `web/src/api.js`)

- **Touch fix:** story action buttons always visible (drop `opacity-0 group-hover:opacity-100`; keep the quiet ghost style).
- **Merged rows** get **↻ Regenerate** (next to Revert), opening the existing `StoryEditDialog` with copy adjusted: title "↻ Regenerate <id>", note "Rebuilds this story on top of the current app with your edited instructions, then re-finalizes and re-pushes. The previous version stays in git history.", primary button "Regenerate story".
- **`+ Add story`** button beside the "Stories" heading → the same dialog shape with empty fields (title required), agent defaulting to the run's master, primary button "Add & build".
- **Schedule field** in both dialogs: one optional text input "Start (optional) — e.g. 2h, 30m, 1d, or 22:00". Client parses relative (`2h`/`30m`/`1d`, the `scheduleDraft` regex) or absolute `HH:MM` (next occurrence today/tomorrow) → epoch ms `startAt`. Blank = immediately.
- **Scheduled chip** on story rows: `⏰ in 1h 12m` (from `startAt`, the dashboard's `fmtEta` pattern) with a **▶ Start now** action that calls `editStory(project, id, { startAt: null })` — clearing the timer makes the story due immediately, so the action is named for what it does. Abandoning a scheduled story = the existing ⏭ Skip (which also clears any timer).
- `api.js`: `addStory(project, body)`; `editStory` passes `startAt` through.
- `EDIT_AGENTS` list in the dialog is replaced by the run's roster + `VALID_AGENTS` from `/api/keys` (the current hardcoded five omit kimi/grok/vibe — fix in passing since the dialog is being touched).

### 4. PWA (`public/js/dashboard/ralph.js`) — display only

Story rows in the status dialog render two passive labels when present: `⏰ scheduled` (with the countdown) and `↻ revision`. No new dialogs — build management lives in the web UI. Bump `public/sw.js` VERSION → `webtmux-v44`.

### 5. UX copy & user guidance (exact strings — the flows that need explaining)

Every place a click has non-obvious consequences gets one plain-language line, written
from the user's side of the screen (what happens, not how it works). These strings are
part of the spec, not implementation detail:

| Where | String |
|---|---|
| Stories section hint (finished builds only, one muted line under the heading) | `Regenerate any story with new instructions, add a new one, or revert a merged one — the build re-checks and re-publishes itself afterwards.` |
| Edit dialog note (unchanged behavior, existing copy kept) | `Saving stops the current attempt and rebuilds this story with the new instructions.` |
| Regenerate dialog note | `Rebuilds this story on top of the current app using your edited instructions, then re-checks and re-publishes the build. The previous version stays in git history — use Revert instead if you just want it gone.` |
| Add story dialog note | `Describe one self-contained change. It builds like any other story — on a finished build the agent changes the existing app rather than starting over.` |
| Schedule field label + placeholder | Label `Start (optional)`; placeholder `now — or 2h, 30m, 1d, or 22:00`; helper line `Runs on the server at that time — you don't need to keep this page open. Handy for off-peak hours on a subscription plan.` |
| Scheduled chip tooltip | `Starts automatically at <local time>. "Start now" begins immediately; Skip abandons it.` |
| Run status while only scheduled stories remain | Phase line shows `building · waiting for a scheduled story (⏰ in 1h 12m)` — so a "done-looking" build that re-entered building explains itself. |
| After-action feedback (the existing event feed, `recordRunEvent`) | edit: `✏ you edited s3 — rebuilding with the new instructions` (existing) · regenerate: `↻ you asked for s3 to be redone — rebuilding on the current app` · add: `＋ you added s9 — building it now` (or `— starts at <time>`) · start-now: `▶ s3 started early at your request` |
| Invalid schedule input | Inline, next to the field, never a dialog: `Couldn't read that time — use 2h, 30m, 1d, or a clock time like 22:00.` |
| 409 while finalizing/delivering | `The build is finishing up — try again in a minute, or pause it first.` |
| Push notification when a timer fires | `⏰ <project>: story s3 started` body `Your scheduled rebuild is running.` |

Rules for this copy (matching the product's existing voice): sentence case, active verbs, name the action by its effect ("Start now", never "Cancel timer"), consistent verbs across button → event → push ("Regenerate" everywhere, not "redo/rebuild/recreate" mixed), errors say what to do next, no jargon (no "worktree", "verdict", "revision flag" in user-facing text — "re-checks" not "re-reviews with --revision").

### 6. Invariants preserved

- The orchestrator alone writes `prd.json` (both routes write it on `main` and commit, as revise/story-edit do today).
- `maxAttempts` still bounds review→retry cycles for regenerated/added stories; `workerPasses` unchanged.
- Slugs/session names unchanged (`ralphSessionName` handles the same ids).
- No planner call anywhere in these paths — deterministic, no spend.
- Failure modes: regenerate on a run mid-build → 409; unknown story → 404; invalid agent/creds → 400 with the existing `missingKeysError` text; a scheduled story on a run that later fails elsewhere just sits in `todo` (visible, cancellable) — Doctor/skip/edit all still apply to it.

## Out of scope (explicit)

- Editing `reverted` stories (add a new story instead) · per-story media plans for manual stories · PWA editing dialogs · consuming Track's peak-hours to *suggest* a start time (future nicety; the field is free-text) · recurring schedules.

## Testing

- `node --test ralph/story-ops.test.mjs` — normalize/clamp/canEdit edge cases (empty title, dep on unknown id, startAt below/above clamp, merged vs reverted vs todo).
- Stub e2e (RALPH_FORCE_TOOL=stub, isolated instance): (1) finished stub run → `story-add` → phase `building` → auto re-finalize → `done` again, story count +1; (2) `story-edit` a merged story → rebuilds with `revision: true` → `done`; (3) `story-add` with `startAt = now + 20s` → story stays `todo` ≥ 15 s, spawns after, run completes; ✕ cancel path via `startAt: null`.
- UI probe (headless, the 2026-07-03 harness pattern): story action buttons visible without hover at touch viewport; Regenerate button present on a merged row; scheduled chip renders with "Start now" and clicking it clears `startAt`; the Stories hint line and the "waiting for a scheduled story" phase line render on a finished-build fixture (§5 copy verified verbatim for those two).
