// server/routes/saas.mjs — multi-tenant control-plane routes, active only when
// WEBTMUX_MULTITENANT=1: auth + the /api gate, the BYO-key vault, CLI logins,
// billing, and the admin dashboard API. Single-tenant deployments register
// nothing here beyond the inert (flag-gated) webhook.
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import * as saasAuth from '../../saas/auth.mjs';
import * as saasStore from '../../saas/store.mjs';
import * as saasPlans from '../../saas/plans.mjs';
import * as saasVault from '../../saas/vault.mjs';
import * as saasTenants from '../../saas/tenants.mjs';
import * as saasBilling from '../../saas/billing.mjs';
import { sanitizeModels, validModelId } from '../../ralph/solo-models.mjs';
import { LIVE_USAGE, resolveUsageProvider } from '../../ralph/provider-usage.mjs';
import { buildKeyProbe, buildPlanProbe, interpretProbe } from '../../ralph/key-test.mjs';
import { planModelsMap, mediaCredentialIds, normalizeMedia, mediaModelChoices } from '../../ralph/providers.mjs';
import { platformKeyEntries, platformSecretFor } from '../../ralph/platform-keys.mjs';
import { ADMIN_EMAILS, MULTITENANT, audit, execFileAsync, isAdminEmail } from '../config.mjs';
import {
  arkBaseUrl, qwenBaseUrl, platformKeyValues, GLM_BASE_URL, soloModelsEffective,
  setSoloModels, setMediaCaps,
} from '../secrets.mjs';
import { tmux } from '../tmux.mjs';
import {
  CLAUDE_PLAN_PRESETS, DEFAULT_AGENT, claudePlanOf, loginExistsTest, sandboxLogins,
} from '../agents.mjs';
import { RALPH_STATE_DIR, ralphRuns, clampInt, tenantOf } from '../ralph-engine.mjs';
import { runSessionJanitorNow } from '../monitor.mjs';

