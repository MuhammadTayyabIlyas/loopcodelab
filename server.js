// webtmux — session dashboard + xterm.js terminal over a tmux PTY bridge.
// Listens only on localhost; TLS + basic-auth are terminated by nginx in front.
//
// This file is the ENTRY POINT and assembly only: middleware/route registration
// ORDER here is load-bearing (preview host routing and the raw-body Stripe
// webhook must precede express.json; the saas auth gate must precede the API
// routes; /rc must precede express.static). The logic lives in server/*.mjs.
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { pairTokenValid, makeDevice } from './ralph/rc-auth.mjs';
import { REPO_ROOT, HOST, PORT, audit } from './server/config.mjs';
import {
  initSecrets, loadSoloModels, openaiKey, openaiModel, qwenKey, qwenModel,
} from './server/secrets.mjs';
import { loadRcDevices, saveRcDevices, rcPairTokens, rcDeviceFromReq, getRcDevices } from './server/rc.mjs';
import { initPush, pushReady } from './server/push.mjs';
import { initRalphRuns, ralphTick } from './server/ralph-engine.mjs';
import { applySudoRule } from './server/sudo.mjs';
import { monitorTick } from './server/monitor.mjs';
import { previewHostMiddleware } from './server/preview.mjs';
import { registerBillingWebhook, registerSaasRoutes } from './server/routes/saas.mjs';
import { registerCoreRoutes } from './server/routes/core.mjs';
import { registerRalphRoutes } from './server/routes/ralph.mjs';
import { registerRcRoutes } from './server/routes/rc.mjs';
import { attachWebSockets } from './server/ws.mjs';

const app = express();
app.disable('x-powered-by');

app.use(previewHostMiddleware); // project-subdomain previews (before body parsing)

registerBillingWebhook(app); // raw-body Stripe webhook — must precede express.json

app.use(express.json({ limit: '256kb' }));

// --- Static assets (PWA shell + vendored xterm) -----------------------------
// The modern product UI (React/Vite build) is now the front door at `/`; its assets
// live under /app/assets (Vite base '/app/'), served by the /app static mount below.
// The original tmux-session dashboard stays fully available at `/legacy`. Registered
// BEFORE express.static(public) so `/` resolves to the React app, not public/index.html.
const REACT_INDEX = path.join(REPO_ROOT, 'web', 'dist', 'index.html');
app.get('/', (_req, res) => res.sendFile(REACT_INDEX));
app.get('/legacy', (_req, res) => res.sendFile(path.join(REPO_ROOT, 'public', 'index.html')));
// Register /rc BEFORE express.static so the pairing route isn't masked by public/rc.html
// (express.static with extensions:['html'] would serve rc.html for the path /rc otherwise).
app.get('/rc', async (req, res) => {
  const t = String(req.query.t || '');
  const rec = t ? rcPairTokens.get(t) : null;
  if (t) {
    if (!pairTokenValid(rec)) {
      return res.status(410).type('html').send('<h2>QR expired</h2><p>Generate a new one in the dashboard.</p>');
    }
    rec.used = true; rcPairTokens.delete(t);
    const tenantSlug = rec.tenant ?? null;
    const { token, record } = makeDevice({ label: req.headers['user-agent'] || 'device', tenant: tenantSlug });
    getRcDevices().push(record); await saveRcDevices();
    audit({ rcDevice: 'paired', id: record.id, tenant: tenantSlug });
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      `rc_dev=${encodeURIComponent(token)}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/rc; Max-Age=${60 * 60 * 24 * 365}`);
    return res.redirect(302, '/rc/');
  }
  if (rcDeviceFromReq(req)) return res.redirect(302, '/rc/');
  res.status(401).type('html').send('<h2>Not paired</h2><p>Open the dashboard, tap "📱 Remote control", and scan the QR.</p>');
});
app.use(express.static(path.join(REPO_ROOT, 'public'), { extensions: ['html'], index: false }));

// React build assets + SPA fallback (also reachable at /app for back-compat).
app.use('/app', express.static(path.join(REPO_ROOT, 'web', 'dist')));
app.get('/app/*', (_req, res) => res.sendFile(REACT_INDEX));

// --- API routes ---------------------------------------------------------------
// saas first: its auth gate must cover everything under /api. Within the ralph
// module, fixed paths (prefs/drafts/…) register before /api/ralph/:project.
registerSaasRoutes(app); // auth + /api gate + vault + admin (inert single-tenant)
registerCoreRoutes(app); // sessions, projects, push, rc pairing, audit
registerRalphRoutes(app);
registerRcRoutes(app);   // phone remote control under /rc/

// --- HTTP + WebSocket PTY bridge -------------------------------------------
const server = http.createServer(app);
attachWebSockets(server);

await initSecrets().catch((err) => console.error('secrets init failed:', err.message));
await loadSoloModels();
await loadRcDevices();
await applySudoRule(false).catch(() => {}); // known-safe start: sudo off until a human enables it
await initRalphRuns().catch((err) => console.error('ralph resume failed:', err.message));
await initPush().catch((err) => console.error('push init failed:', err.message));
setInterval(() => { monitorTick().catch(() => {}); }, 5000);
setInterval(() => { ralphTick().catch(() => {}); }, 4000); // Ralph orchestrator

server.listen(PORT, HOST, () => {
  const ralph = (qwenKey() || openaiKey()) ? 'ready' : 'no-key';
  const planner = qwenKey() ? qwenModel() : (openaiKey() ? openaiModel() : 'none');
  console.log(`webtmux listening on http://${HOST}:${PORT} (push ${pushReady() ? 'ready' : 'off'}, ralph ${ralph}, planner ${planner})`);
});
