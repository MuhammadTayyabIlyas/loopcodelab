// Pure helpers for store-screenshot capture. The capture itself (headless Chromium on the
// Flutter build/web at device viewports — the method proven on apkipa) lives in
// capture-shots.mjs; this defines the store-required device sizes, parses an optional
// per-app shot manifest, and names output files. No I/O — unit-tested.

// Portrait pixel sizes accepted by the stores (deviceScaleFactor=1 → screenshot == these).
export const DEVICE_SHOTS = [
  { id: 'phone', store: 'play', w: 1080, h: 1920 },      // Play phone
  { id: 'tablet-7', store: 'play', w: 1200, h: 1920 },   // Play 7" tablet
  { id: 'iphone-6_5', store: 'ios', w: 1242, h: 2688 },  // iOS 6.5" iPhone
  { id: 'ipad-13', store: 'ios', w: 2048, h: 2732 },     // iOS 12.9"/13" iPad
];

const MAX_SHOTS = 6;
const cleanName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
// A safe in-app path/route: an absolute path or a hash route, no scheme/host/traversal.
const cleanPath = (s) => {
  const p = String(s || '/').trim();
  if (/^https?:|\/\//.test(p) || p.includes('..')) return '/';
  if (p.startsWith('/') || p.startsWith('#')) return p;
  return '/' + p;
};

// Parse an optional .ralph/shots.json: [{name, path}] of screens to capture. Falls back
// to a single home-screen shot. Invalid entries are dropped; the result is always non-empty.
export function parseShotManifest(raw) {
  const fallback = [{ name: 'home', path: '/' }];
  if (raw == null) return fallback;
  let j;
  try { j = JSON.parse(String(raw)); } catch { return fallback; }
  const arr = Array.isArray(j) ? j : Array.isArray(j?.shots) ? j.shots : null;
  if (!arr) return fallback;
  const out = arr.map((s, i) => ({ name: cleanName(s?.name) || `screen-${i + 1}`, path: cleanPath(s?.path ?? s?.route) }))
    .filter((s) => s.name).slice(0, MAX_SHOTS);
  return out.length ? out : fallback;
}

// e.g. phone-1-home.png — mirrors apkipa's store-assets naming.
export function shotFileName(device, shot, idx) {
  return `${device.id}-${idx + 1}-${cleanName(shot.name) || 'screen'}.png`;
}

export function devicesForStore(store) {
  return store ? DEVICE_SHOTS.filter((d) => d.store === store) : DEVICE_SHOTS;
}
