# Admin Root Maintenance Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-click admin "Root maintenance shell" that opens a tmux terminal at a root prompt (`#`) in the webtmux repo dir, with the passwordless-sudo grant auto-enabled while open and auto-revoked when the shell closes.

**Architecture:** Additive, reusing the existing audited `webtmux-sudo` grant (`sudoSessions`/`reconcileSudo`) and the `/ws` terminal bridge. A new `POST /api/maint-shell` enables sudo and creates a tmuxweb-owned `maint` session whose pane is `exec sudo -s` (root shell). Auto-revoke: the session-delete route already drops sudo; a small pure `deadSudoSessions` helper wired into `monitorTick` covers the shell-exits-on-its-own case.

**Tech Stack:** Node 22 ESM, Express, tmux, the existing `webtmux-sudo` sudoers helper, vanilla-JS PWA.

## Global Constraints

- **ESM**; pure logic in importable modules tested with `node --test`. Gates: `node --check server.js`, `node --check public/js/dashboard.js`.
- **Reuse, don't reinvent:** use the existing `sudoSessions` Set, `reconcileSudo()`, `applySudoRule` (audited), and `SUDO_CTL` — do not add a new privileged binary or sudoers entry.
- **Session name** is the fixed constant `MAINT_SESSION = 'maint'` (`validName`-safe). No user input flows into a tmux command; the cwd is `__dirname` (the repo dir), a server constant.
- **Gating:** in MULTITENANT, `POST /api/maint-shell` requires an admin (`isAdminEmail(req.auth?.user?.email)`, else 403). Single-tenant: allowed (behind nginx basic-auth).
- **Privilege is revocable + bounded:** sudo enabled on open; auto-revoked when the session ends (DELETE route — already implemented; + `monitorTick` prune for self-exit). Default OFF; boot resets OFF (existing).
- **Audit** every maint-shell open via the existing `audit(...)`.
- **PWA cache rule:** any `public/` change requires bumping `VERSION` in `public/sw.js`.

---

### Task 1: `ralph/sudo-prune.mjs` — pure dead-session helper + tests

**Files:**
- Create: `ralph/sudo-prune.mjs`
- Test: `ralph/sudo-prune.test.mjs`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `deadSudoSessions(sudoNames, liveNames)` → `string[]` (names in `sudoNames` not present in `liveNames`).

- [ ] **Step 1: Write the failing test**

Create `ralph/sudo-prune.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadSudoSessions } from './sudo-prune.mjs';

test('returns sudo sessions that are no longer live', () => {
  assert.deepEqual(deadSudoSessions(['maint', 'foo'], ['foo', 'bar']), ['maint']);
});
test('empty when all sudo sessions are live', () => {
  assert.deepEqual(deadSudoSessions(['foo'], ['foo', 'bar']), []);
});
test('all dead when nothing is live', () => {
  assert.deepEqual(deadSudoSessions(['maint', 'foo'], []), ['maint', 'foo']);
});
test('empty inputs are safe', () => {
  assert.deepEqual(deadSudoSessions([], ['foo']), []);
  assert.deepEqual(deadSudoSessions(undefined, undefined), []);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test ralph/sudo-prune.test.mjs`
Expected: FAIL — `Cannot find module './sudo-prune.mjs'`.

- [ ] **Step 3: Implement**

Create `ralph/sudo-prune.mjs`:

```js
// Pure helper: which opted-in sudo sessions no longer correspond to a live tmux session.
// Used to auto-revoke the passwordless-sudo grant when a session (e.g. the root maintenance
// shell) ends on its own. No I/O — unit-tested in isolation.
export function deadSudoSessions(sudoNames, liveNames) {
  const live = new Set(liveNames || []);
  return [...(sudoNames || [])].filter((n) => !live.has(n));
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `node --test ralph/sudo-prune.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add ralph/sudo-prune.mjs ralph/sudo-prune.test.mjs
git commit -m "feat(maint): pure deadSudoSessions helper + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `POST /api/maint-shell` + auto-revoke prune in `monitorTick`

**Files:**
- Modify: `server.js` — import `deadSudoSessions`; `MAINT_SESSION` const + the `POST /api/maint-shell` route (near the sudo routes ~3874); restructure `monitorTick` (2402–2435) to always list sessions + prune sudo, gating only the notify work.

**Interfaces:**
- Consumes (Task 1): `deadSudoSessions(sudoNames, liveNames)`; existing `sudoSessions`, `reconcileSudo`, `isAdminEmail`, `MULTITENANT`, `tmux`, `listSessions`, `audit`, `__dirname`, `subscriptions`, `monitorState`, `SHELL_CMDS`, `IDLE_MS`, `FINISH_MIN_MS`, `sendPush`.
- Produces (Task 3): `POST /api/maint-shell` → `{ session: 'maint' }`.

