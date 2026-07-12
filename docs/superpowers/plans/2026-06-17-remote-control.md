# Phone Remote Control of the Ralph Master — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pair a phone by scanning a QR on the dashboard and then supervise any running Ralph master (view its live pane read-only + continue/steer/restart/answer/swap), with Web Push when the master needs input, a run hits trouble, or completes.

**Architecture:** Everything remote-control lives under a single `/rc/` URL prefix that nginx exempts from basic-auth and the Node app gates with a hashed, revocable **device token** (the dashboard `/ws` and `/api/*` stay untouched). A pure `ralph/rc-auth.mjs` module owns token mint/hash/compare/TTL (unit-tested). A dedicated mobile page (`public/rc.html` + `public/js/rc.js`) with its own `/rc/`-scoped manifest + service worker shows the pane (xterm read-only over `/rc/ws`) and supervise actions, and receives push via the existing VAPID pipeline.

**Tech Stack:** Node 22 ESM, Express, `ws`, `web-push` (already a dep), tmux PTY bridge, vanilla-JS PWA + vendored xterm.js, a small vendored MIT QR encoder.

## Global Constraints

- **ESM** (`package.json` `"type":"module"`): `import`/`export`.
- **No JS test runner**; pure logic goes in importable modules tested with `node --test`. Syntax-gate: `node --check server.js`, `node --check public/js/rc.js`, `node --check public/js/dashboard.js`.
- **Single `/rc/` opening.** All phone-facing routes are under `/rc/` (page, `/rc/ws`, `/rc/api/*`). nginx exempts only `/rc/` from basic-auth. Never weaken the existing `/ws` or `/api/*`.
- **Auth boundary naming (do not swap):** `/api/rc/*` = dashboard-side, behind basic-auth (and `requireAuth` in MULTITENANT). `/rc/api/*` = phone-side, gated by the **device token**.
- **Device token**: random, stored **hashed (sha256)**, compared **constant-time**, set as **HttpOnly; Secure; SameSite=Lax; Path=/rc** cookie, **revocable**, scoped to one tenant (or the whole deployment single-tenant). Pairing token: **single-use, ~5 min TTL**, created only by an authed dashboard user.
- **Pane is READ-ONLY** on `/rc/ws` (ignore inbound socket data) — capability is supervise-only.
- **`/rc/ws` never accepts a free-form session name** — derive allowed master-session names from the device's tenant + requested project via `ralphSessionName(project, …, 'rv'|'rf'|'r…', tenant)`.
- **Device scope = tenant-wide** (pair once → all the user's projects).
- **PWA cache rule:** any change under `public/` requires bumping `VERSION` in `public/sw.js`; the new `/rc/` PWA has its own `public/rc.sw.js`.
- **Push triggers:** master needs-input (new unanswered `question.md`) + run attention/failure + run done. All payloads carry `url:/rc/#/<project>` and a per-project `tag`.
- **MULTITENANT awareness:** `MULTITENANT` = `process.env.WEBTMUX_MULTITENANT === '1'`. Device scope is `req.tenant` when on, the whole deployment when off. tmux for a tenant runs via `tenantExecArgs`.
- **nginx is an ops step** (outside the repo): the plan documents the exact block; the feature is inert until it's applied + a device is paired, so it ships dark.

---

### Task 1: `ralph/rc-auth.mjs` — pure token/cookie helpers + tests

**Files:**
- Create: `ralph/rc-auth.mjs`
- Test: `ralph/rc-auth.test.mjs`

**Interfaces:**
- Consumes: `node:crypto` only.
- Produces (used by Task 2+): `PAIR_TTL_MS`, `sha256(s)`, `randomToken(prefix)`, `makePairToken(now?)→{token,expiresAt,used}`, `pairTokenValid(rec,now?)→bool`, `makeDevice({label,tenant},now?)→{token,record}`, `findDevice(devices,token)→record|null`, `parseCookie(header,name)→string|null`.

- [ ] **Step 1: Write the failing tests**

Create `ralph/rc-auth.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIR_TTL_MS, sha256, randomToken, makePairToken, pairTokenValid,
  makeDevice, findDevice, parseCookie,
} from './rc-auth.mjs';

test('randomToken has prefix and entropy', () => {
  const a = randomToken('pt'), b = randomToken('pt');
  assert.match(a, /^pt_[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(a, b);
});

test('pair token valid until used or expired', () => {
  const now = 1_000_000;
  const rec = makePairToken(now);
  assert.equal(rec.expiresAt, now + PAIR_TTL_MS);
  assert.ok(pairTokenValid(rec, now));
  assert.ok(!pairTokenValid(rec, now + PAIR_TTL_MS + 1)); // expired
  assert.ok(!pairTokenValid({ ...rec, used: true }, now)); // used
  assert.ok(!pairTokenValid(null, now));
});

test('makeDevice returns token + record whose hash matches', () => {
  const { token, record } = makeDevice({ label: 'iPhone', tenant: 't1' }, 5);
  assert.match(token, /^dev_/);
  assert.equal(record.hash, sha256(token));
  assert.equal(record.tenant, 't1');
  assert.equal(record.label, 'iPhone');
  assert.equal(record.createdAt, 5);
  assert.ok(record.id.length >= 8);
});

test('findDevice matches by hash, constant-time, else null', () => {
  const { token, record } = makeDevice({ label: '', tenant: null });
  const devices = [{ hash: sha256('dev_other'), id: 'x' }, record];
  assert.equal(findDevice(devices, token), record);
  assert.equal(findDevice(devices, 'dev_nope'), null);
  assert.equal(findDevice([], token), null);
  assert.equal(findDevice(devices, ''), null);
});

test('parseCookie extracts the named cookie', () => {
  assert.equal(parseCookie('a=1; rc_dev=dev_abc; b=2', 'rc_dev'), 'dev_abc');
  assert.equal(parseCookie('', 'rc_dev'), null);
  assert.equal(parseCookie('x=y', 'rc_dev'), null);
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test ralph/rc-auth.test.mjs`
Expected: FAIL — `Cannot find module './rc-auth.mjs'`.

- [ ] **Step 3: Implement the module**

Create `ralph/rc-auth.mjs`:

```js
// Pure auth helpers for phone Remote Control (RC). Token mint/hash/compare + cookie
// parsing, no I/O — server.js owns the device store and HTTP. Unit-tested in isolation.
import crypto from 'node:crypto';

export const PAIR_TTL_MS = 5 * 60 * 1000; // one-time QR pairing token lifetime

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

export function makePairToken(now = Date.now()) {
  return { token: randomToken('pt'), expiresAt: now + PAIR_TTL_MS, used: false };
}
export function pairTokenValid(rec, now = Date.now()) {
  return !!rec && !rec.used && rec.expiresAt > now;
}

// Device record persists (hashed token). The raw token only ever lives in the cookie.
export function makeDevice({ label = '', tenant = null }, now = Date.now()) {
  const token = randomToken('dev');
  return {
    token,
    record: {
      id: crypto.randomBytes(8).toString('hex'),
      hash: sha256(token),
      label: String(label).slice(0, 120),
      tenant: tenant || null,
      createdAt: now,
      lastSeen: now,
    },
  };
}

export function findDevice(devices, token) {
  if (!token || typeof token !== 'string') return null;
  const h = Buffer.from(sha256(token));
  for (const d of devices || []) {
    const stored = Buffer.from(String(d.hash || ''));
    if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) return d;
  }
  return null;
}

export function parseCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test ralph/rc-auth.test.mjs`
Expected: PASS, all green, pristine output.

- [ ] **Step 5: Commit**

```bash
git add ralph/rc-auth.mjs ralph/rc-auth.test.mjs
git commit -m "feat(rc): pure token/cookie auth helpers + unit tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Device store + pairing endpoints + `requireDevice` + `GET /rc`

**Files:**
- Modify: `server.js` — import (after the solo-models import block near line 27); device store + helpers (near the other `DATA_DIR` files / `loadSoloModels`, ~line 600); dashboard-side endpoints with the other `/api/*` (near the push routes ~3640); device gate + `GET /rc` pairing handler (before the WS section ~3674).

**Interfaces:**
- Consumes (Task 1): `makePairToken, pairTokenValid, makeDevice, findDevice, parseCookie, sha256`.
- Produces (Task 3+): module state `rcDevices` (array of records) + `saveRcDevices()`; `rcDeviceFromReq(req)→record|null`; `requireDevice(req,res,next)`; `rcTenantSlug(req)` (device's tenant or null); HTTP `POST /api/rc/pair-token` → `{url}`, `GET /api/rc/devices` → `{devices}`, `DELETE /api/rc/devices/:id`; `GET /rc` (pairing/landing).

- [ ] **Step 1: Add the import**

In `server.js`, after the `./ralph/solo-models.mjs` import, add:

```js
import {
  makePairToken, pairTokenValid, makeDevice, findDevice, parseCookie, sha256,
} from './ralph/rc-auth.mjs';
```

- [ ] **Step 2: Add device store + pairing-token map + helpers**

In `server.js`, after the solo-models config block (~after `loadSoloModels`), add:

```js
// --- Remote Control (RC): paired-device store + one-time pairing tokens ----------
const RC_DEVICES_FILE = path.join(DATA_DIR, 'rc-devices.json');
let rcDevices = [];                       // [{ id, hash, label, tenant, createdAt, lastSeen }]
const rcPairTokens = new Map();           // token -> { token, expiresAt, used }
async function loadRcDevices() { rcDevices = await readJson(RC_DEVICES_FILE, []); }
async function saveRcDevices() { await writeJson(RC_DEVICES_FILE, rcDevices); }

// Resolve the device record from the rc_dev cookie; bumps lastSeen (best-effort).
function rcDeviceFromReq(req) {
  const token = parseCookie(req.headers.cookie, 'rc_dev');
  const d = findDevice(rcDevices, token);
  if (d) { d.lastSeen = Date.now(); }
  return d || null;
}
const rcTenantSlug = (req) => rcDeviceFromReq(req)?.tenant || null;

// Express gate for /rc/api/*: a valid device token is required.
function requireDevice(req, res, next) {
  const d = rcDeviceFromReq(req);
  if (!d) return res.status(401).json({ error: 'Not paired. Scan the QR again.' });
  req.rcDevice = d;
  next();
}
```

- [ ] **Step 3: Boot-load the device store**

In `server.js`, where boot loaders run (after `await loadSoloModels();`), add:

```js
await loadRcDevices();
```

- [ ] **Step 4: Dashboard-side pairing endpoints (behind basic-auth / requireAuth)**

In `server.js`, near the push routes (~3640), add. In MULTITENANT these inherit the `requireAuth` mounted on `/api`; in single-tenant they're behind nginx basic-auth like every `/api/*`.

```js
// Dashboard mints a one-time pairing token; the client renders it as a QR of /rc?t=…
app.post('/api/rc/pair-token', (req, res) => {
  const rec = makePairToken();
  rcPairTokens.set(rec.token, rec);
  // prune expired tokens opportunistically
  const now = Date.now();
  for (const [k, v] of rcPairTokens) if (v.expiresAt <= now) rcPairTokens.delete(k);
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${req.headers.host}/rc?t=${encodeURIComponent(rec.token)}`;
  audit({ rcPair: 'minted', by: req.auth?.user?.email || null });
  res.json({ url, expiresInMs: rec.expiresAt - now });
});

app.get('/api/rc/devices', (req, res) =>
  res.json({ devices: rcDevices
    .filter((d) => !MULTITENANT || d.tenant === (req.tenant?.slug || null))
    .map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastSeen: d.lastSeen })) }));

app.delete('/api/rc/devices/:id', async (req, res) => {
  const before = rcDevices.length;
  rcDevices = rcDevices.filter((d) => d.id !== req.params.id);
  if (rcDevices.length !== before) { await saveRcDevices(); audit({ rcDevice: 'revoked', id: req.params.id }); }
  res.json({ ok: true });
});
```

- [ ] **Step 5: Phone-side pairing landing `GET /rc`**

In `server.js`, just before the WebSocket section (`const wss = …`, ~3674), add. This route is reached via the nginx `/rc/` exemption.

```js
// Phone lands here from the QR (no basic-auth — nginx exempts /rc/). A valid one-time
// token mints a persistent device token (cookie) scoped to the minting tenant.
app.get('/rc', async (req, res) => {
  const t = String(req.query.t || '');
  const rec = t ? rcPairTokens.get(t) : null;
  if (t) {
    if (!pairTokenValid(rec)) {
      return res.status(410).type('html').send('<h2>QR expired</h2><p>Generate a new one in the dashboard.</p>');
    }
    rec.used = true; rcPairTokens.delete(t);
    const tenantSlug = MULTITENANT ? (req.tenant?.slug || null) : null; // single-tenant: deployment-wide
    const { token, record } = makeDevice({ label: req.headers['user-agent'] || 'device', tenant: tenantSlug });
    rcDevices.push(record); await saveRcDevices();
    audit({ rcDevice: 'paired', id: record.id, tenant: tenantSlug });
    res.setHeader('Set-Cookie',
      `rc_dev=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/rc; Max-Age=${60 * 60 * 24 * 365}`);
    return res.redirect(302, '/rc/');
  }
  // No token: serve the app shell if already paired, else a hint.
  if (rcDeviceFromReq(req)) return res.redirect(302, '/rc/');
  res.status(401).type('html').send('<h2>Not paired</h2><p>Open the dashboard, tap “📱 Remote control”, and scan the QR.</p>');
});
```

- [ ] **Step 6: Syntax-check**

Run: `node --check server.js`
Expected: clean, exit 0.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(rc): device store, pairing tokens, requireDevice gate, GET /rc landing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `/rc/ws` read-only, scoped PTY bridge (upgrade-router refactor)

**Files:**
- Modify: `server.js` — the WebSocket section (`const wss = new WebSocketServer({ server, path: '/ws' })`, ~3676 through the connection handler).

**Interfaces:**
- Consumes (Task 2): `rcDeviceFromReq`, `MULTITENANT`, `ralphSessionName`, `tenantExecArgs` (existing), `validName` (existing).
- Produces (Task 4): a working read-only pane socket at `/rc/ws?project=<p>&kind=<rf|rv|r>&story=<id?>&cols&rows` that only attaches to that project's master sessions for the device's tenant.

- [ ] **Step 1: Convert to a noServer upgrade router and add `/rc/ws`**

In `server.js`, replace `const wss = new WebSocketServer({ server, path: '/ws' });` and keep the existing `wss.on('connection', …)` handler, but add a second server and route upgrades. Change the single-line construction to:

```js
const wss = new WebSocketServer({ noServer: true });     // dashboard terminal (existing handler)
const rcWss = new WebSocketServer({ noServer: true });   // phone read-only pane

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  if (pathname === '/rc/ws') return rcWss.handleUpgrade(req, socket, head, (ws) => rcWss.emit('connection', ws, req));
  socket.destroy();
});
```

(The existing `wss.on('connection', (ws, req) => { … })` block stays exactly as-is — its behaviour is unchanged.)

- [ ] **Step 2: Add the `/rc/ws` connection handler**

Immediately after the existing `wss.on('connection', …)` block, add:

```js
// Phone read-only pane. Auth = device token; the session name is DERIVED (never taken
// from the client) so a device can only ever see its own tenant's master sessions.
rcWss.on('connection', (ws, req) => {
  const device = rcDeviceFromReq(req);
  if (!device) { ws.close(1008, 'not paired'); return; }
  const url = new URL(req.url, 'http://localhost');
  const project = url.searchParams.get('project') || '';
  const kind = ['rf', 'rv', 'r'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'rf';
  const story = url.searchParams.get('story') || 'final';
  if (!validName(project)) { ws.close(1008, 'bad project'); return; }

  // Resolve the tenant context for this device (MULTITENANT) or null (single-tenant).
  let tctx = null;
  if (MULTITENANT) {
    const ws_ = device.tenant ? saasStore.getWorkspaceBySlug(device.tenant) : null;
    tctx = ws_ ? saasTenants.tenantContext(ws_) : null;
    if (!tctx) { ws.close(1008, 'tenant gone'); return; }
  }
  const name = ralphSessionName(project, story, kind, tctx);

  let cmd = 'tmux', cmdArgs = ['attach-session', '-t', name];   // attach, do NOT create
  if (MULTITENANT) { const argv = saasTenants.tenantExecArgs(tctx, ['tmux', 'attach-session', '-t', name]); cmd = argv[0]; cmdArgs = argv.slice(1); }

  const term = pty.spawn(cmd, cmdArgs, {
    name: 'xterm-256color',
    cols: Number(url.searchParams.get('cols')) || 80,
    rows: Number(url.searchParams.get('rows')) || 24,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' },
  });
  term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(1000, 'pane closed'); });
  ws.on('message', () => { /* READ-ONLY: ignore all inbound keystrokes */ });
  ws.on('close', () => { try { term.kill(); } catch { /* gone */ } });
});
```

> Note: uses `attach-session` (not `new-session -A`) so the phone never creates a stray session if the master isn't running — `onExit` then closes the socket and the UI shows "no live pane".
> If `saasTenants.tenantBySlug` does not exist, use the existing lookup the codebase already uses to resolve a workspace by slug (grep `tenantContext(` call sites) — keep the resolution, adapt the accessor.

- [ ] **Step 3: Syntax-check + verify the dashboard terminal still works**

Run: `node --check server.js`
Then restart and smoke-test the EXISTING dashboard terminal (the refactor must not regress it): open a normal terminal session in the dashboard and confirm it attaches and echoes.
Expected: `node --check` clean; dashboard terminal works exactly as before.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(rc): /rc/ws read-only scoped pane via noServer upgrade router

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: RC page shell + status endpoint (read-only pane working end-to-end)

**Files:**
- Create: `public/rc.html`, `public/js/rc.js`, `public/rc.webmanifest`
- Modify: `server.js` — serve `/rc/` static assets + `GET /rc/api/status`.

**Interfaces:**
- Consumes (Task 2/3): `requireDevice`, `rcDeviceFromReq`, `/rc/ws`, existing `loadRun`/`ralphRuns`/run status shape, vendored xterm at `public/vendor/xterm`.
- Produces (Task 5/6): `GET /rc/api/status[?project=]` → `{ runs:[{project,phase,master,story,question,attention}] }`; a working RC page that lists runs and streams the master pane.

- [ ] **Step 1: Serve the `/rc/` static assets**

In `server.js`, near `GET /rc` (Task 2), add explicit routes (the nginx `/rc/` exemption proxies these):

```js
const RC_PUBLIC = path.join(__dirname, 'public');
app.get('/rc/', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'rc.html')));
app.get('/rc/rc.js', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'js/rc.js')));
app.get('/rc/rc.webmanifest', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'rc.webmanifest')));
app.use('/rc/vendor', express.static(path.join(RC_PUBLIC, 'vendor'))); // xterm assets
```

- [ ] **Step 2: Add `GET /rc/api/status`**

In `server.js`, add near the other `/rc` routes (device-gated):

```js
// Read run status for the device's tenant. Reuses the run model; surfaces any pending
// (unanswered) worker question so the phone can answer it.
app.get('/rc/api/status', requireDevice, async (req, res) => {
  const wanted = String(req.query.project || '');
  const out = [];
  for (const run of ralphRuns.values()) {
    if (MULTITENANT && run.tenant?.slug !== req.rcDevice.tenant) continue;
    if (wanted && run.project !== wanted) continue;
    const story = run.stories?.find((s) => s.status === 'building') || run.stories?.find((s) => s.status === 'reviewing') || null;
    let question = null;
    if (story) {
      const ctl = path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph');
      try {
        const q = (await fs.readFile(path.join(ctl, 'question.md'), 'utf8')).trim();
        const answered = await fs.access(path.join(ctl, 'answer.md')).then(() => true).catch(() => false);
        if (q && !answered) question = { story: story.id, text: q.slice(0, 2000) };
      } catch { /* none */ }
    }
    out.push({
      project: run.project, phase: run.phase, master: run.master,
      story: story ? { id: story.id, title: story.title, status: story.status } : null,
      question, attention: run.attention || null,
    });
  }
  res.json({ runs: out });
});
```

> Verify `WORKTREES_SUBDIR` and the per-story `.ralph` path match how `spawnReview`/the supervisor read `question.md` (server.js ~1186); copy that exact path construction if it differs.

- [ ] **Step 3: Create the manifest**

Create `public/rc.webmanifest`:

```json
{
  "name": "webtmux Remote Control",
  "short_name": "webtmux RC",
  "start_url": "/rc/",
  "scope": "/rc/",
  "display": "standalone",
  "background_color": "#0b0f14",
  "theme_color": "#0b0f14",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

> If `/icons/icon-192.png` / `512` don't exist, reuse whatever icon paths `public/manifest.webmanifest` already references (grep it).

- [ ] **Step 4: Create the page shell**

Create `public/rc.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>webtmux Remote Control</title>
  <link rel="manifest" href="/rc/rc.webmanifest" />
  <link rel="stylesheet" href="/rc/vendor/xterm/xterm.css" />
  <meta name="theme-color" content="#0b0f14" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 15px system-ui, sans-serif; background: #0b0f14; color: #e6edf3; }
    header { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid #1c2530; }
    select, button { font: inherit; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; }
    button.primary { background: #1f6feb; border-color: #1f6feb; }
    #pane { height: 46vh; padding: 6px; }
    #bar { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; }
    #bar button { flex: 1 1 30%; }
    #q { margin: 10px 12px; padding: 10px; border: 1px solid #d29922; border-radius: 10px; background: #2a210a; display: none; }
    textarea { width: 100%; box-sizing: border-box; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 8px; }
    #msg { padding: 8px 12px; color: #8b949e; min-height: 18px; }
    .hide { display: none !important; }
  </style>
</head>
<body>
  <header>
    <select id="project"></select>
    <span id="phase" style="color:#8b949e"></span>
    <button id="notify" style="margin-left:auto">🔔</button>
  </header>
  <div id="q">
    <div id="qtext" style="white-space:pre-wrap;margin-bottom:8px"></div>
    <textarea id="qans" rows="3" placeholder="Answer the master…"></textarea>
    <button class="primary" id="qsend" style="margin-top:8px;width:100%">Send answer</button>
  </div>
  <div id="pane"></div>
  <div id="bar">
    <button data-act="continue">▶ Continue</button>
    <button data-act="steer">🧭 Steer</button>
    <button data-act="restart">🔁 Restart</button>
    <button data-act="swap">🔀 Swap</button>
  </div>
  <div id="msg"></div>
  <p id="ios-a2hs" class="hide" style="padding:0 12px;color:#8b949e">On iPhone: Share → <b>Add to Home Screen</b> to get notifications.</p>
  <script src="/rc/vendor/xterm/xterm.js"></script>
  <script type="module" src="/rc/rc.js"></script>
</body>
</html>
```

- [ ] **Step 5: Create the page logic (status + read-only pane; actions wired in Task 5/6)**

Create `public/js/rc.js`:

```js
// webtmux Remote Control — mobile supervise view. Read-only pane + status polling.
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
let project = location.hash.slice(2) || '';   // /rc/#/<project>
let term, fit, sock;

async function api(pathname, opts) {
  const r = await fetch(`/rc/api${pathname}`, { credentials: 'include', ...opts });
  if (r.status === 401) { msg('Not paired — scan the QR again.'); throw new Error('unpaired'); }
  return r.json();
}

function openPane(p, kind, story) {
  if (sock) { try { sock.close(); } catch {} }
  if (!term) {
    term = new window.Terminal({ fontSize: 12, convertEol: true, disableStdin: true, theme: { background: '#0b0f14' } });
    term.open($('pane'));
  }
  term.reset();
  const q = new URLSearchParams({ project: p, kind, story: story || 'final', cols: String(term.cols), rows: String(term.rows) });
  sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rc/ws?${q}`);
  sock.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  sock.onclose = () => term.write('\r\n\x1b[90m[no live pane]\x1b[0m\r\n');
  sock.binaryType = 'arraybuffer';
}

