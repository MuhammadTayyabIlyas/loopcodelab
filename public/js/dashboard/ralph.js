// dashboard/ralph.js — the Ralph orchestrator UI: build/clarify/confirm dialogs,
// brand-asset uploads, run status dialog (stories/master log/windows/apk actions),
// swap + doctor, drafts, and the adopt-existing flow.
import { esc, loadProjectsPanel } from './sessions.js';

// ---------------------------------------------------------------------------
// Ralph: autonomous multi-agent build
// ---------------------------------------------------------------------------
const RALPH_AGENTS = [
  ['claude', 'Claude'], ['codex', 'Codex'], ['qwen', 'Qwen'], ['gemini', 'Gemini'], ['kimi', 'Kimi'], ['grok', 'Grok'], ['vibe', 'Vibe'], ['glm', 'GLM-5.1'],
];
const ralphDlg = document.getElementById('ralph-dlg');
const ralphForm = document.getElementById('ralph-form');
const ralphProject = document.getElementById('ralph-project');
const ralphIdea = document.getElementById('ralph-idea');
const ralphMasterEl = document.getElementById('ralph-master');
const ralphWorkersEl = document.getElementById('ralph-workers');
const ralphAttempts = document.getElementById('ralph-attempts');
const ralphPasses = document.getElementById('ralph-passes');
const ralphBypass = document.getElementById('ralph-bypass');
const ralphOutput = document.getElementById('ralph-output');
const ralphConfirmDlg = document.getElementById('ralph-confirm-dlg');
const ralphConfirmForm = document.getElementById('ralph-confirm-form');
const ralphConfirmStories = document.getElementById('ralph-confirm-stories');
const ralphConfirmSummary = document.getElementById('ralph-confirm-summary');
const ralphConfirmError = document.getElementById('ralph-confirm-error');
const ralphClarifyDlg = document.getElementById('ralph-clarify-dlg');
const ralphClarifyForm = document.getElementById('ralph-clarify-form');
const ralphClarifyQs = document.getElementById('ralph-clarify-qs');
const ralphClarifyError = document.getElementById('ralph-clarify-error');

