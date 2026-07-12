// Pure helpers for the Google Play feature graphic (1024×500) — a composed marketing
// banner (app name + tagline + icon on a brand gradient), NOT a screenshot. Rendered by
// headless Chromium in capture-shots.mjs; this builds the HTML + normalizes the spec the
// finalize agent optionally provides in `.ralph/feature-graphic.json`. No I/O — unit-tested.

export const FEATURE_GRAPHIC = { w: 1024, h: 500, file: 'feature-1024x500.png' };

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const color = (c, fallback) => (HEX.test(String(c || '').trim()) ? String(c).trim() : fallback);
const prettyName = (project) => String(project || 'App')
  .replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).trim().slice(0, 40) || 'App';

// Parse `.ralph/feature-graphic.json` ({name,tagline,bg,accent,icon}) + apply defaults.
// `icon` is a repo-relative path the caller resolves to a data URI (or auto-detects).
export function normalizeSpec(raw, { project } = {}) {
  let j = {};
  if (raw != null) { try { j = JSON.parse(raw) || {}; } catch { j = {}; } }
  return {
    name: (String(j.name || '').trim() || prettyName(project)).slice(0, 40),
    tagline: String(j.tagline || '').trim().slice(0, 90),
    bg: color(j.bg, '#1e3a8a'),
    accent: color(j.accent, '#6d28d9'),
    icon: typeof j.icon === 'string' && j.icon.trim() ? j.icon.trim() : null,
  };
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function featureGraphicHtml({ name, tagline, bg, accent, iconDataUri } = {}) {
  const grad = `linear-gradient(135deg, ${color(bg, '#1e3a8a')} 0%, ${color(accent, '#6d28d9')} 100%)`;
  const icon = iconDataUri
    ? `<img src="${iconDataUri}" alt="" style="width:200px;height:200px;border-radius:44px;box-shadow:0 24px 60px rgba(0,0,0,.38);object-fit:cover"/>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;box-sizing:border-box}
    html,body{width:${FEATURE_GRAPHIC.w}px;height:${FEATURE_GRAPHIC.h}px;overflow:hidden}
    .wrap{width:${FEATURE_GRAPHIC.w}px;height:${FEATURE_GRAPHIC.h}px;display:flex;align-items:center;gap:56px;
      padding:0 84px;background:${grad};color:#fff;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .text{flex:1;min-width:0}
    h1{font-size:84px;font-weight:800;letter-spacing:-.02em;line-height:1.02;text-shadow:0 2px 22px rgba(0,0,0,.28)}
    p{margin-top:22px;font-size:32px;font-weight:500;opacity:.92;line-height:1.26}
    .icon{flex:0 0 auto}
  </style></head><body><div class="wrap">
    <div class="text"><h1>${esc(name)}</h1>${tagline ? `<p>${esc(tagline)}</p>` : ''}</div>
    <div class="icon">${icon}</div>
  </div></body></html>`;
}
