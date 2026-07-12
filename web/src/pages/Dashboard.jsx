import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go } from '../App.jsx';
import { setPendingIdea } from './Landing.jsx';

const TEMPLATES = [
  { label: 'Landing page', idea: 'A landing page for a SaaS product with a hero, features, pricing section, and waitlist signup form.' },
  { label: 'CRUD dashboard', idea: 'A full-stack CRUD dashboard for managing a list of items with search, filters, and inline editing.' },
  { label: 'Data analysis script', idea: 'A Python data analysis script that reads a CSV, produces summary statistics, and generates charts.' },
  { label: 'Slide deck', idea: 'A professional slide deck about AI trends in 2025, with 10 slides and speaker notes.' },
  { label: 'REST API', idea: 'A Node.js REST API with CRUD endpoints, JWT authentication, and OpenAPI documentation.' },
];

const PHASE = {
  done: { label: 'done', cls: 'bg-ok/15 text-ok' },
  building: { label: 'building', cls: 'bg-accent/15 text-accent' },
  finalizing: { label: 'finalizing', cls: 'bg-accent/15 text-accent' },
  failed: { label: 'failed', cls: 'bg-danger/15 text-danger' },
  push_failed: { label: 'push failed', cls: 'bg-danger/15 text-danger' },
};

function BuildCard({ b, onDoctor }) {
  const total = (b.stories || []).length;
  const merged = (b.stories || []).filter((s) => s.status === 'merged').length;
  const ph = PHASE[b.phase] || { label: b.phase, cls: 'bg-panel2 text-muted' };
  const failed = b.phase === 'failed' || b.phase === 'push_failed';
  return (
    <div className="card cursor-pointer transition-colors hover:border-accent/40" onClick={() => go(`/build/${encodeURIComponent(b.project)}`)}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{b.project}</h3>
        <span className={`badge ${ph.cls}`}>{ph.label}</span>
      </div>
      <p className="mt-1 text-xs text-muted">master {b.master} · {merged}/{total} merged</p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: total ? `${(merged / total) * 100}%` : '0%' }} />
      </div>
      {failed && (b.attention?.message || b.error) && (
        <p className="mt-2 text-xs leading-snug text-danger line-clamp-2" title={b.attention?.message || b.error}>
          {b.attention?.message || b.error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
        {b.previewUrl && <a className="btn-ghost px-3 py-1.5 text-xs" href={b.previewUrl} target="_blank" rel="noreferrer">🌐 Open</a>}
        {b.repo && <a className="btn-ghost px-3 py-1.5 text-xs" href={b.repo} target="_blank" rel="noreferrer">Repo ↗</a>}
        {failed && <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => onDoctor(b.project)}>🩺 Doctor</button>}
      </div>
    </div>
  );
}

