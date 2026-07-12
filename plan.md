# Ralph Orchestrator — Implementation Plan

A "Ralph" mode in webtmux that turns a one-line idea into a finished, git-tracked,
auto-pushed project built by a team of CLI AI agents working in parallel.

## Roles
- **Planner** — OpenAI API (`gpt-5.4-mini`). Turns the user's idea into `prd.json`
  (a list of stories) and assigns each story to the most suitable CLI model.
- **Master** — one user-picked CLI (claude/codex/qwen/gemini/glm). Owns its assigned
  stories AND reviews every worker's output for quality before integrating, then
  "compiles" (merges green branches → main + full build/test) and finalizes.
- **Workers** — the other CLIs, run in bypass/yolo mode, each implementing its
  assigned stories via the Ralph loop.

## Confirmed decisions
- Workers run **in parallel** → **git worktree per story** (`prd/<id>` branch).
- Master **reviews quality before** merge/integrate/test.
- **Max 3 iterations** per loop. Master reviews completion; stalls escalate to master.
- **Git per project:** `git init` on create; commit per PRD; reversible via per-story
  branches; **auto-push to GitHub** on completion and on revisions.
- Secrets (OpenAI key, GitHub token) live server-side in `~/.webtmux/secrets.json`
  (chmod 600), never in client JS.

## Data model
`prd.json` (in repo):
```json
{
  "idea": "user prompt",
  "master": "qwen",
  "workers": ["gemini", "codex"],
  "stories": [
    { "id": "s1", "title": "...", "spec": "...", "assignee": "gemini",
      "deps": [], "status": "todo|building|review|merged|failed",
      "branch": "prd/s1", "iterations": 0 }
  ]
}
```
`progress.txt` — append-only learnings (Ralph convention).
`~/.webtmux/ralph/<project>.json` — orchestrator runtime: phase, session IDs,
branch status, iteration/spend counters.

## Orchestration phases (server-side)
1. **Init** — `git init`, write `prd.json`/`progress.txt`/`AGENTS.md`, first commit on `main`.
2. **Plan** — OpenAI call fills `stories[]` + `assignee`. Commit `prd.json`.
3. **Distribute (parallel)** — per story: `prd/<id>` branch + `git worktree add`;
   spawn one tmux session per worker running `ralph.sh` (bypass, cap 3 iters).
4. **Review + integrate (master, serialized)** — green branch → master reviews diff;
   accept ⇒ merge → main + full build/test; reject ⇒ bounce to worker.
5. **Finalize** — master reviews completion; all merged ⇒ `gh repo create` + push.

## Files to touch
- `public/index.html` — Ralph chip + new dialog (idea textarea, master picker,
  worker multi-select, iteration cap).
- `public/js/dashboard.js` — Ralph dialog logic + POST to endpoints; move hardcoded
  GLM key off the client.
- `server.js` — endpoints `POST /api/ralph/start`, `GET /api/ralph/status`,
  `POST /api/ralph/revise`, `POST /api/ralph/revert`; OpenAI planner call (fetch);
  orchestrator loop; git init/worktree/branch/merge/push helpers.
- `ralph/` (vendored) — `ralph.sh`, worker `prompt.md`, master-review prompt, planner prompt.
- `public/sw.js` — bump cache VERSION.

## Milestones
- [x] **M1 — Secrets plumbing.** `~/.webtmux/secrets.json` (OpenAI + GitHub + model),
  loaded by `server.js` (`openaiKey()`/`openaiModel()`/`githubToken()`, env-overridable),
  startup logs `ralph ready`. *(GLM-key move to server: pending, folded into M7.)*
- [x] **M2 — Git per project.** `git init -b main` + initial commit on project
  create (best-effort, reports `git:true`); helpers `git/isGitRepo/gitInitProject/
  gitCommitAll/gitAddWorktree/gitRemoveWorktree/gitMergeBranch/gitRevertMerge`.
  Verified the worktree→commit→merge→revert chain end-to-end.
- [x] **M3 — Vendor Ralph.** `ralph/`: `ralph.sh` (per-story, multi-tool, runs in a
  worktree, ≤3 attempts, completion via `<promise>COMPLETE</promise>`), `prompt.md`
  (worker, does NOT touch prd.json), `planner.md` (OpenAI system prompt), `review.md`
  (master), `stub-tool.sh` (test double). Loop verified end-to-end with the stub:
  commits on the story branch, prd.json untouched across branches.
