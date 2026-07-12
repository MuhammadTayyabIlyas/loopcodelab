import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { go } from '../App.jsx';
import { pendingIdea, setPendingIdea, pendingFormat, setPendingFormat } from './Landing.jsx';
import { FAMILIES, familyForFormat, Slide, GoalScreen } from '../components/wizard.jsx';

// Master can be any agent except glm (unreliable in the agentic review loop).
const AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'kimi', 'grok', 'vibe', 'glm'];
const MASTERS = AGENTS.filter((a) => a !== 'glm');
// Vault credentials that satisfy each agent — any ONE (API key, subscription
// sign-in, or coding plan) is enough. glm: none — platform fallback.
const AGENT_PROVIDER = {
  claude: ['anthropic', 'claude-oauth', 'claude-plan'],
  codex: ['openai', 'codex-oauth'],
  qwen: ['qwen', 'qwen-oauth'],
  gemini: ['gemini', 'gemini-oauth'],
  kimi: ['kimi', 'kimi-oauth'],
  grok: ['grok', 'grok-oauth'],
  vibe: ['vibe'],
};
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex (OpenAI)', qwen: 'Qwen', gemini: 'Gemini', kimi: 'Kimi (Moonshot)', grok: 'Grok (xAI)', vibe: 'Vibe (Mistral)' };
const FORMATS = ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'];
// Client-side mirror of ralph/social-formats.mjs PLATFORM_SPECS (same deliberate
// mirror pattern as RALPH_AGENTS) — server re-validates via normalizePlatforms.
const PLATFORMS = [
  { id: 'tiktok', label: 'TikTok 9:16' }, { id: 'instagram-reel', label: 'IG Reel 9:16' },
  { id: 'instagram-feed', label: 'IG Feed 4:5' }, { id: 'youtube-short', label: 'YT Short 9:16' },
  { id: 'youtube', label: 'YouTube 16:9' }, { id: 'linkedin', label: 'LinkedIn 16:9' },
];
// Row labels for the media-generation toggle/cap controls, shared by every
// screen that renders a subset of them (Options main body + Advanced leftovers).
const MEDIA_LABELS = [['image', 'Images (Qwen/Wan)'], ['video', 'Video (Seedance)'], ['audio', 'Audio (Suno / ElevenLabs)']];

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export default function NewBuild() {
  // Wizard screens: goal (pick a deliverable family) -> describe (idea + AI
  // analyze/refine) -> options (relevant fields, rest under Advanced) -> review.
  // A dashboard/landing prefill means the user already typed their idea — skip
  // the goal tiles and let the analyze call infer the format ("Anything" family;
  // "← Change goal" still reachable). NOTE: these initializers run before the
  // `idea` initializer below consumes/clears pendingIdea — order is load-bearing.
  const [screen, setScreen] = useState(() => (pendingIdea ? 'describe' : 'goal')); // goal | describe | options | review
  const [navDir, setNavDir] = useState('fwd');
  const [family, setFamily] = useState(() => (pendingIdea ? FAMILIES.find((f) => f.id === 'auto') : null)); // FAMILIES entry
  const [analysis, setAnalysis] = useState(null); // last analyze result
  const [chatLog, setChatLog] = useState([]);   // [{role, text}] for refine history
  const [chatMsg, setChatMsg] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [project, setProject] = useState('');
  // Consume the module-level prefill on first mount; clear it so it isn't reused.
  const [idea, setIdea] = useState(() => {
    const v = pendingIdea;
    setPendingIdea('');
    return v;
  });
  const [master, setMaster] = useState('claude');
  const [workers, setWorkers] = useState(['claude', 'codex']);
  // Optional per-run model override. Blank = the connected default; any model id
  // works (e.g. an openrouter.ai/models id when running via an OpenRouter plan).
  const [model, setModel] = useState('');
  // Optional per-build media generation toggles/caps (image/video/audio); defaults
  // overridden by the deployment's /api/ralph/media-caps once loaded.
  const [media, setMedia] = useState({ image: { enabled: true, cap: 8 }, video: { enabled: false, cap: 2 }, audio: { enabled: false, cap: 3 } });
  // social-video: target platforms + optional per-kind media model overrides.
  const [platforms, setPlatforms] = useState(['tiktok', 'instagram-reel', 'youtube-short']);
  const [mediaModels, setMediaModels] = useState({});          // {kind: {provider, model}} — absent = auto
  const [mediaModelChoices, setMediaModelChoices] = useState(null); // from /api/keys
  // The landing/dashboard deliverable toggle pre-picks the format.
  const [outputFormat, setOutputFormat] = useState(() => {
    const v = pendingFormat;
    setPendingFormat('');
    return FORMATS.includes(v) ? v : 'auto';
  });
  const [plan, setPlan] = useState(null); // { prd, ... }
  const [questions, setQuestions] = useState([]); // clarify questions, sourced from analyze
  const [picks, setPicks] = useState({});         // qIndex -> [labels] (or single free-text)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Optional brand assets — staged server-side under a token, committed at /start.
  const [assetToken, setAssetToken] = useState(null);
  const [assets, setAssets] = useState([]);
  const [assetError, setAssetError] = useState('');
  const [planModels, setPlanModels] = useState([]); // token-plan model suggestions for the model field
  const onAssetPick = async (e) => {
    setAssetError('');
    try {
      let token = assetToken; let list = assets;
      for (const f of [...e.target.files]) {
        const data = await api.uploadAsset(f, token);
        token = data.assetToken; list = data.assets;
      }
      setAssetToken(token); setAssets(list);
    } catch (err) { setAssetError(err.message); }
    e.target.value = '';
  };
  // Vault providers with a saved key; null = unknown/single-tenant (no gating).
  const [providers, setProviders] = useState(null);
  const [cliLogins, setCliLogins] = useState([]);
  const [defaultAgent, setDefaultAgent] = useState('claude'); // deployment default
  // A ?draft=<id> in the hash means we're reopening a saved draft; its values must win
  // over the deployment-default seeding + mediaCaps below, so skip those when reopening.
  const reopenDraftId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('draft');
  useEffect(() => {
    api.keys().then((d) => {
      setProviders(new Set((d.keys || []).map((k) => k.provider)));
      setCliLogins(d.cliLogins || []); // agents signed in inside the sandbox terminal
      if (d.defaultAgent) setDefaultAgent(d.defaultAgent);
      setPlanModels((d.planModels && d.planModels.tokenplan) || []);
      setMediaModelChoices(d.mediaModels || null);
    }).catch(() => setProviders(null));
    if (!reopenDraftId) api.mediaCaps().then((d) => d?.caps && setMedia(d.caps)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draftId, setDraftId] = useState(null); // set when reopened from / saved as a draft
  const [soloModels, setSoloModels] = useState({});
  useEffect(() => { api.soloModels().then((d) => setSoloModels(d.models || {})).catch(() => {}); }, []);

  // Reopen a saved draft (?draft=<id> in the hash) straight onto the Options
  // screen with everything restored. Restoring a social-video draft must NOT
  // let the format-flip effect below clobber the draft's saved media flags
  // (draft values win — same invariant as the mediaCaps guard above):
  // consume-once ref, same spirit as `seeded`.
  const skipFormatMediaSeed = useRef(false);
  useEffect(() => {
    if (!reopenDraftId) return;
    api.draft(reopenDraftId).then(({ draft: d }) => {
      if (!d) return;
      setDraftId(d.id);
      skipFormatMediaSeed.current = true; // the restored format change is not user-driven
      setIdea(d.idea || ''); setMaster(d.master || 'claude'); setWorkers(d.workers || []);
      setModel(d.model || ''); setOutputFormat(d.outputFormat || 'auto'); setProject(d.project || '');
      if (d.media) setMedia(d.media);
      if (d.platforms) setPlatforms(d.platforms);
      if (d.mediaModels) setMediaModels(d.mediaModels);
      if (d.prd) setPlan({ prd: d.prd });
      // Legacy drafts saved before formatFamily existed derive it from outputFormat.
      setFamily(FAMILIES.find((f) => f.id === (d.formatFamily || familyForFormat(d.outputFormat))) || FAMILIES.at(-1));
      setScreen('options');
    }).catch(() => {});
  }, []);

  // social-video needs its own media generation (video for the clip, audio for
  // the soundtrack/voiceover) — flipping the format on switches those toggles on
  // (and bumps their caps) so the user doesn't have to discover the media section too.
  // Skipped once after a draft restore or an analyze apply (both set media
  // directly from their own source of truth — see skipFormatMediaSeed writes below).
  useEffect(() => {
    if (skipFormatMediaSeed.current) { skipFormatMediaSeed.current = false; return; }
    if (outputFormat === 'social-video') {
      setMedia((s) => ({ image: { ...s.image, enabled: true, cap: Math.max(s.image.cap, 8) },
                         video: { enabled: true, cap: Math.max(s.video.cap, 2) },
                         audio: { enabled: true, cap: Math.max(s.audio.cap, 2) } }));
    }
  }, [outputFormat]);
  const needsKey = (a) => providers !== null && AGENT_PROVIDER[a]
    && !AGENT_PROVIDER[a].some((p) => providers.has(p)) && !cliLogins.includes(a);
  const missingKeys = [...new Set([master, ...workers])].filter(needsKey);

  // Seed the agent pickers once we know the deployment default + which agents are
  // connected, so a single-agent deployment (e.g. Kimi-only) doesn't default users
  // onto claude/codex they can't use. Prefer the deployment default if it's usable,
  // else the first agent the user has connected, else leave the default selected.
  const seeded = useRef(!!reopenDraftId); // pre-mark seeded when reopening so the draft's agents win
  useEffect(() => {
    if (providers === null || seeded.current) return;
    seeded.current = true;
    const pref = MASTERS.includes(defaultAgent) ? defaultAgent : 'claude';
    const connected = MASTERS.filter((a) => !needsKey(a));
    const pick = !needsKey(pref) ? pref : (connected[0] || pref);
    setMaster(pick);
    setWorkers([pick]);
  }, [providers, defaultAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // If a prefill arrived after mount (e.g. via a re-navigation), pick it up.
  useEffect(() => {
    if (pendingIdea) {
      setIdea(pendingIdea);
      setPendingIdea('');
      // Same skip as the mount path: a typed idea goes straight to Describe.
      setFamily((f) => f || FAMILIES.find((x) => x.id === 'auto'));
      setScreen((s) => (s === 'goal' ? 'describe' : s));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const slug = project ? slugify(project) : ''; // blank -> the server smart-names from the idea

  // Wizard-screen navigation (distinct from the imported page-level `go`,
  // which navigates between /new, /app, /settings etc).
  const goScreen = (next) => {
    const order = ['goal', 'describe', 'options', 'review'];
    setNavDir(order.indexOf(next) >= order.indexOf(screen) ? 'fwd' : 'back');
    setScreen(next);
  };

  // Which of today's configure fields are relevant enough to show up front on
  // the Options screen vs tucked under Advanced, based on the chosen goal family.
  // "Anything" defers to whatever format the analysis inferred, so e.g. a typed
  // "cat dance video" still gets the platform/media fields on Options.
  const fam = (family?.id && family.id !== 'auto') ? family.id : familyForFormat(outputFormat);
  const show = {
    platforms: outputFormat === 'social-video',
    mediaFull: fam === 'video',                       // image+video+audio toggle rows
    mediaImagesOnly: fam === 'web' || fam === 'mobile',
    workers: fam === 'web' || fam === 'mobile',
    formatSelect: fam === 'auto',
  };
  const mediaRow = (k, lbl) => (
    <div key={k} className="flex items-center gap-3 text-sm">
      <label className="flex items-center gap-2 w-56">
        <input type="checkbox" checked={media[k].enabled}
          onChange={(e) => setMedia((s) => ({ ...s, [k]: { ...s[k], enabled: e.target.checked } }))} />
        {lbl}
      </label>
      <input type="number" min="0" max="20" className="input !py-1 w-24 text-xs" value={media[k].cap}
        disabled={!media[k].enabled}
        onChange={(e) => setMedia((s) => ({ ...s, [k]: { ...s[k], cap: Math.max(0, Math.min(20, parseInt(e.target.value, 10) || 0)) } }))} />
      <span className="text-xs text-muted">max</span>
    </div>
  );

  const toggleWorker = (a) =>
    setWorkers((w) => (w.includes(a) ? w.filter((x) => x !== a) : [...w, a]));

  // Screen 2 (Describe): one combined inference call — deliverable format,
  // short name, media needs, platforms, clarify questions, refined brief.
  // Serves both the initial "Analyze idea" button and the refine chat.
  async function runAnalyze(extraMsg) {
    if (!idea.trim() || analyzing) return;
    setAnalyzing(true);
    const history = extraMsg ? [...chatLog, { role: 'user', text: extraMsg }] : chatLog;
    if (extraMsg) setChatLog(history);
    try {
      const r = await api.analyze({
        idea: idea.trim(),
        formatFamily: family?.id || 'auto',
        history,
        current: analysis ? { name: project || analysis.name, outputFormat, media, platforms } : null,
      });
      setAnalysis(r);
      // We set media directly from the analyze result below — skip the
      // format-flip auto-seed effect so it doesn't stomp that with its
      // generic "turn on video+audio" defaults.
      skipFormatMediaSeed.current = true;
      setOutputFormat(r.outputFormat);
      setMedia(r.media);
      if (r.platforms) setPlatforms(r.platforms);
      if (!project) setProject(r.name);
      // analyze's questions are {q, options:[string]}; adapt to the {label}
      // shape the existing questions/picks JSX (built for api.clarify) expects.
      setQuestions(r.questions.map((q) => ({ q: q.q, options: (q.options || []).map((o) => ({ label: o })) })));
      setPicks({});
      if (extraMsg && r.note) setChatLog((l) => [...l, { role: 'assistant', text: r.note }]);
    } catch {
      // Network-level failure only — the route itself always replies 200 with
      // a deterministic fallback shape, so this is a last-resort client fallback.
      const seedFor = { video: 'social-video', web: 'web-app', mobile: 'flutter-app', doc: 'google-doc', sheet: 'google-sheet', slides: 'google-slides' };
      const fmt = seedFor[family?.id] || 'auto';
      // Mirror the server's fallback shape (ralph/analyze.mjs fallbackAnalysis)
      // minimally so later field access (r.questions.map, r.media, etc.) can't crash.
      setAnalysis({ fallback: true, note: '', name: '', brief: '', questions: [], platforms: null, media: null, outputFormat: fmt, formatFamily: family?.id || 'auto' });
      setOutputFormat(fmt);
    } finally { setAnalyzing(false); }
  }

  // Assemble clarify answers (same shape the PWA sends) and generate the plan.
  function answersText() {
    return questions.map((q, i) => {
      const a = (picks[i] || []).join(', ');
      return a ? `Q: ${q.q}\nA: ${a}` : '';
    }).filter(Boolean).join('\n');
  }
  const togglePick = (qi, label, multi) => setPicks((p) => {
    const cur = p[qi] || [];
    if (multi) return { ...p, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    return { ...p, [qi]: [label] };
  });

  // Screen 3 (Options) "Generate plan" — the idea sent is the AI-refined brief
  // when we have one (falls back to the raw idea); clarify answers come from
  // the questions/picks assembled on the Describe screen, not a separate call.
  async function doPlan() {
    setErr('');
    if (missingKeys.length) return setErr(`Connect ${missingKeys.map((a) => PROVIDER_LABEL[a] || a).join(' and ')} in Settings first (API key, subscription, or coding plan), or pick a different agent.`);
    setBusy(true);
    try {
      const res = await api.plan({ idea: (analysis?.brief || idea).trim(), project: slug, master, workers, outputFormat, assetToken, answers: answersText(), media });
      setPlan(res);
      goScreen('review');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function saveDraft() {
    setErr('');
    try {
      const clarify = questions.map((q, i) => ({ q: q.q, a: picks[i] })).filter((c) => c.a);
      const { id } = await api.saveDraft({
        id: draftId || undefined,
        draft: { name: (slug || idea.trim().slice(0, 40) || 'Untitled draft'), idea: idea.trim(), master, workers, model: model.trim(), outputFormat, project: slug, media, clarify, prd: plan?.prd,
          platforms: outputFormat === 'social-video' ? platforms : undefined,
          mediaModels: Object.keys(mediaModels).length ? mediaModels : undefined,
          formatFamily: family?.id || null },
      });
      setDraftId(id);
      setErr('Saved as draft ✓');
    } catch (e) { setErr(e.message); }
  }

  async function doStart() {
    setErr('');
    setBusy(true);
    try {
      await api.start({
        project: slug || plan?.prd?.project || '', idea: idea.trim(), master, workers, outputFormat,
        model: model.trim() || undefined,
        media,
        platforms: outputFormat === 'social-video' ? platforms : undefined,
        mediaModels: Object.keys(mediaModels).length ? mediaModels : undefined,
        prd: plan?.prd || undefined,
        assetToken: assetToken || undefined,
      });
      go('/app');
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  const stories = plan?.prd?.stories || [];
  const enabledKinds = ['image', 'video', 'audio'].filter((k) => media[k]?.enabled);
  const mediaTotals = { image: 0, video: 0, audio: 0 };
  for (const s of stories) for (const k of enabledKinds) mediaTotals[k] += (s.media?.[k] || 0);
  function setStoryMedia(i, kind, n) {
    setPlan((p) => {
      if (!p?.prd) return p;
      const v = Math.max(0, Math.min(20, parseInt(n, 10) || 0));
      const nextStories = p.prd.stories.map((s, idx) => {
        if (idx !== i) return s;
        const m = { ...(s.media || {}) };
        if (v > 0) m[kind] = v; else delete m[kind];
        return { ...s, media: Object.keys(m).length ? m : undefined };
      });
      return { ...p, prd: { ...p.prd, stories: nextStories } };
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3 text-sm text-muted">
        <button className="hover:text-slate-900" onClick={() => go('/app')}>← Builds</button>
        <span className="opacity-40">/</span>
        <span className="text-slate-700">New build</span>
      </div>

      {/* stepper */}
      <div className="mb-8 flex items-center gap-2 text-xs">
        {[['goal', '1 · Goal'], ['describe', '2 · Describe'], ['options', '3 · Options'], ['review', '4 · Review']].map(([id, label]) => (
          <span key={id} className={screen === id ? 'badge bg-accent/15 text-accent' : 'badge bg-panel2 text-muted'}>{label}</span>
        ))}
      </div>

      {err && <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">{err}</div>}

      {missingKeys.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          ⚠ <b>{missingKeys.join(', ')}</b> not connected — agents run on your own account (API key, subscription, or coding plan).{' '}
          <button className="underline" type="button" onClick={() => go('/settings')}>Connect it in Settings</button> or pick a different agent.
        </div>
      )}

      {screen === 'goal' && (
        <Slide k="goal" dir={navDir}>
          {/* A new goal invalidates the previous family's analysis/refine state,
              including any plan already generated — otherwise "Review saved
              plan →" on Options could carry a previous idea's PRD forward. */}
          <GoalScreen onPick={(f) => { setFamily(f); setOutputFormat(null); setAnalysis(null); setQuestions([]); setPicks({}); setChatLog([]); setPlan(null); goScreen('describe'); }} />
        </Slide>
      )}

      {screen === 'describe' && family && (
        <Slide k="describe" dir={navDir}>
          <button className="btn-ghost text-xs" onClick={() => goScreen('goal')}>← Change goal</button>
          <h2 className="mt-2 text-lg font-semibold">{family.ask}</h2>
          {family.chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {family.chips.map((c) => (
                <button key={c} type="button" className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => setIdea((v) => (v ? `${v} — ${c.toLowerCase()}` : `A ${c.toLowerCase()}: `))}>{c}</button>
              ))}
            </div>
          )}
          <textarea className="prompt-area mt-3" rows={4} value={idea}
            onChange={(e) => setIdea(e.target.value)} placeholder="Describe it in a sentence or two…" />

          <div className="mt-3">
            <label className="label">Brand assets <span className="opacity-60">(optional)</span></label>
            <input type="file" multiple className="block text-sm"
              accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,image/*,application/pdf"
              onChange={onAssetPick} />
            <p className="mt-1 text-xs text-muted">Logo, brand images, or a brand guide. PNG/JPG/WEBP/GIF/SVG/PDF, ≤10 MB each, up to 12.</p>
            {assets.length > 0 && (
              <ul className="mt-1 text-xs text-muted">{assets.map((a) => <li key={a.name}>{a.name} ({a.kind})</li>)}</ul>
            )}
            {assetError && <p className="mt-1 text-xs text-danger">{assetError}</p>}
          </div>

          <button className="btn btn-primary mt-3" disabled={!idea.trim() || analyzing} onClick={() => runAnalyze()}>
            {analyzing ? 'Analyzing…' : analysis ? 'Re-analyze' : 'Analyze idea'}
          </button>

          {analysis && (
            <div className="card mt-4">
              {analysis.fallback
                ? <p className="text-xs text-muted">Smart analysis unavailable — using sensible defaults (everything stays editable on the next screen).</p>
                : (<>
                  <p className="text-sm"><b>{slug || analysis.name}</b> · {outputFormat}{analysis.platforms ? ` · ${analysis.platforms.join(', ')}` : ''}</p>
                  {analysis.note && <p className="mt-1 text-xs text-muted">{analysis.note}</p>}
                  {analysis.brief && analysis.brief !== idea.trim() && <p className="mt-2 text-xs">{analysis.brief}</p>}
                </>)}

              {questions.length > 0 && (
                <div className="mt-3 space-y-3">
                  {questions.map((q, i) => (
                    <div key={i} className="space-y-2">
                      <p className="text-sm font-medium">{q.header ? <span className="text-accent">{q.header}: </span> : null}{q.q}</p>
                      {(q.options || []).length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {q.options.map((o) => {
                            const sel = (picks[i] || []).includes(o.label);
                            return (
                              <button type="button" key={o.label} title={o.description || ''}
                                onClick={() => togglePick(i, o.label, q.multiSelect)}
                                className={`badge cursor-pointer px-3 py-1 ${sel ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'bg-panel2 text-muted'}`}>
                                {o.label}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <input className="input" placeholder="Your answer (optional)"
                          value={(picks[i] || [])[0] || ''}
                          onChange={(e) => setPicks((p) => ({ ...p, [i]: e.target.value ? [e.target.value] : [] }))} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex gap-2">
                <input className="input flex-1" placeholder='Refine with AI — e.g. "also Instagram", "brainstorm this idea"'
                  value={chatMsg} onChange={(e) => setChatMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !analyzing && chatMsg.trim()) { runAnalyze(chatMsg.trim()); setChatMsg(''); } }} />
                <button className="btn-ghost text-xs" disabled={analyzing || !chatMsg.trim()}
                  onClick={() => { if (!analyzing && chatMsg.trim()) { runAnalyze(chatMsg.trim()); setChatMsg(''); } }}>Send</button>
              </div>
              {chatLog.length > 0 && (
                <div className="mt-2 space-y-1 text-xs text-muted">
                  {chatLog.slice(-4).map((m, i) => <p key={i}><b>{m.role === 'user' ? 'You' : 'AI'}:</b> {m.text}</p>)}
                </div>
              )}
            </div>
          )}

          <div className="mt-4">
            {/* Await a first-time analyze before advancing — a fire-and-forget call
                landing late would clobber edits the user already made on Options. */}
            <button className="btn btn-primary" disabled={!idea.trim() || analyzing}
              onClick={async () => { if (!analysis) await runAnalyze(); goScreen('options'); }}>
              {analyzing ? 'Analyzing…' : 'Continue →'}
            </button>
          </div>
        </Slide>
      )}

      {screen === 'options' && (
        <Slide k="options" dir={navDir}>
          <button className="btn-ghost text-xs" onClick={() => goScreen('describe')}>← Back</button>
          <h2 className="mt-2 text-lg font-semibold">Options</h2>
          <p className="mt-1 text-sm text-muted">Pre-filled from your idea — adjust anything, or open Advanced for the rest.</p>

          <div className="card mt-3 space-y-5">
            <div>
              <label className="label">Project name <span className="opacity-60">(optional — used for the preview subdomain; leave blank for a smart auto-name)</span></label>
              <input className="input" placeholder={slug || 'leave blank — named from your idea'} value={project} onChange={(e) => setProject(e.target.value)} />
              {slug && <p className="mt-1 text-xs text-muted">→ <span className="text-accent">{slug}</span>.tayyabcheema.com</p>}
            </div>

            <div>
              <label className="label">Master agent <span className="opacity-60">(reviews &amp; integrates)</span></label>
              <select className="input" value={master} onChange={(e) => setMaster(e.target.value)}>
                {MASTERS.map((a) => <option key={a} value={a}>{a}{needsKey(a) ? ' — no key' : ''}</option>)}
              </select>
            </div>

            {show.formatSelect && (
              <div>
                <label className="label">Output format</label>
                <select className="input" value={outputFormat}
                  onChange={(e) => { skipFormatMediaSeed.current = false; setOutputFormat(e.target.value); }}>
                  {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            )}

            {show.platforms && (
              <div>
                <label className="label">Target platforms</label>
                <div className="flex flex-wrap gap-2">
                  {PLATFORMS.map((p) => (
                    <label key={p.id} className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={platforms.includes(p.id)}
                        onChange={(e) => setPlatforms((s) => e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id))} />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {show.mediaFull && (
              <div>
                <label className="label">Media generation <span className="opacity-60">(optional — billed to your keys)</span></label>
                <div className="space-y-2">{MEDIA_LABELS.map(([k, lbl]) => mediaRow(k, lbl))}</div>
                <p className="mt-1 text-xs text-muted">Video &amp; audio are off by default (they cost the most). Images use your token-plan key; video/audio need their keys in Settings.</p>
              </div>
            )}

            {show.mediaImagesOnly && (
              <div>
                <label className="label">Media generation <span className="opacity-60">(optional — billed to your keys)</span></label>
                <div className="space-y-2">{MEDIA_LABELS.filter(([k]) => k === 'image').map(([k, lbl]) => mediaRow(k, lbl))}</div>
                <p className="mt-1 text-xs text-muted">Images use your token-plan key. Video &amp; audio are under Advanced.</p>
              </div>
            )}

            {show.workers && (
              <div>
                <label className="label">Worker agents <span className="opacity-60">(build stories in parallel)</span></label>
                <div className="flex flex-wrap gap-2">
                  {AGENTS.map((a) => (
                    <button type="button" key={a} onClick={() => toggleWorker(a)}
                      className={`badge cursor-pointer px-3 py-1 ${workers.includes(a) ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'bg-panel2 text-muted'}`}>
                      {a}{needsKey(a) ? ' 🔒' : ''}
                    </button>
                  ))}
                </div>
                {workers.length === 0 && (
                  <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
                    <b>Solo mode.</b> <span className="text-accent">{master}</span> builds every story and reviews its own work — no separate workers.
                    {soloModels[master]?.build && (
                      <> Builds on <code>{soloModels[master].build}</code>, reviews on <code>{soloModels[master].review || 'its default model'}</code>.</>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <details className="card mt-4">
            <summary className="cursor-pointer text-sm font-semibold">Advanced</summary>
            <div className="mt-3 space-y-4">
              {!show.formatSelect && (
                <div>
                  <label className="label">Output format</label>
                  <select className="input" value={outputFormat}
                    onChange={(e) => { skipFormatMediaSeed.current = false; setOutputFormat(e.target.value); }}>
                    {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className="label">Model for this run <span className="opacity-60">(optional)</span></label>
                {planModels.length > 0 && (
                  <select className="input" value={planModels.some((m) => m.id === model) ? model : ''}
                    onChange={(e) => setModel(e.target.value)}>
                    <option value="">Connected default</option>
                    <optgroup label="Alibaba Token Plan (one key, many models)">
                      {planModels.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
                    </optgroup>
                  </select>
                )}
                <input className="input mt-2" placeholder="…or type any model id (e.g. an openrouter.ai/models id)"
                  value={model} onChange={(e) => setModel(e.target.value)} />
                <p className="mt-1 text-xs text-muted">Overrides the model for this build only. Pick a Token-Plan model above, or type any id — for OpenRouter, browse{' '}
                  <a className="text-accent underline" href="https://openrouter.ai/models" target="_blank" rel="noreferrer">openrouter.ai/models ↗</a>.</p>
              </div>

              {mediaModelChoices && ['image', 'video', 'audio'].some((k) => media[k]?.enabled) && (
                <div>
                  <label className="label">Media models <span className="opacity-60">(optional — auto picks per your keys)</span></label>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(mediaModelChoices).map(([kind, list]) => (
                      <label key={kind} className="text-xs flex items-center gap-2">
                        <span className="w-20 capitalize">{kind}</span>
                        <select className="input !py-1 text-xs flex-1"
                          value={mediaModels[kind] ? `${mediaModels[kind].provider}:${mediaModels[kind].model}` : ''}
                          onChange={(e) => setMediaModels((s) => {
                            const v = e.target.value;
                            if (!v) { const { [kind]: _d, ...rest } = s; return rest; }
                            const [provider, ...m] = v.split(':');
                            return { ...s, [kind]: { provider, model: m.join(':') } };
                          })}>
                          <option value="">auto</option>
                          {list.map((m) => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.label}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!show.workers && (
                <div>
                  <label className="label">Worker agents <span className="opacity-60">(build stories in parallel)</span></label>
                  <div className="flex flex-wrap gap-2">
                    {AGENTS.map((a) => (
                      <button type="button" key={a} onClick={() => toggleWorker(a)}
                        className={`badge cursor-pointer px-3 py-1 ${workers.includes(a) ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'bg-panel2 text-muted'}`}>
                        {a}{needsKey(a) ? ' 🔒' : ''}
                      </button>
                    ))}
                  </div>
                  {workers.length === 0 && (
                    <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
                      <b>Solo mode.</b> <span className="text-accent">{master}</span> builds every story and reviews its own work — no separate workers.
                      {soloModels[master]?.build && (
                        <> Builds on <code>{soloModels[master].build}</code>, reviews on <code>{soloModels[master].review || 'its default model'}</code>.</>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!show.mediaFull && (
                <div>
                  <label className="label">Media generation <span className="opacity-60">(optional — billed to your keys)</span></label>
                  <div className="space-y-2">
                    {MEDIA_LABELS.filter(([k]) => !(show.mediaImagesOnly && k === 'image')).map(([k, lbl]) => mediaRow(k, lbl))}
                  </div>
                  <p className="mt-1 text-xs text-muted">Video &amp; audio are off by default (they cost the most). Images use your token-plan key; video/audio need their keys in Settings.</p>
                </div>
              )}
            </div>
          </details>

          <div className="mt-4 flex gap-3">
            {plan?.prd ? (
              <>
                {/* An existing plan (e.g. restored from a draft, possibly hand-tuned)
                    must not be silently re-planned away — reviewing it as-is is the
                    primary action; regenerating is an explicit choice. */}
                <button className="btn btn-primary" disabled={busy} onClick={() => goScreen('review')}>
                  Review saved plan →
                </button>
                <button className="btn-ghost" disabled={busy} onClick={doPlan}>
                  {busy ? 'Planning…' : 'Regenerate plan'}
                </button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={busy} onClick={doPlan}>
                {busy ? 'Planning…' : 'Generate plan →'}
              </button>
            )}
          </div>
        </Slide>
      )}

      {screen === 'review' && (
        <Slide k="review" dir={navDir}>
          <div className="space-y-5">
            <div className="card">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{plan?.prd?.project || slug}</h2>
                <span className="badge bg-panel2 text-muted">{stories.length} stor{stories.length === 1 ? 'y' : 'ies'}</span>
              </div>
              {plan?.prd?.summary && <p className="mt-2 text-sm text-muted">{plan.prd.summary}</p>}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="badge bg-panel2 text-muted">master: {master}</span>
                <span className="badge bg-panel2 text-muted">output: {plan?.prd?.outputFormat || outputFormat}</span>
                {model.trim() && <span className="badge bg-panel2 text-muted">model: {model.trim()}</span>}
              </div>
              {enabledKinds.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {enabledKinds.map((k) => {
                    const over = mediaTotals[k] > media[k].cap;
                    return (
                      <span key={k} className={`badge ${over ? 'bg-danger/15 text-danger' : 'bg-panel2 text-muted'}`}>
                        {k}: {mediaTotals[k]}/{media[k].cap}{over ? ' ⚠ over budget — will be trimmed' : ''}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-3">
              {stories.map((s, i) => (
                <div key={s.id || i} className="card py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{s.id ? `${s.id} · ` : ''}{s.title}</p>
                      {s.description && <p className="mt-1 text-xs text-muted">{s.description}</p>}
                    </div>
                    <span className="badge shrink-0 bg-accent/15 text-accent">{s.assignee || master}</span>
                  </div>
                  {(s.deps?.length > 0 || s.outputType) && (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                      {s.outputType && s.outputType !== 'auto' && <span className="badge bg-panel2">→ {s.outputType}</span>}
                      {s.deps?.length > 0 && <span className="badge bg-panel2">after {s.deps.join(', ')}</span>}
                    </div>
                  )}
                  {enabledKinds.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                      <span className="opacity-70">media:</span>
                      {enabledKinds.map((k) => (
                        <label key={k} className="flex items-center gap-1">
                          {k}
                          <input type="number" min="0" max="20" className="input !py-0.5 w-14 text-xs"
                            value={s.media?.[k] || 0}
                            onChange={(e) => setStoryMedia(i, k, e.target.value)} />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button className="btn-ghost" onClick={() => goScreen('options')} disabled={busy}>← Edit</button>
              <button className="btn-ghost" onClick={saveDraft} disabled={busy}>💾 Save draft</button>
              <button className="btn-primary flex-1 py-3" onClick={doStart} disabled={busy}>{busy ? 'Starting…' : '🚀 Start build'}</button>
            </div>
          </div>
        </Slide>
      )}
    </div>
  );
}
