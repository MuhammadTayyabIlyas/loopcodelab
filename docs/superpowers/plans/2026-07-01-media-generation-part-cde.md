# Media Generation (Parts C/D/E) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Ralph builds generate real media into their deliverables — **images** (token-plan, reuse `qwenApiKey`), **video** (BytePlus ModelArk / Seedance, new `ark` credential), **music** (Suno, new `suno`), **voiceover** (ElevenLabs, new `elevenlabs`) — agent-invoked, per-kind opt-in with a cap, and stub-aware for the no-spend harness.

**Architecture:** Extends Plan 1's `ralph/providers.mjs` registry. A pure, tested core (`ralph/media-gen.mjs`) holds payload builders + response parsers + cap math; a small runtime (`ralph/media-runtime.mjs`) holds fs/http (download, cap-counter file, stub placeholders); three thin CLI helpers (`ralph/gen-image.mjs` / `gen-video.mjs` / `gen-audio.mjs`) the worker agent runs via the **media skill** (`ralph/skills/imagery/SKILL.md` extended). Credentials mirror the existing flutter-app vault pattern (`firebaseConfig()` etc.); per-kind caps/toggles thread through `run.media` and are injected into worker sessions by `ralphEnvPrefix`. UI is `web/`-only (the `public/` PWA has no media surface today).

**Tech Stack:** Node 22 (ESM, `node:test`), Express (`server.js`), React+Vite (`web/`). Proven call shapes come from `/home/tmuxweb/projects/video/backend/app/services/generation_service.py`.

## Global Constraints

- Pure logic in `ralph/*.mjs` + sibling `ralph/*.test.mjs` (Node built-in runner, no external deps). `server.js` is side-effectful → `node --check` only.
- Model/credential values are shell/URL-spliced — never log or commit the keys. Media keys are **env-injected** into worker sessions, never written to the repo (so no new `.gitignore` entries needed); generated media files ARE committed under `assets/`.
- Verified endpoints (token-plan `sk-sp-…` = `secrets.qwenApiKey`):
  - Image (sync): `POST {qwenBaseUrl}/chat/completions`, body `{model, messages:[{role:"user",content:[{type:"text",text}]}]}`; image URL is inside response `output` (first `https…{.png,.jpg,.jpeg,.webp,.gif}`). `qwenBaseUrl` default = `…/compatible-mode/v1`.
  - Video (async): `POST {ark}/contents/generations/tasks` → `{id}`; poll `GET {ark}/contents/generations/tasks/{id}` → `status` (`succeeded`/`failed`/other) + `content.video_url`. `ark` default = `https://ark.ap-southeast.bytepluses.com/api/v3`. Bearer auth.
  - Music (async): `POST {suno}/api/v1/generate` → `data.taskId`; poll `GET {suno}/api/v1/generate/record-info?taskId=` → status → audio in `response.sunoData[].audioUrl`. `suno` default = `https://api.sunoapi.org`. Bearer auth.
  - Voiceover (sync binary): `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}` header `xi-api-key`, body `{text, model_id}`, returns audio/mpeg bytes.
- Per-kind cap defaults (admin/secrets/env overridable, per-build overridable): **image on / 8**, **video off / 2**, **audio off / 3** (audio = music+voiceover combined). Env: `WEBTMUX_RALPH_{IMAGE,VIDEO,AUDIO}` (0 disables), `WEBTMUX_RALPH_{IMAGE,VIDEO,AUDIO}_CAP`.
- Helper exit codes: `0` success (prints the saved path), `2` error, `3` skipped (disabled or cap reached — agent falls back to placeholder/stock/omit).
- After `server.js` edits: `node --check` + `sudo systemctl restart webtmux`. After `web/src`: `cd web && npm run build`. New pure modules ship with `*.test.mjs`; run `node --test ralph/*.test.mjs`. Manual-checkpoint repo (commits are local).
- This plan builds on Plan 1 (merged: `ralph/providers.mjs`, `tokenplan` preset). Also clears the 3 deferred Plan-1 Minors (freeze registry arrays; document the shallow spread; tighten one key-test assertion) in Task 1/where touched.

---

### Task 1: Media registry + cap config in `ralph/providers.mjs`

**Files:**
- Modify: `ralph/providers.mjs`
- Test: `ralph/providers.test.mjs`