async function refresh() {
  let data;
  try { data = await api('/status'); } catch { return; }
  const runs = data.runs || [];
  const sel = $('project');
  sel.innerHTML = runs.map((r) => `<option value="${r.project}">${r.project}</option>`).join('');
  if (!project && runs[0]) project = runs[0].project;
  sel.value = project;
  const run = runs.find((r) => r.project === project) || runs[0];
  if (!run) { $('phase').textContent = 'no active runs'; return; }
  project = run.project;
  $('phase').textContent = `${run.phase} · master ${run.master}`;
  // pending question banner
  if (run.question) {
    $('q').style.display = 'block'; $('qtext').textContent = run.question.text;
    $('q').dataset.story = run.question.story;
  } else { $('q').style.display = 'none'; }
  // pane: finalize > review/build of the active story
  const kind = run.phase === 'finalizing' ? 'rf' : (run.story?.status === 'reviewing' ? 'rv' : 'r');
  const story = run.phase === 'finalizing' ? 'final' : (run.story?.id || 'final');
  if ($('pane').dataset.key !== `${project}:${kind}:${story}`) {
    $('pane').dataset.key = `${project}:${kind}:${story}`;
    openPane(project, kind, story);
  }
}

$('project').onchange = (e) => { project = e.target.value; location.hash = `#/${project}`; $('pane').dataset.key=''; refresh(); };
// iOS add-to-home-screen hint when not standalone
if (window.navigator.standalone === false) $('ios-a2hs').classList.remove('hide');

