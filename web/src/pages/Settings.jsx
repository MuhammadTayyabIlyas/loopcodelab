import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go } from '../App.jsx';
import McpServers from '../components/McpServers.jsx';

// Each agent can be authorized one of several ways; any ONE method is enough.
//  key  = raw API key · token = subscription token · json = CLI login-file JSON
//  plan = flat-rate coding plan on an Anthropic-compatible endpoint
const AGENT_CARDS = [
  {
    agent: 'claude', label: 'Claude agent', emoji: '✳️',
    blurb: 'The most reliable builder. Authorize with an Anthropic API key, your Claude Pro/Max subscription, or a flat-rate coding plan (Z.ai, Kimi, DeepSeek, MiniMax, BytePlus, OpenRouter for Grok/Mistral…).',
    methods: [
      { id: 'anthropic', kind: 'key', label: 'API key', hint: 'Pay-per-token key from console.anthropic.com (sk-ant-…)' },
      { id: 'claude-oauth', kind: 'token', label: 'Claude Pro/Max', terminal: true, hint: 'Sign in below — a terminal opens in your workspace, follow its instructions (no install needed). Builds run on your subscription. Or paste a token from `claude setup-token` run on your computer.' },
      { id: 'claude-plan', kind: 'plan', label: 'Coding plan', hint: 'A flat-rate API package from another provider — the claude agent runs on their model.' },
    ],
  },
  {
    agent: 'codex', label: 'Codex agent', emoji: '🟢',
    blurb: 'OpenAI’s coding agent. Authorize with an OpenAI API key or your ChatGPT plan sign-in.',
    methods: [
      { id: 'openai', kind: 'key', label: 'API key', hint: 'Key from platform.openai.com (sk-…)' },
      { id: 'codex-oauth', kind: 'json', label: 'ChatGPT plan', terminal: true, hint: 'Sign in below — a terminal opens in your workspace showing a link and a code; open the link, sign in to ChatGPT, enter the code. (Or, on your own computer: codex login, then paste ~/.codex/auth.json here.)' },
    ],
  },
  {
    agent: 'gemini', label: 'Gemini agent', emoji: '🔷',
    blurb: 'Google’s coding agent. Authorize with a Gemini API key or your Google sign-in.',
    methods: [
      { id: 'gemini', kind: 'key', label: 'API key', hint: 'Key from aistudio.google.com (AIza…)' },
      { id: 'gemini-oauth', kind: 'json', label: 'Google sign-in', terminal: true, hint: 'Sign in below — a terminal opens in your workspace; open the Google URL it shows and paste the code back. Or paste ~/.gemini/oauth_creds.json from your computer.' },
    ],
  },
  {
    agent: 'qwen', label: 'Qwen agent', emoji: '🟣',
    blurb: 'Alibaba’s coding agent. Authorize with a DashScope API key or the free qwen.ai sign-in.',
    methods: [
      { id: 'qwen', kind: 'key', label: 'API key', hint: 'DashScope / Model Studio key (sk-…)' },
      { id: 'qwen-oauth', kind: 'json', label: 'Qwen.ai sign-in', terminal: true, hint: 'Sign in below — a terminal opens in your workspace; authorize on qwen.ai (free 2000 requests/day). Or paste ~/.qwen/oauth_creds.json from your computer.' },
    ],
  },
  {
    agent: 'kimi', label: 'Kimi agent', emoji: '🌙',
    blurb: 'Moonshot’s Kimi Code CLI. Authorize with your Kimi subscription or a Moonshot API key.',
    methods: [
      { id: 'kimi', kind: 'key', label: 'API key', hint: 'Moonshot API key (sk-…) from platform.moonshot.ai — stored in your workspace’s ~/.kimi-code/config.toml.' },
      { id: 'kimi-oauth', kind: 'json', label: 'Subscription', terminal: true, hint: 'Sign in below — a terminal opens in your workspace; complete the Kimi device-code login (uses your Kimi Code subscription). Or paste your computer’s ~/.kimi-code/config.toml.' },
    ],
  },
  {
    agent: 'grok', label: 'Grok agent', emoji: '🛰️',
    blurb: 'xAI’s Grok Build CLI. Authorize with your SuperGrok / X Premium+ subscription or an xAI API key. Bonus: a subscription sign-in also unlocks Grok Imagine for build media — image/video generation on your plan’s Imagine credits (used when preferred or when no paid media key is set).',
    methods: [
      { id: 'grok', kind: 'key', label: 'API key', hint: 'xAI API key (xai-…) from console.x.ai — used as XAI_API_KEY.' },
      { id: 'grok-oauth', kind: 'json', label: 'Subscription', terminal: true, hint: 'Sign in below — a terminal opens in your workspace; complete the xAI device-code login (SuperGrok / X Premium+). Or paste your computer’s ~/.grok/auth.json.' },
    ],
  },
  {
    agent: 'vibe', label: 'Vibe agent', emoji: '🎛️',
    blurb: 'Mistral’s Vibe Code CLI. Authorize with a Mistral API key.',
    methods: [{ id: 'vibe', kind: 'key', label: 'API key', hint: 'Mistral API key from console.mistral.ai — used as MISTRAL_API_KEY.' }],
  },
  {
    agent: 'glm', label: 'GLM agent (BytePlus Coding Plan)', emoji: '⚡',
    blurb: 'Budget worker on the BytePlus Coding Plan (GLM-5.1 by default; the plan also offers Dola Seed, Kimi K2.5, GPT-OSS…). Works out of the box on the platform plan — add your own ARK key to use yours. ONE ARK key covers this coding plan AND Seedance video, so a key saved here (or on the Video card) is reused for both.',
    methods: [{ id: 'glm', kind: 'key', label: 'ARK API key', hint: 'BytePlus console → API keys. Runs on the coding base (…/api/coding/v3) so it draws from your Coding Plan quota — never the separately-billed base-model endpoint. The same key also unlocks the “BytePlus GLM” coding-plan preset (leave its key blank) and Seedance video.' }],
  },
  {
    agent: 'github', label: 'GitHub', emoji: '🐙',
    blurb: 'Optional: a token lets finished builds push to your own GitHub account. The token must be able to CREATE repos and push to them — a token that can’t ends the build with “push failed”.',
    methods: [{ id: 'github', kind: 'key', label: 'Personal access token', hint: 'Recommended: a classic token (ghp_…) with the “repo” scope — simplest and most reliable. A fine-grained token (github_pat_…) also works, but only with: Repository access “All repositories” + Contents “Read and write” + Administration “Read and write” (Administration is what allows creating the repo).' }],
  },
];

