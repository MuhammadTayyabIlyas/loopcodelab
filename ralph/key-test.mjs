// Pure helpers for the Settings "Test connection" feature: a cheap, auth-only probe per
// provider that answers "is this stored key still valid?" — the gap that let a dead Kimi
// key look like a failing agent (every run died with `401 Invalid Authentication` but the
// orchestrator only reported "did not meet acceptance criteria"). The actual fetch lives
// in server.js; building the request + interpreting the HTTP status are here and unit-tested.
//
// OAuth credentials, CLI login files and service-account JSON have no simple key probe, so
// they are absent from KEY_TESTS and buildKeyProbe returns null for them — the UI then shows
// "no automated test" and relies on the sandbox CLI-sign-in check instead.

// provider -> { url, auth: 'bearer' | 'x-api-key' | 'query', headers? }
// All probes are a plain GET that the provider rejects (401/403) when the key is bad and
// accepts (2xx) when it is good — typically the model-list endpoint.
export const KEY_TESTS = {
  openai:    { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
  anthropic: { url: 'https://api.anthropic.com/v1/models', auth: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' } },
  gemini:    { url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query' },
  qwen:      { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', auth: 'bearer' },
  kimi:      { url: 'https://api.moonshot.ai/v1/models', auth: 'bearer' },
  grok:      { url: 'https://api.x.ai/v1/models', auth: 'bearer' },
  vibe:      { url: 'https://api.mistral.ai/v1/models', auth: 'bearer' },
  github:    { url: 'https://api.github.com/user', auth: 'bearer', headers: { 'User-Agent': 'webtmux', Accept: 'application/vnd.github+json' } },
  suno:       { url: 'https://api.sunoapi.org/api/v1/generate/credit', auth: 'bearer' },
  elevenlabs: { url: 'https://api.elevenlabs.io/v1/user', auth: 'xi-api-key' },
  ark:        { url: 'https://ark.ap-southeast.bytepluses.com/api/v3/models', auth: 'bearer' },
  apify:      { url: 'https://api.apify.com/v2/users/me', auth: 'bearer' },
  // glm = BytePlus Coding Plan key. Probe the CODING base (/api/coding/v3) — NOT the
  // base-model /api/v3: same key works there too, but that endpoint bills outside the
  // plan, and a probe against it would "validate" a key the agent then uses differently.
  glm:        { url: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3/models', auth: 'bearer' },
  // Perplexity has no GET /models — probe auth with a minimal Sonar ping (same POST-ping
  // pattern as the Alibaba /apps/anthropic hosts in buildPlanProbe; costs a fraction of a
  // cent). max_tokens MUST be >= 16: smaller values 400 ("max_tokens must be at least 16"),
  // which the verdict mapper would misread as an invalid key (bit the first real key test).
  perplexity: {
    url: 'https://api.perplexity.ai/chat/completions', auth: 'bearer', method: 'POST',
    body: { model: 'sonar', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
  },
};

// Build a fetch request ({ url, headers }) that exercises auth, or null if no probe exists
// for this provider (OAuth / login-file / service-account) or no key was supplied.
// A caller may pass a `baseUrl` override for OpenAI-compatible providers whose endpoint is
// deployment-specific — e.g. qwen on an Alibaba monthly-token-plan MaaS host
// (token-plan.<region>.maas.aliyuncs.com), where the default DashScope endpoint 401s a
// token-plan key. The override targets `<baseUrl>/models` (the same list endpoint).
export function buildKeyProbe(provider, key, { baseUrl } = {}) {
  const cfg = KEY_TESTS[provider];
  if (!cfg || !key) return null;
  const headers = { ...(cfg.headers || {}) };
  let url = baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/models` : cfg.url;
  if (cfg.auth === 'bearer') headers.Authorization = `Bearer ${key}`;
  else if (cfg.auth === 'x-api-key') headers['x-api-key'] = key;
  else if (cfg.auth === 'xi-api-key') headers['xi-api-key'] = key;
  else if (cfg.auth === 'query') url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
  if (cfg.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    return { url, headers, method: 'POST', body: JSON.stringify(cfg.body || {}) };
  }
  return { url, headers };
}

// Build a probe for a resolved coding-plan credential (an Anthropic-compatible base URL).
// `plan` is the shape returned by server.js claudePlanOf(): { baseUrl, key, authVar }.
export function buildPlanProbe(plan) {
  if (!plan?.baseUrl || !plan?.key) return null;
  const base = String(plan.baseUrl).replace(/\/+$/, '');
  const headers = { 'anthropic-version': '2023-06-01' };
  // authVar mirrors how the agent CLI sends the credential to this endpoint.
  if (plan.authVar === 'ANTHROPIC_API_KEY') headers['x-api-key'] = plan.key;
  else headers.Authorization = `Bearer ${plan.key}`;
  // Alibaba /apps/anthropic hosts (token-plan, DashScope qwencode) 404 GET /v1/models
  // ("Not support") — probe auth with a minimal messages ping instead.
  if (/\/apps\/anthropic$/.test(base)) {
    headers['Content-Type'] = 'application/json';
    return {
      url: `${base}/v1/messages`, headers, method: 'POST',
      body: JSON.stringify({ model: plan.model || 'qwen3.7-max', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    };
  }
  return { url: `${base}/v1/models`, headers };
}

// Map an HTTP status (or 0 for a network error / timeout) to a verdict. `valid` is
// true | false | null, where null means "couldn't disprove the key" (inconclusive).
// `body` (optional response text) disambiguates providers whose 401 does NOT mean a
// bad key: an ElevenLabs SCOPED key answers 401 missing_permissions on /v1/user while
// authenticating fine — that key is real, just restricted (bit a real key 2026-07-02).
export function interpretProbe(status, body = '') {
  if ((status === 401 || status === 403) && /missing_permissions|missing the permission/i.test(String(body))) {
    return { valid: true, message: 'Key authenticates ✓ — but it is a RESTRICTED key missing the probe\'s scope; make sure it has the permissions this feature needs (e.g. text-to-speech).' };
  }
  if (status >= 200 && status < 300) return { valid: true, message: 'Key is valid ✓' };
  if (status === 401 || status === 403) return { valid: false, message: `Invalid or expired key (HTTP ${status})` };
  if (status === 400) return { valid: false, message: 'Key rejected (HTTP 400) — likely invalid' };
  if (status === 429) return { valid: true, message: 'Key valid — rate-limited right now (HTTP 429)' };
  if (status === 404) return { valid: null, message: "Reachable, but couldn't verify (HTTP 404)" };
  if (status === 0) return { valid: null, message: 'Could not reach provider' };
  if (status >= 500) return { valid: null, message: `Provider error (HTTP ${status}) — try again` };
  return { valid: null, message: `Unexpected response (HTTP ${status})` };
}

// Convenience predicate used by callers/tests.
export function testableProvider(provider) {
  return Object.prototype.hasOwnProperty.call(KEY_TESTS, provider) || provider === 'claude-plan';
}
