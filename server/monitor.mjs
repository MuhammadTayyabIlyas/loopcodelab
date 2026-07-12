// server/monitor.mjs — the 5s background tick: draft start timers, the tenant
// session janitor, sudo auto-revoke, staged-asset pruning, and busy/idle push
// notifications for running sessions.
import path from 'node:path';
import fs from 'node:fs/promises';
import * as saasStore from '../saas/store.mjs';
import * as saasTenants from '../saas/tenants.mjs';
import { deadSudoSessions } from '../ralph/sudo-prune.mjs';
import { staleStagedAssets } from '../ralph/assets.mjs';
import { dueDrafts, draftStartBody } from '../ralph/drafts.mjs';
import { MULTITENANT, STAGED_ASSETS_DIR, audit, execFileAsync } from './config.mjs';
import { listSessions, SHELL_CMDS } from './tmux.mjs';
import { loadDraftsList, saveDraftFor, deleteDraftFor } from './prefs.mjs';
import { sendPush, sendPushRun, subscriptionCount } from './push.mjs';
import { sudoSessions, reconcileSudo } from './sudo.mjs';
import { startRunFromRequest } from './ralph-engine.mjs';
// --- draft start timer (one-shot scheduled starts, ChatGPT-tasks/Claude-routines style:
// the schedule is persisted ON the draft, the server clock fires it — the user's browser
// need not be open). monitorTick (5s) calls draftTimerTick; the scan itself is throttled.
let lastDraftScan = 0;
const startingDrafts = new Set(); // in-flight guard: a slow start must not double-fire
export async function draftTimerTick(now = Date.now()) {
  if (now - lastDraftScan < 15_000) return;
  lastDraftScan = now;
  let due = [];
  if (MULTITENANT) { try { due = saasStore.listAllDueDrafts(now); } catch { due = []; } }
  else due = dueDrafts(await loadDraftsList(null).catch(() => []), now).map((d) => ({ ...d, workspaceId: null }));
  for (const d of due) {
    const key = `${d.workspaceId || 'local'}:${d.id}`;
    if (startingDrafts.has(key)) continue;
    startingDrafts.add(key);
    startScheduledDraft(d)
      .catch((err) => console.error(`draft timer: ${d.id} failed:`, err.message))
      .finally(() => startingDrafts.delete(key));
  }
}

async function startScheduledDraft(d) {
  let tenant = null;
  if (d.workspaceId) {
    const ws = saasStore.getWorkspaceById(d.workspaceId);
    if (!ws) return; // workspace deleted since scheduling — drop silently
    tenant = saasTenants.tenantContext(ws);
  }
  const { id, workspaceId, updatedAt, createdAt, startAt, startError, ...cfg } = d;
  // Consume the timer FIRST — a crash mid-start must not refire the draft forever.
  await saveDraftFor(tenant, d.id, { ...cfg, startAt: null, startError: null });
  const label = cfg.name || cfg.project || d.id;
  try {
    const run = await startRunFromRequest(draftStartBody(cfg), tenant);
    await deleteDraftFor(tenant, d.id); // the draft became a run
    audit({ draft: d.id, scheduledStart: run.project, tenant: tenant?.slug });
    sendPush({ title: `Ralph: ${run.project}`, body: '⏰ Timer fired — your scheduled build is running.', tag: `ralph-${run.project}`, url: '/' }).catch(() => {});
    sendPushRun(run, { title: `${run.project}: scheduled build started ⏰`, body: 'The draft timer fired and the build is running.' }).catch(() => {});
  } catch (err) {
    // Keep the draft, surface WHY it did not start (dead key, plan cap, name clash …)
    // — the same class of failures a manual Start would have shown in the dialog.
    await saveDraftFor(tenant, d.id, { ...cfg, startAt: null, startError: String(err.message || err).slice(0, 300) }).catch(() => {});
    audit({ draft: d.id, scheduledStartFailed: String(err.message || '').slice(0, 120), tenant: tenant?.slug });
    sendPush({ title: `Ralph draft: ${label}`, body: `⏰ Scheduled start failed: ${err.message}`, tag: `draft-${d.id}`, url: '/' }).catch(() => {});
  }
}

const IDLE_MS = Number(process.env.WEBTMUX_IDLE_MS || 90_000);   // "may need input"
const FINISH_MIN_MS = Number(process.env.WEBTMUX_FINISH_MS || 30_000); // ignore quick commands
const monitorState = new Map(); // name -> { state, activity, busySince, notifiedIdle }

// Remove staged-asset upload dirs older than the TTL (a New Build dialog opened,
// files staged, never started). Pure helper decides which; we rm them. Best-effort.
async function pruneStagedAssets() {
  let names;
  try { names = await fs.readdir(STAGED_ASSETS_DIR); } catch { return; }
  const entries = [];
  for (const token of names) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(STAGED_ASSETS_DIR, token, 'meta.json'), 'utf8'));
      entries.push({ token, createdAt: m.createdAt });
    } catch { entries.push({ token, createdAt: 0 }); } // unreadable → treat as stale
  }
  for (const token of staleStagedAssets(entries, Date.now())) {
    await fs.rm(path.join(STAGED_ASSETS_DIR, token), { recursive: true, force: true }).catch(() => {});
  }
}

