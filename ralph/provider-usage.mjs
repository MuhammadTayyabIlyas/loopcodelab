// Pure helpers for the Settings "live balance" feature. Only a few providers expose a
// remaining-balance/credits endpoint; this maps a stored credential (vault provider + the
// coding-plan preset) to that endpoint and a parser. The actual fetch is in server.js; the
// URL building + response parsing here are unit-tested. (Billing-model labels + the
// "Check usage" page URLs are presentation and live in the web/ Settings UI.)

function money(v, currency = 'USD') {
  const n = Number(v);
  return Number.isFinite(n) ? { available: n, currency, unlimited: false } : null;
}

// usage-provider id -> { url, parse(json) -> { available, currency, unlimited } | null }.
// Auth is always `Authorization: Bearer <key>` (added by the caller).
export const LIVE_USAGE = {
  // Moonshot / Kimi balance.
  kimi: {
    url: 'https://api.moonshot.ai/v1/users/me/balance',
    parse: (j) => money(j?.data?.available_balance, 'USD'),
  },
  // OpenRouter key info — limit_remaining null means an uncapped key.
  openrouter: {
    url: 'https://openrouter.ai/api/v1/auth/key',
    parse: (j) => {
      const d = j?.data;
      if (!d) return null;
      if (d.limit == null && d.limit_remaining == null) return { available: null, currency: 'USD', unlimited: true };
      return money(d.limit_remaining, 'USD');
    },
  },
  // DeepSeek balance.
  deepseek: {
    url: 'https://api.deepseek.com/user/balance',
    parse: (j) => {
      const b = Array.isArray(j?.balance_infos) ? j.balance_infos[0] : null;
      return b ? money(b.total_balance, b.currency || 'USD') : null;
    },
  },
  // Apify plan headroom: monthly max minus what this cycle already used.
  apify: {
    url: 'https://api.apify.com/v2/users/me/limits',
    parse: (j) => {
      const max = Number(j?.data?.limits?.maxMonthlyUsageUsd);
      const used = Number(j?.data?.current?.monthlyUsageUsd);
      return (Number.isFinite(max) && Number.isFinite(used)) ? money(max - used, 'USD') : null;
    },
  },
};

// Map a (vault provider, coding-plan preset) to a usage-provider id, or null if we can't
// fetch a live balance for it (most providers — Anthropic/OpenAI/Google/xAI/Mistral — have
// no per-key remaining-quota API, so the UI shows only the "Check usage" link for them).
export function resolveUsageProvider(provider, preset = null) {
  if (provider === 'kimi') return 'kimi';
  if (provider === 'apify') return 'apify';
  if (provider === 'claude-plan') return LIVE_USAGE[preset] ? preset : null;
  return null;
}

export function supportsLiveUsage(provider, preset = null) {
  return !!LIVE_USAGE[resolveUsageProvider(provider, preset)];
}
