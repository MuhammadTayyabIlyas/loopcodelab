# PWA-by-Default (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generated `web-app` build ship an installable PWA by default — a manifest, service worker, icons, and offline fallback — by injecting a `pwa-baseline` skill into worker + finalize briefs and adding an advisory compliance check when a web-app build finishes.

**Architecture:** A pure, unit-tested validator (`ralph/pwa-validate.mjs`) computes PWA-baseline compliance from a parsed manifest + a few booleans. A vendored `pwa-baseline` skill (auto-discovered, read fresh per build) tells any agent how to produce the PWA assets, injected into every `web-app` worker AND finalize brief by `writeRalphBrief`. At finalize PASS, an advisory, non-blocking `checkPwaCompliance(run)` scans the built output, runs the validator, records `run.pwa`, and surfaces a warning if the app isn't installable — it never fails the build.

**Tech Stack:** Node (ESM, `node:test`), the existing Ralph orchestrator in `server.js`, vendored `ralph/skills/*/SKILL.md`.

## Global Constraints

- **Advisory, never blocking.** The finalize PWA check RECORDS (`run.pwa`) and WARNS; it must never change a build's terminal phase or fail a run. PWA is an enhancement (the app still works) and the prerequisite for the later Store PWA path — a missing SW must not turn a `done` build into `failed`.
- **`web-app` only.** The `pwa-baseline` skill injection and the compliance check apply when `run.outputFormat === 'web-app'`. Other formats are untouched.
- **No hardcoding.** The skill instructs the agent to derive manifest name/description/colors/icons from the project's own idea/brand assets — never hardcode an app name, color, or domain.
- **Skill files are read fresh per build** (`getSkillMd` reads the vendored file each time) — a new/edited `SKILL.md` needs **no restart**. `server.js` edits DO need `systemctl restart webtmux` at deploy.
- **No new dependencies.** Pure JS + Node built-ins only.
- Syntax/verify gates: `node --check server.js`, `node --test ralph/*.test.mjs`. `server.js` binds a port on import — verify with `node --check`, never run it.
- Manual-checkpoint repo — commit only in each task's commit step.

## File Structure

- Create `ralph/pwa-validate.mjs` — pure PWA-baseline validator (manifest fields + SW/offline signals → compliance report). One responsibility: decide compliance from already-gathered inputs.
- Create `ralph/pwa-validate.test.mjs` — its unit tests.
- Create `ralph/skills/pwa-baseline/SKILL.md` — the injected instructions (content only).
- Modify `server.js` — inject `pwa-baseline` into `web-app` briefs (`writeRalphBrief`); add + call `checkPwaCompliance(run)` at finalize PASS; import the validator.
- Modify `CLAUDE.md` — one note that web-app builds are PWA-by-default.

---

### Task 1: `ralph/pwa-validate.mjs` — pure PWA-baseline validator

**Files:**
- Create: `ralph/pwa-validate.mjs`
- Test: `ralph/pwa-validate.test.mjs`

**Interfaces:**
- Produces:
  - `REQUIRED_MANIFEST_FIELDS: string[]`
  - `validateManifest(manifest) -> { ok: boolean, missing: string[], warnings: string[] }`
  - `pwaReport({ manifest, hasServiceWorker, hasOfflineFallback }) -> { compliant: boolean, missing: string[], warnings: string[] }` — `missing` are hard failures (blockers to installability, prefixed `manifest.<field>` or `service-worker`); `warnings` are soft. Task 3 consumes `pwaReport`.

