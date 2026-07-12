import { useState } from 'react';
import { go } from '../App.jsx';

const TEMPLATES = [
  { label: 'Landing page', idea: 'A landing page for a SaaS product with a hero, features, pricing section, and waitlist signup form.' },
  { label: 'CRUD dashboard', idea: 'A full-stack CRUD dashboard for managing a list of items with search, filters, and inline editing.' },
  { label: 'Data analysis script', idea: 'A Python data analysis script that reads a CSV, produces summary statistics, and generates charts with matplotlib.' },
  { label: 'Slide deck', idea: 'A professional slide deck presentation about AI trends in 2025, with 10 slides, charts, and speaker notes.' },
  { label: 'REST API', idea: 'A Node.js REST API with CRUD endpoints for a todo list, JWT authentication, and OpenAPI documentation.' },
  { label: 'Blog site', idea: 'A Markdown-powered blog with a clean reading layout, tag filtering, and an RSS feed.' },
];

const FEATURES = [
  { icon: '⚡', title: 'From idea to deployed app', body: 'Describe what you want. A team of AI agents plans, builds, reviews, and ships it — automatically.' },
  { icon: '🔀', title: 'Parallel agent builds', body: 'Multiple AI agents work on separate stories at once on isolated git branches, then merge.' },
  { icon: '🩺', title: 'Self-healing', body: 'When something fails, the Doctor auto-diagnoses and retries — runs rarely need babysitting.' },
  { icon: '🧠', title: 'Learns your style', body: 'Cross-project memory tunes defaults to how you like things built, improving over time.' },
];

// Segmented deliverable toggle — pre-picks the build's output format.
const SEGMENTS = [
  { label: 'Web app', format: 'web-app' },
  { label: 'Document', format: 'docx' },
  { label: 'Slides', format: 'pptx' },
];

// Module-level variables: simplest prefill mechanism compatible with the hash
// router. Landing sets them before go('/new'); NewBuild reads + clears on mount.
export let pendingIdea = '';
export function setPendingIdea(v) { pendingIdea = v; }
export let pendingFormat = '';
export function setPendingFormat(v) { pendingFormat = v; }

export default function Landing({ me }) {
  const [idea, setIdea] = useState('');
  const [seg, setSeg] = useState(0);

  function submit(text) {
    const trimmed = (text || idea).trim();
    if (!trimmed) return;
    setPendingIdea(trimmed);
    setPendingFormat(SEGMENTS[seg].format);
    go(me ? '/new' : '/login');
  }

  return (
    <div className="min-h-full">
      {/* Floating pill nav */}
      <header className="mx-auto max-w-5xl px-6 pt-5">
        <div className="pill-nav">
          <div className="flex items-center gap-2 font-semibold text-slate-900">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-accent to-accent2 text-sm text-white">⌬</span>
            webtmux
          </div>
          <nav className="flex items-center gap-2 text-sm">
            {me
              ? <button className="btn rounded-full bg-slate-900 px-5 text-white hover:bg-slate-800" onClick={() => go('/app')}>Open dashboard</button>
              : <>
                  <button className="btn-ghost rounded-full border-0 bg-transparent shadow-none hover:bg-white" onClick={() => go('/login')}>Sign in</button>
                  <button className="btn rounded-full bg-slate-900 px-5 text-white hover:bg-slate-800" onClick={() => go('/login')}>Start building</button>
                </>}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pb-16 pt-16 text-center">
        {/* Deliverable toggle (base44's Apps/Superagents slot) */}
        <div className="seg">
          {SEGMENTS.map((s, i) => (
            <button key={s.label} className={`seg-item ${i === seg ? 'seg-item-active' : ''}`} onClick={() => setSeg(i)}>
              {s.label}
            </button>
          ))}
        </div>

        <h1 className="mx-auto mt-7 max-w-2xl text-5xl font-extrabold leading-[1.08] tracking-tight text-slate-900 sm:text-6xl">
          Turn your ideas into <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">shipped projects</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-base text-slate-500">
          A team of AI agents plans, builds, reviews, and deploys it live — with just your words.
        </p>

        {/* Floating prompt card — THE focal point */}
        <div className="hero-card mx-auto mt-10 max-w-xl">
          <textarea
            rows={3}
            placeholder={seg === 0
              ? 'Build me a task tracker with deadlines and a Kanban view…'
              : seg === 1 ? 'Write me a market-research report on…' : 'Create a 10-slide pitch deck about…'}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          />
          <div className="flex items-center justify-between px-3 pb-1">
            <span className="text-xs text-slate-400">No credit card — bring your own AI account</span>
            <button className="send-btn" title="Build it" disabled={!idea.trim()} onClick={() => submit()}>↑</button>
          </div>
        </div>

        {/* Template chips */}
        <p className="eyebrow mt-10">Not sure where to start? Try one of these</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2.5">
          {TEMPLATES.map((t) => (
            <button key={t.label} className="chip" onClick={() => submit(t.idea)}>
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {/* Features — below the fold, the hero stays uncluttered */}
      <section className="mx-auto max-w-5xl px-6 pb-24 pt-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="card border-white/70 bg-white/70 backdrop-blur-sm">
              <div className="text-2xl">{f.icon}</div>
              <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
              <p className="mt-1 text-xs text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-white/60 py-8 text-center text-sm text-slate-400">
        webtmux · self-hosted AI builder · BYO keys
      </footer>
    </div>
  );
}
