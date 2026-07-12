// server/preview.mjs — <project>.DOMAIN previews: static build output, the
// read-only file browser + zip download, live server-app processes on the
// 9000-9100 port range, and the Host-routing middleware in front of Express.
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import * as saasStore from '../saas/store.mjs';
import * as saasTenants from '../saas/tenants.mjs';
import {
  BASE_DOMAIN, DASHBOARD_HOST, MULTITENANT, PROJECTS_ROOT, WEB_ROOT_CANDIDATES,
  audit, validProject, within,
} from './config.mjs';
import { tmux } from './tmux.mjs';
import { runKey } from './ralph-engine.mjs';
// --- Project preview: serve each project at <project>.tayyabcheema.com -------
// If the project has static web output (or built output), serve it live; else
// show a click-to-download file browser. Public (no auth), read-only.
const PREVIEW_HIDE = new Set(['.git', '.worktrees', '.ralph', 'node_modules']);
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


// First servable static root inside a project (built output, then root index.html).
async function detectWebRoot(dir) {
  for (const cand of WEB_ROOT_CANDIDATES) {
    const p = path.join(dir, cand);
    if (await fs.stat(path.join(p, 'index.html')).then(() => true).catch(() => false)) return p;
  }
  if (await fs.stat(path.join(dir, 'index.html')).then(() => true).catch(() => false)) return dir;
  return null;
}

function previewPage(title, body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">`
    + `<title>${htmlEsc(title)}</title><style>`
    + `body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#0d1117;color:#e6edf3}`
    + `a{color:#2f81f7;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:20px}`
    + `.row{display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid #2a313c;border-radius:8px;margin:6px 0;background:#161b22}`
    + `.muted{color:#8b949e}.b{font-weight:600}</style>${body}`;
}

async function serveFileBrowser(res, project, dir, urlPath) {
  const abs = path.resolve(dir, '.' + (urlPath || '/'));
  if (!within(dir, abs)) return res.status(403).type('html').send(previewPage('Forbidden', '<h1>Forbidden</h1>'));
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return res.status(404).type('html').send(previewPage('Not found', '<h1>404 — not found</h1>'));
  if (st.isFile()) {
    if (res.req.query && 'download' in res.req.query) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
    }
    return res.sendFile(abs);
  }
  const entries = (await fs.readdir(abs, { withFileTypes: true }))
    .filter((e) => !PREVIEW_HIDE.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
  const base = (urlPath || '/').replace(/\/+$/, '');
  const up = base ? `<div class="row"><a href="${htmlEsc(path.posix.dirname(base) || '/')}">⬆ ..</a></div>` : '';
  const rows = entries.map((e) => {
    const href = htmlEsc((base + '/' + e.name).replace(/\/+/g, '/'));
    const dl = e.isDirectory() ? '' : ` <a class="muted" href="${href}?download">↓ download</a>`;
    return `<div class="row">${e.isDirectory() ? '📁' : '📄'} <a class="b" href="${href}${e.isDirectory() ? '/' : ''}">${htmlEsc(e.name)}</a>${dl}</div>`;
  }).join('');
  res.type('html').send(previewPage(`${project} — files`,
    `<h1>📦 ${htmlEsc(project)} <span class="muted">${htmlEsc(base || '/')}</span></h1>`
    + `<p><a class="b" href="/?zip">⬇ Download project as .zip</a></p>`
    + `<p class="muted">No live web app detected — browse and download the files.</p>${up}${rows || '<p class="muted">(empty)</p>'}`));
}

// Stream the whole project as a .zip (excludes git/agent/heavy dirs).
function streamZip(res, project, dir) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${project}.zip"`);
  const z = spawn('zip', ['-rq', '-', '.', '-x', '.git/*', '.worktrees/*', '.ralph/*', 'node_modules/*'], { cwd: dir });
  z.stdout.pipe(res);
  z.stderr.resume();
  z.on('error', () => { if (!res.headersSent) res.status(500).end('zip failed'); });
}

const readJsonFile = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } };

