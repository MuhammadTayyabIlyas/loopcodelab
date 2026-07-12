// dashboard/sessions.js — the classic dashboard: session cards + action sheet,
// launcher dialog (tools/SSH/modes/MCP picker), projects panel + context editor,
// health poll, push-notification UI, audit view, PWA install prompt.
// Top-level statements wire the UI on import (same order as the old single file).
// Dashboard: list / create / rename / kill tmux sessions, plus project
// continuity, pane previews, resource hints, an action sheet, a context
// editor, push notifications and an audit view.

const listEl = document.getElementById('list');
const dlg = document.getElementById('dlg');
const dlgForm = document.getElementById('dlg-form');
const dlgTitle = document.getElementById('dlg-title');
const dlgInput = document.getElementById('dlg-input');
const dlgOk = document.getElementById('dlg-ok');
const dlgError = document.getElementById('dlg-error');
const confirmDlg = document.getElementById('confirm-dlg');
const confirmMsg = document.getElementById('confirm-msg');
const launchEl = document.getElementById('dlg-launch');
const toolsEl = document.getElementById('dlg-tools');
const sshEl = document.getElementById('dlg-ssh');
const sshLabel = document.getElementById('ssh-label');
const modesEl = document.getElementById('dlg-modes');
const resumeRow = document.getElementById('dlg-resume-row');
const resumeChk = document.getElementById('dlg-resume');
const cmdEl = document.getElementById('dlg-cmd');
const projectSel = document.getElementById('dlg-project');
const projNewBtn = document.getElementById('proj-new');
const projNewRow = document.getElementById('proj-new-row');
const projName = document.getElementById('proj-name');
const projError = document.getElementById('proj-error');
const healthEl = document.getElementById('health');
const filterEl = document.getElementById('filter');
const sortEl = document.getElementById('sort');
const mcpRow = document.getElementById('dlg-mcp-row');
const mcpCategories = document.getElementById('mcp-categories');
const mcpSelected = document.getElementById('mcp-selected');
const mcpCount = document.getElementById('mcp-count');
const mcpTags = document.getElementById('mcp-tags');
const mcpNoneBtn = document.getElementById('mcp-none');
const mcpAllBtn = document.getElementById('mcp-all');
let mcpTools = [];
let mcpSelectedSet = new Set();


// Mirror of the server's launcher table — display/preview only; the server is
// the source of truth for what actually runs. Same composition rules as there.
const LAUNCHERS = {
  claude: { cmd: 'claude', bypass: '--dangerously-skip-permissions', resume: '--continue' },
  codex:  { cmd: 'codex',  bypass: '--sandbox danger-full-access',   resume: 'resume --last' },
  qwen:   { cmd: 'qwen',   bypass: '--yolo',                          resume: '--continue' },
  gemini: { cmd: 'gemini', bypass: '--yolo',                          resume: '--resume latest' },
  kimi:   { cmd: 'kimi',   bypass: '--yolo',                          resume: '--continue' },
  grok:   { cmd: 'grok',   bypass: '--always-approve',                resume: '--continue' },
  vibe:   { cmd: 'vibe --trust', bypass: '--yolo',                   resume: '--continue' },
  // The GLM base-URL + key live server-side (resolveLaunch); the client only shows
  // a clean preview so no credential is shipped in this file.
  glm:    { cmd: 'claude --model GLM-5.1', bypass: '--dangerously-skip-permissions', resume: '--continue' },
};

function previewCommand() {
  if (sshHost) return `ssh ${sshHost}`;
  const t = LAUNCHERS[tool];
  if (!t) return '';
  const parts = [t.cmd];
  if (launchMode === 'bypass') parts.push(t.bypass);
  if (resumeChk.checked) parts.push(t.resume);
  return parts.join(' ');
}

