// Pure detector: did an agent session die because of a CREDENTIAL / auth / startup failure
// (a dead or disconnected key) rather than producing bad code? Each CLI prints a different
// signature on a 401 / not-logged-in / missing-key / out-of-credits. The orchestrator scans
// the worker's pane on exit and, when this matches AND the branch has no new commits, surfaces
// "agent auth failed — check its key in Settings" and reroutes/fails fast, instead of the
// misleading "did not meet acceptance criteria" reject that a dead Kimi key produced (it died
// every run on `provider.auth_error: 401 Invalid Authentication` yet only ever showed up as a
// rejection, making a disconnected agent look like an incompetent one).

// Worded patterns only — bare status numbers (a stray "401") are too ambiguous to match on
// their own, so 401/403 must sit next to an auth word. The zero-commits gate in the caller is
// the real guard against false positives, which lets these stay readable.
const AUTH_PATTERNS = [
  /invalid\s+authentication/i,                         // Moonshot / Kimi
  /auth(?:entication|orization)?[_\s-]?(?:error|failed|failure)/i, // provider.auth_error, "authentication failed"
  /\bunauthorized\b/i,                                 // 401 Unauthorized
  /\b(?:401|403)\b[^\n]{0,40}(?:unauthor|auth|invalid|denied|forbidden|token|api[_\s-]?key)/i,
  /(?:unauthor|forbidden|invalid|denied|expired)[^\n]{0,40}\b(?:401|403)\b/i,
  /(?:invalid|incorrect|expired|revoked)[_\s-]?api[_\s-]?key/i,    // OpenAI / Anthropic
  /api key not valid/i,                                // Gemini
  /\bnot logged in\b/i,                                // codex / claude
  /please run\s+\/?login/i,
  /\blogin (?:required|expired|failed)\b/i,
  /no (?:api )?key (?:found|configured|provided|set)/i,
  /missing[^\n]{0,24}api[_\s-]?key/i,
  /(?:expired|revoked) (?:token|credential|session)/i,
  /startup failed/i,                                   // kimi-code: "ERROR startup failed"
  /credit balance is too low/i,                        // Anthropic out of credits
  /insufficient[_\s]?quota/i,                          // OpenAI out of quota
  /quota exceeded/i,
  // Subscription quota exhaustion (kimi-code: "provider.rate_limit: 429 You've reached your
  // usage limit for this period"). A worker that produced ZERO commits and shows a rate/usage
  // limit is blocked exactly like a dead key — reroute or fail fast with the provider's own
  // message instead of "did not meet acceptance criteria" (bit the first timer-fired kimi run).
  /provider\.rate_limit/i,
  /reached your usage limit/i,
  /usage limit (?:reached|exceeded)/i,
  /\b429\b[^\n]{0,60}(?:limit|quota)/i,
];

// Returns { auth: boolean, snippet: string }. snippet = the last matching line, for the
// MASTER.md journal and the dashboard event (so the user sees the exact provider message).
export function detectAuthFailure(text) {
  const s = String(text || '');
  if (!s.trim()) return { auth: false, snippet: '' };
  for (const re of AUTH_PATTERNS) {
    if (re.test(s)) {
      const line = s.split('\n').map((l) => l.trim()).filter(Boolean).reverse().find((l) => re.test(l)) || '';
      return { auth: true, snippet: line.slice(0, 160) };
    }
  }
  return { auth: false, snippet: '' };
}
