// server/tmux.mjs — tmux plumbing: run tmux as the right unix user, list/inspect
// sessions, and per-session process stats. All calls use argv arrays (never a
// shell string) so input can't be injected.
import path from 'node:path';
import crypto from 'node:crypto';
import * as saasTenants from '../saas/tenants.mjs';
import { execFileAsync, MT_ON, PROJECTS_ROOT } from './config.mjs';

// In multi-tenant mode a tenant's sandbox identity is fully encoded in the things
// git/tmux already operate on: the filesystem path (/home/<wt_user>/…) and the
// tmux session name (<wt_user>-…, see ralphSessionName). So instead of threading a
// tenant through ~35 call sites (and risking a miss), git()/tmux() DERIVE the
// sandbox from their own arguments and run there via the root helper. Single-tenant
// paths are /home/tmuxweb/… and names are r-/rv-/rf-… — neither matches `wt_`, so
// flag-off behaviour is byte-identical. An explicit opts.tenant always wins.
export function tenantUserFromDir(dir) {
  const m = /^\/home\/(wt_[a-z0-9]{1,28})(?:\/|$)/.exec(dir || '');
  return m ? m[1] : null;
}
export function tenantUserFromArgs(args) {
  for (const a of args) { const m = /^(wt_[a-z0-9]{1,28})-/.exec(String(a)); if (m) return m[1]; }
  return null;
}
export const wrapAsTenantUser = (user, argv) => saasTenants.tenantExecArgs({ unix_user: user }, argv);

// Run tmux with an argv array (never a shell string) so input can't be injected.
export async function tmux(args, opts = {}) {
  const user = MT_ON() && !opts.tenant ? tenantUserFromArgs(args) : null;
  const argv = opts.tenant ? opts.tenant.wrap(['tmux', ...args])
    : user ? wrapAsTenantUser(user, ['tmux', ...args])
    : ['tmux', ...args];
  return execFileAsync(argv[0], argv.slice(1), { timeout: 10_000 });
}

export async function listSessions(tenant = null) {
  // Tab-separated fields per session; sort newest first for the dashboard.
  // window_name / pane_current_command / pane_current_path resolve to the
  // session's active pane — enough to show what each session is doing.
  // With a tenant, list sessions on THAT tenant's tmux socket (their build runs).
  const fmt = [
    '#{session_name}', '#{session_windows}', '#{session_attached}',
    '#{session_created}', '#{session_activity}',
    '#{window_name}', '#{pane_current_command}', '#{pane_current_path}',
  ].join('\t');
  try {
    const { stdout } = await tmux(['list-sessions', '-F', fmt], { tenant });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, windows, attached, created, activity, window, command, cwd] = line.split('\t');
        return {
          name,
          windows: Number(windows) || 0,
          attached: Number(attached) > 0,
          clients: Number(attached) || 0,
          created: Number(created) * 1000 || null,
          activity: Number(activity) * 1000 || null,
          window: window || '',
          command: command || '',
          cwd: cwd || '',
        };
      })
      .sort((a, b) => (b.activity || 0) - (a.activity || 0));
  } catch (err) {
    // "no server running" simply means there are no sessions yet.
    if (/no server running|no current session/i.test(err.stderr || err.message)) return [];
    throw err;
  }
}

// The project a cwd belongs to: first path segment under PROJECTS_ROOT, else null.
export function projectFromCwd(cwd, root = PROJECTS_ROOT) {
  if (!cwd) return null;
  const prefix = root + path.sep;
  if (!cwd.startsWith(prefix)) return null;
  return cwd.slice(prefix.length).split(path.sep)[0] || null;
}

// Last few non-blank lines of a session's active pane — a glanceable preview.
export async function paneTail(name, lines = 3) {
  try {
    const { stdout } = await tmux(['capture-pane', '-p', '-t', name]);
    const rows = stdout.replace(/[ \t]+$/gm, '').split('\n');
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows.slice(-lines).map((l) => l.slice(0, 200)).join('\n');
  } catch {
    return '';
  }
}

// Shells count as "idle / at a prompt"; anything else is a running command.
export const SHELL_CMDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', '-bash', '-zsh', 'login', 'tmux']);

// Approximate CPU%/RSS per session by summing each session's pane process trees.
// One ps snapshot + one list-panes call covers all sessions (no per-session fan-out).
export async function statsForSessions(names) {
  const out = {};
  if (!names.length) return out;
  let panes, ps;
  try {
    [panes, ps] = await Promise.all([
      tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']),
      execFileAsync('ps', ['-eo', 'pid=,ppid=,rss=,pcpu='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
  } catch {
    return out;
  }
  const procs = new Map();   // pid -> { rss, cpu }
  const children = new Map(); // ppid -> [pid]
  for (const line of ps.stdout.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const pid = +f[0], ppid = +f[1];
    procs.set(pid, { rss: +f[2], cpu: parseFloat(f[3]) || 0 });
    (children.get(ppid) || children.set(ppid, []).get(ppid)).push(pid);
  }
  const roots = new Map(); // session -> [pane pids]
  for (const line of panes.stdout.split('\n').filter(Boolean)) {
    const [sn, pid] = line.split('\t');
    (roots.get(sn) || roots.set(sn, []).get(sn)).push(+pid);
  }
  for (const name of names) {
    let rss = 0, cpu = 0;
    const stack = [...(roots.get(name) || [])];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = procs.get(pid);
      if (!p) continue;
      rss += p.rss; cpu += p.cpu;
      for (const c of (children.get(pid) || [])) stack.push(c);
    }
    out[name] = { rssMb: Math.round(rss / 1024), cpu: Math.round(cpu * 10) / 10 };
  }
  return out;
}

// A signature of a session's visible pane; changes whenever the agent emits output.
export async function paneSignature(name) {
  try {
    const { stdout } = await tmux(['capture-pane', '-p', '-t', name]);
    return crypto.createHash('sha1').update(stdout).digest('hex');
  } catch { return ''; }
}
