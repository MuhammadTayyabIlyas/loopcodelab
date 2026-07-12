// Extensible provider/model registry for the token-plan integration. Data-first:
// adding a provider is a registry entry, not new plumbing. Pure (no I/O) → unit-tested.
// Plan 2 (media generation) extends this with image/video/audio adapters.

// Alibaba MaaS monthly token-plan models, reachable via ONE sk-sp key over both the
// OpenAI-compatible (/compatible-mode/v1) and Anthropic (/apps/anthropic) bases.
export const TOKEN_PLAN_TEXT_MODELS = Object.freeze([
  { id: 'qwen3.7-max',      label: 'Qwen3.7 Max' },
  { id: 'qwen3.7-plus',     label: 'Qwen3.7 Plus' },
  { id: 'glm-5.2',          label: 'GLM-5.2' },
  { id: 'glm-5.1',          label: 'GLM-5.1' },
  { id: 'kimi-k2.7-code',   label: 'Kimi K2.7 Code' },
  { id: 'deepseek-v4-pro',  label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'MiniMax-M2.5',     label: 'MiniMax M2.5' },
]);

// Image models (used by Plan 2; defined here so the registry is the single source).
export const TOKEN_PLAN_IMAGE_MODELS = Object.freeze([
  { id: 'qwen-image-2.0',     label: 'Qwen-Image 2.0 (fast)' },
  { id: 'qwen-image-2.0-pro', label: 'Qwen-Image 2.0 Pro' },
  { id: 'wan2.7-image',       label: 'Wan 2.7 Image (fast)' },
  { id: 'wan2.7-image-pro',   label: 'Wan 2.7 Image Pro' },
]);

// BytePlus Coding Plan models — ONE ARK key over both coding bases (Anthropic
// /api/coding, OpenAI /api/coding/v3). BILLING TRAP (BytePlus docs): the base-model
// URL /api/v3 does NOT draw from the coding plan — requests there bill separately.
// Only ModelArk features that aren't part of the plan (Seedance video) belong on /api/v3.
// 'ark-code-latest' = console-managed auto mode (BytePlus picks the model).
export const BYTEPLUS_CODING_MODELS = Object.freeze([
  { id: 'ark-code-latest',    label: 'Auto (console-managed)' },
  { id: 'glm-5.1',            label: 'GLM-5.1' },
  { id: 'glm-4.7',            label: 'GLM-4.7' },
  { id: 'kimi-k2.5',          label: 'Kimi K2.5' },
  { id: 'dola-seed-2.0-pro',  label: 'Dola Seed 2.0 Pro' },
  { id: 'dola-seed-2.0-lite', label: 'Dola Seed 2.0 Lite' },
  { id: 'dola-seed-2.0-code', label: 'Dola Seed 2.0 Code' },
  { id: 'bytedance-seed-code', label: 'ByteDance Seed Code' },
  { id: 'gpt-oss-120b',       label: 'GPT-OSS 120B' },
]);

// Apify MCP (Phase D): the hosted server row wired into builds whose stories plan
// `web-data`. Tools are PRECONFIGURED to discovery + docs + the RAG web browser —
// actor EXECUTION deliberately stays with $RALPH_FETCH_DATA so the per-build data
// budget is enforced (MCP-run actors would bypass the counter). Streamable HTTP +
// Bearer auth (SSE deprecated by Apify 2026-04).
export function apifyMcpServer(token) {
  if (!token || typeof token !== 'string') return null;
  return {
    name: 'apify',
    url: 'https://mcp.apify.com/?tools=actors,docs,apify/rag-web-browser',
    auth: token,
    transport: 'http',
    capabilities: ['web-data'],
  };
}

// coding-plan preset id -> curated New Build model list. Presets absent here
// (openrouter/custom/zai/…) keep the free-text model field (any id).
const PLAN_MODELS = { tokenplan: TOKEN_PLAN_TEXT_MODELS, byteplus: BYTEPLUS_CODING_MODELS };

export function planModelsFor(presetId) {
  const list = PLAN_MODELS[presetId];
  // shallow spread is a complete copy for the flat { id, label } shape
  return list ? list.map((m) => ({ ...m })) : [];
}

export function planModelsMap() {
  const out = {};
  for (const id of Object.keys(PLAN_MODELS)) out[id] = planModelsFor(id);
  return out;
}

// The token-plan preset REUSES the qwen credential: a stored claude-plan of
// {preset:'tokenplan'} may have a blank key; resolve it from the qwen key so the
// user never re-pastes sk-sp-…. Every other preset uses its own pasted key.
export function resolveClaudePlanKey(v, { qwenKey = '' } = {}) {
  if (v && v.preset === 'tokenplan' && !v.key) return qwenKey || '';
  return (v && v.key) || '';
}

// Default Anthropic base for the token plan (region ap-southeast-1). Overridable
// via env WEBTMUX_QWEN_ANTHROPIC_BASE or secrets.qwenAnthropicBaseUrl.
export function tokenPlanAnthropicBase(secrets = {}, env = {}) {
  return String(
    env.WEBTMUX_QWEN_ANTHROPIC_BASE || secrets.qwenAnthropicBaseUrl
    || 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
  ).replace(/\/+$/, '');
}

