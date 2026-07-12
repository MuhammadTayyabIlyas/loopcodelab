# SSH Adopt — Run Agents on a Project on Another Server — Design

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** Claude (pair) + tayyabcheema777

## 1. Problem & goal

The brownfield feature adopts an **existing local directory**. The user also has projects on
**other servers** reachable over SSH and wants to run agents on them. Goal: adopt a remote
project by **browsing it over SSH and pulling it in**, then run the *exact same* brownfield
pipeline (research → `RESEARCH.md` → instruct → build).

**SSH-adopt = brownfield-adopt where the copy step fetches over SSH instead of from a local
path.** Everything downstream is reused unchanged.

### Decisions (resolved in brainstorming)
- **Remote source:** pick an existing **`~/.ssh/config` Host alias** (`listSshHosts`,
  injection-safe allowlist) + a **remote path**. No new key/secret handling — keys already
  live in `~/.ssh/config`.
- **Result flow:** agents' changes go to a **new GitHub repo** (existing `ensureRemote`,
  same as brownfield). **The source server is read-only / untouched.**
- **Remote path:** **browse over SSH** — a remote directory picker (`ssh <host> ls`),
  mirroring the local picker.

### Non-goals
Running agents ON the remote host; pushing results back to the source server; SSH password
auth (key-only, `BatchMode`); adding/editing `~/.ssh/config` from the app (admin/ops task);
adopting a remote that isn't reachable by an existing host alias.

## 2. Grounding in existing code (verified)

- **SSH host allowlist already exists:** `listSshHosts()` (server.js:287) parses `Host`
  aliases from `~/.ssh/config`; `GET /api/ssh-hosts` (server.js:3035) exposes them; the
  Connect feature runs `ssh <host>` only for an allowlisted host (server.js:3830) — the
  list "acts as an allowlist so a launched `ssh <host>` can never carry injected args."
- **Brownfield pipeline (just merged):** `adoptRalphRun` (server.js:2271) copies a local
  dir in → phase `researching` → `spawnResearch` → tick → `awaiting` → `POST /api/ralph/instruct`
  → `planPrd(research)` → build. `GET /api/ralph/fs-list` (local browse). `ralph/adopt-paths.mjs`
  holds pure path policy.
- **New-repo result flow:** `ensureRemote`/`gitPushRef` (server.js:1760+) create + push to a
  new GitHub repo on instruct — reused as-is. The source is only ever *read* (clone/rsync).
- **`execFileAsync`** (server.js:33) runs argv (no shell). `git clone <host>:<path>` and
  `rsync -e ssh` use the alias, which carries the key + user from `~/.ssh/config`.

**Consequence:** the change is small and additive: a remote-browse endpoint, an SSH branch
in the adopt copy step, an SSH-target validator, and a Local/Remote toggle in the dialog.

## 3. Components

### 3.1 Remote browse — `GET /api/ralph/ssh-list?host=<alias>&path=<remote path>`
Behind the same dashboard auth as other `/api/ralph/*`. Returns
`{ host, path, parent, dirs: [{ name, path }] }`.
- **`host` MUST be in `listSshHosts()`** (else 403) — the injection-safe allowlist. `host`
  matches `SSH_HOST_RE` already.
- Default `path` = `.` (the remote login dir / home) when empty.
- Runs: `execFileAsync('ssh', [host, '-o','BatchMode=yes','-o','ConnectTimeout=10', remoteCmd], {timeout: 20_000})`
  where `remoteCmd` is a single string the remote shell runs, with the path **single-quoted**
  for the remote shell (`shRemoteQuote(path)` — wrap in `'…'`, escape embedded `'` as `'\''`):
  `cd <q-path> 2>/dev/null && pwd && ls -1Ap` (so we get the canonical remote path + entries).
  Parse: first line = canonical `path`; entries ending `/` and not `./`,`../`,`.git/`,
  `node_modules/`, dotfiles → `dirs`. `parent` = the remote `dirname` (null at `/`).
