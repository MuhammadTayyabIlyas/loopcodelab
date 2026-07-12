// server/routes/core.mjs — the single-tenant heart of the dashboard API:
// health/status, tmux session CRUD + sudo toggle + the admin maintenance
// shell, project listing/context, SSH hosts, push subscriptions, RC device
// pairing, and the audit feed.
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makePairToken } from '../../ralph/rc-auth.mjs';
import {
  AUDIT_FILE, HOME, MULTITENANT, PROJECTS_ROOT, REPO_ROOT, audit, isAdminEmail,
  validName, validProject,
} from '../config.mjs';
import { openaiKey, openaiModel, qwenKey, qwenModel } from '../secrets.mjs';
import { tmux, listSessions, projectFromCwd, paneTail, statsForSessions } from '../tmux.mjs';
import { isGitRepo, gitInitProject } from '../git.mjs';
import {
  listProjects, resolveProjectDir, listSshHosts, CONTEXT_FILE, scaffoldContext,
} from '../projects.mjs';
import { mcpServersFor, writeMcpConfig } from '../skills.mjs';
import { resolveLaunch } from '../agents.mjs';
import { rcPairTokens, saveRcDevices, getRcDevices, setRcDevices } from '../rc.mjs';
import {
  sendPush, pushReady, vapidPublicKey, subscriptionCount, addSubscription, removeSubscriptions,
} from '../push.mjs';
import { sudoSessions, reconcileSudo } from '../sudo.mjs';
import { tenantOf } from '../ralph-engine.mjs';

