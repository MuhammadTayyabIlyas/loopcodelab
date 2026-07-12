# Windows Installer — Phase 2a (scaffold + GitHub Actions) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On any finished `web-app` build, let the user press **"Build Windows installer"** — the box scaffolds a Tauri desktop wrapper around the built web app and commits a `windows-latest` GitHub Actions workflow to the generated repo; the user runs that workflow and downloads the `.exe`/`.msi` installer from the run's artifacts. (Auto-dispatch → poll → download → Google Drive is the separate Phase 2b.)

**Architecture:** Mirror the proven flutter-app **`POST /api/ralph/submit`** pattern ("scaffold CI, user runs it"): a pure module `ralph/windows-scaffold.mjs` generates the Tauri project files + the workflow YAML + a checklist; a `prepareWindowsInstaller(run, opts)` writer in `server.js` writes them into the repo, commits, and pushes; a thin `POST /api/ralph/windows/installer` endpoint validates input and calls it; a `web/` button + dialog triggers it. No off-box orchestration, no Drive, no secrets in 2a.

**Tech Stack:** Node (ESM, `node:test`), the Ralph orchestrator in `server.js`, React + Vite (`web/`), Tauri v2 (built on the GitHub Actions runner), `tauri-apps/tauri-action` / the `@tauri-apps/cli`.

## Global Constraints

