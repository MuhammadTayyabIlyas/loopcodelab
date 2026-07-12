import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validModelId, sanitizeModels, soloModelsFromEnv, effectiveModels,
  resolveSoloModel, soloModelFlag, isSolo, SOLO_MODEL_DEFAULTS, SOLO_AGENTS,
} from './solo-models.mjs';

test('SOLO_AGENTS excludes glm', () => {
  assert.deepEqual(SOLO_AGENTS, ['claude', 'codex', 'qwen', 'gemini']);
});

test('validModelId accepts real ids, rejects junk', () => {
  assert.ok(validModelId('claude-opus-4-8'));
  assert.ok(validModelId('anthropic/claude-3.5'));
  assert.ok(!validModelId('claude; rm -rf /'));
  assert.ok(!validModelId(''));
  assert.ok(!validModelId('a'.repeat(101)));
});

test('sanitizeModels keeps valid, trims, drops blanks/unknowns, throws on bad id', () => {
  const out = sanitizeModels({ claude: { build: ' gpt ', review: '' }, bogus: { build: 'x' } });
  assert.deepEqual(out, { claude: { build: 'gpt' } });
  assert.throws(() => sanitizeModels({ codex: { build: 'bad id!' } }));
});

test('soloModelsFromEnv parses valid JSON or returns {}', () => {
  assert.deepEqual(
    soloModelsFromEnv({ RALPH_SOLO_MODELS: '{"codex":{"build":"gpt-x"}}' }),
    { codex: { build: 'gpt-x' } });
  assert.deepEqual(soloModelsFromEnv({ RALPH_SOLO_MODELS: 'not json' }), {});
  assert.deepEqual(soloModelsFromEnv({}), {});
});

test('effectiveModels merges defaults < file < env', () => {
  const eff = effectiveModels({ claude: { build: 'sonnet-x' } }, { claude: { review: 'opus-y' } });
  assert.equal(eff.claude.build, 'sonnet-x');
  assert.equal(eff.claude.review, 'opus-y');
});

test('effectiveModels populates claude defaults, leaves others absent', () => {
  const eff = effectiveModels({}, {});
  assert.deepEqual(eff.claude, SOLO_MODEL_DEFAULTS.claude);
  assert.equal(eff.codex, undefined);
});

test('resolveSoloModel returns id or empty string', () => {
  const m = { claude: { build: 'b' } };
  assert.equal(resolveSoloModel(m, 'claude', 'build'), 'b');
  assert.equal(resolveSoloModel(m, 'claude', 'review'), '');
  assert.equal(resolveSoloModel(m, 'codex', 'build'), '');
});

test('isSolo: empty workers → true', () => {
  assert.equal(isSolo({ master: 'claude', workers: [] }), true);
});

test('isSolo: master listed as worker → true (master-as-worker)', () => {
  assert.equal(isSolo({ master: 'claude', workers: ['claude'] }), true);
});

test('isSolo: different worker → false', () => {
  assert.equal(isSolo({ master: 'claude', workers: ['codex'] }), false);
});

test('isSolo: master + different worker → false', () => {
  assert.equal(isSolo({ master: 'claude', workers: ['claude', 'codex'] }), false);
});

test('isSolo: no workers field → true (defensive)', () => {
  assert.equal(isSolo({}), true);
});

test('soloModelFlag: only when solo, configured, not coding-plan', () => {
  const models = { claude: { build: 'claude-sonnet-4-6', review: 'claude-opus-4-8' } };
  assert.equal(soloModelFlag({ solo: true, agent: 'claude', role: 'build', models }), ' --model claude-sonnet-4-6');
  assert.equal(soloModelFlag({ solo: true, agent: 'claude', role: 'review', models }), ' --model claude-opus-4-8');
  assert.equal(soloModelFlag({ solo: false, agent: 'claude', role: 'build', models }), '');
  assert.equal(soloModelFlag({ solo: true, agent: 'claude', role: 'build', codingPlan: true, models }), '');
  assert.equal(soloModelFlag({ solo: true, agent: 'codex', role: 'build', models }), '');
});
