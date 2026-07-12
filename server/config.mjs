// server/config.mjs — deployment constants, data paths, tiny fs helpers, audit log.
// Everything here is env-derived or pure; no imports from other server/ modules.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const execFileAsync = promisify(execFile);

// This file lives in server/; the repo root (where public/, web/, ralph/ live) is one up.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HOST = process.env.WEBTMUX_HOST || '127.0.0.1';
export const PORT = Number(process.env.WEBTMUX_PORT || 8090);
export const HOME = process.env.HOME || '/home/tmuxweb';

// Each project is a sub-directory of this root; sessions start there (tmux -c).
export const PROJECTS_ROOT = process.env.WEBTMUX_PROJECTS_ROOT || path.join(HOME, 'projects');

// Writable state dir (push keys/subscriptions, audit log). HOME is owned by the
// service user, so this needs no extra provisioning.
export const DATA_DIR = process.env.WEBTMUX_DATA || path.join(HOME, '.webtmux');
export const STAGED_ASSETS_DIR = path.join(DATA_DIR, 'staged-assets'); // pre-/start brand uploads, keyed by token
export const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
export const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
export const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
// Server-only credentials for the Ralph orchestrator (OpenAI planner + GitHub
// auto-push). Never sent to the client. chmod 600, owned by the service user.
export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
// Vendored Ralph loop + prompts (ralph.sh, prompt.md, planner.md, review.md).
export const RALPH_DIR = path.join(REPO_ROOT, 'ralph');

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// tmux session names cannot contain '.' or ':'. Keep them to a tidy, safe set.
// Long enough for tenant-prefixed Ralph sessions: wt_<slug≤28>- + r-<project≤64>-s<N>.
// Charset is the security boundary (no slashes/dots → no traversal); length is not.
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
export const validName = (n) => typeof n === 'string' && NAME_RE.test(n);

// Project folder names: no slashes (so no traversal); '.' allowed but never a
// leading one, so '..' is rejected by the leading-alnum requirement.
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const validProject = (n) => typeof n === 'string' && PROJECT_RE.test(n);

// --- Append-only audit log of launched commands ----------------------------
export async function audit(entry) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(AUDIT_FILE, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  } catch { /* best effort; never block a launch on logging */ }
}

// True if `child` resolves to inside `parent` (path-traversal guard).
export function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export const MT_ON = () => process.env.WEBTMUX_MULTITENANT === '1';
export const MULTITENANT = process.env.WEBTMUX_MULTITENANT === '1';
// Admin accounts: any signed-in user whose email is in WEBTMUX_ADMIN_EMAILS gets the
// admin dashboard (invites, user access, resource/plan allocation). No DB flag needed.
export const ADMIN_EMAILS = new Set((process.env.WEBTMUX_ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
export const isAdminEmail = (email) => !!email && ADMIN_EMAILS.has(String(email).toLowerCase());

export const BASE_DOMAIN = process.env.WEBTMUX_BASE_DOMAIN || 'tayyabcheema.com';
export const DASHBOARD_HOST = (process.env.WEBTMUX_DASHBOARD_HOST || `tmux.${BASE_DOMAIN}`).toLowerCase();

// Where a finished build's static web output can live, in probe order. The
// preview server probes the same list minus '.' (a bare repo root is browsable
// via the file browser instead of being served as a site).
export const STATIC_OUTPUT_DIRS = ['build/web', 'dist', 'build', 'out', 'public', '.'];
export const WEB_ROOT_CANDIDATES = STATIC_OUTPUT_DIRS.filter((d) => d !== '.');