let ralphAssetToken = null;             // set by uploads in the clarify dialog
const ralphAssetEls = () => ({
  input: document.getElementById('ralph-asset-input'),
  list: document.getElementById('ralph-asset-list'),
  error: document.getElementById('ralph-asset-error'),
});
async function uploadRalphAsset(file) {
  const qs = new URLSearchParams({ name: file.name });
  if (ralphAssetToken) qs.set('token', ralphAssetToken);
  const res = await fetch(`/api/ralph/assets?${qs.toString()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  ralphAssetToken = data.assetToken;
  return data.assets || [];
}
function renderRalphAssets(assets) {
  const { list } = ralphAssetEls();
  if (!list) return;
  list.replaceChildren(...assets.map((a) => {
    const li = document.createElement('li');
    li.textContent = `${a.name} (${a.kind})`;
    return li;
  }));
}
let ralphPending = null;
// Skill/tool/output metadata returned by /api/ralph/plan, used to render the
// editable chips in the confirm dialog. Baseline skills are the always-present
// vendored set shown as quick-add chips (the planner may also assign cloned ones).
let ralphSkillsCatalog = [];     // [{id, description}]
let ralphMcpTools = [];          // ['google-docs', ...]
let ralphOutputFormats = ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'];
const RALPH_BASELINE_SKILLS = ['docx', 'pdf', 'xlsx', 'pptx', 'google-workspace', 'web-deliverable'];
const ralphError = document.getElementById('ralph-error');
const ralphActive = document.getElementById('ralph-active');
const ralphStatusDlg = document.getElementById('ralph-status-dlg');
const ralphStatusTitle = document.getElementById('ralph-status-title');
const ralphStatusPhase = document.getElementById('ralph-status-phase');
const ralphStatusStories = document.getElementById('ralph-status-stories');
const ralphStatusRepo = document.getElementById('ralph-status-repo');
const ralphStatusAttention = document.getElementById('ralph-status-attention');
const fmtDur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`; };

async function swapAgent(project, role, agent) {
  try {
    const res = await fetch('/api/ralph/swap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, role, agent }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'swap failed'); }
    pollRalphStatus(project); // it's building again — resume polling
    if (!ralphPollTimer) ralphPollTimer = setInterval(() => pollRalphStatus(project), 3000);
  } catch (err) { alert(`Switch failed: ${err.message}`); }
}

// Doctor: ask the server to diagnose a failed run and auto-treat it, then show
// the diagnosis + applied treatments inline on the card and resume polling.
async function doctorProject(project, card) {
  const btn = card.querySelector('[data-doctor]');
  if (btn) { btn.disabled = true; btn.textContent = '🩺 Diagnosing…'; }
  try {
    const res = await fetch(`/api/ralph/${encodeURIComponent(project)}/doctor`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'doctor failed');
    const treatments = (d.treatments || []).map((t) =>
      `<li>${esc(t.id)} <span class="muted">(${esc(t.cls)})</span>${t.swapTo ? ` — reassigned <b>${esc(t.swapFrom)}→${esc(t.swapTo)}</b>` : ''} — ${esc(t.remedy)}</li>`).join('');
    const extra = [d.finalizeFailed ? '<li>finalize — re-running</li>' : '',
      d.pushFailed ? `<li>remote — ${esc(d.remoteFix || 'retried')}</li>` : ''].join('');
    const panel = document.createElement('div');
    panel.className = 'attention';
    panel.innerHTML = `<div>🩺 <b>Diagnosis</b></div><div>${esc(d.diagnosis || 'Treated.')}</div>`
      + (treatments || extra ? `<div class="muted" style="margin-top:.4rem">Treatment applied</div><ul style="margin:.2rem 0 .2rem 1rem">${treatments}${extra}</ul>` : '')
      + `<div class="attention-actions"><button type="button" class="btn small" data-refresh>Done</button></div>`;
    card.appendChild(panel);
    panel.querySelector('[data-refresh]').onclick = openRalphBuilds; // re-render with the resumed (building) state
    if (btn) btn.remove();
  } catch (err) {
    alert(`Doctor failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🩺 Doctor'; }
  }
}

async function deleteProject(project, after) {
  if (!confirm(`Delete "${project}" and ALL its files from the server? This frees space but cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/ralph/${encodeURIComponent(project)}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'delete failed'); }
    if (after) after();
  } catch (err) { alert(`Delete failed: ${err.message}`); }
}
let ralphMaster = 'claude';
const ralphWorkerSet = new Set(['codex', 'gemini']);
let ralphPollTimer = null;

// Master is single-select; workers toggle. Re-rendered on every change.
function renderRalphAgents() {
  const chip = (key, label, active, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (active ? ' active' : '');
    b.textContent = label; b.dataset.agent = key; b.onclick = onClick;
    return b;
  };
  // glm is unreliable as master (agentic review) — workers only.
  if (ralphMaster === 'glm') ralphMaster = 'claude';
  ralphMasterEl.replaceChildren(...RALPH_AGENTS.filter(([k]) => k !== 'glm').map(([k, l]) =>
    chip(k, l, ralphMaster === k, () => { ralphMaster = k; renderRalphAgents(); })));
  ralphWorkersEl.replaceChildren(...RALPH_AGENTS.map(([k, l]) =>
    chip(k, l, ralphWorkerSet.has(k), () => {
      ralphWorkerSet.has(k) ? ralphWorkerSet.delete(k) : ralphWorkerSet.add(k);
      renderRalphAgents();
    })));
  const soloNote = document.getElementById('ralph-solo-note');
  if (soloNote) {
    const workers = [...ralphWorkerSet].filter((w) => w !== ralphMaster);
    soloNote.hidden = workers.length !== 0;
    soloNote.textContent = `Solo mode — ${ralphMaster} builds every story and reviews its own work (no separate workers).`;
  }
}

// Surface any in-progress builds at the top of the start dialog so they're reachable.
async function loadRalphActive() {
  try {
    const { runs = [] } = await (await fetch('/api/ralph/status', { cache: 'no-store' })).json();
    const live = runs.filter((r) => r.phase === 'building' || r.phase === 'finalizing');
    if (!live.length) { ralphActive.hidden = true; ralphActive.replaceChildren(); return; }
    ralphActive.hidden = false;
    const head = document.createElement('span');
    head.className = 'field-label'; head.textContent = 'In progress';
    ralphActive.replaceChildren(head, ...live.map((r) => {
      const a = document.createElement('button');
      a.type = 'button'; a.className = 'btn small';
      a.textContent = `${r.project} — ${r.phase}`;
      a.onclick = () => { ralphDlg.close(); openRalphStatus(r.project); };
      return a;
    }));
  } catch { ralphActive.hidden = true; }
}

function openRalphDialog() {
  ralphError.hidden = true;
  ralphProject.value = ''; ralphIdea.value = ''; ralphAttempts.value = '3'; ralphPasses.value = '1';
  ralphBypass.checked = true; ralphOutput.value = 'auto';
  ralphMaster = 'claude';
  ralphWorkerSet.clear(); ['codex', 'gemini'].forEach((w) => ralphWorkerSet.add(w));
  renderRalphAgents();
  loadRalphActive();
  seedRalphPrefs(); // suggest-only: override the hardcoded defaults from learned prefs
  ralphDlg.showModal();
  ralphProject.focus();
}

// Seed the start dialog from learned preferences (master/workers/output format).
// Best-effort and non-blocking; the user can change anything or clear the memory.
async function seedRalphPrefs() {
  const hint = document.getElementById('ralph-prefs-hint');
  if (hint) hint.hidden = true;
  let data;
  try { data = await (await fetch('/api/ralph/prefs', { cache: 'no-store' })).json(); } catch { return; }
  const prefs = data?.prefs || {};
  const masterKeys = RALPH_AGENTS.map(([k]) => k).filter((k) => k !== 'glm');
  if (prefs.preferredMaster && masterKeys.includes(prefs.preferredMaster)) ralphMaster = prefs.preferredMaster;
  if (Array.isArray(prefs.workers) && prefs.workers.length) {
    const valid = RALPH_AGENTS.map(([k]) => k);
    const ws = prefs.workers.filter((w) => valid.includes(w));
    if (ws.length) { ralphWorkerSet.clear(); ws.forEach((w) => ralphWorkerSet.add(w)); }
  }
  if (prefs.defaultOutputFormat) {
    const opts = [...ralphOutput.options].map((o) => o.value);
    const fmt = opts.includes(prefs.defaultOutputFormat) ? prefs.defaultOutputFormat
      : (['docx', 'pdf', 'xlsx', 'pptx'].includes(prefs.defaultOutputFormat) ? 'downloadable' : null);
    if (fmt) ralphOutput.value = fmt;
  }
  renderRalphAgents();
  // Show a small, dismissible "using your preferences" line with a clear action.
  const bits = [];
  if (prefs.preferredMaster) bits.push(`master ${prefs.preferredMaster}`);
  if (prefs.defaultOutputFormat) bits.push(`output ${prefs.defaultOutputFormat}`);
  if (data?.profileNote) bits.push('profile');
  if (hint && bits.length) {
    hint.replaceChildren();
    hint.append(document.createTextNode(`Using your saved preferences (${bits.join(', ')}). `));
    const clr = document.createElement('button');
    clr.type = 'button'; clr.className = 'btn small'; clr.textContent = 'Clear';
    clr.onclick = async () => {
      try { await fetch('/api/ralph/prefs', { method: 'DELETE' }); } catch { /* ignore */ }
      ralphMaster = 'claude';
      ralphWorkerSet.clear(); ['codex', 'gemini'].forEach((w) => ralphWorkerSet.add(w));
      ralphOutput.value = 'auto'; renderRalphAgents(); hint.hidden = true;
    };
    hint.append(clr);
    hint.hidden = false;
  }
}

// Step 1: "Plan stories" — first ask clarifying questions, then plan.
ralphForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const project = ralphProject.value.trim();
  const idea = ralphIdea.value.trim();
  const workers = [...ralphWorkerSet].filter((w) => w !== ralphMaster);
  const maxAttempts = Math.min(Math.max(parseInt(ralphAttempts.value, 10) || 3, 1), 10);
  const workerPasses = Math.min(Math.max(parseInt(ralphPasses.value, 10) || 1, 1), 5);
  const bypass = ralphBypass.checked;
  const outputFormat = ralphOutput.value || 'auto';
  const model = (document.getElementById('ralph-model')?.value || '').trim();
  ralphError.hidden = true;
  if (!project) { ralphError.textContent = 'Enter a project name.'; ralphError.hidden = false; return; }
  if (!idea) { ralphError.textContent = 'Describe what to build.'; ralphError.hidden = false; return; }
  ralphPending = { project, idea, master: ralphMaster, workers, maxAttempts, workerPasses, bypass, outputFormat, model: model || undefined };
  const planBtn = document.getElementById('ralph-plan');
  planBtn.disabled = true; planBtn.textContent = 'Thinking…';
  try {
    const cr = await fetch('/api/ralph/clarify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idea, outputFormat }),
    });
    const cj = await cr.json().catch(() => ({ questions: [] }));
    const qs = Array.isArray(cj.questions) ? cj.questions : [];
    if (qs.length) { ralphDlg.close(); openClarify(qs); } // ask, then plan
    else { await doPlan(''); }                            // already clear → plan now
  } catch (err) {
    ralphError.textContent = err.message; ralphError.hidden = false;
  } finally {
    planBtn.disabled = false; planBtn.textContent = 'Plan stories →';
  }
});

