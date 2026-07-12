import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { go } from '../App.jsx';

const PHASE = {
  done: 'bg-ok/15 text-ok',
  building: 'bg-accent/15 text-accent',
  finalizing: 'bg-accent/15 text-accent',
  failed: 'bg-danger/15 text-danger',
  push_failed: 'bg-danger/15 text-danger',
};
const STATUS = {
  merged: 'text-ok', building: 'text-accent', reviewing: 'text-accent',
  failed: 'text-danger', blocked: 'text-danger', pending: 'text-muted',
  queued: 'text-muted', reverted: 'text-muted', skipped: 'text-muted',
};
const STATUS_DOT = {
  merged: 'bg-ok', building: 'bg-accent', reviewing: 'bg-accent',
  failed: 'bg-danger', blocked: 'bg-danger', pending: 'bg-muted',
  queued: 'bg-muted', reverted: 'bg-muted', skipped: 'bg-muted',
};

// Friendly label for a tmux session that belongs to this build. Multi-tenant
// sessions carry a `wt_<user>-` prefix (the tenant's OS user) — strip it first.
function sessionLabel(name, project) {
  const n = name.replace(/^wt_[a-z0-9]+-/, '');
  const alnum = project.replace(/[^A-Za-z0-9]/g, '');
  if (n === `app-${alnum}` || n === `app-${project}`) return '🌐 preview server';
  const m = n.match(/^(r|rv|rf)-/);
  const kind = m ? { r: '🛠 worker', rv: '🔎 review', rf: '✅ finalize' }[m[1]] : '·';
  const tail = n.replace(/^(r|rv|rf)-[A-Za-z0-9]*-?/, '');
  return `${kind}${tail ? ' · ' + tail : ''}`;
}

