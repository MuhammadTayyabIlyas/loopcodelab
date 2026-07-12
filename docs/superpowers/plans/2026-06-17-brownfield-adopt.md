# Brownfield Ralph — Adopt an Existing Project + Research Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user adopt an existing local directory as a Ralph project — copy it in, run a one-shot agent **research pass** that writes `RESEARCH.md`, then take the user's change instructions and run the normal (now code-aware) build flow.

**Architecture:** A short front-end pipeline (`adopt → research → instruct`) prepended to the unchanged build flow. `adoptRalphRun` copies the source (git-clone if a repo, else `cp -a` + `gitInitProject`) and lands the run at phase `researching`; `spawnResearch` (a clone of `spawnFinalize`) runs the master agent to produce `RESEARCH.md`; the tick reaps it → phase `awaiting`; `POST /api/ralph/instruct` plans with `RESEARCH.md` as context → phase `building` → existing pipeline.

**Tech Stack:** Node 22 ESM, Express, tmux PTY bridge, bash worker scripts, vanilla-JS PWA.

## Global Constraints

- **ESM** (`package.json` `"type":"module"`): `import`/`export`. No project test runner — pure logic in importable modules tested with `node --test`. Syntax-gate: `node --check server.js`, `bash -n ralph/ralph-research.sh`, `node --check public/js/dashboard.js`.
- **Additive only:** the greenfield path (`startRalphRun`, `planPrd` without research, the build/finalize tick) must remain byte-for-byte behaviorally unchanged.
- **New phases:** `researching` (agent exploring), `awaiting` (waiting for the user's idea). Existing phases unchanged.
- **Adoption = copy a local path in.** `dest = path.join(projectsRoot, slugify(project))`. The user's original directory is **never modified**.
- **Copy rule:** if the source is a git repo → `git clone <src> <dest>` (preserves history, copies only tracked content). Else → `cp -a <src>/. <dest>` then `gitInitProject(dest)`. Multitenant: run the copy AS the tenant (`tenantExecArgs`); single-tenant: as the app user.
- **Path policy:** source must be an absolute path, `realpath`-resolved, an existing **directory**, NOT a system path (`/ /etc /root /boot /sys /proc /dev /usr /bin /sbin /var /lib`), NOT the webtmux repo dir, NOT inside `PROJECTS_ROOT`; if `WEBTMUX_ADOPT_ROOT` is set, must be inside it. Size cap `WEBTMUX_ADOPT_MAX_MB` (default 500).
- **Research is read-only by prompt** (records build/test commands; does NOT run them). Stub mode (`RALPH_FORCE_TOOL=stub`) writes a placeholder RESEARCH.md + done sentinel.
- **Research agent = the run's `master`.**
- **Brownfield planner context:** when `planPrd` gets a `research` string, `ralph/planner.md`'s brownfield block applies: *"modify this EXISTING codebase; stories must fit it; do not recreate what exists; prefer minimal targeted changes; reference real files."*
- **PWA cache rule:** any `public/` change requires bumping `VERSION` in `public/sw.js`.

---

### Task 1: `ralph/adopt-paths.mjs` — source-path validation + tests

**Files:**
- Create: `ralph/adopt-paths.mjs`
- Test: `ralph/adopt-paths.test.mjs`

**Interfaces:**
- Consumes: `node:path` only (pure path policy; the caller does realpath/stat/size).
- Produces: `validateSource(srcRealpath, { projectsRoot, repoDir, allowRoot })` → `{ ok:true, path } | { error }`; `DENY_DIRS` (string[]).

- [ ] **Step 1: Write the failing tests**

Create `ralph/adopt-paths.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, DENY_DIRS } from './adopt-paths.mjs';

const cfg = { projectsRoot: '/home/tmuxweb/projects', repoDir: '/var/www/app', allowRoot: '' };

test('accepts a normal directory', () => {
  assert.deepEqual(validateSource('/home/me/myapp', cfg), { ok: true, path: '/home/me/myapp' });
});
test('rejects a relative path', () => {
  assert.ok(validateSource('myapp', cfg).error);
});
test('rejects system directories', () => {
  for (const d of ['/', '/etc', '/root', '/usr', '/var']) assert.ok(validateSource(d, cfg).error, d);
  assert.ok(DENY_DIRS.includes('/etc'));
});
test('rejects the webtmux repo and its subdirs', () => {
  assert.ok(validateSource('/var/www/app', cfg).error);
  assert.ok(validateSource('/var/www/app/ralph', cfg).error);
});
test('rejects paths inside PROJECTS_ROOT (no self-adopt)', () => {
  assert.ok(validateSource('/home/tmuxweb/projects/foo', cfg).error);
});
test('enforces allowRoot when set', () => {
  const c = { ...cfg, allowRoot: '/srv/code' };
  assert.ok(validateSource('/home/me/x', c).error);
  assert.deepEqual(validateSource('/srv/code/x', c), { ok: true, path: '/srv/code/x' });
});
test('strips a trailing slash', () => {
  assert.deepEqual(validateSource('/home/me/app/', cfg), { ok: true, path: '/home/me/app' });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test ralph/adopt-paths.test.mjs`
Expected: FAIL — `Cannot find module './adopt-paths.mjs'`.

- [ ] **Step 3: Implement the module**

Create `ralph/adopt-paths.mjs`:

```js
// Pure source-path policy for brownfield adoption. The caller realpaths the input and
// confirms it is a directory + within the size cap; this module decides if the (already
// resolved, absolute) path is allowed to be adopted. No I/O — unit-tested in isolation.
import path from 'node:path';

// Never copy from these (or their subtrees). The system roots + common FHS dirs.
export const DENY_DIRS = ['/', '/etc', '/root', '/boot', '/sys', '/proc', '/dev', '/usr', '/bin', '/sbin', '/var', '/lib', '/lib64'];

const under = (p, base) => p === base || p.startsWith(base.replace(/\/+$/, '') + path.sep);

export function validateSource(srcRealpath, { projectsRoot, repoDir, allowRoot = '' } = {}) {
  if (!srcRealpath || typeof srcRealpath !== 'string' || !path.isAbsolute(srcRealpath)) {
    return { error: 'Source path must be an absolute path.' };
  }
  const p = srcRealpath.replace(/\/+$/, '') || '/';
  if (DENY_DIRS.includes(p)) return { error: 'Refusing to adopt a system directory.' };
  if (repoDir && under(p, repoDir)) return { error: 'Cannot adopt the webtmux repo itself.' };
  if (projectsRoot && under(p, projectsRoot)) return { error: 'Source is already under the projects root.' };
  if (allowRoot && !under(p, allowRoot)) return { error: `Source must be inside ${allowRoot}.` };
  return { ok: true, path: p };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test ralph/adopt-paths.test.mjs`
Expected: PASS, all green.

- [ ] **Step 5: Commit**

```bash
git add ralph/adopt-paths.mjs ralph/adopt-paths.test.mjs
git commit -m "feat(brownfield): source-path validation module + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Research prompt + runner script

**Files:**
- Create: `ralph/research.md`
- Create: `ralph/ralph-research.sh`

**Interfaces:**
- Consumes: `--tool <agent>`, `--dir <projectDir>`, `--result <file>`, optional `--model`; env `RALPH_BYPASS`, `RALPH_FORCE_TOOL`.
- Produces: writes `RESEARCH.md` into the project dir and `PASS`/`FAIL` into the result file (a `.ralph/research.done` sentinel the tick polls). Stub → placeholder RESEARCH.md + PASS.

- [ ] **Step 1: Create the research prompt**

Create `ralph/research.md`:

```markdown
You are exploring an EXISTING codebase so an autonomous build team can safely change it.
Work READ-ONLY: read and analyze files. Do NOT install dependencies, build, run, or
execute the project, and do NOT modify any source file.

Produce a single file `RESEARCH.md` in the repo root with these sections:
- **Summary** — one paragraph: what this project appears to be and its current state.
- **Stack & languages** — languages, frameworks, package managers, runtime versions.
- **Architecture & key directories** — the important folders/modules and what they do.
- **Entry points** — where execution starts (main files, servers, CLIs).
- **Build / run / test** — the commands you find in package.json/Makefile/README/CI
  (list them; DO NOT run them).
- **Current state** — inferred from the code (complete? partial? notable bugs/TODOs?).
- **Risks & gotchas** — anything a change agent must know (auth, migrations, generated files).

Write `RESEARCH.md`, then end your reply with the exact line:
<promise>COMPLETE</promise>
```

- [ ] **Step 2: Create the runner script (mirror of ralph-finalize.sh)**

Create `ralph/ralph-research.sh`:

```bash
#!/bin/bash
# One-shot codebase research pass over an adopted project. Writes RESEARCH.md and then
# "PASS"/"FAIL" to the result file, exits 0. RALPH_FORCE_TOOL=stub => placeholder + PASS.
# Usage: ralph-research.sh --tool T --dir PROJECT_DIR --result FILE [--model M]
set -uo pipefail
TOOL=""; DIR="."; RESULT_FILE=""; MODEL=""
while [[ $# -gt 0 ]]; do case "$1" in
  --tool) TOOL="$2"; shift 2;; --dir) DIR="$2"; shift 2;;
  --result) RESULT_FILE="$2"; shift 2;; --model) MODEL="$2"; shift 2;; *) shift;;