refresh();
setInterval(refresh, 4000);   // status fallback poll (also covers no-push platforms)

export { api, project };   // actions/push modules (Task 5/6) import these
```

> `api`/`project` are exported so Task 5/6 can extend behaviour without rewriting this file. If module-export friction arises, attach them to `window.rc` instead — pick one and keep it consistent.

- [ ] **Step 6: Vendor xterm into `public/vendor/xterm`**

xterm.js is already a dependency (`@xterm/xterm`). Copy its built assets so `/rc/vendor/xterm/{xterm.js,xterm.css}` exist (the dashboard term client already loads xterm — reuse the SAME vendored path it uses if one exists; grep `term.html`/`term.js` for the xterm `<script>`/`<link>` href and point `rc.html` at that path instead of copying twice).

```bash
ls node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css
mkdir -p public/vendor/xterm
cp node_modules/@xterm/xterm/lib/xterm.js public/vendor/xterm/xterm.js
cp node_modules/@xterm/xterm/css/xterm.css public/vendor/xterm/xterm.css
```

- [ ] **Step 7: Gate + commit**

Run: `node --check server.js && node --check public/js/rc.js`
Expected: clean.

```bash
git add server.js public/rc.html public/js/rc.js public/rc.webmanifest public/vendor/xterm
git commit -m "feat(rc): RC page shell + /rc/api/status + read-only master pane

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Supervise endpoints + action bar