// Ask the user clarifying questions before planning. Each question shows concrete
// options (radio, or checkboxes when multiSelect) with the recommended one pre-
// picked, plus an always-present "Something else…" free-write escape hatch — so
// the common path is one click and the user can still override.
function openClarify(questions) {
  ralphClarifyError.hidden = true;
  ralphClarifyQs.replaceChildren(...questions.map((q, qi) => {
    const wrap = document.createElement('div');
    wrap.className = 'clarify-q';
    wrap.dataset.q = q.q;
    wrap.dataset.header = q.header || '';
    wrap.dataset.multi = q.multiSelect ? '1' : '';

    const lab = document.createElement('div'); lab.className = 'field-label';
    if (q.header) { const tag = document.createElement('span'); tag.className = 'clarify-header'; tag.textContent = q.header; lab.append(tag); }
    lab.append(document.createTextNode(q.q));
    wrap.append(lab);

    const type = q.multiSelect ? 'checkbox' : 'radio';
    const name = `cq${qi}`;
    const opts = document.createElement('div'); opts.className = 'clarify-options';

    const other = document.createElement('input');
    other.type = 'text'; other.className = 'clarify-input clarify-other-input';
    other.placeholder = 'Type your own answer'; other.hidden = true;

    const showOther = (focus) => {
      const on = wrap.querySelector('.clarify-opt-other input').checked;
      other.hidden = !on;
      if (on && focus) other.focus();
    };

    const mkOpt = (value, labelText, descText, checked, isOther) => {
      const l = document.createElement('label');
      l.className = 'clarify-opt' + (isOther ? ' clarify-opt-other' : '');
      const inp = document.createElement('input');
      inp.type = type; inp.name = name; inp.value = value; inp.checked = !!checked;
      inp.addEventListener('change', () => showOther(true));
      const t = document.createElement('span'); t.className = 'clarify-opt-label'; t.textContent = labelText;
      l.append(inp, t);
      if (descText) { const d = document.createElement('span'); d.className = 'clarify-opt-desc'; d.textContent = descText; l.append(d); }
      return l;
    };

    for (const o of q.options) opts.append(mkOpt(o.label, o.label, o.description, o.recommended, false));
    // No discrete options → the free-write field is the only (pre-selected) answer.
    opts.append(mkOpt('__other__', 'Something else…', '', q.options.length === 0, true));
    opts.append(other);
    wrap.append(opts);
    showOther(false);
    return wrap;
  }));
  ralphAssetToken = null;
  const { input, list, error } = ralphAssetEls();
  if (list) list.replaceChildren();
  if (error) error.hidden = true;
  if (input) {
    input.value = '';
    input.onchange = async () => {
      error.hidden = true;
      try {
        let assets = [];
        for (const f of [...input.files]) assets = await uploadRalphAsset(f);
        renderRalphAssets(assets);
      } catch (err) { error.textContent = err.message; error.hidden = false; }
      input.value = '';
    };
  }
  ralphClarifyDlg.showModal();
  const first = ralphClarifyQs.querySelector('input'); if (first) first.focus();
}