esac; done
[[ -n "${RALPH_FORCE_TOOL:-}" ]] && TOOL="$RALPH_FORCE_TOOL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" 2>/dev/null || { echo "FAIL" > "$RESULT_FILE"; exit 0; }
mkdir -p "$(dirname "$RESULT_FILE")"

if [[ "$TOOL" == "stub" ]]; then
  printf '# RESEARCH.md (stub)\n\nSummary: stub research for %s.\n' "$DIR" > RESEARCH.md
  echo "[stub-research] PASS"; echo "PASS" > "$RESULT_FILE"; exit 0
fi

PROMPT="Project directory (existing code): $DIR"$'\n\n'"$(cat "$SCRIPT_DIR/research.md" 2>/dev/null)"
BYPASS="${RALPH_BYPASS:-1}"; bypass_flag=""
if [[ "$BYPASS" == "1" ]]; then case "$TOOL" in
  claude|glm) bypass_flag="--dangerously-skip-permissions";;
  codex) bypass_flag="--sandbox danger-full-access";;
  gemini|qwen) bypass_flag="--yolo";;
esac; fi
model_flag=(); [[ -n "$MODEL" ]] && model_flag=(--model "$MODEL")
run_master() {
  case "$TOOL" in
    claude) printf '%s' "$PROMPT" | claude $bypass_flag "${model_flag[@]}" --print ;;
    glm)    printf '%s' "$PROMPT" | ANTHROPIC_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/coding" \
              ANTHROPIC_API_KEY="${GLM_API_KEY:-}" claude --model GLM-5.1 $bypass_flag --print ;;
    codex)  printf '%s' "$PROMPT" | codex exec $bypass_flag "${model_flag[@]}" - ;;
    gemini) gemini $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
    qwen)   qwen $bypass_flag "${model_flag[@]}" -p "$PROMPT" ;;
    *) echo "unknown tool $TOOL" ;;
  esac
}
OUT="$(run_master 2>&1)" || true
# Success = RESEARCH.md exists (the promise line is best-effort).
if [[ -f RESEARCH.md ]]; then echo "PASS" > "$RESULT_FILE"; else echo "FAIL" > "$RESULT_FILE"; fi
exit 0
```

- [ ] **Step 3: Syntax-check + stub smoke**

Run:
```bash
bash -n ralph/ralph-research.sh
tmp=$(mktemp -d); ( cd "$tmp" && RALPH_FORCE_TOOL=stub bash /var/www/tmux.tayyabcheema.com/ralph/ralph-research.sh --tool stub --dir "$tmp" --result "$tmp/.ralph/research.done" ); echo "exit=$?"; cat "$tmp/.ralph/research.done"; ls "$tmp/RESEARCH.md"; rm -rf "$tmp"
```
Expected: `bash -n` clean; `exit=0`; result file contains `PASS`; `RESEARCH.md` exists.

- [ ] **Step 4: Commit**

```bash
git add ralph/research.md ralph/ralph-research.sh
git commit -m "feat(brownfield): research prompt + one-shot research runner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Adopt API + `adoptRalphRun` + copy logic + `spawnResearch`