**Files:**
- Modify: `server.js` — `/rc/api/{answer,steer,restart,continue,swap}` (device-gated), reusing existing internals.
- Modify: `public/js/rc.js` — wire the action bar + answer box.

**Interfaces:**
- Consumes: `requireDevice`, `loadRun`/`ralphRuns`, the existing functions that write `.ralph/answer.md` (~1200) and `.ralph/steer.md` (~1244), the existing story-restart path, and `swap` internals (`POST /api/ralph/swap`, server.js:3248).
- Produces: device-gated supervise mutations the RC page calls.

- [ ] **Step 1: Add the supervise endpoints**

In `server.js`, add near `/rc/api/status`. Find the run for the device's tenant via a small helper; reuse the exact `.ralph` path + write idiom the autonomous supervisor uses.

```js
function rcRun(req, project) {
  for (const run of ralphRuns.values()) {
    if (MULTITENANT && run.tenant?.slug !== req.rcDevice.tenant) continue;
    if (run.project === project) return run;
  }
  return null;
}
function rcCtlDir(run, storyId) {
  const story = run.stories.find((s) => s.id === storyId)
    || run.stories.find((s) => s.status === 'building' || s.status === 'reviewing');
  return story ? { story, ctl: path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph') } : null;
}

app.post('/rc/api/answer', requireDevice, async (req, res) => {
  const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
  const tgt = rcCtlDir(run, String(req.body?.story || '')); if (!tgt) return res.status(409).json({ error: 'no active story' });
  await fs.mkdir(tgt.ctl, { recursive: true });
  await fs.writeFile(path.join(tgt.ctl, 'answer.md'), String(req.body?.text || '').slice(0, 4000) + '\n');
  audit({ rcAnswer: run.project, story: tgt.story.id, device: req.rcDevice.id });
  res.json({ ok: true });
});

app.post('/rc/api/steer', requireDevice, async (req, res) => {
  const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
  const tgt = rcCtlDir(run, String(req.body?.story || '')); if (!tgt) return res.status(409).json({ error: 'no active story' });
  await fs.mkdir(tgt.ctl, { recursive: true });
  await fs.writeFile(path.join(tgt.ctl, 'steer.md'), String(req.body?.text || '').slice(0, 2000) + '\n');
  audit({ rcSteer: run.project, story: tgt.story.id, device: req.rcDevice.id });
  res.json({ ok: true });
});

app.post('/rc/api/continue', requireDevice, async (req, res) => {
  const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
  if (run.paused) { run.paused = false; await persistRun(run); audit({ rcContinue: run.project, device: req.rcDevice.id }); }
  res.json({ ok: true });
});

app.post('/rc/api/swap', requireDevice, async (req, res) => {
  const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
  const agent = String(req.body?.agent || ''); const role = String(req.body?.role || 'master');
  if (!VALID_AGENTS.includes(agent)) return res.status(400).json({ error: 'Invalid agent.' });
  try { await ralphSwap(run, role, agent); audit({ rcSwap: run.project, device: req.rcDevice.id }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/rc/api/restart', requireDevice, async (req, res) => {
  const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
  const tgt = rcCtlDir(run, String(req.body?.story || '')); if (!tgt) return res.status(409).json({ error: 'no active story' });
  try { await spawnWorker(run, tgt.story, 'remote restart requested'); audit({ rcRestart: run.project, story: tgt.story.id, device: req.rcDevice.id }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
```