// Plan with the (optional) clarifying answers, then show the plan to confirm.
async function doPlan(answers) {
  const res = await fetch('/api/ralph/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idea: ralphPending.idea, master: ralphPending.master, workers: ralphPending.workers, answers: answers || '', outputFormat: ralphPending.outputFormat, assetToken: ralphAssetToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  ralphPending.prd = data.prd;
  ralphSkillsCatalog = Array.isArray(data.skillsCatalog) ? data.skillsCatalog : [];
  ralphMcpTools = Array.isArray(data.mcpTools) ? data.mcpTools : [];
  if (Array.isArray(data.outputFormats) && data.outputFormats.length) ralphOutputFormats = data.outputFormats;
  if (ralphClarifyDlg.open) ralphClarifyDlg.close();
  if (ralphDlg.open) ralphDlg.close();
  openRalphConfirm(data.prd);
}

ralphClarifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const skip = e.submitter && e.submitter.value === 'skip';
  ralphClarifyError.hidden = true;
  const goBtn = document.getElementById('ralph-clarify-go');
  goBtn.disabled = true; goBtn.textContent = 'Planning…';
  try {
    const items = skip ? [] : [...ralphClarifyQs.querySelectorAll('.clarify-q')]
      .map((wrap) => {
        const multi = !!wrap.dataset.multi;
        const otherInput = wrap.querySelector('.clarify-other-input');
        const otherText = otherInput ? otherInput.value.trim() : '';
        const picks = [];
        for (const i of wrap.querySelectorAll('.clarify-opt input')) {
          if (!i.checked) continue;
          if (i.value === '__other__') { if (otherText) picks.push(otherText); }
          else picks.push(i.value);
        }
        return { q: wrap.dataset.q, header: wrap.dataset.header || '', a: multi ? picks.join(', ') : (picks[0] || '') };
      })
      .filter((x) => x.a);
    const answers = items.map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n');
    if (ralphPending) ralphPending.clarify = items; // carried to /api/ralph/start as a learning signal
    await doPlan(answers);
  } catch (err) {
    ralphClarifyError.textContent = err.message; ralphClarifyError.hidden = false;
  } finally {
    goBtn.disabled = false; goBtn.textContent = 'Generate plan →';
  }
});

// Step 2: show the planned stories with EDITABLE skills/tools/output per story.
// Edits mutate prd.stories in place; the prd is sent as-is on Confirm (the server
// re-sanitizes). Confirm starts the build, Back returns to edit.
function openRalphConfirm(prd) {
  ralphConfirmError.hidden = true;
  const n = (prd.stories || []).length;
  ralphConfirmSummary.textContent =
    `${n} stor${n === 1 ? 'y' : 'ies'} · master ${ralphPending.master} · output ${ralphPending.outputFormat || 'auto'} · ${ralphPending.bypass ? 'bypass on' : 'bypass OFF'}`;
  const descOf = (id) => (ralphSkillsCatalog.find((s) => s.id === id) || {}).description || '';
  // A small toggle chip whose active state reflects membership in `list`.
  const toggleChip = (label, list, value, title) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (list.includes(value) ? ' active' : '');
    b.textContent = label; if (title) b.title = title;
    b.onclick = () => {
      const i = list.indexOf(value);
      if (i >= 0) list.splice(i, 1); else list.push(value);
      b.classList.toggle('active');
    };
    return b;
  };
  ralphConfirmStories.replaceChildren(...(prd.stories || []).map((st) => {
    st.skills = Array.isArray(st.skills) ? st.skills : [];
    st.tools = Array.isArray(st.tools) ? st.tools : [];
    const row = document.createElement('div');
    row.className = 'ralph-story ralph-story-edit';

    const head = document.createElement('div');
    head.className = 'ralph-story-head';
    head.innerHTML =
      `<span class="badge todo">${esc(st.id)}</span>` +
      `<span class="ralph-story-title">${esc(st.title)}</span>` +
      `<span class="tag">${esc(st.assignee)}</span>` +
      (st.deps && st.deps.length ? `<span class="muted">needs ${esc(st.deps.join(', '))}</span>` : '');

    // Output type select.
    const outWrap = document.createElement('div'); outWrap.className = 'ralph-field';
    outWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'output' }));
    const sel = document.createElement('select'); sel.className = 'num-input';
    for (const f of ralphOutputFormats) sel.append(new Option(f, f, false, (st.outputType || 'auto') === f));
    sel.onchange = () => { st.outputType = sel.value; };
    outWrap.append(sel);

    // Skill chips: baseline set + any already-assigned (incl. cloned) ids.
    const skWrap = document.createElement('div'); skWrap.className = 'ralph-field';
    skWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'skills' }));
    const skIds = [...new Set([...st.skills, ...RALPH_BASELINE_SKILLS])];
    skWrap.append(...skIds.map((id) => toggleChip(id, st.skills, id, descOf(id))));

    // Tool chips from the connected MCP capabilities.
    const tlWrap = document.createElement('div'); tlWrap.className = 'ralph-field';
    tlWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'tools' }));
    tlWrap.append(...ralphMcpTools.map((id) => toggleChip(id, st.tools, id, 'MCP tool')));

    // Planned generated media for this story (read-only here — edit in the web app).
    const planned = (st.media && typeof st.media === 'object')
      ? ['image', 'video', 'audio'].filter((k) => st.media[k] > 0).map((k) => `${k} ×${st.media[k]}`)
      : [];
    const extra = [];
    if (planned.length) {
      const mdWrap = document.createElement('div'); mdWrap.className = 'ralph-field';
      mdWrap.append(Object.assign(document.createElement('span'), { className: 'ralph-field-label', textContent: 'media' }));
      mdWrap.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: planned.join(', ') }));
      extra.push(mdWrap);
    }

    row.append(head, outWrap, skWrap, tlWrap, ...extra);
    return row;
  }));
  ralphConfirmDlg.showModal();
}

ralphConfirmForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'back') {
    e.preventDefault(); ralphConfirmDlg.close(); ralphDlg.showModal(); return;
  }
  e.preventDefault();
  if (!ralphPending) return;
  ralphConfirmError.hidden = true;
  const goBtn = document.getElementById('ralph-confirm-go');
  goBtn.disabled = true; goBtn.textContent = 'Starting…';
  try {
    ralphPending.assetToken = ralphAssetToken; // brand uploads staged during clarify
    const res = await fetch('/api/ralph/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ralphPending),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    ralphConfirmDlg.close();
    openRalphStatus(data.project || ralphPending.project); // server may have slugified the name
    loadProjectsPanel();
  } catch (err) {
    ralphConfirmError.textContent = err.message; ralphConfirmError.hidden = false;
  } finally {
    goBtn.disabled = false; goBtn.textContent = 'Confirm & build';
  }
});

