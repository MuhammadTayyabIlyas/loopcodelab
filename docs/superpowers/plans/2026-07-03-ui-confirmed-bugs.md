# UI Confirmed Bugs Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three UI bugs confirmed in the 2026-07-03 review: (1) both UIs overflow a phone viewport because their headers never wrap, (2) the terminal retries forever when the WebSocket gate refuses a session, (3) a failed build card shows no failure reason.

**Architecture:** All three are small, local fixes. Bug 1 is CSS/className-only (allow wrap, hide the email on small screens). Bug 2 adds a fatal-close branch to `term.js`'s reconnect logic keyed on WS close code 1008 (the code `server/ws.mjs` uses for `invalid session name` / `auth required` / `forbidden`). Bug 3 is frontend-only: `runSummary` already ships `attention.message` and `error` in the builds-list payload; the React card just doesn't render them.

**Tech Stack:** React 18 + Tailwind 3.4 (`web/`, built with Vite), vanilla ES modules + hand-written CSS (`public/`), no test framework for UI — verification is headless Chromium probes against an isolated server instance.

## Global Constraints

- **Work in a git worktree** (superpowers:using-git-worktrees): `public/` is served from disk by the live service, so in-place edits ship instantly. Symlink deps in: `ln -s /var/www/tmux.tayyabcheema.com/node_modules <wt>/node_modules && ln -s /var/www/tmux.tayyabcheema.com/web/node_modules <wt>/web/node_modules`.
- **No behavior change beyond the three fixes.** No route, API shape, or server logic changes — `server/` is untouched; deploying needs **no service restart** (static files + a `web/dist` rebuild on the live checkout only).
- After ANY `public/` change ships, **bump `VERSION` in `public/sw.js` to `webtmux-v43`** (once for the whole plan — Task 4 owns the bump because it's the last `public/` task; if you execute Task 3 without Task 4, do the bump there instead).
- After ANY `web/src` change, run `cd web && npm run build` (worktree verification) and again on the live checkout after merge (`web/dist` is gitignored).
- **Verification harness** (used by several tasks) — isolated instance + headless Chromium:

```bash
SCRATCH=$(mktemp -d)
WEBTMUX_PORT=18092 WEBTMUX_DATA=$SCRATCH/data WEBTMUX_PROJECTS_ROOT=$SCRATCH/projects \
  RALPH_FORCE_TOOL=stub nohup node server.js > $SCRATCH/server.log 2>&1 & echo $! > $SCRATCH/pid
# Chromium binary: /opt/ms-playwright/chromium-1228/chrome-linux64/chrome
# playwright-core:  import { chromium } from '/var/www/tmux.tayyabcheema.com/node_modules/playwright-core/index.mjs'
# Kill $(cat $SCRATCH/pid) when done. The isolated instance is single-tenant (no
# WEBTMUX_MULTITENANT), so /#/app works without a session ("open mode").
```
- Line numbers reference the current `main` (`0bca3dc`); locate by the quoted code, not the number.

---

### Task 1: React mobile header — wrap instead of overflow

**Files:**
- Modify: `web/src/pages/Dashboard.jsx:96-108` (the `<header>` block)
- Modify: `web/src/pages/Admin.jsx:68-75` (the `<header>` block)

**Interfaces:** none — className changes only.

- [ ] **Step 1: Fix the Dashboard header.** In `web/src/pages/Dashboard.jsx`, replace:

```jsx
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
```
with
```jsx
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-y-2 px-4 py-4 sm:px-6">
```
and replace:
```jsx
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted">{me.email}</span>
```
with
```jsx
          <div className="flex flex-wrap items-center gap-2 text-sm sm:gap-3">
            <span className="hidden text-muted md:inline">{me.email}</span>
```
(The email is decoration on a personal dashboard; below `md` it goes — the plan badge and buttons stay.)

- [ ] **Step 2: Fix the Admin header.** In `web/src/pages/Admin.jsx`, replace:

```jsx
      <header className="mb-6 flex items-center justify-between">
```
with
```jsx
      <header className="mb-6 flex flex-wrap items-center justify-between gap-y-2">
```
and on the email badge line (~72), replace:
```jsx
          <span className="badge bg-accent/10 text-accent">{me.email}</span>
```
with
```jsx
          <span className="badge hidden bg-accent/10 text-accent sm:inline-flex">{me.email}</span>
```

- [ ] **Step 3: Build.** Run: `cd web && npm run build && cd ..` — expected: `✓ built` with no errors.

- [ ] **Step 4: Verify at 390px.** Start the harness instance (Global Constraints), then run this probe:

```js
// $SCRATCH/probe-mobile-react.mjs
import { chromium } from '/var/www/tmux.tayyabcheema.com/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
await p.goto('http://127.0.0.1:18092/#/app', { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
const w = await p.evaluate(() => document.documentElement.scrollWidth);
console.log(w === 390 ? 'PASS scrollWidth=390' : `FAIL scrollWidth=${w}`);
await browser.close();
```
Run: `node $SCRATCH/probe-mobile-react.mjs` — expected: `PASS scrollWidth=390`. (Before the fix this printed 613.)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Dashboard.jsx web/src/pages/Admin.jsx
git commit -m "fix(web): headers wrap on phones instead of forcing horizontal overflow"
```

---

### Task 2: React failed-build card — show the failure reason

**Files:**
- Modify: `web/src/pages/Dashboard.jsx:22-44` (`BuildCard`)

**Interfaces:**
- Consumes: `b.attention` (`{ message, authError, … } | null`) and `b.error` (`string | null`) — both already present in every item of `api.builds()` (`runSummary` in `server/ralph-engine.mjs` builds them; no server change).

- [ ] **Step 1: Render the reason line.** In `BuildCard`, directly after the progress-bar `<div>` (the one ending `style={{ width: … }} /></div>`), insert:

```jsx
      {failed && (b.attention?.message || b.error) && (
        <p className="mt-2 text-xs leading-snug text-red-600 line-clamp-2" title={b.attention?.message || b.error}>
          {b.attention?.message || b.error}
        </p>
      )}
```
(`failed` is already defined at the top of `BuildCard`; `line-clamp-2` is core Tailwind at 3.4 — keeps the card height bounded, full text in the tooltip and on the detail page.)

- [ ] **Step 2: Build.** Run: `cd web && npm run build && cd ..` — expected: `✓ built`.

- [ ] **Step 3: Verify with a real failed run.** The harness instance has no failed runs, so seed one: start the harness with `RALPH_FORCE_TOOL=stub`, POST a run, then mark it failed on disk:

```bash
curl -s -X POST http://127.0.0.1:18092/api/ralph/start -H 'Content-Type: application/json' -d '{
  "project":"failprobe","idea":"probe","master":"claude","workers":[],
  "prd":{"project":"failprobe","description":"p","stories":[{"id":"s1","title":"t","description":"d","acceptanceCriteria":["a"],"assignee":"claude","deps":[]}]}}'