**Files:**
- Modify: `server.js` — import (after the rc-auth import); `RALPH_RESEARCH_SH` const (near `RALPH_FINALIZE_SH`); `spawnResearch` (near `spawnFinalize` ~1734); `adoptRalphRun` (near `startRalphRun` ~2179); `POST /api/ralph/adopt` (near `POST /api/ralph/start` ~2972).

**Interfaces:**
- Consumes (Task 1): `validateSource`; (Task 2): `ralph/ralph-research.sh`; existing `ensureProjectDir`, `scaffoldContext`, `gitInitProject`, `isGitRepo`, `git`, `runKey`, `ralphRuns`, `persistRun`, `ralphTick`, `slugify`, `validProject`, `execFileAsync`, `ralphSessionName`, `launchRalphSession`, `ralphEnvPrefix`, `credFileLines`, `soloModelFlag`/`isSolo`/`agentHasCodingPlan`/`soloModelsEffective`, `tenantOf`, `PROJECTS_ROOT`, `RALPH_DIR`, `__dirname`, `VALID_AGENTS`.
- Produces (Task 4/5): a run at phase `researching` with `mode:'brownfield'`, `run.researchSession`; `spawnResearch(run)`; `POST /api/ralph/adopt`.

- [ ] **Step 1: Add the import + script constant**

In `server.js`, after the `./ralph/rc-auth.mjs` import, add:

```js
import { validateSource } from './ralph/adopt-paths.mjs';
```

Near `const RALPH_FINALIZE_SH = …` (grep it), add:

```js
const RALPH_RESEARCH_SH = path.join(RALPH_DIR, 'ralph-research.sh');
```

- [ ] **Step 2: Add `spawnResearch` (mirror of spawnFinalize)**

In `server.js`, immediately after `spawnFinalize` (ends ~line 1755), add:

```js
// One-shot research pass over an adopted repo; writes RESEARCH.md + .ralph/research.done.
async function spawnResearch(run) {
  const result = path.join(run.dir, '.ralph', 'research.done');
  await fs.rm(result, { force: true }).catch(() => {});
  const session = ralphSessionName(run.project, 'research', 'rf', run.tenant);
  const modelFlag = soloModelFlag({
    solo: isSolo(run), agent: run.master, role: 'review',
    codingPlan: agentHasCodingPlan(run.master, run), models: soloModelsEffective(),
  });
  const cmd = `mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_RESEARCH_SH} --tool ${run.master} ` +
    `--dir ${run.dir} --result ${result}${modelFlag}`;
  await launchRalphSession(session, run.dir, cmd, credFileLines(run.master, run));
  run.researchSession = session;
  run.researchSince = Date.now();
}
```