**Interfaces:**
- Produces: `MEDIA_PROVIDERS: {id,label,kind,protocol,defaultBase,credential}[]`, `mediaCredentialIds() => string[]` (`['ark','suno','elevenlabs']`), `MEDIA_CAP_DEFAULTS`, `mediaCapDefaults() => {image:{enabled,cap},video:{...},audio:{...}}`, `normalizeMedia(input) => same shape` (clamps caps 0..20, coerces enabled). Also freezes the existing model arrays (Plan-1 Minor #3).

- [ ] **Step 1: Write the failing tests** — append to `ralph/providers.test.mjs`:

```js
import {
  MEDIA_PROVIDERS, mediaCredentialIds, MEDIA_CAP_DEFAULTS, mediaCapDefaults, normalizeMedia,
} from './providers.mjs';

test('media providers registry: ark(video)/suno(music)/elevenlabs(voiceover), each vault-credentialed', () => {
  const byId = Object.fromEntries(MEDIA_PROVIDERS.map((p) => [p.id, p]));
  assert.deepEqual(mediaCredentialIds().sort(), ['ark', 'elevenlabs', 'suno']);
  assert.equal(byId.ark.kind, 'video');
  assert.equal(byId.suno.kind, 'music');
  assert.equal(byId.elevenlabs.kind, 'voiceover');
  for (const p of MEDIA_PROVIDERS) {
    assert.match(p.defaultBase, /^https:\/\//, `${p.id} base`);
    assert.equal(p.credential, 'vault');
    assert.equal(typeof p.label, 'string');
  }
});

test('media cap defaults: image on/8, video off/2, audio off/3', () => {
  const d = mediaCapDefaults();
  assert.deepEqual(d.image, { enabled: true, cap: 8 });
  assert.deepEqual(d.video, { enabled: false, cap: 2 });
  assert.deepEqual(d.audio, { enabled: false, cap: 3 });
  // returns a copy — mutation doesn't leak into the source
  d.image.cap = 99;
  assert.equal(mediaCapDefaults().image.cap, 8);
  assert.equal(MEDIA_CAP_DEFAULTS.image.cap, 8);
});

test('normalizeMedia clamps caps and coerces enabled, filling missing kinds from defaults', () => {
  const m = normalizeMedia({ image: { enabled: false, cap: 999 }, video: { enabled: true, cap: -3 } });
  assert.deepEqual(m.image, { enabled: false, cap: 20 });   // clamped to max 20
  assert.deepEqual(m.video, { enabled: true, cap: 0 });      // clamped to min 0
  assert.deepEqual(m.audio, { enabled: false, cap: 3 });     // default filled
  assert.deepEqual(normalizeMedia(null), mediaCapDefaults()); // null -> defaults
});

test('registry model arrays are frozen (defense-in-depth)', () => {
  assert.ok(Object.isFrozen(TOKEN_PLAN_TEXT_MODELS));
  assert.ok(Object.isFrozen(TOKEN_PLAN_IMAGE_MODELS));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test ralph/providers.test.mjs`
Expected: FAIL — `MEDIA_PROVIDERS` etc. not exported; freeze assertions fail.

- [ ] **Step 3: Implement** — in `ralph/providers.mjs`, freeze the two existing arrays (change `export const TOKEN_PLAN_TEXT_MODELS = [ … ];` to end with `];` wrapped in `Object.freeze`), and append the media exports.

Change the two array declarations to freeze them:
```js
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
```
```js
export const TOKEN_PLAN_IMAGE_MODELS = Object.freeze([
  { id: 'qwen-image-2.0',     label: 'Qwen-Image 2.0 (fast)' },
  { id: 'qwen-image-2.0-pro', label: 'Qwen-Image 2.0 Pro' },
  { id: 'wan2.7-image',       label: 'Wan 2.7 Image (fast)' },
  { id: 'wan2.7-image-pro',   label: 'Wan 2.7 Image Pro' },
]);
```
Add a one-line comment above the `{ ...m }` in `planModelsFor` (Plan-1 Minor #2):
```js
export function planModelsFor(presetId) {
  const list = PLAN_MODELS[presetId];
  // shallow spread is a complete copy for the flat { id, label } shape
  return list ? list.map((m) => ({ ...m })) : [];
}
```
Append the media registry + cap config at the end of the file:
```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test ralph/providers.test.mjs`
Expected: PASS (all, incl. the new media + freeze tests).

- [ ] **Step 5: Commit**

```bash
git add ralph/providers.mjs ralph/providers.test.mjs
git commit -m "feat(providers): media provider registry + per-kind cap config (freeze registries)"
```

---

### Task 2: Pure media-gen core (`ralph/media-gen.mjs`)

**Files:**
- Create: `ralph/media-gen.mjs`
- Test: `ralph/media-gen.test.mjs`

**Interfaces:**
- Produces (all pure): `buildImagePayload(model,prompt)`, `parseImageResponse(data)→url|null`, `findImageUrl(obj)→url|null`; `buildVideoPayload(model,prompt,opts)`, `parseVideoTask(data)→{status,videoUrl,error}`, `videoTaskDone(status)→bool`; `buildMusicPayload(model,prompt,opts)`, `parseMusicTask(data)→{status,audioUrl,error}`; `buildVoicePayload(text,opts)`, `elevenLabsTtsUrl(base,voiceId)→string`; `capState(counts,kind,cap,enabled)→{allowed,reason?,used?,cap?}`.

- [ ] **Step 1: Write the failing tests** — create `ralph/media-gen.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImagePayload, parseImageResponse, findImageUrl,
  buildVideoPayload, parseVideoTask, videoTaskDone,
  buildMusicPayload, parseMusicTask,
  buildVoicePayload, elevenLabsTtsUrl, capState,
} from './media-gen.mjs';

test('buildImagePayload: multimodal content list (MaaS image models require it)', () => {
  assert.deepEqual(buildImagePayload('qwen-image-2.0', 'a red apple'),
    { model: 'qwen-image-2.0', messages: [{ role: 'user', content: [{ type: 'text', text: 'a red apple' }] }] });
});

test('parseImageResponse: finds the first image URL inside output', () => {
  const data = { request_id: 'x', output: { choices: [{ message: { content: [{ image: 'https://oss.example/a/b/c.png?sig=1' }] } }] }, usage: {} };
  assert.equal(parseImageResponse(data), 'https://oss.example/a/b/c.png?sig=1');
  assert.equal(findImageUrl({ a: ['nope', { u: 'https://x/y.webp' }] }), 'https://x/y.webp');
  assert.equal(parseImageResponse({ output: { note: 'no image here' } }), null);
});

test('buildVideoPayload + parseVideoTask', () => {
  assert.deepEqual(buildVideoPayload('seedance-1-0-pro-250528', 'a wave', { ratio: '9:16', duration: 8 }),
    { model: 'seedance-1-0-pro-250528', content: [{ type: 'text', text: 'a wave' }], ratio: '9:16', duration: 8, watermark: true });
  assert.deepEqual(parseVideoTask({ status: 'succeeded', content: { video_url: 'https://v/x.mp4' } }),
    { status: 'succeeded', videoUrl: 'https://v/x.mp4', error: null });
  assert.equal(parseVideoTask({ status: 'failed', error: { message: 'boom' } }).error, 'boom');
  assert.ok(videoTaskDone('succeeded') && videoTaskDone('failed') && !videoTaskDone('running'));
});

test('buildMusicPayload + parseMusicTask (Suno status mapping)', () => {
  const p = buildMusicPayload('V4_5', 'lofi beat', { instrumental: true, callbackUrl: 'https://cb' });
  assert.equal(p.model, 'V4_5'); assert.equal(p.instrumental, true); assert.equal(p.callBackUrl, 'https://cb'); assert.equal(p.customMode, false);
  assert.equal(parseMusicTask({ data: { status: 'PENDING' } }).status, 'pending');
  assert.equal(parseMusicTask({ data: { status: 'GENERATE_AUDIO_FAILED' } }).status, 'failed');
  const ok = parseMusicTask({ data: { status: 'SUCCESS', response: { sunoData: [{ audioUrl: 'https://a/x.mp3' }] } } });
  assert.deepEqual([ok.status, ok.audioUrl], ['succeeded', 'https://a/x.mp3']);
});

test('buildVoicePayload + elevenLabsTtsUrl', () => {
  assert.deepEqual(buildVoicePayload('hello', { modelId: 'eleven_multilingual_v2' }), { text: 'hello', model_id: 'eleven_multilingual_v2' });
  assert.equal(elevenLabsTtsUrl('https://api.elevenlabs.io/', 'Voice 1'), 'https://api.elevenlabs.io/v1/text-to-speech/Voice%201');
});

test('capState: disabled / over-cap / allowed', () => {
  assert.equal(capState({}, 'image', 8, false).allowed, false);
  assert.equal(capState({ image: 8 }, 'image', 8, true).allowed, false);
  const ok = capState({ image: 2 }, 'image', 8, true);
  assert.deepEqual([ok.allowed, ok.used, ok.cap], [true, 2, 8]);
});
```

- [ ] **Step 2: Run to verify fail** — `node --test ralph/media-gen.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `ralph/media-gen.mjs`:

```js
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
```

- [ ] **Step 4: Run to verify pass** — `node --test ralph/media-gen.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ralph/media-gen.mjs ralph/media-gen.test.mjs
git commit -m "feat(media-gen): pure payloads, parsers, and cap logic for image/video/audio"
```

---

### Task 3: Media runtime (`ralph/media-runtime.mjs`)

**Files:**
- Create: `ralph/media-runtime.mjs`
- Test: `ralph/media-runtime.test.mjs`

**Interfaces:**
- Produces: `readCounts(dir)→{image,video,audio}`, `bumpCount(dir,kind)→number`, `downloadTo(url,outPath)→bytes`, `writeBinary(bytes,outPath)`, `writeStub(outPath,kind)`. (Counter + stub are fs-only and unit-tested against a temp dir; `downloadTo` is exercised live by the helpers.)

- [ ] **Step 1: Write the failing tests** — create `ralph/media-runtime.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCounts, bumpCount, writeStub } from './media-runtime.mjs';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'mrt-')); }