// Mobile-app / backend credentials for flutter-app builds. Optional and EMPTY by
// default — each tenant supplies their own (the apkipa admin Firebase is never shared).
// Rendered as their own group below the coding agents; same vault store + routes.
export const MOBILE_CARDS = [
  {
    agent: 'firebase', label: 'Firebase', emoji: '🔥',
    blurb: 'Optional backend for your apps — accounts, cloud database, push. Easiest: sign in with the Firebase CLI (like the agent sign-ins) and builds auto-configure with “flutterfire configure” — no file to export. Or paste your own google-services.json.',
    methods: [
      { id: 'firebase-oauth', kind: 'token', label: 'Sign in (CLI)', terminal: true, hint: 'Recommended. Sign in below — a terminal opens in your workspace; run the Firebase login and paste the auth code it shows. Builds then run “flutterfire configure” against your account (selects/creates a project + generates the config). Nothing to export or paste.' },
      { id: 'firebase', kind: 'json', label: 'google-services.json', hint: 'Fallback: paste your Android google-services.json (Firebase console → Project settings → your Android app). Materialized into the build, never committed.' },
    ],
  },
  {
    agent: 'google-play', label: 'Google Play', emoji: '🎮',
    blurb: 'Programmatic Play uploads via a service account (the “Submit to Play” step generates the CI workflow). The very first .aab upload + app creation are manual in Play Console (Google’s rules) — the generated SUBMISSION-PLAY.md walks you through it.',
    methods: [{ id: 'google-play', kind: 'json', label: 'Service account JSON', hint: 'How to get it: Google Cloud Console → IAM & Admin → Service Accounts → Create → open it → Keys → Add key → Create new key → JSON (downloads). Enable the “Google Play Android Developer API”, then Play Console → Users and permissions → Invite the SA email (…@….iam.gserviceaccount.com) with Release/Admin access. Paste the JSON contents here (must contain client_email + private_key).' }],
  },
  {
    agent: 'codemagic', label: 'Codemagic (iOS)', emoji: '🍏',
    blurb: 'Cloud-macOS CI that builds + submits your iOS app to TestFlight (managed App Store Connect signing). Used by the “Submit to App Store” step on a finished build. The Apple App Store Connect key itself lives in Codemagic’s integration — here you just add the API token.',
    methods: [{ id: 'codemagic', kind: 'key', label: 'API token', hint: 'Codemagic → Teams / User settings → Integrations → API token. In Codemagic, set up an App Store Connect integration named “CodemagicAppStoreKey” (Issuer ID + Key ID + .p8 from Apple).' }],
  },
];

