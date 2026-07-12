import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampStoryStart, normalizeNewStory, editKind, MIN_STORY_DELAY_MS, MAX_STORY_DELAY_MS } from './story-ops.mjs';

const NOW = 1_700_000_000_000;
const AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'glm', 'kimi', 'grok', 'vibe'];

test('clampStoryStart: floors to now+15s', () => {
  assert.equal(clampStoryStart(NOW + 1000, NOW), NOW + MIN_STORY_DELAY_MS);
});
test('clampStoryStart: caps at now+30d', () => {
  assert.equal(clampStoryStart(NOW + 90 * 86_400_000, NOW), NOW + MAX_STORY_DELAY_MS);
});
test('clampStoryStart: passes a sane value through', () => {
  assert.equal(clampStoryStart(NOW + 3_600_000, NOW), NOW + 3_600_000);
});
test('clampStoryStart: junk -> null (start immediately)', () => {
  for (const junk of [null, undefined, NaN, Infinity, 'tomorrow', {}]) {
    assert.equal(clampStoryStart(junk, NOW), null, String(junk));
  }
});

test('normalizeNewStory: happy path shapes a queued story', () => {
  const { story, error } = normalizeNewStory(
    { title: 'Add CSV export', description: 'Export the table as CSV', acceptanceCriteria: ['a CSV downloads'], agent: 'codex', deps: ['s1'] },
    ['s1', 's2'], AGENTS);
  assert.equal(error, undefined);
  assert.deepEqual(story, {
    id: 's3', title: 'Add CSV export', description: 'Export the table as CSV',
    acceptanceCriteria: ['a CSV downloads'], assignee: 'codex', deps: ['s1'],
    branch: 'prd/s3', status: 'todo', iterations: 0,
  });
});
test('normalizeNewStory: id survives non-contiguous ids', () => {
  const { story } = normalizeNewStory({ title: 't' }, ['s1', 's7', 'weird'], AGENTS);
  assert.equal(story.id, 's8');
});
test('normalizeNewStory: title required', () => {
  assert.match(normalizeNewStory({ title: '  ' }, [], AGENTS).error, /title/i);
});
test('normalizeNewStory: clamps lengths and list sizes', () => {
  const { story } = normalizeNewStory(
    { title: 'x'.repeat(300), description: 'y'.repeat(5000), acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `c${i}` + 'z'.repeat(600)) },
    [], AGENTS);
  assert.equal(story.title.length, 200);
  assert.equal(story.description.length, 4000);
  assert.equal(story.acceptanceCriteria.length, 20);
  assert.equal(story.acceptanceCriteria[0].length, 500);
});
test('normalizeNewStory: unknown agent rejected, missing agent -> null assignee', () => {
  assert.match(normalizeNewStory({ title: 't', agent: 'gpt9' }, [], AGENTS).error, /agent/i);
  assert.equal(normalizeNewStory({ title: 't' }, [], AGENTS).story.assignee, null);
});
test('normalizeNewStory: deps filtered to existing ids', () => {
  const { story } = normalizeNewStory({ title: 't', deps: ['s1', 'nope', 42] }, ['s1'], AGENTS);
  assert.deepEqual(story.deps, ['s1']);
});

test('editKind: merged->regenerate, reverted->null, rest->edit', () => {
  assert.equal(editKind('merged'), 'regenerate');
  assert.equal(editKind('reverted'), null);
  for (const s of ['todo', 'building', 'review', 'failed', 'blocked', 'skipped']) assert.equal(editKind(s), 'edit');
});