// ---- Activity feed -----------------------------------------------------------
// The build as a story: one line per event, newest first, refreshed by the same
// 4s run poll. The waiting screen becomes "watching your team work".
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ActivityFeed({ events, phase }) {
  const list = [...events].reverse();
  return (
    <div className="card max-h-[65vh] overflow-y-auto">
      {(phase === 'building' || phase === 'finalizing') && (
        <p className="mb-3 flex items-center gap-2 text-xs text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          Your agents are working — this feed updates live.
        </p>
      )}
      {list.length === 0 && <p className="text-sm text-muted">Waiting for the first event…</p>}
      <ol className="space-y-2.5">
        {list.map((e, i) => (
          <li key={`${e.at}-${i}`} className="flex items-start gap-3 text-sm">
            <span className="mt-0.5 shrink-0 font-mono text-[11px] text-slate-400">{fmtTime(e.at)}</span>
            <span className={i === 0 ? 'text-slate-900' : 'text-slate-600'}>{e.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- Story dialog (edit / regenerate / add) ---------------------------------
// One dialog for all three story mutations. Edit stops the in-flight attempt
// and re-queues; regenerate rebuilds a merged story on top of the current app
// (the Revise machinery); add queues a hand-written story with no planner call.
// Same deliberate client-side mirror as the PWA's RALPH_AGENTS — the server
// re-validates against VALID_AGENTS either way.
const ALL_AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'kimi', 'grok', 'vibe', 'glm'];

// "2h" / "30m" / "1d" (relative) or "22:00" (next occurrence) -> epoch ms.
// '' -> null (start now). Unparseable -> NaN (caller shows the inline error).
function parseStartInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i.exec(s);
  if (rel) {
    const u = rel[2][0].toLowerCase();
    return Date.now() + Number(rel[1]) * (u === 'm' ? 60_000 : u === 'd' ? 86_400_000 : 3_600_000);
  }
  const abs = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (abs) {
    const d = new Date(); d.setHours(+abs[1], +abs[2], 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return NaN;
}
const fmtIn = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };

const DIALOG_COPY = {
  edit: { title: (id) => `✏ Edit ${id}`, note: 'Saving stops the current attempt and rebuilds this story with the new instructions.', cta: 'Save & rebuild story' },
  regenerate: { title: (id) => `↻ Regenerate ${id}`, note: 'Rebuilds this story on top of the current app using your edited instructions, then re-checks and re-publishes the build. The previous version stays in git history — use Revert instead if you just want it gone.', cta: 'Regenerate story' },
  add: { title: () => '＋ Add story', note: 'Describe one self-contained change. It builds like any other story — on a finished build the agent changes the existing app rather than starting over.', cta: 'Add & build' },
};
function StoryDialog({ project, story, mode, defaultAgent, onClose, onSaved }) {
  const [title, setTitle] = useState(story?.title || '');
  const [description, setDescription] = useState(story?.description || '');
  const [criteria, setCriteria] = useState((story?.acceptanceCriteria || []).join('\n'));
  const [agent, setAgent] = useState(story?.assignee || defaultAgent || 'claude');
  const [startRaw, setStartRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const C = DIALOG_COPY[mode];

  async function save() {
    const startAt = parseStartInput(startRaw);
    if (Number.isNaN(startAt)) { setErr("Couldn't read that time — use 2h, 30m, 1d, or a clock time like 22:00."); return; }
    setBusy(true); setErr('');
    const body = {
      title, description,
      acceptanceCriteria: criteria.split('\n').map((c) => c.trim()).filter(Boolean),
      ...(startAt !== null ? { startAt } : {}),
    };
    try {
      if (mode === 'add') await api.addStory(project, { ...body, agent });
      else await api.editStory(project, story.id, { ...body, agent: agent !== story.assignee ? agent : undefined });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-slate-900/30 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold">{C.title(story?.id)}</h3>
        <p className="mt-1 text-xs text-muted">{C.note}{mode === 'edit' && story?.status === 'building' ? ' (it is building right now)' : ''}</p>
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
        <div className="mt-3 space-y-3">
          <div><label className="label">Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><label className="label">Instructions</label>
            <textarea className="input min-h-[110px]" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div><label className="label">Acceptance criteria (one per line)</label>
            <textarea className="input min-h-[80px] font-mono text-xs" value={criteria} onChange={(e) => setCriteria(e.target.value)} /></div>
          <div><label className="label">Agent</label>
            <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
              {ALL_AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select></div>
          <div><label className="label">Start (optional)</label>
            <input className="input" placeholder="now — or 2h, 30m, 1d, or 22:00" value={startRaw} onChange={(e) => setStartRaw(e.target.value)} />
            <p className="mt-1 text-[11px] text-muted">Runs on the server at that time — you don't need to keep this page open. Handy for off-peak hours on a subscription plan.</p></div>
        </div>
        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary flex-1" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Saving…' : C.cta}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Master log panel -----------------------------------------------------
// The master's logbook: status board, design rulings, mid-build steering, and
// learnings — the supervisor's working memory, refreshed while the build runs.
function MasterLogPanel({ project }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => api.masterLog(project).then((d) => { if (on) setLog(d.log); }).catch((e) => { if (on) setLog(`(no log: ${e.message})`); });
    load();
    const t = setInterval(load, 8000);
    return () => { on = false; clearInterval(t); };
  }, [project]);
  return (
    <div className="card max-h-[65vh] overflow-y-auto">
      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-700">{log ?? 'Loading…'}</pre>
    </div>
  );
}

// ---- Revise / Chat panel ------------------------------------------------
function RevisePanel({ project, onRevised }) {
  const [messages, setMessages] = useState([
    { role: 'ai', text: "Build is finished. Describe a change or addition and I'll plan new stories for it." },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const res = await api.revise(project, text);
      const added = (res.stories || []).filter((s) => s.status === 'todo').length;
      setMessages((m) => [...m, {
        role: 'ai',
        text: added > 0
          ? `Added ${added} new stor${added === 1 ? 'y' : 'ies'} to the build. The run is resuming now.`
          : 'Revision planned. The run is resuming.',
      }]);
      onRevised?.();
    } catch (e) {
      setMessages((m) => [...m, { role: 'ai', text: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col rounded-2xl border border-border bg-panel shadow-card overflow-hidden" style={{ minHeight: '320px', maxHeight: '420px' }}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Refine / Revise</span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}>
            {m.text}
          </div>
        ))}
        {busy && (
          <div className="chat-bubble-ai opacity-60">Planning…</div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-border px-3 py-3 flex gap-2">
        <input
          className="input flex-1 text-sm"
          placeholder="Describe a change or new feature…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={busy}
        />
        <button className="btn-primary px-4 py-2 text-sm" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

// ---- Version history timeline -------------------------------------------
function HistoryTimeline({ run, project, onReverted }) {
  const [reverting, setReverting] = useState(null);
  const [err, setErr] = useState('');
  const canRevert = run.phase !== 'building' && run.phase !== 'finalizing';

  const stories = [...(run.stories || [])].reverse(); // most recent first

  async function revert(storyId) {
    if (!canRevert) return;
    setErr('');
    setReverting(storyId);
    try {
      await api.revert(project, storyId);
      onReverted?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setReverting(null);
    }
  }

  return (
    <div>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Version history</h2>
      {err && <div className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger">{err}</div>}
      <div className="relative space-y-0">
        {/* vertical line */}
        <div className="absolute left-[5px] top-3 bottom-3 w-px bg-border" />
        {stories.map((s) => {
          const dotCls = STATUS_DOT[s.status] || 'bg-muted';
          const merged = s.status === 'merged';
          const reverted = s.status === 'reverted';
          return (
            <div key={s.id} className="flex items-start gap-3 pb-4 pl-1">
              {/* dot */}
              <div className={`timeline-dot mt-1.5 shrink-0 ${dotCls}`} />
              <div className="flex flex-1 items-start justify-between gap-2 min-w-0">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-700 truncate">{s.id} · {s.title}</p>
                  <p className={`mt-0.5 text-[11px] ${STATUS[s.status] || 'text-muted'}`}>
                    {reverted ? 'reverted' : s.status}
                    {s.assignee ? ` · ${s.assignee}` : ''}
                    {s.iterations ? ` · ${s.iterations} iter` : ''}
                  </p>
                </div>
                {merged && (
                  <button
                    className="btn-danger shrink-0 px-2 py-1 text-[11px]"
                    disabled={!canRevert || reverting === s.id}
                    onClick={() => revert(s.id)}
                    title="Revert this story's merge commit"
                  >
                    {reverting === s.id ? '…' : 'Revert'}
                  </button>
                )}
                {reverted && (
                  <span className="shrink-0 text-[11px] text-muted italic">reverted</span>
                )}
              </div>
            </div>
          );
        })}
        {stories.length === 0 && <p className="pl-4 text-xs text-muted">No stories yet.</p>}
      </div>
      {!canRevert && <p className="mt-1 text-[11px] text-muted italic">Revert is available once the build finishes.</p>}
    </div>
  );
}

// ---- Main page ----------------------------------------------------------
export default function BuildDetail({ project }) {
  const [run, setRun] = useState(null);
  const [err, setErr] = useState('');
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null); // selected session name
  const [diag, setDiag] = useState(null);
  // Tab: 'terminal' | 'history' | 'revise'
  const [tab, setTab] = useState('activity');

  const load = () => {
    api.build(project).then(setRun).catch((e) => setErr(e.message));
    api.sessions().then((all) => setSessions(all.filter((s) => s.project === project)));
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [project]);

  // Auto-pick the most-recently-active session once they load.
  useEffect(() => {
    if (!active && sessions.length) {
      const best = [...sessions].sort((a, b) => (b.activity || 0) - (a.activity || 0))[0];
      setActive(best.name);
    }
    if (active && sessions.length && !sessions.find((s) => s.name === active)) {
      setActive(sessions[0]?.name || null);
    }
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = run?.stories?.length || 0;
  const merged = run?.stories?.filter((s) => s.status === 'merged').length || 0;
  const failed = run && (run.phase === 'failed' || run.phase === 'push_failed');
  const isDone = run?.phase === 'done';
  const delivering = run?.phase === 'delivering';

  async function doctor() {
    setDiag({ text: 'Diagnosing…' });
    try { const d = await api.doctor(project); setDiag({ text: d.diagnosis, treatments: d.treatments }); load(); }
    catch (e) { setDiag({ text: `Doctor failed: ${e.message}` }); }
  }

  const building = run?.phase === 'building' || run?.phase === 'finalizing';
  const [dialog, setDialog] = useState(null); // { mode: 'edit'|'regenerate'|'add', story } | null
  const [submitting, setSubmitting] = useState(false);
  const [winDlg, setWinDlg] = useState(false);
  const [winForm, setWinForm] = useState({ appId: '', productName: '', version: '1.0.0' });
  async function buildWindows() {
    setSubmitting('windows'); setWinDlg(false);
    try {
      const r = await api.windowsInstaller(project, {
        appId: winForm.appId.trim() || undefined,
        productName: winForm.productName.trim() || undefined,
        version: winForm.version.trim() || undefined,
      });
      setDiag({ text: r.message || 'Windows installer scaffolded — run the "Windows Package" Action, then download the installer.' });
      load();
    } catch (e) { setDiag({ text: e.message, error: true }); }
    finally { setSubmitting(false); }
  }
  const [storeDlg, setStoreDlg] = useState(false);
  const [storeForm, setStoreForm] = useState({ packaging: 'electron', identityName: '', publisher: '', publisherDisplayName: '', version: '1.0.0' });
  async function buildStore() {
    setSubmitting('store'); setStoreDlg(false);
    try {
      const r = await api.windowsStore(project, {
        packaging: storeForm.packaging,
        identityName: storeForm.identityName.trim() || undefined,
        publisher: storeForm.publisher.trim() || undefined,
        publisherDisplayName: storeForm.publisherDisplayName.trim() || undefined,
        version: storeForm.version.trim() || undefined,
      });
      setDiag({ text: r.message || 'Store packaging started.' });
      load();
    } catch (e) { setDiag({ text: e.message, error: true }); }
    finally { setSubmitting(false); }
  }
  async function submitWindowsStore() {
    setSubmitting('winsubmit');
    try { const r = await api.windowsSubmit(project); setDiag({ text: r.message || 'Submission checklist pushed.' }); load(); }
    catch (e) { setDiag({ text: e.message, error: true }); }
    finally { setSubmitting(false); }
  }

  async function togglePause() {
    try { run.paused ? await api.resume(project) : await api.pause(project); load(); }
    catch (e) { setDiag({ text: e.message }); }
  }

  async function skip(s) {
    if (!window.confirm(`Skip ${s.id} "${s.title}"? The build continues without it (dependent stories proceed).`)) return;
    try { await api.skipStory(project, s.id); load(); }
    catch (e) { setDiag({ text: e.message }); }
  }

  async function removeBuild() {
    if (!window.confirm(`Delete "${project}"? This stops its sessions and permanently removes the files, preview, and build state. The GitHub repo (if any) is NOT deleted.`)) return;
    try { await api.deleteBuild(project); go('/app'); }
    catch (e) { setDiag({ text: `Delete failed: ${e.message}` }); }
  }

  // Scaffold a store submission (separate, user-triggered) for a finished Flutter app:
  // writes the proven CI config + checklist into the repo and pushes them. Play uses
  // GitHub Actions; iOS uses Codemagic (and needs a real bundle id).
  async function submitStore(store) {
    const opts = {};
    if (store === 'ios') {
      const bid = window.prompt('iOS bundle identifier (reverse-DNS, e.g. com.you.app). Blank = a placeholder you can edit later.', '');
      if (bid === null) return; // cancelled
      if (bid.trim()) opts.bundleId = bid.trim();
    }
    if (store === 'play') {
      const pkg = window.prompt('Android package name / applicationId (e.g. com.you.app) — sets the PLAY_PACKAGE_NAME variable. Leave blank to set it later in GitHub.', '');
      if (pkg === null) return; // cancelled
      if (pkg.trim()) opts.packageName = pkg.trim();
    }
    if (run.submit?.[store] && !window.confirm(`Re-scaffold the ${store === 'ios' ? 'iOS (Codemagic)' : 'Play'} submission config? This overwrites it in the repo.`)) return;
    setSubmitting(store);
    try { const r = await api.submit(project, store, opts); setDiag({ text: r.message || 'Submission scaffolded — see the repo.' }); load(); }
    catch (e) { setDiag({ text: `Submit failed: ${e.message}` }); }
    finally { setSubmitting(false); }
  }

  // On-demand APK: release Android build → Google Drive → shareable QR + link. Decoupled from
  // finishing the build (the web preview is already live); run this before "Submit to Play".
  async function makeApk() {
    if (!window.confirm('Build the installable APK and upload it to Google Drive? This runs a release Android build (a few minutes).')) return;
    setSubmitting('apk');
    try { await api.apk(project); setDiag({ text: 'Building the APK… this takes a few minutes; the install link + QR appear above when it is ready.' }); load(); }
    catch (e) { setDiag({ text: `APK build failed to start: ${e.message}` }); }
    finally { setSubmitting(false); }
  }

  const termSrc = useMemo(() => active ? `/term.html?s=${encodeURIComponent(active)}` : null, [active]);

  if (err) return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <button className="text-sm text-muted hover:text-slate-900" onClick={() => go('/app')}>← Builds</button>
      <div className="card mt-4 text-danger">{err}</div>
    </div>
  );
  if (!run) return <div className="grid h-full place-items-center text-muted">Loading…</div>;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Breadcrumb */}
      <div className="mb-5 flex items-center gap-3 text-sm text-muted">
        <button className="hover:text-slate-900" onClick={() => go('/app')}>← Builds</button>
        <span className="opacity-40">/</span>
        <span className="text-slate-700">{project}</span>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{project}</h1>
          <span className={`badge ${PHASE[run.phase] || 'bg-panel2 text-muted'}`}>{(() => {
            // A building run with nothing active and a future startAt is just
            // waiting on the clock — say so instead of a bare "building".
            const scheduled = run.stories.filter((s) => s.startAt && s.startAt > Date.now());
            if (run.phase === 'building' && scheduled.length && !run.stories.some((s) => ['building', 'review'].includes(s.status))) {
              const nextAt = Math.min(...scheduled.map((s) => s.startAt));
              return `building · waiting for a scheduled story (⏰ in ${fmtIn(nextAt - Date.now())})`;
            }
            return run.phase;
          })()}</span>
          {run.paused && <span className="badge bg-warn/15 text-warn">⏸ paused</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {run.previewUrl && <a className="btn-ghost px-3 py-1.5 text-xs" href={run.previewUrl} target="_blank" rel="noreferrer">🌐 Open preview</a>}
          {run.repo && <a className="btn-ghost px-3 py-1.5 text-xs" href={run.repo} target="_blank" rel="noreferrer">Repo ↗</a>}
          {isDone && run.apk?.shareLink && <a className="btn-ghost px-3 py-1.5 text-xs" href={run.apk.shareLink} target="_blank" rel="noreferrer">📲 Install APK</a>}
          {delivering && <span className="btn-ghost px-3 py-1.5 text-xs opacity-70">📦 Building APK…</span>}
          {run.outputFormat === 'web-app' && run.phase === 'windows-delivering' && (
            <span className="badge bg-panel2 text-muted">
              {run.windowsDeliverKind === 'store' ? '🏪 Building Store package on Actions…' : '🪟 Building installer on Actions…'}
            </span>
          )}
          {isDone && run.outputFormat === 'web-app' && (
            <>
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setWinDlg(true)} disabled={!!submitting}>
                {run.windows?.installer?.shareLink ? '🪟 Rebuild Windows installer' : (run.windows?.installer ? '🪟 Re-build Windows installer' : '🪟 Build Windows installer')}
              </button>
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setStoreDlg(true)} disabled={!!submitting}>
                {run.windows?.store?.shareLink ? '🏪 Rebuild Store package' : '🏪 Build Store package'}
              </button>
              {run.windows?.store && (
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={submitWindowsStore} disabled={!!submitting}>
                  {submitting === 'winsubmit' ? 'Preparing…' : (run.windows?.submit ? '🏬 Re-prep Store submission' : '🏬 Submit to Store')}
                </button>
              )}
            </>
          )}
          {isDone && run.outputFormat === 'flutter-app' && (
            <>
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={makeApk} disabled={!!submitting}>
                {submitting === 'apk' ? 'Starting…' : (run.apk?.shareLink ? '📦 Rebuild APK' : '📦 Create APK')}
              </button>
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => submitStore('play')} disabled={!!submitting}>
                {submitting === 'play' ? 'Submitting…' : (run.submit?.play ? '🏪 Re-scaffold Play' : '🏪 Submit to Play')}
              </button>
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => submitStore('ios')} disabled={!!submitting}>
                {submitting === 'ios' ? 'Submitting…' : (run.submit?.ios ? '🍏 Re-scaffold iOS' : '🍏 Submit to App Store')}
              </button>
            </>
          )}
          {failed && <button className="btn-primary px-3 py-1.5 text-xs" onClick={doctor}>🩺 Doctor</button>}
          {building && (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={togglePause}>
              {run.paused ? '▶ Resume' : '⏸ Pause'}
            </button>
          )}
          <button className="btn-danger px-3 py-1.5 text-xs" onClick={removeBuild}>🗑 Delete</button>
        </div>
      </div>
      <p className="mt-1 text-sm text-muted">
        master {run.master} · {merged}/{total} merged
        {run.etaMs ? ` · ~${Math.round(run.etaMs / 60000)}m left` : ''}
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: total ? `${(merged / total) * 100}%` : '0%' }} />
      </div>

      {run.windows?.installer?.shareLink && (
        <div className="mt-4 flex items-start gap-4 rounded-xl border border-border bg-panel2 p-4">
          {run.windows.installer.qr && <img src={run.windows.installer.qr} alt="Scan to download the Windows installer" className="h-24 w-24 shrink-0 rounded bg-white p-1" />}
          <div className="min-w-0">
            <p className="text-sm font-medium">🪟 Windows installer ready</p>
            <a className="mt-1 inline-block break-all text-accent hover:underline" href={run.windows.installer.shareLink} target="_blank" rel="noreferrer">{run.windows.installer.shareLink}</a>
            <p className="mt-1 text-xs text-muted">Download and run on Windows. Unsigned builds show a SmartScreen prompt until signed.</p>
          </div>
        </div>
      )}
      {isDone && run.windows?.installer?.deliverWarning && <p className="mt-3 text-xs text-warn">⚠️ Windows installer build issue: {run.windows.installer.deliverWarning}</p>}
      {run.windows?.store?.shareLink && (
        <div className="mt-4 flex items-start gap-4 rounded-xl border border-border bg-panel2 p-4">
          {run.windows.store.qr && <img src={run.windows.store.qr} alt="Scan to download the Store package" className="h-24 w-24 shrink-0 rounded bg-white p-1" />}
          <div className="min-w-0">
            <p className="text-sm font-medium">🏪 Microsoft Store package ready (unsigned appx — the Store re-signs it)</p>
            <a className="mt-1 inline-block break-all text-accent hover:underline" href={run.windows.store.shareLink} target="_blank" rel="noreferrer">{run.windows.store.shareLink}</a>
            <p className="mt-1 text-xs text-muted">Upload it in Partner Center → your app → Submission → Packages. Steps: SUBMISSION-WINDOWS.md in the repo.</p>
          </div>
        </div>
      )}
      {isDone && run.windows?.store?.deliverWarning && <p className="mt-3 text-xs text-warn">⚠️ Store package build issue: {run.windows.store.deliverWarning}</p>}
      {run.apk?.shareLink && (
        <div className="mt-4 flex items-center gap-4 rounded-lg border border-border bg-panel p-3">
          {run.apk.qr && <img src={run.apk.qr} alt="Scan to install the APK" className="h-24 w-24 shrink-0 rounded bg-white p-1" />}
          <div className="text-xs">
            <p className="font-medium text-slate-800">📲 Install on Android</p>
            <p className="mt-0.5 text-muted">Scan the QR with your phone, or open the link below.</p>
            <a className="mt-1 inline-block break-all text-accent hover:underline" href={run.apk.shareLink} target="_blank" rel="noreferrer">{run.apk.shareLink}</a>
          </div>
        </div>
      )}
      {delivering && <p className="mt-3 text-xs text-muted">📦 Building the APK and uploading to Drive… the install link + QR will appear here (a few minutes).</p>}
      {isDone && run.deliverWarning && <p className="mt-3 text-xs text-warn">⚠️ APK build issue: {run.deliverWarning}</p>}

      {/* Media outputs (social-video) — per-platform render verification */}
      {run.mediaReport && (
        <div className="card mt-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Media outputs {run.mediaReport.ok ? '✓' : '⚠'}</h3>
            {run.previewUrl && <a className="btn-ghost text-xs" href={run.previewUrl} target="_blank" rel="noreferrer">Preview gallery ↗</a>}
          </div>
          <table className="w-full text-xs mt-2">
            <tbody>
              {run.mediaReport.outputs.map((o) => (
                <tr key={o.file} className="border-t border-panel2">
                  <td className="py-1">{o.platform}</td>
                  <td className="py-1 opacity-70">{o.file}</td>
                  <td className="py-1">{o.ok ? '✓ verified' : `⚠ ${o.issues.join('; ')}`}</td>
                </tr>
              ))}
              {run.mediaReport.missing.map((p) => (
                <tr key={p} className="border-t border-panel2">
                  <td className="py-1">{p}</td><td className="py-1 opacity-70">—</td><td className="py-1">⚠ no render produced</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Main grid */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* Left column: stories + sessions */}
        <div className="space-y-6">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Stories</h2>
              {!['finalizing', 'delivering', 'windows-delivering', 'researching', 'awaiting'].includes(run.phase) && (
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setDialog({ mode: 'add', story: null })}>＋ Add story</button>
              )}
            </div>
            {['done', 'failed', 'push_failed'].includes(run.phase) && (
              <p className="mb-2 text-[11px] text-muted">Regenerate any story with new instructions, add a new one, or revert a merged one — the build re-checks and re-publishes itself afterwards.</p>
            )}
            <div className="space-y-2">
              {run.stories.map((s) => {
                const settled = ['merged', 'reverted', 'skipped'].includes(s.status);
                return (
                  <div key={s.id} className="card group py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{s.id}</p>
                      <span className={`text-xs ${STATUS[s.status] || 'text-muted'}`}>{s.status}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{s.title}</p>
                    <p className="mt-1 text-[11px] text-muted">{s.assignee}{s.iterations ? ` · ${s.iterations} iter` : ''}</p>
                    {s.status === 'building' && s.progress && (
                      <p className="mt-1 text-[11px] text-accent">🎬 {s.progress}</p>
                    )}
                    {!settled && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button className="btn-ghost px-2 py-0.5 text-[11px]" title="Edit instructions / change agent"
                          onClick={() => setDialog({ mode: 'edit', story: s })}>✏ Edit</button>
                        <button className="btn-ghost px-2 py-0.5 text-[11px]" title="Skip this story — the rest continue without it"
                          onClick={() => skip(s)}>⏭ Skip</button>
                      </div>
                    )}
                    {s.status === 'merged' && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button className="btn-ghost px-2 py-0.5 text-[11px]" title="Rebuild this story on the current app with new instructions"
                          onClick={() => setDialog({ mode: 'regenerate', story: s })}>↻ Regenerate</button>
                      </div>
                    )}
                    {s.startAt && (
                      <div className="mt-2 flex items-center gap-1.5" title={`Starts automatically at ${new Date(s.startAt).toLocaleString()}. "Start now" begins immediately; Skip abandons it.`}>
                        <span className="badge bg-panel2 text-muted">⏰ in {fmtIn(s.startAt - Date.now())}</span>
                        <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => api.editStory(project, s.id, { startAt: null }).then(load)}>▶ Start now</button>
                      </div>
                    )}
                    {s.revision && <span className="mt-1 inline-block text-[10px] text-muted">↻ revision</span>}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Live sessions</h2>
            {sessions.length === 0
              ? <p className="text-xs text-muted">No live tmux sessions for this build right now.</p>
              : <div className="space-y-1.5">
                  {sessions.map((s) => (
                    <button key={s.name} onClick={() => { setActive(s.name); setTab('terminal'); }}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${active === s.name && tab === 'terminal' ? 'border-accent bg-accent/10 text-slate-900' : 'border-border bg-panel hover:bg-panel2 text-muted'}`}>
                      <span className="flex items-center justify-between">
                        <span>{sessionLabel(s.name, project)}</span>
                        {s.attached && <span className="h-1.5 w-1.5 rounded-full bg-ok" title="attached" />}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] opacity-60">{s.name} · {s.command}</span>
                    </button>
                  ))}
                </div>}
          </div>
        </div>

        {/* Right column: tabbed panel */}
        <div className="flex flex-col gap-4">
          {/* Tab bar */}
          <div className="flex gap-1 rounded-xl border border-border bg-panel p-1 self-start">
            {[
              { id: 'activity', label: '⚡ Activity' },
              { id: 'preview', label: '🌐 Preview' },
              { id: 'terminal', label: '⌨ Terminal' },
              { id: 'log', label: '📋 Master log' },
              { id: 'history', label: '🕐 History' },
              { id: 'revise', label: '✏ Revise' },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${tab === t.id ? 'bg-accent/20 text-accent' : 'text-muted hover:text-slate-900'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Terminal tab */}
          {tab === 'terminal' && (
            <div className="overflow-hidden rounded-2xl border border-border bg-[#0d1117]">
              {termSrc
                ? <iframe key={active} title={`terminal ${active}`} src={termSrc} className="h-[65vh] w-full" />
                : <div className="grid h-[65vh] place-items-center px-6 text-center text-sm text-slate-400">
                    {isDone
                      ? 'Build finished — its worker sessions have exited. Open the preview to see the result.'
                      : 'Waiting for a session to attach to…'}
                  </div>}
            </div>
          )}

          {/* Activity feed tab */}
          {tab === 'activity' && <ActivityFeed events={run.events || []} phase={run.phase} />}

          {/* Live preview tab — reloads automatically on every merge */}
          {tab === 'preview' && (
            run.previewUrl && merged > 0
              ? <div className="overflow-hidden rounded-2xl border border-border bg-white">
                  <div className="flex items-center justify-between border-b border-border bg-panel2/60 px-3 py-1.5 text-xs text-muted">
                    <span>🌐 {run.previewUrl.replace('https://', '')} — updates as stories merge ({merged}/{total})</span>
                    <a className="text-accent hover:underline" href={run.previewUrl} target="_blank" rel="noreferrer">Open ↗</a>
                  </div>
                  <iframe key={merged} title="live preview" src={`${run.previewUrl}?v=${merged}`} className="h-[62vh] w-full" />
                </div>
              : <div className="card grid h-[62vh] place-items-center text-center text-sm text-muted">
                  <div>
                    <p className="text-2xl">🌱</p>
                    <p className="mt-2">Your live preview appears here after the first story merges.</p>
                  </div>
                </div>
          )}

          {/* Master log tab */}
          {tab === 'log' && <MasterLogPanel project={project} />}

          {/* History tab */}
          {tab === 'history' && (
            <div className="card">
              <HistoryTimeline run={run} project={project} onReverted={load} />
            </div>
          )}

          {/* Revise tab */}
          {tab === 'revise' && (
            isDone
              ? <RevisePanel project={project} onRevised={() => { load(); setTab('terminal'); }} />
              : <div className="card text-sm text-muted py-10 text-center">
                  Revision is available once the build finishes.
                </div>
          )}
        </div>
      </div>

      {/* Doctor modal */}
      {dialog && (
        <StoryDialog project={project} story={dialog.story} mode={dialog.mode} defaultAgent={run?.master}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); load(); }} />
      )}

      {diag && (
        <div className="fixed inset-0 grid place-items-center bg-slate-900/30 backdrop-blur-sm p-6" onClick={() => setDiag(null)}>
          <div className="card max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold">🩺 Doctor · {project}</h3>
            <p className="mt-2 text-sm text-slate-600">{diag.text}</p>
            {diag.treatments?.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-muted">
                {diag.treatments.map((t) => (
                  <li key={t.id}>{t.id} <span className="opacity-70">({t.cls})</span>{t.swapTo ? ` — reassigned ${t.swapFrom}→${t.swapTo}` : ''} — {t.remedy}</li>
                ))}
              </ul>
            )}
            <button className="btn-ghost mt-4 w-full" onClick={() => setDiag(null)}>Close</button>
          </div>
        </div>
      )}

      {winDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setWinDlg(false)}>
          <div className="w-full max-w-md rounded-xl bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">Build Windows installer</h3>
            <p className="mb-3 text-xs text-muted">Wraps the finished web app as a Tauri desktop installer, built on a GitHub Actions Windows runner. Leave blank for sensible defaults.</p>
            <label className="label">App identifier</label>
            <input className="input mb-3" placeholder={`com.webtmux.${(project || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '')}`}
              value={winForm.appId} onChange={(e) => setWinForm((f) => ({ ...f, appId: e.target.value }))} />
            <label className="label">Product name</label>
            <input className="input mb-3" placeholder={project} value={winForm.productName}
              onChange={(e) => setWinForm((f) => ({ ...f, productName: e.target.value }))} />
            <label className="label">Version</label>
            <input className="input mb-4" placeholder="1.0.0" value={winForm.version}
              onChange={(e) => setWinForm((f) => ({ ...f, version: e.target.value }))} />
            <div className="flex justify-end gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setWinDlg(false)}>Cancel</button>
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={buildWindows}>Scaffold & push</button>
            </div>
          </div>
        </div>
      )}

      {storeDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setStoreDlg(false)}>
          <div className="w-full max-w-md rounded-xl bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">Build Microsoft Store package</h3>
            <p className="mb-3 text-xs text-muted">
              Reserve the app in Partner Center first (free) and copy the three Product-identity values —
              or save them once in Settings → Microsoft Store. The package is unsigned; the Store re-signs it.
            </p>
            <label className="label">Packaging</label>
            <select className="input mb-3" value={storeForm.packaging}
              onChange={(e) => setStoreForm((f) => ({ ...f, packaging: e.target.value }))}>
              <option value="electron">Electron appx — automated on GitHub Actions</option>
              <option value="pwa">PWA via pwabuilder.com — leaner package, ~2 min manual</option>
            </select>
            <label className="label">Identity name</label>
            <input className="input mb-3" placeholder="12345Publisher.AppName (or from Settings)"
              value={storeForm.identityName} onChange={(e) => setStoreForm((f) => ({ ...f, identityName: e.target.value }))} />
            <label className="label">Publisher id</label>
            <input className="input mb-3" placeholder="CN=xxxxxxxx-xxxx-… (or from Settings)"
              value={storeForm.publisher} onChange={(e) => setStoreForm((f) => ({ ...f, publisher: e.target.value }))} />
            <label className="label">Publisher display name</label>
            <input className="input mb-3" placeholder="Your publisher name (or from Settings)"
              value={storeForm.publisherDisplayName} onChange={(e) => setStoreForm((f) => ({ ...f, publisherDisplayName: e.target.value }))} />
            <label className="label">Version</label>
            <input className="input mb-4" placeholder="1.0.0" value={storeForm.version}
              onChange={(e) => setStoreForm((f) => ({ ...f, version: e.target.value }))} />
            <div className="flex justify-end gap-2">
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setStoreDlg(false)}>Cancel</button>
              <button className="btn-primary px-3 py-1.5 text-xs" onClick={buildStore}>
                {storeForm.packaging === 'pwa' ? 'Write checklist' : 'Build on Actions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