- **The generated Tauri scaffold + workflow are NOT verifiable from this box.** They build only on a real GitHub Actions `windows-latest` runner. Automated verification in this plan is limited to `node --check server.js`, `node --test ralph/*.test.mjs` (pure helpers), and reading the emitted YAML/config. A real Actions **smoke test is a required post-merge step** (documented, like flutter-app's "not yet smoke-tested" caveat) — do NOT claim the installer builds until an Actions run proves it.
- **web-app + done only.** The endpoint requires `run.outputFormat === 'web-app'` and `run.phase === 'done'`. Other formats/phases are rejected (mirrors the `/submit` gates).
- **No hardcoding.** `productName`, `identifier` (appId), `version`, window title, and icon all come from the request/config or are derived from the project — never a literal app name/domain in the scaffold.
- **Scaffold, don't run.** 2a writes + commits + pushes files and returns a checklist message. It must NOT dispatch the workflow, poll, download, or touch Google Drive (Phase 2b). It sets `run.windows` (not `run.apk`).
- **Reuse, don't fork.** Mirror `POST /api/ralph/submit` (write files → `gitCommitAll` → `gitPushRef` → set `run.<x>` → `revent` → `persistRun` → `audit` → respond with `message`). Reuse `previewSafeProject`/slug helpers where useful.
- Verify gates: `node --check server.js`; `node --test ralph/*.test.mjs`. `server.js` binds a port on import — verify with `node --check`, never run it. After `web/src` edits: `cd web && npm run build`.
- Manual-checkpoint repo — commit only in each task's commit step.

## File Structure

- Create `ralph/windows-scaffold.mjs` — pure generators: input validation, appId/version helpers, and the exact text of every scaffold file (Tauri config + Rust + workflow + checklist). One responsibility: turn validated inputs into file contents.
- Create `ralph/windows-scaffold.test.mjs` — its unit tests.
- Modify `server.js` — import the module; add `prepareWindowsInstaller(run, opts)` (fs writer); add `POST /api/ralph/windows/installer`.
- Modify `web/src/api.js` — a `windowsInstaller(project, opts)` client method.
- Modify `web/src/pages/BuildDetail.jsx` — a "Build Windows installer" button + a small input dialog on finished web-app builds.
- Modify `CLAUDE.md` — a note + the smoke-test caveat.

---

### Task 1: `ralph/windows-scaffold.mjs` — pure scaffold generators + tests

**Files:**
- Create: `ralph/windows-scaffold.mjs`
- Test: `ralph/windows-scaffold.test.mjs`

**Interfaces:**
- Produces:
  - `WINDOWS_WORKFLOW_PATH = '.github/workflows/windows-package.yml'`
  - `WINDOWS_CHECKLIST_DOC = 'WINDOWS-INSTALLER.md'`
  - `defaultWindowsAppId(project) -> string` (e.g. `com.webtmux.notes`)
  - `validWindowsAppId(s) -> boolean` (reverse-DNS, Tauri identifier rules)
  - `sanitizeProductName(input, project) -> string`
  - `semverTo4Part(v) -> string | null` (`'1.2.3' -> '1.2.3.0'`; null if not x.y.z)
  - `validateWindowsInput({ appId, productName, version }) -> { ok, errors: string[] }`
  - `tauriConfJson({ productName, appId, version, frontendDist, beforeBuildCommand }) -> object`
  - `cargoToml({ crateName }) -> string`
  - `mainRs() -> string`, `buildRs() -> string`
  - `windowsPackageYaml({ frontendDir, hasNodeBuild }) -> string`
  - `windowsChecklistMd({ project, appId, version }) -> string`
  Task 2 (`prepareWindowsInstaller`) consumes all of these.

- [ ] **Step 1: Write the failing tests.** Create `ralph/windows-scaffold.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS_WORKFLOW_PATH, WINDOWS_CHECKLIST_DOC,
  defaultWindowsAppId, validWindowsAppId, sanitizeProductName, semverTo4Part,
  validateWindowsInput, tauriConfJson, cargoToml, mainRs, buildRs,
  windowsPackageYaml, windowsChecklistMd,
} from './windows-scaffold.mjs';

test('appId: default is reverse-DNS from the project; validity rules', () => {
  assert.equal(defaultWindowsAppId('My Notes App!'), 'com.webtmux.mynotesapp');
  assert.equal(validWindowsAppId('com.acme.app'), true);
  assert.equal(validWindowsAppId('com.acme'), true);
  assert.equal(validWindowsAppId('acme'), false);          // needs at least two segments
  assert.equal(validWindowsAppId('com.acme.'), false);     // trailing dot
  assert.equal(validWindowsAppId('com.1acme.app'), false); // segment starting with a digit
  assert.equal(validWindowsAppId('com.acme.my-app'), true);
});

test('semverTo4Part: x.y.z -> x.y.z.0; rejects non-semver', () => {
  assert.equal(semverTo4Part('1.2.3'), '1.2.3.0');
  assert.equal(semverTo4Part('0.0.1'), '0.0.1.0');
  assert.equal(semverTo4Part('1.2'), null);
  assert.equal(semverTo4Part('v1.2.3'), null);
  assert.equal(semverTo4Part('1.2.3.4'), null);
});

test('sanitizeProductName: falls back to the project, strips control chars, caps length', () => {
  assert.equal(sanitizeProductName('', 'notes'), 'notes');
  assert.equal(sanitizeProductName('  Cool App  ', 'x'), 'Cool App');
  assert.equal(sanitizeProductName('a'.repeat(200), 'x').length <= 60, true);
});

test('validateWindowsInput: reports every bad field; ok when all valid', () => {
  assert.deepEqual(validateWindowsInput({ appId: 'com.acme.app', productName: 'Notes', version: '1.0.0' }),
    { ok: true, errors: [] });
  const r = validateWindowsInput({ appId: 'acme', productName: '', version: '1.2' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /appId/i.test(e)));
  assert.ok(r.errors.some((e) => /version/i.test(e)));
});

test('tauriConfJson: v2 shape with identity/frontendDist/bundle targets', () => {
  const c = tauriConfJson({ productName: 'Notes', appId: 'com.acme.notes', version: '1.0.0', frontendDist: '../dist', beforeBuildCommand: '' });
  assert.equal(c.productName, 'Notes');
  assert.equal(c.version, '1.0.0');
  assert.equal(c.identifier, 'com.acme.notes');
  assert.equal(c.build.frontendDist, '../dist');
  assert.deepEqual(c.bundle.targets, ['nsis', 'msi']);
  assert.ok(Array.isArray(c.app.windows) && c.app.windows[0].title === 'Notes');
});

test('cargoToml/mainRs/buildRs: minimal valid Tauri v2 crate text', () => {
  const cargo = cargoToml({ crateName: 'app' });
  assert.match(cargo, /name = "app"/);
  assert.match(cargo, /tauri-build = \{ version = "2"/);
  assert.match(cargo, /tauri = \{ version = "2"/);
  assert.match(buildRs(), /tauri_build::build\(\)/);
  assert.match(mainRs(), /tauri::Builder::default\(\)/);
});

test('windowsPackageYaml: dispatchable windows-latest job that builds Tauri + uploads artifacts', () => {
  const y = windowsPackageYaml({ frontendDir: 'dist', hasNodeBuild: true });
  assert.match(y, /on:\s*\n\s*workflow_dispatch:/);
  assert.match(y, /runs-on: windows-latest/);
  assert.match(y, /tauri icon/);            // generates the icon set from the source png
  assert.match(y, /tauri build/);
  assert.match(y, /upload-artifact/);
  assert.match(y, /npm run build/);          // hasNodeBuild -> builds the web app first
});

test('windowsChecklistMd: names the workflow, run steps, and where the installer lands', () => {
  const md = windowsChecklistMd({ project: 'notes', appId: 'com.acme.notes', version: '1.0.0' });
  assert.match(md, /Windows installer/i);
  assert.match(md, /Actions/);
  assert.match(md, /com\.acme\.notes/);
  assert.match(md, /\.msi|\.exe/);
});

test('paths are the fixed constants', () => {
  assert.equal(WINDOWS_WORKFLOW_PATH, '.github/workflows/windows-package.yml');
  assert.equal(WINDOWS_CHECKLIST_DOC, 'WINDOWS-INSTALLER.md');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/windows-scaffold.test.mjs 2>&1 | tail -6`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Create `ralph/windows-scaffold.mjs`:**

```js
// Pure generators for the Windows-installer scaffold (Phase 2a). No fs/IO — the file
// contents and validation live here (unit-tested); server.js writes them into the repo.
// The installer itself builds on a GitHub Actions windows-latest runner via Tauri v2.

export const WINDOWS_WORKFLOW_PATH = '.github/workflows/windows-package.yml';
export const WINDOWS_CHECKLIST_DOC = 'WINDOWS-INSTALLER.md';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'app';
export function defaultWindowsAppId(project) { return `com.webtmux.${slug(project)}`; }

// Tauri identifier: 2+ dot segments, each starting with a letter, [a-z0-9-] after.
export function validWindowsAppId(s) {
  const v = String(s || '');
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(v)) return false;
  return !v.endsWith('.');
}

export function sanitizeProductName(input, project) {
  const v = String(input ?? '').replace(/[ -]/g, '').trim();
  return (v || String(project || 'App')).slice(0, 60);
}

export function semverTo4Part(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || '')) ? `${v}.0` : null;
}

export function validateWindowsInput({ appId, productName, version } = {}) {
  const errors = [];
  if (!validWindowsAppId(appId)) errors.push('appId must be reverse-DNS, e.g. com.acme.app');
  if (!sanitizeProductName(productName, '').trim() && !productName) { /* product falls back to project — never invalid */ }
  if (!semverTo4Part(version)) errors.push('version must be semver x.y.z, e.g. 1.0.0');
  return { ok: errors.length === 0, errors };
}

export function tauriConfJson({ productName, appId, version, frontendDist, beforeBuildCommand = '' }) {
  return {
    $schema: 'https://schema.tauri.app/config/2',
    productName,
    version,
    identifier: appId,
    build: { frontendDist, beforeBuildCommand, beforeDevCommand: '', devUrl: '' },
    app: {
      windows: [{ title: productName, width: 1200, height: 800, resizable: true }],
      security: { csp: null },
    },
    bundle: {
      active: true,
      targets: ['nsis', 'msi'],
      icon: ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.icns', 'icons/icon.ico'],
    },
  };
}

export function cargoToml({ crateName }) {
  return `[package]
name = "${crateName}"
version = "0.0.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[[bin]]
name = "${crateName}"
path = "src/main.rs"
`;
}

export function buildRs() {
  return `fn main() {
    tauri_build::build()
}
`;
}

export function mainRs() {
  return `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;
}