// Stripe needs the raw request body for signature verification, so the caller
// registers this BEFORE express.json.
export function registerBillingWebhook(app) {
  // Stripe webhook needs the RAW body for signature verification, so it is registered
  // BEFORE express.json (which would consume + reparse it). Public (Stripe calls it),
  // flag-gated, and inert unless STRIPE_* env is set.
  if (process.env.WEBTMUX_MULTITENANT === '1') {
    app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
      if (!saasBilling.billingReady()) return res.status(503).json({ error: 'Billing not configured.' });
      try {
        const result = await saasBilling.handleWebhook(req.body, req.headers['stripe-signature']);
        res.json(result);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  }
}

export function registerSaasRoutes(app) {
  // When WEBTMUX_MULTITENANT=1, mount account routes and require a logged-in session
  // for every /api/* call except /api/auth/*. Default OFF keeps the existing
  // single-tenant + nginx-basic-auth behaviour byte-for-byte unchanged. Registered
  // here (before the /api routes) so the gate covers them; /healthz stays public.
  if (MULTITENANT) {
    const fail = (res, code, msg) => res.status(code).json({ error: msg });
    // Public auth routes — registered BEFORE the gate.
    app.post('/api/auth/signup', async (req, res) => {
      try {
        const { user, workspace } = saasAuth.signup({
          email: req.body?.email, password: req.body?.password,
          inviteCode: req.body?.invite, name: req.body?.name,
        });
        // Provision the tenant's OS sandbox (best-effort: if the root helper isn't
        // installed yet the account still works for login; the orchestrator
        // ensures provisioning before a run starts — Stage 3b).
        try { await saasTenants.provisionTenant(workspace, { setUnixUser: saasStore.setWorkspaceUnixUser }); }
        catch (e) { console.warn(`[saas] provisionTenant(${workspace.slug}) failed: ${e.message}`); }
        saasAuth.issueSession(req, res, user.id);
        res.json({ ok: true, email: user.email, workspace: workspace.slug });
      } catch (e) { fail(res, 400, e.message); }
    });
    app.post('/api/auth/login', (req, res) => {
      const user = saasAuth.login({ email: req.body?.email, password: req.body?.password });
      if (!user) return fail(res, 401, 'Invalid email or password.');
      saasAuth.issueSession(req, res, user.id);
      res.json({ ok: true, email: user.email });
    });
    app.post('/api/auth/logout', (req, res) => { saasAuth.clearSession(req, res); res.json({ ok: true }); });
    app.get('/api/auth/me', (req, res) => {
      const a = saasAuth.currentAuth(req);
      if (!a) return fail(res, 401, 'Not signed in.');
      res.json({ email: a.user.email, workspace: a.workspace?.slug || null, plan: saasPlans.planFor(a.workspace?.id).key, isAdmin: isAdminEmail(a.user.email) });
    });

    // Gate: everything else under /api requires a session (req.path is mount-relative).
    app.use('/api', (req, res, next) => {
      if (req.path.startsWith('/auth')) return next();
      return saasAuth.requireAuth(req, res, next);
    });

    // BYO-credential vault management (gated; secrets are write-only — list shows
    // last4 only). Three credential shapes share the store: raw API keys, OAuth
    // sign-ins (token or the CLI's login-file JSON), and claude-plan (JSON config
    // for an Anthropic-compatible coding-plan endpoint — validated here).
    const VAULT_PROVIDERS = new Set([
      'anthropic', 'openai', 'gemini', 'qwen', 'glm', 'kimi', 'grok', 'vibe', 'github',
      'claude-oauth', 'codex-oauth', 'gemini-oauth', 'qwen-oauth', 'kimi-oauth', 'grok-oauth', 'claude-plan',
      // Mobile-app / backend credentials for flutter-app builds (tenant supplies own;
      // empty by default). firebase = google-services.json; google-play = Play Console
      // service-account JSON (store submission); codemagic = API token (iOS, later).
      // flutter-signing is orchestrator-managed (never set via this route).
      'firebase', 'google-play', 'codemagic',
      // Windows Store credentials (web-app builds). windows-store = Partner Center identity
      // JSON {identityName, publisher, publisherDisplayName}; windows-signing = OPTIONAL
      // installer code-signing cert JSON {pfxBase64, password} (wired as Actions secrets,
      // never committed — Store packages don't need it, the Store re-signs).
      'windows-store', 'windows-signing',
      // Research & data: perplexity = Sonar web-grounded planning; apify = actor
      // marketplace token (real datasets; worker helpers land in a later phase).
      'perplexity', 'apify',
      // Media-generation credentials (image reuses the qwen/token-plan key; these are the paid extras).
      ...mediaCredentialIds(), // ark (video), suno (music), elevenlabs (voiceover)
    ]);
    app.get('/api/keys', async (req, res) => {
      const keys = saasStore.listProviderKeys(req.tenant.id);
      // Surface the NON-secret coding-plan preset + model id (never the key) so the UI
      // can show the model that will actually run (e.g. a chosen OpenRouter model).
      const plan = keys.find((k) => k.provider === 'claude-plan');
      if (plan) {
        try {
          const j = JSON.parse(saasStore.getProviderKey(req.tenant.id, 'claude-plan') || '{}');
          plan.preset = j.preset || null;
          plan.model = j.model || null;
        } catch { /* leave undecorated */ }
      }
      // Admin: surface platform-supplied (secrets.json) keys as "connected · platform" so the
      // deployment owner's Settings reflects the fallback builds actually use (BYO tenants: none).
      const platformKeys = platformKeyEntries(platformKeyValues(), keys.map((k) => k.provider), isAdminEmail(req.auth?.user?.email));
      res.json({
        keys: [...keys, ...platformKeys],
        defaultAgent: DEFAULT_AGENT, // deployment default for seeding the New Build pickers
        planPresets: Object.entries(CLAUDE_PLAN_PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model })),
        planModels: planModelsMap(), // curated per-preset model lists for the New Build dropdown
        mediaModels: mediaModelChoices(), // per-kind media model pickers (spec §6b)
        // Agents already signed in INSIDE the sandbox (terminal sign-in) — as good as a key.
        cliLogins: [...await sandboxLogins(saasTenants.tenantContext(req.tenant))],
      });
    });
    // Interactive CLI sign-in inside the user's own sandbox: spawn a login session
    // on the tenant's tmux socket; the dashboard terminal attaches to it (the /ws
    // gate already restricts attachment to the tenant's own wt_<user>- prefix) and
    // the OAuth credential file lands in the tenant's $HOME — nothing is pasted.
    // codex uses --device-auth (plain `codex login` redirects to localhost:1455 on
    // the USER'S machine, unreachable from here; device-auth shows a URL + code).
    const CLI_LOGIN_CMDS = {
      claude: 'claude setup-token',
      codex: 'codex login --device-auth',
      qwen: 'qwen',
      gemini: 'NO_BROWSER=true gemini',
      kimi: 'kimi login',
      grok: 'grok login --device-auth',
      // Firebase (flutter-app backends): headless device/code flow — prints a URL + asks
      // for the auth code. Builds then run `flutterfire configure` against the signed-in account.
      firebase: 'firebase login --no-localhost',
    };
    app.post('/api/cli-login/:agent', async (req, res) => {
      const agent = req.params.agent;
      const cmd = CLI_LOGIN_CMDS[agent];
      if (!cmd) return fail(res, 400, 'No terminal sign-in for that agent — use an API key instead.');
      const t = tenantOf(req);
      if (!t) return fail(res, 400, 'Terminal sign-in is only available in multi-tenant mode.');
      const session = `${t.unix_user}-login-${agent}`;
      try { await tmux(['kill-session', '-t', session]); } catch { /* none */ }
      // The success banner is gated on the credential FILE existing — a Ctrl-C'd or
      // failed login must not claim success (the device flow only completes while
      // the CLI keeps running and polling, which trips users up).
      const credTest = loginExistsTest(agent); // matches any of the agent's credential filenames
      const sh = 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; cd "$HOME"; '
        + `echo "── Sign in to ${agent}: follow the instructions, and KEEP THIS TAB OPEN until it confirms. ──"; `
        + `${cmd}; echo; `
        + `if ${credTest}; then echo "✅ Signed in — you can close this tab and return to Settings."; `
        + `else echo "❌ Sign-in did not complete. Go back to Settings and click the sign-in button to try again (do not press Ctrl+C while it waits)."; fi; exec bash`;
      await tmux(['new-session', '-d', '-s', session, sh]);
      audit({ user: req.auth?.user?.email, cliLogin: agent, session });
      res.json({ session });
    });
    app.put('/api/keys/:provider', (req, res) => {
      const provider = req.params.provider;
      if (!VAULT_PROVIDERS.has(provider)) return fail(res, 400, 'Unknown provider.');
      const v = String(req.body?.key || '').trim();
      if (!v) return fail(res, 400, 'Key required.');
      if (!saasVault.vaultReady()) return fail(res, 500, 'Server vault not configured (set WEBTMUX_VAULT_KEY).');
      if (provider === 'claude-plan') {
        let p; try { p = JSON.parse(v); } catch { return fail(res, 400, 'Coding plan must be a JSON object.'); }
        // tokenplan reuses the stored qwen key, byteplus the stored glm/ark (ARK) key —
        // a blank key is valid for those presets (resolved server-side in claudePlanOf).
        if (!p?.key && !['tokenplan', 'byteplus'].includes(p?.preset)) return fail(res, 400, 'Coding plan needs the provider API key.');
        const preset = CLAUDE_PLAN_PRESETS[p.preset];
        if (!preset) return fail(res, 400, 'Unknown coding-plan preset.');
        if (!preset.baseUrl && !/^https:\/\//.test(p.baseUrl || '')) return fail(res, 400, 'Custom plan needs an https base URL.');
        // The model id is spliced into ANTHROPIC_MODEL — reject anything that isn't a
        // model id (this is what let an email get saved as the model before).
        if (p.model && !validModelId(String(p.model).trim())) return fail(res, 400, 'Invalid model id (letters, digits and . _ : / - only). Leave blank for the plan default.');
      }
      if (['codex-oauth', 'gemini-oauth', 'qwen-oauth'].includes(provider)) {
        try { JSON.parse(v); } catch { return fail(res, 400, 'Paste the JSON content of the CLI login file.'); }
      }
      if (['firebase', 'google-play'].includes(provider)) {
        let j; try { j = JSON.parse(v); } catch { return fail(res, 400, 'Paste the JSON file contents.'); }
        if (provider === 'google-play' && !(j.client_email && j.private_key)) {
          return fail(res, 400, 'Not a Google Play service-account JSON (needs client_email + private_key).');
        }
      }
      if (provider === 'windows-store') {
        let j; try { j = JSON.parse(v); } catch { return fail(res, 400, 'Paste a JSON object with identityName, publisher, publisherDisplayName (Partner Center → Product identity).'); }
        if (!(j.identityName && /^CN=/.test(j.publisher || '') && j.publisherDisplayName)) {
          return fail(res, 400, 'Needs identityName, publisher (CN=…) and publisherDisplayName from Partner Center → Product identity.');
        }
      }
      if (provider === 'windows-signing') {
        let j; try { j = JSON.parse(v); } catch { return fail(res, 400, 'Paste a JSON object {pfxBase64, password}.'); }
        if (!j.pfxBase64) return fail(res, 400, 'Needs pfxBase64 (base64 of your .pfx code-signing certificate).');
      }
      saasStore.setProviderKey(req.tenant.id, provider, v);
      res.json({ ok: true });
    });
    app.delete('/api/keys/:provider', (req, res) => { saasStore.deleteProviderKey(req.tenant.id, req.params.provider); res.json({ ok: true }); });
    // Live balance/credits for the few providers that expose one (Moonshot/Kimi, OpenRouter,
    // DeepSeek — see provider-usage.mjs). Uses the tenant's stored key; best-effort, never
    // throws to the client. { supported:false } = no balance API (UI shows just the link);
    // { supported:true, available, currency } on success; { supported:true, error } on failure.
    app.get('/api/keys/:provider/usage', async (req, res) => {
      const provider = req.params.provider;
      if (!VAULT_PROVIDERS.has(provider)) return fail(res, 400, 'Unknown provider.');
      let key = saasStore.getProviderKey(req.tenant.id, provider), preset = null;
      if (provider === 'claude-plan') { try { const j = JSON.parse(key || '{}'); preset = j.preset; key = j.key; } catch { key = null; } }
      if (!key) return res.json({ supported: false }); // not connected
      const cfg = LIVE_USAGE[resolveUsageProvider(provider, preset)];
      if (!cfg) return res.json({ supported: false });
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(cfg.url, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (!r.ok) return res.json({ supported: true, error: `provider returned ${r.status}` });
        const bal = cfg.parse(await r.json().catch(() => ({})));
        if (!bal) return res.json({ supported: true, error: 'could not read balance' });
        res.json({ supported: true, ...bal, checkedAt: Date.now() });
      } catch { res.json({ supported: true, error: 'could not reach provider' }); }
    });

    // "Test connection": is the stored credential still VALID? A cheap, auth-only probe per
    // provider (GET the model list / user endpoint) — answers the question that a dead Kimi
    // key only surfaced as a generic "did not meet acceptance criteria" rejection. Best-effort,
    // never throws to the client. { tested:false, reason } when there's no probe for this
    // sign-in method (OAuth / login file / service-account); otherwise
    // { tested:true, valid:true|false|null, message, status }.
    app.get('/api/keys/:provider/test', async (req, res) => {
      const provider = req.params.provider;
      if (!VAULT_PROVIDERS.has(provider)) return fail(res, 400, 'Unknown provider.');
      const get = (p) => { try { return saasStore.getProviderKey(req.tenant.id, p); } catch { return null; } };
      // Admin: fall back to the platform-supplied key so a "connected · platform" provider tests too.
      const raw = get(provider) || (isAdminEmail(req.auth?.user?.email) ? platformSecretFor(platformKeyValues(), provider) : null);
      if (!raw) return res.json({ tested: false, reason: 'Not connected.' });
      // qwen's endpoint is deployment-specific (an Alibaba token-plan MaaS host 401s the
      // default DashScope endpoint), so probe the same base URL the planner/worker use.
      // ark (BytePlus ModelArk / Seedance) probes its configured base's /models list.
      const probe = provider === 'claude-plan' ? buildPlanProbe(claudePlanOf(get))
        : buildKeyProbe(provider, raw, provider === 'qwen' ? { baseUrl: qwenBaseUrl() }
                                      : provider === 'ark' ? { baseUrl: arkBaseUrl() }
                                      : provider === 'glm' ? { baseUrl: GLM_BASE_URL() } : {});
      if (!probe) return res.json({ tested: false, reason: 'No automated test for this sign-in method — it uses a CLI login, not an API key.' });
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(probe.url, { method: probe.method || 'GET', headers: probe.headers, body: probe.body, signal: ctrl.signal }).finally(() => clearTimeout(timer));
        // Body disambiguates scoped-key 401s (e.g. ElevenLabs missing_permissions = the key
        // authenticates but lacks the probe's scope — still usable for its granted features).
        const verdict = interpretProbe(r.status, await r.text().catch(() => ''));
        // GitHub: a valid token still needs the right scopes to create + push repos, so surface
        // them (classic PATs report scopes via x-oauth-scopes; fine-grained tokens send none).
        if (provider === 'github' && verdict.valid) {
          const scopes = (r.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
          if (scopes.length) {
            verdict.message = `Valid ✓ — scopes: ${scopes.join(', ')}`;
            if (!scopes.includes('repo')) verdict.message += ' · ⚠ missing "repo" scope (needed to create/push repos)';
          } else {
            verdict.message = 'Valid ✓ — fine-grained token (ensure Contents + Administration are read/write)';
          }
        }
        res.json({ tested: true, status: r.status, ...verdict, checkedAt: Date.now() });
      } catch { res.json({ tested: true, ...interpretProbe(0) }); }
    });

    // Billing (gated + authed; inert unless STRIPE_* env is set). Checkout/portal act
    // on the requester's own workspace (req.tenant) so one tenant can't bill another.
    const billUrls = (req) => {
      const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      return { origin };
    };
    app.post('/api/billing/checkout', async (req, res) => {
      if (!saasBilling.billingReady()) return fail(res, 503, 'Billing not configured.');
      const { origin } = billUrls(req);
      try {
        const { url } = await saasBilling.createCheckoutSession({
          workspaceId: req.tenant.id, plan: String(req.body?.plan || 'indie'),
          successUrl: `${origin}/app#/settings?billing=ok`, cancelUrl: `${origin}/app#/settings`,
        });
        res.json({ url });
      } catch (e) { fail(res, 502, e.message); }
    });
    app.post('/api/billing/portal', async (req, res) => {
      if (!saasBilling.billingReady()) return fail(res, 503, 'Billing not configured.');
      const { origin } = billUrls(req);
      try {
        const { url } = await saasBilling.createPortalSession({ workspaceId: req.tenant.id, returnUrl: `${origin}/app#/settings` });
        res.json({ url });
      } catch (e) { fail(res, 502, e.message); }
    });

    // --- Admin dashboard API (gated: signed-in AND email in WEBTMUX_ADMIN_EMAILS) ---
    const requireAdmin = (req, res, next) => {
      if (!isAdminEmail(req.auth?.user?.email)) return fail(res, 403, 'Admin only.');
      next();
    };
    app.use('/api/admin', requireAdmin);

    // Fully remove a tenant: drop in-memory + persisted run state, then tear down its
    // OS sandbox (kills tmux/processes + archives & deletes the home).
    async function removeTenantSandbox(ws) {
      if (!ws?.slug) return;
      for (const [key, run] of [...ralphRuns]) if (run.tenant?.slug === ws.slug) ralphRuns.delete(key);
      for (const f of await fs.readdir(RALPH_STATE_DIR).catch(() => [])) {
        if (f.startsWith(`${ws.slug}--`)) await fs.rm(path.join(RALPH_STATE_DIR, f), { force: true }).catch(() => {});
      }
      await saasTenants.deprovisionTenant(ws).catch((e) => console.warn(`[admin] deprovision ${ws.slug}: ${e.message}`));
    }

    // Snapshot for the admin home.
    app.get('/api/admin/overview', (_req, res) => {
      const users = saasStore.listUsers();
      const activeRuns = [...ralphRuns.values()].filter((r) => r.phase === 'building' || r.phase === 'finalizing').length;
      const invites = saasStore.listInvites();
      const usage7d = (() => {
        try { return Object.fromEntries(saasStore.usageSummary(Date.now() - 7 * 864e5).map((r) => [r.type, r.n])); }
        catch { return {}; }
      })();
      res.json({
        users: users.length,
        suspended: users.filter((u) => u.status !== 'active').length,
        activeRuns,
        usage7d, // e.g. { run_started: 12, run_finished: 10 } across all workspaces
        invites: { total: invites.length, unused: invites.filter((i) => !i.used_by_user_id).length },
      });
    });

    // Access codes (invites): list / create N / revoke.
    // Platform MCP servers (admin-managed): available to the owner's builds, and to
    // tenant builds only when `shared` is set — adding e.g. a Google Drive MCP here
    // with shared=true exposes it to every tester (use a service account, not a
    // personal grant). Bearer tokens are vault-encrypted; list never returns them.
    const validMcpInput = (b) => {
      const name = String(b?.name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const url = String(b?.url || '').trim();
      const auth = String(b?.auth || '').trim() || null;
      const capabilities = (Array.isArray(b?.capabilities) ? b.capabilities : String(b?.capabilities || '').split(','))
        .map((c) => String(c).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')).filter(Boolean).slice(0, 20);
      if (!name) return { error: 'Name required (letters/numbers/dashes).' };
      if (!/^https:\/\//.test(url)) return { error: 'URL must be https.' };
      if (!capabilities.length) return { error: 'List at least one capability id (e.g. google-drive, gmail).' };
      return { name, url, auth, capabilities };
    };
    // Tenant tmux sessions (admin ops). The sandboxes' OWN tmux servers are invisible to the
    // app-socket dashboard — this sweeps every provisioned workspace so leaked sessions are
    // visible and killable from the Admin UI ("stale" = the janitor's rules).
    app.get('/api/admin/sessions', async (_req, res) => {
      const out = [];
      let rows = []; try { rows = saasStore.listProvisionedWorkspaces(); } catch { /* none */ }
      await Promise.all(rows.map(async (ws) => {
        try {
          const argv = saasTenants.tenantContext(ws).wrap(['tmux', 'ls', '-F', '#{session_name}\t#{session_created}\t#{session_attached}']);
          const { stdout } = await execFileAsync(argv[0], argv.slice(1), { timeout: 10_000 });
          for (const line of stdout.split('\n')) {
            const [name, created, attached] = line.trim().split('\t');
            if (!name) continue;
            const ageMs = Date.now() - Number(created) * 1000;
            const stale = /-login-/.test(name) ? ageMs > 86_400_000
              : /-(r|rv|rf|rd)-/.test(name) ? ageMs > 2_700_000 : false;
            out.push({ tenant: ws.slug, name, ageMs, attached: attached === '1', stale });
          }
        } catch { /* tenant has no tmux server running */ }
      }));
      res.json({ sessions: out.sort((a, b) => b.ageMs - a.ageMs) });
    });
    app.delete('/api/admin/sessions/:slug/:name', async (req, res) => {
      let rows = []; try { rows = saasStore.listProvisionedWorkspaces(); } catch { /* none */ }
      const ws = rows.find((w) => w.slug === req.params.slug);
      if (!ws) return fail(res, 404, 'Unknown workspace.');
      const name = String(req.params.name || '');
      // A tenant session is always prefixed with its unix user — never let this route
      // aim at another tenant's (or the app's) sessions via a crafted name.
      if (!name.startsWith(`${ws.unix_user}-`)) return fail(res, 400, 'Session does not belong to that tenant.');
      try {
        const argv = saasTenants.tenantContext(ws).wrap(['tmux', 'kill-session', '-t', name]);
        await execFileAsync(argv[0], argv.slice(1), { timeout: 10_000 });
        audit({ admin: 'kill-session', tenant: ws.slug, session: name });
        res.json({ ok: true });
      } catch (e) { fail(res, 502, `Kill failed: ${e.message}`); }
    });
    app.post('/api/admin/sessions/sweep', async (_req, res) => {
      await runSessionJanitorNow().catch(() => {}); // reset the throttle + run one pass now
      res.json({ ok: true });
    });

    app.get('/api/admin/mcp', (_req, res) => res.json({ servers: saasStore.listMcpServers(null) }));
    app.post('/api/admin/mcp', (req, res) => {
      const v = validMcpInput(req.body);
      if (v.error) return fail(res, 400, v.error);
      if (v.auth && !saasVault.vaultReady()) return fail(res, 500, 'Server vault not configured (set WEBTMUX_VAULT_KEY).');
      saasStore.addMcpServer({ workspaceId: null, ...v, shared: !!req.body?.shared });
      res.json({ ok: true });
    });
    app.delete('/api/admin/mcp/:id', (req, res) => { saasStore.deleteMcpServer(req.params.id, null); res.json({ ok: true }); });

    app.put('/api/admin/solo-models', async (req, res) => {
      let clean;
      try { clean = sanitizeModels(req.body?.models); }
      catch (e) { return fail(res, 400, e.message); }
      await setSoloModels(clean);
      audit({ adminSoloModels: Object.keys(clean), by: req.auth?.user?.email });
      res.json({ ok: true, models: soloModelsEffective() });
    });

    app.put('/api/admin/media-caps', async (req, res) => {
      const caps = normalizeMedia(req.body?.caps);
      await setMediaCaps(caps);
      res.json({ ok: true, caps });
    });

    // A tenant's OWN MCP connections (e.g. a personal Composio/Pipedream/Zapier
    // Gmail or Drive URL, pre-authorized on their side). Used only in their builds.
    app.get('/api/mcp', (req, res) => res.json({ servers: saasStore.listMcpServers(req.tenant.id) }));
    app.post('/api/mcp', (req, res) => {
      const v = validMcpInput(req.body);
      if (v.error) return fail(res, 400, v.error);
      if (v.auth && !saasVault.vaultReady()) return fail(res, 500, 'Server vault not configured (set WEBTMUX_VAULT_KEY).');
      saasStore.addMcpServer({ workspaceId: req.tenant.id, ...v });
      res.json({ ok: true });
    });
    app.delete('/api/mcp/:id', (req, res) => { saasStore.deleteMcpServer(req.params.id, req.tenant.id); res.json({ ok: true }); });

    app.get('/api/admin/invites', (_req, res) => res.json({ invites: saasStore.listInvites() }));
    app.post('/api/admin/invites', (req, res) => {
      const count = clampInt(req.body?.count, 1, 50, 1);
      const made = [];
      for (let i = 0; i < count; i++) {
        const code = 'BETA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
        try { saasStore.createInvite({ code, email: (req.body?.email || '').trim() || null }); made.push(code); } catch { /* dup, skip */ }
      }
      res.status(201).json({ created: made });
    });
    app.delete('/api/admin/invites/:code', (req, res) => { saasStore.deleteInvite(req.params.code); res.json({ ok: true }); });

    // Users: list with plan + project count; change plan (resource allocation),
    // suspend/restore (revoke access), or fully delete (removes their OS sandbox).
    app.get('/api/admin/users', async (req, res) => {
      const rows = saasStore.listUsers();
      const stateFiles = await fs.readdir(RALPH_STATE_DIR).catch(() => []);
      const users = rows.map((u) => {
        const plan = u.workspace_id ? saasPlans.planFor(u.workspace_id) : { key: 'free' };
        const projects = u.workspace_slug ? stateFiles.filter((f) => f.startsWith(`${u.workspace_slug}--`)).length : 0;
        const activeRuns = [...ralphRuns.values()].filter((r) => r.tenant?.slug === u.workspace_slug && (r.phase === 'building' || r.phase === 'finalizing')).length;
        return {
          id: u.id, email: u.email, name: u.name, status: u.status, createdAt: u.created_at,
          workspace: u.workspace_slug, plan: plan.key, planStatus: plan.status,
          limits: { maxConcurrentRuns: plan.maxConcurrentRuns, maxProjects: plan.maxProjects },
          projects, activeRuns, admin: isAdminEmail(u.email),
        };
      });
      res.json({ users, plans: saasPlans.PLANS });
    });
    app.post('/api/admin/users/:id/plan', (req, res) => {
      const plan = String(req.body?.plan || '').trim();
      if (!saasPlans.PLANS[plan]) return fail(res, 400, 'Unknown plan.');
      const u = saasStore.getUserById(req.params.id);
      const ws = u && saasStore.getWorkspacesForUser(u.id)[0];
      if (!ws) return fail(res, 404, 'No workspace for that user.');
      // Admin override = a live subscription on the chosen plan (independent of Stripe).
      saasStore.upsertSubscription({ workspaceId: ws.id, plan, status: 'active' });
      audit({ adminPlan: u.email, plan, by: req.auth.user.email });
      res.json({ ok: true, plan });
    });
    app.post('/api/admin/users/:id/suspend', (req, res) => {
      const u = saasStore.getUserById(req.params.id);
      if (!u) return fail(res, 404, 'No such user.');
      if (isAdminEmail(u.email)) return fail(res, 400, 'Cannot suspend an admin.');
      const status = req.body?.suspend === false ? 'active' : 'suspended';
      saasStore.setUserStatus(u.id, status);
      audit({ adminSuspend: u.email, status, by: req.auth.user.email });
      res.json({ ok: true, status });
    });
    app.delete('/api/admin/users/:id', async (req, res) => {
      const u = saasStore.getUserById(req.params.id);
      if (!u) return fail(res, 404, 'No such user.');
      if (isAdminEmail(u.email)) return fail(res, 400, 'Cannot delete an admin account.');
      try {
        for (const ws of saasStore.getWorkspacesForUser(u.id)) await removeTenantSandbox(ws);
        saasStore.deleteUser(u.id); // workspaces/keys/subs cascade via FK ON DELETE
        audit({ adminDelete: u.email, by: req.auth.user.email });
        res.json({ ok: true });
      } catch (e) { fail(res, 500, e.message); }
    });

    console.log(`webtmux: MULTITENANT mode ON — app accounts active, /api gated${saasBilling.billingReady() ? ', billing live' : ''}${ADMIN_EMAILS.size ? `, admin(${ADMIN_EMAILS.size})` : ''}`);
  }
}