const RALPH_PHASE_LABEL = {
  building: 'Building & reviewing stories…',
  finalizing: 'Master finalizing & testing…',
  delivering: '📦 Building the APK & uploading to Drive…',
  'windows-delivering': '🪟 Building the Windows package on GitHub Actions… (~10–15 min)',
  done: '✅ Done — pushed to GitHub',
  failed: '❌ Build failed',
  push_failed: '⚠️ Built, but the GitHub push failed',
};
const RALPH_BADGE = {
  todo: 'queued', building: 'building', review: 'in review',
  merged: 'merged', failed: 'failed', blocked: 'blocked',
};

function renderRalphStatus(s) {
  ralphStatusTitle.textContent = `Build: ${s.project}`;
  const timing = [];
  if (s.elapsedMs != null) timing.push(s.phase === 'done' ? `took ${fmtDur(s.elapsedMs)}` : `running ${fmtDur(s.elapsedMs)}`);
  if (s.etaMs != null) timing.push(`~${fmtDur(s.etaMs)} left`);
  ralphStatusPhase.textContent = (RALPH_PHASE_LABEL[s.phase] || s.phase) + (timing.length ? `  ·  ${timing.join(' · ')}` : '');
  ralphStatusPhase.className = 'ralph-phase ' + s.phase;
  // Attention: an agent failed — offer to switch the master and retry.
  if (s.attention) {
    const others = RALPH_AGENTS.filter(([k]) => k !== s.master && k !== 'glm'); // glm never master
    ralphStatusAttention.hidden = false;
    ralphStatusAttention.innerHTML =
      `<div class="attention"><div>⚠️ ${esc(s.attention.message)}</div>`
      + `<div class="attention-actions"><span class="muted">Switch master to:</span> `
      + others.map(([k, l]) => `<button type="button" class="btn small" data-swap="${esc(k)}">${esc(l)}</button>`).join(' ')
      + `</div></div>`;
    ralphStatusAttention.querySelectorAll('[data-swap]').forEach((b) => {
      b.onclick = () => { b.disabled = true; swapAgent(s.project, 'master', b.dataset.swap); };
    });
  } else { ralphStatusAttention.hidden = true; ralphStatusAttention.innerHTML = ''; }
  ralphStatusStories.replaceChildren(...(s.stories || []).map((st) => {
    const row = document.createElement('div');
    row.className = 'ralph-story';
    row.innerHTML =
      `<span class="badge ${esc(st.status)}">${RALPH_BADGE[st.status] || esc(st.status)}</span>` +
      `<span class="ralph-story-title">${esc(st.title)}</span>` +
      `<span class="tag">${esc(st.assignee)}</span>` +
      (st.iterations ? `<span class="muted">×${st.iterations}</span>` : '') +
      (st.revision ? `<span class="tag">↻ revision</span>` : '') +
      (st.startAt ? `<span class="tag">⏰ in ${fmtDur(Math.max(0, st.startAt - Date.now()))}</span>` : '') +
      (st.status === 'building' && st.progress ? `<span class="tag">🎬 ${esc(st.progress)}</span>` : '') +
      (st.error ? `<div class="ralph-story-err">${esc(st.error)}</div>` : '');
    return row;
  }));
  const repoHtml = s.repo
    ? (/^https?:/.test(s.repo)
      ? `Repo: <a href="${esc(s.repo)}" target="_blank" rel="noopener">${esc(s.repo)}</a>`
      : `Pushing to ${esc(s.repo)}`)
    : '';
  const warnHtml = s.pushWarning ? `<span class="ralph-story-err">⚠️ ${esc(s.pushWarning)}</span>` : '';
  const previewHtml = s.previewUrl
    ? `🌐 <a class="b" href="${esc(s.previewUrl)}" target="_blank" rel="noopener">Open live / files ↗</a> <span class="muted">${esc(s.previewUrl)}</span>`
    : '';
  const mediaReportHtml = s.mediaReport
    ? (() => {
      const mr = s.mediaReport;
      return mr.ok
        ? `🎬 Media outputs verified (${mr.outputs.length} platform renders)`
        : `⚠️ Media outputs: ${[...mr.missing.map((p) => `missing ${esc(p)}`), ...mr.outputs.filter((o) => !o.ok).map((o) => `${esc(o.platform)}: ${esc(o.issues[0] || 'unspecified issue')}`)].join('; ')}`;
    })()
    : '';
  // Windows installer (web-app builds): ready link + QR, or the build trigger.
  const win = s.windows && s.windows.installer;
  const winReady = win && win.shareLink
    ? `🪟 <a class="b" href="${esc(win.shareLink)}" target="_blank" rel="noopener">Download Windows installer ↗</a>`
      + (win.qr ? `<br><img src="${esc(win.qr)}" alt="Scan to download the Windows installer" width="120" height="120" style="background:#fff;padding:4px;border-radius:8px">` : '')
    : '';
  const winWarn = win && win.deliverWarning ? `<span class="ralph-story-err">⚠️ Windows installer: ${esc(win.deliverWarning)}</span>` : '';
  // Microsoft Store package (Phase 3): ready link, or the packaging/submission triggers.
  const store = s.windows && s.windows.store;
  const storeReady = store && store.shareLink
    ? `🏪 <a class="b" href="${esc(store.shareLink)}" target="_blank" rel="noopener">Download Store package ↗</a> <span class="muted">unsigned appx — upload in Partner Center (SUBMISSION-WINDOWS.md)</span>`
    : '';
  const storeWarn = store && store.deliverWarning ? `<span class="ralph-story-err">⚠️ Store package: ${esc(store.deliverWarning)}</span>` : '';
  const isDoneWeb = s.outputFormat === 'web-app' && s.phase === 'done';
  const winBtn = isDoneWeb
    ? `<button type="button" class="btn small" data-win-installer>${win && win.shareLink ? '🪟 Rebuild Windows installer' : '🪟 Build Windows installer'}</button>`
      + ` <button type="button" class="btn small" data-win-store>${store && store.shareLink ? '🏪 Rebuild Store package' : '🏪 Build Store package'}</button>`
      + (store ? ` <button type="button" class="btn small" data-win-submit>🏬 Submit to Store</button>` : '')
    : '';
  const lines = [previewHtml, mediaReportHtml, winReady, winWarn, storeReady, storeWarn, repoHtml, warnHtml, winBtn].filter(Boolean);
  if (lines.length) {
    ralphStatusRepo.hidden = false;
    ralphStatusRepo.innerHTML = lines.join('<br>');
    ralphStatusRepo.querySelector('[data-win-installer]')?.addEventListener('click', () => openWinInstallerDialog(s.project));
    ralphStatusRepo.querySelector('[data-win-store]')?.addEventListener('click', () => openWinStoreDialog(s.project));
    ralphStatusRepo.querySelector('[data-win-submit]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const res = await fetch('/api/ralph/windows/submit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: s.project }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'failed');
        alert(d.message || 'Submission checklist pushed.');
      } catch (err) { alert(`Store submission prep failed: ${err.message}`); }
      finally { e.target.disabled = false; }
    });
  } else { ralphStatusRepo.hidden = true; }
}