// windows-latest workflow: build the web app (if it has an npm build), generate the
// Tauri icon set from a committed source png, then `tauri build`, and upload the
// installer artifacts. Uses the maintained @tauri-apps/cli.
export function windowsPackageYaml({ frontendDir, hasNodeBuild }) {
  const webBuild = hasNodeBuild
    ? `      - name: Install & build web
        run: |
          npm ci || npm install
          npm run build
`
    : `      - name: (static web app — no build step)
        run: echo "using committed static output in ${frontendDir}"
`;
  return `name: Windows Package
on:
  workflow_dispatch: {}

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
${webBuild}      - name: Install Tauri CLI
        run: npm install -g @tauri-apps/cli@^2
      - name: Generate app icons
        run: tauri icon src-tauri/icons/source.png
      - name: Build installer
        run: tauri build
      - name: Upload installer
        uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: |
            src-tauri/target/release/bundle/nsis/*.exe
            src-tauri/target/release/bundle/msi/*.msi
          if-no-files-found: error
`;
}

export function windowsChecklistMd({ project, appId, version }) {
  return `# ${project} — Windows installer

This repo is scaffolded to build a Windows desktop installer (a native Tauri wrapper around the
built web app). The installer builds on a **GitHub Actions \`windows-latest\`** runner — nothing is
built on the server.

- **App identifier:** \`${appId}\`
- **Version:** \`${version}\`

## Build it
1. Push is already done. On GitHub, open **Actions → "Windows Package" → Run workflow**.
2. When the run finishes, open it and download the **\`windows-installer\`** artifact — it contains the
   \`.exe\` (NSIS) and \`.msi\` installers.
3. Run the \`.exe\` or \`.msi\` on a Windows machine to install the app.

## Notes
- The build wraps whatever the web app builds to (\`build/web\`/\`dist\`/\`build\`/\`out\`/\`public\`/root).
- For SmartScreen-clean installs, sign the installer with your own code-signing certificate (added in a
  later step). Unsigned installers show a SmartScreen prompt until the certificate earns reputation.
- App icons are generated from \`src-tauri/icons/source.png\`. Replace it with your brand icon (≥512×512
  PNG) for a branded installer.
`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/windows-scaffold.test.mjs 2>&1 | tail -5`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add ralph/windows-scaffold.mjs ralph/windows-scaffold.test.mjs
git commit -m "feat(windows): pure Tauri-installer scaffold generators (config, crate, workflow, checklist)"
```

---

### Task 2: `prepareWindowsInstaller(run, opts)` — write the scaffold into the repo

**Files:**
- Modify: `server.js` — import the module (~line 31, after the pwa-validate import); add `prepareWindowsInstaller` (near `writeDeliverable`/the flutter delivery helpers, ~line 2088)

**Interfaces:**
- Consumes: all of Task 1's generators; existing `gitCommitAll(dir, msg)`, `gitPushRef(run, ref)`, `previewUrlFor(run)`, `fs`, `path`.
- Produces: `prepareWindowsInstaller(run, { appId, productName, version }) -> { pushed, appId, version, productName, workflow, doc }`. Writes `src-tauri/{Cargo.toml,build.rs,src/main.rs,tauri.conf.json,icons/source.png}`, the workflow, and the checklist; commits; pushes; sets `run.windows = { installer: {...} }`.

- [ ] **Step 1: Import the generators.** In `server.js`, find the pwa-validate import (~line 31):

```js
import { pwaReport } from './ralph/pwa-validate.mjs';
```
Add on the next line:
```js
import { WINDOWS_WORKFLOW_PATH, WINDOWS_CHECKLIST_DOC, tauriConfJson, cargoToml, mainRs, buildRs, windowsPackageYaml, windowsChecklistMd } from './ralph/windows-scaffold.mjs';
```

- [ ] **Step 2: Add `prepareWindowsInstaller`.** In `server.js`, immediately BEFORE the `// Record the finished deliverable (web preview + APK install link) and commit it.` line (the comment just above `async function writeDeliverable`, ~line 2129), insert:

```js
// Scaffold a Tauri Windows-installer project + a windows-latest GitHub Actions workflow
// into a finished web-app repo, commit + push. The installer BUILDS ON ACTIONS, not here
// (Phase 2a: scaffold + user runs it). Locates the built static web dir the same way the
// host serves and points Tauri's frontendDist at it; copies a source icon if one is found.
const WIN_STATIC_DIRS = ['build/web', 'dist', 'build', 'out', 'public', '.'];
async function prepareWindowsInstaller(run, { appId, productName, version }) {
  const dir = run.dir;
  const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
  // Detect the built web output (relative to repo root) for Tauri's frontendDist.
  let webRel = '.';
  for (const d of WIN_STATIC_DIRS) {
    if (await exists(path.join(dir, d, 'index.html'))) { webRel = d; break; }
  }
  const hasNodeBuild = await exists(path.join(dir, 'package.json'));
  const frontendDist = `../${webRel}`; // src-tauri sits one level under the repo root
  const conf = tauriConfJson({ productName, appId, version, frontendDist, beforeBuildCommand: '' });

  const srcTauri = path.join(dir, 'src-tauri');
  await fs.mkdir(path.join(srcTauri, 'src'), { recursive: true });
  await fs.mkdir(path.join(srcTauri, 'icons'), { recursive: true });
  await fs.writeFile(path.join(srcTauri, 'Cargo.toml'), cargoToml({ crateName: 'app' }));
  await fs.writeFile(path.join(srcTauri, 'build.rs'), buildRs());
  await fs.writeFile(path.join(srcTauri, 'src', 'main.rs'), mainRs());
  await fs.writeFile(path.join(srcTauri, 'tauri.conf.json'), JSON.stringify(conf, null, 2) + '\n');

  // Seed the icon source from the PWA icon set if present (Phase 1 emits 512/maskable).
  const iconCandidates = ['icons/512.png', 'icons/512x512.png', 'icons/icon-512.png', 'icon.png', 'assets/brand/icon.png'];
  let seeded = false;
  for (const c of iconCandidates) {
    for (const base of [path.join(dir, webRel), dir]) {
      if (await exists(path.join(base, c))) {
        await fs.copyFile(path.join(base, c), path.join(srcTauri, 'icons', 'source.png')).catch(() => {});
        seeded = await exists(path.join(srcTauri, 'icons', 'source.png'));
        break;
      }
    }
    if (seeded) break;
  }

  const wfPath = path.join(dir, WINDOWS_WORKFLOW_PATH);
  await fs.mkdir(path.dirname(wfPath), { recursive: true });
  await fs.writeFile(wfPath, windowsPackageYaml({ frontendDir: webRel, hasNodeBuild }));
  await fs.writeFile(path.join(dir, WINDOWS_CHECKLIST_DOC), windowsChecklistMd({ project: run.project, appId, version }));

  await gitCommitAll(dir, `ci(windows): scaffold Tauri installer + Actions workflow`);
  const pushed = await gitPushRef(run, 'main').catch(() => false);
  run.windows = run.windows || {};
  run.windows.installer = {
    status: pushed ? 'scaffolded' : 'scaffolded_local',
    appId, productName, version, iconSeeded: seeded,
    workflow: WINDOWS_WORKFLOW_PATH, doc: WINDOWS_CHECKLIST_DOC, at: Date.now(),
  };
  return { pushed, appId, productName, version, workflow: WINDOWS_WORKFLOW_PATH, doc: WINDOWS_CHECKLIST_DOC, iconSeeded: seeded };
}
```

- [ ] **Step 3: Verify**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --check server.js && echo "server ok"
node --test ralph/*.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"
grep -n "prepareWindowsInstaller\|windows-scaffold.mjs" server.js
```
Expected: `server ok`; `# fail 0`; the import + the definition present.

- [ ] **Step 4: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add server.js
git commit -m "feat(windows): prepareWindowsInstaller writes the Tauri scaffold + workflow and pushes"
```

---

### Task 3: `POST /api/ralph/windows/installer` endpoint

**Files:**
- Modify: `server.js` — add the route immediately AFTER the `app.post('/api/ralph/submit', ...)` handler (~line 4320)

**Interfaces:**
- Consumes: `prepareWindowsInstaller` (Task 2), `defaultWindowsAppId`/`sanitizeProductName`/`validateWindowsInput` (Task 1 — add them to the import), `loadRun`, `tenantOf`, `validProject`, `runSummary`, `persistRun`, `revent`, `audit`.
- Produces: `POST /api/ralph/windows/installer {project, appId?, productName?, version?}` → scaffolds + pushes, returns `{...runSummary, message}`.

- [ ] **Step 1: Extend the Task-1 import** in `server.js` to also bring in the input helpers. Find the import added in Task 2 Step 1 and replace it with:

```js
import { WINDOWS_WORKFLOW_PATH, WINDOWS_CHECKLIST_DOC, tauriConfJson, cargoToml, mainRs, buildRs, windowsPackageYaml, windowsChecklistMd, defaultWindowsAppId, sanitizeProductName, validateWindowsInput } from './ralph/windows-scaffold.mjs';
```

- [ ] **Step 2: Add the route.** In `server.js`, find the end of the submit handler — the line:

```js
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
```
(the FIRST occurrence after `app.post('/api/ralph/submit'` — confirm by checking the handler above it is the submit route). Immediately AFTER that closing `});`, insert:

```js

// Phase 2a: scaffold a Tauri Windows installer + a windows-latest Actions workflow into a
// finished web-app repo (user runs the workflow and downloads the installer artifact). The
// build runs on Actions, not here; no Drive/dispatch (that is Phase 2b).
app.post('/api/ralph/windows/installer', async (req, res) => {
  const project = (req.body?.project || '').trim();
  if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
  const run = await loadRun(project, tenantOf(req));
  if (!run) return res.status(404).json({ error: 'No run for that project.' });
  if (run.outputFormat !== 'web-app') return res.status(409).json({ error: 'Windows installers are only for web-app builds.' });
  if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first, then build the Windows installer.' });
  const appId = (req.body?.appId || '').trim() || defaultWindowsAppId(run.project);
  const productName = sanitizeProductName(req.body?.productName, run.project);
  const version = (req.body?.version || '1.0.0').trim();
  const check = validateWindowsInput({ appId, productName, version });
  if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
  try {
    const info = await prepareWindowsInstaller(run, { appId, productName, version });
    const iconNote = info.iconSeeded ? '' : ' (no source icon found — add src-tauri/icons/source.png, ≥512px, for a branded installer)';
    const msg = info.pushed
      ? `Scaffolded the Windows installer for ${productName} (${appId} v${version}) and pushed it. Open GitHub → Actions → "Windows Package" → Run workflow, then download the "windows-installer" artifact. See ${info.doc}.${iconNote}`
      : `Scaffolded the Windows installer locally but the GitHub push failed — fix the repo/token (Doctor) and retry. See ${info.doc}.${iconNote}`;
    revent(run, `🪟 Windows installer scaffolded — run the "Windows Package" Action, then download the installer`);
    await persistRun(run);
    audit({ ralph: run.project, windows: 'installer' });
    res.json({ ...runSummary(run), message: msg });
  } catch (err) {
    res.status(502).json({ error: `Could not scaffold the Windows installer: ${err.message}` });
  }
});
```

- [ ] **Step 3: Verify**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --check server.js && echo "server ok"
grep -n "api/ralph/windows/installer" server.js
node --test ralph/*.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `server ok`; one route match; `# fail 0`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add server.js
git commit -m "feat(windows): POST /api/ralph/windows/installer scaffolds + pushes the installer CI"
```

---

### Task 4: `web/` UI — "Build Windows installer" button + dialog

**Files:**
- Modify: `web/src/api.js` — add `windowsInstaller`
- Modify: `web/src/pages/BuildDetail.jsx` — a button (finished web-app builds) + a small identity dialog

**Interfaces:**
- Consumes: the endpoint from Task 3. Produces: a user-facing trigger on finished web-app builds.

- [ ] **Step 1: Add the api client.** In `web/src/api.js`, find:

```js
  // submit a finished flutter-app to an app store (separate step). store: 'play' | 'ios'.
  submit: (project, store = 'play', opts = {}) => req('POST', '/api/ralph/submit', { project, store, ...opts }),
```
Add immediately after it (inside the same object):

```js
  // Phase 2a: scaffold a Windows installer (Tauri) + Actions workflow for a finished web-app build.
  windowsInstaller: (project, opts = {}) => req('POST', '/api/ralph/windows/installer', { project, ...opts }),
```

- [ ] **Step 2: Add the button + dialog to BuildDetail.** In `web/src/pages/BuildDetail.jsx`, find the flutter action block:

```jsx
          {isDone && run.outputFormat === 'flutter-app' && (
```
Immediately BEFORE that line, insert a web-app Windows block (uses the existing `submitting` state + `api` + `load` already in the component, and a local dialog state added in Step 3):

```jsx
          {isDone && run.outputFormat === 'web-app' && (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setWinDlg(true)} disabled={!!submitting}>
              {run.windows?.installer ? '🪟 Re-scaffold Windows installer' : '🪟 Build Windows installer'}
            </button>
          )}
```

- [ ] **Step 3: Add the dialog + handler.** In `web/src/pages/BuildDetail.jsx`, find the `const [submitting, setSubmitting] = useState(false);` line and add right after it:

```jsx
  const [winDlg, setWinDlg] = useState(false);
  const [winForm, setWinForm] = useState({ appId: '', productName: '', version: '1.0.0' });
  async function buildWindows() {
    setSubmitting('windows'); setWinDlg(false);
    try {
      const r = await api.windowsInstaller(project, {
        appId: winForm.appId.trim() || undefined,
        productName: winForm.productName.trim() || undefined,
        version: winForm.version.trim() || undefined,
      });
      setDiag({ text: r.message || 'Windows installer scaffolded — run the "Windows Package" Action, then download the installer.' });
      load();
    } catch (e) { setDiag({ text: e.message, error: true }); }
    finally { setSubmitting(false); }
  }
```

- [ ] **Step 4: Render the dialog.** In `web/src/pages/BuildDetail.jsx`, find the closing of the component's returned JSX — the last `</div>` before the final `);` of the `return (`. Immediately BEFORE that final closing tag, insert the modal:

```jsx
      {winDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setWinDlg(false)}>
          <div className="w-full max-w-md rounded-xl bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">Build Windows installer</h3>
            <p className="mb-3 text-xs text-muted">Wraps the finished web app as a Tauri desktop installer, built on a GitHub Actions Windows runner. Leave blank for sensible defaults.</p>
            <label className="label">App identifier</label>
            <input className="input mb-3" placeholder={`com.webtmux.${(project || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '')}`}
              value={winForm.appId} onChange={(e) => setWinForm((f) => ({ ...f, appId: e.target.value }))} />
            <label className="label">Product name</label>
            <input className="input mb-3" placeholder={project} value={winForm.productName}
              onChange={(e) => setWinForm((f) => ({ ...f, productName: e.target.value }))} />
            <label className="label">Version</label>
            <input className="input mb-4" placeholder="1.0.0" value={winForm.version}
              onChange={(e) => setWinForm((f) => ({ ...f, version: e.target.value }))} />
            <div className="flex justify-end gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setWinDlg(false)}>Cancel</button>
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={buildWindows}>Scaffold & push</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Build the web UI**

Run: `cd /var/www/tmux.tayyabcheema.com/web && npm run build 2>&1 | tail -4`
Expected: Vite `✓ built`, no errors.

- [ ] **Step 6: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add web/src/api.js web/src/pages/BuildDetail.jsx
git commit -m "feat(web): Build Windows installer button + dialog on finished web-app builds"
```

---

### Task 5: Docs + smoke-test caveat

**Files:**
- Modify: `CLAUDE.md` (the flutter-app / output-format area — a short subsection)

- [ ] **Step 1: Add the note.** In `CLAUDE.md`, find the line `### Flutter app builds (\`flutter-app\` output format)` and insert immediately BEFORE it:

```md
### Windows installer (web-app, Phase 2a)
A finished `web-app` build can be packaged as a **Windows desktop installer** (Tauri). `POST
/api/ralph/windows/installer` (the "Build Windows installer" button in `web/` BuildDetail; gated on
`web-app` + `done`) calls `prepareWindowsInstaller`, which writes a Tauri `src-tauri/` scaffold +
`.github/workflows/windows-package.yml` + `WINDOWS-INSTALLER.md` (all from the pure, tested
`ralph/windows-scaffold.mjs`) and pushes them. The installer **builds on a GitHub Actions
`windows-latest` runner**, never on this box; the user runs the "Windows Package" Action and downloads
the `.exe`/`.msi` from the run's `windows-installer` artifact. Sets `run.windows.installer`.
**NOT YET SMOKE-TESTED against a real Actions run** — the Tauri scaffold/build correctness (icons,
frontendDist, toolchain) must be verified with one real `windows-latest` run before relying on it.
Auto-dispatch → poll → download → Google Drive link/QR is the separate **Phase 2b**. Spec:
`docs/superpowers/specs/2026-07-01-pwa-default-windows-packaging-design.md`.

```

- [ ] **Step 2: Verify**

Run: `cd /var/www/tmux.tayyabcheema.com && grep -c "Windows installer (web-app, Phase 2a)" CLAUDE.md`
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): Windows installer Phase 2a (scaffold + Actions) + smoke-test caveat"
```

---

## Self-Review

- **Spec coverage (Phase 2 — installer half, "scaffold" scope):**
  - *"Build Windows installer" action on every finished web-app build* → Task 3 (endpoint, gated web-app+done) + Task 4 (button). ✓
  - *Tauri scaffold around the built web app (identity/version/icons from config, no hardcoding)* → Task 1 (generators) + Task 2 (writer, frontendDist detection + icon seeding). ✓
  - *`windows-latest` GitHub Actions workflow the user runs* → Task 1 (`windowsPackageYaml`) + Task 2 (writes/pushes it) + Task 5 (checklist). ✓
  - *Output = installer downloadable from the run (`/dist/windows-installer` conceptually = the artifact)* → the workflow uploads NSIS `.exe` + MSI `.msi` as the `windows-installer` artifact. ✓
  - *Validation (appId, version, publisher≠product)* → Task 1 `validateWindowsInput` (appId + semver; publisher/product identity belongs to the Store path, deferred to Phase 3). ✓ for the installer scope.
  - *Modular / future targets* → `windows-scaffold.mjs` is a self-contained generator module; Phase 2b/3 add packagers beside it. ✓
  - *Auto Drive delivery* → **explicitly deferred to Phase 2b** (Global Constraints). ✓
- **Placeholder scan:** none — full file contents/code for every step.
- **Type consistency:** `prepareWindowsInstaller(run, {appId, productName, version})` returns `{pushed, appId, productName, version, workflow, doc, iconSeeded}` and is consumed exactly so in Task 3. `run.windows.installer` shape is written in Task 2 and read by the UI (`run.windows?.installer`) in Task 4. Generator names (`tauriConfJson`, `windowsPackageYaml`, `windowsChecklistMd`, `validateWindowsInput`, `defaultWindowsAppId`, `sanitizeProductName`) match between Task 1 (defined), Task 2/3 (imported), and the tests. `WINDOWS_WORKFLOW_PATH`/`WINDOWS_CHECKLIST_DOC` constants are single-sourced. ✓
- **Risk note (honest):** the one thing this plan cannot verify is that the emitted Tauri scaffold actually builds on `windows-latest` — Task 5 records the required real-Actions smoke test. All server/UI wiring and the pure generators ARE verified (node --check, unit tests, Vite build).
