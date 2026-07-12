import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDraft, draftListItem, scheduleAt, dueDrafts, draftStartBody } from './drafts.mjs';

test('normalizeDraft: clamps + defaults, keeps media/prd as opaque objects', () => {
  const d = normalizeDraft({
    idea: 'a landing page', master: 'claude', workers: ['claude', 'codex', 'codex'],
    model: 'glm-5.2', outputFormat: 'web-app', project: 'my-site',
    media: { image: { enabled: true, cap: 8 } }, prd: { stories: [{ id: 's1' }] },
    clarify: [{ q: 'x', a: 'y' }],
  });
  assert.equal(d.idea, 'a landing page');
  assert.deepEqual(d.workers, ['claude', 'codex']);        // deduped, cap 8
  assert.equal(d.model, 'glm-5.2');
  assert.equal(d.name, 'my-site');                          // name falls back to project
  assert.deepEqual(d.media, { image: { enabled: true, cap: 8 } });
  assert.deepEqual(d.prd, { stories: [{ id: 's1' }] });
  assert.equal(d.clarify.length, 1);
});

test('normalizeDraft: safe on junk — arrays/nulls rejected, strings capped, no throw', () => {
  const d = normalizeDraft({ media: [1, 2], prd: 'nope', workers: 'x', name: 'n'.repeat(200) });
  assert.equal(d.media, null);
  assert.equal(d.prd, null);
  assert.deepEqual(d.workers, []);
  assert.equal(d.name.length, 80);
  assert.deepEqual(normalizeDraft(null).workers, []);       // null input -> defaults
  assert.equal(normalizeDraft(null).outputFormat, 'auto');
});

test('draftListItem: compact summary with story count', () => {
  const item = draftListItem({ id: 'd1', name: 'Site', outputFormat: 'web-app', updatedAt: 5, prd: { stories: [1, 2, 3] }, idea: 'big' });
  assert.deepEqual(item, { id: 'd1', name: 'Site', outputFormat: 'web-app', stories: 3, updatedAt: 5, startAt: null, startError: null });
  assert.equal(draftListItem({ id: 'd2', prd: null }).stories, 0);
});

// --- start timer (scheduled draft -> auto-start) ------------------------------

test('normalizeDraft: startAt kept as a positive integer timestamp, else null', () => {
  assert.equal(normalizeDraft({ startAt: 1782970000000 }).startAt, 1782970000000);
  assert.equal(normalizeDraft({ startAt: '1782970000000' }).startAt, 1782970000000);
  assert.equal(normalizeDraft({ startAt: 0 }).startAt, null);
  assert.equal(normalizeDraft({ startAt: -5 }).startAt, null);
  assert.equal(normalizeDraft({ startAt: 'soon' }).startAt, null);
  assert.equal(normalizeDraft({}).startAt, null);
});

test('scheduleAt: clamps the delay to [15s, 30d] from now', () => {
  const now = 1_000_000_000_000;
  assert.equal(scheduleAt(now, 2 * 60 * 60 * 1000), now + 2 * 60 * 60 * 1000); // 2h
  assert.equal(scheduleAt(now, 1), now + 15_000);                              // below floor
  assert.equal(scheduleAt(now, 400 * 24 * 60 * 60 * 1000), now + 30 * 24 * 60 * 60 * 1000);
  assert.equal(scheduleAt(now, 'nope'), null);
  assert.equal(scheduleAt(now, undefined), null);
});

test('dueDrafts: only drafts whose timer has passed', () => {
  const now = 5000;
  const list = [
    { id: 'a', startAt: 4000 },   // due
    { id: 'b', startAt: 5000 },   // due (boundary)
    { id: 'c', startAt: 6000 },   // future
    { id: 'd', startAt: null },   // no timer
    { id: 'e' }, null,            // junk
  ];
  assert.deepEqual(dueDrafts(list, now).map((d) => d.id), ['a', 'b']);
  assert.deepEqual(dueDrafts(null, now), []);
});

test('draftListItem: exposes startAt + startError for the timer UI', () => {
  const item = draftListItem({ id: 'd3', name: 'S', startAt: 123, startError: 'no key' });
  assert.equal(item.startAt, 123);
  assert.equal(item.startError, 'no key');
  assert.equal(draftListItem({ id: 'd4' }).startAt, null);
});

test('normalizeDraft + draftStartBody: platforms/mediaModels round-trip (social-video)', () => {
  const saved = normalizeDraft({
    idea: 'a story video', outputFormat: 'social-video',
    platforms: ['tiktok'], mediaModels: { image: { provider: 'grok', model: 'grok-imagine-image' } },
  });
  assert.deepEqual(saved.platforms, ['tiktok']);
  assert.deepEqual(saved.mediaModels, { image: { provider: 'grok', model: 'grok-imagine-image' } });
  const body = draftStartBody(saved);
  assert.deepEqual(body.platforms, ['tiktok']);
  assert.deepEqual(body.mediaModels, { image: { provider: 'grok', model: 'grok-imagine-image' } });
});

test('normalizeDraft: formatFamily is additive and junk-safe', () => {
  const d = normalizeDraft({ name: 'x', idea: 'y', formatFamily: 'video' });
  assert.equal(d.formatFamily, 'video');
  const junk = normalizeDraft({ name: 'x', idea: 'y', formatFamily: 'bogus' });
  assert.equal(junk.formatFamily, 'auto');
  const legacy = normalizeDraft({ name: 'x', idea: 'y' });
  assert.equal(legacy.formatFamily, null);
});

test('draftStartBody: maps a draft to the /api/ralph/start request shape', () => {
  const body = draftStartBody({
    id: 'x', name: 'My Site', project: 'my-site', idea: 'a site', master: 'kimi',
    workers: ['kimi'], model: 'm1', outputFormat: 'web-app',
    media: { image: { enabled: true } }, prd: { stories: [] }, clarify: [{ a: 'y' }],
    startAt: 99, startError: 'old', updatedAt: 1,
  });
  assert.equal(body.project, 'my-site');
  assert.equal(body.idea, 'a site');
  assert.equal(body.master, 'kimi');
  assert.deepEqual(body.workers, ['kimi']);
  assert.equal(body.model, 'm1');
  assert.equal(body.outputFormat, 'web-app');
  assert.deepEqual(body.prd, { stories: [] });
  assert.equal('startAt' in body, false);   // timer fields never leak into the start request
  assert.equal('id' in body, false);
  // no explicit project -> the start route smart-names from the idea (not the draft name)
  assert.equal(draftStartBody({ name: 'N', idea: 'i' }).project, '');
});
