#!/usr/bin/env node
// Generate ONE audio clip and save it into the repo. Providers behind --type:
//   music     -> Suno (sunoapi.org, async poll)
//   voiceover -> ElevenLabs (sync binary mp3), or Grok TTS on the user's Grok
//                SUBSCRIPTION token (RALPH_VOICE_PROVIDER=grok — no extra spend)
// Usage: node gen-audio.mjs "<prompt>" <out.mp3> --type music|voiceover [--instrumental]
// Exit: 0 saved | 2 error | 3 skipped. Both count against the shared `audio` cap.
import { buildMusicPayload, parseMusicTask, buildVoicePayload, elevenLabsTtsUrl, grokTtsPayload, capState } from './media-gen.mjs';
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

const dir = process.env.RALPH_MEDIA_COUNT_DIR || process.cwd();
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
    const provider = process.env.RALPH_VOICE_PROVIDER || 'elevenlabs';
    const key = process.env.RALPH_VOICE_KEY;
    if (!key) { console.error('[gen-audio] RALPH_VOICE_KEY not set'); process.exit(2); }
    let r;
    if (provider === 'grok') {
      // xAI Grok TTS: sync binary mp3; `language` is required, voice via RALPH_VOICE_ID.
      const base = (process.env.RALPH_VOICE_BASE || 'https://api.x.ai/v1').replace(/\/+$/, '');
      r = await fetch(`${base}/tts`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(grokTtsPayload(prompt, { voice: process.env.RALPH_VOICE_ID || 'ara', language: process.env.RALPH_VOICE_LANG || 'en' })),
      });
    } else {
      const base = process.env.RALPH_VOICE_BASE || 'https://api.elevenlabs.io';
      const voiceId = process.env.RALPH_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
      r = await fetch(elevenLabsTtsUrl(base, voiceId), {
        method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(buildVoicePayload(prompt, { modelId: process.env.RALPH_VOICE_MODEL || 'eleven_multilingual_v2' })),
      });
    }
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
