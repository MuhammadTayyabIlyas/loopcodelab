// server/secrets.mjs — the server-only credential store (secrets.json) and every
// provider-key getter, plus the admin-managed solo-model / media-cap maps.
// This module OWNS the mutable state; everyone else goes through the exported
// functions (env vars override file values so deploys can inject them too).
import path from 'node:path';
import {
  SOLO_MODEL_DEFAULTS, sanitizeModels, soloModelsFromEnv, effectiveModels,
} from '../ralph/solo-models.mjs';
import { normalizeMedia, mediaCapDefaults } from '../ralph/providers.mjs';
import { DATA_DIR, SECRETS_FILE, readJson, writeJson } from './config.mjs';

// --- Ralph orchestrator credentials (server-only) ---------------------------
// Loaded from secrets.json; env vars override so deploys can inject them too.
let secrets = {};
export async function initSecrets() {
  secrets = await readJson(SECRETS_FILE, {});
}
// Read-only view for helpers that inspect several fields at once
// (e.g. tokenPlanAnthropicBase(getSecrets(), process.env)). Do not mutate.
export const getSecrets = () => secrets;

export const openaiKey = () => process.env.WEBTMUX_OPENAI_KEY || secrets.openaiApiKey || '';
export const openaiModel = () => process.env.WEBTMUX_OPENAI_MODEL || secrets.openaiModel || 'gpt-5.4-mini';
export const githubToken = () => process.env.WEBTMUX_GITHUB_TOKEN || secrets.githubToken || '';
// Single-tenant fallbacks for flutter-app build/submission credentials (multitenant
// reads the per-tenant vault first; see tenantKey). All optional — empty until set.
export const firebaseConfig = () => process.env.WEBTMUX_FIREBASE_CONFIG || secrets.firebaseConfig || '';
export const googlePlayKey = () => process.env.WEBTMUX_GOOGLE_PLAY_KEY || secrets.googlePlayKey || '';
export const codemagicToken = () => process.env.WEBTMUX_CODEMAGIC_TOKEN || secrets.codemagicToken || '';
// Media-generation credentials (single-tenant fallback; multitenant reads the vault first).
export const arkKey = () => process.env.WEBTMUX_ARK_KEY || secrets.arkApiKey || '';
export const arkBaseUrl = () => (process.env.WEBTMUX_ARK_BASE || secrets.arkBaseUrl || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/+$/, '');
export const sunoKey = () => process.env.WEBTMUX_SUNO_KEY || secrets.sunoApiKey || '';
export const sunoBaseUrl = () => (process.env.WEBTMUX_SUNO_BASE || secrets.sunoBaseUrl || 'https://api.sunoapi.org').replace(/\/+$/, '');
export const elevenLabsKey = () => process.env.WEBTMUX_ELEVENLABS_KEY || secrets.elevenLabsApiKey || '';
export const elevenLabsVoice = () => process.env.WEBTMUX_ELEVENLABS_VOICE || secrets.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM';
// qwen (Alibaba DashScope / Model Studio) — an OpenAI-compatible deep-thinking
// model used for PRD creation (planner + clarify) when configured: its server-side
// reasoning produces sharper PRDs. Falls back to OpenAI if unset or it errors.
export const qwenKey = () => process.env.WEBTMUX_QWEN_KEY || secrets.qwenApiKey || '';
export const qwenBaseUrl = () => (process.env.WEBTMUX_QWEN_BASE || secrets.qwenBaseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
export const qwenModel = () => process.env.WEBTMUX_QWEN_MODEL || secrets.qwenModel || 'qwen3.7-max';
export const qwenImageModel = () => process.env.WEBTMUX_QWEN_IMAGE_MODEL || secrets.qwenImageModel || 'qwen-image-2.0';
// Perplexity (Sonar) — web-grounded research for the planner (Phase B of the
// perplexity/apify plan): one cheap cited call folds current facts into the PRD prompt.
export const perplexityKey = () => process.env.WEBTMUX_PERPLEXITY_KEY || secrets.perplexityApiKey || '';
// Apify — actor marketplace token (Phase A: provider only; worker data helpers are Phase C).
export const apifyToken = () => process.env.WEBTMUX_APIFY_TOKEN || secrets.apifyToken || '';
// Platform-supplied credentials (secrets.json/env) by provider — surfaced ONLY in the
// admin's Settings/Test (ralph/platform-keys.mjs), never to BYO tenants. Referenced
// accessors are all module-level; this runs at request time so forward refs are fine.
export const platformKeyValues = () => ({ openai: openaiKey(), qwen: qwenKey(), glm: GLM_API_KEY(), github: githubToken(), perplexity: perplexityKey(), apify: apifyToken() });

export const GLM_API_KEY = () => secrets.glmApiKey || '6f165013-4c71-4e2e-88a5-94ab28d63d86';
// glm worker uses the OpenAI-compatible BytePlus endpoint (`/api/coding/v3`) via a
// direct API call (ralph/direct.mjs) — far more reliable than the Anthropic-style
// claude-CLI agentic loop. The plain `/api/coding` (Anthropic) URL is only for the
// interactive claude-CLI launcher (LAUNCHERS.glm), which can't speak OpenAI shape.
export const GLM_BASE_URL = () => secrets.glmBaseUrl || 'https://ark.ap-southeast.bytepluses.com/api/coding/v3';
export const GLM_MODEL = () => secrets.glmModel || 'GLM-5.1';
// Default models for the kimi/grok agents. Admin-overridable via secrets.json, and
// per-run via run.model. Kimi's is baked into config.toml. Grok MUST be pinned to an
// explicit id: the CLI's bare default alias `grok-build` 404s on some accounts, but
// the canonical `grok-build-0.1` works (verified against a live xAI key 2026-06-21).
export const KIMI_MODEL = () => secrets.kimiModel || 'kimi-k2.7-code';
export const GROK_MODEL = () => secrets.grokModel || 'grok-build-0.1';

// Deployment-wide solo-build model map (admin-managed, like platform MCP servers).
// File holds only what the admin saved; effective view merges defaults < file < env.
const SOLO_MODELS_FILE = path.join(DATA_DIR, 'soloModels.json');
let soloModelsFile = {};
export function soloModelsEffective() { return effectiveModels(soloModelsFile, soloModelsFromEnv()); }
export const savedSoloModels = () => soloModelsFile;
// Deployment-wide media-generation caps/toggles (admin-managed), same shape as
// solo-models: a dedicated file the admin PUT writes; effective view is env > file > defaults.
const MEDIA_CAPS_FILE = path.join(DATA_DIR, 'mediaCaps.json');
let mediaCapsFile = {};
export function mediaCapsEffective() {
  try { if (process.env.WEBTMUX_RALPH_MEDIA) return normalizeMedia(JSON.parse(process.env.WEBTMUX_RALPH_MEDIA)); } catch { /* ignore */ }
  return normalizeMedia(mediaCapsFile);
}
export async function loadSoloModels() {
  try { soloModelsFile = sanitizeModels(await readJson(SOLO_MODELS_FILE, {})); }
  catch (e) { console.warn('[solo-models] ignoring invalid soloModels.json:', e.message); soloModelsFile = {}; }
  try { mediaCapsFile = normalizeMedia(await readJson(MEDIA_CAPS_FILE, {})); }
  catch { mediaCapsFile = mediaCapDefaults(); }
}
// Admin PUT routes persist then swap the in-memory map (same order as before the split).
export async function setSoloModels(clean) {
  await writeJson(SOLO_MODELS_FILE, clean);
  soloModelsFile = clean;
}
export async function setMediaCaps(caps) {
  await writeJson(MEDIA_CAPS_FILE, caps);
  mediaCapsFile = caps;
}
