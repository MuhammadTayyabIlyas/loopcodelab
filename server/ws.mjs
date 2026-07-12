// server/ws.mjs — the WebSocket PTY bridges: the dashboard terminal (/ws,
// interactive) and the phone read-only pane (/rc/ws). Session names are
// validated/derived server-side; multitenant attaches run AS the tenant.
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import * as saasAuth from '../saas/auth.mjs';
import * as saasStore from '../saas/store.mjs';
import * as saasTenants from '../saas/tenants.mjs';
import { MULTITENANT, validName } from './config.mjs';
import { rcDeviceFromReq } from './rc.mjs';
import { ralphSessionName } from './ralph-engine.mjs';

export function attachWebSockets(server) {
  const wss = new WebSocketServer({ noServer: true });     // dashboard terminal (existing handler)
  const rcWss = new WebSocketServer({ noServer: true });   // phone read-only pane

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/ws') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    if (pathname === '/rc/ws') return rcWss.handleUpgrade(req, socket, head, (ws) => rcWss.emit('connection', ws, req));
    socket.destroy();
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const name = url.searchParams.get('s') || 'main';
    if (!validName(name)) {
      ws.close(1008, 'invalid session name');
      return;
    }

    // Multi-tenant: a tenant's build sessions live on THEIR tmux socket and are named
    // `<unix_user>-…`. The terminal must (a) authenticate the request via its session
    // cookie, (b) allow attaching ONLY to a session that carries the requester's own
    // unix-user prefix (no cross-tenant peeking), and (c) run tmux AS that tenant so it
    // hits the right socket. Single-tenant: unchanged (app user, app socket).
    let cmd = 'tmux';
    let cmdArgs = ['new-session', '-A', '-s', name];
    if (MULTITENANT) {
      const auth = saasAuth.currentAuth(req);
      const tctx = auth?.workspace ? saasTenants.tenantContext(auth.workspace) : null;
      if (!tctx) { ws.close(1008, 'auth required'); return; }
      const m = /^(wt_[a-z0-9]{1,28})-/.exec(name);
      if (!m || m[1] !== tctx.unix_user) { ws.close(1008, 'forbidden'); return; }
      const argv = saasTenants.tenantExecArgs(tctx, ['tmux', 'new-session', '-A', '-s', name]);
      cmd = argv[0];
      cmdArgs = argv.slice(1);
    }

    // `new-session -A -s NAME` attaches if it exists, otherwise creates it.
    // When this PTY dies the tmux client detaches, but the session lives on in
    // the tmux server — that persistence is what makes reconnect seamless.
    const term = pty.spawn(cmd, cmdArgs, {
      name: 'xterm-256color',
      cols: Number(url.searchParams.get('cols')) || 80,
      rows: Number(url.searchParams.get('rows')) || 24,
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' },
    });

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    term.onExit(() => {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'tmux exited');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed control frames
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
        try { term.resize(Math.floor(msg.cols), Math.floor(msg.rows)); } catch { /* terminal gone */ }
      } else if (msg.type === 'ping') {
        if (ws.readyState === ws.OPEN) ws.send('__pong__');
      }
    });

    ws.on('close', () => {
      try { term.kill(); } catch { /* already gone */ }
    });
  });

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
      const workspaceRow = device.tenant ? saasStore.getWorkspaceBySlug(device.tenant) : null;
      tctx = workspaceRow ? saasTenants.tenantContext(workspaceRow) : null;
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
}