- [x] **M4 — OpenAI planner.** `POST /api/ralph/plan` → normalised `prd.json`
  (stories + assignees + deps). Live call verified: `gpt-5.4-mini` valid, returned
  a clean 6-story PRD with cross-model assignments + dependency graph. Shared
  `normalizePrd()` also lets `/start` accept a pre-built prd (replay/test).
- [x] **M5 — Parallel distribution.** Orchestrator engine: `startRalphRun` (fresh
  repo → plan → commit prd) + `ralphTick` (every 4s: reap workers via `.ralph/<id>.exit`,
  merge branch→main, unblock deps, spawn unblocked stories in parallel via per-story
  worktree + tmux session). `POST /api/ralph/start`, `GET /api/ralph/status`. Verified
  end-to-end with the `RALPH_FORCE_TOOL=stub` dry-run: correct dep gating + merge order,
  worktrees cleaned, branches kept. *(M5 auto-merges on worker success; M6 inserts review.)*
- [x] **M6 — Master review → compile → push.** State machine: worker done → master
  review (`ralph-review.sh`, ACCEPT/REJECT) → ACCEPT merges, REJECT retries with the
  reason (<max) else fails → all merged → master finalize/build-test (`ralph-finalize.sh`,
  PASS/FAIL) → on PASS auto-push to a **private** GitHub repo (created via API, token
  auth). Test hook `RALPH_FAKE_REMOTE` pushes to a local bare repo. Verified end-to-end
  with the stub: full phase progression + identical history on the fake remote.
- [x] **M7 — Ralph dialog UI.** Header `🤖 Ralph` button → start dialog (project,
  idea, master picker, worker multi-select, max attempts, + in-progress builds) →
  live status dialog polling `/api/ralph/status` (phase + per-story badges + repo
  link). Moved GLM key out of client JS (server keeps it for `resolveLaunch`). Bumped
  sw.js → v13. Verified served markup/JS, client parse, key removal.
- [x] **M8 — Revise/revert endpoints.** `POST /api/ralph/revert` (roll back a merged
  story via `git revert -m 1`, mark `reverted`, re-push) and `POST /api/ralph/revise`
  (plan + append renumbered stories, rebuild, auto-push). `loadRun` reloads from
  persisted state so both survive a restart. Verified build→revert→revise reaches
  `done`. Fixed a bug found here: a `reverted` story must not block finalize
  (terminal check now = "no active + no failed → finalize", not "all merged").

## Post-M8 enhancements (all stub-verified)
- Two-step UI: **Plan stories → Confirm the plan → build** (`/plan` then `/start`), so stories are reviewed before any agent runs.
- Per-run **bypass toggle** (default on; `RALPH_BYPASS=0` drops dangerous-skip/yolo in all 3 scripts).
- Split caps: **`maxAttempts`** (master retries, def 3) vs **`workerPasses`** (`ralph.sh --max`, def 1) — no longer compound.
- **Web Push on completion** (`notifyRalphDone`, reuses VAPID pipeline; needs notifications enabled).
- SW **network-first for app JS/CSS** (v15) — fixes new-HTML-with-stale-JS (the unresponsive-button bug).
- GitHub: classic `ghp_` PAT (create+push verified); `pushToGitHub`→`ensureRemote`+`gitPushRef`.
- **Option 2 — build on GitHub live:** repo created at *start*, scaffold pushed; each story **branch pushed on worker finish**; **`main` pushed after every merge**; finalize does a last push. All best-effort (`gitPushRef` never throws; `pushWarning` surfaced in status/UI). Verified: scaffold + `prd/*` branches + per-merge main all land on the remote during the run.