let mode = null;         // dialog mode: { action: 'create', project? } | { action: 'rename', from }
let tool = '';           // selected launcher tool ('' = plain shell)
let sshHost = '';        // selected SSH connect host ('' = none); wins over tool
let launchMode = 'safe'; // 'safe' | 'bypass'
let projectsRoot = '';   // absolute PROJECTS_ROOT, cached from /api/projects
let projectNames = [];   // known project folder names, cached
let sessionsCache = [];  // last /api/sessions payload, for filter/sort + sheet

function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/home\/[^/]+/, '~').replace(/^\/root/, '~');
}
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- "new output since you last looked" badge (client-side, per browser) -----
const seenKey = (name) => `seen:${name}`;
const isNew = (s) => (s.activity || 0) > Number(localStorage.getItem(seenKey(s.name)) || 0) + 1000;
const markSeen = (s) => localStorage.setItem(seenKey(s.name), String(s.activity || Date.now()));

// Suggest a session name for a project that won't collide with a live session.
function suggestName(project) {
  const base = project || 'shell';
  const taken = new Set(sessionsCache.map((s) => s.name));
  if (!taken.has(base)) return base.slice(0, 32);
  for (let i = 2; i < 100; i++) { const n = `${base}-${i}`.slice(0, 32); if (!taken.has(n)) return n; }
  return base.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------
function card(s) {
  const el = document.createElement('div');
  el.className = 'card';
  const cmd = s.command ? `<span class="cmd">${esc(s.command)}</span>` : '';
  const where = s.cwd ? ` · ${esc(shortPath(s.cwd))}` : '';
  const tag = s.project ? `<span class="tag">${esc(s.project)}</span>` : '';
  const stats = s.stats ? ` · ${s.stats.rssMb}MB${s.stats.cpu ? ` · ${s.stats.cpu}%` : ''}` : '';
  const preview = s.preview ? `<pre class="preview">${esc(s.preview)}</pre>` : '';
  const newDot = isNew(s) ? '<span class="newdot" title="New output"></span>' : '';
  const newInProj = s.project
    ? `<button class="icon-btn newproj" title="New session in ${esc(s.project)}" aria-label="New session in project ${esc(s.project)}">＋</button>`
    : '';
  el.innerHTML = `
    <div class="info">
      <div class="name">${newDot}<span class="nm"></span>${tag}</div>
      <div class="meta">
        <span class="dot ${s.attached ? 'live' : ''}"></span>
        ${s.attached ? `attached (${s.clients})` : 'detached'}
        · ${s.windows} window${s.windows === 1 ? '' : 's'}
        · ${fmtAgo(s.activity)}${stats}
      </div>
      <div class="sub">${cmd}${where}</div>
      ${preview}
    </div>
    <div class="actions">
      <button class="btn open" title="Open / attach session" aria-label="Open session ${esc(s.name)}">Open</button>
      ${newInProj}
      <button class="icon-btn more" title="More actions" aria-label="More actions for ${esc(s.name)}">⋯</button>
    </div>`;
  el.querySelector('.name .nm').textContent = s.name;
  const open = () => { markSeen(s); location.href = `/term?s=${encodeURIComponent(s.name)}`; };
  el.querySelector('.open').onclick = open;
  el.querySelector('.info').onclick = open;
  el.querySelector('.info').style.cursor = 'pointer';
  const np = el.querySelector('.newproj');
  if (np) np.onclick = (e) => { e.stopPropagation(); openDialog({ action: 'create', project: s.project }); };
  el.querySelector('.more').onclick = (e) => { e.stopPropagation(); openSheet(s); };
  return el;
}

function applyView() {
  const q = filterEl.value.trim().toLowerCase();
  let list = sessionsCache.filter((s) =>
    !q || s.name.toLowerCase().includes(q) || (s.project || '').toLowerCase().includes(q) || (s.command || '').toLowerCase().includes(q));
  const key = sortEl.value;
  list = [...list].sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name);
    if (key === 'project') return (a.project || '~').localeCompare(b.project || '~') || (b.activity || 0) - (a.activity || 0);
    return (b.activity || 0) - (a.activity || 0);
  });
  if (!list.length) {
    listEl.innerHTML = sessionsCache.length
      ? '<p class="empty">No sessions match the filter.</p>'
      : '<p class="empty">No sessions yet. Create one to get started.</p>';
    return;
  }
  listEl.replaceChildren(...list.map(card));
}

