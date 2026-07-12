// webtmux Remote Control — mobile supervise view. Read-only pane + status polling.
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
let project = location.hash.slice(2) || '';   // /rc/#/<project>
let term, sock;

async function api(pathname, opts) {
  const r = await fetch(`/rc/api${pathname}`, { credentials: 'include', ...opts });
  if (r.status === 401) { msg('Not paired — scan the QR again.'); throw new Error('unpaired'); }
  return r.json();
}

function openPane(p, kind, story) {
  if (sock) { try { sock.close(); } catch {} }
  if (!term) {
    term = new window.Terminal({ fontSize: 12, convertEol: true, disableStdin: true, theme: { background: '#0b0f14' } });
    term.open($('pane'));
  }
  term.reset();
  const q = new URLSearchParams({ project: p, kind, story: story || 'final', cols: String(term.cols), rows: String(term.rows) });
  sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rc/ws?${q}`);
  sock.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  sock.onclose = () => term.write('\r\n\x1b[90m[no live pane]\x1b[0m\r\n');
  sock.binaryType = 'arraybuffer';
}

async function refresh() {
  let data;
  try { data = await api('/status'); } catch { return; }
  const runs = data.runs || [];
  const sel = $('project');
  sel.replaceChildren(...runs.map((r) => { const o = document.createElement('option'); o.value = r.project; o.textContent = r.project; return o; }));
  if (!project && runs[0]) project = runs[0].project;
  sel.value = project;
  const run = runs.find((r) => r.project === project) || runs[0];
  if (!run) { $('phase').textContent = 'no active runs'; return; }
  project = run.project;
  $('phase').textContent = `${run.phase} · master ${run.master}`;
  // pending question banner
  if (run.question) {
    $('q').style.display = 'block'; $('qtext').textContent = run.question.text;
    $('q').dataset.story = run.question.story;
  } else { $('q').style.display = 'none'; }
  // pane: finalize > review/build of the active story
  const kind = run.phase === 'finalizing' ? 'rf' : (run.story?.status === 'reviewing' ? 'rv' : 'r');
  const story = run.phase === 'finalizing' ? 'final' : (run.story?.id || 'final');
  if ($('pane').dataset.key !== `${project}:${kind}:${story}`) {
    $('pane').dataset.key = `${project}:${kind}:${story}`;
    openPane(project, kind, story);
  }
}

$('project').onchange = (e) => { project = e.target.value; location.hash = `#/${project}`; $('pane').dataset.key=''; refresh(); };
// iOS add-to-home-screen hint when not standalone
if (window.navigator.standalone === false) $('ios-a2hs').classList.remove('hide');

async function act(action) {
  if (action === 'continue') { await api('/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }); return msg('Continued.'); }
  if (action === 'steer') {
    const text = prompt('Steering note for the master:'); if (!text) return;
    await api('/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, text }) }); return msg('Steer sent.');
  }
  if (action === 'restart') { if (!confirm('Restart the current story?')) return; await api('/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }); return msg('Restarting.'); }
  if (action === 'swap') {
    const agent = prompt('Swap master to (claude/codex/qwen/gemini):'); if (!agent) return;
    await api('/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, role: 'master', agent }) }); return msg(`Swapping master to ${agent}.`);
  }
}
document.querySelectorAll('#bar button').forEach((b) => { b.onclick = () => act(b.dataset.act).catch((e) => msg(e.message)); });
$('qsend').onclick = async () => {
  const text = $('qans').value.trim(); if (!text) return;
  await api('/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, story: $('q').dataset.story, text }) }).catch((e) => msg(e.message));
  $('qans').value = ''; $('q').style.display = 'none'; msg('Answer sent.');
};

refresh();
setInterval(refresh, 4000);   // status fallback poll (also covers no-push platforms)

async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return msg('Push not supported here.');
  const reg = await navigator.serviceWorker.register('/rc/sw.js', { scope: '/rc/' });
  const perm = await Notification.requestPermission(); if (perm !== 'granted') return msg('Notifications denied.');
  const { key } = await api('/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
  await api('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
  msg('Notifications on ✓');
}
function urlB64(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }
$('notify').onclick = () => enableNotifications().catch((e) => msg(e.message));

export { api, project };   // actions/push modules (Task 5/6) import these