export default function Dashboard({ me, onSignOut }) {
  const [builds, setBuilds] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [idea, setIdea] = useState('');
  const [diag, setDiag] = useState(null);

  const load = () => {
    api.builds().then((d) => setBuilds(d.runs || [])).catch(() => {});
    api.drafts().then((d) => setDrafts(d.drafts || [])).catch(() => {});
  };
  const removeDraft = (id) => api.deleteDraft(id).then(load).catch(() => {});

  // Draft start timer: "2h" / "30m" / "1d" -> the server fires the build when it's due,
  // even with the browser closed (the schedule lives on the draft, not the client).
  const fmtEta = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return 'under a minute';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.round(h / 24)}d`;
  };
  function scheduleDraft(d) {
    const raw = window.prompt('Start this draft automatically in… (e.g. 2h, 30m, 1d)', '2h');
    if (raw == null) return;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)?\s*$/i.exec(raw);
    if (!m) { setDiag({ project: d.name, text: 'Could not read that delay — use e.g. 2h, 30m, or 1d.' }); return; }
    const unit = (m[2] || 'h').toLowerCase();
    const ms = Number(m[1]) * (unit.startsWith('m') ? 60_000 : unit === 'd' ? 86_400_000 : 3_600_000);
    api.scheduleDraft(d.id, Math.round(ms)).then(load)
      .catch((e) => setDiag({ project: d.name, text: `Could not schedule: ${e.message}` }));
  }
  const unscheduleDraft = (id) => api.unscheduleDraft(id).then(load).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  function startWithIdea(text) {
    const trimmed = (text || idea).trim();
    if (!trimmed) return;
    setPendingIdea(trimmed);
    go('/new');
  }

  async function doctor(project) {
    setDiag({ project, text: 'Diagnosing…' });
    try { const d = await api.doctor(project); setDiag({ project, text: d.diagnosis, treatments: d.treatments }); load(); }
    catch (e) { setDiag({ project, text: `Doctor failed: ${e.message}` }); }
  }

  return (
    <div className="min-h-full">
      {/* Top nav */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-y-2 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-white text-sm">⌬</span>
            <button className="hover:text-slate-900" onClick={() => go('/')}>webtmux</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm sm:gap-3">
            <span className="hidden text-muted md:inline">{me.email}</span>
            {me.plan && <span className="badge border border-border bg-panel2 text-muted">{me.plan}</span>}
            {me.isAdmin && <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => go('/admin')}>Admin</button>}
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => go('/settings')}>Settings</button>
            {onSignOut && <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onSignOut}>Sign out</button>}
          </div>
        </div>
      </header>

      {/* Prompt hero */}
      <section className="mx-auto max-w-3xl px-6 pb-10 pt-12 text-center">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">What do you want to build?</h2>
        <p className="mt-2 text-sm text-slate-500">Describe your idea and AI agents will plan, build, and deploy it.</p>
        <div className="hero-card mx-auto mt-7 max-w-xl">
          <textarea
            rows={3}
            placeholder="e.g. A task tracker with deadlines, priority tags, and a Kanban view"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startWithIdea(); }}
          />
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-xs text-slate-400">Ctrl+Enter to start</span>
            <button className="send-btn" title="Start building" disabled={!idea.trim()} onClick={() => startWithIdea()}>↑</button>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          {TEMPLATES.map((t) => (
            <button key={t.label} className="chip" onClick={() => startWithIdea(t.idea)}>
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {drafts.length > 0 && (
        <section className="mx-auto max-w-6xl px-6 pb-4">
          <h3 className="mb-4 text-sm font-semibold text-muted uppercase tracking-wide">
            Drafts <span className="ml-1 text-slate-500">({drafts.length})</span>
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map((d) => (
              <div key={d.id} className="card flex items-center justify-between gap-3 py-4">
                <button className="min-w-0 text-left" onClick={() => go(`/new?draft=${encodeURIComponent(d.id)}`)}>
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="mt-1 text-xs text-muted">{d.outputFormat} · {d.stories} stor{d.stories === 1 ? 'y' : 'ies'}</p>
                  {d.startAt && d.startAt > Date.now() && (
                    <p className="mt-1 text-xs text-accent">⏰ starts in {fmtEta(d.startAt - Date.now())}</p>
                  )}
                  {d.startAt && d.startAt <= Date.now() && (
                    <p className="mt-1 text-xs text-accent">⏰ starting…</p>
                  )}
                  {d.startError && <p className="mt-1 text-xs text-warn" title={d.startError}>⚠ last scheduled start failed: {d.startError}</p>}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {d.startAt
                    ? <button className="btn-ghost px-2 py-1 text-xs" onClick={() => unscheduleDraft(d.id)} title="Cancel the start timer">⏰✕</button>
                    : <button className="btn-ghost px-2 py-1 text-xs" onClick={() => scheduleDraft(d)} title="Start automatically after a delay">⏰</button>}
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => removeDraft(d.id)} title="Delete draft">✕</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Builds list */}
      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted uppercase tracking-wide">
            Your builds <span className="ml-1 text-slate-500">({builds.length})</span>
          </h3>
        </div>

        {builds.length === 0
          ? <div className="card text-center text-muted py-10">
              <p className="text-base">No builds yet — describe your first idea above.</p>
            </div>
          : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {builds.map((b) => <BuildCard key={b.project} b={b} onDoctor={doctor} />)}
            </div>}
      </section>

      {diag && (
        <div className="fixed inset-0 grid place-items-center bg-slate-900/30 backdrop-blur-sm p-6" onClick={() => setDiag(null)}>
          <div className="card max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold">🩺 Doctor · {diag.project}</h3>
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
    </div>
  );
}