async function refresh() {
  try {
    const res = await fetch('/api/sessions?preview=1&stats=1', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessionsCache = (await res.json()).sessions;
    applyView();
  } catch (err) {
    listEl.innerHTML = `<p class="empty">Could not load sessions: ${esc(err.message)}</p>`;
  }
}

filterEl.addEventListener('input', applyView);
sortEl.addEventListener('change', applyView);

// ---------------------------------------------------------------------------
// Per-session action sheet
// ---------------------------------------------------------------------------
const sheetDlg = document.getElementById('sheet-dlg');
const sheetTitle = document.getElementById('sheet-title');
const sheetActions = document.getElementById('sheet-actions');

function openSheet(s) {
  sheetTitle.textContent = s.name;
  const acts = [
    ['New window', () => act(`/api/sessions/${encodeURIComponent(s.name)}/window`)],
    ['Duplicate', () => duplicate(s.name)],
    ['Detach others', () => act(`/api/sessions/${encodeURIComponent(s.name)}/detach`)],
  ];
  if (s.project) acts.push([`Edit ${s.project} context`, () => openContext(s.project)]);
  acts.push(['Rename', () => openDialog({ action: 'rename', from: s.name })]);
  acts.push(['Kill session', () => killSession(s.name), 'danger']);
  sheetActions.replaceChildren(...acts.map(([label, fn, cls]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn sheet-btn ${cls || ''}`;
    b.textContent = label;
    b.onclick = () => { sheetDlg.close(); fn(); };
    return b;
  }));
  sheetDlg.showModal();
}

// Fire a POST action endpoint, then refresh.
async function act(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    refresh();
    return await res.json().catch(() => ({}));
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function duplicate(from) {
  const name = await promptName(`Duplicate "${from}"`, suggestName(from));
  if (name) act(`/api/sessions/${encodeURIComponent(from)}/duplicate`, { name });
}

// ---------------------------------------------------------------------------
// Generic name prompt
// ---------------------------------------------------------------------------
const promptDlg = document.getElementById('prompt-dlg');
const promptForm = document.getElementById('prompt-form');
const promptTitle = document.getElementById('prompt-title');
const promptInput = document.getElementById('prompt-input');
const promptError = document.getElementById('prompt-error');

function promptName(title, value = '') {
  return new Promise((resolve) => {
    promptTitle.textContent = title;
    promptInput.value = value;
    promptError.hidden = true;
    const onClose = () => {
      promptForm.removeEventListener('submit', onSubmit);
      resolve(promptDlg.returnValue === 'ok' ? promptInput.value.trim() : null);
    };
    const onSubmit = (e) => { if (e.submitter && e.submitter.value === 'cancel') return; };
    promptForm.addEventListener('submit', onSubmit);
    promptDlg.addEventListener('close', onClose, { once: true });
    promptDlg.showModal();
    promptInput.focus();
    promptInput.select();
  });
}

// ---------------------------------------------------------------------------
// Projects panel
// ---------------------------------------------------------------------------
const projectsPanel = document.getElementById('projects-panel');
const projectsListEl = document.getElementById('projects-list');
const projCountEl = document.getElementById('proj-count');

export async function loadProjectsPanel() {
  try {
    const res = await fetch('/api/projects?detail=1', { cache: 'no-store' });
    const { detail = [] } = await res.json();
    projCountEl.textContent = detail.length ? `(${detail.length})` : '';
    if (!detail.length) {
      projectsListEl.innerHTML = '<p class="hint">No projects yet. Create one when starting a session.</p>';
      return;
    }
    projectsListEl.replaceChildren(...detail.map((p) => {
      const row = document.createElement('div');
      row.className = 'proj-item';
      const live = p.sessions ? `<span class="dot live"></span>${p.sessions} session${p.sessions === 1 ? '' : 's'}` : '<span class="dot"></span>no session';
      row.innerHTML = `
        <div class="proj-meta">
          <span class="proj-name"></span>
          <span class="muted">${live}${p.lastActivity ? ` · ${fmtAgo(p.lastActivity)}` : ''}</span>
        </div>
        <div class="proj-actions">
          <button class="btn start" title="Start a session here">Start</button>
          <button class="icon-btn edit" title="Edit context">✎</button>
        </div>`;
      row.querySelector('.proj-name').textContent = p.name;
      row.querySelector('.start').onclick = () => openDialog({ action: 'create', project: p.name });
      row.querySelector('.edit').onclick = () => openContext(p.name);
      return row;
    }));
  } catch {
    projectsListEl.innerHTML = '<p class="hint">Could not load projects.</p>';
  }
}

// ---------------------------------------------------------------------------
// Context editor
// ---------------------------------------------------------------------------
const ctxDlg = document.getElementById('ctx-dlg');
const ctxForm = document.getElementById('ctx-form');
const ctxTitle = document.getElementById('ctx-title');
const ctxText = document.getElementById('ctx-text');
const ctxError = document.getElementById('ctx-error');
let ctxProject = '';

async function openContext(project) {
  ctxProject = project;
  ctxTitle.textContent = `${project} — context`;
  ctxError.hidden = true;
  ctxText.value = 'Loading…';
  ctxDlg.showModal();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(project)}/context`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    ctxText.value = data.content;
  } catch (err) {
    ctxText.value = '';
    ctxError.textContent = err.message;
    ctxError.hidden = false;
  }
}

ctxForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(ctxProject)}/context`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ctxText.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    ctxDlg.close();
  } catch (err) {
    ctxError.textContent = err.message;
    ctxError.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// New / rename dialog
// ---------------------------------------------------------------------------
async function loadProjects(keep = '') {
  try {
    const res = await fetch('/api/projects', { cache: 'no-store' });
    const { root = '', projects = [] } = await res.json();
    projectsRoot = root;
    projectNames = projects;
    projectSel.innerHTML = '<option value="">(home — no project)</option>'
      + projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    projectSel.value = projects.includes(keep) ? keep : '';
  } catch {
    projectSel.innerHTML = '<option value="">(home — no project)</option>';
  }
}

projectSel.addEventListener('change', () => {
  resumeChk.checked = !!projectSel.value;
  if (projectSel.value && (!dlgInput.value || projectNames.includes(dlgInput.value))) {
    dlgInput.value = suggestName(projectSel.value);
  }
  updateCmdPreview();
});

projNewBtn.addEventListener('click', () => {
  projNewRow.hidden = false;
  projError.hidden = true;
  projName.value = '';
  projName.focus();
});
document.getElementById('proj-cancel').addEventListener('click', () => { projNewRow.hidden = true; });
document.getElementById('proj-create').addEventListener('click', async () => {
  const name = projName.value.trim();
  try {
    const res = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadProjects(data.name);
    projNewRow.hidden = true;
    resumeChk.checked = !!data.existed;
    if (!dlgInput.value || projectNames.includes(dlgInput.value)) dlgInput.value = suggestName(data.name);
    updateCmdPreview();
    loadProjectsPanel();
  } catch (err) {
    projError.textContent = err.message;
    projError.hidden = false;
  }
});

function updateCmdPreview() {
  if (!tool && !sshHost) { cmdEl.hidden = true; return; }
  cmdEl.hidden = false;
  cmdEl.textContent = `Runs: ${previewCommand()}`;
  cmdEl.classList.toggle('danger', !sshHost && launchMode === 'bypass');
}

function selectTool(key) {
  tool = key;
  if (key) sshHost = '';           // tool and SSH connect are mutually exclusive
  toolsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.tool === key));
  sshEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  modesEl.hidden = !key;
  resumeRow.hidden = !key;
  mcpRow.hidden = !key;            // show MCP picker when a launcher tool is selected
  updateCmdPreview();
}

function selectSsh(host) {
  sshHost = host;
  tool = '';                       // clear any tool selection
  toolsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.tool === ''));
  sshEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.ssh === host));
  modesEl.hidden = true;
  resumeRow.hidden = true;
  mcpRow.hidden = true;            // hide MCP picker for SSH
  if (!dlgInput.value || projectNames.includes(dlgInput.value)) dlgInput.value = suggestName(host);
  updateCmdPreview();
}

// Populate the SSH connect chips from the server's ~/.ssh/config Host aliases.
async function loadSshHosts() {
  try {
    const { hosts = [] } = await (await fetch('/api/ssh-hosts', { cache: 'no-store' })).json();
    sshLabel.hidden = sshEl.hidden = !hosts.length;
    sshEl.replaceChildren(...hosts.map((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.ssh = h;
      b.textContent = h;
      b.onclick = () => { selectSsh(h); dlgInput.focus(); };
      return b;
    }));
  } catch {
    sshLabel.hidden = sshEl.hidden = true;
  }
}

resumeChk.addEventListener('change', updateCmdPreview);

function selectMode(m) {
  launchMode = m;
  modesEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.mode === m));
  updateCmdPreview();
}

toolsEl.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const prev = tool;
    selectTool(chip.dataset.tool);
    if (!dlgInput.value || dlgInput.value === prev) dlgInput.value = tool;
    dlgInput.focus();
  });
});
modesEl.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => selectMode(chip.dataset.mode));
});

function openDialog(m) {
  mode = m;
  dlgError.hidden = true;
  const renaming = m.action === 'rename';
  dlgTitle.textContent = renaming ? `Rename "${m.from}"` : 'New session';
  dlgOk.textContent = renaming ? 'Rename' : 'Create';
  dlgInput.value = renaming ? m.from : '';
  launchEl.hidden = renaming;
  projNewRow.hidden = true;
  projError.hidden = true;
  resumeChk.checked = false;
  sshHost = '';
  selectMode('safe');
  selectTool('');
  mcpSelectedSet.clear();
  if (!renaming) {
    loadSshHosts();
    loadMcpTools();
    loadProjects(m.project || '').then(() => {
      if (m.project) { resumeChk.checked = true; dlgInput.value = suggestName(m.project); updateCmdPreview(); }
    });
  }
  dlg.showModal();
  dlgInput.focus();
  dlgInput.select();
}

dlgForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const name = dlgInput.value.trim();
  try {
    let res;
    if (mode.action === 'create') {
      res = await fetch('/api/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tool, mode: launchMode, project: projectSel.value, resume: resumeChk.checked, ssh: sshHost, mcpServers: [...mcpSelectedSet] }),
      });
    } else {
      res = await fetch(`/api/sessions/${encodeURIComponent(mode.from)}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    dlg.close();
    refresh();
    loadProjectsPanel();
  } catch (err) {
    dlgError.textContent = err.message;
    dlgError.hidden = false;
  }
});

