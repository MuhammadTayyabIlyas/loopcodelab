import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validModelId } from './solo-models.mjs';
import {
  TOKEN_PLAN_TEXT_MODELS, TOKEN_PLAN_IMAGE_MODELS,
  planModelsFor, planModelsMap, resolveClaudePlanKey, tokenPlanAnthropicBase,
  MEDIA_PROVIDERS, mediaCredentialIds, MEDIA_CAP_DEFAULTS, mediaCapDefaults, normalizeMedia,
  applyMediaPlan, MEDIA_MODEL_CHOICES, mediaModelChoices, normalizeMediaModels, withFormatMediaDefaults,
  apifyMcpServer,
} from './providers.mjs';

test('token-plan model lists are non-empty and every id is a valid (shell-safe) model id', () => {
  assert.ok(TOKEN_PLAN_TEXT_MODELS.length >= 5);
  assert.ok(TOKEN_PLAN_IMAGE_MODELS.length >= 2);
  for (const m of [...TOKEN_PLAN_TEXT_MODELS, ...TOKEN_PLAN_IMAGE_MODELS]) {
    assert.ok(validModelId(m.id), `invalid model id: ${m.id}`);
    assert.equal(typeof m.label, 'string');
  }
  const ids = TOKEN_PLAN_TEXT_MODELS.map((m) => m.id);
  for (const want of ['qwen3.7-max', 'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'MiniMax-M2.5'])
    assert.ok(ids.includes(want), `missing ${want}`);
});

test('planModelsFor returns a curated list for tokenplan, empty for free-text presets, and a copy', () => {
  const list = planModelsFor('tokenplan');
  assert.ok(list.length >= 5);
  list.push({ id: 'x', label: 'x' });                 // mutate the copy…
  assert.notEqual(planModelsFor('tokenplan').length, list.length); // …source unaffected
  assert.deepEqual(planModelsFor('openrouter'), []);
  assert.deepEqual(planModelsFor('nope'), []);
});

test('planModelsMap exposes tokenplan and returns deep copies', () => {
  const map = planModelsMap();
  assert.ok(Array.isArray(map.tokenplan));
  map.tokenplan[0].id = 'MUT';
  assert.notEqual(planModelsMap().tokenplan[0].id, 'MUT');
});

test('resolveClaudePlanKey reuses the qwen key ONLY for a blank tokenplan key', () => {
  assert.equal(resolveClaudePlanKey({ preset: 'tokenplan', key: '' }, { qwenKey: 'sk-sp-Z' }), 'sk-sp-Z');
  assert.equal(resolveClaudePlanKey({ preset: 'tokenplan', key: 'explicit' }, { qwenKey: 'sk-sp-Z' }), 'explicit');
  assert.equal(resolveClaudePlanKey({ preset: 'zai', key: '' }, { qwenKey: 'sk-sp-Z' }), ''); // no reuse for other presets
  assert.equal(resolveClaudePlanKey({ preset: 'openrouter', key: 'k' }), 'k');
  assert.equal(resolveClaudePlanKey(null), '');
});

test('tokenPlanAnthropicBase: default host, no trailing slash, env + secrets overrides', () => {
  assert.equal(tokenPlanAnthropicBase(), 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic');
  assert.equal(tokenPlanAnthropicBase({ qwenAnthropicBaseUrl: 'https://x.example/apps/anthropic/' }, {}),
    'https://x.example/apps/anthropic');
  assert.equal(tokenPlanAnthropicBase({}, { WEBTMUX_QWEN_ANTHROPIC_BASE: 'https://env.example/apps/anthropic' }),
    'https://env.example/apps/anthropic');
});

test('media providers registry: ark(video)/suno(music)/elevenlabs(voiceover), each vault-credentialed', () => {
  const byId = Object.fromEntries(MEDIA_PROVIDERS.map((p) => [p.id, p]));
  assert.deepEqual(mediaCredentialIds().sort(), ['ark', 'elevenlabs', 'suno']);
  assert.equal(byId.ark.kind, 'video');
  assert.equal(byId.suno.kind, 'music');
  assert.equal(byId.elevenlabs.kind, 'voiceover');
  for (const p of MEDIA_PROVIDERS) {
    assert.match(p.defaultBase, /^https:\/\//, `${p.id} base`);
    assert.equal(p.credential, 'vault');
    assert.equal(typeof p.label, 'string');
  }
});

test('media cap defaults: image on/8, video off/2, audio off/3', () => {
  const d = mediaCapDefaults();
  assert.deepEqual(d.image, { enabled: true, cap: 8 });
  assert.deepEqual(d.video, { enabled: false, cap: 2 });
  assert.deepEqual(d.audio, { enabled: false, cap: 3 });
  // returns a copy — mutation doesn't leak into the source
  d.image.cap = 99;
  assert.equal(mediaCapDefaults().image.cap, 8);
  assert.equal(MEDIA_CAP_DEFAULTS.image.cap, 8);
});

test('normalizeMedia clamps caps and coerces enabled, filling missing kinds from defaults', () => {
  const m = normalizeMedia({ image: { enabled: false, cap: 999 }, video: { enabled: true, cap: -3 } });
  assert.deepEqual(m.image, { enabled: false, cap: 20 });   // clamped to max 20
  assert.deepEqual(m.video, { enabled: true, cap: 0 });      // clamped to min 0
  assert.deepEqual(m.audio, { enabled: false, cap: 3 });     // default filled
  assert.deepEqual(normalizeMedia(null), mediaCapDefaults()); // null -> defaults
});

test('registry model arrays are frozen (defense-in-depth)', () => {
  assert.ok(Object.isFrozen(TOKEN_PLAN_TEXT_MODELS));
  assert.ok(Object.isFrozen(TOKEN_PLAN_IMAGE_MODELS));
});

test('applyMediaPlan: coerces per-story counts, drops disabled kinds, omits empty media', () => {
  const media = { image: { enabled: true, cap: 8 }, video: { enabled: false, cap: 2 }, audio: { enabled: false, cap: 3 } };
  const out = applyMediaPlan([
    { id: 's1', media: { image: 3, video: 2, audio: '1' } }, // video disabled -> dropped; audio disabled -> dropped
    { id: 's2', media: { image: 0 } },                        // no positive -> media omitted
    { id: 's3' },                                             // no media -> stays without media
  ], media);
  assert.deepEqual(out[0].media, { image: 3 });   // enabled kind kept; disabled kinds gone
  assert.equal('media' in out[1], false);          // zero-count -> omitted
  assert.equal('media' in out[2], false);          // absent stays absent
  assert.equal(out[0].id, 's1');                   // other fields preserved
});

test('applyMediaPlan: clamps the per-kind TOTAL across the whole PRD to the cap, in order', () => {
  const media = { image: { enabled: true, cap: 4 }, video: { enabled: true, cap: 1 }, audio: { enabled: false, cap: 3 } };
  const out = applyMediaPlan([
    { id: 's1', media: { image: 3, video: 1 } },
    { id: 's2', media: { image: 3, video: 1 } }, // image budget has 1 left -> gets 1; video budget spent -> 0
    { id: 's3', media: { image: 2 } },           // image budget spent -> media omitted
  ], media);
  assert.deepEqual(out[0].media, { image: 3, video: 1 });
  assert.deepEqual(out[1].media, { image: 1 });   // clamped to remaining; video dropped (cap already used)
  assert.equal('media' in out[2], false);
});

test('applyMediaPlan: null/garbage media budget and non-array stories are safe', () => {
  assert.deepEqual(applyMediaPlan(null, { image: { enabled: true, cap: 8 } }), []);
  // null budget -> normalizeMedia defaults (image on/8, video off, audio off)
  const out = applyMediaPlan([{ id: 's1', media: { image: 2, video: 5 } }], null);
  assert.deepEqual(out[0].media, { image: 2 }); // video off by default -> dropped
  // per-count clamp to 0..20
  const big = applyMediaPlan([{ id: 's1', media: { image: 999 } }], { image: { enabled: true, cap: 20 } });
  assert.deepEqual(big[0].media, { image: 20 });
});

test('applyMediaPlan: a story with media:null is treated as no media (no crash)', () => {
  const out = applyMediaPlan([
    { id: 's1', media: null },
    { id: 's2', media: { image: 2 } },
  ], { image: { enabled: true, cap: 8 } });
  assert.equal('media' in out[0], false); // null media -> omitted, no throw
  assert.deepEqual(out[1].media, { image: 2 });
});

test('byteplus coding plan: curated models surfaced for the preset dropdown', () => {
  const m = planModelsMap();
  assert.ok(Array.isArray(m.byteplus) && m.byteplus.length >= 8);
  assert.ok(m.byteplus.some((x) => x.id === 'glm-5.1'));
  assert.ok(m.byteplus.some((x) => x.id === 'ark-code-latest')); // console auto mode
  assert.ok(m.byteplus.every((x) => x.id && x.label));
});

test('apifyMcpServer: hosted MCP row (http transport, discovery-only tools) or null without a token', () => {
  const s = apifyMcpServer('apify_api_x');
  assert.equal(s.name, 'apify');
  assert.match(s.url, /^https:\/\/mcp\.apify\.com\//);
  assert.match(s.url, /tools=/);              // preconfigured: discovery/docs/RAG, not execution
  assert.equal(s.transport, 'http');          // SSE is deprecated on Apify's side
  assert.equal(s.auth, 'apify_api_x');
  assert.deepEqual(s.capabilities, ['web-data']);
  assert.equal(apifyMcpServer(''), null);
  assert.equal(apifyMcpServer(null), null);
});

test('normalizeMediaModels keeps only known provider/model pairs', () => {
  const picked = normalizeMediaModels({
    image: { provider: 'grok', model: 'grok-imagine-image' },
    video: { provider: 'ark', model: 'not-a-model' },
    music: 'garbage',
    bogusKind: { provider: 'suno', model: 'V4_5' },
  });
  assert.deepEqual(picked, { image: { provider: 'grok', model: 'grok-imagine-image' } });
  assert.deepEqual(normalizeMediaModels(null), {});
});

test('mediaModelChoices covers all four kinds and copies safely', () => {
  const c = mediaModelChoices();
  for (const k of ['image', 'video', 'music', 'voiceover']) assert.ok(c[k].length > 0);
  c.image.push({ provider: 'x' });
  assert.notEqual(c.image.length, mediaModelChoices().image.length);
});

test('withFormatMediaDefaults: social-video turns video+audio on', () => {
  const m = withFormatMediaDefaults(mediaCapDefaults(), 'social-video');
  assert.equal(m.video.enabled, true);
  assert.ok(m.video.cap >= 2);
  assert.equal(m.audio.enabled, true);
  assert.ok(m.image.cap >= 8);
  // other formats untouched
  assert.equal(withFormatMediaDefaults(mediaCapDefaults(), 'web-app').video.enabled, false);
});
