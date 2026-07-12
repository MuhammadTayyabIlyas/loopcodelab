#!/usr/bin/env node
// ralph/compose-media.mjs
// Agent-invoked LOCAL composition helper for social-video builds ($RALPH_COMPOSE).
// No API spend — runs ffmpeg on this box — so it is bounded by output COUNT and
// total SIZE, not the paid media caps. Exit codes: 0 ok, 2 error, 3 skipped.
//
// Usage:
//   $RALPH_COMPOSE slideshow img1.png img2.png --audio bed.mp3 --out out.mp4 --platform tiktok [--secs-per-image 3]
//   $RALPH_COMPOSE stitch clip1.mp4 clip2.mp4 --out master.mp4 --platform youtube
//   $RALPH_COMPOSE overlay-text in.mp4 --text "Hook line" --color '#FF5500' --out out.mp4 --platform tiktok
//   $RALPH_COMPOSE render-platforms master.mp4 --out output/story --platforms tiktok,youtube-short
//   $RALPH_COMPOSE story storyboard.json --out output/story --platforms tiktok,youtube-short   (the one-shot recipe)
//   $RALPH_COMPOSE gallery output --out index.html --title "My promo" --color '#FF5500'        (preview page, no ffmpeg)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import {
  PLATFORM_SPECS, normalizePlatforms, parseComposeArgs,
  slideshowArgs, stitchArgs, drawTextArgs, renderPlatformArgs,
  probeArgs, parseProbe, checkOutput, parseStoryboard, storyboardSteps, galleryHtml,
  platformForFile,
} from './social-formats.mjs';
import { readCounts, bumpCount, bumpBytes, writeStub } from './media-runtime.mjs';

const run = promisify(execFile);
const req = parseComposeArgs(process.argv.slice(2));
if (req.error) { console.error(`[compose] ${req.error}`); process.exit(2); }

const countDir = process.env.RALPH_MEDIA_COUNT_DIR || process.cwd();
const CAP = Math.max(1, Number(process.env.RALPH_COMPOSE_CAP) || 12);
const MB_CAP = Math.max(10, Number(process.env.RALPH_COMPOSE_MB) || 200);

// gallery: pure templating over output/*.mp4 — no ffmpeg, no caps, stub-indifferent.
if (req.cmd === 'gallery') {
  const dir = req.inputs[0];
  const names = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.mp4')).sort();
  const outputs = names.map((f) => ({ file: `${dir}/${f}`, platform: platformForFile(f) })).filter((o) => o.platform);
  if (!outputs.length) { console.error(`[compose] gallery: no *-<platform>.mp4 files in ${dir}`); process.exit(2); }
  await fs.writeFile(req.out, galleryHtml(outputs, { title: req.opts.title || 'Story video', color: req.opts.color || '#3b82f6' }));
  console.log(req.out); process.exit(0);
}

async function execStep(args, out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  try { await run('ffmpeg', args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { console.error(`[compose] ffmpeg failed on ${out}: ${String(e.stderr || e.message).slice(-400)}`); process.exit(2); }
}
async function verify(out, spec, { wantAudio = false } = {}) {
  let probe = null;
  try { probe = parseProbe((await run('ffprobe', probeArgs(out), { timeout: 30_000 })).stdout); } catch { /* below */ }
  const issues = checkOutput(probe, spec).filter((i) => wantAudio || !i.includes('no audio'));
  if (issues.length) { console.error(`[compose] verify failed for ${out}: ${issues.join('; ')}`); process.exit(2); }
}
async function record(out) {
  const size = (await fs.stat(out)).size;
  await bumpCount(countDir, 'compose');
  await bumpBytes(countDir, 'composeBytes', size);
  console.log(out);
}
async function capGate(plannedCount) {
  const counts = await readCounts(countDir);
  if ((counts.compose || 0) + plannedCount > CAP) {
    console.error(`[compose] skipped: compose cap reached (${counts.compose || 0}/${CAP})`); process.exit(3);
  }
  if ((Number(counts.composeBytes) || 0) > MB_CAP * 1024 * 1024) {
    console.error(`[compose] skipped: total output size cap reached (${MB_CAP} MB)`); process.exit(3);
  }
}

// story: agent-written storyboard.json -> the whole compose chain in one call.
// Only the final platform renders count toward the cap; intermediates are temp.
if (req.cmd === 'story') {
  const parsed = parseStoryboard(await fs.readFile(req.inputs[0], 'utf8').catch(() => ''));
  if (parsed.error) { console.error(`[compose] storyboard: ${parsed.error}`); process.exit(2); }
  const platforms = normalizePlatforms(req.opts.platforms);
  const steps = storyboardSteps(parsed.board, platforms, req.out);
  const renders = steps.filter((s) => s.kind === 'render');
  await capGate(renders.length);
  if (process.env.RALPH_FORCE_TOOL) {
    for (const r of renders) { await writeStub(r.out, 'video'); await bumpCount(countDir, 'compose'); console.log(r.out); }
    process.exit(0);
  }
  // Progress breadcrumb for the orchestrator tick (surfaced in both UIs) + cleanup
  // that survives the error paths — execStep process.exit()s, so a finally won't run.
  const PROGRESS = '.ralph/compose-progress.json';
  process.on('exit', () => {
    try { rmSync(PROGRESS, { force: true }); } catch { /* best-effort */ }
    try { rmSync('.ralph/compose-tmp', { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  await fs.mkdir('.ralph', { recursive: true }).catch(() => {});
  for (const [i, s] of steps.entries()) {
    await fs.writeFile(PROGRESS, JSON.stringify({ step: i + 1, total: steps.length, kind: s.kind, out: s.out, at: Date.now() })).catch(() => {});
    await execStep(s.args, s.out);
  }
  for (const r of renders) { await verify(r.out, PLATFORM_SPECS[platformForFile(r.out)], { wantAudio: !!parsed.board.audio }); await record(r.out); }
  process.exit(0);
}

// The four single-step commands.
const outputsFor = () => req.cmd === 'render-platforms'
  ? normalizePlatforms(req.opts.platforms).map((p) => ({ platform: p, out: `${req.out}-${p}.mp4` }))
  : [{ platform: req.opts.platform || 'tiktok', out: req.out }];

const planned = outputsFor();
await capGate(planned.length);

// Stub harness: deterministic placeholders, no ffmpeg, still counted.
if (process.env.RALPH_FORCE_TOOL) {
  for (const o of planned) { await writeStub(o.out, 'video'); await bumpCount(countDir, 'compose'); }
  console.log(planned.map((o) => o.out).join('\n')); process.exit(0);
}

for (const o of planned) {
  const s = PLATFORM_SPECS[o.platform];
  if (!s) { console.error(`[compose] unknown platform ${o.platform}`); process.exit(2); }
  let args;
  if (req.cmd === 'slideshow') args = slideshowArgs(req.inputs, req.opts.audio, o.out, s, { secsPerImage: req.opts.secsPerImage });
  else if (req.cmd === 'stitch') args = stitchArgs(req.inputs, o.out, s);
  else if (req.cmd === 'overlay-text') {
    if (!req.opts.text) { console.error('[compose] overlay-text needs --text'); process.exit(2); }
    args = drawTextArgs(req.inputs[0], o.out, { text: req.opts.text, color: req.opts.color || 'white' }, s);
  } else args = renderPlatformArgs(req.inputs[0], o.out, s);

  await execStep(args, o.out);
  // Self-verify: exact canvas + duration clamp; a bad render is an error, not a shrug.
  await verify(o.out, s);
  await record(o.out);
}