// ---- Windows installer (web-app → Tauri, built off-box on GitHub Actions) ----
const winInstallerDlg = document.getElementById('win-installer-dlg');
function openWinInstallerDialog(project) {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, '');
  document.getElementById('win-appid').placeholder = `com.webtmux.${slug || 'app'}`;
  document.getElementById('win-product').placeholder = project;
  document.getElementById('win-err').hidden = true;
  winInstallerDlg.showModal();
  document.getElementById('win-cancel').onclick = () => winInstallerDlg.close();
  document.getElementById('win-start').onclick = async () => {
    const btn = document.getElementById('win-start');
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const body = { project };
      const appId = document.getElementById('win-appid').value.trim();
      const productName = document.getElementById('win-product').value.trim();
      const version = document.getElementById('win-version').value.trim();
      if (appId) body.appId = appId;
      if (productName) body.productName = productName;
      if (version) body.version = version;
      const res = await fetch('/api/ralph/windows/installer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'failed to start the installer build');
      winInstallerDlg.close();
      pollRalphStatus(project); // phase is windows-delivering now — resume polling
      if (!ralphPollTimer) ralphPollTimer = setInterval(() => pollRalphStatus(project), 3000);
    } catch (err) {
      const el = document.getElementById('win-err');
      el.textContent = `⚠️ ${err.message}`; el.hidden = false;
    } finally { btn.disabled = false; btn.textContent = 'Scaffold & push'; }
  };
}

// ---- Microsoft Store package (Phase 3): electron appx on Actions, or pwa manual checklist ----
const winStoreDlg = document.getElementById('win-store-dlg');
function openWinStoreDialog(project) {
  document.getElementById('ws-err').hidden = true;
  winStoreDlg.showModal();
  document.getElementById('ws-cancel').onclick = () => winStoreDlg.close();
  document.getElementById('ws-start').onclick = async () => {
    const btn = document.getElementById('ws-start');
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const body = { project, packaging: document.getElementById('ws-packaging').value };
      for (const [id, key] of [['ws-identity', 'identityName'], ['ws-publisher', 'publisher'], ['ws-pubname', 'publisherDisplayName'], ['ws-version', 'version']]) {
        const v = document.getElementById(id).value.trim();
        if (v) body[key] = v;
      }
      const res = await fetch('/api/ralph/windows/store', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'failed to start the Store packaging');
      winStoreDlg.close();
      if (d.message) alert(d.message);
      pollRalphStatus(project); // electron path is windows-delivering now — resume polling
      if (!ralphPollTimer) ralphPollTimer = setInterval(() => pollRalphStatus(project), 3000);
    } catch (err) {
      const el = document.getElementById('ws-err');
      el.textContent = `⚠️ ${err.message}`; el.hidden = false;
    } finally { btn.disabled = false; btn.textContent = 'Start'; }
  };
}