// Session janitor: tenant sandboxes accumulate finished sessions — login-* stays open
// after the sign-in is saved, and worker/review sessions can outlive their run because
// the reaper kills on the APP tmux socket while tenant sessions live on the TENANT's
// own server (found 2026-07-02: 18 stale sessions back to Jun 10). Every 10 min, per
// tenant: kill login-* older than 24h and ralph work sessions older than 45 min — an
// ACTIVE story never legitimately exceeds RALPH_HARD_CAP_MS (30m; the tick reaps it).
const JANITOR_SH = `now=$(date +%s); tmux ls -F '#{session_name} #{session_created}' 2>/dev/null | while read n c; do
  age=$((now-c))
  case "$n" in
    *-login-*) [ "$age" -gt 86400 ] && tmux kill-session -t "$n" 2>/dev/null;;
    *-r-*|*-rv-*|*-rf-*|*-rd-*) [ "$age" -gt 2700 ] && tmux kill-session -t "$n" 2>/dev/null;;
  esac
done; true`;
let lastJanitor = 0;
// Admin "sweep now": reset the throttle and run one janitor pass immediately.
export async function runSessionJanitorNow() {
  lastJanitor = 0;
  await sessionJanitor();
}
async function sessionJanitor(now = Date.now()) {
  if (!MULTITENANT || now - lastJanitor < 10 * 60_000) return;
  lastJanitor = now;
  let rows = [];
  try { rows = saasStore.listProvisionedWorkspaces(); } catch { return; }
  for (const ws of rows) {
    try {
      const argv = saasTenants.tenantContext(ws).wrap(['bash', '-c', JANITOR_SH]);
      await execFileAsync(argv[0], argv.slice(1), { timeout: 15_000 });
    } catch { /* tenant sandbox may be gone; best-effort */ }
  }
}

export async function monitorTick() {
  // Draft start timers fire independently of tmux session state (and of push subs).
  draftTimerTick().catch(() => {});
  sessionJanitor().catch(() => {});
  let sessions;
  try { sessions = await listSessions(); } catch { return; }
  // Auto-revoke the sudo grant for any opted-in session that no longer exists — e.g. the
  // root maintenance shell after the user types `exit`. (Explicit "kill session" already
  // revokes in the DELETE route.) Runs regardless of push subscriptions.
  const liveNames = sessions.map((s) => s.name);
  const dead = deadSudoSessions([...sudoSessions], liveNames);
  if (dead.length) { for (const n of dead) sudoSessions.delete(n); reconcileSudo().catch(() => {}); }
  pruneStagedAssets().catch(() => {}); // sweep abandoned upload dirs (before the no-subscribers return)
  if (!subscriptionCount()) { // notify work needs subscribers; pruning above does not
    for (const name of [...monitorState.keys()]) if (!liveNames.includes(name)) monitorState.delete(name);
    return;
  }
  const now = Date.now();
  const seen = new Set();
  for (const s of sessions) {
    seen.add(s.name);
    const state = SHELL_CMDS.has(s.command) ? 'shell' : 'busy';
    const prev = monitorState.get(s.name);
    const next = { state, activity: s.activity || 0, busySince: 0, notifiedIdle: false };
    if (prev) {
      next.busySince = state === 'busy' ? (prev.state === 'busy' ? prev.busySince : now) : 0;
      // Finished: was running a command long enough, now back at the prompt.
      if (prev.state === 'busy' && state === 'shell' && prev.busySince && now - prev.busySince >= FINISH_MIN_MS) {
        sendPush({ title: `✓ ${s.name} finished`, body: 'Back at the shell prompt.', tag: `fin-${s.name}`, url: `/term?s=${encodeURIComponent(s.name)}` });
      }
      // Idle: still busy but no new output for a while — likely awaiting input.
      if (state === 'busy') {
        const advanced = (s.activity || 0) > (prev.activity || 0);
        next.notifiedIdle = advanced ? false : prev.notifiedIdle;
        if (!next.notifiedIdle && now - (s.activity || now) >= IDLE_MS) {
          const secs = Math.round((now - (s.activity || now)) / 1000);
          sendPush({ title: `⏳ ${s.name} is waiting`, body: `Quiet for ${secs}s — may need input.`, tag: `idle-${s.name}`, url: `/term?s=${encodeURIComponent(s.name)}` });
          next.notifiedIdle = true;
        }
      }
    } else {
      next.busySince = state === 'busy' ? now : 0;
    }
    monitorState.set(s.name, next);
  }
  for (const name of [...monitorState.keys()]) if (!seen.has(name)) monitorState.delete(name);
}