export const MEDIA_CARDS = [
  {
    agent: 'ark', label: 'Video (BytePlus ModelArk)', emoji: '🎬',
    blurb: 'Optional — generate short hero/product-demo videos inside your builds. Off by default per build; enable it and set a cap in New Build. Providers: BytePlus Seedance (this ARK key — shared with the GLM card) or Grok Imagine on a Grok subscription sign-in (no extra spend; used when preferred or when no ARK key is set).',
    methods: [{ id: 'ark', kind: 'key', label: 'ARK API key', hint: 'BytePlus console → API keys (same key as the Coding Plan). Video runs on ModelArk (…/api/v3) and bills pay-as-you-go to your BytePlus account — Seedance is not part of the Coding Plan quota.' }],
  },
  {
    agent: 'suno', label: 'Music (Suno)', emoji: '🎵',
    blurb: 'Optional — generate background music / sound for apps, games, and product demos (Suno via sunoapi.org). Off by default; enable per build.',
    methods: [{ id: 'suno', kind: 'key', label: 'API key', hint: 'sunoapi.org API key. Used for music generation.' }],
  },
  {
    agent: 'elevenlabs', label: 'Voiceover (ElevenLabs)', emoji: '🎙️',
    blurb: 'Optional — generate narration / voiceover for demos and apps (ElevenLabs). Off by default; enable per build.',
    methods: [{ id: 'elevenlabs', kind: 'key', label: 'API key', hint: 'ElevenLabs API key (xi-api-key). Used for text-to-speech voiceover.' }],
  },
];

export const RESEARCH_CARDS = [
  {
    agent: 'perplexity', label: 'Perplexity (web research)', emoji: '🔎',
    blurb: 'Optional — grounds your build plans in current reality. With a key connected, planning runs one cheap Sonar web-search call (with citations) so PRDs reflect real competitor features, current library versions, and live facts instead of training-data guesses.',
    methods: [{ id: 'perplexity', kind: 'key', label: 'API key', hint: 'perplexity.ai → Settings → API (keys start pplx-…). Planning uses the cheapest Sonar tier (~a cent per plan); no key = planning works exactly as before.' }],
  },
  {
    agent: 'apify', label: 'Apify (real data)', emoji: '🕷️',
    blurb: 'Optional — token for the Apify actor marketplace (thousands of ready scrapers: Google Maps, Amazon, social…). Connected now for upcoming data-powered builds (real seed datasets instead of placeholder content); the live balance shows your plan headroom.',
    methods: [{ id: 'apify', kind: 'key', label: 'API token', hint: 'console.apify.com → Settings → API & Integrations (tokens start apify_api_…). Actor runs spend your Apify plan credits.' }],
  },
];

export const WINDOWS_CARDS = [
  {
    agent: 'windows-store', label: 'Microsoft Store', emoji: '🏪',
    blurb: 'Optional — only for packaging a finished web-app build for the Microsoft Store. Reserve your app in Partner Center (free), then paste the three Product-identity values here once; the “Build Store package” step uses them automatically.',
    methods: [{ id: 'windows-store', kind: 'json', label: 'Product identity JSON', hint: 'Partner Center → your app → Product management → Product identity. Paste: {"identityName":"12345Publisher.AppName","publisher":"CN=xxxxxxxx-…","publisherDisplayName":"Your Name"}.' }],
  },
  {
    agent: 'windows-signing', label: 'Windows signing (installer)', emoji: '🔏',
    blurb: 'Optional — code-sign the direct-download installer for SmartScreen-clean sideloading. NOT needed for the Store (Microsoft re-signs Store uploads). “Submit to Store” wires this to the repo as GitHub Actions secrets.',
    methods: [{ id: 'windows-signing', kind: 'json', label: 'Certificate JSON', hint: 'Paste {"pfxBase64":"<base64 of your .pfx>","password":"…"}. Stored encrypted; set as WINDOWS_CERT_BASE64 / WINDOWS_CERT_PASSWORD Actions secrets, never committed to the repo.' }],
  },
];