async function pollRalphStatus(project) {
  try {
    const res = await fetch(`/api/ralph/status?project=${encodeURIComponent(project)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const s = await res.json();
    renderRalphStatus(s);
    if (['done', 'failed', 'push_failed'].includes(s.phase) && ralphPollTimer) {
      clearInterval(ralphPollTimer); ralphPollTimer = null;
    }
  } catch { /* transient; keep polling */ }
}

function openRalphStatus(project) {
  if (ralphPollTimer) clearInterval(ralphPollTimer);
  ralphStatusStories.innerHTML = '<p class="hint">Loading…</p>';
  ralphStatusPhase.textContent = ''; ralphStatusRepo.hidden = true;
  ralphStatusDlg.showModal();
  pollRalphStatus(project);
  ralphPollTimer = setInterval(() => pollRalphStatus(project), 3000);
}
ralphStatusDlg.addEventListener('close', () => {
  if (ralphPollTimer) { clearInterval(ralphPollTimer); ralphPollTimer = null; }
});

document.getElementById('ralph-btn').onclick = openRalphDialog;

// ---- Builds gallery: a detail card per project, with live + repo links --------
const ralphBuildsDlg = document.getElementById('ralph-builds-dlg');
const ralphBuildsList = document.getElementById('ralph-builds-list');
const RALPH_PHASE_SHORT = { building: 'building', finalizing: 'finalizing', done: 'done', failed: 'failed', push_failed: 'push failed' };
const RALPH_PHASE_BADGE = { done: 'merged', failed: 'failed', push_failed: 'failed', building: 'building', finalizing: 'building' };

function buildCard(s) {
  const total = (s.stories || []).length;
  const merged = (s.stories || []).filter((x) => x.status === 'merged').length;
  const card = document.createElement('div');
  card.className = 'build-card';
  const live = s.previewUrl
    ? `<a class="btn small" href="${esc(s.previewUrl)}" target="_blank" rel="noopener">🌐 Open</a>`
    : '<span class="muted" title="project name is not URL-safe">no live link</span>';
  const repo = s.repo && /^https?:/.test(s.repo)
    ? `<a class="btn small" href="${esc(s.repo)}" target="_blank" rel="noopener">Repo ↗</a>` : '';
  // A failed (or push-failed) run gets a Doctor button: one click diagnoses and auto-treats it.
  const doctor = ['failed', 'push_failed'].includes(s.phase)
    ? '<button type="button" class="btn small" data-doctor title="Diagnose the failure and auto-fix">🩺 Doctor</button>' : '';
  const timing = s.etaMs != null ? ` · ~${fmtDur(s.etaMs)} left`
    : (s.phase === 'done' && s.elapsedMs != null ? ` · took ${fmtDur(s.elapsedMs)}` : '');
  card.innerHTML =
    `<div class="build-head"><span class="b">${esc(s.project)}</span>`
    + `<span class="badge ${RALPH_PHASE_BADGE[s.phase] || ''}">${esc(RALPH_PHASE_SHORT[s.phase] || s.phase)}</span></div>`
    + `<div class="muted build-sub">master ${esc(s.master)} · ${merged}/${total} merged${timing}</div>`
    + `<div class="build-actions">${live} ${repo} ${doctor} <button type="button" class="btn small" data-details>Details</button>`
    + `<button type="button" class="btn small" data-rc title="Pair a phone to supervise">📱 Remote</button>`
    + `<button type="button" class="btn small danger" data-del>🗑 Delete</button></div>`;
  card.querySelector('[data-details]').onclick = () => { ralphBuildsDlg.close(); openRalphStatus(s.project); };
  card.querySelector('[data-rc]').onclick = () => openRcDialog(s.project);
  card.querySelector('[data-del]').onclick = () => deleteProject(s.project, openRalphBuilds);
  card.querySelector('[data-doctor]')?.addEventListener('click', () => doctorProject(s.project, card));
  return card;
}

async function openRalphBuilds() {
  ralphBuildsList.innerHTML = '<p class="hint">Loading…</p>';
  ralphBuildsDlg.showModal();
  try {
    const { runs = [] } = await (await fetch('/api/ralph/status', { cache: 'no-store' })).json();
    if (!runs.length) { ralphBuildsList.innerHTML = '<p class="hint">No builds yet — start one with 🤖 Ralph.</p>'; return; }
    ralphBuildsList.replaceChildren(...runs.map(buildCard));
  } catch { ralphBuildsList.innerHTML = '<p class="hint">Could not load builds.</p>'; }
}
document.getElementById('ralph-builds-btn').onclick = openRalphBuilds;

async function openRcDialog(project) {
  const dlg = document.getElementById('rc-dialog');
  document.getElementById('rc-qr').innerHTML = '';
  document.getElementById('rc-qr-hint').textContent = 'Generating…';
  try {
    const { url, expiresInMs } = await (await fetch('/api/rc/pair-token', { method: 'POST' })).json();
    new window.QRCode(document.getElementById('rc-qr'), { text: url, width: 220, height: 220 });
    document.getElementById('rc-qr-hint').textContent = `QR valid ~${Math.round(expiresInMs / 60000)} min. Pairing covers all your projects.`;
  } catch (e) { document.getElementById('rc-qr-hint').textContent = 'Failed to create pairing code.'; }
  await renderRcDevices();
  dlg.showModal();
}
async function renderRcDevices() {
  const wrap = document.getElementById('rc-devices');
  try {
    const { devices = [] } = await (await fetch('/api/rc/devices')).json();
    wrap.innerHTML = devices.length ? devices.map((d) =>
      `<div class="row"><span>${esc(d.label || 'device')} · seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never'}</span>`
      + `<button type="button" class="btn small danger" data-revoke="${esc(d.id)}">Revoke</button></div>`).join('')
      : '<p class="muted">No paired devices.</p>';
    wrap.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
      await fetch(`/api/rc/devices/${b.dataset.revoke}`, { method: 'DELETE' }); renderRcDevices();
    });
  } catch { wrap.innerHTML = '<p class="muted">Could not load devices.</p>'; }
}
document.getElementById('rc-close').onclick = () => document.getElementById('rc-dialog').close();

// ---- Brownfield: adopt an existing project (directory picker + research/instruct) ----
let adoptCwd = '';
let adoptMode = 'local';
function setAdoptMode(mode) {
  adoptMode = mode;
  document.getElementById('adopt-mode-local').classList.toggle('primary', mode === 'local');
  document.getElementById('adopt-mode-ssh').classList.toggle('primary', mode === 'ssh');
  document.getElementById('adopt-host-row').hidden = mode !== 'ssh';
  adoptCwd = '';
  document.getElementById('adopt-cwd').textContent = '';
  if (mode === 'ssh') loadAdoptHosts(); else browseAdopt('');
}
document.getElementById('adopt-mode-local').onclick = () => setAdoptMode('local');
document.getElementById('adopt-mode-ssh').onclick = () => setAdoptMode('ssh');