- [ ] **Step 1: Import the helper**

In `server.js`, add near the other `./ralph/*.mjs` imports:

```js
import { deadSudoSessions } from './ralph/sudo-prune.mjs';
```

- [ ] **Step 2: Restructure `monitorTick` to always prune sudo**

In `server.js`, replace the top of `monitorTick` (the first three lines 2402–2405):

```js
async function monitorTick() {
  if (!subscriptions.length) return; // nothing to notify; skip the work
  let sessions;
  try { sessions = await listSessions(); } catch { return; }
```

with (list sessions first, prune sudo unconditionally, then gate the notify work):

```js
async function monitorTick() {
  let sessions;
  try { sessions = await listSessions(); } catch { return; }
  // Auto-revoke the sudo grant for any opted-in session that no longer exists — e.g. the
  // root maintenance shell after the user types `exit`. (Explicit "kill session" already
  // revokes in the DELETE route.) Runs regardless of push subscriptions.
  const liveNames = sessions.map((s) => s.name);
  const dead = deadSudoSessions([...sudoSessions], liveNames);
  if (dead.length) { for (const n of dead) sudoSessions.delete(n); reconcileSudo().catch(() => {}); }
  if (!subscriptions.length) { // notify work needs subscribers; pruning above does not
    for (const name of [...monitorState.keys()]) if (!liveNames.includes(name)) monitorState.delete(name);
    return;
  }
```

(The rest of `monitorTick` — `const now = Date.now(); const seen = new Set(); for (const s of sessions) { … }` through the final `monitorState` prune — stays unchanged.)

- [ ] **Step 3: Add `MAINT_SESSION` + the maint-shell route**

In `server.js`, after the sudo-toggle routes (after `app.post('/api/sessions/:name/sudo', …)`, ~3874), add:

```js
// Admin "root maintenance shell": a tmuxweb-owned session whose pane is `sudo -s` (a root
// shell) in the repo dir, so the dashboard terminal attaches normally while the prompt is
// root. Enables the audited sudo grant on open; it is auto-revoked when the session ends
// (DELETE route + monitorTick prune). Admin-gated in multitenant; behind basic-auth single-tenant.
const MAINT_SESSION = 'maint';
app.post('/api/maint-shell', async (req, res) => {
  if (MULTITENANT && !isAdminEmail(req.auth?.user?.email)) return res.status(403).json({ error: 'Admin only.' });
  const had = sudoSessions.has(MAINT_SESSION);
  sudoSessions.add(MAINT_SESSION);
  try {
    await reconcileSudo(); // installs the NOPASSWD rule so `sudo -s` runs non-interactively
  } catch (err) {
    if (!had) sudoSessions.delete(MAINT_SESSION);
    return res.status(500).json({ error: `Could not enable sudo: ${err.stderr?.trim() || err.message}` });
  }
  const exists = await tmux(['has-session', '-t', MAINT_SESSION]).then(() => true).catch(() => false);
  if (!exists) {
    // -c sets the cwd to the repo; `exec sudo -s` replaces the pane shell with a root shell
    // (sudo preserves cwd without -i). When that root shell exits, the session ends.
    await tmux(['new-session', '-d', '-s', MAINT_SESSION, '-c', __dirname, 'exec sudo -s']);
  }
  audit({ maintShell: 'open', by: req.auth?.user?.email || null });
  res.json({ session: MAINT_SESSION });
});
```

- [ ] **Step 4: Syntax-check + verify (gating + monitor prune)**

Run: `node --check server.js`. Then on a throwaway instance (`WEBTMUX_PORT=8099 node server.js &`):
- `curl -s -XPOST http://127.0.0.1:8099/api/maint-shell` → expect either `{"session":"maint"}` (single-tenant, if the `webtmux-sudo` helper is installed) OR `{"error":"Could not enable sudo: …"}` 500 (helper not present in the test env). Either proves the route + gating wiring; the live root prompt is a manual smoke test (needs the real sudoers helper). Paste output.
- Do NOT touch the live 8090 service. If a `maint` session was created on the throwaway instance, kill it: `tmux kill-session -t maint 2>/dev/null` (then the throwaway instance is killed anyway).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(maint): POST /api/maint-shell root shell + auto-revoke sudo prune in monitorTick

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Dashboard button + warning + sw bump + docs

**Files:**
- Modify: `public/index.html` — a 🔧 button + a warning element.
- Modify: `public/js/dashboard.js` — POST `/api/maint-shell`, open the terminal on `maint`, show the warning.
- Modify: `public/sw.js` — bump VERSION.
- Modify: `CLAUDE.md` — document the maintenance shell.