// Decide how to serve a project: explicit manifest (webtmux.json) wins, then a
// static web build, then a server-app heuristic (Node start script / Python app),
// else a file browser.
async function resolveServe(dir) {
  const manifest = await readJsonFile(path.join(dir, 'webtmux.json'));
  if (manifest?.type === 'server' && manifest.command) {
    return { mode: 'server', command: String(manifest.command), install: manifest.install ? String(manifest.install) : '' };
  }
  const webRoot = await detectWebRoot(dir);
  if (webRoot) return { mode: 'static', root: webRoot };
  const pkg = await readJsonFile(path.join(dir, 'package.json'));
  if (pkg?.scripts?.start) return { mode: 'server', command: 'npm start', install: 'npm install' };
  for (const f of ['app.py', 'main.py', 'server.py']) {
    if (await fs.stat(path.join(dir, f)).then(() => true).catch(() => false)) {
      const hasReq = await fs.stat(path.join(dir, 'requirements.txt')).then(() => true).catch(() => false);
      return { mode: 'server', command: `python3 ${f}`, install: hasReq ? 'pip3 install --user -r requirements.txt' : '' };
    }
  }
  return { mode: 'files' };
}

// --- Live server apps: run a project as a process and reverse-proxy it ---------
const apps = new Map(); // project -> { port, session, startedAt, lastAccess, command }
// Forget a project's app-process entry (its tmux session is killed by the caller).
export const dropAppProcess = (key) => apps.delete(key);
const APP_PORT_MIN = 9000, APP_PORT_MAX = 9100;
const APP_IDLE_MS = Number(process.env.WEBTMUX_APP_IDLE_MS || 15 * 60 * 1000);
// Multi-tenant: the preview app session is tenant-prefixed (so tmux() runs it on the
// tenant's socket, as the tenant) and the apps map is keyed per-tenant (runKey) so
// two tenants' same-named projects don't collide.
const appSessionName = (project, tenant) => {
  const base = ('app-' + project.replace(/[^A-Za-z0-9]/g, '')).slice(0, 32);
  return tenant ? `${tenant.unix_user}-${base}` : base;
};
const tmuxAlive = (s) => tmux(['has-session', '-t', s]).then(() => true).catch(() => false);