test('readCounts defaults to zeros when no file; bumpCount increments and persists', async () => {
  const dir = await tmp();
  assert.deepEqual(await readCounts(dir), { image: 0, video: 0, audio: 0 });
  assert.equal(await bumpCount(dir, 'image'), 1);
  assert.equal(await bumpCount(dir, 'image'), 2);
  assert.equal(await bumpCount(dir, 'video'), 1);
  assert.deepEqual(await readCounts(dir), { image: 2, video: 1, audio: 0 });
  await fs.rm(dir, { recursive: true, force: true });
});

test('writeStub writes a nonzero file (png bytes for image, text otherwise)', async () => {
  const dir = await tmp();
  const img = path.join(dir, 'a/hero.png'); await writeStub(img, 'image');
  const vid = path.join(dir, 'b/clip.mp4'); await writeStub(vid, 'video');
  assert.ok((await fs.stat(img)).size > 0);
  assert.ok((await fs.stat(vid)).size > 0);
  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify fail** — `node --test ralph/media-runtime.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `ralph/media-runtime.mjs`:

```js
// Runtime (fs + http) helpers shared by the gen-*.mjs media helpers. Kept out of
// media-gen.mjs so that module stays pure/unit-tested; the fs bits here are tested
// against a temp dir, downloadTo() is exercised live by the helpers.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const COUNT_FILE = '.ralph/media-count.json';
const ZERO = () => ({ image: 0, video: 0, audio: 0 });

export async function readCounts(dir) {
  try {
    const c = JSON.parse(await fs.readFile(path.join(dir, COUNT_FILE), 'utf8'));
    return { ...ZERO(), ...c };
  } catch { return ZERO(); }
}
export async function bumpCount(dir, kind) {
  const c = await readCounts(dir);
  c[kind] = (c[kind] || 0) + 1;
  await fs.mkdir(path.join(dir, '.ralph'), { recursive: true });
  await fs.writeFile(path.join(dir, COUNT_FILE), JSON.stringify(c));
  return c[kind];
}
export async function writeBinary(bytes, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, bytes);
}
export async function downloadTo(url, outPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeBinary(buf, outPath);
  return buf.length;
}
// Deterministic placeholder for the no-spend stub harness (RALPH_FORCE_TOOL set).
const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
export async function writeStub(outPath, kind) {
  if (kind === 'image') return writeBinary(STUB_PNG, outPath);
  return writeBinary(Buffer.from(`stub ${kind} placeholder (no-spend harness)\n`), outPath);
}
```

- [ ] **Step 4: Run to verify pass** — `node --test ralph/media-runtime.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ralph/media-runtime.mjs ralph/media-runtime.test.mjs
git commit -m "feat(media-runtime): counter file, download, and stub-placeholder helpers"
```

---

### Task 4: `gen-image.mjs` helper

**Files:**
- Create: `ralph/gen-image.mjs`

**Interfaces:**
- Consumes: `media-gen.mjs` (`buildImagePayload`, `parseImageResponse`, `capState`), `media-runtime.mjs` (`readCounts`, `bumpCount`, `downloadTo`, `writeStub`).
- CLI: `node gen-image.mjs "<prompt>" <out/path.png>`. Env: `RALPH_IMAGE_KEY`, `RALPH_IMAGE_BASE` (…/compatible-mode/v1), `RALPH_IMAGE_MODEL` (default `qwen-image-2.0`), `RALPH_IMAGE_CAP` (default 8), `RALPH_IMAGES` (`0` disables), `RALPH_FORCE_TOOL` (stub). Build dir = `process.cwd()`.

- [ ] **Step 1: Implement** — create `ralph/gen-image.mjs`:

```js
#!/usr/bin/env node
// Generate ONE image via the token-plan MaaS chat endpoint and save it into the repo.
// Usage: node gen-image.mjs "<prompt>" <out/path.png>
// Exit: 0 saved (prints path) | 2 error | 3 skipped (disabled/cap → agent uses a placeholder).
import { buildImagePayload, parseImageResponse, capState } from './media-gen.mjs';
import { readCounts, bumpCount, downloadTo, writeStub } from './media-runtime.mjs';

const [prompt, outPath] = process.argv.slice(2);
if (!prompt || !outPath) { console.error('usage: gen-image "<prompt>" <out.png>'); process.exit(2); }

const dir = process.cwd();
const enabled = process.env.RALPH_IMAGES !== '0';
const cap = Number(process.env.RALPH_IMAGE_CAP || 8);
const st = capState(await readCounts(dir), 'image', cap, enabled);
if (!st.allowed) { console.log(`[gen-image] skipped: ${st.reason}. Use a brand asset or placeholder instead.`); process.exit(3); }

// No-spend stub harness.
if (process.env.RALPH_FORCE_TOOL) {
  await writeStub(outPath, 'image'); await bumpCount(dir, 'image');
  console.log(outPath); process.exit(0);
}

const key = process.env.RALPH_IMAGE_KEY;
const base = (process.env.RALPH_IMAGE_BASE || '').replace(/\/+$/, '');
const model = process.env.RALPH_IMAGE_MODEL || 'qwen-image-2.0';
if (!key || !base) { console.error('[gen-image] RALPH_IMAGE_KEY / RALPH_IMAGE_BASE not set'); process.exit(2); }

try {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildImagePayload(model, prompt)),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`[gen-image] API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`); process.exit(2); }
  const url = parseImageResponse(data);
  if (!url) { console.error('[gen-image] no image URL in response'); process.exit(2); }
  await downloadTo(url, outPath);
  await bumpCount(dir, 'image');
  console.log(outPath);
} catch (e) { console.error(`[gen-image] ${e.message}`); process.exit(2); }
```

- [ ] **Step 2: Syntax check** — `node --check ralph/gen-image.mjs` → no output.

- [ ] **Step 3: Stub smoke test** — verify the no-spend path writes a file and bumps the counter, in a temp dir:

Run:
```bash
d=$(mktemp -d); ( cd "$d" && RALPH_FORCE_TOOL=stub node /var/www/tmux.tayyabcheema.com/ralph/gen-image.mjs "a blue logo" assets/logo.png ); \
  test -s "$d/assets/logo.png" && cat "$d/.ralph/media-count.json"; rm -rf "$d"