- [ ] **Step 3: Add `adoptRalphRun`**

In `server.js`, immediately after `startRalphRun` (ends ~line 2225), add:

```js
// Brownfield: copy an existing local dir into a project, then research it. No idea/prd yet
// (the user provides instructions after reading RESEARCH.md — see POST /api/ralph/instruct).
async function adoptRalphRun({ project, sourcePath, master, workers, outputFormat, tenant = null }) {
  const projectsRoot = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
  const dir = path.join(projectsRoot, project);
  if (path.dirname(dir) !== projectsRoot) throw new Error('Invalid project name.');
  if (await fs.stat(dir).then(() => true).catch(() => false)) {
    throw new Error('Project already exists — choose a new name.');
  }
  // Validate the source: realpath -> directory -> path policy -> size cap.
  let real;
  try { real = await fs.realpath(sourcePath); } catch { throw new Error('Source path not found.'); }
  const st = await fs.stat(real).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('Source path must be a directory.');
  const v = validateSource(real, {
    projectsRoot, repoDir: __dirname, allowRoot: process.env.WEBTMUX_ADOPT_ROOT || '',
  });
  if (v.error) throw new Error(v.error);
  const maxMb = Number(process.env.WEBTMUX_ADOPT_MAX_MB || 500);
  try {
    const { stdout } = await execFileAsync('du', ['-sm', '--exclude=node_modules', '--exclude=.git', real], { timeout: 60_000 });
    const mb = parseInt(stdout, 10) || 0;
    if (mb > maxMb) throw new Error(`Source is ${mb} MB (cap ${maxMb} MB). Set WEBTMUX_ADOPT_MAX_MB to raise it.`);
  } catch (e) { if (/cap/.test(e.message)) throw e; /* du failure is non-fatal */ }

  await ensureProjectDir(dir, tenant);
  // Copy: git clone preserves history + skips node_modules/untracked; else cp -a.
  const isRepo = await isGitRepo(real);
  const runAs = (argv) => (tenant ? tenant.wrap(argv) : argv);
  if (isRepo) {
    const argv = runAs(['git', 'clone', '--no-local', real, dir]);
    await execFileAsync(argv[0], argv.slice(1), { timeout: 300_000 });
  } else {
    const argv = runAs(['bash', '-c', `cp -a ${JSON.stringify(real)}/. ${JSON.stringify(dir)}/ && rm -rf ${JSON.stringify(path.join(dir, 'node_modules'))}`]);
    await execFileAsync(argv[0], argv.slice(1), { timeout: 300_000 });
  }
  await scaffoldContext(dir, project);
  await gitInitProject(dir); // no-op if already a repo; else init + identity + gitignore
  // Ensure a committable baseline (clone may already be clean; cp+init committed scaffold).
  await gitCommitAll(dir, 'chore: adopt existing project').catch(() => {});

  const run = {
    project, key: runKey(project, tenant), dir, mode: 'brownfield',
    idea: '', master, workers, outputFormat: outputFormat || 'auto',
    maxAttempts: 3, workerPasses: 1, bypass: true,
    phase: 'researching', startedAt: Date.now(), stories: [], sessions: {},
    tenant: tenant || undefined,
  };
  revent(run, `📥 adopted ${path.basename(real)} → researching the codebase (master ${master})`);
  ralphRuns.set(run.key, run);
  await spawnResearch(run);
  await persistRun(run);
  return run;
}
```

- [ ] **Step 4: Add `POST /api/ralph/adopt`**

In `server.js`, right after the `POST /api/ralph/start` route (ends ~line 3070), add:

```js
app.post('/api/ralph/adopt', async (req, res) => {
  const project = slugify(req.body?.project || '');
  const sourcePath = String(req.body?.sourcePath || '').trim();
  const master = (req.body?.master || '').trim();
  const workers = Array.isArray(req.body?.workers) ? req.body.workers.map((w) => String(w).trim()) : [];
  const outputFormat = (req.body?.outputFormat || '').trim();
  if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
  if (!sourcePath) return res.status(400).json({ error: 'Provide the source directory path.' });
  if (!VALID_AGENTS.includes(master) || master === 'glm') return res.status(400).json({ error: 'Pick a valid master (claude, codex, qwen, gemini).' });
  const bad = workers.filter((w) => !VALID_AGENTS.includes(w));
  if (bad.length) return res.status(400).json({ error: `Unknown worker(s): ${bad.join(', ')}` });
  try {
    const run = await adoptRalphRun({ project, sourcePath, master, workers, outputFormat, tenant: tenantOf(req) });
    audit({ ralphAdopt: project, source: sourcePath });
    res.json({ ok: true, project: run.project, phase: run.phase });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Syntax-check**

Run: `node --check server.js`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(brownfield): adopt API + adoptRalphRun copy logic + spawnResearch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Tick reaps research → `awaiting`; `GET /api/ralph/research`

**Files:**
- Modify: `server.js` — the `ralphTick` phase dispatch (add a `researching` branch after the `finalizing` branch, before the `else { continue; }` ~line 2146); `GET /api/ralph/research` (near the other `/api/ralph/*` GET routes); `initRalphRuns` re-registration (confirm researching/awaiting runs are re-registered — they are, since the map iterates persisted runs).

**Interfaces:**
- Consumes (Task 3): runs at phase `researching` with `run.researchSession`/`run.researchSince`, `spawnResearch`; existing `RALPH_STALL_MS`, `gitCommitAll`, `revent`, `tmux`.
- Produces (Task 5): runs at phase `awaiting` once `RESEARCH.md` is committed; `GET /api/ralph/research?project=`.

- [ ] **Step 1: Add the `researching` tick branch**

In `server.js`, in `ralphTick`, change the tail of the phase dispatch. Replace:

```js
      } else {
        continue; // done / failed / push_failed: nothing to do
      }
```

with:

```js
      } else if (run.phase === 'researching') {
        // Brownfield: reap the research pass -> commit RESEARCH.md -> await instructions.
        const resultFile = path.join(run.dir, '.ralph', 'research.done');
        let result = null;
        try { result = (await fs.readFile(resultFile, 'utf8')).trim(); } catch { /* pending */ }
        const stalled = !run.researchSession || (Date.now() - (run.researchSince || 0) > RALPH_STALL_MS);
        if (result !== null || stalled) {
          try { await tmux(['kill-session', '-t', run.researchSession]); } catch { /* gone */ }
          await fs.rm(resultFile, { force: true }).catch(() => {});
          const hasFile = await fs.access(path.join(run.dir, 'RESEARCH.md')).then(() => true).catch(() => false);
          if (!hasFile) {
            await fs.writeFile(path.join(run.dir, 'RESEARCH.md'),
              '# RESEARCH.md\n\nResearch did not complete — proceeding without a code summary.\n').catch(() => {});
            run.attention = { message: 'Research pass did not finish; instruct anyway or re-adopt.' };
          }
          await gitCommitAll(run.dir, 'research: add RESEARCH.md').catch(() => {});
          run.phase = 'awaiting';
          run.researchSession = null;
          revent(run, hasFile ? '🔎 research complete — review RESEARCH.md and give instructions'
            : '⚠️ research incomplete — give instructions to proceed');
          changed = true;
        }
      } else {
        continue; // awaiting / done / failed / push_failed: nothing for the tick to do
      }
