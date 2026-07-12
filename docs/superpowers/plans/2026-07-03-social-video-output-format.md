# Social-Video Output Format (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `social-video` Ralph output format that builds a ~30-second story video and renders it per social platform (TikTok / Instagram / YouTube / LinkedIn dimensions), with per-build media model pickers and a user-facing output verification report + preview.

**Architecture:** Follows the proven media-gen pattern — a pure unit-tested module (`ralph/social-formats.mjs`) holding platform specs + ffmpeg arg builders, a stub-aware agent-invoked CLI (`ralph/compose-media.mjs`, `$RALPH_COMPOSE`), a vendored SKILL.md that teaches any agent the workflow, and orchestrator wiring (format registration, env injection, finalize-time verification recorded on `run.mediaReport`, mirrored in both UIs). Generation spend stays behind the existing `gen-*` caps; composition is free local ffmpeg bounded by count/size.

**Tech Stack:** Node ESM (`ralph/*.mjs`, `node --test`), ffmpeg 8 + ffprobe (installed at `/usr/bin`), Express routes in `server/routes/`, React+Vite in `web/`, vanilla PWA in `public/`.

**Spec:** `docs/superpowers/specs/2026-07-03-media-output-formats-design.md` (Phase 1 scope; `music-track`/`image-set`/vocal-removal are Phases 2–3 — do NOT build them here).

## Global Constraints

- Syntax-check before any restart: `node --check server.js server/*.mjs server/routes/*.mjs` and `node --check ralph/*.mjs`; UI: `node --check public/js/dashboard.js public/js/dashboard/*.js`.
- Tests: `node --test ralph/<name>.test.mjs` — pure modules only; never unit-test `server/` modules directly.
- After editing anything in `public/`: bump `VERSION` in `public/sw.js` (current scheme `webtmux-vNN` — increment by 1, once, in the final public/ task).
- After editing `web/src`: `cd web && npm run build`. NEVER commit `web/dist`.
- After editing `server.js`/`server/*`: `systemctl restart webtmux` (safe for live sessions).
- Helper CLI exit codes: `0` ok, `2` error, `3` skipped (disabled/over-cap) — agents are told 3 means "fall back gracefully".
- Stub awareness: every helper obeys `RALPH_FORCE_TOOL` → deterministic placeholder, zero external calls.
- Compose bounds: max **12** compose outputs and **200 MB** total per build (env-overridable `RALPH_COMPOSE_CAP` / `RALPH_COMPOSE_MB`).
- A compose/verification failure NEVER fails a build (advisory, same rule as `run.pwa`).
- Workers never edit `prd.json`; all new run fields must round-trip through `runSummary` to reach the UIs.
- Commit after each task (checkpoint repo; `git add` the specific files, never `-A` — `.claude/` must stay untracked).

---

### Task 1: `ralph/social-formats.mjs` — platform specs + pure ffmpeg arg builders

**Files:**
- Create: `ralph/social-formats.mjs`
- Test: `ralph/social-formats.test.mjs`

**Interfaces:**
- Produces (used by Tasks 2, 4, 6, 8):
  - `PLATFORM_SPECS: {[id]: {w,h,fps,maxSeconds,label}}`, `DEFAULT_PLATFORMS: string[]`
  - `normalizePlatforms(input) -> string[]` (valid ids only; `[]`/junk → `DEFAULT_PLATFORMS`)
  - `escapeDrawText(s) -> string`
  - `slideshowArgs(images, audio, out, spec, {secsPerImage}) -> string[]` (ffmpeg argv, no binary name)
  - `stitchArgs(clips, out, spec) -> string[]` (video-only concat)
  - `drawTextArgs(input, out, {text, color, box}, spec) -> string[]`
  - `renderPlatformArgs(master, out, spec) -> string[]`
  - `probeArgs(file) -> string[]` (ffprobe argv)
  - `parseProbe(json) -> {width,height,duration,hasAudio} | null`
  - `checkOutput(probe, spec) -> string[]` (issues, empty = ok)
  - `platformForFile(name) -> string|null` (matches `*-<platform>.mp4`; re-exported by media-validate in Task 3)
  - `muxAudioArgs(video, audio, out) -> string[]` (lay an audio bed under a silent video)
  - `parseStoryboard(json) -> {board} | {error}` (board: `{title, platform, audio, text|null, scenes:[{image, clip, seconds}]}`)
  - `storyboardSteps(board, platforms, outBase) -> [{kind, out, args}]` (the pure recipe planner behind `story`)
  - `galleryHtml(outputs, {title, color}) -> string` (outputs: `[{file, platform}]`)
  - `parseComposeArgs(argv) -> {cmd, inputs, out, opts} | {error}`

- [ ] **Step 1: Write the failing test**