## Project preview links (live, 2026-05-26)
Each project is served at **`https://<project>.tayyabcheema.com`** (public, read-only):
- **App** → serves static output (`build/web`→`dist`→`build`→`out`→`public`→root `index.html`) with SPA fallback.
- **No web output** → click-to-download file browser (hides `.git`/`.ralph`/`.worktrees`/`node_modules`).
- nginx wildcard vhost `*.tayyabcheema.com` → webtmux preview server (Host-routed); exact vhosts still win.
- **Wildcard TLS** `*.tayyabcheema.com` via Hostinger DNS-01: token in `/root/.secrets/hostinger.token`,
  hooks in `/etc/letsencrypt/hostinger/{auth,cleanup}.sh` (touch only `_acme-challenge` TXT); auto-renews.
- Planner now targets static-servable stacks (no Flutter — not installed; npm/python3 are). Dashboard
  status shows the "Open live / files" link (`previewUrl` in runSummary).
- Live merge-conflict fixes also landed (abort-on-conflict, rebuild-on-current-main retry, `progress.txt` union merge).

## Live server apps + zip download (2026-05-26)
- **Live server apps:** `resolveServe()` picks static (build dir/index.html) → server
  (webtmux.json `{type:server,command,install}`, or package.json `start`, or python
  app.py/main.py) → file browser. Server apps run via tmux session `app-<project>` on
  an allocated port 9000–9100 (`PORT` env), reverse-proxied by webtmux; start on first
  request, idle-stop after 15 min (`WEBTMUX_APP_IDLE_MS`). Preview middleware moved
  BEFORE `express.json` so the proxy gets the raw body. Verified with a Node app.
- **Download .zip:** `?zip` on any project streams `zip -rq` (excludes git/agent/heavy
  dirs); "Download project as .zip" link in the file browser. Verified.
- Planner/finalize updated: server apps must bind `$PORT` + ship `webtmux.json`.
- **Env-aware planning** earlier: `detectEnvironment()` feeds installed tools to the
  planner; box has node/npm/pnpm/python3/pip3 + full C toolchain/sqlite/imagemagick;
  no flutter/dart; tmuxweb has no sudo (agents self-install project deps only).

## Builds gallery + stall timeout (2026-05-26)
- **📁 Builds** header button → dialog of detail cards per project (phase badge,
  N/M merged, live link, repo link, Details→live status). Backed by `listRuns()`
  (persisted + in-memory, newest first), so the no-arg `/api/ralph/status` lists all.
- **Stall timeout (`RALPH_STALL_MS`, 8 min):** a story stuck building/reviewing past
  it (agent hung/crashed without writing exit/verdict) is reaped + retried on current
  main, up to maxAttempts. `story.phaseSince` tracks entry. Found via a real stall:
  glm master-review died under `set -e` before writing a verdict → story hung forever.
- **Review/finalize scripts now always write a verdict/result** (`|| true`) so a tool
  failure can't hang the orchestrator.

## Builds: delete, README, ETA, agent-swap-on-failure (2026-05-26)
- **Delete** `DELETE /api/ralph/:project`: kills the project's sessions (workers/review/
  finalize/app), removes worktrees + dir + state json. 🗑 button on each build card (confirm).
- **README** `ensureReadme(run)` at finalize: writes a README from prd (title, idea, live
  link, stories, how-built) if none/short, commits + pushes. finalize.md also asks the master for a rich one.
- **ETA/elapsed** in runSummary (`startedAt`/`elapsedMs`/`etaMs` = avg-per-merged × remaining);
  shown in status dialog + cards.
- **Agent-swap-on-failure:** runSummary `attention` (failed stories + their agents + master)
  → status dialog shows a banner with "Switch master to: [agents]"; `POST /api/ralph/swap`
  {project, role:'master'|storyId, agent} reassigns + re-queues failed stories + resumes.
  So a dead LLM never fails silently — the user is prompted to pick another. Verified all.

## Status: all milestones complete; engine + UI stub-verified end-to-end.
Not yet done: a LIVE run with real CLIs + a real private GitHub push (held by choice
until now). Test hooks (`RALPH_FORCE_TOOL`, `RALPH_FAKE_REMOTE`, `/start` `prd`) remain
in place and are inert unless explicitly set.

## Notes / risks
- Credentials were shared in plaintext chat → rotate after verification.
- Cost control: hard 3-iteration cap; consider per-project spend ceiling.
- Completion detection: prefer `prd.json` all-`merged` + exit code over idle heuristic.
- Exact OpenAI model string (`gpt-5.4-mini`) may need adjusting to the real API id.
