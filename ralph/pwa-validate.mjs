// Pure PWA-baseline compliance checks (no fs, no I/O). Decides whether a generated
// web app is an installable PWA from an already-parsed manifest plus a couple of
// booleans gathered by the caller. Used by the advisory finalize check in server.js.

export const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'name', 'short_name', 'description', 'start_url', 'scope',
  'display', 'theme_color', 'background_color', 'icons',
]);
const INSTALLABLE_DISPLAY = new Set(['standalone', 'fullscreen', 'minimal-ui']);

// Validate a parsed web app manifest object. Returns { ok, missing, warnings }:
// `missing` = required fields absent/empty (hard); `warnings` = soft issues.
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, missing: [...REQUIRED_MANIFEST_FIELDS], warnings: [] };
  }
  const missing = [];
  for (const f of REQUIRED_MANIFEST_FIELDS) {
    const v = manifest[f];
    const empty = v == null
      || (typeof v === 'string' && v.trim() === '')
      || (f === 'icons' && !(Array.isArray(v) && v.length));
    if (empty) missing.push(f);
  }
  const warnings = [];
  if (manifest.display != null && !INSTALLABLE_DISPLAY.has(manifest.display)) {
    warnings.push(`display "${manifest.display}" is not installable (use standalone/fullscreen/minimal-ui)`);
  }
  if (Array.isArray(manifest.icons) && manifest.icons.length) {
    const sizes = manifest.icons.flatMap((i) => String(i?.sizes || '').split(/\s+/));
    for (const need of ['192x192', '512x512']) {
      if (!sizes.includes(need)) warnings.push(`missing a ${need} icon (recommended for install)`);
    }
  }
  return { ok: missing.length === 0, missing, warnings };
}

// Combine manifest validity with the other PWA-baseline signals. `missing` lists
// hard blockers to installability (manifest.<field> or service-worker); `warnings`
// are soft (offline fallback isn't always possible). Never throws.
export function pwaReport({ manifest = null, hasServiceWorker = false, hasOfflineFallback = false } = {}) {
  const m = validateManifest(manifest);
  const missing = m.missing.map((f) => `manifest.${f}`);
  const warnings = [...m.warnings];
  if (!hasServiceWorker) missing.push('service-worker');
  if (!hasOfflineFallback) warnings.push('no offline fallback page');
  return { compliant: missing.length === 0, missing, warnings };
}
