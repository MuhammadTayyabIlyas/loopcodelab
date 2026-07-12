import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_TESTS, buildKeyProbe, buildPlanProbe, interpretProbe, testableProvider } from './key-test.mjs';

test('buildKeyProbe: bearer providers send Authorization', () => {
  const p = buildKeyProbe('kimi', 'sk-abc');
  assert.equal(p.url, 'https://api.moonshot.ai/v1/models');
  assert.equal(p.headers.Authorization, 'Bearer sk-abc');
});

test('buildKeyProbe: anthropic uses x-api-key + version header', () => {
  const p = buildKeyProbe('anthropic', 'sk-ant');
  assert.equal(p.headers['x-api-key'], 'sk-ant');
  assert.equal(p.headers['anthropic-version'], '2023-06-01');
  assert.equal(p.headers.Authorization, undefined);
});

test('buildKeyProbe: gemini puts the key in the query string (url-encoded)', () => {
  const p = buildKeyProbe('gemini', 'a b/c');
  assert.equal(p.url, 'https://generativelanguage.googleapis.com/v1beta/models?key=a%20b%2Fc');
  assert.equal(p.headers.Authorization, undefined);
});

test('buildKeyProbe: github carries a User-Agent (the API rejects requests without one)', () => {
  const p = buildKeyProbe('github', 'ghp_x');
  assert.equal(p.headers['User-Agent'], 'webtmux');
  assert.equal(p.headers.Authorization, 'Bearer ghp_x');
});