```

- [ ] **Step 2: Add `GET /api/ralph/research`**

In `server.js`, near the other read routes (e.g. just before `app.get('/api/ralph/solo-models'` or with the masterlog route), add:

```js
app.get('/api/ralph/research', async (req, res) => {
  const run = await loadRun(slugify(req.query.project || ''), tenantOf(req));
  if (!run) return res.status(404).json({ error: 'No run for that project.' });
  try {
    const content = await fs.readFile(path.join(run.dir, 'RESEARCH.md'), 'utf8');
    res.json({ project: run.project, phase: run.phase, research: content });
  } catch { res.json({ project: run.project, phase: run.phase, research: '' }); }
});
```

- [ ] **Step 3: Syntax-check + stub integration (adopt → research → awaiting)**

Run: `node --check server.js`. Then drive it with the stub against a throwaway instance (no live-service impact), using a fixture git repo as the source:
```bash
fix=$(mktemp -d); ( cd "$fix" && git init -q && echo "# fixture" > README.md && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init )
WEBTMUX_PORT=8099 RALPH_FORCE_TOOL=stub WEBTMUX_FAKE_REMOTE=/tmp/ad.git node server.js >/tmp/ad.log 2>&1 & SRV=$!; sleep 2
git init --bare /tmp/ad.git 2>/dev/null
curl -s -XPOST http://127.0.0.1:8099/api/ralph/adopt -H 'Content-Type: application/json' \
  -d "{\"project\":\"adopt-smoke\",\"sourcePath\":\"$fix\",\"master\":\"claude\",\"workers\":[]}" ; echo
for i in $(seq 1 8); do sleep 2; curl -s "http://127.0.0.1:8099/api/ralph/research?project=adopt-smoke" | grep -o '"phase":"[a-z]*"'; done
kill $SRV 2>/dev/null; rm -rf "$fix" /tmp/ad.git /tmp/ad.log
```
Expected: adopt returns `{"ok":true,...,"phase":"researching"}`; phase reaches `"awaiting"`; the research endpoint returns the (stub) RESEARCH.md. (`RALPH_FAKE_REMOTE` may be unset for brownfield since no remote is created at adopt — the env var name above mirrors the documented test knob; if pushes aren't attempted at adopt, it's a no-op.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(brownfield): tick reaps research -> awaiting; GET /api/ralph/research

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Instruct API + brownfield planner context

**Files:**
- Modify: `server.js` — `planPrd` signature (add `research`); the planner `user` prompt (inject research); `POST /api/ralph/instruct`.
- Modify: `ralph/planner.md` — brownfield block.

**Interfaces:**
- Consumes (Task 4): runs at phase `awaiting` with `RESEARCH.md` on disk; existing `planPrd`, `normalizePrd`, `gitCommitAll`, `ralphTick`, `loadRun`, `persistRun`.
- Produces: a run transitioned `awaiting → building` with a code-aware `prd.json`.

- [ ] **Step 1: Thread `research` into `planPrd`**

In `server.js`, change the `planPrd` signature and inject the research context. Signature:

```js
async function planPrd({ idea, master, workers, answers, outputFormat, tenant = null, research = '' }) {
```

In the `const user = …` template (server.js ~785-810), add a brownfield context block near the top of the user message (after the `Idea:` line):

```js
    (research ? `You are modifying an EXISTING codebase. Its research summary follows — stories MUST fit it; do NOT recreate what exists; prefer minimal, targeted changes; reference real files.\n--- RESEARCH.md ---\n${research.slice(0, 12000)}\n--- end ---\n\n` : '') +
```

(Insert it as one more `+`-concatenated segment in the existing `user` string; keep all existing segments.)

- [ ] **Step 2: Add the brownfield block to `ralph/planner.md`**

In `ralph/planner.md`, append a short section so the planner knows the brownfield convention when a research summary is present:

```markdown

## Brownfield builds (when a RESEARCH.md summary is included)
When the user message includes a RESEARCH.md summary, you are changing an EXISTING project,
not creating one. Then:
- Make stories that MODIFY or EXTEND the existing code; never re-scaffold what already exists.
- Match the existing stack, structure, and conventions described in the summary.
- Prefer the smallest set of targeted stories that achieve the user's instruction.
- Reference real files/directories from the summary in each story's description.
```

- [ ] **Step 3: Add `POST /api/ralph/instruct`**

In `server.js`, after `POST /api/ralph/adopt`, add:

```js
app.post('/api/ralph/instruct', async (req, res) => {
  const project = slugify(req.body?.project || '');
  const idea = String(req.body?.idea || '').trim();
  if (!idea) return res.status(400).json({ error: 'Describe the change to make.' });
  const tenant = tenantOf(req);
  const run = await loadRun(project, tenant);
  if (!run) return res.status(404).json({ error: 'No run for that project.' });
  if (run.phase !== 'awaiting') return res.status(409).json({ error: `Run is "${run.phase}", not awaiting instructions.` });
  let research = '';
  try { research = await fs.readFile(path.join(run.dir, 'RESEARCH.md'), 'utf8'); } catch { /* none */ }
  try {
    const prd = await planPrd({ idea, master: run.master, workers: run.workers || [], outputFormat: run.outputFormat, tenant, research });
    prd.project = project;
    await fs.writeFile(path.join(run.dir, 'prd.json'), JSON.stringify(prd, null, 2));
    await fs.writeFile(path.join(run.dir, 'progress.txt'), `# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`).catch(() => {});
    await gitCommitAll(run.dir, 'plan: add prd.json from instructions').catch(() => {});
    run.idea = idea;
    run.outputFormat = prd.outputFormat || run.outputFormat || 'auto';
    run.stories = prd.stories.map((s) => ({ ...s }));
    run.phase = 'building';
    run.attention = null;
    revent(run, `📋 plan ready — ${run.stories.length} stor${run.stories.length === 1 ? 'y' : 'ies'} on the adopted codebase`);
    try { await ensureRemote(run); await gitPushRef(run, 'main'); } catch (err) { run.pushWarning = err.message; }
    await persistRun(run);
    ralphTick().catch(() => {});
    res.json({ ok: true, stories: run.stories.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Syntax-check + stub end-to-end (adopt → research → instruct → build → done)**

Run: `node --check server.js`. Then extend the Task 4 smoke: after the run reaches `awaiting`, POST instruct with a deterministic `prd`-free idea is not possible (planner is stubbed only for agents, not the OpenAI planner). For a no-spend full run, post a `prd` directly is NOT supported by instruct — instead verify the transition with `RALPH_FORCE_TOOL=stub` AND a real planner is avoided by asserting only up to `building` is unreachable without a planner. **Minimal deterministic check:** assert `POST /api/ralph/instruct` with no idea → 400, and with a run not in `awaiting` → 409 (call it twice). Full planner-driven build is covered by the existing greenfield path; brownfield reuses it unchanged.

```bash
# (reusing a throwaway instance with an adopted 'adopt-smoke' run at awaiting from Task 4)
curl -s -XPOST http://127.0.0.1:8099/api/ralph/instruct -H 'Content-Type: application/json' -d '{"project":"adopt-smoke"}' -w " (%{http_code})\n"   # expect 400 (no idea)
curl -s -XPOST http://127.0.0.1:8099/api/ralph/instruct -H 'Content-Type: application/json' -d '{"project":"does-not-exist","idea":"x"}' -w " (%{http_code})\n"  # expect 404
```
Expected: 400 then 404. (A planner-backed `awaiting→building` requires an OpenAI/qwen key — exercise that manually post-merge; the wiring is verified by `node --check` + the transition guards.)

- [ ] **Step 5: Commit**

```bash
git add server.js ralph/planner.md
git commit -m "feat(brownfield): instruct API + research-aware planner context

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: UI (adopt entry + research view + instruct box) + sw bump + docs

**Files:**
- Modify: `public/index.html` — an "Adopt existing project" dialog + a research/instruct view.
- Modify: `public/js/dashboard.js` — wire adopt → poll for `awaiting` → show RESEARCH.md + instruct box.
- Modify: `public/sw.js` — bump `VERSION`.
- Modify: `CLAUDE.md` — document brownfield adopt.

**Interfaces:**
- Consumes: `POST /api/ralph/adopt`, `GET /api/ralph/research`, `POST /api/ralph/instruct`; existing dashboard dialog/build-status patterns + `esc()`.
- Produces: a usable adopt → research → instruct flow in the PWA.

- [ ] **Step 1: Add the adopt dialog markup**

In `public/index.html`, near the other `<dialog>`s, add:

```html
<dialog id="adopt-dialog">
  <h3>📥 Adopt existing project</h3>
  <p class="muted">Point Ralph at an existing directory on the server. It's copied in (your original is untouched), researched, then you give the change.</p>
  <label class="field-label">Project name <input id="adopt-name" class="input" placeholder="my-app"></label>
  <label class="field-label">Source path <input id="adopt-path" class="input" placeholder="/home/me/my-app"></label>
  <label class="field-label">Master <select id="adopt-master"><option>claude</option><option>codex</option><option>qwen</option><option>gemini</option></select></label>
  <p id="adopt-err" class="muted" hidden></p>
  <div class="row" style="justify-content:flex-end;gap:8px">
    <button type="button" id="adopt-cancel" class="btn small">Cancel</button>
    <button type="button" id="adopt-go" class="btn small primary">Adopt &amp; research</button>
  </div>
</dialog>
<dialog id="research-dialog">
  <h3>🔎 <span id="research-project"></span></h3>
  <pre id="research-md" style="white-space:pre-wrap;max-height:50vh;overflow:auto;background:#0d1117;padding:10px;border-radius:8px"></pre>
  <label class="field-label">What change should the agents make?
    <textarea id="instruct-idea" class="input" rows="4" placeholder="e.g. add a dark-mode toggle to the settings page"></textarea></label>
  <p id="instruct-err" class="muted" hidden></p>
  <div class="row" style="justify-content:flex-end;gap:8px">
    <button type="button" id="research-close" class="btn small">Close</button>
    <button type="button" id="instruct-go" class="btn small primary">Plan &amp; build</button>
  </div>
</dialog>
```

- [ ] **Step 2: Wire the adopt flow in dashboard.js**

In `public/js/dashboard.js`, add (near the other dialog helpers). Add an entry point — a button that calls `openAdoptDialog()` (place it next to the existing "New build" trigger; grep for how the Ralph start dialog is opened and add a sibling button in `index.html` if needed):

```js
function openAdoptDialog() {
  document.getElementById('adopt-err').hidden = true;
  document.getElementById('adopt-name').value = '';
  document.getElementById('adopt-path').value = '';
  document.getElementById('adopt-dialog').showModal();
}
document.getElementById('adopt-cancel').onclick = () => document.getElementById('adopt-dialog').close();
document.getElementById('adopt-go').onclick = async () => {
  const project = document.getElementById('adopt-name').value.trim();
  const sourcePath = document.getElementById('adopt-path').value.trim();
  const master = document.getElementById('adopt-master').value;
  const err = document.getElementById('adopt-err');
  try {
    const r = await fetch('/api/ralph/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, sourcePath, master, workers: [] }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'adopt failed');
    document.getElementById('adopt-dialog').close();
    pollResearch(d.project);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
};

async function pollResearch(project) {
  const dlg = document.getElementById('research-dialog');
  document.getElementById('research-project').textContent = project;
  document.getElementById('research-md').textContent = 'Researching the codebase…';
  document.getElementById('instruct-idea').value = '';
  dlg.showModal();
  const tick = async () => {
    const d = await (await fetch(`/api/ralph/research?project=${encodeURIComponent(project)}`)).json().catch(() => ({}));
    if (d.phase === 'awaiting') { document.getElementById('research-md').textContent = d.research || '(no summary)'; return; }
    if (d.phase && d.phase !== 'researching') { document.getElementById('research-md').textContent = `Run is "${d.phase}".`; return; }
    setTimeout(tick, 3000);
  };
  tick();
  document.getElementById('instruct-go').onclick = async () => {
    const idea = document.getElementById('instruct-idea').value.trim();
    const err = document.getElementById('instruct-err');
    try {
      const r = await fetch('/api/ralph/instruct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, idea }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'instruct failed');
      dlg.close();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  document.getElementById('research-close').onclick = () => dlg.close();
}
```

Add an entry button in `index.html` next to the Ralph "New build" control:

```html
<button type="button" id="adopt-open" class="btn small">📥 Adopt existing</button>
```
and wire it in dashboard.js: `document.getElementById('adopt-open').onclick = openAdoptDialog;`

- [ ] **Step 3: Bump the service worker**

In `public/sw.js` line 4: `const VERSION = 'webtmux-v30';` → `const VERSION = 'webtmux-v31';`.

- [ ] **Step 4: Document in CLAUDE.md**

In `CLAUDE.md`, under the Ralph orchestrator section (after "### Agents" or near the run-flow), add:

```markdown
### Brownfield: adopt an existing project
Besides greenfield (`/api/ralph/start`), Ralph can adopt an EXISTING local directory:
`POST /api/ralph/adopt {project, sourcePath, master}` validates the path
(`ralph/adopt-paths.mjs`: realpath, directory-only, system-path denylist, not the repo /
PROJECTS_ROOT, optional `WEBTMUX_ADOPT_ROOT`, `WEBTMUX_ADOPT_MAX_MB`), copies it in
(`git clone` if a repo, else `cp -a` + `gitInitProject`; original untouched), and runs a
one-shot **research pass** (`spawnResearch` → `ralph/ralph-research.sh` + `ralph/research.md`,
read-only) that commits `RESEARCH.md`. Phases: `researching` → `awaiting`. Then
`POST /api/ralph/instruct {project, idea}` plans with `RESEARCH.md` as context (brownfield
block in `planner.md`) and hands off to the normal build flow. `GET /api/ralph/research`
returns RESEARCH.md. Read-only research + the path denylist are the guardrails (agents run
in bypass on the adopted code, as in greenfield).
```

- [ ] **Step 5: Syntax-check + build verify**

Run: `node --check public/js/dashboard.js`
Expected: clean. Confirm `public/sw.js` reads `webtmux-v31` and `index.html` has `id="adopt-dialog"`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/dashboard.js public/sw.js CLAUDE.md
git commit -m "feat(brownfield): adopt UI (research view + instruct) + sw v31; docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
| Spec section | Task |
|---|---|
| §4.1 adopt + copy (clone/cp) + validation + multitenant | Task 1 (validate) + Task 3 (API/copy) |
| §4.2 research pass (prompt, runner, spawnResearch, reap, stall fallback) | Task 2 (prompt/script) + Task 3 (spawnResearch) + Task 4 (reap) |
| §4.3 instruct + brownfield planner context | Task 5 |
| §4.4 UI | Task 6 |
| §6 error handling (bad path, exists, stall→minimal RESEARCH.md, size cap) | Task 1/3 (validate/size), Task 4 (stall fallback) |
| §7 security (path policy, behind auth, multitenant copy-as-tenant) | Task 1 + Task 3 |
| §8 testing (path unit, adopt→research→awaiting stub, clone/cp) | Task 1 unit, Task 3/4 stub smoke, Task 5 guards |
| §9 file-by-file | All tasks; CLAUDE.md Task 6 |

**Placeholder scan:** No "TBD/handle errors" placeholders; every code step has real code. Task 5 Step 4 is explicit that a full planner-driven `awaiting→building` needs an API key and is verified by guard-checks + `node --check` (no fake-planner exists for brownfield) — an honest test limitation, not a placeholder. Several steps name exact existing symbols to reuse (`ensureProjectDir`, `scaffoldContext`, `gitCommitAll`, `ensureRemote`, `gitPushRef`, `loadRun`, `RALPH_FINALIZE_SH`) — grep-confirmable, not vague.

**Type/name consistency:** `adoptRalphRun`, `spawnResearch` (`run.researchSession`/`researchSince`), `.ralph/research.done`, `RESEARCH.md`, phases `researching`/`awaiting`, `RALPH_RESEARCH_SH`, `validateSource(src,{projectsRoot,repoDir,allowRoot})`, `planPrd({…,research})`, routes `/api/ralph/{adopt,instruct,research}` are used consistently across tasks.

**Integration symbols to confirm at implementation (grep-able):** `ensureProjectDir`, `scaffoldContext`, `gitCommitAll`, `ensureRemote`, `gitPushRef`, `loadRun`, `revent`, `execFileAsync`, `tenant.wrap`, `RALPH_FINALIZE_SH`/`RALPH_DIR` — each named at its use site; match the exact signature.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-brownfield-adopt.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — execute in this session with checkpoints.

**Which approach?**