```
Expected: prints `assets/logo.png`, the file exists non-empty, and `{"image":1,...}`.

- [ ] **Step 4: Commit**

```bash
git add ralph/gen-image.mjs
git commit -m "feat(gen-image): token-plan image generation helper (cap + stub aware)"
```

---

### Task 5: `gen-video.mjs` helper

**Files:**
- Create: `ralph/gen-video.mjs`

**Interfaces:**
- Consumes: `media-gen.mjs` (`buildVideoPayload`, `parseVideoTask`, `videoTaskDone`, `capState`), `media-runtime.mjs` (`readCounts`, `bumpCount`, `downloadTo`, `writeStub`).
- CLI: `node gen-video.mjs "<prompt>" <out/path.mp4> [--duration N] [--ratio 16:9]`. Env: `RALPH_VIDEO_KEY`, `RALPH_VIDEO_BASE` (ARK …/api/v3), `RALPH_VIDEO_MODEL` (default `seedance-1-0-pro-250528`), `RALPH_VIDEO_CAP` (2), `RALPH_VIDEO` (`0` disables), `RALPH_FORCE_TOOL`.

- [ ] **Step 1: Implement** — create `ralph/gen-video.mjs`:

```js
#!/usr/bin/env node
// Generate ONE short video via BytePlus ModelArk (Seedance) and save it into the repo.
// Usage: node gen-video.mjs "<prompt>" <out.mp4> [--duration N] [--ratio 16:9]
// Exit: 0 saved | 2 error | 3 skipped. Async: create task, poll (bounded ~10 min).
import { buildVideoPayload, parseVideoTask, videoTaskDone, capState } from './media-gen.mjs';
import { readCounts, bumpCount, downloadTo, writeStub } from './media-runtime.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [prompt, outPath] = pos;
if (!prompt || !outPath) { console.error('usage: gen-video "<prompt>" <out.mp4> [--duration N] [--ratio 16:9]'); process.exit(2); }

const dir = process.cwd();
const enabled = process.env.RALPH_VIDEO !== '0';
const cap = Number(process.env.RALPH_VIDEO_CAP || 2);
const st = capState(await readCounts(dir), 'video', cap, enabled);
if (!st.allowed) { console.log(`[gen-video] skipped: ${st.reason}. Omit the video or use a static image.`); process.exit(3); }

if (process.env.RALPH_FORCE_TOOL) {
  await writeStub(outPath, 'video'); await bumpCount(dir, 'video');
  console.log(outPath); process.exit(0);
}

const key = process.env.RALPH_VIDEO_KEY;
const base = (process.env.RALPH_VIDEO_BASE || '').replace(/\/+$/, '');
const model = process.env.RALPH_VIDEO_MODEL || 'seedance-1-0-pro-250528';
if (!key || !base) { console.error('[gen-video] RALPH_VIDEO_KEY / RALPH_VIDEO_BASE not set'); process.exit(2); }
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const create = await fetch(`${base}/contents/generations/tasks`, {
    method: 'POST', headers: H,
    body: JSON.stringify(buildVideoPayload(model, prompt, { ratio: flag('--ratio', '16:9'), duration: flag('--duration', 5) })),
  });
  const cj = await create.json().catch(() => ({}));
  if (!create.ok || !cj.id) { console.error(`[gen-video] create ${create.status}: ${JSON.stringify(cj).slice(0, 200)}`); process.exit(2); }
  // Poll up to ~10 min (60 * 10s).
  for (let i = 0; i < 60; i++) {
    await sleep(10_000);
    const g = await fetch(`${base}/contents/generations/tasks/${cj.id}`, { headers: { Authorization: `Bearer ${key}` } });
    const t = parseVideoTask(await g.json().catch(() => ({})));
    if (videoTaskDone(t.status)) {
      if (t.status === 'failed' || !t.videoUrl) { console.error(`[gen-video] task failed: ${t.error || 'no url'}`); process.exit(2); }
      await downloadTo(t.videoUrl, outPath); await bumpCount(dir, 'video');
      console.log(outPath); process.exit(0);
    }
  }
  console.error('[gen-video] timed out waiting for the video'); process.exit(2);
} catch (e) { console.error(`[gen-video] ${e.message}`); process.exit(2); }
```

- [ ] **Step 2: Syntax check** — `node --check ralph/gen-video.mjs`.

- [ ] **Step 3: Stub smoke test**
```bash
d=$(mktemp -d); ( cd "$d" && RALPH_FORCE_TOOL=stub node /var/www/tmux.tayyabcheema.com/ralph/gen-video.mjs "a wave" assets/hero.mp4 --duration 5 ); \
  test -s "$d/assets/hero.mp4" && cat "$d/.ralph/media-count.json"; rm -rf "$d"
```
Expected: prints `assets/hero.mp4`, file exists, `{"video":1,...}`.

- [ ] **Step 4: Commit**
```bash
git add ralph/gen-video.mjs
git commit -m "feat(gen-video): ModelArk/Seedance video helper (async poll, cap + stub aware)"
```

---

### Task 6: `gen-audio.mjs` helper (music + voiceover)

**Files:**
- Create: `ralph/gen-audio.mjs`

**Interfaces:**
- Consumes: `media-gen.mjs` (`buildMusicPayload`, `parseMusicTask`, `buildVoicePayload`, `elevenLabsTtsUrl`, `capState`), `media-runtime.mjs` (`readCounts`, `bumpCount`, `downloadTo`, `writeBinary`, `writeStub`).
- CLI: `node gen-audio.mjs "<prompt>" <out.mp3> --type music|voiceover [--instrumental]`. Env (music): `RALPH_MUSIC_KEY`, `RALPH_MUSIC_BASE` (suno), `RALPH_MUSIC_MODEL` (default `V4_5`). Env (voiceover): `RALPH_VOICE_KEY`, `RALPH_VOICE_BASE` (default `https://api.elevenlabs.io`), `RALPH_VOICE_ID` (default `21m00Tcm4TlvDq8ikWAM`), `RALPH_VOICE_MODEL` (default `eleven_multilingual_v2`). Shared: `RALPH_AUDIO_CAP` (3), `RALPH_AUDIO` (`0` disables), `RALPH_FORCE_TOOL`.

- [ ] **Step 1: Implement** — create `ralph/gen-audio.mjs`:

```js
#!/usr/bin/env node
// Generate ONE audio clip and save it into the repo. Two providers behind --type:
//   music     -> Suno (sunoapi.org, async poll)
//   voiceover -> ElevenLabs (sync binary mp3)
// Usage: node gen-audio.mjs "<prompt>" <out.mp3> --type music|voiceover [--instrumental]
// Exit: 0 saved | 2 error | 3 skipped. Both count against the shared `audio` cap.
import { buildMusicPayload, parseMusicTask, buildVoicePayload, elevenLabsTtsUrl, capState } from './media-gen.mjs';
import { readCounts, bumpCount, downloadTo, writeBinary, writeStub } from './media-runtime.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [prompt, outPath] = pos;
const type = val('--type', 'music');
if (!prompt || !outPath || !['music', 'voiceover'].includes(type)) {
  console.error('usage: gen-audio "<prompt>" <out.mp3> --type music|voiceover [--instrumental]'); process.exit(2);
}

const dir = process.cwd();
const enabled = process.env.RALPH_AUDIO !== '0';
const cap = Number(process.env.RALPH_AUDIO_CAP || 3);
const st = capState(await readCounts(dir), 'audio', cap, enabled);
if (!st.allowed) { console.log(`[gen-audio] skipped: ${st.reason}. Omit audio for now.`); process.exit(3); }

if (process.env.RALPH_FORCE_TOOL) {
  await writeStub(outPath, 'audio'); await bumpCount(dir, 'audio');
  console.log(outPath); process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (type === 'voiceover') {
    const key = process.env.RALPH_VOICE_KEY;
    const base = process.env.RALPH_VOICE_BASE || 'https://api.elevenlabs.io';
    const voiceId = process.env.RALPH_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    if (!key) { console.error('[gen-audio] RALPH_VOICE_KEY not set'); process.exit(2); }
    const r = await fetch(elevenLabsTtsUrl(base, voiceId), {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(buildVoicePayload(prompt, { modelId: process.env.RALPH_VOICE_MODEL || 'eleven_multilingual_v2' })),
    });
    if (!r.ok) { console.error(`[gen-audio] voiceover ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`); process.exit(2); }
    await writeBinary(Buffer.from(await r.arrayBuffer()), outPath);
    await bumpCount(dir, 'audio'); console.log(outPath); process.exit(0);
  }

  // music (Suno async)
  const key = process.env.RALPH_MUSIC_KEY;
  const base = (process.env.RALPH_MUSIC_BASE || 'https://api.sunoapi.org').replace(/\/+$/, '');
  const model = process.env.RALPH_MUSIC_MODEL || 'V4_5';
  if (!key) { console.error('[gen-audio] RALPH_MUSIC_KEY not set'); process.exit(2); }
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const create = await fetch(`${base}/api/v1/generate`, {
    method: 'POST', headers: H,
    body: JSON.stringify(buildMusicPayload(model, prompt, { instrumental: has('--instrumental') })),
  });
  const cj = await create.json().catch(() => ({}));
  const taskId = cj && cj.data && cj.data.taskId;
  if (!create.ok || !taskId) { console.error(`[gen-audio] music create ${create.status}: ${JSON.stringify(cj).slice(0, 200)}`); process.exit(2); }
  for (let i = 0; i < 60; i++) {
    await sleep(10_000);
    const g = await fetch(`${base}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}` } });
    const t = parseMusicTask(await g.json().catch(() => ({})));
    if (t.status === 'succeeded' && t.audioUrl) { await downloadTo(t.audioUrl, outPath); await bumpCount(dir, 'audio'); console.log(outPath); process.exit(0); }
    if (t.status === 'failed') { console.error(`[gen-audio] music failed: ${t.error || 'unknown'}`); process.exit(2); }
  }
  console.error('[gen-audio] timed out waiting for music'); process.exit(2);
} catch (e) { console.error(`[gen-audio] ${e.message}`); process.exit(2); }
```

- [ ] **Step 2: Syntax check** — `node --check ralph/gen-audio.mjs`.

- [ ] **Step 3: Stub smoke test** (both types share the `audio` counter)
```bash
d=$(mktemp -d); ( cd "$d" && RALPH_FORCE_TOOL=stub node /var/www/tmux.tayyabcheema.com/ralph/gen-audio.mjs "lofi beat" assets/bg.mp3 --type music && \
  RALPH_FORCE_TOOL=stub node /var/www/tmux.tayyabcheema.com/ralph/gen-audio.mjs "welcome" assets/vo.mp3 --type voiceover ); \
  cat "$d/.ralph/media-count.json"; rm -rf "$d"
```
Expected: both print their paths; `{"audio":2,...}`.

- [ ] **Step 4: Commit**
```bash
git add ralph/gen-audio.mjs
git commit -m "feat(gen-audio): Suno music + ElevenLabs voiceover helper (cap + stub aware)"
```

---

### Task 7: Server config — credentials, caps, `run.media`, env injection, routes

**Files:**
- Modify: `server.js` (secret accessors ~669-673; `VAULT_PROVIDERS` ~3107-3115; `ralphEnvPrefix` ~1594-1608; `/api/ralph/start` body reads ~3673 + call ~3729; `startRalphRun` params ~2522 + `run` literal ~2545-2555; add `/api/ralph/media-caps` + `/api/admin/media-caps`; import providers media exports)

**Interfaces:**
- Consumes: `mediaCredentialIds`, `mediaCapDefaults`, `normalizeMedia`, `MEDIA_PROVIDERS` (Task 1).
- Produces: `run.media` (normalized caps) threaded into worker sessions as `RALPH_*` env + `RALPH_GEN_IMAGE/VIDEO/AUDIO` helper paths.

- [ ] **Step 1: Extend the providers import** — the Plan-1 import line is `import { planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase } from './ralph/providers.mjs';`. Replace with:
```js
import { planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase, mediaCredentialIds, mediaCapDefaults, normalizeMedia, MEDIA_PROVIDERS } from './ralph/providers.mjs';
```

- [ ] **Step 2: Media credential + cap accessors** — after the flutter accessors (server.js:673, the `codemagicToken` line), add:
```js
// Media-generation credentials (single-tenant fallback; multitenant reads the vault first).
const arkKey = () => process.env.WEBTMUX_ARK_KEY || secrets.arkApiKey || '';
const arkBaseUrl = () => (process.env.WEBTMUX_ARK_BASE || secrets.arkBaseUrl || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/+$/, '');
const sunoKey = () => process.env.WEBTMUX_SUNO_KEY || secrets.sunoApiKey || '';
const sunoBaseUrl = () => (process.env.WEBTMUX_SUNO_BASE || secrets.sunoBaseUrl || 'https://api.sunoapi.org').replace(/\/+$/, '');
const elevenLabsKey = () => process.env.WEBTMUX_ELEVENLABS_KEY || secrets.elevenLabsApiKey || '';
const elevenLabsVoice = () => process.env.WEBTMUX_ELEVENLABS_VOICE || secrets.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM';
// Per-kind cap/toggle defaults: env override (JSON) → secrets.mediaCaps → registry defaults.
function mediaCapsEffective() {
  try { if (process.env.WEBTMUX_RALPH_MEDIA) return normalizeMedia(JSON.parse(process.env.WEBTMUX_RALPH_MEDIA)); } catch { /* ignore */ }
  return normalizeMedia(secrets.mediaCaps || mediaCapDefaults());
}
```

- [ ] **Step 3: Register the vault providers** — in `VAULT_PROVIDERS` (server.js:3113, after `'firebase', 'google-play', 'codemagic',`), add:
```js
    // Media-generation credentials (image reuses the qwen/token-plan key; these are the paid extras).
    ...mediaCredentialIds(), // ark (video), suno (music), elevenlabs (voiceover)
```