function confirmKill(name) {
  return new Promise((resolve) => {
    confirmMsg.textContent = `Anything running in "${name}" will be terminated.`;
    const onClose = () => { confirmDlg.removeEventListener('close', onClose); resolve(confirmDlg.returnValue === 'ok'); };
    confirmDlg.addEventListener('close', onClose);
    confirmDlg.showModal();
  });
}

async function killSession(name) {
  if (!(await confirmKill(name))) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    refresh();
    loadProjectsPanel();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

document.getElementById('new-btn').onclick = () => openDialog({ action: 'create' });

// ---------------------------------------------------------------------------
// Health pill
// ---------------------------------------------------------------------------
async function pollHealth() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const d = await res.json();
    if (!res.ok || !d.ok) throw new Error();
    healthEl.className = d.tmuxOk ? 'health ok' : 'health warn';
    healthEl.title = d.tmuxOk ? 'Server online' : 'tmux server unreachable';
  } catch {
    healthEl.className = 'health down';
    healthEl.title = 'Backend offline';
  }
}

// ---------------------------------------------------------------------------
// Settings: notifications + audit
// ---------------------------------------------------------------------------
const settingsDlg = document.getElementById('settings-dlg');
const notifState = document.getElementById('notif-state');
const notifEnable = document.getElementById('notif-enable');
const notifDisable = document.getElementById('notif-disable');
const notifTest = document.getElementById('notif-test');
const auditList = document.getElementById('audit-list');

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSub() {
  if (!(await pushSupported())) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshNotifState() {
  if (!(await pushSupported())) {
    notifState.textContent = 'Not supported in this browser.';
    notifEnable.hidden = true; notifDisable.hidden = true; notifTest.hidden = true;
    return;
  }
  const sub = await currentSub();
  const on = !!sub && Notification.permission === 'granted';
  notifState.textContent = on ? 'Enabled on this device.'
    : Notification.permission === 'denied' ? 'Blocked — allow notifications in browser settings.'
    : 'Off.';
  notifEnable.hidden = on;
  notifDisable.hidden = !on;
  notifTest.hidden = !on;
}

notifEnable.addEventListener('click', async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permission not granted');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/push/key')).json();
    if (!key) throw new Error('Push not configured on the server');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
    const res = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    refreshNotifState();
  } catch (err) {
    notifState.textContent = `Could not enable: ${err.message}`;
  }
});