> Verified symbols (use as-is): `run.paused` + `persistRun(run)` (server.js:1488, 3142/3151), `WORKTREES_SUBDIR='.worktrees'` (375), `spawnWorker(run, story, note)` (1654) is the restart path the tick already uses for retries.
> **`ralphSwap` does NOT exist yet** — the swap logic is written **inline** in the `app.post('/api/ralph/swap', …)` route (server.js:3248). First **extract** that core into `async function ralphSwap(run, role, agent) { … }` (everything after the input validation: the `run.master = agent` / failed-story retry block) and call it from BOTH the existing route (replacing the inline body) and `/rc/api/swap`. Keep the route's own input validation + `loadRun` in the route; the extracted fn takes a resolved `run`. This refactor is part of this task; re-confirm the dashboard swap still works (`node --check` + the route still returns ok).

- [ ] **Step 2: Wire the action bar + answer box in `rc.js`**

Append to `public/js/rc.js` (before `refresh(); setInterval(...)`):

```js
async function act(action) {
  if (action === 'continue') { await api('/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }); return msg('Continued.'); }
  if (action === 'steer') {
    const text = prompt('Steering note for the master:'); if (!text) return;
    await api('/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, text }) }); return msg('Steer sent.');
  }
  if (action === 'restart') { if (!confirm('Restart the current story?')) return; await api('/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }); return msg('Restarting.'); }
  if (action === 'swap') {
    const agent = prompt('Swap master to (claude/codex/qwen/gemini):'); if (!agent) return;
    await api('/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, role: 'master', agent }) }); return msg(`Swapping master to ${agent}.`);
  }
}
document.querySelectorAll('#bar button').forEach((b) => { b.onclick = () => act(b.dataset.act).catch((e) => msg(e.message)); });
$('qsend').onclick = async () => {
  const text = $('qans').value.trim(); if (!text) return;
  await api('/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, story: $('q').dataset.story, text }) }).catch((e) => msg(e.message));
  $('qans').value = ''; $('q').style.display = 'none'; msg('Answer sent.');
};
```