- Errors: 403 (host not allowlisted), 400 (bad path / not a dir), 502 (ssh failed:
  unreachable, auth, timeout) — JSON `{error}` with a hint to check `~/.ssh/config`.
- Read-only: only `ls`/`pwd`/`cd` on the remote.

### 3.2 SSH-target validation — `ralph/adopt-paths.mjs` (extend)
Add a pure `validateSshTarget(host, hosts, remotePath)` → `{ ok, host, path } | { error }`:
host non-empty + matches `SSH_HOST_RE` + is in the `hosts` allowlist; `remotePath` non-empty.
(Unit-tested alongside the existing local validator.)

### 3.3 Adopt — SSH branch in `adoptRalphRun` + route
`POST /api/ralph/adopt` body gains a discriminated source:
`{ project, master, workers, outputFormat, source: { type:'local', path } | { type:'ssh', host, path } }`
(Back-compat: a bare `sourcePath` is still accepted as `{type:'local', path}`.)
- **SSH branch** (when `type:'ssh'`): validate `host` ∈ `listSshHosts()` (`validateSshTarget`);
  detect a remote git repo: `ssh <host> -o BatchMode=yes -- test -d <q-path>/.git`.
  - git → `git clone <host>:<q-path> <dest>` (clone over the alias; history preserved).
  - else → `rsync -az --delete=false -e 'ssh -o BatchMode=yes' <host>:<path>/ <dest>/`
    then `gitInitProject(dest)`. Exclude `node_modules`/`.git`-less cruft via
    `--exclude=node_modules`.
  - All commands `execFileAsync` with `BatchMode=yes` + timeouts; on failure **roll back**
    `dest` (`fs.rm`) and throw a clear error (no partial run).
- After the fetch: identical to brownfield (`scaffoldContext`/`gitInitProject`/`gitCommitAll`
  → `mode:'brownfield'` run at phase `researching` → `spawnResearch` → persist). The run
  records `run.sourceKind='ssh'` + `run.sshHost` for display/audit. The remote source is
  never written to.
- Result flow unchanged: `instruct` → `ensureRemote` (new GitHub repo) → build/push.

### 3.4 UI — Local | Remote (SSH) toggle in the adopt dialog
Extend the Task-7 adopt dialog:
- A **Local | Remote (SSH)** segmented toggle.
- **Local** → the existing `fs-list` picker (unchanged).
- **Remote** → a **host dropdown** (from `GET /api/ssh-hosts`) + a **remote directory picker**
  backed by `GET /api/ralph/ssh-list?host=&path=` (same picker UX as local: click to drill,
  "⬆ up", current path shown). "Adopt this directory & research" submits
  `{type:'ssh', host, path: <browsed remote path>}`.
- If no SSH hosts are configured, the Remote tab shows: "No SSH hosts in ~/.ssh/config — add a
  Host block on the server first." Research/instruct views are reused as-is.
- PWA: bump `sw.js`.

## 4. Data flow
```
ssh-list(host, path) ──ssh host 'cd path && pwd && ls'──▶ remote dirs (picker)
adopt {type:ssh, host, path} ──validate host∈allowlist──▶
   git clone host:path  (or rsync) ──▶ <dest>  ──▶ gitInitProject ──▶ run@researching
[then identical to brownfield] research ▶ RESEARCH.md ▶ awaiting ▶ instruct(idea) ▶ ensureRemote(new GitHub) ▶ build
```

## 5. Security & threat model
- **Host is the only SSH identity input and is allowlisted** against `listSshHosts()` — the
  same guarantee the existing Connect feature relies on; no arbitrary `user@host`.
- **Remote path** is passed **single-quoted into the remote shell** (`shRemoteQuote`) and as
  argv locally — no local or remote shell injection. The `git clone host:path` form passes
  `path` as part of the SCP-like target; we single-quote the remote portion the same way.
- **Read-only on the source:** only `ls/pwd/cd/test -d`, `git clone`, `rsync` *from* the
  remote. Nothing writes to the source server. Results go to a **new GitHub repo**.
