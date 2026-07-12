# Admin Root Maintenance Shell — Design

**Date:** 2026-06-17
**Status:** Draft for review
**Author:** Claude (pair) + tayyabcheema777

## 1. Problem & goal

An operator needs an in-dashboard **root shell** to maintain the deployment: update model
IDs (`~/.webtmux/soloModels.json`), bump the app/PWA version, `git pull`, edit secrets,
`systemctl restart webtmux`, etc. — without SSHing to the box separately. Goal: a one-click
**"Root maintenance shell"** that opens a tmux terminal sitting at a **root prompt in the
webtmux repo directory**, gated to operators, with the privilege **auto-revoked when the
shell closes**.

### Decisions (resolved in brainstorming)
- **Privilege:** a genuine **root shell** (`#`), implemented as **(A)** a *tmuxweb-owned*
  tmux session whose pane runs `sudo -s` — so the existing `/ws` terminal attaches normally
  while the interactive shell is root. The passwordless-sudo grant is **auto-enabled** while
  the shell is open and **auto-revoked** when it closes.
- **Working directory:** the **webtmux repo dir** (`__dirname`). `~/.webtmux` is a `cd` away.

### Non-goals
A root-owned tmux server on a separate socket (option B — bigger `/ws` change, deferred);
per-command privilege scoping; a GUI editor for config (use the shell); persisting the
session across reboots.

## 2. Grounding in existing code (verified)

- **Sudo grant** (`server.js:3837–3874`): the app runs as `tmuxweb`; a narrow NOPASSWD entry
  lets it call `/usr/local/sbin/webtmux-sudo on|off`, which installs/removes a sudoers rule
  granting `tmuxweb` passwordless sudo. `sudoSessions` (a Set) + `reconcileSudo()` keep the
  rule on while ≥1 session opted in; `applySudoRule` audits each change. **Reused directly.**
- **Terminal bridge** (`/ws`, server.js:3676): `tmux new-session -A -s <name>` on tmuxweb's
  socket, streamed to xterm. A session pre-created with a specific command + cwd is then
  attached by `/ws` as-is. **The maint pane is `sudo -s`, so the attached terminal is root.**
- **Session creation** (`POST /api/sessions`, server.js:3876): `tmux new-session -d -s <name>
  -c <dir>`. **Session delete** removes a session (`DELETE /api/sessions/:name`,
  `killProjectSessions`).
- **Admin gating**: `requireAdmin`/`isAdminEmail`/`WEBTMUX_ADMIN_EMAILS` (server.js:2868) —
  active only in MULTITENANT. Single-tenant is behind nginx basic-auth (everyone past it is
  trusted/operator).
- `__dirname` = the repo dir; `HOME`/`DATA_DIR` = `~/.webtmux`.

## 3. Components

### 3.1 `POST /api/maint-shell` — open (or attach) the root maintenance session
A plain `/api/*` route (so it exists in **both** single- and multi-tenant). Gating:
- **Multitenant:** require an admin — `if (MULTITENANT && !isAdminEmail(req.auth?.user?.email)) → 403`.
- **Single-tenant:** allowed (already behind nginx basic-auth).

Behavior:
1. Add `MAINT_SESSION` (`'maint'`) to `sudoSessions` and `await reconcileSudo()` → the
   passwordless-sudo rule is installed (so `sudo -s` runs non-interactively).
2. If the `maint` tmux session doesn't already exist, create it at a **root shell in the repo
   dir**: `tmux new-session -d -s maint -c <repoDir> 'cd <repoDir>; exec sudo -s'`. If it
   exists, leave it (idempotent — reopening just re-attaches).
3. `audit({ maintShell: 'open', by: <email|null> })`. Return `{ session: 'maint' }`.

The dashboard then opens the normal terminal view on `s=maint` (existing `/ws` flow); the
user lands at a root prompt (`#`) in the repo.

### 3.2 Auto-revoke sudo when the shell closes
The sudo grant must drop when the maint session ends (not just detaches):
- Extend `DELETE /api/sessions/:name` (and `killProjectSessions`) so that removing a session
  also does `sudoSessions.delete(name); reconcileSudo()` (covers the "Kill session" button).
- Belt-and-suspenders in the existing **monitor tick** (which already `listSessions()`): prune
  any `sudoSessions` entry whose session no longer exists, then `reconcileSudo()`. So if the
  root shell exits (the `sudo -s` shell quits → the `maint` session dies on its own), the next
  tick withdraws sudo within ~the monitor interval.
- `applySudoRule` already audits on/off, so revocation is logged.

### 3.3 UI — "Root maintenance shell" control
In the PWA dashboard (`public/`), add a clearly-marked **🔧 Root maintenance shell** button
(it belongs with the terminal-centric PWA, which owns xterm/`term.html`). Clicking:
1. `POST /api/maint-shell` → `{ session }`.
2. Open the terminal on that session (the existing "open session" path → `term.html?s=maint`).
3. Show a one-line red warning: "Root shell — full system privilege. Sudo is withdrawn when
   you close this session."

