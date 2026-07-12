// Pure source-path policy for brownfield adoption. The caller realpaths the input and
// confirms it is a directory + within the size cap; this module decides if the (already
// resolved, absolute) path is allowed to be adopted. No I/O — unit-tested in isolation.
import path from 'node:path';

// Never copy from these (or their subtrees). The system roots + common FHS dirs.
export const DENY_DIRS = ['/', '/etc', '/root', '/boot', '/sys', '/proc', '/dev', '/usr', '/bin', '/sbin', '/var', '/lib', '/lib64'];

const under = (p, base) => p === base || p.startsWith(base.replace(/\/+$/, '') + path.sep);

export function validateSource(srcRealpath, { projectsRoot, repoDir, allowRoot = '' } = {}) {
  if (!srcRealpath || typeof srcRealpath !== 'string' || !path.isAbsolute(srcRealpath)) {
    return { error: 'Source path must be an absolute path.' };
  }
  const p = srcRealpath.replace(/\/+$/, '') || '/';
  if (DENY_DIRS.some((d) => (d === '/' ? p === '/' : under(p, d)))) return { error: 'Refusing to adopt a system directory.' };
  if (repoDir && under(p, repoDir)) return { error: 'Cannot adopt the webtmux repo itself.' };
  if (projectsRoot && under(p, projectsRoot)) return { error: 'Source is already under the projects root.' };
  if (allowRoot && !under(p, allowRoot)) return { error: `Source must be inside ${allowRoot}.` };
  return { ok: true, path: p };
}

// --- SSH adopt helpers (remote source over an ~/.ssh/config Host alias) ----------
const SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Validate a remote source: host must be a known (allowlisted) alias, path non-empty.
export function validateSshTarget(host, hosts, remotePath) {
  if (!host || typeof host !== 'string' || !SSH_HOST_RE.test(host)) return { error: 'Invalid SSH host.' };
  if (!Array.isArray(hosts) || !hosts.includes(host)) return { error: 'Unknown SSH host (not in ~/.ssh/config).' };
  const p = typeof remotePath === 'string' ? remotePath.trim() : '';
  if (!p) return { error: 'Provide the remote path.' };
  if (/[;|&$`()<>\n\r\\]/.test(p)) return { error: 'Remote path contains unsupported characters.' };
  return { ok: true, host, path: p };
}

// Single-quote a string for the REMOTE shell (ssh joins the command into one string the
// remote shell re-parses). Wrap in '…' and escape embedded single quotes as '\'' .
export function shRemoteQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Parse `pwd` (line 1) + `ls -1Ap` (rest) output into the canonical path + subdir names.
export function parseSshLs(stdout) {
  const lines = String(stdout).split('\n');
  const p = (lines.shift() || '').trim();
  const dirs = [];
  for (const line of lines) {
    const name = line.replace(/\r$/, '');
    if (!name.endsWith('/')) continue;            // ls -p marks dirs with a trailing /
    const base = name.slice(0, -1);
    if (!base || base.startsWith('.') || base === 'node_modules') continue;
    dirs.push(base);
  }
  return { path: p, dirs };
}
