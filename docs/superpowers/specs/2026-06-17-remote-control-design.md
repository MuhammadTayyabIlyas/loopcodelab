# Phone Remote Control of the Ralph Master — Design

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** Claude (pair) + tayyabcheema777

## 1. Problem & goal

When a Ralph build is running, the **master** agent occasionally needs a human: it
raises a design question (`.ralph/question.md`), a run hits `attention`/fails, or you
just want to watch and steer. Today that requires the desktop dashboard (behind nginx
basic-auth). We want to **supervise the master from your phone**, conveniently and
securely:

- Scan a **QR** on the dashboard → your phone is paired (persistently — scan once).
- A mobile view shows the **master's live terminal** plus **supervise actions**
  (continue / steer / restart / answer question / swap master).
- Your phone is **pushed a notification** when the master needs you (question), when a
  run hits trouble (attention/failure), and when a run completes — tap it to jump
  straight to that project's supervise view.

### Locked decisions (from brainstorming)
- **Who/what:** phone supervises the **master** agent.
- **Transport:** self-contained — the webtmux PWA over the existing `/ws`-style tmux
  bridge. No dependency on Claude Code's own remote control.
- **Capability:** **supervise actions only** (view pane + continue/steer/restart/answer/
  swap). No raw interactive terminal (explicitly out of scope — lower risk on mobile).
- **Master scope:** **any** master (claude/codex/qwen/gemini) — the supervise actions
  are orchestrator-level and agent-agnostic.
- **Push triggers:** master **needs input** + run **attention/failure** + run **done**.

### Non-goals
Raw keystroke terminal on mobile; controlling non-Ralph tmux sessions; multi-user
sharing of one device pairing; native app store apps; offline operation.

## 2. Grounding in existing code (verified) + constraints

**Reusable assets (already in the repo):**
- **Web Push**: self-provisioned VAPID (`vapid.json`), subscription store
  (`subscriptions.json`), `sendPush()` / `notifyRalphDone()`, and routes
  `GET /api/push/key`, `POST /api/push/subscribe|unsubscribe|test`
  (`server.js:2187-2224, 3638-3660`).
- **Terminal bridge**: `WebSocketServer` on `/ws` (`server.js:3676`) that runs
  `tmux new-session -A -s <name>` and pipes the PTY. Single-tenant: open behind nginx
  basic-auth. Multitenant: gated by session cookie + `wt_<user>-` name prefix.
- **Supervision primitives**: worker escalation `.ralph/question.md` → answered into
  `.ralph/answer.md` (`server.js:1186-1200`); steering note → `.ralph/steer.md`
  (`server.js:1244`); the `attention` block in run status (`server.js:1461`);
  `POST /api/ralph/swap`, `/pause`, `/resume`, `/skip`.
- **PWA**: `public/manifest.webmanifest`, `public/sw.js` (cache-versioned), vendored
  xterm.js (used by `public/js/term.js`).
- **Master session names**: `ralphSessionName(project,'final','rf')` = finalize,
  `…'<id>','rv'` = review, `…'<id>','r'` = worker (multitenant prefixes `wt_<user>-`).

