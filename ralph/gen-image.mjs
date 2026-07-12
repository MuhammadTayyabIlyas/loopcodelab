#!/usr/bin/env node
// Generate ONE image via the token-plan MaaS chat endpoint and save it into the repo.
// Usage: node gen-image.mjs "<prompt>" <out/path.png>
// Exit: 0 saved (prints path) | 2 error | 3 skipped (disabled/cap → agent uses a placeholder).
import { buildImagePayload, grokImagePayload, parseImageResponse, capState } from './media-gen.mjs';
import { readCounts, bumpCount, downloadTo, writeStub } from './media-runtime.mjs';

const [prompt, outPath] = process.argv.slice(2);
if (!prompt || !outPath) { console.error('usage: gen-image "<prompt>" <out.png>'); process.exit(2); }

const dir = process.env.RALPH_MEDIA_COUNT_DIR || process.cwd();
const enabled = process.env.RALPH_IMAGES !== '0';
const cap = Number(process.env.RALPH_IMAGE_CAP || 8);
const st = capState(await readCounts(dir), 'image', cap, enabled);
if (!st.allowed) { console.log(`[gen-image] skipped: ${st.reason}. Use a brand asset or placeholder instead.`); process.exit(3); }

// No-spend stub harness.
if (process.env.RALPH_FORCE_TOOL) {
  await writeStub(outPath, 'image'); await bumpCount(dir, 'image');
  console.log(outPath); process.exit(0);
}

// Provider: 'tokenplan' (default — Alibaba MaaS via the qwen key) or 'grok'
// (xAI Grok Imagine on the user's SUBSCRIPTION token — no extra spend).
const provider = process.env.RALPH_IMAGE_PROVIDER || 'tokenplan';
const key = process.env.RALPH_IMAGE_KEY;
const base = (process.env.RALPH_IMAGE_BASE || (provider === 'grok' ? 'https://api.x.ai/v1' : '')).replace(/\/+$/, '');
const model = process.env.RALPH_IMAGE_MODEL || (provider === 'grok' ? 'grok-imagine-image' : 'qwen-image-2.0');
if (!key || !base) { console.error('[gen-image] RALPH_IMAGE_KEY / RALPH_IMAGE_BASE not set'); process.exit(2); }

try {
  const url = provider === 'grok' ? `${base}/images/generations` : `${base}/chat/completions`;
  const payload = provider === 'grok' ? grokImagePayload(model, prompt) : buildImagePayload(model, prompt);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`[gen-image] API ${r.status}: ${JSON.stringify(data).slice(0, 200)}`); process.exit(2); }
  const imgUrl = parseImageResponse(data);
  if (!imgUrl) { console.error('[gen-image] no image URL in response'); process.exit(2); }
  await downloadTo(imgUrl, outPath);
  await bumpCount(dir, 'image');
  console.log(outPath);
} catch (e) { console.error(`[gen-image] ${e.message}`); process.exit(2); }