```js
// ralph/social-formats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_SPECS, DEFAULT_PLATFORMS, normalizePlatforms, escapeDrawText,
  slideshowArgs, stitchArgs, drawTextArgs, renderPlatformArgs,
  probeArgs, parseProbe, checkOutput, parseComposeArgs, platformForFile,
  muxAudioArgs, parseStoryboard, storyboardSteps, galleryHtml,
} from './social-formats.mjs';

test('platform specs: vertical trio is 1080x1920, youtube is 16:9', () => {
  for (const id of ['tiktok', 'instagram-reel', 'youtube-short']) {
    assert.equal(PLATFORM_SPECS[id].w, 1080);
    assert.equal(PLATFORM_SPECS[id].h, 1920);
  }
  assert.equal(PLATFORM_SPECS.youtube.w, 1920);
  assert.equal(PLATFORM_SPECS.youtube.h, 1080);
  for (const s of Object.values(PLATFORM_SPECS)) {
    assert.ok(s.fps > 0 && s.maxSeconds > 0 && s.label);
  }
});

test('normalizePlatforms: filters junk, defaults when empty', () => {
  assert.deepEqual(normalizePlatforms(['tiktok', 'nope', 'youtube']), ['tiktok', 'youtube']);
  assert.deepEqual(normalizePlatforms([]), DEFAULT_PLATFORMS);
  assert.deepEqual(normalizePlatforms('junk'), DEFAULT_PLATFORMS);
  for (const id of DEFAULT_PLATFORMS) assert.ok(PLATFORM_SPECS[id]);
});

test('escapeDrawText escapes ffmpeg drawtext specials', () => {
  assert.equal(escapeDrawText("it's 100%: fine\\"), "it\\'s 100\\%\\: fine\\\\");
});

test('slideshowArgs: one loop input per image + audio + concat + x264', () => {
  const spec = PLATFORM_SPECS['instagram-reel'];
  const args = slideshowArgs(['a.png', 'b.png'], 'bed.mp3', 'out.mp4', spec, { secsPerImage: 3 });
  assert.equal(args.filter((a) => a === '-loop').length, 2);
  assert.ok(args.includes('a.png') && args.includes('bed.mp3') && args.at(-1) === 'out.mp4');
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('concat=n=2:v=1:a=0'));
  assert.ok(fc.includes(`s=${spec.w}x${spec.h}`)); // zoompan renders at spec size
  assert.ok(args.includes('libx264') && args.includes('-shortest'));
});

test('stitchArgs: normalizes every clip to spec then concats video-only', () => {
  const spec = PLATFORM_SPECS.youtube;
  const args = stitchArgs(['c1.mp4', 'c2.mp4', 'c3.mp4'], 'out.mp4', spec);
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('concat=n=3:v=1:a=0'));
  assert.ok(fc.includes(`scale=${spec.w}:${spec.h}:force_original_aspect_ratio=decrease`));
  assert.equal(args.filter((a) => a === '-i').length, 3);
});

test('drawTextArgs: escaped text, safe-margin y, translucent box', () => {
  const spec = PLATFORM_SPECS.tiktok;
  const args = drawTextArgs('in.mp4', 'out.mp4', { text: "Don't miss", color: '#FF5500' }, spec);
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes("Don\\'t miss"));
  assert.ok(vf.includes('fontcolor=#FF5500'));
  assert.ok(vf.includes('boxcolor=black@0.4'));
});

test('renderPlatformArgs: pads to exact WxH, clamps duration, faststart', () => {
  const spec = PLATFORM_SPECS['instagram-feed'];
  const args = renderPlatformArgs('master.mp4', 'out.mp4', spec);
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes(`pad=${spec.w}:${spec.h}`));
  assert.deepEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', String(spec.maxSeconds)]);
  assert.ok(args.includes('+faststart'));
});

test('parseProbe/checkOutput: dimensions + duration verdicts', () => {
  const probe = parseProbe(JSON.stringify({
    streams: [{ codec_type: 'video', width: 1080, height: 1920 }, { codec_type: 'audio' }],
    format: { duration: '29.97' },
  }));
  assert.deepEqual(probe, { width: 1080, height: 1920, duration: 29.97, hasAudio: true });
  assert.deepEqual(checkOutput(probe, PLATFORM_SPECS.tiktok), []);
  const bad = checkOutput({ width: 720, height: 1280, duration: 500, hasAudio: false }, PLATFORM_SPECS.tiktok);
  assert.ok(bad.some((i) => i.includes('720x1280')));
  assert.ok(bad.some((i) => i.includes('duration')));
  assert.equal(parseProbe('not json'), null);
});

test('parseComposeArgs: subcommands parse; bad input errors', () => {
  const s = parseComposeArgs(['slideshow', 'a.png', 'b.png', '--audio', 'bed.mp3', '--out', 'out.mp4', '--platform', 'tiktok']);
  assert.deepEqual(s, { cmd: 'slideshow', inputs: ['a.png', 'b.png'], out: 'out.mp4', opts: { audio: 'bed.mp3', platform: 'tiktok', platforms: [], text: '', color: '', title: '', secsPerImage: 3 } });
  const r = parseComposeArgs(['render-platforms', 'master.mp4', '--out', 'output/story', '--platforms', 'tiktok,youtube']);
  assert.equal(r.cmd, 'render-platforms');
  assert.deepEqual(r.opts.platforms, ['tiktok', 'youtube']);
  assert.equal(parseComposeArgs(['story', 'storyboard.json', '--out', 'output/story']).cmd, 'story');
  assert.equal(parseComposeArgs(['gallery', 'output', '--out', 'index.html', '--title', 'Promo']).opts.title, 'Promo');
  assert.ok(parseComposeArgs(['nope']).error);
  assert.ok(parseComposeArgs(['slideshow', '--out', 'x.mp4']).error); // no inputs
});

test('platformForFile matches the -<platform>.mp4 suffix (longest id first)', () => {
  assert.equal(platformForFile('story-tiktok.mp4'), 'tiktok');
  assert.equal(platformForFile('output/promo-instagram-reel.mp4'), 'instagram-reel');
  assert.equal(platformForFile('story.mp4'), null);
  assert.equal(platformForFile('notes.txt'), null);
});

test('muxAudioArgs: copies video, encodes audio, shortest wins', () => {
  const args = muxAudioArgs('v.mp4', 'bed.mp3', 'out.mp4');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '0:v', '-map', '1:a']);
  assert.ok(args.includes('-shortest') && args.includes('v.mp4') && args.includes('bed.mp3') && args.at(-1) === 'out.mp4');
});

test('parseStoryboard: validates scenes, clamps seconds, defaults platform', () => {
  const ok = parseStoryboard(JSON.stringify({ scenes: [{ image: 'a.png', seconds: 99 }, { clip: 'b.mp4' }], audio: 'bed.mp3', text: { content: 'Hi' } }));
  assert.equal(ok.board.scenes.length, 2);
  assert.equal(ok.board.scenes[0].seconds, 10); // clamped
  assert.equal(ok.board.platform, 'tiktok');    // default
  assert.equal(ok.board.text.color, 'white');   // default
  assert.ok(parseStoryboard('not json').error);
  assert.ok(parseStoryboard('{"scenes":[]}').error);
  assert.ok(parseStoryboard('{"scenes":[{"seconds":3}]}').error); // needs image or clip
});

test('storyboardSteps: stills-only -> slideshow, overlay, render per platform', () => {
  const { board } = parseStoryboard(JSON.stringify({ scenes: [{ image: 'a.png' }, { image: 'b.png' }], audio: 'bed.mp3', text: { content: 'Hook' } }));
  const steps = storyboardSteps(board, ['tiktok', 'youtube'], 'output/story');
  assert.deepEqual(steps.map((s) => s.kind), ['slideshow', 'overlay', 'render', 'render']);
  assert.equal(steps.at(-1).out, 'output/story-youtube.mp4');
  assert.ok(steps.every((s) => Array.isArray(s.args) && s.args.at(-1) === s.out));
});

test('storyboardSteps: mixed scenes -> scene clips, stitch, mux, render', () => {
  const { board } = parseStoryboard(JSON.stringify({ scenes: [{ image: 'a.png' }, { clip: 'c.mp4' }], audio: 'bed.mp3' }));
  const steps = storyboardSteps(board, ['tiktok'], 'output/story');
  assert.deepEqual(steps.map((s) => s.kind), ['scene', 'stitch', 'mux', 'render']);
});

test('galleryHtml: one <video> per output, platform label, brand color, escaped title', () => {
  const html = galleryHtml([{ file: 'output/story-tiktok.mp4', platform: 'tiktok' }], { title: 'Promo <x>', color: '#123456' });
  assert.ok(html.includes('<video') && html.includes('output/story-tiktok.mp4'));
  assert.ok(html.includes(PLATFORM_SPECS.tiktok.label));
  assert.ok(html.includes('#123456'));
  assert.ok(html.includes('Promo &lt;x&gt;') && !html.includes('Promo <x>'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ralph/social-formats.test.mjs`
Expected: FAIL — `Cannot find module ... social-formats.mjs`

- [ ] **Step 3: Write the implementation**

```js
// ralph/social-formats.mjs
// Pure helpers for the social-video output format: per-platform render specs and
// ffmpeg/ffprobe ARG BUILDERS (argv arrays, no binary name, no I/O) so the compose
// CLI stays thin and everything fiddly is unit-tested without running ffmpeg.

export const PLATFORM_SPECS = Object.freeze({
  'tiktok':         Object.freeze({ w: 1080, h: 1920, fps: 30, maxSeconds: 180, label: 'TikTok (9:16)' }),
  'instagram-reel': Object.freeze({ w: 1080, h: 1920, fps: 30, maxSeconds: 90,  label: 'Instagram Reel (9:16)' }),
  'instagram-feed': Object.freeze({ w: 1080, h: 1350, fps: 30, maxSeconds: 60,  label: 'Instagram Feed (4:5)' }),
  'youtube-short':  Object.freeze({ w: 1080, h: 1920, fps: 30, maxSeconds: 60,  label: 'YouTube Short (9:16)' }),
  'youtube':        Object.freeze({ w: 1920, h: 1080, fps: 30, maxSeconds: 600, label: 'YouTube (16:9)' }),
  'linkedin':       Object.freeze({ w: 1920, h: 1080, fps: 30, maxSeconds: 600, label: 'LinkedIn (16:9)' }),
});
export const DEFAULT_PLATFORMS = Object.freeze(['tiktok', 'instagram-reel', 'youtube-short']);

export function normalizePlatforms(input) {
  const ids = (Array.isArray(input) ? input : [])
    .map((p) => String(p || '').trim()).filter((p) => PLATFORM_SPECS[p]);
  return ids.length ? [...new Set(ids)] : [...DEFAULT_PLATFORMS];
}

// ffmpeg drawtext treats \ ' : % as syntax — escape them in user text.
export function escapeDrawText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

const X264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
// Cover-fit a stream to the spec canvas (fill + center-crop) — for stills.
const coverFit = (spec) => `scale=${spec.w}:${spec.h}:force_original_aspect_ratio=increase,crop=${spec.w}:${spec.h},setsar=1`;
// Contain-fit (letterbox/pillarbox) — for clips whose framing must survive.
const containFit = (spec) => `scale=${spec.w}:${spec.h}:force_original_aspect_ratio=decrease,pad=${spec.w}:${spec.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

// images + one audio bed -> a slideshow video with a gentle Ken Burns push-in.
export function slideshowArgs(images, audio, out, spec, { secsPerImage = 3 } = {}) {
  const frames = Math.round(secsPerImage * spec.fps);
  const args = ['-y'];
  for (const img of images) args.push('-loop', '1', '-t', String(secsPerImage), '-i', img);
  if (audio) args.push('-i', audio);
  const chains = images.map((_, i) =>
    `[${i}:v]${coverFit(spec)},zoompan=z='min(zoom+0.0008,1.08)':d=${frames}:s=${spec.w}x${spec.h}:fps=${spec.fps}[v${i}]`);
  const fc = `${chains.join(';')};${images.map((_, i) => `[v${i}]`).join('')}concat=n=${images.length}:v=1:a=0[v]`;
  args.push('-filter_complex', fc, '-map', '[v]');
  if (audio) args.push('-map', `${images.length}:a`, '-c:a', 'aac', '-shortest');
  args.push('-r', String(spec.fps), ...X264, out);
  return args;
}

// Normalize N clips/stills-as-video to one canvas and concat their VIDEO streams.
// Audio deliberately stays out (mixed/missing audio tracks make concat brittle);
// lay the bed/voiceover over the result with `slideshow` or a later overlay pass.
export function stitchArgs(clips, out, spec) {
  const args = ['-y'];
  for (const c of clips) args.push('-i', c);
  const chains = clips.map((_, i) => `[${i}:v]${containFit(spec)},fps=${spec.fps}[v${i}]`);
  const fc = `${chains.join(';')};${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[v]`;
  args.push('-filter_complex', fc, '-map', '[v]', ...X264, out);
  return args;
}

// Burn a hook/CTA line near the bottom, inside a ~8% safe margin, on a translucent box.
export function drawTextArgs(input, out, { text, color = 'white', box = true } = {}, spec) {
  const draw = `drawtext=text='${escapeDrawText(text)}':fontcolor=${color}`
    + `:fontsize=h/14:x=(w-text_w)/2:y=h-text_h-h*0.08`
    + (box ? ':box=1:boxcolor=black@0.4:boxborderw=18' : '');
  return ['-y', '-i', input, '-vf', draw, '-c:a', 'copy', ...X264, out];
}

// One master -> one platform render: contain-fit, fps, duration clamp, AAC audio.
export function renderPlatformArgs(master, out, spec) {
  return ['-y', '-i', master, '-vf', `${containFit(spec)},fps=${spec.fps}`,
          '-t', String(spec.maxSeconds), '-c:a', 'aac', ...X264, out];
}

export function probeArgs(file) {
  return ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file];
}
export function parseProbe(json) {
  try {
    const j = JSON.parse(json);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    if (!v) return null;
    return {
      width: v.width || 0, height: v.height || 0,
      duration: Number(j.format?.duration) || 0,
      hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    };
  } catch { return null; }
}
export function checkOutput(probe, spec) {
  const issues = [];
  if (!probe) return ['unreadable output (ffprobe failed)'];
  if (probe.width !== spec.w || probe.height !== spec.h) {
    issues.push(`is ${probe.width}x${probe.height}, expected ${spec.w}x${spec.h}`);
  }
  if (probe.duration > spec.maxSeconds + 0.5) {
    issues.push(`duration ${Math.round(probe.duration)}s exceeds platform max ${spec.maxSeconds}s`);
  }
  if (!probe.hasAudio) issues.push('no audio track');
  return issues;
}