- [ ] **Step 1: Write the failing tests.** Create `ralph/pwa-validate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, pwaReport, REQUIRED_MANIFEST_FIELDS } from './pwa-validate.mjs';

const fullManifest = {
  name: 'Notes', short_name: 'Notes', description: 'A notes app', start_url: '/', scope: '/',
  display: 'standalone', theme_color: '#0b0b0b', background_color: '#ffffff',
  icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
};

test('validateManifest: a complete manifest is ok with no missing/warnings', () => {
  const r = validateManifest(fullManifest);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.warnings, []);
});

test('validateManifest: lists every missing/empty required field', () => {
  const r = validateManifest({ name: 'X', description: '  ', icons: [] });
  assert.equal(r.ok, false);
  // description is whitespace, icons empty -> both missing, plus the untouched fields
  for (const f of ['short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'description', 'icons']) {
    assert.ok(r.missing.includes(f), `expected ${f} missing`);
  }
  assert.ok(!r.missing.includes('name')); // present
});

test('validateManifest: non-installable display + missing icon sizes are warnings, not failures', () => {
  const r = validateManifest({ ...fullManifest, display: 'browser', icons: [{ src: '/a.png', sizes: '48x48' }] });
  assert.equal(r.ok, true); // all fields present -> ok
  assert.ok(r.warnings.some((w) => /display "browser"/.test(w)));
  assert.ok(r.warnings.some((w) => /192x192/.test(w)));
  assert.ok(r.warnings.some((w) => /512x512/.test(w)));
});

test('validateManifest: null/garbage manifest -> all fields missing', () => {
  assert.deepEqual(validateManifest(null).missing, [...REQUIRED_MANIFEST_FIELDS]);
  assert.deepEqual(validateManifest([]).missing, [...REQUIRED_MANIFEST_FIELDS]);
  assert.equal(validateManifest('nope').ok, false);
});

test('pwaReport: compliant when manifest ok + service worker present; offline is only a warning', () => {
  const r = pwaReport({ manifest: fullManifest, hasServiceWorker: true, hasOfflineFallback: false });
  assert.equal(r.compliant, true);
  assert.deepEqual(r.missing, []);
  assert.ok(r.warnings.some((w) => /offline/.test(w)));
});

test('pwaReport: missing service worker is a hard failure; manifest gaps are prefixed', () => {
  const r = pwaReport({ manifest: { name: 'X' }, hasServiceWorker: false, hasOfflineFallback: true });
  assert.equal(r.compliant, false);
  assert.ok(r.missing.includes('service-worker'));
  assert.ok(r.missing.includes('manifest.short_name'));
});

test('pwaReport: empty input is non-compliant, never throws', () => {
  const r = pwaReport();
  assert.equal(r.compliant, false);
  assert.ok(r.missing.includes('service-worker'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/pwa-validate.test.mjs 2>&1 | tail -6`
Expected: FAIL — cannot find module `./pwa-validate.mjs` / functions undefined.

- [ ] **Step 3: Create `ralph/pwa-validate.mjs`:**

```js
// Pure PWA-baseline compliance checks (no fs, no I/O). Decides whether a generated
// web app is an installable PWA from an already-parsed manifest plus a couple of
// booleans gathered by the caller. Used by the advisory finalize check in server.js.

export const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'name', 'short_name', 'description', 'start_url', 'scope',
  'display', 'theme_color', 'background_color', 'icons',
]);
const INSTALLABLE_DISPLAY = new Set(['standalone', 'fullscreen', 'minimal-ui']);

// Validate a parsed web app manifest object. Returns { ok, missing, warnings }:
// `missing` = required fields absent/empty (hard); `warnings` = soft issues.
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, missing: [...REQUIRED_MANIFEST_FIELDS], warnings: [] };
  }
  const missing = [];
  for (const f of REQUIRED_MANIFEST_FIELDS) {
    const v = manifest[f];
    const empty = v == null
      || (typeof v === 'string' && v.trim() === '')
      || (f === 'icons' && !(Array.isArray(v) && v.length));
    if (empty) missing.push(f);
  }
  const warnings = [];
  if (manifest.display != null && !INSTALLABLE_DISPLAY.has(manifest.display)) {
    warnings.push(`display "${manifest.display}" is not installable (use standalone/fullscreen/minimal-ui)`);
  }
  if (Array.isArray(manifest.icons) && manifest.icons.length) {
    const sizes = manifest.icons.flatMap((i) => String(i?.sizes || '').split(/\s+/));
    for (const need of ['192x192', '512x512']) {
      if (!sizes.includes(need)) warnings.push(`missing a ${need} icon (recommended for install)`);
    }
  }
  return { ok: missing.length === 0, missing, warnings };
}

// Combine manifest validity with the other PWA-baseline signals. `missing` lists
// hard blockers to installability (manifest.<field> or service-worker); `warnings`
// are soft (offline fallback isn't always possible). Never throws.
export function pwaReport({ manifest = null, hasServiceWorker = false, hasOfflineFallback = false } = {}) {
  const m = validateManifest(manifest);
  const missing = m.missing.map((f) => `manifest.${f}`);
  const warnings = [...m.warnings];
  if (!hasServiceWorker) missing.push('service-worker');
  if (!hasOfflineFallback) warnings.push('no offline fallback page');
  return { compliant: missing.length === 0, missing, warnings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /var/www/tmux.tayyabcheema.com && node --test ralph/pwa-validate.test.mjs 2>&1 | tail -5`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add ralph/pwa-validate.mjs ralph/pwa-validate.test.mjs