// Categorical, at-a-glance facts per agent: who provides it, what credential YOU
// supply, and where to get it. The "model used" line is computed live (below).
const AGENT_META = {
  claude: {
    provider: 'Anthropic',
    provide: 'Anthropic API key (sk-ant-…), your Claude Pro/Max sign-in, or a coding plan',
    ref: { label: 'console.anthropic.com', url: 'https://console.anthropic.com/settings/keys' },
  },
  codex: {
    provider: 'OpenAI',
    provide: 'OpenAI API key (sk-…) or your ChatGPT plan sign-in',
    ref: { label: 'platform.openai.com', url: 'https://platform.openai.com/api-keys' },
    modelFallback: 'Codex CLI default',
  },
  gemini: {
    provider: 'Google',
    provide: 'Gemini API key (AIza…) or your Google sign-in',
    ref: { label: 'aistudio.google.com', url: 'https://aistudio.google.com/apikey' },
    modelFallback: 'Gemini CLI default',
  },
  qwen: {
    provider: 'Alibaba Model Studio (DashScope)',
    provide: 'DashScope API key (sk-…) or the free qwen.ai sign-in',
    ref: { label: 'Model Studio docs', url: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key' },
    modelFallback: 'Qwen CLI default',
  },
  kimi: {
    provider: 'Moonshot (Kimi Code CLI)',
    provide: 'Moonshot/Kimi API key (sk-…)',
    ref: { label: 'platform.moonshot.ai', url: 'https://platform.moonshot.ai/console/api-keys' },
    model: 'kimi-k2.7-code',
  },
  grok: {
    provider: 'xAI (Grok Build CLI)',
    provide: 'xAI API key (xai-…)',
    ref: { label: 'console.x.ai', url: 'https://console.x.ai' },
    model: 'grok-build-0.1',
  },
  vibe: {
    provider: 'Mistral (Vibe Code CLI)',
    provide: 'Mistral API key',
    ref: { label: 'console.mistral.ai', url: 'https://console.mistral.ai/home?profile_dialog=api-keys' },
    model: 'mistral-vibe-cli-latest',
  },
  glm: {
    provider: 'BytePlus (Ark) · model by Z.ai',
    provide: 'Optional — runs on the platform plan; add a BytePlus/GLM key to use yours',
    ref: { label: 'console.byteplus.com', url: 'https://console.byteplus.com' },
    model: 'GLM-5.1',
  },
  github: {
    provider: 'GitHub',
    provide: 'Recommended: a classic token (ghp_…) with the “repo” scope — simplest and most reliable. Fine-grained tokens work too but need more setup.',
    ref: { label: 'github.com/settings/tokens', url: 'https://github.com/settings/tokens' },
    noModel: true,
  },
};

// The "model used" line — credential-aware so it shows what will ACTUALLY run:
//  · a connected coding plan (e.g. OpenRouter) → that plan's model id
//  · otherwise the live solo build/review models, or a documented CLI default.
function modelLine(agent, meta, keys, soloModels, presets) {
  if (meta.noModel) return null;
  if (meta.model) return meta.model; // static (glm)
  if (agent === 'claude') {
    const plan = keys.find((k) => k.provider === 'claude-plan');
    if (plan) {
      const preset = (presets || []).find((p) => p.id === plan.preset);
      const id = plan.model || preset?.model;
      const via = preset?.label || plan.preset || 'coding plan';
      if (id) return `${id} — via ${via}`;
    }
  }
  const sm = soloModels?.[agent];
  if (sm && (sm.build || sm.review)) {
    const parts = [];
    if (sm.build) parts.push(`builds ${sm.build}`);
    if (sm.review) parts.push(`reviews ${sm.review}`);
    return parts.join(' · ');
  }
  return meta.modelFallback || 'CLI default model';
}

function SpecRow({ icon, label, children }) {
  return (
    <div className="flex gap-2">
      <span className="w-[5.5rem] shrink-0 text-muted">{icon} {label}</span>
      <span className="flex-1 text-slate-700">{children}</span>
    </div>
  );
}

function SpecPanel({ agent, keys, soloModels, presets }) {
  const meta = AGENT_META[agent];
  if (!meta) return null;
  const model = modelLine(agent, meta, keys, soloModels || {}, presets);
  return (
    <div className="mt-3 space-y-1 rounded-lg border border-border bg-panel2/60 px-3 py-2 text-xs">
      <SpecRow icon="🏢" label="Provider">{meta.provider}</SpecRow>
      <SpecRow icon="🔑" label="You provide">{meta.provide}</SpecRow>
      {model && <SpecRow icon="🧠" label="Model used">{model}</SpecRow>}
      <SpecRow icon="📖" label="Reference">
        <a className="text-accent underline" href={meta.ref.url} target="_blank" rel="noreferrer">{meta.ref.label} ↗</a>
      </SpecRow>
    </div>
  );
}

// How the active credential bills, by method kind.
function billingLabel(kind) {
  if (kind === 'key') return 'API key · pay per token';
  if (kind === 'plan') return 'coding plan · flat rate';
  return 'subscription · flat rate'; // token / json sign-in
}
// Where to check usage/billing, by credential method (coding plans depend on the preset).
const USAGE_URLS = {
  anthropic: 'https://console.anthropic.com/settings/usage', 'claude-oauth': 'https://claude.ai/settings/usage',
  openai: 'https://platform.openai.com/usage', 'codex-oauth': 'https://chatgpt.com/#settings',
  gemini: 'https://aistudio.google.com/app/usage', 'gemini-oauth': 'https://console.cloud.google.com/billing',
  qwen: 'https://bailian.console.aliyun.com/', 'qwen-oauth': 'https://chat.qwen.ai/',
  // kimi-oauth = the Kimi Code SUBSCRIPTION: quota is shared with the Kimi membership and is
  // only visible on the membership quota page (no public API — probed 2026-07-02: no
  // usage/quota endpoints on api.kimi.com/coding/v1, no rate headers on completions).
  kimi: 'https://platform.moonshot.ai/console/account', 'kimi-oauth': 'https://www.kimi.com/membership/subscription?tab=quota',
  grok: 'https://console.x.ai/', 'grok-oauth': 'https://grok.com/',
  // glm = BytePlus Coding Plan: the console's subscription page shows remaining plan quota.
  vibe: 'https://console.mistral.ai/usage',
  glm: 'https://console.byteplus.com/ark/region:ark+ap-southeast-1/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe',
  github: 'https://github.com/settings/billing',
  perplexity: 'https://www.perplexity.ai/account/api', apify: 'https://console.apify.com/billing',
};
const PLAN_USAGE_URLS = {
  openrouter: 'https://openrouter.ai/credits', deepseek: 'https://platform.deepseek.com/usage',
  zai: 'https://z.ai/manage-apikey/apikey-list', kimi: 'https://platform.moonshot.ai/console/account',
  minimax: 'https://www.minimax.io/platform', byteplus: 'https://console.byteplus.com/', qwencode: 'https://bailian.console.aliyun.com/',
};
function usageUrlFor(methodId, preset) {
  if (methodId === 'claude-plan') return PLAN_USAGE_URLS[preset] || 'https://openrouter.ai/credits';
  return USAGE_URLS[methodId] || null;
}

function MethodBadge({ saved, kind }) {
  if (!saved) return null;
  // Platform-supplied (secrets.json) key surfaced for the admin — label it, don't show last4.
  // last4 of a JSON credential (plan/oauth file) is mangled punctuation — omit it.
  const tail = saved.platform ? ' · platform'
    : ((kind === 'key' || kind === 'token') ? ` · •••• ${saved.last4}` : '');
  return <span className="badge bg-ok/15 text-ok">connected{tail}</span>;
}

// Compact "days left" for the tracking summary line (mirrors ralph/sub-tracking.mjs).
const daysLeft = (endDate) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) return null;
  return Math.floor((Date.parse(`${endDate}T23:59:59Z`) - Date.now()) / 86_400_000);
};

