import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadSudoSessions } from './sudo-prune.mjs';

test('returns sudo sessions that are no longer live', () => {
  assert.deepEqual(deadSudoSessions(['maint', 'foo'], ['foo', 'bar']), ['maint']);
});
test('empty when all sudo sessions are live', () => {
  assert.deepEqual(deadSudoSessions(['foo'], ['foo', 'bar']), []);
});
test('all dead when nothing is live', () => {
  assert.deepEqual(deadSudoSessions(['maint', 'foo'], []), ['maint', 'foo']);
});
test('empty inputs are safe', () => {
  assert.deepEqual(deadSudoSessions([], ['foo']), []);
  assert.deepEqual(deadSudoSessions(undefined, undefined), []);
});
