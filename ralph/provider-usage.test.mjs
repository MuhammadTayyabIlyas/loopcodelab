import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_USAGE, resolveUsageProvider, supportsLiveUsage } from './provider-usage.mjs';

test('resolveUsageProvider maps only the supported providers/presets', () => {
  assert.equal(resolveUsageProvider('kimi'), 'kimi');
  assert.equal(resolveUsageProvider('claude-plan', 'openrouter'), 'openrouter');
  assert.equal(resolveUsageProvider('claude-plan', 'deepseek'), 'deepseek');
  assert.equal(resolveUsageProvider('claude-plan', 'zai'), null); // no balance API
  assert.equal(resolveUsageProvider('anthropic'), null);
  assert.equal(resolveUsageProvider('openai'), null);
  assert.equal(supportsLiveUsage('kimi'), true);
  assert.equal(supportsLiveUsage('grok'), false);
});

test('moonshot/kimi balance parse', () => {
  const b = LIVE_USAGE.kimi.parse({ code: 0, data: { available_balance: 7.8, cash_balance: 7.8 }, status: true });
  assert.deepEqual(b, { available: 7.8, currency: 'USD', unlimited: false });
  assert.equal(LIVE_USAGE.kimi.parse({}), null);
});

test('openrouter key parse — number and uncapped', () => {
  assert.deepEqual(LIVE_USAGE.openrouter.parse({ data: { limit: 10, usage: 3.2, limit_remaining: 6.8 } }),
    { available: 6.8, currency: 'USD', unlimited: false });
  assert.deepEqual(LIVE_USAGE.openrouter.parse({ data: { limit: null, limit_remaining: null } }),
    { available: null, currency: 'USD', unlimited: true });
  assert.equal(LIVE_USAGE.openrouter.parse({}), null);
});

test('deepseek balance parse (string amounts + currency)', () => {
  const b = LIVE_USAGE.deepseek.parse({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '8.50' }] });
  assert.deepEqual(b, { available: 8.5, currency: 'USD', unlimited: false });
  assert.equal(LIVE_USAGE.deepseek.parse({ balance_infos: [] }), null);
});

test('apify usage: monthly headroom = max - used; tolerant of missing fields', () => {
  const cfg = LIVE_USAGE[resolveUsageProvider('apify')];
  assert.ok(cfg.url.includes('/v2/users/me/limits'));
  assert.deepEqual(cfg.parse({ data: { limits: { maxMonthlyUsageUsd: 49 }, current: { monthlyUsageUsd: 11.5 } } }),
    { available: 37.5, currency: 'USD', unlimited: false });
  assert.equal(cfg.parse({ data: {} }), null);
  assert.equal(supportsLiveUsage('apify'), true);
  assert.equal(supportsLiveUsage('perplexity'), false); // no balance API
});