**Interfaces:**
- Consumes: `POST /api/maint-shell` → `{session}`; the existing "open a terminal on a session" path (how the dashboard opens `term.html`/`/term?s=<name>` for a session — reuse it).
- Produces: an operator-facing button.

- [ ] **Step 1: (confirmed) how the dashboard opens a terminal on a session**

Verified: the dashboard opens a session terminal via `location.href = \`/term?s=${encodeURIComponent(s.name)}\`` (`public/js/dashboard.js:135`). Step 3 uses exactly that for the maint session.

- [ ] **Step 2: Add the button + warning to index.html**

In `public/index.html`, in the dashboard's action bar (near where sessions/new-session controls live — grep for the "new session" button), add:

```html
<button type="button" id="maint-open" class="btn small danger" title="Open a root shell to maintain the deployment">🔧 Root maintenance shell</button>
```

- [ ] **Step 3: Wire it in dashboard.js**

In `public/js/dashboard.js`, add:

```js
document.getElementById('maint-open')?.addEventListener('click', async () => {
  if (!confirm('Open a ROOT maintenance shell? You will have full system privilege. Sudo is withdrawn when you close the session.')) return;
  try {
    const r = await fetch('/api/maint-shell', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed to open');
    location.href = `/term?s=${encodeURIComponent(d.session)}`;   // same as dashboard.js:135
  } catch (e) { alert(`Maintenance shell: ${e.message}`); }
});
```

- [ ] **Step 4: Bump the service worker**

In `public/sw.js`: `const VERSION = 'webtmux-v32';` → `const VERSION = 'webtmux-v33';`.

- [ ] **Step 5: Document in CLAUDE.md**

In `CLAUDE.md`, add under "## Run / iterate" (or near the sudo-toggle mention if one exists):

```markdown
- **Admin root maintenance shell:** the dashboard's "🔧 Root maintenance shell" button
  (`POST /api/maint-shell`, admin-gated in multitenant / basic-auth single-tenant) opens the
  `maint` tmux session whose pane is `exec sudo -s` — a root prompt in the repo dir — for
  ops (update `~/.webtmux/soloModels.json`, bump `public/sw.js` VERSION, `git pull`,
  `systemctl restart webtmux`). It enables the audited `webtmux-sudo` grant on open and
  auto-revokes it when the session ends (the session-DELETE route + a `deadSudoSessions`
  prune in `monitorTick`). Every open is audited.
```

- [ ] **Step 6: Gate + commit**

Run: `node --check public/js/dashboard.js`. Confirm `public/sw.js` reads `webtmux-v33` and `index.html` has `id="maint-open"`.

```bash
git add public/index.html public/js/dashboard.js public/sw.js CLAUDE.md
git commit -m "feat(maint): dashboard root-maintenance-shell button + warning; sw v33; docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
| Spec section | Task |
|---|---|
| §3.1 `POST /api/maint-shell` (gating, enable sudo, root-shell session, rollback, audit) | Task 2 |
| §3.2 auto-revoke (DELETE route already done; `deadSudoSessions` prune in monitorTick) | Task 1 (helper) + Task 2 (wiring) |
| §3.3 UI button + warning + visibility + sw bump | Task 3 |
| §5 security (gating, revocable/bounded, fixed name, audited) | Task 2 (gating/audit/rollback) + Task 1/2 (revoke) |
| §6 error handling (sudo-on fail → rollback+500; idempotent existing session; non-admin 403; self-exit revoke) | Task 2 |
| §7 testing (deadSudoSessions unit; route gating; command review) | Task 1 unit, Task 2 verify |
| §8 file-by-file | All tasks; CLAUDE.md Task 3 |

**Placeholder scan:** No "TBD/handle errors". Task 3 Step 1/3 explicitly says to substitute the real open-terminal call discovered by grep (the dashboard's existing mechanism) — a concrete instruction, not a placeholder; the exact call can't be quoted without reading dashboard.js, so the step names what to find and where to use it.

**Type/name consistency:** `deadSudoSessions(sudoNames, liveNames)→string[]`, `MAINT_SESSION='maint'`, `/api/maint-shell`→`{session}`, `sudoSessions`/`reconcileSudo` reused consistently. The DELETE-route revoke already exists (no change); the monitorTick prune uses the same `deadSudoSessions`.

**Integration symbols to confirm (grep-able):** `listSessions`, `monitorState`, `SHELL_CMDS`, `IDLE_MS`, `FINISH_MIN_MS`, `sendPush`, `isAdminEmail`, `MULTITENANT`, `tmux`, `audit`, and the dashboard's open-terminal-on-session call — each named at its use site.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-admin-maint-shell.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — execute in this session with checkpoints.

**Which approach?**