async function loadAdoptHosts() {
  const sel = document.getElementById('adopt-host');
  const err = document.getElementById('adopt-err'); err.hidden = true;
  let hosts = [];
  try { hosts = (await (await fetch('/api/ssh-hosts')).json()).hosts || []; }
  catch { err.textContent = 'Could not load SSH hosts.'; err.hidden = false; return; }
  if (!hosts.length) {
    sel.innerHTML = '';
    document.getElementById('adopt-list').innerHTML = '<div class="muted" style="padding:10px">No SSH hosts in ~/.ssh/config — add a Host block on the server first.</div>';
    return;
  }
  sel.innerHTML = hosts.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
  sel.onchange = () => browseSsh('.');
  browseSsh('.');
}
async function browseSsh(p) {
  const host = document.getElementById('adopt-host').value;
  const err = document.getElementById('adopt-err'); err.hidden = true;
  let d;
  try { d = await (await fetch(`/api/ralph/ssh-list?host=${encodeURIComponent(host)}&path=${encodeURIComponent(p)}`)).json(); }
  catch { err.textContent = 'SSH browse failed.'; err.hidden = false; return; }
  if (d.error) { err.textContent = d.error; err.hidden = false; return; }
  adoptCwd = d.path;
  document.getElementById('adopt-cwd').textContent = `${host}:${d.path}`;
  const list = document.getElementById('adopt-list');
  const rows = [];
  if (d.parent) rows.push(`<div class="row adopt-row" data-go="${esc(d.parent)}" style="cursor:pointer;padding:6px 10px">⬆ up</div>`);
  for (const dir of d.dirs) rows.push(`<div class="row adopt-row" data-go="${esc(dir.path)}" style="cursor:pointer;padding:6px 10px">📁 ${esc(dir.name)}</div>`);
  list.innerHTML = rows.join('') || '<div class="muted" style="padding:10px">No subdirectories.</div>';
  list.querySelectorAll('[data-go]').forEach((r) => r.onclick = () => browseSsh(r.dataset.go));
}

function openAdoptDialog() {
  document.getElementById('adopt-err').hidden = true;
  document.getElementById('adopt-name').value = '';
  setAdoptMode('local');         // resets + calls browseAdopt('')
  document.getElementById('adopt-dialog').showModal();
}
async function browseAdopt(path) {
  const err = document.getElementById('adopt-err'); err.hidden = true;
  let d;
  try { d = await (await fetch(`/api/ralph/fs-list?path=${encodeURIComponent(path)}`)).json(); }
  catch { err.textContent = 'Could not list that directory.'; err.hidden = false; return; }
  if (d.error) { err.textContent = d.error; err.hidden = false; return; }
  adoptCwd = d.path;
  document.getElementById('adopt-cwd').textContent = d.path;
  const list = document.getElementById('adopt-list');
  const rows = [];
  if (d.parent) rows.push(`<div class="row adopt-row" data-go="${esc(d.parent)}" style="cursor:pointer;padding:6px 10px">⬆ up</div>`);
  for (const dir of d.dirs) rows.push(`<div class="row adopt-row" data-go="${esc(dir.path)}" style="cursor:pointer;padding:6px 10px">📁 ${esc(dir.name)}</div>`);
  list.innerHTML = rows.join('') || '<div class="muted" style="padding:10px">No subdirectories.</div>';
  list.querySelectorAll('[data-go]').forEach((r) => r.onclick = () => browseAdopt(r.dataset.go));
}
document.getElementById('adopt-open').onclick = openAdoptDialog;
document.getElementById('maint-open')?.addEventListener('click', async () => {
  if (!confirm('Open a ROOT maintenance shell? You will have full system privilege. Sudo is withdrawn when you close the session.')) return;
  try {
    const r = await fetch('/api/maint-shell', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed to open');
    location.href = `/term?s=${encodeURIComponent(d.session)}`; // same as the session-open path (dashboard.js)
  } catch (e) { alert(`Maintenance shell: ${e.message}`); }
});
document.getElementById('adopt-cancel').onclick = () => document.getElementById('adopt-dialog').close();
document.getElementById('adopt-go').onclick = async () => {
  const project = document.getElementById('adopt-name').value.trim();
  const master = document.getElementById('adopt-master').value;
  const err = document.getElementById('adopt-err');
  if (!project) { err.textContent = 'Enter a project name.'; err.hidden = false; return; }
  const source = adoptMode === 'ssh'
    ? { type: 'ssh', host: document.getElementById('adopt-host').value, path: adoptCwd }
    : { type: 'local', path: adoptCwd };
  try {
    const r = await fetch('/api/ralph/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, source, master, workers: [] }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'adopt failed');
    document.getElementById('adopt-dialog').close();
    pollResearch(d.project);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
};
async function pollResearch(project) {
  const dlg = document.getElementById('research-dialog');
  document.getElementById('research-project').textContent = project;
  document.getElementById('research-md').textContent = 'Researching the codebase…';
  document.getElementById('instruct-idea').value = '';
  document.getElementById('instruct-err').hidden = true;
  dlg.showModal();
  const tick = async () => {
    if (!dlg.open) return;
    const d = await (await fetch(`/api/ralph/research?project=${encodeURIComponent(project)}`)).json().catch(() => ({}));
    if (d.phase === 'awaiting') { document.getElementById('research-md').textContent = d.research || '(no summary)'; return; }
    if (d.phase && d.phase !== 'researching') { document.getElementById('research-md').textContent = `Run is "${d.phase}".`; return; }
    setTimeout(tick, 3000);
  };
  tick();
  document.getElementById('research-close').onclick = () => dlg.close();
  document.getElementById('instruct-go').onclick = async () => {
    const idea = document.getElementById('instruct-idea').value.trim();
    const err = document.getElementById('instruct-err');
    try {
      const r = await fetch('/api/ralph/instruct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, idea }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'instruct failed');
      dlg.close();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
}

