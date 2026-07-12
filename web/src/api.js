// Thin API client for the Node backend. Same-origin; cookies carry the session.
async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // auth probe: 200 => user; 401 => signed out (multitenant on); 404/err => 'open'
  // (single-tenant: no login needed, dashboard is directly usable).
  me: () => fetch('/api/auth/me', { cache: 'no-store' })
    .then((r) => (r.status === 200 ? r.json() : r.status === 401 ? null : 'open'))
    .catch(() => 'open'),
  login: (email, password) => req('POST', '/api/auth/login', { email, password }),
  signup: (email, password, invite, name) => req('POST', '/api/auth/signup', { email, password, invite, name }),
  logout: () => req('POST', '/api/auth/logout'),
  // workspace data
  keys: () => req('GET', '/api/keys'),
  setKey: (provider, key) => req('PUT', `/api/keys/${provider}`, { key }),
  deleteKey: (provider) => req('DELETE', `/api/keys/${provider}`),
  // live balance/credits for a connected provider (supported ones only; see provider-usage.mjs)
  usage: (provider) => req('GET', `/api/keys/${provider}/usage`),
  // auth-only validity probe for a connected provider (see ralph/key-test.mjs)
  testKey: (provider) => req('GET', `/api/keys/${provider}/test`),
  cliLogin: (agent) => req('POST', `/api/cli-login/${agent}`),
  builds: () => req('GET', '/api/ralph/status'),
  build: (project) => req('GET', `/api/ralph/status?project=${encodeURIComponent(project)}`),
  sessions: () => fetch('/api/sessions', { cache: 'no-store' }).then((r) => r.json()).then((d) => d.sessions || []).catch(() => []),
  doctor: (project) => req('POST', `/api/ralph/${encodeURIComponent(project)}/doctor`),
  deleteBuild: (project) => req('DELETE', `/api/ralph/${encodeURIComponent(project)}`),
  masterLog: (project) => req('GET', `/api/ralph/masterlog?project=${encodeURIComponent(project)}`),
  // new-build flow: clarify (optional) -> plan (PRD preview) -> start
  clarify: (idea, outputFormat) => req('POST', '/api/ralph/clarify', { idea, outputFormat }),
  analyze: (body) => req('POST', '/api/ralph/analyze', body),
  plan: (body) => req('POST', '/api/ralph/plan', body),
  start: (body) => req('POST', '/api/ralph/start', body),
  // Stage one brand asset (octet-stream, filename in ?name). Returns { assetToken, assets }.
  uploadAsset: async (file, token) => {
    const qs = new URLSearchParams({ name: file.name });
    if (token) qs.set('token', token);
    const res = await fetch(`/api/ralph/assets?${qs.toString()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  soloModels: () => req('GET', '/api/ralph/solo-models'),
  setSoloModels: (models) => req('PUT', '/api/admin/solo-models', { models }),
  mediaCaps: () => req('GET', '/api/ralph/media-caps'),
  setMediaCaps: (caps) => req('PUT', '/api/admin/media-caps', { caps }),
  drafts: () => req('GET', '/api/ralph/drafts'),
  draft: (id) => req('GET', `/api/ralph/drafts/${encodeURIComponent(id)}`),
  saveDraft: (body) => req('POST', '/api/ralph/drafts', body),
  deleteDraft: (id) => req('DELETE', `/api/ralph/drafts/${encodeURIComponent(id)}`),
  // revise: append new stories to a finished build from a follow-up instruction.
  // body: { project: string, idea: string }
  revise: (project, idea) => req('POST', '/api/ralph/revise', { project, idea }),
  pause: (project) => req('POST', '/api/ralph/pause', { project }),
  resume: (project) => req('POST', '/api/ralph/resume', { project }),
  skipStory: (project, story) => req('POST', '/api/ralph/skip', { project, story }),
  swap: (project, role, agent) => req('POST', '/api/ralph/swap', { project, role, agent }),
  editStory: (project, story, patch) => req('POST', '/api/ralph/story-edit', { project, story, ...patch }),
  addStory: (project, body) => req('POST', '/api/ralph/story-add', { project, ...body }),
  // revert: roll back a single merged story by reverting its merge commit.
  // body: { project: string, story: string }
  revert: (project, story) => req('POST', '/api/ralph/revert', { project, story }),
  // build the installable APK + Google Drive link/QR on demand (flutter-app); run before submit.
  apk: (project) => req('POST', '/api/ralph/apk', { project }),
  // submit a finished flutter-app to an app store (separate step). store: 'play' | 'ios'.
  // opts: { track } for play, { bundleId } for ios.
  submit: (project, store = 'play', opts = {}) => req('POST', '/api/ralph/submit', { project, store, ...opts }),
  // Phase 2a: scaffold a Windows installer (Tauri) + Actions workflow for a finished web-app build.
  windowsInstaller: (project, opts = {}) => req('POST', '/api/ralph/windows/installer', { project, ...opts }),
  // Phase 3: Microsoft Store package (electron appx on Actions -> Drive, or pwa manual checklist).
  // opts: { packaging, identityName, publisher, publisherDisplayName, version } (identity falls back to the windows-store vault key).
  windowsStore: (project, opts = {}) => req('POST', '/api/ralph/windows/store', { project, ...opts }),
  // Phase 3: refresh SUBMISSION-WINDOWS.md + wire optional signing secrets.
  windowsSubmit: (project) => req('POST', '/api/ralph/windows/submit', { project }),
  // Draft start timer: one-shot auto-start after delayMs (server clock fires it).
  scheduleDraft: (id, delayMs) => req('POST', `/api/ralph/drafts/${encodeURIComponent(id)}/schedule`, { delayMs }),
  unscheduleDraft: (id) => req('DELETE', `/api/ralph/drafts/${encodeURIComponent(id)}/schedule`),
  // Subscription tracking notes (Settings "Track" dialog): per-provider planning metadata.
  tracking: () => req('GET', '/api/tracking'),
  saveTracking: (provider, entry) => req('PUT', `/api/tracking/${encodeURIComponent(provider)}`, { entry }),
  deleteTracking: (provider) => req('DELETE', `/api/tracking/${encodeURIComponent(provider)}`),
  // --- admin (only succeeds for admin accounts) ---
  adminOverview: () => req('GET', '/api/admin/overview'),
  adminSessions: () => req('GET', '/api/admin/sessions'),
  adminKillSession: (slug, name) => req('DELETE', `/api/admin/sessions/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`),
  adminSweepSessions: () => req('POST', '/api/admin/sessions/sweep'),
  adminInvites: () => req('GET', '/api/admin/invites'),
  adminCreateInvites: (count = 1) => req('POST', '/api/admin/invites', { count }),
  adminDeleteInvite: (code) => req('DELETE', `/api/admin/invites/${encodeURIComponent(code)}`),
  adminUsers: () => req('GET', '/api/admin/users'),
  adminSetPlan: (id, plan) => req('POST', `/api/admin/users/${id}/plan`, { plan }),
  adminSuspend: (id, suspend) => req('POST', `/api/admin/users/${id}/suspend`, { suspend }),
  adminDeleteUser: (id) => req('DELETE', `/api/admin/users/${id}`),
  adminMcp: () => req('GET', '/api/admin/mcp'),
  adminAddMcp: (server) => req('POST', '/api/admin/mcp', server),
  adminDeleteMcp: (id) => req('DELETE', `/api/admin/mcp/${id}`),
  // tenant's own MCP connections
  mcp: () => req('GET', '/api/mcp'),
  addMcp: (server) => req('POST', '/api/mcp', server),
  deleteMcp: (id) => req('DELETE', `/api/mcp/${id}`),
};