function probePort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.setTimeout(2000);
      s.once('connect', () => { s.destroy(); resolve(true); });
      const retry = () => { s.destroy(); if (Date.now() > deadline) reject(new Error(`app port ${port} never opened`)); else setTimeout(tryOnce, 600); };
      s.once('error', retry); s.once('timeout', retry);
    };
    tryOnce();
  });
}
function allocAppPort(existing) {
  if (existing) return existing;
  const used = new Set([...apps.values()].map((a) => a.port));
  for (let p = APP_PORT_MIN; p <= APP_PORT_MAX; p++) if (!used.has(p)) return p;
  return APP_PORT_MIN;
}
// Ensure the project's server process is up; returns the running app or throws
// (incl. a "still starting" signal the caller turns into a refresh page).
async function ensureAppRunning(project, dir, serve, tenant = null) {
  const key = runKey(project, tenant);
  let app = apps.get(key);
  const session = appSessionName(project, tenant);
  if (app && await tmuxAlive(session)) {
    app.lastAccess = Date.now();
    if (await probePort(app.port, 1500).then(() => true).catch(() => false)) return app;
    throw new Error('starting'); // session alive but not listening yet (e.g. installing)
  }
  const port = allocAppPort(app?.port);
  // The session name carries the tenant prefix, so tmux() runs new-session/send-keys
  // on the tenant's socket → the app process runs AS the tenant, serving its own code.
  try { await tmux(['kill-session', '-t', session]); } catch { /* none */ }
  await tmux(['new-session', '-d', '-s', session, '-c', dir]);
  const cmd = `${serve.install ? serve.install + ' ; ' : ''}PORT=${port} ${serve.command}`;
  await tmux(['send-keys', '-t', session, cmd, 'Enter']);
  app = { port, session, startedAt: Date.now(), lastAccess: Date.now(), command: serve.command };
  apps.set(key, app);
  audit({ ralphApp: key, port, session, command: serve.command });
  await probePort(port, 30_000); // first boot (may include install); throws if too slow
  return app;
}
function proxyToApp(req, res, port) {
  const up = http.request(
    { host: '127.0.0.1', port, method: req.method, path: req.originalUrl || req.url, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (pr) => { res.writeHead(pr.statusCode || 502, pr.headers); pr.pipe(res); },
  );
  up.on('error', () => { if (!res.headersSent) res.status(502).type('html').send(previewPage('Error', '<h1>App not responding</h1>')); });
  req.pipe(up);
}

export async function servePreview(req, res, project, tenant = null) {
  if (!validProject(project)) return res.status(404).type('html').send(previewPage('Not found', '<h1>Unknown project</h1>'));
  // Multi-tenant: serve the build from the tenant's own home (read via ACL; server
  // apps run as the tenant). Single-tenant: PROJECTS_ROOT, unchanged.
  const root = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
  const dir = path.join(root, project);
  if (!(await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false))) {
    return res.status(404).type('html').send(previewPage('Not found', `<h1>No project named "${htmlEsc(project)}"</h1>`));
  }
  if (req.query && 'zip' in req.query) return streamZip(res, project, dir);
  let urlPath = '/'; try { urlPath = decodeURIComponent(req.path || '/'); } catch { /* keep / */ }

  const serve = await resolveServe(dir);
  if (serve.mode === 'server') {
    try {
      const appProc = await ensureAppRunning(project, dir, serve, tenant);
      return proxyToApp(req, res, appProc.port);
    } catch (err) {
      const starting = err.message === 'starting';
      return res.status(starting ? 503 : 502).type('html').send(previewPage(
        starting ? 'Starting…' : 'Not running',
        `<h1>${htmlEsc(project)} is ${starting ? 'starting…' : 'not responding'}</h1>`
        + `<p class="muted">${starting ? 'Building/booting the app. This page auto-refreshes.' : htmlEsc(err.message)}</p>`
        + (starting ? '<meta http-equiv="refresh" content="4">' : ''),
      ));
    }
  }
  if (serve.mode === 'static') {
    const abs = path.resolve(serve.root, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
    if (!within(serve.root, abs)) return res.status(403).end();
    const st = await fs.stat(abs).catch(() => null);
    if (st && st.isFile()) return res.sendFile(abs);
    if (st && st.isDirectory() && await fs.stat(path.join(abs, 'index.html')).then(() => true).catch(() => false)) {
      return res.sendFile(path.join(abs, 'index.html'));
    }
    return res.sendFile(path.join(serve.root, 'index.html')); // SPA fallback
  }
  return serveFileBrowser(res, project, dir, urlPath);
}

// Route project subdomains to the preview server BEFORE body parsing — so server
// apps get the raw request stream proxied untouched. Anything that isn't the
// dashboard host but is *.BASE_DOMAIN with a single label is a project preview.
// Multi-tenant labels are `<project>--<slug>` (split on the LAST `--`); we resolve
// the slug to its workspace and serve from that tenant's home. A plain `<project>`
// label (no `--`) is a single-tenant/owner preview from PROJECTS_ROOT.
export const previewHostMiddleware = (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase().split(':')[0];
  if (host && host !== DASHBOARD_HOST && host.endsWith('.' + BASE_DOMAIN)) {
    const label = host.slice(0, host.length - BASE_DOMAIN.length - 1);
    if (label && !label.includes('.')) {
      let project = label, tenant = null;
      if (MULTITENANT && label.includes('--')) {
        const parsed = saasTenants.parsePreviewLabel(label); // { project, slug }
        const ws = parsed && saasStore.getWorkspaceBySlug(parsed.slug);
        if (!ws) return res.status(404).type('html').send(previewPage('Not found', '<h1>Unknown preview</h1>'));
        tenant = saasTenants.tenantContext(ws);
        project = parsed.project;
      }
      return servePreview(req, res, project, tenant).catch(() => res.status(500).type('html').send(previewPage('Error', '<h1>Preview error</h1>')));
    }
  }
  next();
};

// Idle-stop live app processes to free resources.
setInterval(() => {
  const now = Date.now();
  for (const [proj, a] of apps) {
    if (now - a.lastAccess > APP_IDLE_MS) {
      tmux(['kill-session', '-t', a.session]).catch(() => {});
      apps.delete(proj);
    }
  }
}, 60_000);