sleep 15   # let the stub run finish (done)
kill $(cat $SCRATCH/pid); sleep 1
python3 - <<'EOF'
import json, glob
f = glob.glob('$SCRATCH-DATA-DIR/ralph/*failprobe*.json'.replace('$SCRATCH-DATA-DIR', __import__('os').environ['SCRATCH'] + '/data'))[0]
r = json.load(open(f)); r['phase'] = 'failed'
r['stories'][0]['status'] = 'failed'; r['stories'][0]['authError'] = False
json.dump(r, open(f, 'w'))
EOF
# restart the harness instance (same env), then probe:
```
Probe (same launch boilerplate as Task 1 Step 4, desktop viewport is fine):
```js
await p.goto('http://127.0.0.1:18092/#/app', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
const txt = await p.locator('.card', { hasText: 'failprobe' }).innerText();
console.log(/stor(y|ies) failed|couldn't authenticate/.test(txt) ? 'PASS reason shown' : `FAIL card text: ${txt}`);
```
Expected: `PASS reason shown`.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Dashboard.jsx
git commit -m "fix(web): failed build card shows the attention/error reason inline"
```

---

### Task 3: PWA header — wrap on narrow screens

**Files:**
- Modify: `public/css/style.css:41-48` (`.bar`) and `:263` (`.bar-actions`)

**Interfaces:** none — CSS only. (Markup in `public/index.html` is untouched.)

- [ ] **Step 1: Allow the bar to wrap.** In `public/css/style.css`, add `flex-wrap: wrap;` to BOTH rules:

```css
.bar {
  position: sticky; top: 0; z-index: 5;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 12px; padding: 14px 16px;
  ...
```
```css
.bar-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; }
```
(`justify-content: flex-end` keeps the wrapped second row right-aligned under the first instead of ragged-left. Nothing is hidden — on a 390px phone the seven actions flow onto two rows and every button, including "＋ New session" and "🔧 Root shell", stays tappable.)

- [ ] **Step 2: Syntax-sanity + verify at 390px.** `node --check` doesn't cover CSS; the probe is the check. Same probe boilerplate as Task 1 Step 4 but against `/legacy`:

```js
await p.goto('http://127.0.0.1:18092/legacy', { waitUntil: 'networkidle' });
const r = await p.evaluate(() => ({
  w: document.documentElement.scrollWidth,
  newBtn: (() => { const b = document.getElementById('new-btn').getBoundingClientRect(); return b.right <= innerWidth && b.width > 0; })(),
}));
console.log(r.w === 390 && r.newBtn ? 'PASS' : `FAIL ${JSON.stringify(r)}`);
```
Expected: `PASS`. (Before the fix: scrollWidth 531.)

- [ ] **Step 3: Commit**

```bash
git add public/css/style.css
git commit -m "fix(pwa): header wraps on narrow screens — every action reachable on phones"
```

---

### Task 4: Terminal — stop retrying on a 1008 (policy) close

**Files:**
- Modify: `public/js/term.js:80-96` (`ws.onclose` + `scheduleReconnect`), `:481-488` (tap-to-retry handler)
- Modify: `public/sw.js:4` (`VERSION`)

**Interfaces:**
- Consumes: `server/ws.mjs` closes the socket with code `1008` and reason `'invalid session name'`, `'auth required'`, `'forbidden'`, or `'not paired'` — all cases where a retry can never succeed. Code `1000` (`'tmux exited'`) keeps today's reconnect behavior (reconnecting recreates the session — that's the documented seamless-persistence path).

- [ ] **Step 1: Add the fatal branch.** In `public/js/term.js`, add a module-level flag next to the other state (`let reconnectTimer = null;` is at ~line 28):

```js
let fatalClose = false; // 1008 from the server: access denied — retrying can never succeed
```
Replace the `ws.onclose` handler:
```js
  ws.onclose = () => {
    stopHeartbeat();
    if (manualClose) return;
    scheduleReconnect();
  };
```
with:
```js
  ws.onclose = (ev) => {
    stopHeartbeat();
    if (manualClose) return;
    // 1008 = the gate refused this session (bad name / not signed in / another
    // tenant's session). Reconnecting can never succeed — say so and stop.
    if (ev.code === 1008) {
      fatalClose = true;
      const why = ev.reason === 'auth required'
        ? 'Sign in required — sign in on the dashboard, then reload this page.'
        : `Access denied: ${ev.reason || 'this session is not available to you'}.`;
      setStatus(why, 'error');
      return;
    }
    scheduleReconnect();
  };
```

- [ ] **Step 2: Guard the retry paths.** At the top of `connect()` (line ~49), make the first line:

```js
function connect() {
  if (fatalClose) return;
  clearTimeout(reconnectTimer);
```
And in the status-pill tap handler (~line 481, `statusEl.addEventListener(...)` region that does `if (ws) try { ws.close(); } catch …` then reconnects), add the same first line:
```js
  if (fatalClose) return; // access-denied is permanent; tapping shouldn't resurrect the loop
```

- [ ] **Step 3: Bump the service worker** (this is the plan's single bump — see Global Constraints). In `public/sw.js`:

```js
const VERSION = 'webtmux-v43';
```

- [ ] **Step 4: Syntax check.** Run: `node --check public/js/term.js` — expected: silence (exit 0).

- [ ] **Step 5: Verify against a real 1008.** The harness instance is single-tenant, where `/ws` accepts any valid name — so probe the OTHER 1008 source, which shares the exact client path: an *invalid* session name (`server/ws.mjs` closes 1008 `'invalid session name'` for a name failing `validName`). Probe:

```js
const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
let wsAttempts = 0; p.on('websocket', () => wsAttempts++);
await p.goto('http://127.0.0.1:18092/term?s=bad.name', { waitUntil: 'networkidle' }); // '.' fails validName
await p.waitForTimeout(6000); // > several backoff periods (500ms · 1.7^n)
const status = await p.evaluate(() => ({ text: document.querySelector('.status').textContent, cls: document.querySelector('.status').className }));
console.log(wsAttempts === 1 && /Access denied/.test(status.text) && /error/.test(status.cls)
  ? 'PASS single attempt + denied message' : `FAIL attempts=${wsAttempts} status=${JSON.stringify(status)}`);
```
Expected: `PASS single attempt + denied message`. (Before the fix: `attempts` ≥ 4 and the amber "Reconnecting…" pill.)
Also confirm the normal path still reconnects: load `/term?s=probe-ok`, then `kill` the pane's tmux session server-side (`tmux kill-session -t probe-ok` as the harness user) — the pill should show "Reconnecting…" and a new attempt should occur (attempts grows). Then kill the leftover session: on the harness this is root's tmux (`tmux kill-session -t probe-ok`).

- [ ] **Step 6: Commit**

```bash
git add public/js/term.js public/sw.js
git commit -m "fix(term): 1008 close (forbidden/auth) shows access-denied and stops the reconnect loop; sw v43"
```

---

### Task 5: Merge + deploy + live verification

**Files:** none (deploy).

- [ ] **Step 1: Full worktree check.** `node --check server.js server/*.mjs server/routes/*.mjs public/js/dashboard.js public/js/dashboard/*.js public/js/term.js && node --test ralph/*.test.mjs 2>&1 | tail -3` — expected: 206 pass, 0 fail (nothing here touches tested code; this is the regression gate).
- [ ] **Step 2: Stop the harness instance** (`kill $(cat $SCRATCH/pid)`), remove the `node_modules` symlinks from the worktree, and fast-forward `main` from the main checkout: `git -C /var/www/tmux.tayyabcheema.com merge --ff-only <branch>`.
- [ ] **Step 3: Rebuild the live React bundle:** `cd /var/www/tmux.tayyabcheema.com/web && npm run build` — expected `✓ built`. **No `systemctl restart`** — no server code changed; static files serve from disk.
- [ ] **Step 4: Live spot-checks:**

```bash
curl -s http://127.0.0.1:8090/sw.js | grep -o "webtmux-v43"          # v43 live
curl -s http://127.0.0.1:8090/js/term.js | grep -c "fatalClose"       # ≥ 2
curl -s http://127.0.0.1:8090/css/style.css | grep -c "flex-wrap: wrap"  # ≥ 2
```
Plus one headless pass of the Task 1 + Task 3 probes against `http://127.0.0.1:8090` at 390px (authenticated via the session-mint trick in memory `revise-efficiency-plan` if needed for `/#/app`; revoke the row afterward): both should print `PASS`.
- [ ] **Step 5: Remove the worktree** and note results.

---

## Self-Review Notes

- **Coverage:** bug 1 → Tasks 1 + 3 (both UIs, verified by scrollWidth probes); bug 2 → Task 4 (fatal branch + both retry paths guarded + regression check that normal reconnect still works); bug 3 → Task 5-free, done in Task 2 with a seeded failed run. Deploy → Task 5.
- **Deliberately narrow:** no shared header component extraction (the duplicated-headers pattern is pre-existing; unifying it is backlog, not a bug fix), no PWA builds-card change for bug 3 (the PWA active card already surfaces `attention` in its status dialog; the observed gap was the React dashboard card).
- **Known trade-offs:** hiding the email below `md`/`sm` loses "which account am I on" on phones — acceptable on a single-user dashboard, and the plan badge stays; `.bar` wrapping makes the sticky header two rows tall on phones (~96px), which is the standard cost of not hiding actions.