// --- Media generation (Plan 2) -------------------------------------------------
// Each provider declares what it produces (kind) and its wire protocol (adapter).
// image uses the token plan (reuse qwenApiKey); ark/suno/elevenlabs are new vault creds.
export const MEDIA_PROVIDERS = Object.freeze([
  { id: 'ark',        label: 'BytePlus ModelArk (Seedance video)', kind: 'video',
    protocol: 'ark-async',    defaultBase: 'https://ark.ap-southeast.bytepluses.com/api/v3', credential: 'vault' },
  { id: 'suno',       label: 'Suno (music, via sunoapi.org)',      kind: 'music',
    protocol: 'suno-async',   defaultBase: 'https://api.sunoapi.org', credential: 'vault' },
  { id: 'elevenlabs', label: 'ElevenLabs (voiceover)',             kind: 'voiceover',
    protocol: 'elevenlabs-tts', defaultBase: 'https://api.elevenlabs.io', credential: 'vault' },
]);
export function mediaCredentialIds() { return MEDIA_PROVIDERS.map((p) => p.id); }

// Per-build media model pickers (spec §6b): what the New Build UI offers per kind.
// provider ids line up with the env selection in ralphEnvPrefix (server/agents.mjs):
// image tokenplan|grok, video ark|grok, music suno, voiceover elevenlabs|grok.
export const MEDIA_MODEL_CHOICES = Object.freeze({
  image: Object.freeze([
    ...TOKEN_PLAN_IMAGE_MODELS.map((m) => ({ provider: 'tokenplan', id: m.id, label: m.label })),
    { provider: 'grok', id: 'grok-imagine-image', label: 'Grok Imagine (subscription)' },
  ]),
  video: Object.freeze([
    { provider: 'grok', id: 'grok-imagine-video',    label: 'Grok Imagine (subscription)' },
    { provider: 'ark',  id: 'seedance-1-0-pro-250528', label: 'Seedance 1.0 Pro (pay per second)' },
  ]),
  music: Object.freeze([
    { provider: 'suno', id: 'V4_5', label: 'Suno v4.5' },
    { provider: 'suno', id: 'V4',   label: 'Suno v4' },
  ]),
  voiceover: Object.freeze([
    { provider: 'elevenlabs', id: 'eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2' },
    { provider: 'grok',       id: 'grok-tts',               label: 'Grok TTS (subscription)' },
  ]),
});
export function mediaModelChoices() {
  const out = {};
  for (const [k, list] of Object.entries(MEDIA_MODEL_CHOICES)) out[k] = list.map((m) => ({ ...m }));
  return out;
}
// Sanitize a client-picked {kind:{provider,model}} map: only pairs present in the
// registry survive; anything else falls back to auto (absent key). Pure.
export function normalizeMediaModels(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [kind, list] of Object.entries(MEDIA_MODEL_CHOICES)) {
    const row = input[kind];
    if (!row || typeof row !== 'object') continue;
    const hit = list.find((m) => m.provider === row.provider && m.id === row.model);
    if (hit) out[kind] = { provider: hit.provider, model: hit.id };
  }
  return out;
}
// Format-aware media defaults (spec §6): a social-video build needs video+audio on
// by default or the deliverable can't exist. Only applied when the client sent no
// explicit media config. Returns a new normalized object.
export function withFormatMediaDefaults(media, outputFormat) {
  const out = normalizeMedia(media);
  if (outputFormat === 'social-video') {
    out.image = { enabled: true, cap: Math.max(out.image.cap, 8) };
    out.video = { enabled: true, cap: Math.max(out.video.cap, 2) };
    out.audio = { enabled: true, cap: Math.max(out.audio.cap, 2) };
  }
  return out;
}

// Cost-aware defaults: image cheap+on; video/audio expensive+off.
export const MEDIA_CAP_DEFAULTS = Object.freeze({
  image: Object.freeze({ enabled: true,  cap: 8 }),
  video: Object.freeze({ enabled: false, cap: 2 }),
  audio: Object.freeze({ enabled: false, cap: 3 }),
});
export function mediaCapDefaults() {
  const out = {};
  for (const k of Object.keys(MEDIA_CAP_DEFAULTS)) out[k] = { ...MEDIA_CAP_DEFAULTS[k] };
  return out;
}
const clampCap = (n) => Math.max(0, Math.min(20, Math.floor(Number(n))|| 0));
export function normalizeMedia(input) {
  const out = mediaCapDefaults();
  if (!input || typeof input !== 'object') return out;
  for (const k of Object.keys(out)) {
    const row = input[k];
    if (row && typeof row === 'object') {
      if ('enabled' in row) out[k].enabled = !!row.enabled;
      if ('cap' in row) out[k].cap = clampCap(row.cap);
    }
  }
  return out;
}

// The three generatable media kinds, in the fixed order the clamp walks.
const MEDIA_KINDS = ['image', 'video', 'audio'];
// Sanitize each story's planner/client-supplied `media` hint and clamp the
// per-kind TOTAL across ALL stories to the build's budget, so a plan can never
// exceed the spend the user approved. Disabled kinds are dropped everywhere.
// Deterministic: walks stories in order, giving each what's left of each cap.
// Pure — returns a new array; a story with no positive counts loses its `media`.
export function applyMediaPlan(stories, media) {
  const budget = normalizeMedia(media);
  const remaining = {};
  for (const k of MEDIA_KINDS) remaining[k] = budget[k]?.enabled ? clampCap(budget[k].cap) : 0;
  return (Array.isArray(stories) ? stories : []).map((s) => {
    const raw = (s && s.media && typeof s.media === 'object' && !Array.isArray(s.media)) ? s.media : {};
    const plan = {};
    for (const k of MEDIA_KINDS) {
      const give = Math.min(clampCap(raw[k]), remaining[k]);
      if (give > 0) { plan[k] = give; remaining[k] -= give; }
    }
    const { media: _drop, ...rest } = s || {};
    return Object.keys(plan).length ? { ...rest, media: plan } : rest;
  });
}