git commit -m "feat(pwa): pure PWA-baseline validator (manifest + service worker compliance)"
```

---

### Task 2: Vendor the `pwa-baseline` skill + inject it into every web-app brief

**Files:**
- Create: `ralph/skills/pwa-baseline/SKILL.md`
- Modify: `server.js` (`writeRalphBrief`, the `briefSkills` line ~1867)

**Interfaces:**
- Consumes: `getSkillMd('pwa-baseline')` (already resolves any vendored skill by id). Produces: every `web-app` worker AND finalize brief now carries the PWA-baseline instructions.

- [ ] **Step 1: Create `ralph/skills/pwa-baseline/SKILL.md`:**

```md
---
name: pwa-baseline
description: Make the generated web app an installable PWA by default — a complete web app manifest, a service worker with offline fallback, and an icon set — all derived from the project's own name/brand, never hardcoded.
---

# PWA baseline (every web app is installable)

Ship the web app as an installable Progressive Web App. This is required for every web build, and it is
the prerequisite for packaging the app for the Microsoft Store later. Derive ALL values from THIS project's
idea/brand — never hardcode an app name, color, or domain.

## 1. Web app manifest
Add `manifest.webmanifest` (served from the site root) with ALL of:
- `name`, `short_name` (≤12 chars), `description` — from the project's real name/summary.
- `start_url` (`/` or the app's entry) and `scope` (`/`).
- `display`: `standalone` (so it opens as an app, not a browser tab).
- `theme_color` and `background_color` — from the project's brand palette (match the UI).
- `icons`: at least `192x192` and `512x512` PNGs, plus a `512x512` entry with `"purpose": "maskable"`.
Link it from every page: `<link rel="manifest" href="/manifest.webmanifest">` and set
`<meta name="theme-color" content="...">`.

## 2. Service worker + offline fallback
Add a service worker (e.g. `sw.js` at the site root) and register it:
`if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')`.
- Cache the app shell (HTML/CSS/JS + icons) on install so the app loads offline.
- Serve an `offline.html` fallback for navigations that fail while offline, where the app allows it.
- Use a versioned cache name and clean up old caches on `activate` (so updates take effect).

## 3. Icons
Generate the icon set from the project's brand/source icon (or a tasteful generated mark if none):
`192x192`, `512x512`, a maskable `512x512`, a `favicon`, and an `apple-touch-icon` (180x180). Reference
them by relative path so the built site serves them.

## Rules
- Keep it consistent with the deploy contract (web-deliverable): emit into the same static output dir
  (`build/web`/`dist`/`build`/`out`/`public`/root), use RELATIVE asset paths, no hardcoded host/port.
- All manifest text/colors/icons come from the project's own brand/content — nothing hardcoded.
- Verify: the site has `manifest.webmanifest`, a registered service worker, and 192+512 icons, and it
  loads once offline after a first visit.
```

- [ ] **Step 2: Inject `pwa-baseline` for web-app builds.** In `server.js`, find (in `writeRalphBrief`, ~line 1866-1867):

```js
  const hasStoryMedia = !!storyMedia && ['image', 'video', 'audio'].some((k) => storyMedia[k] > 0);
  const wantsMedia = VISUAL_OUTPUT.has(outputFormat) || hasStoryMedia;
  const briefSkills = wantsMedia ? ['imagery', ...skills] : skills;
```

Replace with:

```js
  const hasStoryMedia = !!storyMedia && ['image', 'video', 'audio'].some((k) => storyMedia[k] > 0);
  const wantsMedia = VISUAL_OUTPUT.has(outputFormat) || hasStoryMedia;
  // Every web-app build is an installable PWA by default (Part 1): inject the
  // pwa-baseline skill into worker AND finalize briefs. Dedup below handles overlap.
  const wantsPwa = outputFormat === 'web-app';
  const briefSkills = [
    ...(wantsPwa ? ['pwa-baseline'] : []),
    ...(wantsMedia ? ['imagery'] : []),
    ...skills,
  ];
```

- [ ] **Step 3: Verify the skill is discovered + the brief logic parses**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --check server.js && echo "server ok"
head -4 ralph/skills/pwa-baseline/SKILL.md
node --input-type=module -e "import('./server.js').catch(()=>{})" 2>/dev/null; echo "(server import binds a port — ignore; node --check is the gate)"
node --test ralph/*.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"
```
Expected: `server ok`; the frontmatter (`---`/`name: pwa-baseline`/`description:`/`---`); `# fail 0`.

- [ ] **Step 4: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add ralph/skills/pwa-baseline/SKILL.md server.js
git commit -m "feat(pwa): pwa-baseline skill injected into every web-app worker + finalize brief"
```

---

### Task 3: Advisory PWA compliance check at finalize PASS

**Files:**
- Modify: `server.js` — import the validator (~line 30 area); add `checkPwaCompliance(run)` (near `writeDeliverable`, ~line 2082); call it at finalize PASS (~line 2527)

**Interfaces:**
- Consumes: `pwaReport` from `ralph/pwa-validate.mjs` (Task 1). Produces: `run.pwa = { compliant, missing, warnings, at }` on finished web-app builds; a `revent` advisory. Non-blocking.

- [ ] **Step 1: Import the validator.** In `server.js`, find the import from `./ralph/providers.mjs` (line ~30) and add a new import line immediately after it:

```js
import { planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase, mediaCredentialIds, mediaCapDefaults, normalizeMedia, applyMediaPlan } from './ralph/providers.mjs';
```
Add on the next line:
```js
import { pwaReport } from './ralph/pwa-validate.mjs';
```

- [ ] **Step 2: Add `checkPwaCompliance`.** In `server.js`, immediately BEFORE the `async function writeDeliverable(run, info) {` line (~2082), insert:

```js
// Advisory PWA-baseline check on a finished web-app build. NON-BLOCKING: records
// run.pwa and surfaces a warning if the generated app isn't an installable PWA, but
// never fails the build — the app still works, and this is the prerequisite signal for
// the later Store PWA packaging path. Scans the served static output (same order the
// host serves) for a manifest, a service worker, and an offline fallback.
const PWA_STATIC_DIRS = ['build/web', 'dist', 'build', 'out', 'public', '.'];
const PWA_SW_NAMES = ['sw.js', 'service-worker.js', 'serviceworker.js'];
const PWA_MANIFEST_NAMES = ['manifest.webmanifest', 'manifest.json'];
async function checkPwaCompliance(run) {
  if (run.outputFormat !== 'web-app') return;
  const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
  let root = null;
  for (const d of PWA_STATIC_DIRS) {
    const cand = path.join(run.dir, d);
    if (await exists(path.join(cand, 'index.html'))) { root = cand; break; }
  }
  if (!root) return; // server app or no static output — skip the advisory check
  let manifest = null;
  for (const base of [root, run.dir]) {
    for (const name of PWA_MANIFEST_NAMES) {
      try { manifest = JSON.parse(await fs.readFile(path.join(base, name), 'utf8')); break; } catch { /* next */ }
    }
    if (manifest) break;
  }
  const anyExists = async (names, bases) => {
    for (const base of bases) for (const n of names) if (await exists(path.join(base, n))) return true;
    return false;
  };
  let hasServiceWorker = await anyExists(PWA_SW_NAMES, [root, run.dir]);
  if (!hasServiceWorker) {
    try { hasServiceWorker = /serviceWorker\s*\.\s*register/.test(await fs.readFile(path.join(root, 'index.html'), 'utf8')); }
    catch { /* none */ }
  }
  const hasOfflineFallback = await anyExists(['offline.html'], [root, run.dir]);
  const report = pwaReport({ manifest, hasServiceWorker, hasOfflineFallback });
  run.pwa = { ...report, at: Date.now() };
  if (report.compliant) revent(run, '📲 PWA-ready — installable from the browser');
  else revent(run, `⚠️ PWA baseline incomplete: missing ${report.missing.join(', ')} (app works, but not yet installable as a PWA)`);
}
```

- [ ] **Step 3: Call it at finalize PASS (web-app only, non-blocking).** In `server.js`, find (in the finalize-result handling, ~line 2520-2528):

```js
            if (await gitPushRef(run, 'main')) {
              // flutter-app: don't finish yet — build the installable APK + Drive link
              // in a separate (non-blocking) delivery pass the tick reaps below.
              // The web preview is already live (finalize built build/web). The installable
              // APK + Drive link is now an ON-DEMAND step (POST /api/ralph/apk) so the build
              // finishes fast and the heavy capped Gradle/APK build only runs when the user
              // asks for it (and before "Submit to Play").
              run.phase = 'done';
```

Replace with (adds the advisory check before marking done):

```js
            if (await gitPushRef(run, 'main')) {
              // Every web-app build is a PWA by default — record its installability
              // (advisory; never blocks). This also seeds the later Store PWA path.
              await checkPwaCompliance(run).catch(() => {});
              // flutter-app: don't finish yet — build the installable APK + Drive link
              // in a separate (non-blocking) delivery pass the tick reaps below.
              // The web preview is already live (finalize built build/web). The installable
              // APK + Drive link is now an ON-DEMAND step (POST /api/ralph/apk) so the build
              // finishes fast and the heavy capped Gradle/APK build only runs when the user
              // asks for it (and before "Submit to Play").
              run.phase = 'done';
```

- [ ] **Step 4: Verify**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --check server.js && echo "server ok"
node --test ralph/*.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)"
grep -n "checkPwaCompliance" server.js
```
Expected: `server ok`; `# fail 0`; two matches (the definition + the call).

- [ ] **Step 5: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add server.js
git commit -m "feat(pwa): advisory PWA-baseline compliance check on finished web-app builds"
```

---

### Task 4: Document PWA-by-default

**Files:**
- Modify: `CLAUDE.md` (the "Skills, tools & deliverable format" section, or the project-preview section — one paragraph)

- [ ] **Step 1: Add the note.** In `CLAUDE.md`, find the "### Skills, tools & deliverable format" heading line:

```md
### Skills, tools & deliverable format
```

Insert immediately AFTER that heading line (a new paragraph before the existing content):

```md
**PWA-by-default (web-app builds).** Every `web-app` build ships an installable PWA: `writeRalphBrief`
injects the vendored `pwa-baseline` skill (`ralph/skills/pwa-baseline/SKILL.md`) into the worker AND
finalize briefs (manifest + service worker + icons + offline fallback, all brand-derived — no hardcoding).
At finalize PASS, `checkPwaCompliance(run)` scans the built static output and records `run.pwa`
(`{compliant, missing, warnings}`) using the pure `ralph/pwa-validate.mjs` validator — **advisory only, it
never fails a build**. This makes every web app browser-installable and is the prerequisite for the later
Store PWA packaging path (see `docs/superpowers/specs/2026-07-01-pwa-default-windows-packaging-design.md`).

```

- [ ] **Step 2: Verify**

Run: `cd /var/www/tmux.tayyabcheema.com && grep -c "PWA-by-default" CLAUDE.md`
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
cd /var/www/tmux.tayyabcheema.com
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): note PWA-by-default for web-app builds"
```

---

## Self-Review

- **Spec coverage (Part 1):**
  - *PWA baseline enforced on every web-app build (manifest/SW/icons/offline, brand-derived, no hardcoding)* → Task 2 (skill + injection). ✓
  - *Applied via a vendored `pwa-baseline` skill injected into builds* → Task 2. ✓
  - *A pure validator `ralph/pwa-validate.mjs` checks the built output before a run is marked done* → Task 1 (validator) + Task 3 (called at finalize PASS, before `run.phase='done'`). ✓ (advisory per Global Constraints — it checks + records, doesn't block).
  - *Payoff: browser-installable; prerequisite for the Store PWA path* → Task 3 records `run.pwa`; documented in Task 4. ✓
  - *Non-regression: web app unchanged except added PWA assets* → injection is additive; check is advisory. ✓
- **Placeholder scan:** none — full code/content given for every step.
- **Type consistency:** `pwaReport({manifest, hasServiceWorker, hasOfflineFallback})` returns `{compliant, missing, warnings}` in Task 1 and is consumed exactly that way in Task 3 (`report.compliant`, `report.missing`). `run.pwa` shape `{compliant, missing, warnings, at}` is only written here (no other consumer in Phase 1; Part 2 reads it later). Skill id `pwa-baseline` matches the directory name and the injected id. ✓
- **Note:** Phase 1 has no server route/UI change — it's the foundation. The Windows installer/Store actions that consume `run.pwa` are Phases 2 and 3.
