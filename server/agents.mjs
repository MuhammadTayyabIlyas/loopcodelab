// server/agents.mjs — the CLI-agent layer: quick-launch table, per-agent
// credential resolution (vault keys, coding plans, CLI logins), model flags,
// and the env prefix injected into every spawned worker/master session.
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as saasStore from '../saas/store.mjs';
import { soloModelFlag, isSolo, validModelId } from '../ralph/solo-models.mjs';
import { resolveClaudePlanKey, tokenPlanAnthropicBase } from '../ralph/providers.mjs';
import { isFlutterRun, flutterEnvAssignments } from '../ralph/flutter-env.mjs';
import { execFileAsync, RALPH_DIR } from './config.mjs';
import {
  getSecrets, qwenKey, qwenBaseUrl, qwenModel, qwenImageModel, perplexityKey,
  apifyToken, arkKey, arkBaseUrl, sunoKey, sunoBaseUrl, elevenLabsKey, elevenLabsVoice,
  soloModelsEffective, GLM_API_KEY, GLM_BASE_URL, GLM_MODEL, KIMI_MODEL, GROK_MODEL,
} from './secrets.mjs';

// Paths of the agent-invoked media/research helper CLIs injected via RALPH_GEN_* env.
const RALPH_GEN_IMAGE = path.join(RALPH_DIR, 'gen-image.mjs');
const RALPH_GEN_VIDEO = path.join(RALPH_DIR, 'gen-video.mjs');
const RALPH_GEN_AUDIO = path.join(RALPH_DIR, 'gen-audio.mjs');
// Phase C research/data helpers (perplexity cited answers + apify datasets/custom actors).
const RALPH_GEN_RESEARCH_HELPER = path.join(RALPH_DIR, 'gen-research.mjs');
const RALPH_FETCH_DATA_HELPER = path.join(RALPH_DIR, 'fetch-data.mjs');
// Local social-video composition helper ($RALPH_COMPOSE) — free CPU (ffmpeg), no spend.
const RALPH_COMPOSE_HELPER = path.join(RALPH_DIR, 'compose-media.mjs');


// Quick-launch tools, as composable pieces so the same table covers safe /
// bypass and an optional "continue previous context" resume. The client only
// sends a tool key, a mode and a resume flag; the actual argv lives here, so no
// caller can inject one. `resume` carries on from the most recent conversation
// in the session's directory — that's what makes re-entering a project pick up
// where it left off instead of starting fresh. Order matters: codex's `resume`
// is a subcommand, so any bypass flag must precede it (verified to parse).

export const LAUNCHERS = {
  claude: { cmd: 'claude', bypass: '--dangerously-skip-permissions', resume: '--continue' },
  codex:  { cmd: 'codex',  bypass: '--sandbox danger-full-access',   resume: 'resume --last' },
  qwen:   { cmd: 'qwen',   bypass: '--yolo',                          resume: '--continue' },
  gemini: { cmd: 'gemini', bypass: '--yolo',                          resume: '--resume latest' },
  glm:    { cmd: 'ANTHROPIC_BASE_URL="https://ark.ap-southeast.bytepluses.com/api/coding" ANTHROPIC_API_KEY="6f165013-4c71-4e2e-88a5-94ab28d63d86" claude --model GLM-5.1', bypass: '--dangerously-skip-permissions', resume: '--continue' },
  kimi:   { cmd: 'kimi', bypass: '--yolo',           resume: '--continue' }, // Kimi Code CLI (Moonshot); key via ~/.kimi-code/config.toml
  grok:   { cmd: 'grok', bypass: '--always-approve', resume: '--continue' }, // xAI Grok Build CLI; key via XAI_API_KEY
  vibe:   { cmd: 'vibe --trust', bypass: '--yolo',   resume: '--continue' }, // Mistral Vibe CLI; key via MISTRAL_API_KEY
};

// Valid agent keys for the Ralph orchestrator (master + workers come from here).
export const VALID_AGENTS = Object.keys(LAUNCHERS);

// Deployment-wide default agent the New Build UI seeds master + workers from, so a
// single-agent deployment (e.g. Kimi-only) doesn't push users at claude/codex they
// can't use. `WEBTMUX_DEFAULT_AGENT=kimi`. Falls back to claude; never glm (glm can't
// be a master). Other agents stay selectable.
export const DEFAULT_AGENT = (() => {
  const a = (process.env.WEBTMUX_DEFAULT_AGENT || 'claude').trim();
  return (VALID_AGENTS.includes(a) && a !== 'glm') ? a : 'claude';
})();