notifDisable.addEventListener('click', async () => {
  const sub = await currentSub();
  if (sub) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  refreshNotifState();
});

notifTest.addEventListener('click', () => fetch('/api/push/test', { method: 'POST' }));

async function loadAudit() {
  try {
    const { entries = [] } = await (await fetch('/api/audit', { cache: 'no-store' })).json();
    if (!entries.length) { auditList.innerHTML = '<p class="hint">No launches recorded yet.</p>'; return; }
    auditList.replaceChildren(...entries.slice(0, 40).map((e) => {
      const row = document.createElement('div');
      row.className = 'audit-row';
      const what = e.command && e.command !== '(shell)' ? e.command : 'shell';
      row.innerHTML = `<span class="audit-when">${fmtAgo(e.t)}</span>
        <span class="audit-cmd ${e.bypass ? 'danger' : ''}">${esc(what)}</span>
        <span class="muted">${esc(e.session || '')}${e.project ? ` · ${esc(e.project)}` : ''}</span>`;
      return row;
    }));
  } catch {
    auditList.innerHTML = '<p class="hint">Could not load audit log.</p>';
  }
}

document.getElementById('settings-btn').onclick = () => {
  settingsDlg.showModal();
  refreshNotifState();
  loadAudit();
};


// ---------------------------------------------------------------------------
// MCP Server Picker
// ---------------------------------------------------------------------------
async function loadMcpTools() {
  if (!mcpRow) return;
  try {
    const res = await fetch('https://mcp.tayyabcheema.com/api/tools', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    mcpTools = await res.json();
    renderMcpPicker();
  } catch (err) {
    mcpCategories.innerHTML = '<p class="hint" style="color:var(--danger)">Could not load MCP servers: ' + esc(err.message) + '</p>';
  }
}

function renderMcpPicker() {
  const groups = {};
  for (const t of mcpTools) {
    const cat = t.category || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(t);
  }
  const catOrder = ['search','git_advanced','qr_codes','browser','security','mcp_search','api_intelligence','sharing','knowledge','art','presentations','productivity','shipping','shopping','payments','filesystem','web_fetch','git','shell','mcp_catalog'];
  const sortedKeys = catOrder.filter(k => groups[k]);
  for (const k of Object.keys(groups)) { if (!sortedKeys.includes(k)) sortedKeys.push(k); }

  mcpCategories.innerHTML = sortedKeys.map(cat => {
    const tools = groups[cat];
    const allChecked = tools.every(t => mcpSelectedSet.has(t.name));
    return '<div class="mcp-cat-group">' +
      '<div class="mcp-cat-label">' +
        '<input type="checkbox" class="cat-check" data-cat="' + esc(cat) + '" ' + (allChecked ? 'checked' : '') + ' />' +
        esc(cat) + ' <span class="cat-count">(' + tools.length + ')</span>' +
      '</div>' +
      tools.map(t =>
        '<div class="mcp-server-row">' +
          '<input type="checkbox" id="mcp-' + esc(t.name) + '" data-tool="' + esc(t.name) + '" ' + (mcpSelectedSet.has(t.name) ? 'checked' : '') + ' />' +
          '<label for="mcp-' + esc(t.name) + '">' +
            '<span class="mcp-srv-name">' + esc(t.name) + '</span> ' +
            '<span class="mcp-srv-desc">' + esc(t.description) + '</span>' +
          '</label>' +
        '</div>'
      ).join('') +
    '</div>';
  }).join('');

  mcpCategories.querySelectorAll('.cat-check').forEach(cb => {
    cb.onchange = () => {
      const cat = cb.dataset.cat;
      const checked = cb.checked;
      for (const t of groups[cat]) {
        if (checked) mcpSelectedSet.add(t.name); else mcpSelectedSet.delete(t.name);
      }
      syncMcpCheckboxes();
      updateMcpSelected();
    };
  });
  mcpCategories.querySelectorAll('.mcp-server-row input').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) mcpSelectedSet.add(cb.dataset.tool); else mcpSelectedSet.delete(cb.dataset.tool);
      updateMcpSelected();
      updateCatChecks();
    };
  });
  updateMcpSelected();
}

