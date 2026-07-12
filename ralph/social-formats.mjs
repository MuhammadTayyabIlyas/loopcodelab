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

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
// Intermediates get re-encoded again downstream — fastest preset, higher quality floor.
const X264_FAST = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
// Cover-fit a stream to the spec canvas (fill + center-crop) — for stills.
const coverFit = (spec) => `scale=${spec.w}:${spec.h}:force_original_aspect_ratio=increase,crop=${spec.w}:${spec.h},setsar=1`;
// Contain-fit (letterbox/pillarbox) — for clips whose framing must survive.
const containFit = (spec) => `scale=${spec.w}:${spec.h}:force_original_aspect_ratio=decrease,pad=${spec.w}:${spec.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

// images + one audio bed -> a slideshow video with a gentle Ken Burns push-in.
// text (optional {text,color}) is burned in the same pass — no separate overlay encode.
// secs (optional array, one entry per image) overrides the uniform secsPerImage.
export function slideshowArgs(images, audio, out, spec, { secsPerImage = 3, secs = null, text = null } = {}) {
  const perImage = (Array.isArray(secs) && secs.length === images.length) ? secs : images.map(() => secsPerImage);
  const args = ['-y'];
  // Each image is a SINGLE input frame — zoompan's d= expands it to the scene length.
  // Never -loop/-t here: zoompan multiplies EVERY input frame by d, so a looped input
  // made 60x-too-long scenes (the bug behind minutes-long "3 second" renders).
  for (const img of images) args.push('-i', img);
  if (audio) args.push('-i', audio);
  const chains = images.map((_, i) =>
    `[${i}:v]${coverFit(spec)},zoompan=z='min(zoom+0.0008,1.08)':d=${Math.round(perImage[i] * spec.fps)}:s=${spec.w}x${spec.h}:fps=${spec.fps}[v${i}]`);
  const concat = `${images.map((_, i) => `[v${i}]`).join('')}concat=n=${images.length}:v=1:a=0`;
  const fc = `${chains.join(';')};${concat}` + (text ? `[vc];[vc]${drawTextExpr(text)}[v]` : '[v]');
  args.push('-filter_complex', fc, '-map', '[v]');
  if (audio) args.push('-map', `${images.length}:a`, '-c:a', 'aac', '-shortest');
  args.push('-r', String(spec.fps), ...X264_FAST, out);
  return args;
}

// Normalize N clips/stills-as-video to one canvas and concat their VIDEO streams.
// Audio deliberately stays out (mixed/missing audio tracks make concat brittle);
// lay the bed/voiceover over the result with `slideshow` or a later overlay pass.
export function stitchArgs(clips, out, spec, { text = null } = {}) {
  const args = ['-y'];
  for (const c of clips) args.push('-i', c);
  const chains = clips.map((_, i) => `[${i}:v]${containFit(spec)},fps=${spec.fps}[v${i}]`);
  const concat = `${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0`;
  const fc = `${chains.join(';')};${concat}` + (text ? `[vc];[vc]${drawTextExpr(text)}[v]` : '[v]');
  args.push('-filter_complex', fc, '-map', '[v]', ...X264_FAST, out);
  return args;
}

// The hook/CTA drawtext expression: bottom-centered inside a ~8% safe margin, translucent box.
// color is allowlist-sanitized — a stray ffmpeg metachar would break the whole filter graph.
function drawTextExpr({ text, color = 'white', box = true } = {}) {
  color = String(color).replace(/[^#a-zA-Z0-9@.]/g, '') || 'white';
  return `drawtext=text='${escapeDrawText(text)}':fontcolor=${color}`
    + `:fontsize=h/14:x=(w-text_w)/2:y=h-text_h-h*0.08`
    + (box ? ':box=1:boxcolor=black@0.4:boxborderw=18' : '');
}

// Burn a hook/CTA line as a standalone pass (the `overlay-text` subcommand).
// The storyboard flow folds the same expression into slideshow/stitch instead.
export function drawTextArgs(input, out, opts, spec) {
  return ['-y', '-i', input, '-vf', drawTextExpr(opts), '-c:a', 'copy', ...X264_FAST, out];
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
    // agents often write audio as a rich object ({type, description, path}); take its path
    audio: typeof b.audio === 'string' ? b.audio
      : (b.audio && typeof b.audio === 'object') ? String(b.audio.path || b.audio.file || '') : '',
    text, scenes: clean,
  } };
}

// The reusable recipe: expand a board into the ordered ffmpeg step list the compose
// CLI executes. Pure — intermediates live under .ralph/compose-tmp/. Stills-only
// boards go straight through slideshow (audio + text burned in the same pass);
// mixed boards render each still to a scene clip, stitch (video-only, text burned
// there), then mux the audio bed. A platform matching the master's canvas within
// its duration cap gets a stream-copy remux instead of a fourth encode pass.
export function storyboardSteps(board, platforms, outBase) {
  const spec = PLATFORM_SPECS[board.platform];
  const tmp = (n) => `.ralph/compose-tmp/${n}`;
  const steps = [];
  const text = board.text ? { text: board.text.content, color: board.text.color } : null;
  const allStills = board.scenes.every((s) => s.image);
  let master;
  let masterSeconds = Infinity; // unknown for clip-bearing boards — they never stream-copy
  if (allStills) {
    const secs = board.scenes.map((s) => s.seconds);
    masterSeconds = secs.reduce((a, b) => a + b, 0);
    master = tmp('master.mp4');
    steps.push({ kind: 'slideshow', out: master,
      args: slideshowArgs(board.scenes.map((s) => s.image), board.audio, master, spec, { secs, text }) });
  } else {
    const clips = board.scenes.map((s, i) => {
      if (s.clip) return s.clip;
      const out = tmp(`scene${i}.mp4`);
      steps.push({ kind: 'scene', out, args: slideshowArgs([s.image], '', out, spec, { secsPerImage: s.seconds }) });
      return out;
    });
    master = tmp('stitched.mp4');
    steps.push({ kind: 'stitch', out: master, args: stitchArgs(clips, master, spec, { text }) });
    if (board.audio) {
      const muxed = tmp('master.mp4');
      steps.push({ kind: 'mux', out: muxed, args: muxAudioArgs(master, board.audio, muxed) });
      master = muxed;
    }
  }
  for (const p of platforms) {
    const out = `${outBase}-${p}.mp4`;
    const ps = PLATFORM_SPECS[p];
    const copyOk = ps.w === spec.w && ps.h === spec.h && ps.fps === spec.fps && masterSeconds <= ps.maxSeconds;
    steps.push({ kind: 'render', out, args: copyOk
      ? ['-y', '-i', master, '-c', 'copy', '-movflags', '+faststart', out]
      : renderPlatformArgs(master, out, ps) });
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
