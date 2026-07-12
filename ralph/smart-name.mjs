// Smart project naming + DNS-safe preview labels.
//
// Two problems this fixes:
//  1. When the user leaves the name blank, the UI used to slugify the WHOLE first line of
//     the idea ("you are a multi-agent flutter firebase development team build a quiz app…")
//     into a 63-char project slug.
//  2. The preview host is `<project>--<tenant>.tayyabcheema.com`. A DNS label is capped at
//     63 chars (RFC 1035), so a 63-char slug + "--tenant" = 80 chars → the hostname never
//     resolves and the preview is unreachable. `smartName` keeps names short and meaningful;
//     `previewSafeProject` guarantees the final label fits 63 chars no matter what.

// Words dropped when distilling a name — articles, fillers, conjunctions. Nouns that read
// well in a name (app, website, dashboard, game…) are intentionally kept.
const STOP = new Set([
  'a', 'an', 'the', 'me', 'us', 'my', 'our', 'your', 'some', 'simple', 'basic', 'please',
  'that', 'which', 'for', 'with', 'to', 'of', 'and', 'or', 'in', 'on', 'as', 'is', 'are',
  'be', 'using', 'use', 'it', 'its', 'this', 'these', 'those', 'want', 'need', 'would',
  'like', 'should', 'can', 'will', 'about', 'lets', 'let',
]);
// A leading persona/instruction clause up to an action verb is noise:
// "you are a … team, build a quiz app" -> "quiz app".
const ACTION = /\b(?:build|create|make|develop|design|implement|generate|code|write|produce|craft)\b(?:\s+(?:me|us|a|an|the|my|our))*\s+/ig;

// Derive a short, meaningful, DNS-safe slug from a free-text idea. Deterministic so the
// plan step and the start step compute the SAME name.
export function smartName(idea, { max = 32, words = 5 } = {}) {
  let s = String(idea || '').toLowerCase().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Strip a leading persona/instruction preamble: cut up to and including the LAST action
  // verb that appears early (so the persona is dropped but a later "build" in the body isn't).
  let cut = -1, cutLen = 0, m;
  ACTION.lastIndex = 0;
  while ((m = ACTION.exec(s))) { if (m.index <= 90) { cut = m.index; cutLen = m[0].length; } }
  if (cut >= 0) s = s.slice(cut + cutLen);
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  const salient = tokens.filter((w) => !STOP.has(w));
  const pick = (salient.length >= 2 ? salient : tokens).slice(0, words);
  // Accumulate WHOLE words up to `max` so the name never ends on a half-word ("…-leag").
  let name = '';
  for (const w of pick) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > max) break;
    name = next;
  }
  if (!name) name = (pick[0] || 'project').slice(0, max).replace(/-+$/, '');
  return name || 'project';
}

// Guarantee `<project>--<tenantSlug>` fits in one 63-char DNS label. If the project portion
// is too long it is truncated and (when a hash fn is supplied) suffixed with a 4-char hash of
// the original so distinct long names don't collide on the same preview host. No-op for names
// that already fit (the overwhelmingly common case), so short slugs are byte-identical.
export function previewSafeProject(project, tenantSlug = '', hashFn = null) {
  const p = String(project || '');
  const room = tenantSlug ? (63 - 2 - String(tenantSlug).length) : 63;
  if (p.length <= room) return p;
  if (hashFn) {
    const h = String(hashFn(p)).replace(/[^a-z0-9]/g, '').slice(0, 4);
    const head = p.slice(0, Math.max(6, room - 5)).replace(/-+$/, '');
    return `${head}-${h}`;
  }
  return p.slice(0, Math.max(6, room)).replace(/-+$/, '');
}