// Resolve { tool, mode, resume } to a command string. '' tool → plain shell ('').
// Returns null for an unknown tool/mode so the caller can reject it.
export function resolveLaunch(tool, mode, resume) {
  if (!tool) return '';
  const t = LAUNCHERS[tool];
  if (!t) return null;
  if (mode !== 'safe' && mode !== 'bypass') return null;
  const parts = [t.cmd];
  if (mode === 'bypass') parts.push(t.bypass);
  if (resume) parts.push(t.resume);
  return parts.join(' ');
}

// Env prefix common to every spawned agent command (GLM key, bypass toggle, the
// dry-run hook). `run.bypass === false` turns off the agents' dangerous-skip flags.
// A tenant can authorize an agent three ways, all stored in the encrypted vault:
//  1. a raw API key (provider id: anthropic/openai/gemini/qwen)
//  2. a subscription OAuth credential (claude-oauth = `claude setup-token` value;
//     codex-oauth / gemini-oauth / qwen-oauth = the CLI's login JSON file content,
//     written into the tenant's $HOME by the session script before the CLI runs)
//  3. a flat-rate CODING PLAN (claude-plan, JSON {preset,key,baseUrl?,model?}) —
//     an Anthropic-compatible endpoint the claude CLI targets via ANTHROPIC_BASE_URL.
// Single-tenant: all of this is inert (the server's own CLI logins/keys are used).
export const CLAUDE_PLAN_PRESETS = {
  zai:        { label: 'Z.ai GLM Coding Plan', baseUrl: 'https://api.z.ai/api/anthropic', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'glm-5.1' },
  byteplus:   { label: 'BytePlus GLM', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding', authVar: 'ANTHROPIC_API_KEY', model: 'GLM-5.1' },
  kimi:       { label: 'Kimi Code (Moonshot)', baseUrl: 'https://api.moonshot.ai/anthropic', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'kimi-k2.5' },
  deepseek:   { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'deepseek-reasoner' },
  minimax:    { label: 'MiniMax Token Plan', baseUrl: 'https://api.minimax.io/anthropic', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'minimax-m2.7' },
  qwencode:   { label: 'Qwen (DashScope)', baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'qwen3.6-plus' },
  tokenplan:  { label: 'Alibaba Token Plan (Qwen/GLM/Kimi/DeepSeek/MiniMax)', baseUrl: tokenPlanAnthropicBase(getSecrets(), process.env), authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'qwen3.7-max' },
  // xAI Grok / Mistral have no native Anthropic endpoint — route them through
  // OpenRouter (Anthropic-compatible, any model id) or a custom proxy URL.
  openrouter: { label: 'OpenRouter (Grok, Mistral, any model)', baseUrl: 'https://openrouter.ai/api', authVar: 'ANTHROPIC_AUTH_TOKEN', model: '' },
  custom:     { label: 'Custom (Anthropic-compatible URL)', baseUrl: '', authVar: 'ANTHROPIC_AUTH_TOKEN', model: '' },
};
// Vault providers that satisfy each agent (any ONE is enough to run it).
export const AGENT_CRED_PROVIDERS = {
  claude: ['anthropic', 'claude-oauth', 'claude-plan'],
  codex:  ['openai', 'codex-oauth'],
  qwen:   ['qwen', 'qwen-oauth'],
  gemini: ['gemini', 'gemini-oauth'],
  kimi:   ['kimi', 'kimi-oauth'],   // Moonshot API key (config.toml) OR Kimi subscription device-login
  grok:   ['grok', 'grok-oauth'],   // xAI API key (XAI_API_KEY) OR SuperGrok/X Premium+ device-login
  vibe:   ['vibe'],                 // Mistral API key (MISTRAL_API_KEY)
};
// A tenant's vault key (decrypted) for one provider, or null. Inert single-tenant.
export function tenantKey(run, provider) {
  if (!run?.tenant) return null;
  try { return saasStore.getProviderKey(run.tenant.id, provider) || null; } catch { return null; }
}
// Parse + resolve a stored claude-plan credential against its preset.
export function claudePlanOf(get) {
  const raw = get('claude-plan');
  if (!raw) return null;
  let v; try { v = JSON.parse(raw); } catch { return null; }
  const p = CLAUDE_PLAN_PRESETS[v.preset] || CLAUDE_PLAN_PRESETS.custom;
  // tokenplan resolves lazily at call time: its base honors the secrets.json override
  // (secrets is still empty when CLAUDE_PLAN_PRESETS is built at module load), and the
  // qwen vault key is read ONLY for a blank-key tokenplan plan — never for other presets.
  const isTokenPlan = v.preset === 'tokenplan';
  const presetBase = isTokenPlan ? tokenPlanAnthropicBase(getSecrets(), process.env) : p.baseUrl;
  const baseUrl = String(v.baseUrl || presetBase || '').replace(/\/+$/, '');
  // byteplus mirrors tokenplan's blank-key reuse: one ARK key powers the coding plan,
  // the glm agent, and Seedance — resolve a blank-key byteplus plan from those vault keys.
  const bpKey = (v.preset === 'byteplus' && !v.key) ? (get('glm') || get('ark') || '') : '';
  const key = resolveClaudePlanKey({ ...v, key: v.key || bpKey },
    { qwenKey: (isTokenPlan && !v.key) ? (get('qwen') || qwenKey()) : '' });
  if (!baseUrl || !key) return null;
  return { baseUrl, key, authVar: v.authVar || p.authVar, model: v.model || p.model || '' };
}
// Preflight: a tenant agent with no usable credential dies in seconds ("Not logged
// in") and the run burns every attempt building nothing — so refuse to start.
// glm is exempt (platform key fallback). Inert single-tenant (tenant=null → []).
export function missingAgentKeys(tenant, agents) {
  if (!tenant) return [];
  const get = (p) => { try { return saasStore.getProviderKey(tenant.id, p); } catch { return null; } };
  const missing = [];
  for (const agent of new Set(agents)) {
    const providers = AGENT_CRED_PROVIDERS[agent];
    if (!providers) continue;
    const has = providers.some((p) => (p === 'claude-plan' ? !!claudePlanOf(get) : !!get(p)));
    if (!has) missing.push(agent);
  }
  return missing;
}
export const missingKeysError = (missing) =>
  `No credential for ${missing.join(', ')} — add an API key, subscription sign-in, or coding plan for it in Settings → Providers, or pick a different agent.`;
// OAuth login files the CLIs store in $HOME after an interactive sign-in. A file
// already in the tenant's sandbox (via the in-dashboard terminal sign-in) is as
// good as a vault credential — the CLI reads it on its own, no env needed.
export const CLI_LOGIN_FILES = {
  claude: '.claude/.credentials.json',
  codex: '.codex/auth.json',
  // gemini's CLI renamed its credential file (oauth_creds.json -> gemini-credentials.json);
  // accept either so a fresh `gemini` login is still recognized as connected.
  gemini: ['.gemini/oauth_creds.json', '.gemini/gemini-credentials.json'],
  qwen: '.qwen/oauth_creds.json',
  kimi: '.kimi-code/config.toml',
  grok: '.grok/auth.json',
  firebase: '.config/configstore/firebase-tools.json', // `firebase login` token (flutter-app backends)
};
// An agent's login can live under more than one filename (CLIs rename credential files
// between versions). Normalize to a list and build a shell test matching ANY of them.
const loginFilesFor = (agent) => { const f = CLI_LOGIN_FILES[agent]; return Array.isArray(f) ? f : (f ? [f] : []); };
export const loginExistsTest = (agent) => loginFilesFor(agent).map((f) => `[ -f "$HOME/${f}" ]`).join(' || ') || 'false';
// Which agents have a login file in the sandbox — ONE webtmux-run round-trip.
export async function sandboxLogins(tenant) {
  if (!tenant?.wrap) return new Set();
  const script = Object.keys(CLI_LOGIN_FILES)
    .map((a) => `{ ${loginExistsTest(a)}; } && echo ${a}`).join('; ') + '; true';
  try {
    const argv = tenant.wrap(['bash', '-c', script]);
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), { timeout: 10_000 });
    return new Set(String(stdout).split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}
// Full preflight: vault credentials OR a sandbox CLI sign-in satisfy an agent.
export async function missingAgentCreds(tenant, agents) {
  const missing = missingAgentKeys(tenant, agents);
  if (!missing.length) return missing;
  const logins = await sandboxLogins(tenant);
  return missing.filter((a) => !logins.has(a));
}
export const shq = (v) => `'${String(v).replace(/'/g, '')}'`; // single-quote for a shell value
// Resolve the tenant's credential for one agent into launch env vars and/or
// credential files (OAuth logins) the session script writes into the tenant home.
// Preference: subscription OAuth > coding plan > raw API key.
export function tenantAgentCreds(agent, run) {
  const env = [], files = [];
  if (!run?.tenant) return { env, files };
  const get = (p) => tenantKey(run, p);
  if (agent === 'claude') {
    const oauth = get('claude-oauth'), plan = claudePlanOf(get), apiKey = get('anthropic');
    if (oauth) env.push(`CLAUDE_CODE_OAUTH_TOKEN=${shq(oauth)}`);
    else if (plan) {
      // A per-run model override (run.model) wins over the plan's stored model, so an
      // OpenRouter user can pick any model per build without re-saving the credential.
      const planModel = (run?.model && validModelId(run.model)) ? run.model : plan.model;
      env.push(`ANTHROPIC_BASE_URL=${shq(plan.baseUrl)}`, `${plan.authVar}=${shq(plan.key)}`);
      if (planModel) env.push(`ANTHROPIC_MODEL=${shq(planModel)}`, `ANTHROPIC_SMALL_FAST_MODEL=${shq(planModel)}`);
    } else if (apiKey) env.push(`ANTHROPIC_API_KEY=${shq(apiKey)}`);
  } else if (agent === 'codex') {
    const k = get('openai'), o = k ? null : get('codex-oauth');
    if (k) env.push(`OPENAI_API_KEY=${shq(k)}`);
    else if (o) files.push({ path: '$HOME/.codex/auth.json', content: o });
  } else if (agent === 'gemini') {
    const k = get('gemini'), o = k ? null : get('gemini-oauth');
    if (k) env.push(`GEMINI_API_KEY=${shq(k)}`, `GOOGLE_API_KEY=${shq(k)}`);
    else if (o) files.push({ path: '$HOME/.gemini/oauth_creds.json', content: o });
  } else if (agent === 'qwen') {
    const k = get('qwen'), o = k ? null : get('qwen-oauth');
    if (k) {
      // OPENAI_BASE_URL is load-bearing twice: (1) the qwen CLI auto-selects the `openai`
      // auth type in headless mode only when a base URL is present — without it it aborts
      // with "No auth type is selected"; (2) a token-plan key 401s on the default DashScope
      // host, so it must hit the configured base. OPENAI_MODEL pins an on-plan model for
      // runs where no --model flag is passed (a per-run override still wins).
      const model = (run?.model && validModelId(run.model)) ? run.model : qwenModel();
      env.push(`DASHSCOPE_API_KEY=${shq(k)}`, `OPENAI_API_KEY=${shq(k)}`,
               `OPENAI_BASE_URL=${shq(qwenBaseUrl())}`, `OPENAI_MODEL=${shq(model)}`);
    } else if (o) files.push({ path: '$HOME/.qwen/oauth_creds.json', content: o });
  } else if (agent === 'grok') {
    // API key reads straight from the shell env; a subscription sign-in instead
    // drops ~/.grok/auth.json (pasted here, or written by `grok login` in the sandbox).
    const k = get('grok'), oauth = k ? null : get('grok-oauth');
    if (k) env.push(`XAI_API_KEY=${shq(k)}`);
    else if (oauth) files.push({ path: '$HOME/.grok/auth.json', content: oauth });
  } else if (agent === 'vibe') {
    // Mistral Vibe reads MISTRAL_API_KEY from the env; model is its config default.
    const k = get('vibe');
    if (k) env.push(`MISTRAL_API_KEY=${shq(k)}`);
  } else if (agent === 'kimi') {
    // Kimi does NOT read its key from the shell env — credentials must live in
    // ~/.kimi-code/config.toml. API key → synthesize a minimal config (per-run
    // run.model wins over the default). Subscription → the pasted config.toml, or a
    // `kimi login` already in the sandbox.
    const k = get('kimi'), oauth = k ? null : get('kimi-oauth');
    if (k) {
      const model = (run?.model && validModelId(run.model)) ? run.model : KIMI_MODEL();
      const toml = [
        'default_model = "ralph"',
        'default_thinking = true', // kimi-k2.7-code requires thinking mode (errors if disabled)
        '',
        '[providers.kimi]', 'type = "kimi"',
        'base_url = "https://api.moonshot.ai/v1"', `api_key = "${k}"`, '',
        '[models.ralph]', 'provider = "kimi"', `model = "${model}"`, 'max_context_size = 262144', '',
      ].join('\n');
      files.push({ path: '$HOME/.kimi-code/config.toml', content: toml });
    } else if (oauth) {
      files.push({ path: '$HOME/.kimi-code/config.toml', content: oauth });
    }
  }
  return { env, files };
}
// Script lines that materialize OAuth credential files in the tenant's $HOME.
// base64 round-trip so arbitrary JSON survives shell quoting; the session script
// already runs AS the tenant, so $HOME and file ownership are the tenant's own.
export function credFileLines(agent, run) {
  return tenantAgentCreds(agent, run).files.map((f) => {
    const b64 = Buffer.from(String(f.content), 'utf8').toString('base64');
    return `mkdir -p "${path.posix.dirname(f.path)}" && printf '%s' '${b64}' | base64 -d > "${f.path}" && chmod 600 "${f.path}"`;
  });
}

// True only when the claude agent resolves to a coding plan, which already pins
// ANTHROPIC_MODEL (tenantAgentCreds) — don't fight it with --model.
export function agentHasCodingPlan(agent, run) {
  if (agent !== 'claude') return false;
  const get = (p) => tenantKey(run, p);
  return !!claudePlanOf(get);
}

// The model fragment (' --model <id>') for one agent/role. A per-run override
// (run.model, picked in the New Build dialog) wins for every role over the solo
// build/review defaults; a coding plan carries its model via ANTHROPIC_MODEL
// (tenantAgentCreds, where run.model already wins) so we pass no flag there.
export function runModelFlag(agent, role, run) {
  if (agent === 'kimi' || agent === 'vibe') return ''; // model is config-based (no --model flag)
  if (agentHasCodingPlan(agent, run)) return '';   // claude coding plan pins ANTHROPIC_MODEL
  const perRun = (run?.model && validModelId(run.model)) ? run.model : '';
  // grok: pin an explicit model (the bare `grok-build` alias 404s on some accounts);
  // per-run override > secrets.grokModel > grok-build-0.1.
  if (agent === 'grok') return ` --model ${perRun || GROK_MODEL()}`;
  if (perRun) return ` --model ${perRun}`;
  return soloModelFlag({ solo: isSolo(run), agent, role, codingPlan: false, models: soloModelsEffective() });
}

// Grok Imagine media auth: the grok CLI device-login JWT (~/.grok/auth.json) works on
// api.x.ai's imagine models, drawing on the SUBSCRIPTION's Imagine credits (verified
// live 2026-07-02 — undocumented behavior; helpers fail soft if xAI closes it). Read
// fresh at every spawn: the JWT rotates with the login. Sync read: ralphEnvPrefix is sync.
export function grokLoginKey(run) {
  const home = run?.tenant?.home
    || (run?.tenant?.unix_user ? `/home/${run.tenant.unix_user}` : os.homedir());
  const file = path.join(home, '.grok', 'auth.json');
  let txt = '';
  try { txt = readFileSync(file, 'utf8'); }
  catch {
    // Sandboxed tenant homes aren't app-readable (~/.grok is tenant-only — the same
    // reason sandboxLogins runs via tenant.wrap). Read AS the tenant; sync is fine
    // here, we're already in the middle of spawning a session. This gap sent a
    // grok-preferring build to the PAID ark/elevenlabs keys on 2026-07-02.
    try {
      if (run?.tenant?.wrap) {
        const argv = run.tenant.wrap(['cat', file]);
        txt = execFileSync(argv[0], argv.slice(1), { timeout: 5000 }).toString();
      }
    } catch { return ''; }
  }
  try {
    const first = Object.values(JSON.parse(txt))[0];
    return (first && typeof first.key === 'string') ? first.key : '';
  } catch { return ''; }
}

export function ralphEnvPrefix(agent, run) {
  const envs = [];
  if (agent === 'glm') {
    // One BytePlus ARK key covers the coding plan AND ModelArk (verified 2026-07-02):
    // a tenant who stored it as their `ark` (video) key doesn't need to paste it twice.
    // The BASE stays /api/coding/v3 — /api/v3 works but bills OUTSIDE the plan.
    const k = tenantKey(run, 'glm') || tenantKey(run, 'ark') || GLM_API_KEY();
    envs.push(`GLM_API_KEY=${k}`, `GLM_BASE_URL=${GLM_BASE_URL()}`, `GLM_MODEL=${GLM_MODEL()}`);
  } else {
    envs.push(...tenantAgentCreds(agent, run).env); // BYO credential for the tenant's agent
  }
  if (run && run.bypass === false) envs.push('RALPH_BYPASS=0');
  // flutter-app builds need the shared SDKs on PATH + per-runner ($HOME) pub/gradle
  // caches so sandboxed tenants don't clash on a shared cache.
  if (isFlutterRun(run)) envs.push(...flutterEnvAssignments());
  // Media generation: expose the helper paths + per-kind creds/caps for visual/media builds.
  if (run && run.media) {
    const m = run.media, get = (p) => tenantKey(run, p);
    // Build-SHARED media counter (run.dir), so the per-kind cap bounds the WHOLE build —
    // every story worktree + finalize share one .ralph/media-count.json instead of each
    // getting a fresh cap (parallel workers may under/over-count slightly; a soft ceiling).
    envs.push(`RALPH_MEDIA_COUNT_DIR=${shq(run.dir)}`,
              `RALPH_GEN_IMAGE=${RALPH_GEN_IMAGE}`, `RALPH_GEN_VIDEO=${RALPH_GEN_VIDEO}`, `RALPH_GEN_AUDIO=${RALPH_GEN_AUDIO}`);
    envs.push(`RALPH_IMAGES=${m.image.enabled ? 1 : 0}`, `RALPH_IMAGE_CAP=${m.image.cap}`,
              `RALPH_VIDEO=${m.video.enabled ? 1 : 0}`, `RALPH_VIDEO_CAP=${m.video.cap}`,
              `RALPH_AUDIO=${m.audio.enabled ? 1 : 0}`, `RALPH_AUDIO_CAP=${m.audio.cap}`);
    // Social-video: the local composition helper + its count/size bounds (free CPU,
    // so bounded by outputs not spend) + the platform render list for the brief/skill.
    if (run.outputFormat === 'social-video') {
      envs.push(`RALPH_COMPOSE=${RALPH_COMPOSE_HELPER}`,
                `RALPH_COMPOSE_CAP=${Number(process.env.WEBTMUX_COMPOSE_CAP) || 12}`,
                `RALPH_COMPOSE_MB=${Number(process.env.WEBTMUX_COMPOSE_MB) || 200}`);
      if (run.platforms?.length) envs.push(`RALPH_PLATFORMS=${run.platforms.join(',')}`);
    }
    // Per-kind provider selection. secrets.imageProvider/videoProvider (or the
    // WEBTMUX_*_PROVIDER env) = 'grok' prefers Grok Imagine on the run tenant's grok
    // SUBSCRIPTION login (no extra spend); otherwise the paid keys are preferred and
    // grok is the fallback when no paid key exists but a grok login does.
    const grokTok = grokLoginKey(run);
    const mm = run.mediaModels || {};
    const prefer = (kind) => String(mm[kind]?.provider || getSecrets()[`${kind}Provider`] || process.env[`WEBTMUX_${kind.toUpperCase()}_PROVIDER`] || '').toLowerCase();
    // image default: token-plan (qwen) key + OpenAI-compatible base.
    const imgKey = get('qwen') || qwenKey();
    if (m.image.enabled) {
      const useGrok = prefer('image') === 'grok' ? !!grokTok : (!imgKey && !!grokTok);
      if (useGrok) envs.push('RALPH_IMAGE_PROVIDER=grok', `RALPH_IMAGE_KEY=${shq(grokTok)}`,
                             ...(mm.image?.provider === 'grok' && mm.image.model ? [`RALPH_IMAGE_MODEL=${shq(mm.image.model)}`] : []));
      else if (imgKey) envs.push(`RALPH_IMAGE_KEY=${shq(imgKey)}`, `RALPH_IMAGE_BASE=${shq(qwenBaseUrl())}`,
                                 `RALPH_IMAGE_MODEL=${shq(mm.image?.provider === 'tokenplan' && mm.image.model ? mm.image.model : qwenImageModel())}`);
    }
    // video default: ARK (Seedance). Same ARK key as the glm coding plan — reuse it when
    // only `glm` is stored. (Video correctly runs on ModelArk /api/v3: NOT the coding plan.)
    if (m.video.enabled) {
      const k = get('ark') || get('glm') || arkKey();
      const useGrok = prefer('video') === 'grok' ? !!grokTok : (!k && !!grokTok);
      if (useGrok) envs.push('RALPH_VIDEO_PROVIDER=grok', `RALPH_VIDEO_KEY=${shq(grokTok)}`,
                             ...(mm.video?.provider === 'grok' && mm.video.model ? [`RALPH_VIDEO_MODEL=${shq(mm.video.model)}`] : []));
      else if (k) envs.push(`RALPH_VIDEO_KEY=${shq(k)}`, `RALPH_VIDEO_BASE=${shq(arkBaseUrl())}`,
                            ...(mm.video?.provider === 'ark' && mm.video.model ? [`RALPH_VIDEO_MODEL=${shq(mm.video.model)}`] : []));
    }
    // audio (kind naming seam: the picker kinds are `music`/`voiceover`; the legacy
    // secrets pref key for voiceover is `voice` — the mm check ORs in front of prefer('voice')).
    if (m.audio.enabled) {
      const sk = get('suno') || sunoKey();
      if (sk) envs.push(`RALPH_MUSIC_KEY=${shq(sk)}`, `RALPH_MUSIC_BASE=${shq(sunoBaseUrl())}`,
                        ...(mm.music?.model ? [`RALPH_MUSIC_MODEL=${shq(mm.music.model)}`] : []));
      // voiceover: ElevenLabs by default; Grok TTS on the subscription login when
      // preferred (secrets.voiceProvider='grok') or when no ElevenLabs key exists.
      const vk = get('elevenlabs') || elevenLabsKey();
      const useGrokVoice = (mm.voiceover?.provider === 'grok' || prefer('voice') === 'grok') ? !!grokTok : (!vk && !!grokTok);
      if (useGrokVoice) envs.push('RALPH_VOICE_PROVIDER=grok', `RALPH_VOICE_KEY=${shq(grokTok)}`);
      else if (vk) envs.push(`RALPH_VOICE_KEY=${shq(vk)}`, `RALPH_VOICE_ID=${shq(elevenLabsVoice())}`,
                             ...(mm.voiceover?.provider === 'elevenlabs' && mm.voiceover.model ? [`RALPH_VOICE_MODEL=${shq(mm.voiceover.model)}`] : []));
    }
  }
  // Research & data helpers (Phase C): cited web answers (perplexity) + real datasets /
  // custom private actors (apify), per-build capped like media. The count file is shared
  // with media (RALPH_MEDIA_COUNT_DIR) so caps bound the WHOLE build across worktrees.
  if (run && run.research) {
    const r = run.research;
    if (!run.media) envs.push(`RALPH_MEDIA_COUNT_DIR=${shq(run.dir)}`);
    envs.push(`RALPH_GEN_RESEARCH=${RALPH_GEN_RESEARCH_HELPER}`, `RALPH_FETCH_DATA=${RALPH_FETCH_DATA_HELPER}`,
              `RALPH_RESEARCH=${r.research.enabled ? 1 : 0}`, `RALPH_RESEARCH_CAP=${r.research.cap}`,
              `RALPH_DATA=${r.data.enabled ? 1 : 0}`, `RALPH_DATA_CAP=${r.data.cap}`);
    const pk = tenantKey(run, 'perplexity') || perplexityKey();
    if (r.research.enabled && pk) envs.push(`RALPH_RESEARCH_KEY=${shq(pk)}`);
    const ak = tenantKey(run, 'apify') || apifyToken();
    if (r.data.enabled && ak) envs.push(`RALPH_DATA_KEY=${shq(ak)}`);
  }
  if (process.env.RALPH_FORCE_TOOL) envs.push(`RALPH_FORCE_TOOL=${process.env.RALPH_FORCE_TOOL}`);
  return envs.length ? envs.join(' ') + ' ' : '';
}
// Which research/data helper keys exist for this run's tenant — decides whether the
// web-research / real-data skills get injected into briefs (no key → no skill noise).
export function researchKeysFor(run) {
  return {
    web: !!(tenantKey(run, 'perplexity') || perplexityKey()),
    data: !!(tenantKey(run, 'apify') || apifyToken()),
  };
}