- `BatchMode=yes` + `ConnectTimeout` so a missing/locked key fails fast (never hangs on a
  prompt) and surfaces a clear error.
- Behind the dashboard's existing auth (basic-auth single-tenant / `requireAuth` multitenant).
- Multitenant note: `~/.ssh/config` is the **app host's** config; SSH-adopt is intended for
  the single-tenant deployment (like the local picker). Gated the same way; not exposed per-tenant.

## 6. Error handling & edge cases
- Host not in allowlist → 403. No SSH hosts at all → Remote tab disabled with guidance.
- SSH unreachable / auth failure / timeout → 502 with "check ~/.ssh/config / key" hint; no run.
- Remote path missing or not a dir → 400.
- Clone/rsync failure → roll back `dest`, throw; same-name retry works.
- Large remote tree → the existing `WEBTMUX_ADOPT_MAX_MB` cap can't `du` remotely cheaply;
  instead bound the transfer with a `--timeout`/`rsync` size guard is out of scope — rely on
  the command timeout (e.g. 600s) and document it. (Acceptable for v1.)
- Remote git repo with uncommitted changes → `git clone` only takes committed state (clean);
  rsync path takes the working tree as-is.

## 7. Testing (no spend)
- **`validateSshTarget` unit tests** (`ralph/adopt-paths.test.mjs`): rejects empty host, host
  not in allowlist, bad host chars, empty path; accepts a valid allowlisted host + path.
- **`shRemoteQuote` unit test:** quotes a plain path, escapes embedded single quotes, neutralizes
  `; rm -rf` / `$(...)` (assert the output is a single safely-quoted token).
- **ssh-list endpoint (local loopback):** if the test host has an `~/.ssh/config` Host alias to
  `localhost` (or a fixture), assert listing works + a non-allowlisted host → 403. Where no SSH
  is available in CI, unit-test the parse function (`parseSshLs(stdout)`) in isolation.
- **adopt SSH branch:** unit-test the command-builder (host+path → the exact `git clone`/`rsync`
  argv) so the quoting/argv is verified without a live SSH. The full clone→research→build reuses
  the brownfield stub path (already covered).
- Gates: `node --check server.js`, `node --check public/js/dashboard.js`, `node --test ralph/adopt-paths.test.mjs`.

## 8. File-by-file change list
| File | Change |
|---|---|
| `ralph/adopt-paths.mjs` (+test) | `validateSshTarget(host, hosts, path)` + `shRemoteQuote(s)` + `parseSshLs(stdout)` (pure helpers) + tests. |
| `server.js` | `GET /api/ralph/ssh-list` (allowlisted host, ssh ls, parse); SSH branch in `adoptRalphRun` (clone/rsync + rollback) + `run.sourceKind`/`sshHost`; `POST /api/ralph/adopt` accepts `source:{type,host,path}` (back-compat `sourcePath`). |
| `public/index.html`, `public/js/dashboard.js`, `public/sw.js` | Local/Remote toggle, host dropdown (`/api/ssh-hosts`), remote picker (`/api/ralph/ssh-list`); sw bump. |
| `CLAUDE.md` | Document SSH-adopt (reuses host-alias allowlist; results → new GitHub repo). |

## 9. Decisions (resolved)
1. Remote source = **host alias + remote path** (reuse allowlist + keys). ✓
2. Results → **new GitHub repo** (source read-only). ✓
3. Remote path = **browse over SSH**. ✓
4. Push-back-to-source, remote agent execution, SSH password auth, editing `~/.ssh/config` = **out of scope**.

## 10. Rollout
1. `adopt-paths` SSH helpers (`validateSshTarget`/`shRemoteQuote`/`parseSshLs`) + tests.
2. `GET /api/ralph/ssh-list` (remote browse).
3. SSH branch in `adoptRalphRun` + adopt route `source` shape (back-compat).
4. UI Local/Remote toggle + host dropdown + remote picker + sw bump + docs.
Each step independently testable; SSH-adopt is additive and never touches the local-adopt or
greenfield paths.
