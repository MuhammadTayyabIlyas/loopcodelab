import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformKeyEntries, platformSecretFor } from './platform-keys.mjs';

test('platformKeyEntries: non-admin gets nothing (BYO tenants never see the platform key)', () => {
  assert.deepEqual(platformKeyEntries({ qwen: 'sk-sp-abcd1234' }, [], false), []);
});

test('platformKeyEntries: admin gets synthetic entries for platform-backed providers not in the vault', () => {
  const e = platformKeyEntries({ qwen: 'sk-sp-abcd1234', openai: 'sk-openai-9999', glm: '' }, ['glm'], true);
  const byId = Object.fromEntries(e.map((x) => [x.provider, x]));
  assert.deepEqual(byId.qwen, { provider: 'qwen', last4: '1234', platform: true });
  assert.deepEqual(byId.openai, { provider: 'openai', last4: '9999', platform: true });
  assert.equal('glm' in byId, false); // empty platform value -> skipped
});

test('platformKeyEntries: a real vault key wins (no platform duplicate for that provider)', () => {
  assert.deepEqual(platformKeyEntries({ qwen: 'sk-sp-abcd1234' }, ['qwen'], true), []);
});

test('platformSecretFor: value or null', () => {
  assert.equal(platformSecretFor({ qwen: 'sk-sp-x' }, 'qwen'), 'sk-sp-x');
  assert.equal(platformSecretFor({ qwen: '' }, 'qwen'), null);
  assert.equal(platformSecretFor({}, 'openai'), null);
});
