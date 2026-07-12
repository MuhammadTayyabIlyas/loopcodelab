# Brownfield Ralph — Adopt an Existing Project + Research Pass — Design

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** Claude (pair) + tayyabcheema777

## 1. Problem & goal

Ralph today is **greenfield only**: `startRalphRun` plans from an *idea* and builds in a
freshly `git init`-ed repo. The user has existing directories (some are working apps) and
wants to **adopt one as a Ralph project and run autonomous agents on it**. Because there
is already code, Ralph must **explore it first** (greenfield has nothing to research),
*then* take the user's change instructions.

**The flow the user wants (kept deliberately simple):**
> user gives a path → Ralph copies it in → explores it (writes RESEARCH.md) → user gives
> the idea/change → Ralph executes the change (normal build flow, now code-aware).

### Decisions (resolved in brainstorming)
- **Adoption:** copy a **local absolute path** into `PROJECTS_ROOT/<project>`; the original
  is untouched.
- **Research:** a **single CLI master-agent run** explores the repo (read-only) and commits
  **`RESEARCH.md`**; it records build/test commands but does **not** run them (keep it simple).
- **Ordering:** **research first, then instruct** — research runs automatically on adopt,
  the user reads `RESEARCH.md`, then gives the build idea.
- **Path policy:** any absolute path readable by the service user, with hard validation +
  an optional `WEBTMUX_ADOPT_ROOT` allowlist.

### Non-goals
SSH/remote clone (deferred — clone-work-push is a later phase); running agents ON a remote
host; adopting non-directory sources; mutating the user's original directory.

## 2. Grounding in existing code (verified)

- `startRalphRun({project, idea, master, workers, …, prd})` (server.js:2179) creates a run;
  uses a passed `prd` or `planPrd(...)`.
- `gitInitProject(dir)` (server.js:413) **no-ops if the dir is already a git repo**
  (`if (await isGitRepo(dir)) return false`) — so an adopted repo's history is preserved
  and a non-repo gets initialized. Adds the standard `.gitignore`/`.gitattributes`.
- `planPrd({idea, master, workers, answers, outputFormat, tenant})` (server.js:773) builds
  the planner prompt from `ralph/planner.md` + the idea; **no codebase context today**.
- `spawnFinalize(run)` (server.js:1676) is the template for a one-shot master-agent run
  that writes a result file — the research pass mirrors it.
- Per-project **context file** mechanism already exists (`/api/projects/:name/context`,
  `CONTEXT_FILE`) — `RESEARCH.md` is committed in the repo instead (it's a deliverable the
  agents read), but the pattern confirms per-project docs are normal.
- Worker briefs (`writeRalphBrief`, server.js:1626) already inject standing notes — the
  research summary feeds in the same way.

**Consequence:** the entire downstream build pipeline (worktrees, workers, master review,
merge, finalize, prefs, index) is **unchanged**. Brownfield adds a short front-end:
adopt → research → instruct → (existing flow).

## 3. Run lifecycle (new phases prepended)

```
POST /api/ralph/adopt {project, sourcePath, master, workers, outputFormat}
   → validate + copy → register run, phase = 'researching'
ralphTick / spawn:  research agent runs → commits RESEARCH.md → phase = 'awaiting' (instructions)
POST /api/ralph/instruct {project, idea}
   → planPrd(idea + RESEARCH.md context) → commit prd.json → phase = 'building' → (existing flow)
```

