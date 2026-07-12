import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVISE_PLANNER_RULES, mentionsMediaKinds, clampReviseMedia } from './revise-scope.mjs';

test('REVISE_PLANNER_RULES states the caps the planner must follow', () => {
  assert.match(REVISE_PLANNER_RULES, /at most 4/i);
  assert.match(REVISE_PLANNER_RULES, /ONE story/);
  assert.match(REVISE_PLANNER_RULES, /Do NOT assign story media/i);
});

test('mentionsMediaKinds: plain retheme instruction mentions nothing', () => {
  assert.deepEqual(
    mentionsMediaKinds('change the hero section palette to dusk colors'),
    { image: false, video: false, audio: false },
  );
});

test('mentionsMediaKinds: detects each kind independently', () => {
  assert.deepEqual(
    mentionsMediaKinds('add a new hero image and a background video'),
    { image: true, video: true, audio: false },
  );
  assert.equal(mentionsMediaKinds('add a voiceover to the intro').audio, true);
  assert.equal(mentionsMediaKinds('generate a new logo').image, true);
  assert.equal(mentionsMediaKinds('add background music').audio, true);
});

test('mentionsMediaKinds: case-insensitive, tolerates empty/null idea', () => {
  assert.equal(mentionsMediaKinds('Add A New PHOTO gallery').image, true);
  assert.deepEqual(mentionsMediaKinds(''), { image: false, video: false, audio: false });
  assert.deepEqual(mentionsMediaKinds(null), { image: false, video: false, audio: false });
});

test('clampReviseMedia: strips media kinds the instruction never mentioned', () => {
  const stories = [{ id: 's2', media: { image: 2 } }];
  clampReviseMedia(stories, 'retheme the card to Good Bye');
  assert.equal(stories[0].media, undefined);
});

test('clampReviseMedia: keeps kinds the instruction asks for, drops the rest', () => {
  const stories = [{ id: 's2', media: { image: 2, video: 1 } }];
  clampReviseMedia(stories, 'swap the hero image for a sunset photo');
  assert.deepEqual(stories[0].media, { image: 2 });
});

test('clampReviseMedia: stories without media pass through untouched', () => {
  const stories = [{ id: 's2', title: 'x' }];
  const out = clampReviseMedia(stories, 'add a video');
  assert.equal(out, stories);
  assert.equal(stories[0].media, undefined);
});