export function registerCoreRoutes(app) {
  // --- Session REST API -------------------------------------------------------
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));

  app.get('/api/sessions', async (req, res) => {
    const tenant = tenantOf(req); // multi-tenant: list this tenant's own tmux sessions
    try {
      const sessions = await listSessions(tenant);
      const root = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
      for (const s of sessions) s.project = projectFromCwd(s.cwd, root);
      if (req.query.preview) {
        await Promise.all(sessions.map(async (s) => { s.preview = await paneTail(s.name); }));
      }
      if (req.query.stats) {
        const stats = await statsForSessions(sessions.map((s) => s.name));
        for (const s of sessions) s.stats = stats[s.name] || null;
      }
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err.stderr?.trim() || err.message });
    }
  });

  // Lightweight health: is the app up, is the tmux server reachable, is push set up.
  app.get('/api/status', async (_req, res) => {
    let tmuxOk = true;
    try {
      await tmux(['list-sessions']);
    } catch (err) {
      // "no server running" just means zero sessions — tmux itself is fine.
      tmuxOk = /no server running|no current session/i.test(err.stderr || err.message);
    }
    res.json({
      ok: true, tmuxOk, push: pushReady(), subscribed: subscriptionCount(),
      planner: qwenKey() ? qwenModel() : (openaiKey() ? openaiModel() : 'none'),
    });
  });

  // SSH connect targets (Host aliases from ~/.ssh/config).
  app.get('/api/ssh-hosts', async (_req, res) => {
    try {
      res.json({ hosts: await listSshHosts() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List / create project directories under the projects root.
  // ?detail=1 adds live-session counts so the UI can show projects with no
  // running session (the "come back to an old project" view).
  app.get('/api/projects', async (req, res) => {
    try {
      const projects = await listProjects();
      if (!req.query.detail) return res.json({ root: PROJECTS_ROOT, projects });
      const byProject = {};
      for (const s of await listSessions()) {
        const p = projectFromCwd(s.cwd);
        if (!p) continue;
        const cur = byProject[p] || { sessions: 0, lastActivity: 0 };
        cur.sessions += 1;
        cur.lastActivity = Math.max(cur.lastActivity, s.activity || 0);
        byProject[p] = cur;
      }
      const detail = projects.map((name) => ({
        name,
        sessions: byProject[name]?.sessions || 0,
        lastActivity: byProject[name]?.lastActivity || null,
      }));
      res.json({ root: PROJECTS_ROOT, projects, detail });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read / write a project's shared AGENTS.md (the file every provider symlinks to).
  app.get('/api/projects/:name/context', async (req, res) => {
    const dir = await resolveProjectDir(req.params.name);
    if (!dir) return res.status(404).json({ error: 'Unknown project.' });
    try {
      const content = await fs.readFile(path.join(dir, CONTEXT_FILE), 'utf8')
        .catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
      res.json({ name: req.params.name, file: CONTEXT_FILE, content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:name/context', async (req, res) => {
    const dir = await resolveProjectDir(req.params.name);
    if (!dir) return res.status(404).json({ error: 'Unknown project.' });
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required.' });
    if (content.length > 200_000) return res.status(413).json({ error: 'Context file too large (200 KB max).' });
    try {
      await fs.writeFile(path.join(dir, CONTEXT_FILE), content, 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects', async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!validProject(name)) return res.status(400).json({ error: 'Invalid project name. Letters, numbers, . _ - (max 64).' });
    const dir = path.join(PROJECTS_ROOT, name);
    if (path.dirname(dir) !== PROJECTS_ROOT) return res.status(400).json({ error: 'Invalid project name.' });
    try {
      // Re-using an existing project is a feature, not a conflict: just make sure
      // the dir and its shared context file exist, and report whether it was new.
      const existed = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false);
      await fs.mkdir(dir, { recursive: true });
      await scaffoldContext(dir, name);
      // Every project is a git repo (per-PRD commits + GitHub auto-push). Best
      // effort: a normal shell project shouldn't fail to create on a git hiccup.
      let gitReady = false;
      try { await gitInitProject(dir); gitReady = await isGitRepo(dir); }
      catch (err) { console.error(`git init for ${name} failed:`, err.message); }
      res.status(existed ? 200 : 201).json({ name, existed, git: gitReady });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sessions/:name/sudo', (req, res) => {
    const name = req.params.name;
    if (!validName(name)) return res.status(400).json({ error: 'Invalid session name.' });
    res.json({ session: name, enabled: sudoSessions.has(name), active: sudoSessions.size > 0 });
  });
  app.post('/api/sessions/:name/sudo', async (req, res) => {
    const name = req.params.name;
    if (!validName(name)) return res.status(400).json({ error: 'Invalid session name.' });
    const enabled = req.body?.enabled === true;
    const had = sudoSessions.has(name);
    try {
      if (enabled) sudoSessions.add(name); else sudoSessions.delete(name);
      await reconcileSudo();
      res.json({ session: name, enabled, active: sudoSessions.size > 0 });
    } catch (err) {
      if (had) sudoSessions.add(name); else sudoSessions.delete(name); // roll back intent
      res.status(500).json({ error: `sudo toggle failed: ${err.stderr?.trim() || err.message}` });
    }
  });

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
      await tmux(['new-session', '-d', '-s', MAINT_SESSION, '-c', REPO_ROOT, 'exec sudo -s']);
    }
    audit({ maintShell: 'open', by: req.auth?.user?.email || null });
    res.json({ session: MAINT_SESSION });
  });

  app.post('/api/sessions', async (req, res) => {
    const name = (req.body?.name || '').trim();
    const tool = (req.body?.tool || '').trim();
    const mode = (req.body?.mode || 'safe').trim();
    const project = (req.body?.project || '').trim();
    const resume = req.body?.resume === true;
    const sshHost = (req.body?.ssh || '').trim();
    const mcpServers = Array.isArray(req.body?.mcpServers) ? req.body.mcpServers : [];
    if (!validName(name)) return res.status(400).json({ error: 'Invalid name. Use letters, numbers, _ or - (max 32).' });
    // An SSH connect wins over the tool launcher: the command is `ssh <host>`,
    // with the host validated against the ~/.ssh/config allowlist.
    let command;
    if (sshHost) {
      if (!(await listSshHosts()).includes(sshHost)) return res.status(400).json({ error: 'Unknown SSH host.' });
      command = `ssh ${sshHost}`;
    } else {
      command = resolveLaunch(tool, mode, resume);
      if (command === null) return res.status(400).json({ error: 'Unknown launch tool or mode.' });
    }
    const startDir = await resolveProjectDir(project);
    if (startDir === null) return res.status(400).json({ error: 'Unknown project.' });
    try {
      // Start the session in the project directory so the shell and any launched
      // AI tool both run there.
      await tmux(['new-session', '-d', '-s', name, '-c', startDir]);
      // Write MCP config if servers were selected
      if (mcpServers.length && tool) {
        try { await writeMcpConfig(startDir, tool, mcpServersFor(null)); } catch { /* best effort */ }
      }
      // Run the launcher command in the fresh session (argv form; the command is
      // a fixed server-side string, never user input).
      if (command) await tmux(['send-keys', '-t', name, command, 'Enter']);
      audit({ session: name, project: project || null, tool: tool || null, mode: tool ? mode : null, resume: tool ? resume : false, bypass: mode === 'bypass', ssh: sshHost || null, command: command || '(shell)', mcpServers: mcpServers.length });
      // Fire-and-forget: create a Google Sheet workspace for this session
      const _drivePayload = JSON.stringify({ session: name, project: project || null });
      const _driveReq = http.request({ host: '127.0.0.1', port: 8095, path: '/api/session-workspace', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_drivePayload) } }, (r) => { r.resume(); });
      _driveReq.on('error', () => {}); // never block session on drive failure
      _driveReq.end(_drivePayload);
      res.status(201).json({ name, tool: tool || null, mode: tool ? mode : null, project: project || null, resume: tool ? resume : null, ssh: sshHost || null, mcpServers: mcpServers.length });
    } catch (err) {
      const msg = err.stderr?.trim() || err.message;
      if (/duplicate session/i.test(msg)) return res.status(409).json({ error: 'A session with that name already exists.' });
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/sessions/:name/rename', async (req, res) => {
    const from = req.params.name;
    const to = (req.body?.name || '').trim();
    if (!validName(from) || !validName(to)) return res.status(400).json({ error: 'Invalid session name.' });
    try {
      await tmux(['rename-session', '-t', from, to]);
      res.json({ name: to });
    } catch (err) {
      res.status(500).json({ error: err.stderr?.trim() || err.message });
    }
  });

  app.delete('/api/sessions/:name', async (req, res) => {
    const name = req.params.name;
    if (!validName(name)) return res.status(400).json({ error: 'Invalid session name.' });
    try {
      await tmux(['kill-session', '-t', name]);
      if (sudoSessions.delete(name)) await reconcileSudo().catch(() => {}); // drop sudo with the session
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.stderr?.trim() || err.message });
    }
  });

  // Duplicate: a fresh session starting in the source session's current directory.
  app.post('/api/sessions/:name/duplicate', async (req, res) => {
    const from = req.params.name;
    const to = (req.body?.name || '').trim();
    if (!validName(from) || !validName(to)) return res.status(400).json({ error: 'Invalid session name.' });
    try {
      const { stdout } = await tmux(['display-message', '-p', '-t', from, '#{pane_current_path}']);
      const cwd = stdout.trim() || HOME;
      await tmux(['new-session', '-d', '-s', to, '-c', cwd]);
      res.status(201).json({ name: to });
    } catch (err) {
      const msg = err.stderr?.trim() || err.message;
      if (/duplicate session/i.test(msg)) return res.status(409).json({ error: 'A session with that name already exists.' });
      res.status(500).json({ error: msg });
    }
  });

  // Open a new window in the session, in the same directory as its current pane.
  app.post('/api/sessions/:name/window', async (req, res) => {
    const name = req.params.name;
    if (!validName(name)) return res.status(400).json({ error: 'Invalid session name.' });
    try {
      const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_current_path}']);
      const cwd = stdout.trim() || HOME;
      await tmux(['new-window', '-t', name, '-c', cwd]);
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.stderr?.trim() || err.message });
    }
  });

  // Detach every client currently attached to the session (no-op if none).
  app.post('/api/sessions/:name/detach', async (req, res) => {
    const name = req.params.name;
    if (!validName(name)) return res.status(400).json({ error: 'Invalid session name.' });
    try {
      await tmux(['detach-client', '-s', name]);
      res.json({ ok: true });
    } catch (err) {
      const msg = err.stderr?.trim() || err.message;
      if (/no current client|no clients|no such client/i.test(msg)) return res.json({ ok: true, detached: 0 });
      res.status(500).json({ error: msg });
    }
  });

  // --- Push subscription + audit endpoints ------------------------------------
  app.get('/api/push/key', (_req, res) => res.json({ key: vapidPublicKey() }));

  app.post('/api/push/subscribe', async (req, res) => {
    const sub = req.body?.subscription;
    if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });
    await addSubscription(sub);
    res.status(201).json({ ok: true });
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    const endpoint = req.body?.endpoint;
    await removeSubscriptions((s) => s.endpoint === endpoint);
    res.json({ ok: true });
  });

  app.post('/api/push/test', async (_req, res) => {
    await sendPush({ title: 'webtmux', body: 'Notifications are working ✓', tag: 'test', url: '/' });
    res.json({ ok: true, sent: subscriptionCount() });
  });

  // Dashboard mints a one-time pairing token; the client renders it as a QR of /rc?t=…
  app.post('/api/rc/pair-token', (req, res) => {
    const rec = makePairToken();
    rec.tenant = MULTITENANT ? (req.tenant?.slug || null) : null;
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
    res.json({ devices: getRcDevices()
      .filter((d) => !MULTITENANT || d.tenant === (req.tenant?.slug || null))
      .map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastSeen: d.lastSeen })) }));

  app.delete('/api/rc/devices/:id', async (req, res) => {
    const me = MULTITENANT ? (req.tenant?.slug || null) : null;
    const dev = getRcDevices().find((d) => d.id === req.params.id && (!MULTITENANT || d.tenant === me));
    if (dev) {
      setRcDevices(getRcDevices().filter((d) => d !== dev));
      await saveRcDevices(); await removeSubscriptions((s) => s.deviceId === dev.id);
      audit({ rcDevice: 'revoked', id: dev.id });
    }
    res.json({ ok: true });
  });

  app.get('/api/audit', async (_req, res) => {
    try {
      const txt = await fs.readFile(AUDIT_FILE, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
      const entries = txt.split('\n').filter(Boolean).slice(-200)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).reverse();
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