**Production constraints (from research):**
- **iOS (16.4+)**: Web Push requires the PWA be **Added to Home Screen** (manifest
  `display: standalone`) and a **tap-gesture** permission prompt; an open Safari tab
  cannot receive push. **EU** devices: Apple disabled standalone-PWA push (DMA) — they
  fall back to in-app polling only. You **cannot deep-link into an installed PWA** on
  iOS, so first pairing opens Safari; we then prompt Add-to-Home-Screen; thereafter a
  push tap opens the installed PWA (the notification belongs to the home-screen app).
  ([magicbell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide),
  [progressier](https://intercom.help/progressier/en/articles/6902113-complete-guide-to-pwa-deep-links))
- **Android (Chrome)**: install prompt + deep-link into PWA scope both work.
- **Pairing pattern**: QR carries a short-lived one-time secret → establishes a
  persistent device identity. ([Firefox pairing](https://mozilla.github.io/ecosystem-platform/relying-parties/tutorials/pairing),
  [WebAuthn hybrid](https://www.corbado.com/blog/webauthn-passkey-qr-code))

## 3. Architecture

**Auth-zone principle.** The dashboard stays behind nginx basic-auth. A paired phone
*cannot* pass basic-auth, so **everything remote-control lives under a single `/rc/`
prefix** that nginx exempts from basic-auth, and the Node app gates with a **device
token**. The dashboard's existing `/ws` and `/api/*` are untouched (no weakening).

```
nginx:  location /rc/ { auth_basic off; proxy_pass http://127.0.0.1:8090; ... }   # only exception
app:    /rc            → pairing entry + RC page shell (static, no secrets)
        /rc/ws         → device-token-gated PTY bridge (read-only pane)
        /rc/api/*      → device-token-gated supervise + status + push endpoints
```

### 3.1 Pairing (QR → persistent device)
- Dashboard adds a **📱 Remote control** action (per project and/or global). Clicking it
  calls `POST /api/rc/pair-token` (under basic-auth) → returns a **one-time pairing
  token** `pt_<rand>` (single-use, ~5 min TTL, bound to the tenant; in multitenant to
  `req.tenant`). The dashboard renders it as a **QR** of `https://<host>/rc?t=pt_<rand>`
  (QR drawn client-side from vendored lib or a tiny canvas encoder; no external service).
- Phone scans → opens `/rc?t=…` (nginx-exempt). `GET /rc` validates the token
  (single-use, unexpired), **mints a device token** `dev_<rand>`, stores a device record
  (id, **sha256(token)**, label=UA, createdAt, lastSeen, tenant, push endpoint later),
  sets it as an **HttpOnly; Secure; SameSite=Lax** cookie (path `/rc`), invalidates the
  pairing token, audits, and redirects to the RC app (`/rc/#/<project>`).
- **Persistence**: the cookie + device record persist; revisiting `/rc` (home-screen
  icon / bookmark) reconnects with no re-scan. Dashboard shows a **Paired devices** list
  (`GET /api/rc/devices`) with revoke (`DELETE /api/rc/devices/:id`) → token invalid +
  its push subscription dropped.

### 3.2 Device-token auth + the RC websocket
- A small middleware `app.use('/rc/api', requireDevice)` and a check on `/rc/ws`
  validate the cookie's `dev_` token against the store (constant-time sha256 compare),
  set `req.device` (with tenant scope), and update `lastSeen`. Missing/invalid → 401
  (API) or ws close 1008.
- **`/rc/ws`** is a second `WebSocketServer` path (or the same server, branched by
  `req.url`). It accepts `?s=<session>&project=<p>` and **only** attaches to a master
  session for a project the device is scoped to: it recomputes the allowed names with
  `ralphSessionName(project, …, 'rv'|'rf'|'r…', tenant)` and rejects anything else (no
  free-form session names — unlike `/ws`). Multitenant: runs tmux **as the tenant**
  (`tenantExecArgs`), single-tenant: as the app user. The pane is **read-only** — the
  socket ignores inbound data (capability = supervise only).

### 3.3 RC mobile view (`/rc/`)
A dedicated, mobile-first page (`public/rc.html` + `public/js/rc.js`), its own
`/rc/manifest.webmanifest` (scope `/rc/`, `display: standalone`) and `/rc/sw.js`
(scope `/rc/`) so it installs and receives push independently of the dashboard PWA.
Contents:
- **Project switcher** (the device's runs, from `/rc/api/status`).
- **Live master pane**: xterm.js (read-only) attached to the current master session via
  `/rc/ws` — finalize (`rf`) if finalizing, else the active review (`rv`) / worker (`r`).
- **Supervise action bar**: Continue · Steer (text) · Restart story · **Answer**
  (shown when a question is pending) · Swap master.
- **Pending-question banner** when `question.md` is open, with the question text + answer
  box (the highest-value action).
- **Enable notifications** button (tap-gesture → permission → subscribe), plus an
  **Add to Home Screen** hint on iOS.

### 3.4 Supervise endpoints (`/rc/api/*`, device-token-gated)
Thin wrappers that reuse existing orchestrator internals, scoped to `req.device`'s tenant:
- `GET  /rc/api/status[?project=]` — run list + per-run phase, current story, **pending
  question** (read `question.md` if present and unanswered), attention block, master id.
- `POST /rc/api/answer  {project, story?, text}` — write `.ralph/answer.md` for the
  story that raised the pending question (`status` returns its id; `story` defaults to it).
- `POST /rc/api/steer   {project, story?, text}` — write `.ralph/steer.md` for the named
  story, defaulting to the currently-building one (the same target the autonomous steer uses).
- `POST /rc/api/restart {project, story?}` — re-spawn the current/named story (reuse the
  existing restart path used by supervision).
- `POST /rc/api/continue{project}` — `resume` if paused; else no-op ack.
- `POST /rc/api/swap    {project, role, agent}` — reuse `swap` internals.
- Push (device-scoped): `GET /rc/api/push/key`, `POST /rc/api/push/subscribe` (associates
  the subscription with `req.device`), `POST /rc/api/push/unsubscribe`.

### 3.5 Push convenience
- `sendPush` is extended so a payload may target **specific device subscriptions** (by
  tenant/project), not only the global list. Subscriptions made via `/rc/api/push/subscribe`
  are stored **with their `deviceId`** so revoking a device stops its pushes.
- Triggers (all carry `url:/rc/#/<project>`, `tag` per project so they collapse):
  - **needs-input**: when the tick detects a new unanswered `question.md` for a run.
  - **attention/failure**: when a run enters the `attention`/failed state.
  - **done**: extend the existing `notifyRalphDone` to also hit the run's paired devices.
- `/rc/sw.js` handles `push` (show notification) and `notificationclick`
  (`clients.openWindow(data.url)` / focus existing) — opens the RC view on the project.

## 4. Data flow

```
Dashboard (authed) ──POST /api/rc/pair-token──▶ pt_<rand> ──rendered as QR──▶
Phone scans ──GET /rc?t=pt_<rand>──▶ validate+mint dev_token (cookie) ──▶ /rc/#/<project>
Phone ──/rc/ws?project=p──▶ attach master pane (read-only)
Phone ──POST /rc/api/answer──▶ .ralph/answer.md ──▶ worker reads it, continues
[later] master raises question.md ──tick detects──▶ sendPush(paired devices, url:/rc/#/p)
Phone push tap ──sw notificationclick──▶ open /rc/#/p (installed PWA on Android/iOS-home-screen)
```

## 5. Security & threat model
- **nginx exemption is the only opening** and is scoped to `/rc/` exactly; the bare
  `/rc?t=` pairing route requires a valid one-time token; `/rc/api/*` + `/rc/ws` require
  a valid device token; the static `/rc/` shell holds no secrets.
- **Tokens**: pairing token single-use + short TTL + created only by an authed dashboard
  user; device token long-lived but **revocable**, stored **hashed**, HttpOnly/Secure/
  SameSite, scoped to one tenant. Constant-time comparison. Rate-limit `/rc?t=` and
  `/rc/api/*`. Every pair/revoke/answer/steer/swap **audited**.
- **Session scoping**: `/rc/ws` never accepts a free-form session name — it derives the
  allowed master-session names from the device's tenant + requested project, so a device
  can never attach to another tenant's or a non-Ralph session.
- **Read-only pane** removes the raw-keystroke attack surface entirely.
- **Revocation** is immediate (token check is per-request) and drops the device's push.

## 6. Platform handling (explicit)
- **manifest**: ensure `/rc/manifest.webmanifest` has `display: standalone`, `scope:/rc/`,
  `start_url:/rc/`, icons (reuse existing).
- **iOS**: on first open, detect non-standalone (`navigator.standalone === false`) →
  show "Add to Home Screen for notifications" instructions; gate the push-subscribe button
  on a tap; if EU/unsupported, hide push and fall back to in-view polling of
  `/rc/api/status`. Push tap opens the home-screen PWA.
- **Android**: offer `beforeinstallprompt`; deep-links/notification taps open the PWA.
- **Fallback (any platform without push)**: the RC view **polls** `/rc/api/status` every
  few seconds while open, so questions/attention still surface (just not when closed).

## 7. Error handling & edge cases
- Expired/used pairing token → friendly "QR expired, generate a new one" page.
- Device token revoked mid-session → next API/ws call 401 → RC view shows "re-pair".
- No active run / run finished → RC view shows status, disables pane/actions.
- Two devices paired → both get push; both can act (last write wins on answer/steer).
- `question.md` already answered (autonomous supervisor beat the human) → answer endpoint
  is a no-op with a clear message; the banner clears on next status poll.
- Multitenant off vs on: device scope = whole deployment (single-tenant) vs `req.tenant`.

## 8. Testing (no spend, local)
- **Pairing/token unit tests** (pure module `rc-auth` like `solo-models`): token mint,
  hash+constant-time compare, single-use, TTL expiry, revoke. `node --test`.
- **Device-gate middleware**: returns 401 without/with bad cookie; 200 with good; updates
  lastSeen. Focused supertest-style or a thin function test.
- **`/rc/ws` scoping**: asserts a device scoped to tenant A cannot derive/attach a tenant
  B session name (unit-test the name-derivation guard).
- **Push targeting**: `sendPush` to a device subset selects the right endpoints (unit).
- **End-to-end (manual, local)**: with the stub orchestrator running a solo build, pair a
  phone/emulator, answer a forced `question.md`, confirm the worker consumes `answer.md`;
  verify a push arrives on a forced question. No external API spend.
- Gates: `node --check server.js`, `node --check public/js/rc.js`, bump `public/sw.js` and
  add `/rc/sw.js`.

## 9. File-by-file change list
| File | Change |
|---|---|
| `ralph/rc-auth.mjs` (new) + test | Pure: pairing/device token mint, hash, compare, TTL, store shape. |
| `server.js` | Device store load/save; `requireDevice` middleware; `POST /api/rc/pair-token`, `GET/DELETE /api/rc/devices`; `GET /rc`, static `/rc/` assets; `/rc/ws` handler (read-only, scoped); `/rc/api/{status,answer,steer,restart,continue,swap,push/*}`; extend `sendPush` for device targeting; fire needs-input/attention/done pushes in the tick. |
| `public/rc.html`, `public/js/rc.js` (new) | Mobile RC view: pane (xterm read-only), action bar, question banner, push enable, iOS A2HS hint, status polling. |
| `public/rc.manifest.webmanifest`, `public/rc.sw.js` (new) | `/rc/`-scoped PWA + push/notificationclick. |
| `public/js/dashboard.js`, `web/src/...` | "📱 Remote control" button → QR dialog; Paired-devices list/revoke. (PWA: bump `sw.js`.) |
| nginx vhost (ops, outside repo) | `location /rc/ { auth_basic off; proxy_pass …; Upgrade headers }`. Documented, not committed. |
| `CLAUDE.md` | Document the `/rc/` remote-control subsystem + nginx exception. |

## 10. Decisions (resolved at review)
1. **Device scope = tenant-wide** ✅ — pair once, supervise all your projects; the project
   is just the landing view. (Chosen.)
2. **QR encoder** — vendor a tiny MIT QR lib client-side, no external QR service (privacy).
   (Recommendation; adopted.)
3. **nginx `location /rc/` exemption** — ops step outside the repo. The plan **documents
   the exact block** for the user to review/apply before go-live; the feature ships dark
   until then. (Chosen.)

## 11. Rollout
1. `rc-auth` module + tests; device store + pairing endpoints (no UI yet).
2. `/rc/ws` + `/rc/api/status` + RC page shell (read-only pane working).
3. Supervise endpoints (answer/steer/restart/continue/swap) + action bar.
4. Push: subscribe + triggers + `/rc/sw.js`.
5. Dashboard QR dialog + paired-devices management.
6. nginx exemption + manual end-to-end on a phone; docs.
Each step is independently testable; the feature is inert until the nginx exemption +
first pairing exist, so it ships dark safely.
