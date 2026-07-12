// Pure helpers for staged brand-asset uploads. No I/O — unit-tested. The route layer
// does the fs writes; these decide what's allowed, safe filenames, the planner
// manifest line, and which staging dirs are stale.
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf']);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_ASSETS = 12;       // per build

export function validateAsset({ name = '', size = 0 } = {}) {
  const dot = String(name).lastIndexOf('.');
  const ext = dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : '';
  if (!name || dot < 0 || !ALLOWED_EXT.has(ext)) {
    return { ok: false, reason: `Unsupported file type (allowed: ${[...ALLOWED_EXT].join(', ')}).` };
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'Empty file.' };
  if (size > MAX_BYTES) return { ok: false, reason: 'File exceeds 10 MB.' };
  return { ok: true };
}

export function sanitizeAssetName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'asset';
}

export function assetKind(name = '') {
  const n = String(name).toLowerCase();
  if (/logo/.test(n)) return 'logo';
  return n.endsWith('.pdf') ? 'doc' : 'image';
}

export function stagedAssetManifest(entries = []) {
  return entries
    .map((e) => `${e.name} (${e.kind || assetKind(e.name)}${e.note ? `: ${e.note}` : ''})`)
    .join('; ');
}

export function staleStagedAssets(entries = [], now = Date.now(), ttlMs = 6 * 60 * 60 * 1000) {
  return entries
    .filter((e) => e && Number.isFinite(e.createdAt) && now - e.createdAt > ttlMs)
    .map((e) => e.token);
}