- [ ] **Step 3: Gate + commit**

Run: `node --check server.js && node --check public/js/rc.js`

```bash
git add server.js public/js/rc.js
git commit -m "feat(rc): supervise endpoints (answer/steer/restart/continue/swap) + action bar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Web Push — device-scoped subscribe + triggers + `/rc/sw.js`

**Files:**
- Create: `public/rc.sw.js`
- Modify: `server.js` — store push subs with `deviceId`; `sendPushToTenant`; `/rc/api/push/{key,subscribe,unsubscribe}`; fire triggers in the tick + extend `notifyRalphDone`.
- Modify: `public/js/rc.js` — register `/rc/sw.js`, subscribe on the 🔔 tap.

**Interfaces:**
- Consumes: existing `vapid`, `subscriptions`, `SUBS_FILE`, `sendPush`, `webpush`; `requireDevice`; the tick (`ralphTick`) and `notifyRalphDone`.
- Produces: per-device push subscriptions + RC notifications that deep-open `/rc/#/<project>`.

- [ ] **Step 1: Associate push subscriptions with a device + targeted send**

In `server.js`, near `sendPush`, add (subscriptions already persist as objects in `subscriptions`; tag RC ones with `deviceId`/`tenant`):

```js
async function sendPushTo(filterFn, payload) {
  if (!vapid) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subscriptions.filter(filterFn).map(async (sub) => {
    try { await webpush.sendNotification(sub, body); }
    catch (err) { if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint); }
  }));
  if (dead.length) { subscriptions = subscriptions.filter((s) => !dead.includes(s.endpoint)); await writeJson(SUBS_FILE, subscriptions); }
}
// RC notifications go to the paired devices of a run's tenant (single-tenant: all RC subs).
const sendPushRun = (run, payload) => sendPushTo(
  (s) => s.rc && (!MULTITENANT || s.tenant === (run.tenant?.slug || null)),
  { ...payload, url: `/rc/#/${run.project}`, tag: `rc-${run.project}` });
