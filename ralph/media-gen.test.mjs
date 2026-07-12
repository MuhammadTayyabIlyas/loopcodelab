import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImagePayload, parseImageResponse, findImageUrl,
  buildVideoPayload, parseVideoTask, videoTaskDone,
  buildMusicPayload, parseMusicTask,
  buildVoicePayload, elevenLabsTtsUrl, capState,
  grokImagePayload, grokVideoPayload, parseGrokVideo, grokVideoDone, grokTtsPayload,
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

// --- Grok Imagine (xAI) — subscription-token media provider ---------------------

test('grokImagePayload + parse: xAI images/generations; parser handles BOTH observed shapes', () => {
  const p = grokImagePayload('grok-imagine-image', 'a sailboat');
  assert.deepEqual(p, { model: 'grok-imagine-image', prompt: 'a sailboat', n: 1, response_format: 'url' });
  // documented xAI shape
  assert.equal(parseImageResponse({ data: [{ url: 'https://x.ai/img/a.png' }] }), 'https://x.ai/img/a.png');
  // shape observed live 2026-07-02 (DashScope-style envelope, signed URL)
  const observed = { request_id: 'r', output: { choices: [{ message: { content: [{ image: 'https://dashscope-x.oss.aliyuncs.com/a/b.png?Expires=1&Signature=s' }] } }] } };
  assert.match(parseImageResponse(observed), /^https:\/\/dashscope-x\.oss/);
});

test('grokVideoPayload: duration clamped 1-15, aspect_ratio passthrough', () => {
  assert.deepEqual(grokVideoPayload('grok-imagine-video', 'waves', { duration: 8, ratio: '16:9' }),
    { model: 'grok-imagine-video', prompt: 'waves', duration: 8, aspect_ratio: '16:9' });
  assert.equal(grokVideoPayload('m', 'p', { duration: 99 }).duration, 15);
  assert.equal(grokVideoPayload('m', 'p', { duration: 0 }).duration, 5);   // default
});

test('parseGrokVideo + grokVideoDone: pending/done/expired/failed lifecycle', () => {
  const done = parseGrokVideo({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', duration: 8 } });
  assert.equal(done.status, 'done');
  assert.equal(done.videoUrl, 'https://vidgen.x.ai/v.mp4');
  assert.equal(parseGrokVideo({ status: 'pending' }).videoUrl, null);
  assert.equal(grokVideoDone('pending'), false);
  assert.equal(grokVideoDone('done'), true);
  assert.equal(grokVideoDone('failed'), true);
  assert.equal(grokVideoDone('expired'), true);   // terminal — never poll an expired task forever
});

test('grokTtsPayload: text/language/voice — language is REQUIRED by the API (422 without)', () => {
  assert.deepEqual(grokTtsPayload('hello'), { text: 'hello', language: 'en', voice: 'ara' });
  assert.deepEqual(grokTtsPayload('hola', { voice: 'rex', language: 'es' }), { text: 'hola', language: 'es', voice: 'rex' });
});
