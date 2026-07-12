import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthFailure } from './agent-failure.mjs';

test('detects the real Kimi failure (the case that motivated this)', () => {
  const pane = [
    '2026-06-30T10:32:26.918Z ERROR startup failed  operation="run prompt"',
    '  Error: provider.auth_error: 401 Invalid Authentication',
  ].join('\n');
  const r = detectAuthFailure(pane);
  assert.equal(r.auth, true);
  assert.match(r.snippet, /Invalid Authentication/i);
});

test('detects each CLI auth signature', () => {
  const cases = [
    'Invalid API key · Please run /login',         // claude
    'Error: Not logged in. Run `codex login`.',    // codex
    'API key not valid. Please pass a valid API key.', // gemini
    '401 Unauthorized',                            // grok / generic
    'Incorrect API key provided: sk-...abc',        // openai
    'Your credit balance is too low to access the API', // anthropic out of credits
    'Error code: 429 - insufficient_quota',         // openai quota
    'No API key found in environment',              // missing key
    'authentication_error: invalid x-api-key',      // anthropic style
  ];
  for (const c of cases) assert.equal(detectAuthFailure(c).auth, true, `should flag: ${c}`);
});

test('does NOT flag normal build / app output (avoid false positives)', () => {
  const benign = [
    'Running flutter build web --release...',
    'Resolving dependencies... 401 packages available',  // bare number, no auth word
    'Compiling lib/main.dart for the Web...',
    '✓ Built build/web',
    'All 23 tests passed.',
    'Listening on port 4030',
    'POST /api/login 200 OK',                             // a route called login, succeeded
  ].join('\n');
  assert.equal(detectAuthFailure(benign).auth, false);
});

test('empty / whitespace input is not a failure', () => {
  assert.equal(detectAuthFailure('').auth, false);
  assert.equal(detectAuthFailure('   \n  ').auth, false);
  assert.equal(detectAuthFailure(null).auth, false);
  assert.equal(detectAuthFailure(undefined).auth, false);
});

test('snippet is the last matching line and is length-capped', () => {
  const pane = 'line one\nfatal: Unauthorized request to provider\nbuild aborted';
  const r = detectAuthFailure(pane);
  assert.equal(r.auth, true);
  assert.match(r.snippet, /Unauthorized/);
  assert.ok(r.snippet.length <= 160);
});

test('detectAuthFailure: kimi subscription quota exhaustion (429 usage limit)', () => {
  const pane = `error: failed to run prompt: provider.rate_limit: 429 You've reached your usage limit for this period. Your quota will be refreshed in the next period. Upgrade to get more: https://www.kimi.com/code/console?from=limit-upgrade`;
  const r = detectAuthFailure(pane);
  assert.equal(r.auth, true);
  assert.match(r.snippet, /usage limit/i);
  // plain transient chatter must not match
  assert.equal(detectAuthFailure('building the UI components now...').auth, false);
});