export function AgentCard({ card, keys, presets, cliLogins, soloModels, onSave, onRemove, busy, showUsage = false, tracking = null, onTrack = null }) {
  const saved = (id) => keys.find((k) => k.provider === id);
  const signedIn = (cliLogins || []).includes(card.agent); // OAuth file already in the sandbox
  const active = card.methods.find((m) => saved(m.id));
  const [method, setMethod] = useState(active?.id || card.methods[0].id);
  const m = card.methods.find((x) => x.id === method) || card.methods[0];
  const cur = saved(m.id);
  const [val, setVal] = useState('');
  const [test, setTest] = useState(null);   // { tested, valid, message, reason } | null
  const [testing, setTesting] = useState(false);
  // coding-plan extra fields
  const [preset, setPreset] = useState('zai');
  const [planUrl, setPlanUrl] = useState('');
  const [planModel, setPlanModel] = useState('');
  const presetInfo = (presets || []).find((p) => p.id === preset);

  // "How am I connected + usage": reflects the active connection (or the selected method
  // before connecting). Live balance is fetched only for connected, supported providers.
  const conn = active || m;
  const connSaved = !!saved(conn.id);
  const planPreset = saved('claude-plan')?.preset || preset;
  const usageHref = usageUrlFor(conn.id, planPreset);
  const [usage, setUsage] = useState(null);
  const fetchUsage = () => {
    setUsage({ loading: true });
    api.usage(conn.id).then((d) => setUsage(d.supported === false ? { unsupported: true } : d)).catch(() => setUsage({ error: 1 }));
  };
  useEffect(() => {
    if (!showUsage || !connSaved) { setUsage(null); return undefined; }
    let on = true; setUsage({ loading: true });
    api.usage(conn.id).then((d) => { if (on) setUsage(d.supported === false ? { unsupported: true } : d); }).catch(() => { if (on) setUsage({ error: 1 }); });
    return () => { on = false; };
  }, [conn.id, connSaved, showUsage]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (m.kind === 'plan') {
      await onSave(m.id, JSON.stringify({ preset, key: val.trim(), baseUrl: planUrl.trim() || undefined, model: planModel.trim() || undefined }));
    } else {
      await onSave(m.id, val.trim());
    }
    setVal('');
  }

  // The connection the Test / Remove buttons act on: the selected method if it's connected,
  // otherwise whatever method this agent is actually connected through. undefined = nothing
  // to test or remove, so the buttons stay hidden.
  const connForActions = cur ? m : active;
  async function runTest(id) {
    setTesting(true); setTest(null);
    try { setTest(await api.testKey(id)); }
    catch (e) { setTest({ tested: true, valid: false, message: e.message }); }
    finally { setTesting(false); }
  }

  return (
    <div className="card py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{card.emoji} {card.label}</p>
          <p className="mt-0.5 text-xs text-muted">{card.blurb}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onTrack && (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={onTrack}
              title="Track this subscription: start/end dates, peak hours, usage, notes, link">
              📋 Track
            </button>
          )}
          {active
            ? <MethodBadge saved={saved(active.id)} kind={active.kind} />
            : signedIn && <span className="badge bg-ok/15 text-ok">signed in ✓</span>}
        </div>
      </div>

      {tracking && (
        <p className="mt-1.5 text-xs text-muted">
          📋 {tracking.startDate && <>from {tracking.startDate} </>}
          {tracking.endDate && (
            <span className={daysLeft(tracking.endDate) != null && daysLeft(tracking.endDate) < 7 ? 'text-warn' : ''}>
              until {tracking.endDate}{daysLeft(tracking.endDate) != null && (daysLeft(tracking.endDate) >= 0
                ? ` (${daysLeft(tracking.endDate)}d left)` : ' (ended)')}
            </span>
          )}
          {tracking.peakHours && <> · ⚡ {tracking.peakHours}</>}
          {tracking.usage && <> · {tracking.usage}</>}
          {tracking.link && <> · <a className="text-accent hover:underline" href={tracking.link} target="_blank" rel="noreferrer">dashboard ↗</a></>}
        </p>
      )}

      <SpecPanel agent={card.agent} keys={keys} soloModels={soloModels} presets={presets} />

      {showUsage && card.agent !== 'github' && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="text-slate-600">{billingLabel(conn.kind)}</span>
          {connSaved && usage && !usage.loading && !usage.unsupported && !usage.error && (
            usage.unlimited
              ? <span className="text-ok">· uncapped</span>
              : usage.available != null && <span className="text-ok">· {usage.currency === 'USD' ? '$' : ''}{Number(usage.available).toFixed(2)}{usage.currency && usage.currency !== 'USD' ? ' ' + usage.currency : ''} left</span>
          )}
          {connSaved && usage?.loading && <span>· checking…</span>}
          {connSaved && usage?.error && <span className="text-warn">· balance unavailable</span>}
          {connSaved && usage && !usage.unsupported && (
            <button type="button" className="hover:text-slate-900" title="Refresh balance" onClick={fetchUsage}>↻</button>
          )}
          {usageHref && <a className="text-accent hover:underline" href={usageHref} target="_blank" rel="noreferrer">Check usage ↗</a>}
        </div>
      )}

      {card.methods.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {card.methods.map((x) => (
            <button key={x.id} type="button" onClick={() => { setMethod(x.id); setVal(''); setTest(null); }}
              className={`badge cursor-pointer px-3 py-1 ${method === x.id ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'bg-panel2 text-muted'}`}>
              {x.label}{saved(x.id) ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-muted">{m.hint}</p>

      {m.terminal && (
        <button type="button" className="btn-primary mt-2 px-4 py-1.5 text-xs"
          onClick={async () => {
            try {
              const { session } = await api.cliLogin(card.agent);
              window.open(`/term.html?s=${encodeURIComponent(session)}`, '_blank');
            } catch (e) { alert(e.message); }
          }}>
          {signedIn ? '↻ Sign in again via terminal' : '⌨ Sign in via terminal'}
        </button>
      )}

      {m.kind === 'plan' && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {(presets || []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input className="input" placeholder={presetInfo?.model ? `Model (default ${presetInfo.model})` : 'Model id (e.g. x-ai/grok-code-fast-1)'}
            value={planModel} onChange={(e) => setPlanModel(e.target.value)} />
          {preset === 'custom' && (
            <input className="input sm:col-span-2" placeholder="https://… Anthropic-compatible base URL"
              value={planUrl} onChange={(e) => setPlanUrl(e.target.value)} />
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {m.kind === 'json'
          ? <textarea className="input flex-1 font-mono text-xs" rows={3}
              placeholder={cur ? 'Replace credential JSON…' : 'Paste the JSON file content…'}
              value={val} onChange={(e) => setVal(e.target.value)} />
          : <input className="input flex-1" type="password"
              placeholder={cur ? 'Replace…' : (m.kind === 'plan' ? 'Paste the plan API key…' : 'Paste…')}
              value={val} onChange={(e) => setVal(e.target.value)} />}
        <button className="btn-primary px-4" disabled={busy === m.id || !val.trim()} onClick={save}>Save</button>
        {connForActions && (
          <button type="button" className="btn-ghost px-3" disabled={testing}
            title="Check that the saved credential is still valid" onClick={() => runTest(connForActions.id)}>
            {testing ? 'Testing…' : '🔌 Test'}
          </button>
        )}
        {connForActions && (
          <button type="button" className="btn-ghost px-3 text-warn" disabled={busy === connForActions.id}
            onClick={() => { if (window.confirm(`Remove the “${connForActions.label}” credential for ${card.label}? ${card.label} will stop working until you connect a new one.`)) { setTest(null); onRemove(connForActions.id); } }}>
            🗑 Remove
          </button>
        )}
      </div>
      {connForActions && test && (
        <p className={`mt-2 text-xs ${test.tested === false ? 'text-muted' : test.valid === true ? 'text-ok' : test.valid === false ? 'text-warn' : 'text-muted'}`}>
          {test.tested === false ? test.reason : test.message}
        </p>
      )}
    </div>
  );
}

export default function Settings({ me, open }) {
  const [keys, setKeys] = useState(null); // null=loading, [] = none, 'na' = not available (open mode)
  const [presets, setPresets] = useState([]);
  const [cliLogins, setCliLogins] = useState([]);
  const [soloModels, setSoloModels] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [tracking, setTracking] = useState({}); // provider -> planning notes
  const [trackFor, setTrackFor] = useState(null); // card being edited in the Track dialog

  const load = () => {
    api.keys().then((d) => { setKeys(d.keys || []); setPresets(d.planPresets || []); setCliLogins(d.cliLogins || []); }).catch(() => setKeys('na'));
    api.tracking().then((d) => setTracking(d.tracking || {})).catch(() => {});
  };
  // Authoritative model map (admin-managed) for the "Model used" line; best-effort.
  useEffect(() => { api.soloModels().then((d) => setSoloModels(d.models || {})).catch(() => {}); }, []);
  // Re-check on load and whenever the tab regains focus (returning from a
  // terminal sign-in tab) so the "signed in" badge appears without a refresh.
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  async function save(p, value) {
    setBusy(p); setMsg('');
    try { await api.setKey(p, value); setMsg(`${p} saved`); load(); }
    catch (e) { setMsg(`${p}: ${e.message}`); }
    finally { setBusy(''); }
  }
  async function remove(p) {
    setBusy(p); setMsg('');
    try { await api.deleteKey(p); setMsg(`${p} removed`); load(); }
    catch (e) { setMsg(`${p}: ${e.message}`); }
    finally { setBusy(''); }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3 text-sm text-muted">
        <button className="hover:text-slate-900" onClick={() => go('/app')}>← Builds</button>
        <span className="opacity-40">/</span>
        <span className="text-slate-700">Settings</span>
      </div>

      <h1 className="text-2xl font-bold">Providers</h1>
      <p className="mt-1 text-sm text-muted">Agents run on <b>your</b> account — an API key, your existing subscription
        (Claude Pro/Max, ChatGPT, Google, qwen.ai), or a flat-rate coding plan. Stored encrypted (AES-256-GCM), used
        only to run your builds — planning uses the same credential. Connect at least one.</p>

      {msg && <div className="mt-4 rounded-lg border border-border bg-panel2 px-4 py-2 text-sm text-slate-700">{msg}</div>}

      {keys === 'na' && (
        <div className="card mt-6 text-sm text-muted">
          Per-account credentials are available when multi-tenant mode is on. In single-tenant mode keys are read
          from the server’s <code className="text-accent">~/.webtmux/secrets.json</code>.
        </div>
      )}

      {keys === null && <div className="card mt-6 text-muted">Loading…</div>}

      {Array.isArray(keys) && (
        <div className="mt-6 space-y-3">
          {AGENT_CARDS.map((c) => (
            <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={cliLogins}
              soloModels={soloModels} onSave={save} onRemove={remove} busy={busy} showUsage
              tracking={tracking[c.agent]} onTrack={() => setTrackFor(c)} />
          ))}
        </div>
      )}

      {Array.isArray(keys) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Mobile app &amp; backend</h2>
          <p className="mt-1 text-sm text-muted">Optional — only needed for <b>Flutter app</b> builds. Empty by default; add your own when you build a mobile app.</p>
          <div className="mt-3 space-y-3">
            {MOBILE_CARDS.map((c) => (
              <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={cliLogins}
                soloModels={soloModels} onSave={save} onRemove={remove} busy={busy}
                tracking={tracking[c.agent]} onTrack={() => setTrackFor(c)} />
            ))}
          </div>
        </div>
      )}

      {Array.isArray(keys) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Media generation</h2>
          <p className="mt-1 text-sm text-muted">Optional — generate images/video/music/voiceover inside builds. <b>Images</b> use your token-plan/Qwen key (already connected). Video/music/voiceover need their own keys below and are <b>off by default</b> per build.</p>
          <div className="mt-3 space-y-3">
            {MEDIA_CARDS.map((c) => (
              <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={cliLogins}
                soloModels={soloModels} onSave={save} onRemove={remove} busy={busy}
                tracking={tracking[c.agent]} onTrack={() => setTrackFor(c)} />
            ))}
          </div>
        </div>
      )}

      {Array.isArray(keys) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Research &amp; data</h2>
          <p className="mt-1 text-sm text-muted">Optional — ground plans in live web facts (Perplexity) and real datasets (Apify). Builds work without them; with them, plans cite current reality. <b>Live usage</b> shows Sonar spend on Perplexity’s console and plan headroom for Apify.</p>
          <div className="mt-3 space-y-3">
            {RESEARCH_CARDS.map((c) => (
              <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={cliLogins}
                soloModels={soloModels} onSave={save} onRemove={remove} busy={busy} showUsage
                tracking={tracking[c.agent]} onTrack={() => setTrackFor(c)} />
            ))}
          </div>
        </div>
      )}

      {Array.isArray(keys) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Windows desktop &amp; Store</h2>
          <p className="mt-1 text-sm text-muted">Optional — only for <b>web-app</b> builds you package for Windows. The installer + Store package build without any of this; add the Partner Center identity to skip retyping it per build.</p>
          <div className="mt-3 space-y-3">
            {WINDOWS_CARDS.map((c) => (
              <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={cliLogins}
                soloModels={soloModels} onSave={save} onRemove={remove} busy={busy}
                tracking={tracking[c.agent]} onTrack={() => setTrackFor(c)} />
            ))}
          </div>
        </div>
      )}

      {Array.isArray(keys) && (
        <div className="mt-8">
          <McpServers />
        </div>
      )}

      {!open && me?.plan && (
        <div className="card mt-8">
          <h2 className="font-semibold">Plan</h2>
          <p className="mt-1 text-sm text-muted">You’re on the <span className="text-accent">{me.plan}</span> plan.</p>
        </div>
      )}

      {trackFor && (
        <TrackDialog card={trackFor} entry={tracking[trackFor.agent]}
          onClose={() => setTrackFor(null)}
          onSave={async (f) => {
            const d = await api.saveTracking(trackFor.agent, f);
            setTracking(d.tracking || {}); setTrackFor(null);
          }}
          onRemove={async () => {
            const d = await api.deleteTracking(trackFor.agent);
            setTracking(d.tracking || {}); setTrackFor(null);
          }} />
      )}
    </div>
  );
}

// Subscription tracking dialog: the user's planning notes for one provider — dates, peak
// hours, current usage, a dashboard link, free-form notes. Display-only (the summary line
// on the card + this dialog); never gates a build, never holds a secret.
function TrackDialog({ card, entry, onSave, onRemove, onClose }) {
  const [f, setF] = useState({
    startDate: '', endDate: '', peakHours: '', usage: '', notes: '', link: '',
    ...(entry ? {
      startDate: entry.startDate || '', endDate: entry.endDate || '', peakHours: entry.peakHours || '',
      usage: entry.usage || '', notes: entry.notes || '', link: entry.link || '',
    } : {}),
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const left = daysLeft(f.endDate);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 font-semibold">📋 Track {card.emoji} {card.label}</h3>
        <p className="mb-3 text-xs text-muted">Your planning notes for this subscription — kept per account, summarized on the card. Never used to gate builds.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Start date</label>
            <input type="date" className="input" value={f.startDate} onChange={set('startDate')} />
          </div>
          <div>
            <label className="label">End / renewal date</label>
            <input type="date" className="input" value={f.endDate} onChange={set('endDate')} />
          </div>
        </div>
        {left != null && (
          <p className={`mt-1 text-xs ${left < 7 ? 'text-warn' : 'text-muted'}`}>
            {left >= 0 ? `${left} day${left === 1 ? '' : 's'} left` : 'already ended'}
          </p>
        )}
        <label className="label mt-3">Peak / off-peak hours</label>
        <input className="input" placeholder="e.g. off-peak 00:00–08:00 UTC — 50% cheaper" value={f.peakHours} onChange={set('peakHours')} />
        <label className="label mt-3">Current usage</label>
        <input className="input" placeholder="e.g. ~40% of the monthly quota used" value={f.usage} onChange={set('usage')} />
        <label className="label mt-3">Usage dashboard / link</label>
        <input className="input" placeholder="https://…" value={f.link} onChange={set('link')} />
        <label className="label mt-3">Notes</label>
        <textarea className="input" rows={3} placeholder="renewal reminders, plan-change ideas, promo codes…" value={f.notes} onChange={set('notes')} />
        <div className="mt-4 flex items-center justify-between gap-2">
          {entry
            ? <button className="btn-ghost px-3 py-1.5 text-xs text-warn" disabled={busy} onClick={onRemove}>Remove tracking</button>
            : <span />}
          <div className="flex gap-2">
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose}>Cancel</button>
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy}
              onClick={async () => { setBusy(true); try { await onSave(f); } finally { setBusy(false); } }}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