New phases: `researching`, `awaiting` (waiting for the user's idea). All existing phases
(`building`/`finalizing`/`done`/…) unchanged.

## 4. Components

### 4.1 Adopt — copy a local path in
`POST /api/ralph/adopt` body `{ project, sourcePath, master, workers, outputFormat }`:
- **Validate** `sourcePath`: `realpath` it; must exist and be a **directory** the service
  user can read; reject `/`, `/etc`, `/root`, `/boot`, `/sys`, `/proc`, the webtmux repo
  dir, and `PROJECTS_ROOT` itself / anything already under it (no self-adopt). If
  `WEBTMUX_ADOPT_ROOT` is set, the realpath must be inside it. Reject if the project name
  already exists.
- **Copy** into `dest = PROJECTS_ROOT/<slugify(project)>`:
  - If `sourcePath` is a git repo → `git clone <sourcePath> <dest>` (preserves history,
    copies only tracked content — skips `node_modules`, untracked, ignored cruft).
  - Else → `cp -a <sourcePath>/. <dest>` then `gitInitProject(dest)`.
  - Multitenant: copy AS the tenant into their sandbox (mirror how runs are created), via
    `tenantExecArgs`. Single-tenant: as the app user.
- Set the git identity on `dest` (reuse `gitInitProject`'s config step, even for clones, so
  commits have an author).
- **Register** the run (`startRalphRun` extended with `mode:'brownfield'`, no `idea`/`prd`
  yet) at phase `researching`, persist, and kick the research spawn.

### 4.2 Research — one-shot agent explore → RESEARCH.md
- New prompt `ralph/research.md`: instructs the agent to explore the repo **read-only** and
  produce `RESEARCH.md` with: project purpose (best inference), **stack/languages**,
  **architecture & key directories**, **entry points**, **how to build/run/test** (commands
  it finds — *do not run them*), **current state** (inferred), **notable risks/TODOs**, and
  a one-paragraph summary. End with the sentinel `<promise>COMPLETE</promise>`.
- New `spawnResearch(run)` mirrors `spawnFinalize`: launches the **master** agent in the
  project dir via a new `ralph/ralph-research.sh` (same shape as `ralph-finalize.sh`:
  honors `--tool`, bypass, optional `--model`; writes a result file `.ralph/research.done`).
  Stub mode (`RALPH_FORCE_TOOL=stub`) writes a placeholder RESEARCH.md + done sentinel.
- The tick reaps `.ralph/research.done` (and a `RALPH_STALL_MS` guard, like other phases),
  commits `RESEARCH.md` (`git add RESEARCH.md && commit`), sets phase `awaiting`, and
  records an event. Surfaced via `GET /api/ralph/research?project=` (returns RESEARCH.md)
  and an event in the run status.

### 4.3 Instruct — idea + research → plan → build
`POST /api/ralph/instruct` body `{ project, idea }` (run must be in phase `awaiting`):
- Read `RESEARCH.md` from the run dir.
- `planPrd({ idea, master, workers, outputFormat, tenant, research })` — **new `research`
  param** injected into the planner prompt. `ralph/planner.md` gains a brownfield block
  (used only when `research` is present): *"You are modifying an EXISTING codebase,
  summarized below. Stories must fit the existing structure and conventions; DO NOT
  recreate what already exists; prefer minimal, targeted changes; reference real files."*
  + the RESEARCH.md text.
- Commit `prd.json`, set phase `building`, and hand off to the **existing** tick flow
  (workers branch off the adopted `main`, master reviews/merges/finalizes).
- `RESEARCH.md` is also passed to `writeRalphBrief` (a `research` note) so workers get
  codebase awareness, mirroring `masterNotesForBrief`.

### 4.4 UI
- Dashboard: an **"Adopt existing project"** entry (alongside "New build") — fields: project
  name + server path. Submits to `/api/ralph/adopt`.
- A run in phase `researching` shows a spinner ("Exploring the codebase…"); in `awaiting`
  it shows **RESEARCH.md** (rendered) + an **instructions** textarea → `/api/ralph/instruct`.
- Reuse the existing build-status views for the rest. PWA: bump `sw.js`. (React SaaS:
  optional parity, can follow.)

## 5. Data flow

```
adopt(path) ─validate─▶ git clone|cp -a ─▶ gitInitProject(no-op if repo) ─▶ run@researching
ralphTick ─▶ spawnResearch (master agent) ─▶ RESEARCH.md + .ralph/research.done ─▶ commit ─▶ run@awaiting
instruct(idea) ─▶ planPrd(idea + RESEARCH.md) ─▶ prd.json ─▶ run@building ─▶ [unchanged build flow]
```

## 6. Error handling & edge cases
- Invalid/unreadable/`!directory` source, or outside `WEBTMUX_ADOPT_ROOT` → 400 with a
  clear message; nothing copied.
- Project name already exists → 409 (don't clobber).
- Copy failure (disk, perms) → run not created; surfaced as an error.
- Research agent stalls / writes no sentinel → `RALPH_STALL_MS` reaps it; the run still
  enters `awaiting` with a minimal auto RESEARCH.md ("research incomplete — proceeding")
  so the user isn't stuck; an `attention` note records it.
- Research produced but empty/garbage → still allow instruct; planner just gets thin context.
- Huge source tree → a size cap (e.g. `WEBTMUX_ADOPT_MAX_MB`, default 500) checked before
  copy; over → 400. `node_modules` is skipped for git repos (clone) and SHOULD be excluded
  for `cp` (copy with an exclude, or copy then `rm -rf node_modules`).
- Restart mid-research: `initRalphRuns` re-registers `researching`/`awaiting` runs (they're
  in the persisted state) so the tick resumes / the awaiting gate persists.

## 7. Security
- Path validation (realpath, directory-only, denylist of system paths + repo + PROJECTS_ROOT,
  optional allowlist root, size cap) — the only new untrusted input.
- The adopt endpoint is behind the dashboard's existing auth (basic-auth single-tenant /
  `requireAuth` multitenant), like all `/api/ralph/*`.
- Agents already run in bypass/yolo on project code — adopting code doesn't change the trust
  model (the user chose to run agents on it); research is read-only by prompt but bypass is
  on, so the denylist + "don't run build/test" prompt are the guardrails, not a sandbox.
- Multitenant: copy AS the tenant; the source must be readable by the tenant user.

## 8. Testing (no spend)
- **Path validation unit tests** (pure module `ralph/adopt-paths.mjs`: `validateSource(path,
  {root, denylist})` → ok/error): rejects non-dir, traversal, system paths, outside-root;
  accepts a normal dir. `node --test`.
- **Adopt + research + instruct (stub):** with `RALPH_FORCE_TOOL=stub` + `RALPH_FAKE_REMOTE`,
  `POST /api/ralph/adopt` a small fixture git repo → assert it's copied (history preserved),
  phase reaches `awaiting`, RESEARCH.md exists (stub placeholder); `POST /api/ralph/instruct`
  with a `prd` → reaches `building`→`done`. Verifies the brownfield front-end + that it
  hands off to the unchanged build flow.
- **Git-clone vs cp path:** adopt a git fixture (clone path) and a plain-dir fixture (cp
  path); assert both produce a valid repo on `main`.
- Gates: `node --check server.js`, `bash -n ralph/ralph-research.sh`, `node --check public/js/dashboard.js`.

## 9. File-by-file change list
| File | Change |
|---|---|
| `ralph/adopt-paths.mjs` (new) + test | Pure source-path validation. |
| `ralph/research.md` (new) | Research-pass prompt. |
| `ralph/ralph-research.sh` (new) | One-shot research runner (mirror of ralph-finalize.sh). |
| `server.js` | `POST /api/ralph/adopt`, `POST /api/ralph/instruct`, `GET /api/ralph/research`; `spawnResearch`; `researching`/`awaiting` phases in the tick (reap + stall); `startRalphRun` accepts `mode:'brownfield'` (no idea/prd until instruct); `planPrd` gains `research` param; copy logic (clone/cp + validation). |
| `ralph/planner.md` | Brownfield block (used when `research` present). |
| `public/index.html`, `public/js/dashboard.js`, `public/sw.js` | Adopt entry + research view + instruct box; sw bump. |
| `CLAUDE.md` | Document brownfield adopt + research. |

## 10. Open decisions (resolved)
1. Research agent = the chosen **master** (claude/codex). (Adopted.)
2. Research is **read-only** (records but doesn't run build/test). (Chosen — "keep it simple".)
3. Path policy = **any readable abs path** + validation + optional `WEBTMUX_ADOPT_ROOT`. (Decided.)
4. SSH/remote = **out of scope** (later phase). (Decided.)

## 11. Rollout
1. `adopt-paths` module + tests.
2. Adopt API + copy logic (no research yet — lands at `awaiting` with a stub RESEARCH.md).
3. Research prompt + script + `spawnResearch` + tick reap → real RESEARCH.md.
4. Instruct API + planner brownfield context → hands to the existing build flow.
5. UI (adopt entry, research view, instruct box) + sw bump + docs.
Each step is independently testable; brownfield is additive and never touches the greenfield path.
