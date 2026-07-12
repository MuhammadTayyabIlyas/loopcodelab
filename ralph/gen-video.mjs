#!/usr/bin/env node
// Generate ONE short video via BytePlus ModelArk (Seedance) and save it into the repo.
// Usage: node gen-video.mjs "<prompt>" <out.mp4> [--duration N] [--ratio 16:9]
// Exit: 0 saved | 2 error | 3 skipped. Async: create task, poll (bounded ~10 min).
import { buildVideoPayload, parseVideoTask, videoTaskDone, grokVideoPayload, parseGrokVideo, grokVideoDone, capState } from './media-gen.mjs';
import { readCounts, bumpCount, downloadTo, writeStub } from './media-runtime.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [prompt, outPath] = pos;
if (!prompt || !outPath) { console.error('usage: gen-video "<prompt>" <out.mp4> [--duration N] [--ratio 16:9]'); process.exit(2); }

const dir = process.env.RALPH_MEDIA_COUNT_DIR || process.cwd();
const enabled = process.env.RALPH_VIDEO !== '0';
const cap = Number(process.env.RALPH_VIDEO_CAP || 2);
const st = capState(await readCounts(dir), 'video', cap, enabled);
if (!st.allowed) { console.log(`[gen-video] skipped: ${st.reason}. Omit the video or use a static image.`); process.exit(3); }

if (process.env.RALPH_FORCE_TOOL) {
  await writeStub(outPath, 'video'); await bumpCount(dir, 'video');
  console.log(outPath); process.exit(0);
}

// Provider: 'ark' (default — BytePlus Seedance, pay-as-you-go) or 'grok'
// (xAI Grok Imagine on the user's SUBSCRIPTION token — no extra spend).
const provider = process.env.RALPH_VIDEO_PROVIDER || 'ark';
const key = process.env.RALPH_VIDEO_KEY;
const base = (process.env.RALPH_VIDEO_BASE || (provider === 'grok' ? 'https://api.x.ai/v1' : '')).replace(/\/+$/, '');
const model = process.env.RALPH_VIDEO_MODEL || (provider === 'grok' ? 'grok-imagine-video' : 'seedance-1-0-pro-250528');
if (!key || !base) { console.error('[gen-video] RALPH_VIDEO_KEY / RALPH_VIDEO_BASE not set'); process.exit(2); }
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Grok Imagine: create -> { request_id } -> poll GET /videos/{id} until done/failed/expired.
if (provider === 'grok') {
  try {
    const create = await fetch(`${base}/videos/generations`, {
      method: 'POST', headers: H,
      body: JSON.stringify(grokVideoPayload(model, prompt, { ratio: flag('--ratio', '16:9'), duration: flag('--duration', 5) })),
    });
    const cj = await create.json().catch(() => ({}));
    const rid = cj.request_id || cj.id;
    if (!create.ok || !rid) { console.error(`[gen-video] create ${create.status}: ${JSON.stringify(cj).slice(0, 200)}`); process.exit(2); }
    for (let i = 0; i < 60; i++) { // up to ~10 min ("typically several minutes" per xAI docs)
      await sleep(10_000);
      const g = await fetch(`${base}/videos/${rid}`, { headers: { Authorization: `Bearer ${key}` } });
      const t = parseGrokVideo(await g.json().catch(() => ({})));
      if (grokVideoDone(t.status)) {
        if (t.status !== 'done' || !t.videoUrl) { console.error(`[gen-video] task ${t.status}: ${t.error || 'no url'}`); process.exit(2); }
        await downloadTo(t.videoUrl, outPath); await bumpCount(dir, 'video');
        console.log(outPath); process.exit(0);
      }
    }
    console.error('[gen-video] timed out waiting for the video'); process.exit(2);
  } catch (e) { console.error(`[gen-video] ${e.message}`); process.exit(2); }
}

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