function syncMcpCheckboxes() {
  mcpCategories.querySelectorAll('.mcp-server-row input').forEach(cb => {
    cb.checked = mcpSelectedSet.has(cb.dataset.tool);
  });
  updateCatChecks();
}

function updateCatChecks() {
  const groups = {};
  for (const t of mcpTools) {
    const cat = t.category || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(t);
  }
  for (const [cat, tools] of Object.entries(groups)) {
    const cb = mcpCategories.querySelector('.cat-check[data-cat="' + cat + '"]');
    if (cb) cb.checked = tools.every(t => mcpSelectedSet.has(t.name));
  }
}

function updateMcpSelected() {
  const n = mcpSelectedSet.size;
  mcpCount.textContent = n;
  if (n === 0) {
    mcpSelected.hidden = true;
  } else {
    mcpSelected.hidden = false;
    mcpTags.innerHTML = [...mcpSelectedSet].map(name =>
      '<span class="mcp-tag">' + esc(name) + '<span class="remove" data-tool="' + esc(name) + '">\u2715</span></span>'
    ).join('');
    mcpTags.querySelectorAll('.remove').forEach(btn => {
      btn.onclick = () => {
        mcpSelectedSet.delete(btn.dataset.tool);
        syncMcpCheckboxes();
        updateMcpSelected();
      };
    });
  }
}

if (mcpNoneBtn) mcpNoneBtn.onclick = () => { mcpSelectedSet.clear(); syncMcpCheckboxes(); updateMcpSelected(); };
if (mcpAllBtn) mcpAllBtn.onclick = () => { for (const t of mcpTools) mcpSelectedSet.add(t.name); syncMcpCheckboxes(); updateMcpSelected(); };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadProjects();
loadProjectsPanel();
refresh();
pollHealth();
setInterval(refresh, 5000);
setInterval(pollHealth, 15000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// --- PWA install prompt -----------------------------------------------------
const installBtn = document.getElementById('install-btn');
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  if (outcome === 'accepted') installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  deferredInstallPrompt = null;
});