Visibility: in single-tenant, always shown (behind basic-auth). In multitenant, only when the
signed-in user is an admin (the dashboard already knows `isAdmin` from `/api/auth/me`); the
endpoint enforces it regardless. (If the React SaaS app wants the button too, it can call the
same endpoint + open the terminal — optional follow-up.) Bump `public/sw.js`.

## 4. Data flow
```
[admin] click 🔧 ──POST /api/maint-shell──▶ sudoSessions.add('maint') + reconcile(on)
                                          ──▶ tmux new-session -d -s maint -c <repo> 'exec sudo -s'
                                          ──▶ {session:'maint'}
dashboard opens term ──/ws?s=maint──▶ attaches tmuxweb session → pane is `sudo -s` → root # prompt
[admin] exits shell / kills session ──▶ maint session gone ──▶ (delete route or monitor prune)
                                      ──▶ sudoSessions.delete('maint') + reconcile(off) → sudo withdrawn
```

## 5. Security & threat model
- A root web shell is the most powerful surface in the app; it is gated to **operators**
  (admin email in multitenant; nginx basic-auth in single-tenant) and **every open is audited**.
- **Privilege is revocable + bounded:** sudo is only active while the maint session is open; it
  is auto-revoked when the session ends (delete route + monitor prune), matching the existing
  toggle's "withdraw on last off" guarantee. Default OFF; boot resets to OFF (existing behavior).
- The session name is a fixed constant (`maint`, `validName`-safe); no user input flows into a
  shell command. `cd <repoDir>` uses `__dirname` (server constant), not user input.
- Reuses the audited `webtmux-sudo` helper — no new privileged binary or sudoers entry.
- Note: while the maint shell is open, the sudo grant is process-wide for `tmuxweb` (OS sudo is
  per-user) — same property as the existing per-session toggle. Acceptable + documented.

## 6. Error handling & edge cases
- `webtmux-sudo on` fails (helper missing / sudoers not installed) → roll back
  `sudoSessions.delete('maint')`, return 500 with the helper's stderr (don't create a session
  that can't sudo).
- `maint` session already exists → idempotent: skip create, still ensure sudo on, return it.
- Non-admin in multitenant → 403, nothing changed.
- Closing the browser/terminal **detaches** but the session persists (tmux); sudo stays on
  until the session is actually killed or its root shell exits — documented; the monitor prune
  + the explicit "Kill session" both withdraw it.
- Reboot/app restart: boot resets sudo to OFF (existing); a stale `maint` session (if the tmux
  server survived) is harmless and reopened idempotently.

## 7. Testing (no spend)
- **Route gating (unit/integration):** in MULTITENANT, `POST /api/maint-shell` without an admin
  session → 403; with admin → 200 `{session:'maint'}`. Single-tenant → 200. (Use a throwaway
  instance; stub/avoid the real `webtmux-sudo` by asserting the call path — see below.)
- **Sudo-revoke wiring (unit):** a small pure helper `pruneDeadSudoSessions(sudoSessions,
  liveNames)` → returns the set to keep; unit-test that a missing `maint` is pruned. Wire it
  into the monitor tick + `DELETE` route.
- **Session command (review):** assert the `new-session` argv for maint contains `-c <repoDir>`
  and the `sudo -s` pane command (verified in the diff; the live root prompt is a manual smoke
  test since it needs the real sudoers helper).
- Gates: `node --check server.js`, `node --check public/js/dashboard.js`, `node --test` (the prune helper).
- **Manual smoke (operator):** click the button, confirm a `#` root prompt in the repo dir,
  `whoami` → root; close the session, confirm `sudo -n true` from a normal pane now fails
  (grant withdrawn) and the audit log shows `sudo off`.

## 8. File-by-file change list
| File | Change |
|---|---|
| `server.js` | `MAINT_SESSION` const; `POST /api/maint-shell` (gating, enable sudo, create root-shell session, audit, rollback); `pruneDeadSudoSessions` helper wired into the monitor tick + `DELETE /api/sessions/:name` to auto-revoke. |
| `ralph/…` or inline | `pruneDeadSudoSessions(sudoSessions, liveNames)` pure helper + unit test (small; can live in a tiny module or be tested via an exported function). |
| `public/index.html`, `public/js/dashboard.js`, `public/sw.js` | 🔧 Root maintenance shell button (admin/basic-auth visible) → POST + open terminal + red warning; sw bump. |
| `CLAUDE.md` | Document the maintenance shell (root via `sudo -s` in a tmuxweb session; auto-revoked; admin-gated). |

## 9. Decisions (resolved)
1. Privilege = **root shell via `sudo -s`** in a tmuxweb session (option A). ✓
2. Working dir = **repo dir**. ✓
3. Auto-enable sudo on open, **auto-revoke on close** (delete route + monitor prune). ✓
4. Root-owned tmux server (option B), per-command scoping, config GUI = **out of scope**.

## 10. Rollout
1. `pruneDeadSudoSessions` helper + test; wire auto-revoke into the monitor tick + DELETE route.
2. `POST /api/maint-shell` (gating + sudo-on + root-shell session + rollback + audit).
3. UI button + warning + sw bump + docs.
Each step independently testable; additive — the existing per-session sudo toggle and terminal
flow are unchanged.
