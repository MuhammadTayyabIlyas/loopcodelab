# Windows Installer — Phase 2b (auto-dispatch → poll → download → Google Drive) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "Build Windows installer" from a scaffold-and-you-run-it (Phase 2a) into the full APK-style experience: after scaffolding, the box **dispatches** the `windows-latest` GitHub Actions workflow, **polls** it to completion, **downloads** the `.exe`/`.msi` artifact, and **shares it to Google Drive** with a link + QR — writing `DELIVERABLE.md` and firing a Web Push, exactly like the flutter-app APK.

**Architecture:** Mirror the flutter-app APK delivery (`spawnDelivery` → `ralph-deliver.sh` → `.ralph/deliver.json` reap → `writeDeliverable`), but the heavy build is **off-box on GitHub Actions** instead of local. A new session script `ralph/ralph-windows-deliver.sh` uses `gh` (with the tenant's token) to dispatch + watch the run, `gh run download` the artifact, and share it via a generalized privileged uploader `webtmux-artifact-share` (accepts `.exe`/`.msi`, out-of-repo host helper). The `POST /api/ralph/windows/installer` endpoint now scaffolds (Phase 2a) then enters a new `windows-delivering` phase; the tick reaps `.ralph/windows-deliver.json`.

**Tech Stack:** Node (ESM, `node:test`), the Ralph orchestrator in `server.js`, bash + `gh` CLI, React + Vite (`web/`).

## Global Constraints

- **Builds on Phase 2a.** 2a already ships `ralph/windows-scaffold.mjs`, `prepareWindowsInstaller`, `POST /api/ralph/windows/installer` (scaffold+push), `run.windows.installer`, and the `web/` button. 2b extends them — do NOT re-scaffold from scratch.
- **Off-box, never local.** The Windows build runs only on GitHub Actions `windows-latest`. The box only dispatches, polls, downloads, and shares. No Rust/Tauri toolchain on this host.
- **Never fail the build.** A delivery failure sets `run.deliverWarning`/records an error but leaves the run usable — mirrors the APK path (`run.phase === 'delivering'` reap). The web preview + the scaffolded workflow already exist; delivery is additive.
- **Always writes its sentinel.** `ralph-windows-deliver.sh` ALWAYS writes JSON to `--out` (`{shareLink,qr}` on success, `{error}` on any failure) so the tick never hangs — exactly like `ralph-deliver.sh`.
- **Stub-aware.** `RALPH_FORCE_TOOL` → `--stub` → a simulated Drive link, no `gh`/Actions/Drive spend (matches the APK's `--stub`).
- **Credentials.** The tenant github token (`tenantKey(run,'github') || githubToken()`) is passed to the session as `GH_TOKEN`; it must have **`workflow` + `actions:write`** scope to dispatch/download runs. The repo slug is `parseRepoSlug(run.repo)`. Drive tokens stay on the box (the privileged uploader).
- **Host helper is an ops prerequisite** (like flutter's `webtmux-apk-share`): a generalized `webtmux-artifact-share` at `/usr/local/sbin` + a sudoers line. The plan commits the TEMPLATE under `docs/ops/`; installing it is a manual admin step. Until installed, real delivery fails gracefully (`{error}`), but the stub path and the 2a scaffold still work.
- **Confirmed by the Actions smoke test:** the workflow uploads the artifact named `windows-installer` containing the NSIS `.exe` under `nsis/` and the MSI under `msi/`. `gh run download -n windows-installer` extracts that tree. (If the smoke test shows a different layout, adjust the `find` in `ralph-windows-deliver.sh` Step accordingly — it globs `*.exe`/`*.msi` recursively to be robust.)
- Verify gates: `node --check server.js`; `node --test ralph/*.test.mjs`; `bash -n ralph/ralph-windows-deliver.sh`. After `web/src` edits: `cd web && npm run build`. `server.js` binds a port on import — verify with `node --check`, never run it.
- Manual-checkpoint repo — commit only in each task's commit step.

## File Structure

- Create `ralph/windows-deliver.mjs` — pure: share-file name, tolerant result parse, DELIVERABLE markdown. + `ralph/windows-deliver.test.mjs`.
- Create `ralph/ralph-windows-deliver.sh` — the off-box delivery session script (dispatch/poll/download/share, stub-aware).
- Create `docs/ops/webtmux-artifact-share.sh` — the generalized privileged uploader TEMPLATE (accepts `.exe`/`.msi`/`.apk`/`.aab`).
- Modify `server.js` — import the helpers; `spawnWindowsDelivery(run)`; the `windows-delivering` tick reap + `WINDOWS_DELIVER_STALL_MS`; upgrade the endpoint to enter delivery after scaffolding.
- Modify `web/src/pages/BuildDetail.jsx` — show delivery-in-progress + the resulting Drive link/QR on the Windows installer.
- Modify `CLAUDE.md` — 2b behavior + the host-helper ops prerequisite.

---

### Task 1: `ralph/windows-deliver.mjs` — pure delivery helpers + tests

**Files:**
- Create: `ralph/windows-deliver.mjs`
- Test: `ralph/windows-deliver.test.mjs`

**Interfaces:**
- Produces:
  - `installerShareName(project, kind = 'exe') -> string` (safe filename, e.g. `notes.exe`; kind ∈ `exe`|`msi`)
  - `parseWindowsDeliverResult(raw) -> { shareLink, qr } | { error } | null` (tolerant, mirrors `parseDeliverResult`)
  - `windowsDeliverableMarkdown({ project, previewUrl, shareLink, qr, appId, version, kind }) -> string`
  Task 4 consumes all three.

- [ ] **Step 1: Write the failing tests.** Create `ralph/windows-deliver.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installerShareName, parseWindowsDeliverResult, windowsDeliverableMarkdown } from './windows-deliver.mjs';

test('installerShareName: safe slug + extension; defaults to exe', () => {
  assert.equal(installerShareName('My Notes!'), 'my-notes.exe');
  assert.equal(installerShareName('notes', 'msi'), 'notes.msi');
  assert.equal(installerShareName('', 'exe'), 'app.exe');
  assert.equal(installerShareName('a'.repeat(80)).length <= 52, true); // capped + .exe
  assert.equal(installerShareName('x', 'bogus'), 'x.exe'); // unknown kind -> exe
});

test('parseWindowsDeliverResult: success, error, and pending', () => {
  assert.deepEqual(parseWindowsDeliverResult('{"shareLink":"https://drive/x","qr":"https://drive/qr"}'),
    { shareLink: 'https://drive/x', qr: 'https://drive/qr' });
  assert.deepEqual(parseWindowsDeliverResult('{"shareLink":"https://drive/x"}'),
    { shareLink: 'https://drive/x', qr: null });
  assert.deepEqual(parseWindowsDeliverResult('{"error":"actions run failed"}'), { error: 'actions run failed' });
  assert.equal(parseWindowsDeliverResult(''), null);
  assert.equal(parseWindowsDeliverResult(null), null);
  assert.deepEqual(parseWindowsDeliverResult('not json'), { error: 'unparseable delivery result' });
  assert.deepEqual(parseWindowsDeliverResult('{"foo":1}'), { error: 'no share link returned' });
});

test('windowsDeliverableMarkdown: records the install link, QR, and provenance', () => {
  const md = windowsDeliverableMarkdown({ project: 'notes', previewUrl: 'https://notes.example', shareLink: 'https://drive/x', qr: 'https://drive/qr', appId: 'com.acme.notes', version: '1.0.0', kind: 'exe' });
  assert.match(md, /Windows/);
  assert.match(md, /https:\/\/drive\/x/);
  assert.match(md, /https:\/\/drive\/qr/);
  assert.match(md, /com\.acme\.notes/);
  assert.match(md, /1\.0\.0/);
  assert.match(md, /https:\/\/notes\.example/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/windows-deliver.test.mjs 2>&1 | tail -6`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Create `ralph/windows-deliver.mjs`:**

```js
// Pure helpers for the Windows-installer delivery step (Phase 2b): off-box Actions build ->
// download artifact -> Google Drive link. No I/O — orchestration (dispatch/poll/download/share)
// lives in ralph-windows-deliver.sh; this shapes names, parses the result, and renders DELIVERABLE.md.

const KINDS = new Set(['exe', 'msi']);

export function installerShareName(project, kind = 'exe') {
  const k = KINDS.has(kind) ? kind : 'exe';
  const s = String(project || 'app').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
  return `${s}.${k}`;
}

// Tolerant parse of ralph-windows-deliver.sh's --out JSON. { shareLink, qr } on success,
// { error } otherwise, null if nothing written yet.
export function parseWindowsDeliverResult(raw) {
  if (raw == null) return null;
  const txt = String(raw).trim();
  if (!txt) return null;
  let j;
  try { j = JSON.parse(txt); } catch { return { error: 'unparseable delivery result' }; }
  if (j && typeof j.shareLink === 'string' && j.shareLink) {
    return { shareLink: j.shareLink, qr: typeof j.qr === 'string' && j.qr ? j.qr : null };
  }
  if (j && j.error) return { error: String(j.error) };
  return { error: 'no share link returned' };
}

export function windowsDeliverableMarkdown({ project, previewUrl, shareLink, qr, appId, version, kind = 'exe' } = {}) {
  const lines = [`# ${project || 'project'} — Deliverable`, '', '**Type:** Windows desktop app (Tauri installer)', ''];
  if (appId || version) lines.push(`**Identity:** ${appId || '(app id)'} · **Version:** ${version || '1.0.0'}`, '');
  if (previewUrl) lines.push('## Live web preview', previewUrl, '');
  if (shareLink) {
    lines.push('## Install on Windows', `- **Installer (${kind.toUpperCase()}) download:** ${shareLink}`);
    if (qr) lines.push(`- **QR code (scan with your phone):** ${qr}`);
    lines.push('',
      '> Download and run the installer on Windows. Unsigned builds show a SmartScreen prompt',
      '> ("More info" → "Run anyway") until the app earns reputation or you sign it with your own',
      '> code-signing certificate. For the Microsoft Store, use the Store step (Phase 3).', '');
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/windows-deliver.test.mjs 2>&1 | tail -5`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add ralph/windows-deliver.mjs ralph/windows-deliver.test.mjs
git commit -m "feat(windows): pure delivery helpers (share name, result parse, DELIVERABLE)"
```

---

### Task 2: `ralph/ralph-windows-deliver.sh` — off-box dispatch → poll → download → Drive

**Files:**
- Create: `ralph/ralph-windows-deliver.sh`

**Interfaces:**
- Consumes: `GH_TOKEN` (env), the generalized `webtmux-artifact-share` (host helper, Task 3). Produces: writes `--out` JSON. Task 4 spawns it.

- [ ] **Step 1: Create `ralph/ralph-windows-deliver.sh`:**

```bash
#!/bin/bash
# Phase 2b: build the Windows installer OFF-BOX on GitHub Actions and share it to Google Drive.
# Dispatches the scaffolded "Windows Package" workflow, polls the run, downloads the installer
# artifact, and uploads it via the privileged wrapper. Run by the orchestrator AS THE APP USER
# (tmuxweb) — the upload needs the admin Drive OAuth (owned by www-data), via sudo.
# ALWAYS writes JSON to --out so the tick never hangs: {"shareLink":...,"qr":...} or {"error":...}.
# gh auth comes from GH_TOKEN in the environment. Requires `workflow`+`actions:write` scope.
set -u

DIR=""; REPO=""; NAME="app.exe"; OUT=""; URL=""; STUB=0; WORKFLOW="windows-package.yml"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2;;
    --repo) REPO="${2:-}"; shift 2;;
    --name) NAME="${2:-app.exe}"; shift 2;;
    --out) OUT="${2:-}"; shift 2;;
    --url) URL="${2:-}"; shift 2;;
    --stub) STUB=1; shift;;
    *) shift;;
  esac
done

[ -n "$OUT" ] || { echo "ralph-windows-deliver: no --out" >&2; exit 0; }
emit() { printf '%s\n' "$1" > "$OUT"; exit 0; }
fail() { local m="${1//\"/\\\"}"; emit "{\"error\":\"$m\"}"; }

# No-spend path for the stub harness.
if [ "$STUB" = 1 ]; then
  emit "{\"shareLink\":\"https://drive.example/stub/${NAME}\",\"qr\":\"https://drive.example/qr/${NAME}\"}"
fi

command -v gh >/dev/null 2>&1 || fail "gh CLI not installed"
[ -n "$REPO" ] || fail "no repo slug"
[ -n "${GH_TOKEN:-}" ] || fail "no GH_TOKEN"
export GH_PROMPT_DISABLED=1

# 1) Dispatch the workflow on the repo's default branch, then find the run we just created.
gh workflow run "$WORKFLOW" -R "$REPO" >/dev/null 2>&1 || fail "workflow dispatch failed (token needs workflow scope, or Actions disabled)"
RID=""
for i in $(seq 1 12); do
  sleep 5
  RID="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)"
  [ -n "$RID" ] && [ "$RID" != "null" ] && break
done
[ -n "$RID" ] && [ "$RID" != "null" ] || fail "could not find the dispatched run"

# 2) Poll until the run completes (installer builds take ~10-15 min; cap ~22 min).
CONCL=""
for i in $(seq 1 44); do
  ST="$(gh run view "$RID" -R "$REPO" --json status --jq '.status' 2>/dev/null)"
  if [ "$ST" = "completed" ]; then
    CONCL="$(gh run view "$RID" -R "$REPO" --json conclusion --jq '.conclusion' 2>/dev/null)"
    break
  fi
  sleep 30
done
[ "$CONCL" = "success" ] || fail "Actions run ${RID} ${CONCL:-timed out} — see the run logs"

# 3) Download the installer artifact and find the .exe (fallback .msi).
TMP="$(mktemp -d)"
gh run download "$RID" -R "$REPO" -n windows-installer -D "$TMP" >/dev/null 2>&1 || fail "artifact download failed"
FILE="$(find "$TMP" -type f -name '*.exe' | head -1)"
[ -n "$FILE" ] || FILE="$(find "$TMP" -type f -name '*.msi' | head -1)"
[ -n "$FILE" ] || fail "no .exe/.msi in the artifact"

# 4) Share to Google Drive via the privileged wrapper (accepts .exe/.msi). Prints {shareLink,qr}.
OUTJSON="$(sudo -n /usr/local/sbin/webtmux-artifact-share "$FILE" "$NAME" 2>/dev/null)"
rm -rf "$TMP" 2>/dev/null || true
case "$OUTJSON" in
  *shareLink*) emit "$OUTJSON";;
  *) fail "Drive upload failed (is webtmux-artifact-share installed?)";;
esac
```

- [ ] **Step 2: Syntax check**

Run: `cd /var/www/tmux.tayyabcheema.com && bash -n ralph/ralph-windows-deliver.sh && echo "bash ok"`
Expected: `bash ok`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add ralph/ralph-windows-deliver.sh
git commit -m "feat(windows): off-box delivery script — dispatch/poll/download Actions installer -> Drive"
```

---

### Task 3: `webtmux-artifact-share` host-helper template + install docs

**Files:**
- Create: `docs/ops/webtmux-artifact-share.sh`

**Interfaces:**
- Produces: the generalized privileged uploader (accepts `.exe`/`.msi`/`.apk`/`.aab`). Consumed by Task 2's script via `sudo`. This is an ops TEMPLATE — installing it (`/usr/local/sbin` + sudoers) is a manual admin step documented here and in Task 6.

- [ ] **Step 1: Create `docs/ops/webtmux-artifact-share.sh`** (generalized from `webtmux-apk-share`, accepting more extensions):

```bash
#!/bin/bash
# webtmux ARTIFACT -> Google Drive upload helper — TEMPLATE (do NOT run from the repo).
# Generalizes webtmux-apk-share to any installer artifact (.exe/.msi/.apk/.aab). Runs the
# bundled uploader as root (reads the file + the www-data-owned Drive tokens), then restores
# tokens.json ownership to www-data so the Drive service keeps working after a token refresh.
#
# Install at cutover:
#   sudo install -m 0755 docs/ops/webtmux-artifact-share.sh /usr/local/sbin/webtmux-artifact-share
#   echo 'tmuxweb ALL=(root) NOPASSWD: /usr/local/sbin/webtmux-artifact-share' \
#     | sudo tee /etc/sudoers.d/tmuxweb-artifact-share && sudo chmod 0440 /etc/sudoers.d/tmuxweb-artifact-share
#
# Usage: webtmux-artifact-share <file-path> <drive-filename.(exe|msi|apk|aab)>
# Prints the uploader's JSON ({shareLink,qr,...}) on stdout.
set -uo pipefail

file="${1:-}"; name="${2:-}"
HELPER="/root/.claude/skills/create-and-share-apk/share-apk-to-drive.mjs"
TOKENS="/var/www/tayyabcheema.com/subdomains/drive/config/tokens.json"
NODE="$(command -v node || echo /usr/bin/node)"

[[ "$name" =~ ^[A-Za-z0-9._-]+\.(exe|msi|apk|aab)$ ]] || { echo '{"error":"bad output name"}'; exit 1; }
[ -f "$file" ] || { echo '{"error":"file not found"}'; exit 1; }
[ -f "$HELPER" ] || { echo '{"error":"uploader missing"}'; exit 1; }

# The bundled uploader takes --apk/--name but uploads any file at that path unchanged.
out="$("$NODE" "$HELPER" --apk "$file" --name "$name" 2>/dev/null)"; rc=$?
chown www-data:www-data "$TOKENS" 2>/dev/null || true
[ $rc -eq 0 ] || { echo '{"error":"upload failed"}'; exit 1; }
printf '%s\n' "$out"
```

- [ ] **Step 2: Verify it parses**

Run: `cd /var/www/tmux.tayyabcheema.com && bash -n docs/ops/webtmux-artifact-share.sh && echo "bash ok"`
Expected: `bash ok`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add docs/ops/webtmux-artifact-share.sh
git commit -m "ops(windows): webtmux-artifact-share template (generalized Drive uploader for .exe/.msi)"
```

---

### Task 4: server.js — spawn delivery, tick reap, endpoint upgrade

**Files:**
- Modify: `server.js` — import Task 1 helpers; add `WINDOWS_DELIVER_STALL_MS`, `RALPH_WINDOWS_DELIVER_SH`, `spawnWindowsDelivery`; add the `windows-delivering` tick reap; upgrade the `POST /api/ralph/windows/installer` route to enter delivery after scaffolding.

**Interfaces:**
- Consumes: `installerShareName`, `parseWindowsDeliverResult`, `windowsDeliverableMarkdown` (Task 1); `prepareWindowsInstaller` (2a); `parseRepoSlug`, `tenantKey`, `githubToken`, `previewUrlFor`, `ralphSessionName`, `launchRalphSession`, `gitPushRef`, `revent`, `persistRun`, `ralphRuns`, `ralphTick`, `runSummary`.
- Produces: `run.windows.installer.{shareLink,qr,at}`; a `windows-delivering` phase.

- [ ] **Step 1: Import the helpers.** In `server.js`, find the `ralph/windows-scaffold.mjs` import line (~line 32) and add on the next line:

```js
import { installerShareName, parseWindowsDeliverResult, windowsDeliverableMarkdown } from './ralph/windows-deliver.mjs';
```

- [ ] **Step 2: Add the constants.** In `server.js`, find:

```js
const RALPH_DELIVER_SH = path.join(RALPH_DIR, 'ralph-deliver.sh');
```
Add immediately after it:

```js
const RALPH_WINDOWS_DELIVER_SH = path.join(RALPH_DIR, 'ralph-windows-deliver.sh');
```
Then find:

```js
const FLUTTER_DELIVER_STALL_MS = Number(process.env.WEBTMUX_DELIVER_STALL_MS || 15 * 60 * 1000);
```
Add immediately after it:

```js
// Windows installers build off-box on GitHub Actions (Rust compile ~10-15 min) — a longer cap.
const WINDOWS_DELIVER_STALL_MS = Number(process.env.WEBTMUX_WINDOWS_DELIVER_STALL_MS || 25 * 60 * 1000);
```

- [ ] **Step 3: Add `spawnWindowsDelivery`.** In `server.js`, immediately AFTER the `spawnDelivery` function (find its closing `}` — it ends with `run.deliverSince = Date.now();\n}`), insert:

```js

// Phase 2b: dispatch the scaffolded "Windows Package" Action, poll it, download the installer,
// and share it to Drive — off-box. Runs AS THE APP USER (no tenant prefix) so it can sudo the
// Drive uploader. gh auth via GH_TOKEN (tenant token). Writes .ralph/windows-deliver.json (reaped).
async function spawnWindowsDelivery(run) {
  const out = path.join(run.dir, '.ralph', 'windows-deliver.json');
  await fs.rm(out, { force: true }).catch(() => {});
  const token = tenantKey(run, 'github') || githubToken();
  const repo = parseRepoSlug(run.repo) || '';
  const name = installerShareName(run.project, 'exe');
  const session = ralphSessionName(run.project, 'windeliver', 'rd'); // app-user (no tenant prefix)
  const stub = process.env.RALPH_FORCE_TOOL ? ' --stub' : '';
  const cmd = `bash ${RALPH_WINDOWS_DELIVER_SH} --dir ${run.dir} --repo ${shq(repo)} --name ${shq(name)} `
    + `--out ${out} --url ${shq(previewUrlFor(run) || '')}${stub}`;
  // Pass the github token to the session's environment (not the command line) for gh auth.
  await launchRalphSession(session, run.dir, cmd, [`export GH_TOKEN=${shq(token)}`]);
  run.windowsDeliverSession = session;
  run.windowsDeliverSince = Date.now();
}
```

- [ ] **Step 4: Add the `windows-delivering` tick reap.** In `server.js`, find the END of the `else if (run.phase === 'delivering') {` block — it ends with:

```js
          run.phase = 'done';
          changed = true;
        }
      } else if (run.phase === 'researching') {
```
Replace with (insert a new `windows-delivering` branch before `researching`):

```js
          run.phase = 'done';
          changed = true;
        }
      } else if (run.phase === 'windows-delivering') {
        // 5c) Windows installer delivery: reap the off-box Actions build -> Drive link, record it.
        //     A failure here does NOT fail the build (the scaffold + web preview already exist).
        const out = path.join(run.dir, '.ralph', 'windows-deliver.json');
        let raw = null;
        try { raw = await fs.readFile(out, 'utf8'); } catch { /* pending */ }
        const stalled = Date.now() - (run.windowsDeliverSince || 0) > WINDOWS_DELIVER_STALL_MS;
        if (raw !== null || stalled) {
          try { await tmux(['kill-session', '-t', run.windowsDeliverSession]); } catch { /* gone */ }
          await fs.rm(out, { force: true }).catch(() => {});
          const info = parseWindowsDeliverResult(raw);
          const url = previewUrlFor(run);
          run.windows = run.windows || {}; run.windows.installer = run.windows.installer || {};
          if (info && info.shareLink) {
            Object.assign(run.windows.installer, { shareLink: info.shareLink, qr: info.qr || null, deliveredAt: Date.now() });
            const md = windowsDeliverableMarkdown({
              project: run.project, previewUrl: url, shareLink: info.shareLink, qr: info.qr,
              appId: run.windows.installer.appId, version: run.windows.installer.version, kind: 'exe',
            });
            await fs.writeFile(path.join(run.dir, 'DELIVERABLE.md'), md).catch(() => {});
            await gitCommitAll(run.dir, 'docs: record Windows installer link in DELIVERABLE.md').catch(() => {});
            await gitPushRef(run, 'main').catch(() => {});
            revent(run, `🪟 Windows installer ready — 💾 download: ${info.shareLink}`);
          } else {
            run.windows.installer.deliverWarning = (info && info.error) || (stalled ? 'delivery timed out' : 'delivery failed');
            revent(run, `⚠️ Windows installer delivery: ${run.windows.installer.deliverWarning} (the "Windows Package" Action can still be run/downloaded manually)`);
          }
          run.phase = 'done';
          changed = true;
        }
      } else if (run.phase === 'researching') {
```

- [ ] **Step 5: Upgrade the endpoint to enter delivery after scaffolding.** In `server.js`, find the success block of `POST /api/ralph/windows/installer`:

```js
    const info = await prepareWindowsInstaller(run, { appId, productName, version });
    const iconNote = info.iconSeeded ? '' : ' (no brand icon found — a placeholder icon was used; replace src-tauri/icons/source.png, ≥512px square, for branding)';
    const msg = info.pushed
      ? `Scaffolded the Windows installer for ${productName} (${appId} v${version}) and pushed it. Open GitHub → Actions → "Windows Package" → Run workflow, then download the "windows-installer" artifact. See ${info.doc}.${iconNote}`
      : `Scaffolded the Windows installer locally but the GitHub push failed — fix the repo/token (Doctor) and retry. See ${info.doc}.${iconNote}`;
    revent(run, `🪟 Windows installer scaffolded — run the "Windows Package" Action, then download the installer`);
    await persistRun(run);
    audit({ ralph: run.project, windows: 'installer' });
    res.json({ ...runSummary(run), message: msg });
```
Replace with:

```js
    const info = await prepareWindowsInstaller(run, { appId, productName, version });
    const iconNote = info.iconSeeded ? '' : ' (no brand icon found — a placeholder icon was used; replace src-tauri/icons/source.png, ≥512px square, for branding)';
    if (!info.pushed) {
      revent(run, '🪟 Windows installer scaffolded locally, but the GitHub push failed');
      await persistRun(run);
      return res.json({ ...runSummary(run), message: `Scaffolded the Windows installer for ${productName} (${appId} v${version}) locally, but the GitHub push failed — fix the repo/token (Doctor) and retry. See ${info.doc}.${iconNote}` });
    }
    // Pushed — now build it off-box on Actions and deliver the installer to Drive (Phase 2b).
    run.windows.installer.deliverWarning = null;
    run.phase = 'windows-delivering';
    revent(run, '📦 building the Windows installer on GitHub Actions and sharing a link…');
    await spawnWindowsDelivery(run);
    ralphRuns.set(run.key, run);
    await persistRun(run);
    ralphTick().catch(() => {});
    audit({ ralph: run.project, windows: 'installer' });
    res.json({ ...runSummary(run), message: `Scaffolded ${productName} (${appId} v${version}) and started the Windows installer build on GitHub Actions. The download link + QR appear here when it is ready (~10–15 min).${iconNote}` });
```

- [ ] **Step 6: Guard the endpoint against a re-trigger while delivering.** In `server.js`, find (in the same route, the phase gate):

```js
  if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first, then build the Windows installer.' });
```
Replace with:

```js
  if (run.phase === 'windows-delivering') return res.status(409).json({ error: 'A Windows installer build is already in progress.' });
  if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first, then build the Windows installer.' });
```

- [ ] **Step 7: Verify**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --check server.js && echo "server ok"
node --test ralph/*.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"
grep -n "spawnWindowsDelivery\|windows-delivering\|WINDOWS_DELIVER_STALL_MS" server.js
```
Expected: `server ok`; `# fail 0`; the spawn fn (def + call), the reap branch, and the constant present.

- [ ] **Step 8: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add server.js
git commit -m "feat(windows): off-box installer delivery — windows-delivering phase, reap, endpoint dispatch"
```

---

### Task 5: `web/` — show delivery progress + the Drive link/QR

**Files:**
- Modify: `web/src/pages/BuildDetail.jsx`

**Interfaces:**
- Consumes: `run.phase === 'windows-delivering'`, `run.windows?.installer?.shareLink`/`qr`/`deliverWarning` (from Task 4). Produces: an in-progress state + a download link/QR panel, mirroring the APK's `run.apk` display.

- [ ] **Step 1: Show the install link + QR panel.** In `web/src/pages/BuildDetail.jsx`, find the APK link panel:

```jsx
      {run.apk?.shareLink && (
```
Immediately BEFORE that line, insert a Windows panel:

```jsx
      {run.windows?.installer?.shareLink && (
        <div className="mt-4 flex items-start gap-4 rounded-xl border border-border bg-panel2 p-4">
          {run.windows.installer.qr && <img src={run.windows.installer.qr} alt="Scan to download the Windows installer" className="h-24 w-24 shrink-0 rounded bg-white p-1" />}
          <div className="min-w-0">
            <p className="text-sm font-medium">🪟 Windows installer ready</p>
            <a className="mt-1 inline-block break-all text-accent hover:underline" href={run.windows.installer.shareLink} target="_blank" rel="noreferrer">{run.windows.installer.shareLink}</a>
            <p className="mt-1 text-xs text-muted">Download and run on Windows. Unsigned builds show a SmartScreen prompt until signed.</p>
          </div>
        </div>
      )}
```

- [ ] **Step 2: Reflect the in-progress + warning states on the button.** In `web/src/pages/BuildDetail.jsx`, find the Windows button (from Phase 2a):

```jsx
          {isDone && run.outputFormat === 'web-app' && (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setWinDlg(true)} disabled={!!submitting}>
              {run.windows?.installer ? '🪟 Re-scaffold Windows installer' : '🪟 Build Windows installer'}
            </button>
          )}
```
Replace with (also show a building state when the run is delivering):

```jsx
          {run.outputFormat === 'web-app' && run.phase === 'windows-delivering' && (
            <span className="badge bg-panel2 text-muted">🪟 Building installer on Actions…</span>
          )}
          {isDone && run.outputFormat === 'web-app' && (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setWinDlg(true)} disabled={!!submitting}>
              {run.windows?.installer?.shareLink ? '🪟 Rebuild Windows installer' : (run.windows?.installer ? '🪟 Re-build Windows installer' : '🪟 Build Windows installer')}
            </button>
          )}
```

- [ ] **Step 3: Build the web UI**

Run: `cd /var/www/tmux.tayyabcheema.com/web && npm run build 2>&1 | tail -4`
Expected: Vite `✓ built`, no errors.

- [ ] **Step 4: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add web/src/pages/BuildDetail.jsx
git commit -m "feat(web): Windows installer delivery progress + Drive link/QR panel"
```

---

### Task 6: Docs + ops prerequisite

**Files:**
- Modify: `CLAUDE.md` (the "Windows installer (web-app, Phase 2a)" subsection)

- [ ] **Step 1: Update the CLAUDE.md subsection.** In `CLAUDE.md`, find the sentence in the Windows-installer subsection that begins `Auto-dispatch → poll → download → Google Drive link/QR is the separate **Phase 2b**.` and replace that sentence with:

```md
Phase 2b (shipped) makes "Build Windows installer" the full APK-style flow: the endpoint scaffolds
then enters the **`windows-delivering`** phase — `spawnWindowsDelivery` runs `ralph/ralph-windows-deliver.sh`
(app-user; `GH_TOKEN` = tenant token) which `gh workflow run`s the "Windows Package" Action, polls it,
`gh run download`s the `windows-installer` artifact, and shares the `.exe` to Google Drive via the
privileged **`webtmux-artifact-share`** wrapper; the tick reaps `.ralph/windows-deliver.json` → writes
`DELIVERABLE.md` (link + QR) → push + Web Push, setting `run.windows.installer.shareLink`. A delivery
failure never fails the build (the scaffold + preview already exist). Stub-aware (`RALPH_FORCE_TOOL`).
**Ops prerequisite:** install the host helper — `sudo install -m 0755 docs/ops/webtmux-artifact-share.sh
/usr/local/sbin/webtmux-artifact-share` + the `tmuxweb` sudoers line (see the script header); the tenant
github token needs `workflow`+`actions:write` scope. The Store path (PWABuilder / Electron MSIX) is Phase 3.
```

- [ ] **Step 2: Verify**

Run: `cd /var/www/tmux.tayyabcheema.com && grep -c "webtmux-artifact-share" CLAUDE.md`
Expected: `1` (or more).

- [ ] **Step 3: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): Windows installer Phase 2b (off-box delivery to Drive) + ops helper"
```

---

## Self-Review

- **Spec coverage (Phase 2b / delivery):**
  - *Box dispatches the Action, polls, downloads the artifact, shares to Drive with link+QR* → Task 2 (`ralph-windows-deliver.sh`) + Task 4 (`spawnWindowsDelivery` + reap). ✓
  - *Same APK delivery UX (DELIVERABLE.md, Web Push, `run.<x>.shareLink`)* → Task 4 reap (`windowsDeliverableMarkdown`, `revent`, `run.windows.installer.shareLink`) + Task 5 (link/QR panel). ✓
  - *Off-box, never local* → the build is entirely on Actions; the box only dispatches/polls/downloads/shares. ✓
  - *Generalized Drive uploader (`.exe`/`.msi`)* → Task 3 (`webtmux-artifact-share` template) + ops note (Task 6). ✓
  - *Never fails the build; always writes the sentinel; stub-aware* → Global Constraints, Task 2 (`emit`/`fail`/`--stub`), Task 4 (reap warns, phase→done). ✓
  - *Credentials (`GH_TOKEN` tenant token, repo slug)* → Task 4 (`spawnWindowsDelivery`). ✓
- **Placeholder scan:** none — full code for every step.
- **Type consistency:** `parseWindowsDeliverResult` returns `{shareLink,qr}|{error}|null` (Task 1) consumed exactly in Task 4. `installerShareName(project,'exe')` → `<slug>.exe` used in `spawnWindowsDelivery` + validated by `webtmux-artifact-share`'s `(exe|msi|apk|aab)` regex. `run.windows.installer` written in 2a (appId/version) and extended here (shareLink/qr/deliveredAt/deliverWarning), read in Task 5 (`run.windows?.installer?.shareLink`). Phase string `windows-delivering` consistent across spawn, reap, endpoint gate, and UI. ✓
- **Dependency on the smoke test:** the workflow/artifact are validated by the real Actions run done during Phase 2a follow-up; Task 2's `find … -name '*.exe'` is layout-robust. If the smoke test surfaced a scaffold fix (e.g. the `devUrl` fix), that lands in 2a, not here.
