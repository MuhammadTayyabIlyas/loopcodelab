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
