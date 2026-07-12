// Pure media-generation payloads, response parsers, and cap math. HTTP + fs live in
// ralph/media-runtime.mjs and the gen-*.mjs helpers. Shapes proven in
// video.tayyabcheema.com (backend/app/services/generation_service.py).

// --- Image (token-plan MaaS, sync /chat/completions; image URL inside `output`) ---
export function buildImagePayload(model, prompt) {
  return { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
}
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export function findImageUrl(obj) {
  if (typeof obj === 'string') {
    const base = obj.split('?', 1)[0].toLowerCase();
    return obj.startsWith('http') && IMG_EXTS.some((e) => base.endsWith(e)) ? obj : null;
  }
  if (Array.isArray(obj)) { for (const v of obj) { const f = findImageUrl(v); if (f) return f; } return null; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) { const f = findImageUrl(v); if (f) return f; } }
  return null;
}
export function parseImageResponse(data) {
  return findImageUrl(data && data.output != null ? data.output : data);
}

// --- Video (BytePlus ModelArk async task) ---
export function buildVideoPayload(model, prompt, { ratio = '16:9', duration = 5 } = {}) {
  return { model, content: [{ type: 'text', text: prompt }], ratio, duration: Number(duration) || 5, watermark: true };
}
export function parseVideoTask(data) {
  const content = (data && data.content) || {};
  return {
    status: data && data.status,
    videoUrl: content.video_url || null,
    error: data && data.error ? (data.error.message || String(data.error)) : null,
  };
}
export function videoTaskDone(status) { return status === 'succeeded' || status === 'failed'; }

// --- Grok Imagine (xAI) — media on the user's Grok SUBSCRIPTION token ------------
// Empirically verified 2026-07-02: the grok CLI device-login JWT (~/.grok/auth.json)
// authenticates api.x.ai and can call the imagine models, drawing on the plan's
// Imagine credits. UNDOCUMENTED for subscription tokens — helpers must fail soft
// (exit 2 → the agent falls back to a placeholder) if xAI ever closes it.
export function grokImagePayload(model, prompt) {
  return { model, prompt, n: 1, response_format: 'url' };
}
// Image parsing: parseImageResponse's deep URL walk already covers both the documented
// xAI shape (data[0].url) and the DashScope-style envelope observed live.

// Video: POST /v1/videos/generations -> { request_id }; poll GET /v1/videos/{id}.
export function grokVideoPayload(model, prompt, { duration = 5, ratio = '16:9' } = {}) {
  const d = Math.round(Number(duration));
  return {
    model, prompt,
    duration: Number.isFinite(d) && d >= 1 ? Math.min(15, d) : 5, // API range 1-15s
    aspect_ratio: ratio,
  };
}
export function parseGrokVideo(data) {
  return {
    status: data && data.status,                       // pending | done | expired | failed
    videoUrl: (data && data.video && data.video.url) || null,
    error: data && data.error ? (data.error.message || String(data.error)) : null,
  };
}
export function grokVideoDone(status) { return status === 'done' || status === 'failed' || status === 'expired'; }

// TTS: POST /v1/tts -> raw audio/mpeg bytes. `language` is REQUIRED (422 without it —
// shape derived from the API's own validation errors, verified live 2026-07-02).
export function grokTtsPayload(text, { voice = 'ara', language = 'en' } = {}) {
  return { text: String(text || ''), language, voice };
}

// --- Music (Suno via sunoapi.org async) ---
export function buildMusicPayload(model, prompt, { instrumental = false, callbackUrl } = {}) {
  const p = { prompt, model, customMode: false, instrumental: !!instrumental };
  if (callbackUrl) p.callBackUrl = callbackUrl;
  return p;
}
export function parseMusicTask(data) {
  const body = (data && data.data) || {};
  const raw = String(body.status || '').toUpperCase();
  let status = 'pending';
  if (raw === 'SUCCESS') status = 'succeeded';
  else if (raw.endsWith('FAILED') || raw.includes('ERROR') || raw.includes('EXCEPTION')) status = 'failed';
  const resp = body.response || {};
  const items = resp.sunoData || resp.data || [];
  const first = items[0] || {};
  return { status, audioUrl: first.audioUrl || first.audio_url || first.streamAudioUrl || null, error: body.errorMessage || body.errorCode || null };
}

// --- Voiceover (ElevenLabs TTS, sync binary mp3) ---
export function buildVoicePayload(text, { modelId = 'eleven_multilingual_v2' } = {}) {
  return { text, model_id: modelId };
}
export function elevenLabsTtsUrl(base, voiceId) {
  return `${String(base).replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
}

// --- Per-build cap logic (counts = {image,video,audio}) ---
export function capState(counts, kind, cap, enabled) {
  if (!enabled) return { allowed: false, reason: `${kind} generation is disabled for this build` };
  const used = Number((counts && counts[kind]) || 0);
  if (used >= cap) return { allowed: false, reason: `${kind} budget reached (${used}/${cap})` };
  return { allowed: true, used, cap };
}