- [ ] **Step 4: Read + normalize `run.media` in `/api/ralph/start`** — after the `assetToken` read (server.js:3678), add:
```js
  // Per-build media caps/toggles (image/video/audio). Falls back to the deploy defaults.
  const media = normalizeMedia(req.body?.media || mediaCapsEffective());
```
Then thread it into the `startRalphRun` call (server.js:3729): add `, media` to the argument object:
```js
    const run = await startRalphRun({ project, idea, master, workers, maxAttempts, workerPasses, bypass, outputFormat, model, prd, tenant, assetToken, media });
```

- [ ] **Step 5: Accept + store `media` in `startRalphRun`** — add `media = null` to the destructured params (server.js:2522):
```js
async function startRalphRun({ project, idea, master, workers, maxAttempts = 3, workerPasses = 1, bypass = true, outputFormat, model = null, prd: prdInput, tenant = null, assetToken = null, media = null }) {
```
And in the `run` object literal (after the `model:` line, server.js:2548):
```js
    media: normalizeMedia(media), // per-build media caps/toggles (image/video/audio)
```

- [ ] **Step 6: Inject media env into worker sessions** — in `ralphEnvPrefix` (server.js), before the `RALPH_FORCE_TOOL` line (server.js:1606), add:
```js
  // Media generation: expose the helper paths + per-kind creds/caps for visual/media builds.
  if (run && run.media) {
    const m = run.media, get = (p) => tenantKey(run, p);
    envs.push(`RALPH_GEN_IMAGE=${RALPH_GEN_IMAGE}`, `RALPH_GEN_VIDEO=${RALPH_GEN_VIDEO}`, `RALPH_GEN_AUDIO=${RALPH_GEN_AUDIO}`);
    envs.push(`RALPH_IMAGES=${m.image.enabled ? 1 : 0}`, `RALPH_IMAGE_CAP=${m.image.cap}`,
              `RALPH_VIDEO=${m.video.enabled ? 1 : 0}`, `RALPH_VIDEO_CAP=${m.video.cap}`,
              `RALPH_AUDIO=${m.audio.enabled ? 1 : 0}`, `RALPH_AUDIO_CAP=${m.audio.cap}`);
    // image reuses the token-plan (qwen) key + OpenAI-compatible base.
    const imgKey = get('qwen') || qwenKey();
    if (m.image.enabled && imgKey) envs.push(`RALPH_IMAGE_KEY=${shq(imgKey)}`, `RALPH_IMAGE_BASE=${shq(qwenBaseUrl())}`, `RALPH_IMAGE_MODEL=${shq(qwenImageModel())}`);
    if (m.video.enabled) { const k = get('ark') || arkKey(); if (k) envs.push(`RALPH_VIDEO_KEY=${shq(k)}`, `RALPH_VIDEO_BASE=${shq(arkBaseUrl())}`); }
    if (m.audio.enabled) {
      const sk = get('suno') || sunoKey(); if (sk) envs.push(`RALPH_MUSIC_KEY=${shq(sk)}`, `RALPH_MUSIC_BASE=${shq(sunoBaseUrl())}`);
      const vk = get('elevenlabs') || elevenLabsKey(); if (vk) envs.push(`RALPH_VOICE_KEY=${shq(vk)}`, `RALPH_VOICE_ID=${shq(elevenLabsVoice())}`);
    }
  }
```
Add the helper-path constants after `RALPH_DELIVER_SH` (server.js:1130; `RALPH_DIR = path.join(__dirname, 'ralph')` is already defined at server.js:66):
```js
const RALPH_GEN_IMAGE = path.join(RALPH_DIR, 'gen-image.mjs');
const RALPH_GEN_VIDEO = path.join(RALPH_DIR, 'gen-video.mjs');
const RALPH_GEN_AUDIO = path.join(RALPH_DIR, 'gen-audio.mjs');
```
And the image-model accessor beside `qwenModel` (server.js:678):
```js
const qwenImageModel = () => process.env.WEBTMUX_QWEN_IMAGE_MODEL || secrets.qwenImageModel || 'qwen-image-2.0';
```

- [ ] **Step 7: Persist `run.media` across restarts — no change needed.** `persistRun` (server.js:1656) serializes the WHOLE run via `writeJson(path…, run)` (no field whitelist), so the plain `run.media` object round-trips automatically and `loadRun` restores it. (Sanity-confirm `writeJson` does `JSON.stringify`; nothing to edit.)

- [ ] **Step 8: Media-caps routes** — add a public read (mirrors `/api/ralph/solo-models`) near it (server.js:~4457), and an admin write (mirrors `/api/admin/solo-models`):
```js
app.get('/api/ralph/media-caps', (_req, res) => res.json({ caps: mediaCapsEffective(), defaults: mediaCapDefaults() }));
```
In the admin section (near `/api/admin/solo-models`):
```js
  app.put('/api/admin/media-caps', async (req, res) => {
    const caps = normalizeMedia(req.body?.caps);
    try { secrets.mediaCaps = caps; await saveSecrets(); res.json({ ok: true, caps }); }
    catch (e) { fail(res, 500, e.message); }
  });
```
(Use whatever the existing solo-models admin route uses to persist — if it writes a dedicated file rather than `secrets`, mirror that exact persistence; read `/api/admin/solo-models` first and match it.)

- [ ] **Step 9: Syntax check** — `node --check server.js`.

- [ ] **Step 10: Commit**
```bash
git add server.js
git commit -m "feat(server): media credentials, caps, run.media threading + worker env injection"
```

---

### Task 8: Media skill + brief injection

**Files:**
- Modify: `ralph/skills/imagery/SKILL.md`
- Modify: `server.js` (`writeRalphBrief` ~1767-1804)

- [ ] **Step 1: Extend the skill** — replace the closing blockquote of `ralph/skills/imagery/SKILL.md` (the `> (Future) AI image generation …` lines) with real AI-media instructions:
```md
4. **AI generation (when enabled) — use the media helpers.** The build may set a budget for
   generated media. Generate only when a brand asset or good stock image won't do, and stay within budget.
   - **Image:** `node "$RALPH_GEN_IMAGE" "<detailed prompt>" <relative/output/path.png>` — saves the image
     and prints its path. Exit 3 = budget reached/disabled → fall back to stock or a placeholder.
   - **Video** (only if provided): `node "$RALPH_GEN_VIDEO" "<prompt>" <path.mp4> [--duration 5] [--ratio 16:9]`.
   - **Music** (only if provided): `node "$RALPH_GEN_AUDIO" "<prompt>" <path.mp3> --type music [--instrumental]`.
   - **Voiceover/narration** (only if provided): `node "$RALPH_GEN_AUDIO" "<script>" <path.mp3> --type voiceover`.
   Reference saved files by relative path so the built site/app serves them, and record each generated
   asset (kind + prompt) in `DELIVERABLE.md`. If a helper prints "skipped" (exit 3) or isn't set, use a
   tasteful placeholder instead — never block the build on media.
```
Also update the frontmatter `description` to mention media:
```md
description: Use brand assets first, else generate images/video/audio via the media helpers (within the build's budget), else free stock — always with good alt text.
```