test('buildKeyProbe: a baseUrl override retargets the model-list probe (qwen token-plan host)', () => {
  const p = buildKeyProbe('qwen', 'sk-sp-x', { baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/' });
  assert.equal(p.url, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models'); // trailing slash trimmed, /models appended
  assert.equal(p.headers.Authorization, 'Bearer sk-sp-x');
  // No override → the default DashScope endpoint (unchanged behaviour).
  assert.equal(buildKeyProbe('qwen', 'sk-sp-x').url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models');
});

test('buildKeyProbe: null for un-probeable providers and missing keys', () => {
  assert.equal(buildKeyProbe('claude-oauth', 'whatever'), null); // OAuth, no probe
  assert.equal(buildKeyProbe('firebase', '{}'), null);           // service-account JSON
  assert.equal(buildKeyProbe('kimi', ''), null);                 // no key
  assert.equal(buildKeyProbe('kimi', null), null);
});

test('buildPlanProbe: authVar selects the header style', () => {
  const bearer = buildPlanProbe({ baseUrl: 'https://api.z.ai/api/anthropic/', key: 'k', authVar: 'ANTHROPIC_AUTH_TOKEN' });
  assert.equal(bearer.url, 'https://api.z.ai/api/anthropic/v1/models'); // trailing slash trimmed
  assert.equal(bearer.headers.Authorization, 'Bearer k');

  const apiKey = buildPlanProbe({ baseUrl: 'https://ark.example/api/coding', key: 'k2', authVar: 'ANTHROPIC_API_KEY' });
  assert.equal(apiKey.headers['x-api-key'], 'k2');
  assert.equal(apiKey.headers.Authorization, undefined);

  assert.equal(buildPlanProbe(null), null);
  assert.equal(buildPlanProbe({ baseUrl: '', key: 'k' }), null);
});

test('buildPlanProbe: /apps/anthropic hosts probe via POST /v1/messages (GET /v1/models 404s there)', () => {
  const p = buildPlanProbe({ baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic', key: 'sk-sp-x', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'glm-5.2' });
  assert.equal(p.url, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages');
  assert.equal(p.method, 'POST');
  assert.equal(p.headers.Authorization, 'Bearer sk-sp-x');
  const body = JSON.parse(p.body);
  assert.equal(body.model, 'glm-5.2');
  assert.ok(body.max_tokens >= 1 && Array.isArray(body.messages));
  // A normal Anthropic-compatible base still uses GET /v1/models (no method).
  const q = buildPlanProbe({ baseUrl: 'https://api.z.ai/api/anthropic', key: 'k', authVar: 'ANTHROPIC_AUTH_TOKEN' });
  assert.equal(q.url, 'https://api.z.ai/api/anthropic/v1/models');
  assert.equal(q.method, undefined);
});

test('interpretProbe: status -> verdict', () => {
  assert.equal(interpretProbe(200).valid, true);
  assert.equal(interpretProbe(204).valid, true);
  assert.equal(interpretProbe(401).valid, false);
  assert.equal(interpretProbe(403).valid, false);
  assert.equal(interpretProbe(400).valid, false);
  assert.equal(interpretProbe(429).valid, true);  // valid key, just throttled
  assert.equal(interpretProbe(404).valid, null);  // inconclusive
  assert.equal(interpretProbe(0).valid, null);     // network error
  assert.equal(interpretProbe(503).valid, null);   // provider down
  for (const s of [200, 401, 400, 429, 404, 0, 503]) assert.equal(typeof interpretProbe(s).message, 'string');
});

test('testableProvider covers raw-key providers + claude-plan, not oauth/file', () => {
  assert.ok(testableProvider('kimi'));
  assert.ok(testableProvider('github'));
  assert.ok(testableProvider('claude-plan'));
  assert.ok(!testableProvider('claude-oauth'));
  assert.ok(!testableProvider('firebase'));
});

test('every KEY_TESTS entry has an https url and a known auth mode', () => {
  for (const [prov, cfg] of Object.entries(KEY_TESTS)) {
    assert.match(cfg.url, /^https:\/\//, `${prov} url`);
    assert.ok(['bearer', 'x-api-key', 'query', 'xi-api-key'].includes(cfg.auth), `${prov} auth mode`);
  }
});

test('buildKeyProbe: media providers (suno, elevenlabs) have auth probes', () => {
  const s = buildKeyProbe('suno', 'sk-suno');
  assert.equal(s.url, 'https://api.sunoapi.org/api/v1/generate/credit');
  assert.equal(s.headers.Authorization, 'Bearer sk-suno');
  const e = buildKeyProbe('elevenlabs', 'xi-key');
  assert.equal(e.url, 'https://api.elevenlabs.io/v1/user');
  assert.equal(e.headers['xi-api-key'], 'xi-key');
});

test('buildKeyProbe: ark (BytePlus ModelArk / Seedance) probes the /models list with bearer', () => {
  const p = buildKeyProbe('ark', 'ark-key');
  assert.equal(p.url, 'https://ark.ap-southeast.bytepluses.com/api/v3/models');
  assert.equal(p.headers.Authorization, 'Bearer ark-key');
  // deployment base override (like qwen) targets <base>/models
  const q = buildKeyProbe('ark', 'ark-key', { baseUrl: 'https://ark.example/api/v3/' });
  assert.equal(q.url, 'https://ark.example/api/v3/models');
});

test('apify probe: bearer GET on users/me', () => {
  const p = buildKeyProbe('apify', 'apify_api_xyz');
  assert.equal(p.url, 'https://api.apify.com/v2/users/me');
  assert.equal(p.headers.Authorization, 'Bearer apify_api_xyz');
  assert.equal(p.method, undefined); // plain GET
});

test('perplexity probe: 1-token POST ping (no models endpoint exists)', () => {
  const p = buildKeyProbe('perplexity', 'pplx-abc');
  assert.equal(p.method, 'POST');
  assert.equal(p.headers.Authorization, 'Bearer pplx-abc');
  assert.equal(p.headers['Content-Type'], 'application/json');
  const body = JSON.parse(p.body);
  assert.equal(body.max_tokens, 16); // perplexity rejects < 16 with a 400
  assert.equal(body.model, 'sonar');
});

test('glm probe: BytePlus CODING base (/api/coding/v3), never the separately-billed /api/v3', () => {
  const p = buildKeyProbe('glm', 'ark-key');
  assert.match(p.url, /\/api\/coding\/v3\/models$/);
  assert.doesNotMatch(p.url, /\/api\/v3\//);
  assert.equal(p.headers.Authorization, 'Bearer ark-key');
});

test('interpretProbe: scoped-key 401 (missing_permissions) reads as VALID-but-restricted', () => {
  const v = interpretProbe(401, '{"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission user_read to execute this operation."}}');
  assert.equal(v.valid, true);
  assert.match(v.message, /restricted/i);
  // a plain 401 without that marker stays invalid
  assert.equal(interpretProbe(401, '{"detail":"bad key"}').valid, false);
  assert.equal(interpretProbe(401).valid, false);
});
