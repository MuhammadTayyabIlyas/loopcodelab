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
  assert.equal(args.filter((a) => a === '-loop').length, 0); // single frame in; zoompan d= owns duration
  assert.ok(args.includes('a.png') && args.includes('bed.mp3') && args.at(-1) === 'out.mp4');
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('concat=n=2:v=1:a=0'));
  assert.ok(fc.includes(`s=${spec.w}x${spec.h}`)); // zoompan renders at spec size
  assert.ok(args.includes('libx264') && args.includes('-shortest'));
  assert.ok(args.includes('ultrafast')); // intermediate pass: fastest preset
});

test('slideshowArgs: per-image secs array + burned-in text in one pass', () => {
  const spec = PLATFORM_SPECS.tiktok;
  const args = slideshowArgs(['a.png', 'b.png'], '', 'out.mp4', spec, { secs: [2, 5], text: { text: 'Hook', color: 'white' } });
  assert.ok(!args.includes('-t') && !args.includes('-loop')); // duration lives in zoompan d=
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes(`d=${Math.round(2 * spec.fps)}`) && fc.includes(`d=${Math.round(5 * spec.fps)}`));
  assert.ok(fc.includes('drawtext=') && fc.includes('Hook'));
});

test('stitchArgs: normalizes every clip to spec then concats video-only', () => {
  const spec = PLATFORM_SPECS.youtube;
  const args = stitchArgs(['c1.mp4', 'c2.mp4', 'c3.mp4'], 'out.mp4', spec);
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('concat=n=3:v=1:a=0'));
  assert.ok(fc.includes(`scale=${spec.w}:${spec.h}:force_original_aspect_ratio=decrease`));
  assert.equal(args.filter((a) => a === '-i').length, 3);
  assert.ok(args.includes('ultrafast')); // intermediate pass: fastest preset
  const withText = stitchArgs(['c1.mp4'], 'out.mp4', spec, { text: { text: 'CTA' } });
  assert.ok(withText[withText.indexOf('-filter_complex') + 1].includes('drawtext='));
});

test('drawTextArgs: escaped text, safe-margin y, translucent box', () => {
  const spec = PLATFORM_SPECS.tiktok;
  const args = drawTextArgs('in.mp4', 'out.mp4', { text: "Don't miss", color: '#FF5500' }, spec);
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes("Don\\'t miss"));
  assert.ok(vf.includes('fontcolor=#FF5500'));
  assert.ok(vf.includes('boxcolor=black@0.4'));
  const junk = drawTextArgs('in.mp4', 'out.mp4', { text: 'x', color: "red';drop[v]" }, spec);
  assert.ok(junk[junk.indexOf('-vf') + 1].includes('fontcolor=reddropv')); // sanitized
});

test('renderPlatformArgs: pads to exact WxH, clamps duration, faststart', () => {
  const spec = PLATFORM_SPECS['instagram-feed'];
  const args = renderPlatformArgs('master.mp4', 'out.mp4', spec);
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes(`pad=${spec.w}:${spec.h}`));
  assert.deepEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', String(spec.maxSeconds)]);
  assert.ok(args.includes('+faststart'));
  assert.ok(args.includes('veryfast')); // final pass: quality preset
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

test('parseStoryboard: audio as a rich object takes its path (never "[object Object]")', () => {
  const scenes = [{ image: 'a.png' }];
  const obj = parseStoryboard(JSON.stringify({ scenes, audio: { type: 'orchestral', description: 'epic', path: 'audio/bed.mp3' } }));
  assert.equal(obj.board.audio, 'audio/bed.mp3');
  const noPath = parseStoryboard(JSON.stringify({ scenes, audio: { type: 'orchestral' } }));
  assert.equal(noPath.board.audio, '');
  const str = parseStoryboard(JSON.stringify({ scenes, audio: 'bed.mp3' }));
  assert.equal(str.board.audio, 'bed.mp3');
});

test('storyboardSteps: stills-only -> slideshow (text folded in), render per platform', () => {
  const { board } = parseStoryboard(JSON.stringify({ scenes: [{ image: 'a.png' }, { image: 'b.png' }], audio: 'bed.mp3', text: { content: 'Hook' } }));
  const steps = storyboardSteps(board, ['tiktok', 'youtube'], 'output/story');
  assert.deepEqual(steps.map((s) => s.kind), ['slideshow', 'render', 'render']); // no separate overlay pass
  assert.ok(steps[0].args[steps[0].args.indexOf('-filter_complex') + 1].includes('drawtext='));
  assert.equal(steps.at(-1).out, 'output/story-youtube.mp4');
  assert.ok(steps.every((s) => Array.isArray(s.args) && s.args.at(-1) === s.out));
  // tiktok matches the master canvas within its cap -> stream-copy remux, no re-encode
  const [tiktok, youtube] = steps.slice(1);
  assert.ok(tiktok.args.includes('copy') && !tiktok.args.includes('libx264'));
  assert.ok(youtube.args.includes('libx264') && !youtube.args.includes('copy'));
});

test('storyboardSteps: mixed scenes -> scene clips, stitch (text folded), mux, encoded render', () => {
  const { board } = parseStoryboard(JSON.stringify({ scenes: [{ image: 'a.png' }, { clip: 'c.mp4' }], audio: 'bed.mp3', text: { content: 'CTA' } }));
  const steps = storyboardSteps(board, ['tiktok'], 'output/story');
  assert.deepEqual(steps.map((s) => s.kind), ['scene', 'stitch', 'mux', 'render']);
  const stitch = steps.find((s) => s.kind === 'stitch');
  assert.ok(stitch.args[stitch.args.indexOf('-filter_complex') + 1].includes('drawtext='));
  // clip duration is unknown -> even the same-spec platform must re-encode (duration clamp)
  assert.ok(steps.at(-1).args.includes('libx264') && !steps.at(-1).args.includes('copy'));
});

test('galleryHtml: one <video> per output, platform label, brand color, escaped title', () => {
  const html = galleryHtml([{ file: 'output/story-tiktok.mp4', platform: 'tiktok' }], { title: 'Promo <x>', color: '#123456' });
  assert.ok(html.includes('<video') && html.includes('output/story-tiktok.mp4'));
  assert.ok(html.includes(PLATFORM_SPECS.tiktok.label));
  assert.ok(html.includes('#123456'));
  assert.ok(html.includes('Promo &lt;x&gt;') && !html.includes('Promo <x>'));
});