- [ ] **Step 2: Pass the media budget into the brief** — in `writeRalphBrief` (server.js), the `VISUAL_OUTPUT` set already injects `imagery`. Widen it to cover audio-capable formats and add a budget note. Change:
```js
  const VISUAL_OUTPUT = new Set(['web-app', 'flutter-app', 'google-slides', 'pptx']);
  const briefSkills = VISUAL_OUTPUT.has(outputFormat) ? ['imagery', ...skills] : skills;
```
to:
```js
  const VISUAL_OUTPUT = new Set(['web-app', 'flutter-app', 'google-slides', 'pptx']);
  const wantsMedia = VISUAL_OUTPUT.has(outputFormat);
  const briefSkills = wantsMedia ? ['imagery', ...skills] : skills;
```
and add `media` to the destructured options + a budget section. Change the signature:
```js
async function writeRalphBrief(dir, tool, { skills = [], tools = [], outputType, outputFormat, finalize = false, mcp = null, masterNotes = '', media = null }) {
```
and, right before `if (!parts.length) return '';`, add:
```js
  if (wantsMedia && media) {
    const on = (k) => media[k]?.enabled ? `on (up to ${media[k].cap})` : 'off';
    parts.push(`## Media budget for this build\nGenerated media is: image ${on('image')}, video ${on('video')}, audio ${on('audio')}.\n`
      + `Use the media helpers from the imagery skill only for the enabled kinds and within budget; otherwise use brand assets, stock, or a placeholder.`);
  }