// Which platform a render file targets, from the *-<platform>.mp4 naming contract.
// Longest ids first so instagram-reel wins over any shorter suffix overlap.
const PLATFORM_IDS_BY_LENGTH = Object.keys(PLATFORM_SPECS).sort((a, b) => b.length - a.length);
export function platformForFile(name) {
  const base = String(name).split('/').pop();
  if (!base.endsWith('.mp4')) return null;
  for (const id of PLATFORM_IDS_BY_LENGTH) if (base.endsWith(`-${id}.mp4`)) return id;
  return null;
}

// Lay an audio bed under a (silent) video: copy video, encode audio, stop at the shorter.
export function muxAudioArgs(video, audio, out) {
  return ['-y', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', out];
}

// Validate an agent-written storyboard.json into a canonical board (or an error).
// Scenes carry image OR clip paths; seconds clamped 1..10; platform = master canvas.
export function parseStoryboard(json) {
  let b;
  try { b = JSON.parse(json); } catch { return { error: 'storyboard is not valid JSON' }; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'storyboard must be a JSON object' };
  const scenes = Array.isArray(b.scenes) ? b.scenes : [];
  if (!scenes.length) return { error: 'storyboard needs at least one scene' };
  const clean = [];
  for (const s of scenes) {
    if (!s || typeof s !== 'object' || (!s.image && !s.clip)) return { error: 'every scene needs an image or clip path' };
    clean.push({
      image: s.image ? String(s.image) : '', clip: s.clip ? String(s.clip) : '',
      seconds: Math.max(1, Math.min(10, Number(s.seconds) || 3)),
    });
  }
  const text = (b.text && typeof b.text === 'object' && b.text.content)
    ? { content: String(b.text.content), color: String(b.text.color || 'white') } : null;
  return { board: {
    title: String(b.title || 'story'),
    platform: PLATFORM_SPECS[b.platform] ? b.platform : 'tiktok',
    audio: b.audio ? String(b.audio) : '', text, scenes: clean,
  } };
}

// The reusable recipe: expand a board into the ordered ffmpeg step list the compose
// CLI executes. Pure — intermediates live under .ralph/compose-tmp/. Stills-only
// boards go straight through slideshow (audio included there); mixed boards render
// each still to a scene clip, stitch (video-only), then mux the audio bed.
export function storyboardSteps(board, platforms, outBase) {
  const spec = PLATFORM_SPECS[board.platform];
  const tmp = (n) => `.ralph/compose-tmp/${n}`;
  const steps = [];
  let master;
  if (board.scenes.every((s) => s.image)) {
    master = tmp('master.mp4');
    steps.push({ kind: 'slideshow', out: master,
      args: slideshowArgs(board.scenes.map((s) => s.image), board.audio, master, spec, { secsPerImage: board.scenes[0].seconds }) });
  } else {
    const clips = board.scenes.map((s, i) => {
      if (s.clip) return s.clip;
      const out = tmp(`scene${i}.mp4`);
      steps.push({ kind: 'scene', out, args: slideshowArgs([s.image], '', out, spec, { secsPerImage: s.seconds }) });
      return out;
    });
    master = tmp('stitched.mp4');
    steps.push({ kind: 'stitch', out: master, args: stitchArgs(clips, master, spec) });
    if (board.audio) {
      const muxed = tmp('master.mp4');
      steps.push({ kind: 'mux', out: muxed, args: muxAudioArgs(master, board.audio, muxed) });
      master = muxed;
    }
  }
  if (board.text) {
    const t = tmp('master-txt.mp4');
    steps.push({ kind: 'overlay', out: t, args: drawTextArgs(master, t, { text: board.text.content, color: board.text.color }, spec) });
    master = t;
  }
  for (const p of platforms) {
    const out = `${outBase}-${p}.mp4`;
    steps.push({ kind: 'render', out, args: renderPlatformArgs(master, out, PLATFORM_SPECS[p]) });
  }
  return steps;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Deterministic preview gallery (spec §3): vendored template so agents never
// hand-write it. Self-contained, no framework; brand color drives the accents.
export function galleryHtml(outputs, { title = 'Story video', color = '#3b82f6' } = {}) {
  const cards = outputs.map(({ file, platform }) => {
    const s = PLATFORM_SPECS[platform];
    return `  <figure>\n    <video controls preload="metadata" src="${escapeHtml(file)}"></video>\n`
      + `    <figcaption>${escapeHtml(s ? s.label : platform)}${s ? ` · ${s.w}×${s.h}` : ''}</figcaption>\n  </figure>`;
  }).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">\n`
    + `<title>${escapeHtml(title)}</title>\n`
    + `<style>body{font-family:system-ui,sans-serif;margin:2rem;background:#111;color:#eee}`
    + `h1{border-bottom:3px solid ${escapeHtml(color)};padding-bottom:.5rem}`
    + `main{display:flex;flex-wrap:wrap;gap:1.5rem}figure{margin:0}`
    + `video{max-height:70vh;max-width:90vw;border:1px solid #333;border-radius:8px}`
    + `figcaption{margin-top:.5rem;font-size:.85rem;color:${escapeHtml(color)}}</style></head>\n`
    + `<body><h1>${escapeHtml(title)}</h1>\n<main>\n${cards}\n</main></body></html>\n`;
}

// argv (after the subcommand-bearing slice) -> a structured compose request.
const COMPOSE_CMDS = new Set(['slideshow', 'stitch', 'overlay-text', 'render-platforms', 'story', 'gallery']);
export function parseComposeArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!COMPOSE_CMDS.has(cmd)) return { error: `unknown subcommand "${cmd || ''}" (slideshow|stitch|overlay-text|render-platforms|story|gallery)` };
  const inputs = []; const opts = { audio: '', platform: '', platforms: [], text: '', color: '', title: '', secsPerImage: 3 };
  let out = '';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--out') out = rest[++i] || '';
    else if (a === '--audio') opts.audio = rest[++i] || '';
    else if (a === '--platform') opts.platform = rest[++i] || '';
    else if (a === '--platforms') opts.platforms = String(rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--text') opts.text = rest[++i] || '';
    else if (a === '--color') opts.color = rest[++i] || '';
    else if (a === '--title') opts.title = rest[++i] || '';
    else if (a === '--secs-per-image') opts.secsPerImage = Math.max(1, Math.min(10, Number(rest[++i]) || 3));
    else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else inputs.push(a);
  }
  if (!inputs.length) return { error: 'no input files given' };
  if (!out) return { error: '--out is required' };
  return { cmd, inputs, out, opts };
}
```

Note: `parseComposeArgs` returns `opts` with ALL keys present (the test asserts the full object) — keep the defaults exactly as shown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ralph/social-formats.test.mjs`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add ralph/social-formats.mjs ralph/social-formats.test.mjs
git commit -m "feat(ralph): social-formats — platform specs + pure ffmpeg arg builders"
```

---

### Task 2: `bumpBytes` in media-runtime + `ralph/compose-media.mjs` CLI

**Files:**
- Modify: `ralph/media-runtime.mjs` (add `bumpBytes`)
- Modify: `ralph/media-runtime.test.mjs` (one test)
- Create: `ralph/compose-media.mjs`

**Interfaces:**
- Consumes: everything from Task 1; `readCounts/bumpCount/writeStub` from `media-runtime.mjs`.
- Produces: `$RALPH_COMPOSE <subcommand> ...` CLI (Task 4 injects the path; Task 6's skill documents usage). Env contract: `RALPH_MEDIA_COUNT_DIR` (shared counter dir), `RALPH_COMPOSE_CAP` (default 12), `RALPH_COMPOSE_MB` (default 200), `RALPH_FORCE_TOOL` (stub). Count file gains `compose` and `composeBytes` keys (spread-preserved by `readCounts`; no schema change needed).
- Produces: `bumpBytes(dir, kind, n) -> total` in media-runtime.

- [ ] **Step 1: Write the failing test (media-runtime addition)**

Append to `ralph/media-runtime.test.mjs` (match its existing temp-dir style — read the file first and reuse its tmpdir helper):

```js
test('bumpBytes accumulates a byte counter alongside kind counts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mrt-'));
  assert.equal(await bumpBytes(dir, 'composeBytes', 1000), 1000);
  assert.equal(await bumpBytes(dir, 'composeBytes', 500), 1500);
  const counts = await readCounts(dir);
  assert.equal(counts.composeBytes, 1500);
  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test ralph/media-runtime.test.mjs`
Expected: FAIL — `bumpBytes is not defined` (also add it to the test file's import list).

- [ ] **Step 3: Implement `bumpBytes` in `ralph/media-runtime.mjs`**

```js
// Accumulate an arbitrary numeric counter (e.g. composeBytes) in the shared count file.
export async function bumpBytes(dir, key, n) {
  const c = await readCounts(dir);
  c[key] = (Number(c[key]) || 0) + (Number(n) || 0);
  await fs.mkdir(path.join(dir, '.ralph'), { recursive: true });
  await fs.writeFile(path.join(dir, COUNT_FILE), JSON.stringify(c));
  return c[key];
}
```

Run: `node --test ralph/media-runtime.test.mjs` → PASS.

- [ ] **Step 4: Write the compose CLI**

```js
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
import { promises as fs } from 'node:fs';
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
  for (const s of steps) await execStep(s.args, s.out);
  for (const r of renders) { await verify(r.out, PLATFORM_SPECS[platformForFile(r.out)], { wantAudio: !!parsed.board.audio }); await record(r.out); }
  await fs.rm('.ralph/compose-tmp', { recursive: true, force: true });
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
```


- [ ] **Step 5: Syntax-check + live smoke (free — local ffmpeg)**

```bash
node --check ralph/compose-media.mjs ralph/media-runtime.mjs
cd /tmp && mkdir -p compose-smoke && cd compose-smoke
convert -size 800x600 gradient:blue-red a.png && convert -size 800x600 gradient:green-yellow b.png
RALPH_MEDIA_COUNT_DIR=. node /var/www/tmux.tayyabcheema.com/ralph/compose-media.mjs slideshow a.png b.png --out slide.mp4 --platform tiktok --secs-per-image 1
ffprobe -v error -show_entries stream=width,height slide.mp4   # expect 1080 / 1920
RALPH_MEDIA_COUNT_DIR=. node /var/www/tmux.tayyabcheema.com/ralph/compose-media.mjs overlay-text slide.mp4 --text "Hello: 100% test" --out slide2.mp4 --platform tiktok
RALPH_MEDIA_COUNT_DIR=. node /var/www/tmux.tayyabcheema.com/ralph/compose-media.mjs render-platforms slide2.mp4 --out story --platforms tiktok,youtube
# one-shot recipe + gallery (story/gallery need media-validate's platformForFile — all in social-formats, fine)
cat > sb.json <<'EOF'
{"title":"Smoke","scenes":[{"image":"a.png","seconds":1},{"image":"b.png","seconds":1}],"text":{"content":"Hello"}}
EOF
mkdir -p output
RALPH_MEDIA_COUNT_DIR=. node /var/www/tmux.tayyabcheema.com/ralph/compose-media.mjs story sb.json --out output/story --platforms tiktok,youtube
RALPH_MEDIA_COUNT_DIR=. node /var/www/tmux.tayyabcheema.com/ralph/compose-media.mjs gallery output --out index.html --title "Smoke"
grep -q '<video' index.html && echo "gallery OK"
cat .ralph/media-count.json   # expect compose: 6 and a composeBytes total
```

Expected: four mp4s exist, dimensions match specs, no non-zero exits. Clean up `/tmp/compose-smoke` after.

- [ ] **Step 6: Commit**

```bash
git add ralph/compose-media.mjs ralph/media-runtime.mjs ralph/media-runtime.test.mjs
git commit -m "feat(ralph): compose-media CLI — slideshow/stitch/overlay-text/render-platforms via local ffmpeg"
```

---

### Task 3: `ralph/media-validate.mjs` — pure output verification report

**Files:**
- Create: `ralph/media-validate.mjs`
- Test: `ralph/media-validate.test.mjs`

**Interfaces:**
- Consumes: `PLATFORM_SPECS`, `checkOutput`, `platformForFile` from Task 1.
- Produces (Task 5 orchestrator + both UIs rely on this exact shape):
  - `platformForFile` (re-exported from social-formats for report consumers)
  - `mediaOutputReport(files, requestedPlatforms) -> {ok, outputs:[{file, platform, ok, issues}], missing:[platformId], warnings:[]}`
    where `files = [{file, probe}]` (probe = `parseProbe` result or null).

- [ ] **Step 1: Write the failing test**

```js
// ralph/media-validate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformForFile, mediaOutputReport } from './media-validate.mjs';

