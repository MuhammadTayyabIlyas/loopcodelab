// Surface platform-supplied (secrets.json / env) credentials in the ADMIN's Settings.
// Multitenant Settings otherwise only reflects the per-tenant vault (listProviderKeys),
// so the deployment owner sees "not connected" for keys their builds actually fall back
// to (e.g. the token-plan qwen key in secrets.json). This adds admin-only, display-only
// entries — only last4 ever leaves the server, never the secret itself. BYO tenants get
// nothing here (consistent with the strict-BYO policy).

// platformValues: { provider -> resolved key string } (caller resolves via its accessors).
// have: provider ids already present in the tenant vault. isAdmin: gate.
export function platformKeyEntries(platformValues, have, isAdmin) {
  if (!isAdmin) return [];
  const haveSet = new Set(have || []);
  const out = [];
  for (const [provider, value] of Object.entries(platformValues || {})) {
    if (!value || typeof value !== 'string') continue; // no platform key for this provider
    if (haveSet.has(provider)) continue;               // a real vault key wins
    out.push({ provider, last4: value.slice(-4), platform: true });
  }
  return out;
}

// The platform key value for one provider (for the admin's Test probe fallback), or null.
export function platformSecretFor(platformValues, provider) {
  const v = platformValues && platformValues[provider];
  return (typeof v === 'string' && v) ? v : null;
}