```
Finally pass `media` at the two `writeRalphBrief` call sites — the worker spawn (server.js:1866) and the finalize spawn (server.js:1914) — add `media: run.media,` to each options object.

- [ ] **Step 3: Syntax check** — `node --check server.js`.

- [ ] **Step 4: Commit**
```bash
git add ralph/skills/imagery/SKILL.md server.js
git commit -m "feat(skill): media generation instructions + per-build budget in the brief"
```

---

### Task 9: `web/` credentials UI (Settings + Admin)

**Files:**
- Modify: `web/src/pages/Settings.jsx` (export `MEDIA_CARDS` near `MOBILE_CARDS` ~79-98; render group after the mobile block ~463-474; optional `AGENT_META` entries)
- Modify: `web/src/pages/Admin.jsx` (import + render `MEDIA_CARDS` like `MOBILE_CARDS` ~5, ~172-184)

- [ ] **Step 1: Add `MEDIA_CARDS`** — in `web/src/pages/Settings.jsx`, after the `MOBILE_CARDS` array (line 98), add:
```jsx
export const MEDIA_CARDS = [
  {
    agent: 'ark', label: 'Video (BytePlus ModelArk)', emoji: '🎬',
    blurb: 'Optional — generate short hero/product-demo videos (Seedance) inside your builds. Add your BytePlus ModelArk API key. Off by default per build; enable it and set a cap in New Build.',
    methods: [{ id: 'ark', kind: 'key', label: 'API key', hint: 'BytePlus ModelArk (Ark) API key. Used as the video-generation credential; billed to your BytePlus account.' }],
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
```

- [ ] **Step 2: Render the group** — in `web/src/pages/Settings.jsx`, after the `MOBILE_CARDS` render block (closes at line 474), add a sibling block:
```jsx
      {Array.isArray(keys) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Media generation</h2>
          <p className="mt-1 text-sm text-muted">Optional — generate images/video/music/voiceover inside builds. <b>Images</b> use your token-plan/Qwen key (already connected). Video/music/voiceover need their own keys below and are <b>off by default</b> per build.</p>
          <div className="mt-3 space-y-3">
            {MEDIA_CARDS.map((c) => (
              <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={cliLogins}
                soloModels={soloModels} onSave={save} onRemove={remove} busy={busy} />
            ))}
          </div>
        </div>
      )}
```
(The cards have no `AGENT_META` entry, so `SpecPanel` renders nothing for them — which is fine. No `showUsage`, so no balance strip.)

- [ ] **Step 3: Admin credentials group** — in `web/src/pages/Admin.jsx`, extend the Settings import (line 5) to also import `MEDIA_CARDS`, and after the `MOBILE_CARDS` render section (closes ~184) add:
```jsx
      {Array.isArray(keys) && (
        <section className="mt-8">
          <h2 className="mb-1 font-semibold">Media generation</h2>
          <p className="mb-3 text-xs text-muted">Video (ModelArk), music (Suno), and voiceover (ElevenLabs) keys for in-build media generation, saved to your admin workspace vault. Images reuse the token-plan key.</p>
          <div className="space-y-3">
            {MEDIA_CARDS.map((c) => (
              <AgentCard key={c.agent} card={c} keys={keys} presets={presets} cliLogins={[]} soloModels={{}} onSave={saveKey} onRemove={removeKey} busy={busy} />
            ))}
          </div>
        </section>
      )}
```

- [ ] **Step 4: Build** — `cd web && npm run build` (must succeed).

- [ ] **Step 5: Commit**
```bash
git add web/src/pages/Settings.jsx web/src/pages/Admin.jsx
git commit -m "feat(web): media-generation credential cards (Settings + Admin)"
```

---

### Task 10: `web/` New Build media controls + payload

**Files:**
- Modify: `web/src/pages/NewBuild.jsx` (state ~40-54; Media section inside the `card` div ~214-274; `doStart` payload ~163-168)
- Modify: `web/src/api.js` (add `mediaCaps`/`setMediaCaps` near `soloModels` ~53-54)

**Interfaces:**
- Consumes: `GET /api/ralph/media-caps` (Task 7) for defaults; posts `media` to `/api/ralph/start`.

- [ ] **Step 1: api.js** — after `setSoloModels` (web/src/api.js:54), add:
```js
  mediaCaps: () => req('GET', '/api/ralph/media-caps'),
  setMediaCaps: (caps) => req('PUT', '/api/admin/media-caps', { caps }),
```

- [ ] **Step 2: State + defaults fetch** — in `web/src/pages/NewBuild.jsx`, add a `media` state near the other state (after `model` at line 40):
```jsx
  const [media, setMedia] = useState({ image: { enabled: true, cap: 8 }, video: { enabled: false, cap: 2 }, audio: { enabled: false, cap: 3 } });
```
Extend the existing `api.keys()` useEffect (the one that sets `planModels`) to also load the deploy default caps:
```jsx
    api.mediaCaps().then((d) => d?.caps && setMedia(d.caps)).catch(() => {});
```
(Add that line inside the same useEffect body added in Plan 1, right after the `setPlanModels(...)` call.)

- [ ] **Step 3: Media section UI** — inside the `<div className="card space-y-5">` (after the Model block that ends at line 254), add:
```jsx
            <div>
              <label className="label">Media generation <span className="opacity-60">(optional — billed to your keys)</span></label>
              <div className="space-y-2">
                {[['image', 'Images (Qwen/Wan)'], ['video', 'Video (Seedance)'], ['audio', 'Audio (Suno / ElevenLabs)']].map(([k, lbl]) => (
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
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">Video &amp; audio are off by default (they cost the most). Images use your token-plan key; video/audio need their keys in Settings.</p>
            </div>
```

- [ ] **Step 4: Payload** — in `doStart` (web/src/pages/NewBuild.jsx:163-168), add `media` to the `api.start({...})` object (after `model:`):
```jsx
        media,
```

- [ ] **Step 5: Build** — `cd web && npm run build`.

- [ ] **Step 6: Commit**
```bash
git add web/src/pages/NewBuild.jsx web/src/api.js
git commit -m "feat(web): per-build media caps/toggles in New Build"
```

---

### Task 11: Key-test probes, docs, and verification

**Files:**
- Modify: `ralph/key-test.mjs` (`KEY_TESTS` ~14-23) + `ralph/key-test.test.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add key-test probes** — write the failing test first (append to `ralph/key-test.test.mjs`):
```js
test('buildKeyProbe: media providers (suno, elevenlabs) have auth probes', () => {
  const s = buildKeyProbe('suno', 'sk-suno');
  assert.equal(s.url, 'https://api.sunoapi.org/api/v1/generate/credit');
  assert.equal(s.headers.Authorization, 'Bearer sk-suno');
  const e = buildKeyProbe('elevenlabs', 'xi-key');
  assert.equal(e.url, 'https://api.elevenlabs.io/v1/user');
  assert.equal(e.headers['xi-api-key'], 'xi-key');
});
```
Run `node --test ralph/key-test.test.mjs` → FAIL. Then add to `KEY_TESTS` (ralph/key-test.mjs), a new `xi-api-key` auth mode. Add entries:
```js
  suno:       { url: 'https://api.sunoapi.org/api/v1/generate/credit', auth: 'bearer' },
  elevenlabs: { url: 'https://api.elevenlabs.io/v1/user', auth: 'xi-api-key' },
```
and in `buildKeyProbe`, handle the new mode (after the `x-api-key` branch):
```js
  else if (cfg.auth === 'xi-api-key') headers['xi-api-key'] = key;
```
and in the "every KEY_TESTS entry has a known auth mode" test's allowed list, add `'xi-api-key'`. (`ark`/BytePlus has no cheap auth-only GET, so it's intentionally omitted — the UI shows "no automated test", same as OAuth providers.) Run `node --test ralph/key-test.test.mjs` → PASS.

- [ ] **Step 2: Docs** — append a "Media generation" subsection to `CLAUDE.md` (after the token-plan preset paragraph):
```md
### Media generation (image/video/audio in deliverables)
Ralph builds can generate media into visual deliverables via vendored, agent-invoked helpers (like the
imagery skill): `ralph/gen-image.mjs` (token-plan MaaS, reuse the qwen key), `ralph/gen-video.mjs`
(BytePlus ModelArk/Seedance, `ark` vault key), `ralph/gen-audio.mjs` (`--type music` → Suno `suno` key /
`--type voiceover` → ElevenLabs `elevenlabs` key). Pure logic + parsers are in `ralph/media-gen.mjs`
(tested); fs/http in `ralph/media-runtime.mjs`. Per-kind opt-in + cap (`run.media`, defaults image on/8,
video off/2, audio off/3) is injected into worker sessions by `ralphEnvPrefix` as `RALPH_*` env +
`RALPH_GEN_*` paths; `writeRalphBrief` states the budget and injects the media skill for `VISUAL_OUTPUT`
formats. Helpers are **stub-aware** (`RALPH_FORCE_TOOL` → deterministic placeholder, no spend). New vault
creds: `ark`/`suno`/`elevenlabs` (Settings + Admin "Media generation" cards). Call shapes proven in
`/home/tmuxweb/projects/video` (`generation_service.py`).
```

- [ ] **Step 3: Full suite + syntax** — `node --test ralph/*.test.mjs` (all pass), `node --check server.js && node --check ralph/gen-image.mjs && node --check ralph/gen-video.mjs && node --check ralph/gen-audio.mjs`.

- [ ] **Step 4: Commit**
```bash
git add ralph/key-test.mjs ralph/key-test.test.mjs CLAUDE.md
git commit -m "feat(key-test): suno/elevenlabs probes + docs(CLAUDE.md): media generation"
```

- [ ] **Step 5: Stub e2e (no-spend) — controller-run after merge** — with `RALPH_FORCE_TOOL=stub` on the service, start a `web-app` build with `media:{image:{enabled:true,cap:2},...}`, and confirm the worker session env carries `RALPH_GEN_IMAGE` + `RALPH_IMAGE_CAP=2` and that a stub build's worktree gets a `.ralph/media-count.json`. (Full recipe mirrors Plan 1 Task 7's stub verification.)

---

## Self-Review

**Spec coverage (design spec Parts C/D/E + registry):**
- Extensible provider registry + adapters → Task 1 (`MEDIA_PROVIDERS`) + Task 2 (per-protocol builders/parsers). ✓
- Image (token plan, reuse qwenApiKey) → Task 4 + env injection Task 7. ✓
- Video (ark) → Task 5; Music (suno) + Voiceover (elevenlabs) → Task 6. ✓
- 3 new named credentials → Task 7 (`VAULT_PROVIDERS`) + Task 9 (UI). ✓
- Per-kind caps/toggles (image on/8, video off/2, audio off/3), per-build overridable, admin default → Task 1 (`normalizeMedia`/defaults) + Task 7 (`run.media`, routes) + Task 10 (New Build) + Admin. ✓
- Media skill + brief injection → Task 8. ✓
- Stub-aware (no-spend harness) → Tasks 4/5/6 (`RALPH_FORCE_TOOL` → `writeStub`) + Task 11 e2e. ✓
- key-test probes → Task 11. ✓
- Clears Plan-1 deferred Minors (freeze arrays, shallow-spread comment) → Task 1. ✓

**Placeholder scan:** none — full code for every new module/helper; exact old→new for edits. The two originally-uncertain spots are now pinned: `RALPH_DIR` exists at server.js:66 (helper-path constants are literal), and `persistRun` (server.js:1656) serializes the whole run so `run.media` persists with no code change. The one remaining "read-first" is Task 7 Step 8's admin route — mirror the existing `/api/admin/solo-models` persistence exactly (read it first) rather than assuming `secrets.mediaCaps`.

**Type consistency:** `run.media` shape `{image:{enabled,cap},video:{…},audio:{…}}` is produced by `normalizeMedia` (Task 1) and consumed identically in `ralphEnvPrefix` (Task 7), `writeRalphBrief` (Task 8), and the UI (Task 10). Helper env var names (`RALPH_IMAGE_*`/`RALPH_VIDEO_*`/`RALPH_MUSIC_*`/`RALPH_VOICE_*`/`RALPH_AUDIO_CAP`) match between Task 7 injection and Tasks 4/5/6 consumption. `capState`/`readCounts`/`bumpCount` signatures match across core, runtime, and helpers.

**Note for the implementer:** the one "read-first" spot is Task 7 Step 8's admin write route — open `/api/admin/solo-models` and mirror its exact persistence mechanism (dedicated file vs `secrets`) instead of assuming `secrets.mediaCaps`/`saveSecrets`. Everything else is literal.