const good = (w, h) => ({ width: w, height: h, duration: 29, hasAudio: true });

test('platformForFile matches the -<platform>.mp4 suffix', () => {
  assert.equal(platformForFile('story-tiktok.mp4'), 'tiktok');
  assert.equal(platformForFile('output/promo-instagram-reel.mp4'), 'instagram-reel');
  assert.equal(platformForFile('story.mp4'), null);
  assert.equal(platformForFile('notes.txt'), null);
});

test('report: all requested platforms present and valid -> ok', () => {
  const r = mediaOutputReport(
    [{ file: 'output/s-tiktok.mp4', probe: good(1080, 1920) },
     { file: 'output/s-youtube.mp4', probe: good(1920, 1080) }],
    ['tiktok', 'youtube']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.outputs.length, 2);
  assert.ok(r.outputs.every((o) => o.ok));
});

test('report: wrong dimensions + missing platform -> not ok', () => {
  const r = mediaOutputReport(
    [{ file: 'output/s-tiktok.mp4', probe: good(720, 1280) }],
    ['tiktok', 'youtube-short']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['youtube-short']);
  assert.equal(r.outputs[0].ok, false);
  assert.ok(r.outputs[0].issues[0].includes('720x1280'));
});

test('report: unknown-platform files become warnings, not failures', () => {
  const r = mediaOutputReport([{ file: 'output/master.mp4', probe: good(1080, 1920) }], ['tiktok']);
  assert.deepEqual(r.missing, ['tiktok']);
  assert.ok(r.warnings.some((w) => w.includes('master.mp4')));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test ralph/media-validate.test.mjs` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
// ralph/media-validate.mjs
// Pure verdict logic for the finished-build media output report (run.mediaReport).
// The orchestrator gathers ffprobe results; this decides per-file pass/fail against
// PLATFORM_SPECS and which requested platforms have no render. Advisory only.
import { PLATFORM_SPECS, checkOutput, platformForFile } from './social-formats.mjs';
export { platformForFile };

export function mediaOutputReport(files, requestedPlatforms) {
  const outputs = []; const warnings = []; const seen = new Set();
  for (const { file, probe } of Array.isArray(files) ? files : []) {
    const platform = platformForFile(file);
    if (!platform) { warnings.push(`${file} does not match a platform render name (*-<platform>.mp4)`); continue; }
    const issues = checkOutput(probe, PLATFORM_SPECS[platform]);
    outputs.push({ file, platform, ok: issues.length === 0, issues });
    seen.add(platform);
  }
  const missing = (Array.isArray(requestedPlatforms) ? requestedPlatforms : []).filter((p) => !seen.has(p));
  return { ok: missing.length === 0 && outputs.every((o) => o.ok), outputs, missing, warnings };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test ralph/media-validate.test.mjs` → PASS. Also run the full suite: `node --test ralph/*.test.mjs` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add ralph/media-validate.mjs ralph/media-validate.test.mjs
git commit -m "feat(ralph): media-validate — pure per-platform output verification report"
```

---

### Task 4: providers.mjs — media model choices, normalizers, format media defaults

**Files:**
- Modify: `ralph/providers.mjs` (after the `MEDIA_PROVIDERS` block, ~line 103)
- Test: `ralph/providers.test.mjs` (append; the file exists — match its import style)

**Interfaces:**
- Consumes: existing `TOKEN_PLAN_IMAGE_MODELS`, `mediaCapDefaults`, `normalizeMedia`, `clampCap` (module-local — reuse the pattern, don't export it).
- Produces (Tasks 5, 7, 8 rely on these):
  - `MEDIA_MODEL_CHOICES: {image|video|music|voiceover: [{provider, id, label}]}`
  - `mediaModelChoices() -> deep-copied map` (for `/api/keys`)
  - `normalizeMediaModels(input) -> {kind: {provider, model}}` (only entries matching a choice survive; empty object = all-auto)
  - `withFormatMediaDefaults(media, outputFormat) -> media` (new object; `social-video` enables video≥2 + audio≥2, image≥8)

- [ ] **Step 1: Write the failing tests** (append to `ralph/providers.test.mjs`)

```js
test('normalizeMediaModels keeps only known provider/model pairs', () => {
  const picked = normalizeMediaModels({
    image: { provider: 'grok', model: 'grok-imagine-image' },
    video: { provider: 'ark', model: 'not-a-model' },
    music: 'garbage',
    bogusKind: { provider: 'suno', model: 'V4_5' },
  });
  assert.deepEqual(picked, { image: { provider: 'grok', model: 'grok-imagine-image' } });
  assert.deepEqual(normalizeMediaModels(null), {});
});

test('mediaModelChoices covers all four kinds and copies safely', () => {
  const c = mediaModelChoices();
  for (const k of ['image', 'video', 'music', 'voiceover']) assert.ok(c[k].length > 0);
  c.image.push({ provider: 'x' });
  assert.notEqual(c.image.length, mediaModelChoices().image.length);
});

test('withFormatMediaDefaults: social-video turns video+audio on', () => {
  const m = withFormatMediaDefaults(mediaCapDefaults(), 'social-video');
  assert.equal(m.video.enabled, true);
  assert.ok(m.video.cap >= 2);
  assert.equal(m.audio.enabled, true);
  assert.ok(m.image.cap >= 8);
  // other formats untouched
  assert.equal(withFormatMediaDefaults(mediaCapDefaults(), 'web-app').video.enabled, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test ralph/providers.test.mjs` → FAIL (not exported).

- [ ] **Step 3: Implement in `ralph/providers.mjs`** (insert after `mediaCredentialIds`)

```js
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
```

Add the new names to the test file's import from `./providers.mjs`.

- [ ] **Step 4: Run tests**

Run: `node --test ralph/providers.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ralph/providers.mjs ralph/providers.test.mjs
git commit -m "feat(ralph): media model registry + normalizer + social-video media defaults"
```

---

### Task 5: server wiring — format registration, env injection, run fields, verification

**Files:**
- Modify: `server/skills.mjs:77-84` (OUTPUT_FORMATS + OUTPUT_SKILL)
- Modify: `server/agents.mjs` (media env block, ~lines 19-24 and 330-372)
- Modify: `server/ralph-engine.mjs` (VISUAL_OUTPUT ~467, writeRalphBrief, startRalphRun ~1470, run object ~1497, runSummary ~301, startRunFromRequest ~1649, finalize reap ~1322, new `checkMediaOutputs` next to `checkPwaCompliance` ~732)
- Modify: `ralph/drafts.mjs` (round-trip `platforms` + `mediaModels`)

No unit tests for `server/` (side-effectful); the pure logic all landed in Tasks 1–4. Verification here = `node --check` + boot smoke + the Task 9 stub e2e.

- [ ] **Step 1: Register the format** (`server/skills.mjs`)

In `OUTPUT_FORMATS` insert `'social-video'` after `'flutter-app'`:

```js
export const OUTPUT_FORMATS = ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'];
```

In `OUTPUT_SKILL` add:

```js
'social-video': 'social-video',
```

- [ ] **Step 2: Env injection** (`server/agents.mjs`)

Near the other helper paths (~line 24) add:

```js
const RALPH_COMPOSE_HELPER = path.join(RALPH_DIR, 'compose-media.mjs');
```

Inside the `if (run && run.media) {` block, right after the `RALPH_GEN_*` push (~line 337), add:

```js
    // Social-video: the local composition helper + its count/size bounds (free CPU,
    // so bounded by outputs not spend) + the platform render list for the brief/skill.
    if (run.outputFormat === 'social-video') {
      envs.push(`RALPH_COMPOSE=${RALPH_COMPOSE_HELPER}`,
                `RALPH_COMPOSE_CAP=${Number(process.env.WEBTMUX_COMPOSE_CAP) || 12}`,
                `RALPH_COMPOSE_MB=${Number(process.env.WEBTMUX_COMPOSE_MB) || 200}`);
      if (run.platforms?.length) envs.push(`RALPH_PLATFORMS=${run.platforms.join(',')}`);
    }
```

Wire the per-build model picks into the existing selection. Change the `prefer` helper (~line 347) to consult `run.mediaModels` first:

```js
    const mm = run.mediaModels || {};
    const prefer = (kind) => String(mm[kind]?.provider || getSecrets()[`${kind}Provider`] || process.env[`WEBTMUX_${kind.toUpperCase()}_PROVIDER`] || '').toLowerCase();
```

Then thread the picked model ids through each kind (note `prefer('voice')` stays as-is for the secrets path, but the picker kind is `voiceover` — map it):

```js
    // image
    if (m.image.enabled) {
      const useGrok = prefer('image') === 'grok' ? !!grokTok : (!imgKey && !!grokTok);
      if (useGrok) envs.push('RALPH_IMAGE_PROVIDER=grok', `RALPH_IMAGE_KEY=${shq(grokTok)}`,
                             ...(mm.image?.provider === 'grok' && mm.image.model ? [`RALPH_IMAGE_MODEL=${shq(mm.image.model)}`] : []));
      else if (imgKey) envs.push(`RALPH_IMAGE_KEY=${shq(imgKey)}`, `RALPH_IMAGE_BASE=${shq(qwenBaseUrl())}`,
                                 `RALPH_IMAGE_MODEL=${shq(mm.image?.provider === 'tokenplan' && mm.image.model ? mm.image.model : qwenImageModel())}`);
    }
    // video (replaces the existing block at server/agents.mjs:356-361)
    if (m.video.enabled) {
      const k = get('ark') || get('glm') || arkKey();
      const useGrok = prefer('video') === 'grok' ? !!grokTok : (!k && !!grokTok);
      if (useGrok) envs.push('RALPH_VIDEO_PROVIDER=grok', `RALPH_VIDEO_KEY=${shq(grokTok)}`,
                             ...(mm.video?.provider === 'grok' && mm.video.model ? [`RALPH_VIDEO_MODEL=${shq(mm.video.model)}`] : []));
      else if (k) envs.push(`RALPH_VIDEO_KEY=${shq(k)}`, `RALPH_VIDEO_BASE=${shq(arkBaseUrl())}`,
                            ...(mm.video?.provider === 'ark' && mm.video.model ? [`RALPH_VIDEO_MODEL=${shq(mm.video.model)}`] : []));
    }
    // audio (replaces the existing block at server/agents.mjs:363-371). Note the kind
    // naming seam: the picker kinds are `music`/`voiceover`; the legacy secrets pref
    // key for voiceover is `voice` — the mm check ORs in front of prefer('voice').
    if (m.audio.enabled) {
      const sk = get('suno') || sunoKey();
      if (sk) envs.push(`RALPH_MUSIC_KEY=${shq(sk)}`, `RALPH_MUSIC_BASE=${shq(sunoBaseUrl())}`,
                        ...(mm.music?.model ? [`RALPH_MUSIC_MODEL=${shq(mm.music.model)}`] : []));
      const vk = get('elevenlabs') || elevenLabsKey();
      const useGrokVoice = (mm.voiceover?.provider === 'grok' || prefer('voice') === 'grok') ? !!grokTok : (!vk && !!grokTok);
      if (useGrokVoice) envs.push('RALPH_VOICE_PROVIDER=grok', `RALPH_VOICE_KEY=${shq(grokTok)}`);
      else if (vk) envs.push(`RALPH_VOICE_KEY=${shq(vk)}`, `RALPH_VOICE_ID=${shq(elevenLabsVoice())}`,
                             ...(mm.voiceover?.provider === 'elevenlabs' && mm.voiceover.model ? [`RALPH_VOICE_MODEL=${shq(mm.voiceover.model)}`] : []));
    }
```

The gen helpers already read `RALPH_VIDEO_MODEL` / `RALPH_MUSIC_MODEL` / `RALPH_VOICE_MODEL` (`ralph/gen-video.mjs:30`, `gen-audio.mjs:51,62`), so ONLY these env pushes change — no helper edits.

- [ ] **Step 3: Orchestrator run fields + verification** (`server/ralph-engine.mjs`)

Imports (top of file, extend existing import lists):

```js
import { normalizeMedia, normalizeMediaModels, withFormatMediaDefaults } from '../ralph/providers.mjs';
import { normalizePlatforms, probeArgs, parseProbe } from '../ralph/social-formats.mjs';
import { mediaOutputReport } from '../ralph/media-validate.mjs';
```

`startRalphRun` signature (line ~1470): add `platforms = null, mediaModels = null` params; on the `run` object (after `media: runMedia,`) add:

```js
    platforms: run.outputFormat === 'social-video' ? normalizePlatforms(platforms) : null,
    mediaModels: normalizeMediaModels(mediaModels),
```

Careful: `run` isn't defined yet at that point — compute `const fmt = prd.outputFormat || 'auto';` above the object literal and use `fmt === 'social-video'`.

`startRunFromRequest` (~line 1649): after the `media` line, add parsing + format defaults:

```js
  const media = body?.media ? normalizeMedia(body.media)
    : withFormatMediaDefaults(mediaCapsEffective(), outputFormat);
  const platforms = Array.isArray(body?.platforms) ? body.platforms : null;
  const mediaModels = normalizeMediaModels(body?.mediaModels);
```

(replaces the existing `const media = normalizeMedia(body?.media || mediaCapsEffective());`) and pass `platforms, mediaModels` through the `startRalphRun({...})` call at ~line 1695.

`runSummary` (~line 301): add to the returned object:

```js
    platforms: run.platforms || null,
    mediaModels: run.mediaModels && Object.keys(run.mediaModels).length ? run.mediaModels : null,
    mediaReport: run.mediaReport || null, // social-video: per-platform verification (advisory)
```

`writeRalphBrief` (~line 467): add `'social-video'` to the local `VISUAL_OUTPUT` set. Add a `platforms = null` option param, and after the media-budget paragraph add:

```js
  if (outputFormat === 'social-video') {
    const list = (platforms?.length ? platforms : []).join(', ') || 'tiktok, instagram-reel, youtube-short';
    parts.push(`## Social video target\nThe deliverable is a ~30-second story video rendered for: ${list}.\n`
      + `Follow the social-video skill: storyboard first, generate scene assets, then ONE \`$RALPH_COMPOSE story storyboard.json\` call `
      + `renders every platform as output/<name>-<platform>.mp4, and \`$RALPH_COMPOSE gallery\` writes the preview page.`);
  }
```

Thread `platforms: run.platforms` into every `writeRalphBrief(...)` call site (grep `writeRalphBrief(` — worker spawn + finalize spawn).

New `checkMediaOutputs` (place directly under `checkPwaCompliance`, ~line 763):

```js
// Advisory social-video output verification (spec §7b). NON-BLOCKING, mirrors
// checkPwaCompliance: ffprobe every output/*.mp4, judge against PLATFORM_SPECS via
// the pure mediaOutputReport, record run.mediaReport for the UIs. Never fails a build.
async function checkMediaOutputs(run) {
  if (run.outputFormat !== 'social-video') return;
  const outDir = path.join(run.dir, 'output');
  let names = [];
  try { names = (await fs.readdir(outDir)).filter((f) => f.endsWith('.mp4')); } catch { /* none */ }
  const files = [];
  for (const f of names) {
    let probe = null;
    try { probe = parseProbe((await execFileAsync('ffprobe', probeArgs(path.join(outDir, f)), { timeout: 30_000 })).stdout); }
    catch { /* unreadable -> null probe = issue */ }
    files.push({ file: `output/${f}`, probe });
  }
  const report = mediaOutputReport(files, run.platforms || []);
  run.mediaReport = { ...report, at: Date.now() };
  if (report.ok) recordRunEvent(run, `🎬 Media outputs verified — ${report.outputs.length} platform render(s) OK`);
  else recordRunEvent(run, `⚠️ Media output check: ${[...report.missing.map((p) => `missing ${p}`), ...report.outputs.filter((o) => !o.ok).map((o) => `${o.file}: ${o.issues[0]}`)].join('; ')}`);
}
```

Call it next to the PWA check at the finalize-PASS reap (~line 1322):

```js
              await checkPwaCompliance(run).catch(() => {});
              await checkMediaOutputs(run).catch(() => {});
```

Stub note: under `RALPH_FORCE_TOOL` the stub worker writes no real mp4s, so the report will be `missing: [...]` — that is CORRECT advisory behaviour and what the Task 9 e2e asserts (report exists + machinery ran).

- [ ] **Step 4: Draft round-trip** (`ralph/drafts.mjs`)

`normalizeDraft` has two shapes (~lines 18-21 stored, ~68-70 outgoing — read the file to confirm). Add to both, next to `media`:

```js
    platforms: Array.isArray(d.platforms) ? d.platforms.map(String).slice(0, 8) : null,
    mediaModels: obj(d.mediaModels),
```

Also extend `ralph/drafts.test.mjs` with one assertion that a draft carrying `platforms: ['tiktok']` and `mediaModels: {image:{provider:'grok',model:'grok-imagine-image'}}` round-trips both. Run `node --test ralph/drafts.test.mjs`.

- [ ] **Step 5: Syntax check, restart, boot smoke**

```bash
node --check server.js server/*.mjs server/routes/*.mjs ralph/*.mjs
node --test ralph/*.test.mjs
systemctl restart webtmux && sleep 2 && journalctl -u webtmux -n 20 --no-pager   # no crash loop
curl -s http://127.0.0.1:8090/healthz
```

Expected: checks pass, service healthy.

- [ ] **Step 6: Commit**

```bash
git add server/skills.mjs server/agents.mjs server/ralph-engine.mjs ralph/drafts.mjs ralph/drafts.test.mjs
git commit -m "feat(ralph): social-video format — env injection, run fields, finalize output verification"
```

---

### Task 6: vendored skill + clarify axes

**Files:**
- Create: `ralph/skills/social-video/SKILL.md`
- Modify: `ralph/clarify-axes.mjs` (CONTENT_AXES)
- Modify: `ralph/clarify-axes.test.mjs` (one test)

- [ ] **Step 1: Clarify test first** (append to `ralph/clarify-axes.test.mjs`)

```js
test('social-video is content-heavy with platform + audio axes', () => {
  const { axes, cap, contentHeavy } = clarifyAxesFor('social-video');
  assert.equal(cap, 6);
  assert.equal(contentHeavy, true);
  assert.ok(axes.some((a) => a.includes('platform')));
  assert.ok(axes.some((a) => a.includes('voiceover')));
});
```

Run: `node --test ralph/clarify-axes.test.mjs` → FAIL.

- [ ] **Step 2: Add the axes** (`ralph/clarify-axes.mjs`, inside `CONTENT_AXES`)

```js
  'social-video': ['target platforms (TikTok / Instagram Reel & Feed / YouTube & Shorts / LinkedIn)', 'purpose — promo, brand story, or viral hook', 'voiceover, music, or both', 'opening hook + call-to-action text', 'brand identity and color palette', 'story length (default ~30 seconds)'],
```

Run: `node --test ralph/clarify-axes.test.mjs` → PASS.

- [ ] **Step 3: Write the skill** (`ralph/skills/social-video/SKILL.md`)

```markdown
---
name: social-video
description: Build a short (~30s) social story video and render it per platform (TikTok/Instagram/YouTube/LinkedIn dimensions) using the media helpers and $RALPH_COMPOSE.
---

# Social video deliverable

You are producing a short story video (default ~30 seconds) delivered as ONE file
per target platform, each at that platform's exact dimensions. The target platform
list is in `$RALPH_PLATFORMS` (comma-separated) and in your brief.

## Workflow (in this order)

1. **Storyboard first.** Write `STORYBOARD.md`: 4–8 scenes, each with a one-line
   visual description, on-screen text (if any), and seconds — total duration ≈ the
   target length. Commit it before generating anything.
2. **One style.** Define ONE project style descriptor (subject → setting → style →
   lighting → technical) and reuse it in EVERY generation prompt (imagery skill rule).
   Use `assets/brand/` colors/logo when present.
3. **Generate scene assets** with the media helpers (they enforce the build's budget;
   exit 3 = skipped → use a brand asset or stock instead, never block):
   - stills: `$RALPH_GEN_IMAGE "<style> — <scene>" scenes/s1.png`
   - motion moments (budget is small — use for 1–2 hero scenes only):
     `$RALPH_GEN_VIDEO "<style> — <scene>" scenes/s2.mp4 --duration 5 --ratio 9:16`
   - audio bed: `$RALPH_GEN_AUDIO "<mood, genre, instruments>" audio/bed.mp3 --type music --instrumental`
     and/or voiceover: `$RALPH_GEN_AUDIO "<script text>" audio/vo.mp3 --type voiceover`
     (voiceover = best pronunciation; write the script with plain spellings).
4. **Write `storyboard.json`** — the machine-readable version of your storyboard.
   This is your main creative artifact; the vendored pipeline executes it:

   ```json
   {
     "title": "Product promo",
     "platform": "tiktok",
     "audio": "audio/bed.mp3",
     "text": { "content": "Your hook line", "color": "#FF5500" },
     "scenes": [
       { "image": "scenes/s1.png", "seconds": 3 },
       { "clip":  "scenes/s2.mp4" },
       { "image": "scenes/s3.png", "seconds": 4 }
     ]
   }
   ```

   Scenes play in order (each needs an `image` or `clip` path; `seconds` 1–10 for
   stills). `audio` and `text` are optional; text is drawn inside the platform-safe
   bottom margin — keep it ≤ 8 words.
5. **Compose + render every platform in ONE call:**
   `$RALPH_COMPOSE story storyboard.json --out output/story --platforms $RALPH_PLATFORMS`
   → slideshow/stitch/audio/text/per-platform renders all happen internally, each
   output self-verified, written as `output/story-<platform>.mp4`. These names are
   REQUIRED — the build's verification report matches `*-<platform>.mp4`.
   To revise: edit `storyboard.json` (or regenerate one asset) and re-run the same
   command. Advanced/manual subcommands (`slideshow`, `stitch`, `overlay-text`,
   `render-platforms`) exist for cases the storyboard shape can't express.
6. **Preview gallery in ONE call:**
   `$RALPH_COMPOSE gallery output --out index.html --title "<project name>" --color '<brand hex>'`
   writes the repo-root gallery page (one player per platform render). Do not
   hand-write it. (The project's preview subdomain serves it.)
7. **Provenance.** Record every generated asset (helper, model if known, prompt) and
   every output file in `DELIVERABLE.md`.

## Rules

- Never run raw `ffmpeg` yourself — always `$RALPH_COMPOSE` (it enforces caps and
  verifies dimensions). If it exits 3 (cap reached), ship what exists and note it.
- Respect the media budget from your brief; prefer stills over video clips.
- Keep total scene text readable: ≤ 8 words per overlay.
- Commit generated assets and outputs (they are the deliverable).
```

- [ ] **Step 4: Verify the skill loads**

```bash
node --check ralph/clarify-axes.mjs
node -e "import('./server/skills.mjs').then(async (m) => { const c = await m.loadSkillsCatalog(); console.log(c.find((s) => s.id === 'social-video') ? 'skill loaded' : 'MISSING'); })"
```

Expected: `skill loaded`.

- [ ] **Step 5: Commit**

```bash
git add ralph/skills/social-video/SKILL.md ralph/clarify-axes.mjs ralph/clarify-axes.test.mjs
git commit -m "feat(ralph): social-video skill + format-aware clarify axes"
```

---

### Task 7: routes — expose model choices + accept the new start fields

**Files:**
- Modify: `server/routes/saas.mjs` (~line 113 `/api/keys` response)
- Modify: `server/routes/ralph.mjs` (verify pass-through only)

- [ ] **Step 1: `/api/keys` surfaces the picker data** (`server/routes/saas.mjs`)

Add `mediaModelChoices` to the existing `ralph/providers.mjs` import (line 17), and in the `/api/keys` response object (after `planModels:`):

```js
        mediaModels: mediaModelChoices(), // per-kind media model pickers (spec §6b)
```

- [ ] **Step 2: Confirm start body pass-through** (`server/routes/ralph.mjs`)

`POST /api/ralph/start` hands `req.body` to `startRunFromRequest` (Task 5 already parses `platforms`/`mediaModels` there). Read the route to confirm nothing whitelists body fields; if the route builds an explicit body object, add both fields to it. Same check for the drafts start path (`draftStartBody` in `server/ralph-engine.mjs` or `ralph/drafts.mjs` — grep `draftStartBody`) — add `platforms: d.platforms, mediaModels: d.mediaModels` so scheduled draft starts behave identically.

- [ ] **Step 3: Syntax check + restart + probe**

```bash
node --check server/routes/saas.mjs server/routes/ralph.mjs
systemctl restart webtmux && sleep 2
# multitenant: needs a wt_session cookie — verify via journalctl no-crash + the web UI in Task 8
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/saas.mjs server/routes/ralph.mjs server/ralph-engine.mjs ralph/drafts.mjs
git commit -m "feat(api): media model choices on /api/keys; platforms+mediaModels accepted on start"
```

---

### Task 8: `web/` UI — format, platform picker, media model pickers, verification card

**Files:**
- Modify: `web/src/pages/NewBuild.jsx` (FORMATS line 21; state ~line 43; plan/start/draft payloads ~lines 173-200; configure-step JSX ~line 281-330)
- Modify: `web/src/pages/BuildDetail.jsx` (finished-build section, near the `isDone` block ~line 339+)

- [ ] **Step 1: NewBuild — format + state**

```js
const FORMATS = ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'];
// Client-side mirror of ralph/social-formats.mjs PLATFORM_SPECS (same deliberate
// mirror pattern as RALPH_AGENTS) — server re-validates via normalizePlatforms.
const PLATFORMS = [
  { id: 'tiktok', label: 'TikTok 9:16' }, { id: 'instagram-reel', label: 'IG Reel 9:16' },
  { id: 'instagram-feed', label: 'IG Feed 4:5' }, { id: 'youtube-short', label: 'YT Short 9:16' },
  { id: 'youtube', label: 'YouTube 16:9' }, { id: 'linkedin', label: 'LinkedIn 16:9' },
];
```

State + data:

```js
const [platforms, setPlatforms] = useState(['tiktok', 'instagram-reel', 'youtube-short']);
const [mediaModels, setMediaModels] = useState({});          // {kind: {provider, model}} — absent = auto
const [mediaModelChoices, setMediaModelChoices] = useState(null); // from /api/keys
```

Where `api.keys()` is already consumed (defaultAgent seeding — find it in the component), also `setMediaModelChoices(d.mediaModels || null)`. When the format flips to `social-video`, seed the media toggles on:

```js
useEffect(() => {
  if (outputFormat === 'social-video') {
    setMedia((s) => ({ image: { ...s.image, enabled: true, cap: Math.max(s.image.cap, 8) },
                       video: { enabled: true, cap: Math.max(s.video.cap, 2) },
                       audio: { enabled: true, cap: Math.max(s.audio.cap, 2) } }));
  }
}, [outputFormat]);
```

- [ ] **Step 2: NewBuild — configure-step JSX** (below the existing "Media generation" block ~line 313)

```jsx
{outputFormat === 'social-video' && (
  <div>
    <label className="label">Target platforms</label>
    <div className="flex flex-wrap gap-2">
      {PLATFORMS.map((p) => (
        <label key={p.id} className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={platforms.includes(p.id)}
            onChange={(e) => setPlatforms((s) => e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id))} />
          {p.label}
        </label>
      ))}
    </div>
  </div>
)}
{mediaModelChoices && ['image', 'video', 'audio'].some((k) => media[k]?.enabled) && (
  <div>
    <label className="label">Media models <span className="opacity-60">(optional — auto picks per your keys)</span></label>
    <div className="grid grid-cols-2 gap-2">
      {Object.entries(mediaModelChoices).map(([kind, list]) => (
        <label key={kind} className="text-xs flex items-center gap-2">
          <span className="w-20 capitalize">{kind}</span>
          <select className="input !py-1 text-xs flex-1"
            value={mediaModels[kind] ? `${mediaModels[kind].provider}:${mediaModels[kind].model}` : ''}
            onChange={(e) => setMediaModels((s) => {
              const v = e.target.value;
              if (!v) { const { [kind]: _d, ...rest } = s; return rest; }
              const [provider, ...m] = v.split(':');
              return { ...s, [kind]: { provider, model: m.join(':') } };
            })}>
            <option value="">auto</option>
            {list.map((m) => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.label}</option>)}
          </select>
        </label>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 3: NewBuild — payloads**

Add to the `api.plan({...})` body: nothing (the planner doesn't need platforms). Add to the **start** body (~line 200 region) and the **draft** object (~line 186):

```js
platforms: outputFormat === 'social-video' ? platforms : undefined,
mediaModels: Object.keys(mediaModels).length ? mediaModels : undefined,
```

And when reopening a draft (~line 100 `if (d.media) setMedia(d.media);`):

```js
if (d.platforms) setPlatforms(d.platforms);
if (d.mediaModels) setMediaModels(d.mediaModels);
```

- [ ] **Step 4: BuildDetail — "Media outputs" verification card**

In the finished-build region (next to where `isDone` gates other cards — anchor at `web/src/pages/BuildDetail.jsx:339`), add:

```jsx
{run.mediaReport && (
  <div className="card">
    <div className="flex items-center justify-between">
      <h3 className="font-semibold">Media outputs {run.mediaReport.ok ? '✓' : '⚠'}</h3>
      {previewUrl && <a className="btn-ghost text-xs" href={previewUrl} target="_blank" rel="noreferrer">Preview gallery ↗</a>}
    </div>
    <table className="w-full text-xs mt-2">
      <tbody>
        {run.mediaReport.outputs.map((o) => (
          <tr key={o.file} className="border-t border-panel2">
            <td className="py-1">{o.platform}</td>
            <td className="py-1 opacity-70">{o.file}</td>
            <td className="py-1">{o.ok ? '✓ verified' : `⚠ ${o.issues.join('; ')}`}</td>
          </tr>
        ))}
        {run.mediaReport.missing.map((p) => (
          <tr key={p} className="border-t border-panel2">
            <td className="py-1">{p}</td><td className="py-1 opacity-70">—</td><td className="py-1">⚠ no render produced</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)}
```

`previewUrl` — reuse however BuildDetail already links the preview subdomain (grep `preview` in the file; if it composes `https://<project>...` inline, follow that exact pattern).

- [ ] **Step 5: Build + verify in the browser**

```bash
cd web && npm run build
```

Then with Playwright (or manually): open the app, New Build → pick `social-video` → confirm the platform checkboxes + model selects render; confirm a non-social format hides the platform picker.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/NewBuild.jsx web/src/pages/BuildDetail.jsx
git commit -m "feat(web): social-video format — platform picker, media model selects, output verification card"
```

---

### Task 9: PWA mirror + service-worker bump

**Files:**
- Modify: `public/js/dashboard/ralph.js` (line 64 fallback list; status dialog)
- Modify: `public/sw.js` (VERSION bump)

- [ ] **Step 1: Format fallback** (`public/js/dashboard/ralph.js:64`)

```js
let ralphOutputFormats = ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'];
```

(The list is server-refreshed at line 342, so this only covers the pre-plan default.)

- [ ] **Step 2: Status dialog media report line**

In the status dialog rendering (near the `isDoneWeb` block at line ~547 — read the surrounding function to match its DOM style), add after the deliverable/PWA lines:

```js
  if (s.mediaReport) {
    const mr = s.mediaReport;
    const line = mr.ok
      ? `🎬 Media outputs verified (${mr.outputs.length} platform renders)`
      : `⚠️ Media outputs: ${[...mr.missing.map((p) => `missing ${p}`), ...mr.outputs.filter((o) => !o.ok).map((o) => `${o.platform}: ${o.issues[0]}`)].join('; ')}`;
    // append `line` using the same element/append pattern the surrounding lines use
  }
```

(PWA stays read-only for model pickers/platforms — precedent: per-story media counts are editable in `web/` and read-only in the PWA confirm dialog.)

- [ ] **Step 3: Bump the service worker**

In `public/sw.js` increment `VERSION` (e.g. `webtmux-v44` → `webtmux-v45` — read the current value first).

- [ ] **Step 4: Syntax check + commit**

```bash
node --check public/js/dashboard.js public/js/dashboard/*.js
git add public/js/dashboard/ralph.js public/sw.js
git commit -m "feat(pwa): social-video in format list + media report in status dialog; sw bump"
```

---

### Task 10: no-spend stub e2e + docs

**Files:**
- Create: `docs/ops/social-video-stub-e2e.sh`
- Modify: `CLAUDE.md` (media section: one short paragraph on social-video + compose helper + mediaReport)

- [ ] **Step 1: Write the e2e script** (clone the flutter-stub-e2e skeleton — quoted at `docs/ops/flutter-stub-e2e.sh:1-30`; isolated port/data/projects + fake remote + `RALPH_FORCE_TOOL=stub`)

```bash
#!/bin/bash
# No-spend e2e for the social-video output format. Stubbed agents on an isolated
# instance. Verifies: run reaches done, run.mediaReport exists (stub outputs won't
# pass ffprobe — the report being present and honest IS the assertion), and the
# compose CLI itself works with REAL local ffmpeg (free) on a generated still.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8125}"
BASE="$(mktemp -d /tmp/socialvideo-stub-e2e.XXXXXX)"
trap 'kill -9 $SV 2>/dev/null; for s in $(tmux ls 2>/dev/null | grep -oE "^[a-z]+-svstub[^:]*"); do tmux kill-session -t "$s" 2>/dev/null; done; rm -rf "$BASE"' EXIT
mkdir -p "$BASE/data" "$BASE/projects"; git init --bare -q "$BASE/remote.git"
ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT " && { echo "port $PORT busy"; exit 1; }

# 1) Real-ffmpeg compose smoke (no server, no spend) — the one-shot recipe + gallery
cd "$BASE"
convert -size 800x600 gradient:blue-red a.png
echo '{"title":"E2E","scenes":[{"image":"a.png","seconds":1}],"text":{"content":"Hi"}}' > sb.json
mkdir -p output
RALPH_MEDIA_COUNT_DIR="$BASE" node "$REPO/ralph/compose-media.mjs" story sb.json --out output/story --platforms tiktok,youtube || { echo "FAIL compose story"; exit 1; }
ffprobe -v error -show_entries stream=width -of csv=p=0 output/story-youtube.mp4 | grep -q 1920 || { echo "FAIL youtube dims"; exit 1; }
RALPH_MEDIA_COUNT_DIR="$BASE" node "$REPO/ralph/compose-media.mjs" gallery output --out index.html --title E2E || { echo "FAIL gallery"; exit 1; }
grep -q '<video' index.html || { echo "FAIL gallery html"; exit 1; }
echo "compose smoke OK"

# 2) Orchestrator e2e with stubs
export WEBTMUX_PORT=$PORT WEBTMUX_DATA="$BASE/data" WEBTMUX_PROJECTS_ROOT="$BASE/projects"
export RALPH_FORCE_TOOL=stub RALPH_FAKE_REMOTE="$BASE/remote.git"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@local GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@local
( cd "$REPO" && node server.js > "$BASE/server.log" 2>&1 ) & SV=$!
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

curl -s -X POST "http://127.0.0.1:$PORT/api/ralph/start" -H 'Content-Type: application/json' -d '{
  "project":"svstub","idea":"a 30s promo story video","master":"claude","workers":[],
  "outputFormat":"social-video","bypass":true,
  "platforms":["tiktok","youtube-short"],
  "mediaModels":{"image":{"provider":"grok","model":"grok-imagine-image"}},
  "prd":{"project":"svstub","description":"promo","outputFormat":"social-video",
    "stories":[{"id":"s1","title":"story video","description":"storyboard, assets, compose","acceptanceCriteria":["renders per platform"],"assignee":"claude","outputType":"social-video","deps":[]}]}}' >/dev/null

for i in $(seq 1 60); do
  p=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=svstub" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).phase)}catch{console.log("?")}})')
  [ "$p" = done ] && break; [ "$p" = failed ] && { echo "FAIL run failed"; tail -40 "$BASE/server.log"; exit 1; }
  sleep 2
done
[ "$p" = done ] || { echo "FAIL not done (phase=$p)"; exit 1; }

st=$(curl -s "http://127.0.0.1:$PORT/api/ralph/status?project=svstub")
echo "$st" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
  if(!j.mediaReport){console.error("FAIL no mediaReport");process.exit(1)}
  if(!Array.isArray(j.platforms)||j.platforms[0]!=="tiktok"){console.error("FAIL platforms lost");process.exit(1)}
  if(!j.mediaModels||!j.mediaModels.image){console.error("FAIL mediaModels lost");process.exit(1)}
  console.log("mediaReport present, missing:",j.mediaReport.missing.join(","))})' || exit 1
echo "PASS social-video stub e2e"
```

- [ ] **Step 2: Run it**

```bash
bash docs/ops/social-video-stub-e2e.sh
```

Expected: `compose smoke OK` then `PASS social-video stub e2e`. Afterwards confirm no leftover `r-/rv-/rf-/app-` tmux sessions or listeners on 8125 (the stub e2e scripts are known to leak servers when piped — kill by hand if needed).

- [ ] **Step 3: Update CLAUDE.md** — in the "Media generation" section add a short paragraph:

```markdown
**Social-video output format (Phase 1).** `social-video` ∈ `OUTPUT_FORMATS`: a ~30s story
video rendered per platform. Pure specs/arg-builders/storyboard recipe in `ralph/social-formats.mjs`
(tested), local composition CLI `ralph/compose-media.mjs` (`$RALPH_COMPOSE`, ffmpeg — free, bounded
by RALPH_COMPOSE_CAP/MB not spend; agents write a declarative `storyboard.json` and call the `story`
one-shot + `gallery` for the preview page — never raw ffmpeg), skill `ralph/skills/social-video/SKILL.md`, verification
`ralph/media-validate.mjs` → `run.mediaReport` (advisory, checkPwaCompliance pattern). Per-build
`platforms` + `mediaModels` (pickers in web/ NewBuild; `normalizeMediaModels` gates; env
overrides ride the existing RALPH_*_MODEL vars). Outputs `output/<name>-<platform>.mp4` + a
root index.html gallery on the preview subdomain. No-spend e2e: `bash docs/ops/social-video-stub-e2e.sh`.
```

- [ ] **Step 4: Final full verification + commit**

```bash
node --check server.js server/*.mjs server/routes/*.mjs ralph/*.mjs public/js/dashboard.js public/js/dashboard/*.js
node --test ralph/*.test.mjs
bash -n ralph/*.sh docs/ops/social-video-stub-e2e.sh
git add docs/ops/social-video-stub-e2e.sh CLAUDE.md
git commit -m "test(ralph): social-video no-spend stub e2e + docs"
```

---

## Deferred (do NOT build in this plan)

- Phase 2 `music-track` (+ `remove-vocals`/`vocalRemovalArgs`), Phase 3 `image-set` — separate plans.
- Drive share for big outputs (`webtmux-artifact-share` allowlist `.mp4/.mp3/...`) — outputs are committed to the repo in Phase 1; revisit if repos bloat.
- PWA-side model pickers/platform picker (web/-first, PWA read-only — existing precedent).
- Live real-key run (one paid social-video build) — post-deploy smoke, like flutter's.