```

- [ ] **Step 2: Device-gated push subscribe/unsubscribe/key**

In `server.js`, add near the other `/rc/api/*`:

```js
app.get('/rc/api/push/key', requireDevice, (_req, res) => res.json({ key: vapid?.publicKey || null }));
app.post('/rc/api/push/subscribe', requireDevice, async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'bad subscription' });
  subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  subscriptions.push({ ...sub, rc: true, deviceId: req.rcDevice.id, tenant: req.rcDevice.tenant || null });
  await writeJson(SUBS_FILE, subscriptions);
  res.status(201).json({ ok: true });
});
app.post('/rc/api/push/unsubscribe', requireDevice, async (req, res) => {
  subscriptions = subscriptions.filter((s) => s.endpoint !== req.body?.endpoint);
  await writeJson(SUBS_FILE, subscriptions); res.json({ ok: true });
});
```

Also, in `DELETE /api/rc/devices/:id` (Task 2), drop that device's push subs: after filtering `rcDevices`, add `subscriptions = subscriptions.filter((s) => s.deviceId !== req.params.id); await writeJson(SUBS_FILE, subscriptions);`.

- [ ] **Step 3: Fire the three triggers**

In `server.js`, in the tick (`ralphTick`) — at the points where a run's state is evaluated — add edge-triggered pushes (store the last-pushed marker on the run so each fires once):

```js
// needs-input: a new unanswered question.md appeared for a building story
if (story && story.status === 'building') {
  const ctl = path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph');
  const hasQ = await fs.access(path.join(ctl, 'question.md')).then(() => true).catch(() => false);
  const ans = await fs.access(path.join(ctl, 'answer.md')).then(() => true).catch(() => false);
  if (hasQ && !ans && run._rcQ !== story.id) { run._rcQ = story.id; sendPushRun(run, { title: `${run.project}: master needs you`, body: 'A question is waiting.' }); }
  if (ans || !hasQ) run._rcQ = run._rcQ === story.id ? null : run._rcQ;
}
// attention/failure: run entered the attention state
if (run.attention && !run._rcAttn) { run._rcAttn = true; sendPushRun(run, { title: `${run.project}: needs attention`, body: run.attention.message?.slice(0, 120) || 'A run hit a problem.' }); }
if (!run.attention) run._rcAttn = false;
```

In `notifyRalphDone(run)` (server.js:2130), add a line: `sendPushRun(run, { title: `${run.project}: build done ✅`, body: 'Your project finished.' });`.

> Place the needs-input/attention block where the tick already has `run` and the active `story` in scope (it computes these for supervision/stall logic). Reuse that existing `story` if present rather than recomputing.

- [ ] **Step 4: Create `/rc/sw.js`**

Create `public/rc.sw.js` and serve it at `/rc/sw.js` (add `app.get('/rc/sw.js', (_q,res)=>res.sendFile(path.join(RC_PUBLIC,'rc.sw.js')))` in server.js):

```js
self.addEventListener('push', (e) => {
  const d = (() => { try { return e.data.json(); } catch { return { title: 'webtmux', body: '' }; } })();
  e.waitUntil(self.registration.showNotification(d.title || 'webtmux', {
    body: d.body || '', tag: d.tag, data: { url: d.url || '/rc/' }, badge: '/icons/icon-192.png', icon: '/icons/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/rc/';
  e.waitUntil(clients.matchAll({ type: 'window' }).then((wins) => {
    for (const w of wins) { if (w.url.includes('/rc') && 'focus' in w) { w.navigate(url); return w.focus(); } }
    return clients.openWindow(url);
  }));
});
```

- [ ] **Step 5: Register the SW + subscribe on tap (rc.js)**

Append to `public/js/rc.js`:

```js
async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return msg('Push not supported here.');
  const reg = await navigator.serviceWorker.register('/rc/sw.js', { scope: '/rc/' });
  const perm = await Notification.requestPermission(); if (perm !== 'granted') return msg('Notifications denied.');
  const { key } = await api('/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
  await api('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
  msg('Notifications on ✓');
}
function urlB64(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }
$('notify').onclick = () => enableNotifications().catch((e) => msg(e.message));
```

- [ ] **Step 6: Gate + commit**

Run: `node --check server.js && node --check public/js/rc.js && node --check public/rc.sw.js`

```bash
git add server.js public/rc.sw.js public/js/rc.js
git commit -m "feat(rc): device-scoped web push + needs-input/attention/done triggers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Dashboard QR dialog + paired-devices management

**Files:**
- Create: `public/vendor/qrcode.min.js` (vendored MIT QR encoder)
- Modify: `public/js/dashboard.js` — "📱 Remote control" button in `buildCard` → QR dialog + paired-devices list/revoke.
- Modify: `public/index.html` — a `<dialog>` for the QR + devices.
- Modify: `public/sw.js` — bump `VERSION`.
- (Optional) `web/src/...` — same button in the React UI.

**Interfaces:**
- Consumes: `POST /api/rc/pair-token`, `GET /api/rc/devices`, `DELETE /api/rc/devices/:id` (Task 2).
- Produces: a way to pair/revoke from the dashboard.

- [ ] **Step 1: Vendor a tiny QR encoder**

Download a single-file MIT QR generator into `public/vendor/qrcode.min.js` that exposes a global `QRCode` (e.g. davidshimjs/qrcodejs `qrcode.min.js`). Verify it defines `window.QRCode`.

```bash
mkdir -p public/vendor
# fetch the file into public/vendor/qrcode.min.js (no runtime external dependency thereafter)
ls -l public/vendor/qrcode.min.js
```

- [ ] **Step 2: Add the dialog markup**

In `public/index.html`, add near the other `<dialog>`s:

```html
<dialog id="rc-dialog">
  <h3>📱 Remote control</h3>
  <p class="muted">Scan to pair this device, then supervise from your phone.</p>
  <div id="rc-qr" style="display:flex;justify-content:center;padding:8px"></div>
  <p class="muted" id="rc-qr-hint"></p>
  <h4>Paired devices</h4>
  <div id="rc-devices"></div>
  <div class="row" style="justify-content:flex-end"><button type="button" id="rc-close" class="btn small">Close</button></div>
</dialog>
<script src="/vendor/qrcode.min.js"></script>
```

- [ ] **Step 3: Wire the button + dialog in dashboard.js**

In `public/js/dashboard.js` `buildCard` (line ~1333), add a button to the actions row and handler:

```js
// in the build-actions innerHTML string, add before Delete:
+ `<button type="button" class="btn small" data-rc title="Pair a phone to supervise">📱 Remote</button>`
```

Then after the other `card.querySelector(...)` wirings:

```js
card.querySelector('[data-rc]').onclick = () => openRcDialog(s.project);
```

Add the dialog logic (near other dialog helpers):

```js
async function openRcDialog(project) {
  const dlg = document.getElementById('rc-dialog');
  document.getElementById('rc-qr').innerHTML = '';
  document.getElementById('rc-qr-hint').textContent = 'Generating…';
  try {
    const { url, expiresInMs } = await (await fetch('/api/rc/pair-token', { method: 'POST' })).json();
    new window.QRCode(document.getElementById('rc-qr'), { text: url, width: 220, height: 220 });
    document.getElementById('rc-qr-hint').textContent = `QR valid ~${Math.round(expiresInMs / 60000)} min. Pairing covers all your projects.`;
  } catch (e) { document.getElementById('rc-qr-hint').textContent = 'Failed to create pairing code.'; }
  await renderRcDevices();
  dlg.showModal();
}
async function renderRcDevices() {
  const wrap = document.getElementById('rc-devices');
  const { devices = [] } = await (await fetch('/api/rc/devices')).json();
  wrap.innerHTML = devices.length ? devices.map((d) =>
    `<div class="row"><span>${esc(d.label || 'device')} · seen ${new Date(d.lastSeen).toLocaleString()}</span>`
    + `<button type="button" class="btn small danger" data-revoke="${d.id}">Revoke</button></div>`).join('')
    : '<p class="muted">No paired devices.</p>';
  wrap.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
    await fetch(`/api/rc/devices/${b.dataset.revoke}`, { method: 'DELETE' }); renderRcDevices();
  });
}
document.getElementById('rc-close').onclick = () => document.getElementById('rc-dialog').close();
```

> Reuse the existing `esc()` helper in dashboard.js. Match the existing dialog open/close pattern (e.g. `ralphBuildsDlg`).

- [ ] **Step 4: Bump the service worker**

In `public/sw.js` line 4: `const VERSION = 'webtmux-v29';` → `const VERSION = 'webtmux-v30';`.

- [ ] **Step 5: Gate + commit**

Run: `node --check public/js/dashboard.js`

```bash
git add public/vendor/qrcode.min.js public/index.html public/js/dashboard.js public/sw.js
git commit -m "feat(rc): dashboard QR pairing dialog + paired-devices management; sw v30

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: nginx exemption (documented) + CLAUDE.md + end-to-end verification

**Files:**
- Create: `docs/ops/nginx-rc.conf` (reference snippet — NOT applied by the repo)
- Modify: `CLAUDE.md` — document the `/rc/` subsystem.

- [ ] **Step 1: Write the nginx reference snippet**

Create `docs/ops/nginx-rc.conf`:

```nginx
# Add INSIDE the existing server { } for the main host, BEFORE the catch-all `location /`.
# Exempts ONLY the /rc/ remote-control surface from basic-auth; the Node app enforces
# the device token on /rc/api/* and /rc/ws. Everything else stays basic-auth protected.
location /rc/ {
    auth_basic off;
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;          # for /rc/ws
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
# The pairing landing (/rc?t=…) is the exact path /rc — exempt it too:
location = /rc {
    auth_basic off;
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

- [ ] **Step 2: Document in CLAUDE.md**

In `CLAUDE.md`, under a new subsection (after "### Learned preferences" or near "Project preview / hosting"), add:

```markdown
## Phone remote control (`/rc/`)

Supervise a running master from your phone. Dashboard "📱 Remote" mints a one-time
pairing token rendered as a QR of `/rc?t=…`; scanning it mints a **hashed, revocable
device token** (`~/.webtmux/rc-devices.json`, cookie `rc_dev`, path `/rc`). Everything
phone-facing lives under **`/rc/`** — nginx exempts that prefix from basic-auth
(`docs/ops/nginx-rc.conf`) and the Node app gates it with the device token
(`requireDevice`, `ralph/rc-auth.mjs`). `/rc/ws` is a **read-only** pane whose tmux
session name is derived server-side (never client-supplied), so a device only sees its
own tenant's master sessions. Supervise actions (`/rc/api/{answer,steer,restart,continue,
swap}`) reuse the orchestrator's `.ralph/answer.md`/`.ralph/steer.md`/swap internals.
Web Push (existing VAPID pipeline) fires on needs-input/attention/done to paired devices;
`public/rc.sw.js` opens `/rc/#/<project>` on tap. iOS needs Add-to-Home-Screen for push.
The feature is inert until the nginx block is applied and a device is paired.
```

- [ ] **Step 3: End-to-end verification (manual, local, no spend)**

With the stub orchestrator (`RALPH_FORCE_TOOL=stub`, `RALPH_FAKE_REMOTE`) running a solo build and the nginx block applied on a test host (or by hitting `127.0.0.1:8090` directly, bypassing nginx):
1. `curl -s -XPOST http://127.0.0.1:8090/api/rc/pair-token` → get `url`; open `/rc?t=…` in a mobile browser/emulator → confirm redirect to `/rc/` + `rc_dev` cookie set.
2. Confirm the pane streams the master session; confirm `/rc/api/status` lists the run.
3. Force a `question.md` in the active worktree → confirm the banner appears and "Send answer" writes `.ralph/answer.md` (worker consumes it).
4. Tap 🔔 → confirm a push subscription is stored; trigger done → confirm a notification arrives and tapping opens `/rc/#/<project>`.
5. Revoke the device in the dashboard → confirm `/rc/api/status` now returns 401.
Tear down stub drop-in + kill `r-/rv-/rf-` sessions.

- [ ] **Step 4: Commit**

```bash
git add docs/ops/nginx-rc.conf CLAUDE.md
git commit -m "docs(rc): nginx exemption reference + CLAUDE.md remote-control section

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
| Spec section | Task |
|---|---|
| §3.1 pairing (QR, one-time→device token, cookie, revoke) | Task 1 (tokens) + Task 2 (endpoints, GET /rc) + Task 7 (QR dialog, revoke UI) |
| §3.2 device-token auth + `/rc/ws` read-only scoped | Task 2 (`requireDevice`) + Task 3 (`/rc/ws`) |
| §3.3 RC mobile view (own manifest/sw, pane, action bar, question banner, A2HS) | Task 4 (shell/pane/manifest) + Task 5 (actions) + Task 6 (sw/push) |
| §3.4 supervise endpoints | Task 5 |
| §3.5 push (device-scoped subscribe, triggers, notificationclick) | Task 6 |
| §5 security (single opening, hashed/scoped/revocable, read-only, audit) | Tasks 1–3, 6; nginx Task 8 |
| §6 platform handling (iOS A2HS, polling fallback) | Task 4 (poll, iOS hint) + Task 6 (push) |
| §8 testing | Task 1 unit; Tasks 3/4/8 manual gates |
| §9 file-by-file | All tasks; nginx + CLAUDE.md Task 8 |
| §10 decisions (tenant-wide, vendored QR, nginx documented) | Task 2 (tenant scope), Task 7 (QR), Task 8 (nginx) |

**Placeholder scan:** No "TBD/handle errors" placeholders. Code steps carry real code. Several steps carry explicit "verify/adapt this exact existing name" notes (e.g. `run.paused`/`persistRun`, `ralphSwap`, `spawnWorker`, `WORKTREES_SUBDIR`, the xterm vendor path, `tenantBySlug`) — these are deliberate integration checks against unchanged code the diff can't show, not placeholders; each names the exact symbol to confirm.

**Type/name consistency:** `rc_dev` cookie, `requireDevice`/`req.rcDevice`, `rcDevices`/`saveRcDevices`, `rcRun`/`rcCtlDir`, `sendPushRun`/`sendPushTo`, `/api/rc/*` (dashboard) vs `/rc/api/*` (device), `/rc/ws`, `/rc/sw.js` are used consistently across tasks. Push subs are tagged `{rc, deviceId, tenant}` in Task 6 and filtered on those exact fields.

**Integration symbols — verified during planning (use as written):** `run.paused` + `persistRun(run)` (server.js:1488/3142), `WORKTREES_SUBDIR='.worktrees'` (375), `spawnWorker(run,story,note)` (1654), `saasStore.getWorkspaceBySlug(slug)` (saas/store.mjs:46), `WORKTREES_SUBDIR`-based `.ralph` path (matches `spawnReview`). **Still to confirm at implementation:** that `ralphSwap` is extracted from the inline `/api/ralph/swap` route (Task 5 does this), and the exact vendored **xterm** asset path the dashboard already uses (Task 4 Step 6 — reuse it rather than double-vendoring).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-remote-control.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
