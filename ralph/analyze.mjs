// ralph/analyze.mjs
// Pure logic for the idea-first New Build wizard's combined analyze step:
// goal-family mapping, LLM prompt assembly, response normalization, and the
// fail-soft fallback. The route (server/routes/ralph.mjs) owns the LLM +
// grounding calls; everything here is deterministic and unit-tested.
import { normalizeMedia, withFormatMediaDefaults, mediaCapDefaults } from './providers.mjs';
import { normalizePlatforms, DEFAULT_PLATFORMS } from './social-formats.mjs';
import { smartName } from './smart-name.mjs';
import { clarifyAxesFor } from './clarify-axes.mjs';

// Goal tile -> format family. `seed` is what renders instantly when the tile
// is tapped; `formats` is the set the LLM may pick within that family.
// Mirrored by the web/ wizard tiles (web/src/components/wizard.jsx FAMILIES).
export const FORMAT_FAMILIES = {
  video: { seed: 'social-video', formats: ['social-video'], label: 'Video' },
  web: { seed: 'web-app', formats: ['web-app'], label: 'Website / Web app' },
  mobile: { seed: 'flutter-app', formats: ['flutter-app'], label: 'Mobile app' },
  doc: { seed: 'google-doc', formats: ['google-doc', 'docx', 'pdf'], label: 'Document' },
  sheet: { seed: 'google-sheet', formats: ['google-sheet', 'xlsx'], label: 'Spreadsheet' },
  slides: { seed: 'google-slides', formats: ['google-slides', 'pptx'], label: 'Presentation' },
  auto: {
    seed: 'auto',
    formats: ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc',
      'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'],
    label: 'Anything',
  },
};

export function familyOf(id) {
  const key = String(id || '').trim();
  return FORMAT_FAMILIES[key] ? key : 'auto';
}

const MAX_HISTORY = 8;
const MAX_MSG = 500;
export function clampHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY)
    .map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      text: String(m?.text || '').slice(0, MAX_MSG),
    }))
    .filter((m) => m.text);
}

// Two messages for callPlanner: a fixed system persona and one user turn
// carrying the idea + family constraint + optional grounding/history/current.
export function analyzePrompt({ idea, formatFamily, history = [], current = null, grounding = '' } = {}) {
  const famKey = familyOf(formatFamily);
  const fam = FORMAT_FAMILIES[famKey];
  const axes = clarifyAxesFor(fam.seed);
  const system = 'You are the intake assistant for an autonomous software/media build system. '
    + 'Given a user idea, decide the best deliverable format, a short project name, which media '
    + 'generation kinds the build needs, target platforms (social video only), the clarifying '
    + 'questions worth asking, and a refined one-paragraph brief. '
    + 'Reply ONLY JSON: {"name":"<kebab, <=32 chars>","outputFormat":"<id>",'
    + '"media":{"image":{"enabled":bool,"cap":n},"video":{"enabled":bool,"cap":n},"audio":{"enabled":bool,"cap":n}},'
    + '"platforms":["<id>"...],"questions":[{"q":"...","options":["...",...]}],'
    + '"brief":"<refined brief>","note":"<one line on what you inferred and why>"}';
  const parts = [
    `Idea: ${idea}`,
    `Allowed outputFormat values (pick ONE): ${fam.formats.join(', ')}`,
    `Question axes to consider (ask at most ${axes.cap}, only ones the idea leaves open):\n${axes.axes.map((a) => `- ${a}`).join('\n')}`,
  ];
  if (famKey === 'video') {
    parts.push('Platform ids: tiktok, instagram-reel, instagram-feed, youtube-short, youtube, linkedin.');
  }
  if (current) parts.push(`Current config (the user may be refining it): ${JSON.stringify(current)}`);
  if (grounding) parts.push(`Current web research:\n${grounding}`);
  const h = clampHistory(history);
  if (h.length) parts.push(`Refinement conversation so far:\n${h.map((m) => `${m.role}: ${m.text}`).join('\n')}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function normalizeAnalysis(raw, { idea, formatFamily } = {}) {
  const famKey = familyOf(formatFamily);
  const fam = FORMAT_FAMILIES[famKey];
  const outputFormat = fam.formats.includes(raw?.outputFormat) ? raw.outputFormat : fam.seed;
  const name = String(raw?.name || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || smartName(String(idea || ''));
  const media = withFormatMediaDefaults(
    normalizeMedia(raw?.media && typeof raw.media === 'object' ? raw.media : mediaCapDefaults()),
    outputFormat,
  );
  const platforms = outputFormat === 'social-video' ? normalizePlatforms(raw?.platforms) : null;
  const cap = clarifyAxesFor(outputFormat).cap;
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .map((q) => ({
      q: String(q?.q || (typeof q === 'string' ? q : '')).slice(0, 300),
      options: Array.isArray(q?.options) ? q.options.slice(0, 6).map((o) => String(o).slice(0, 80)) : [],
    }))
    .filter((q) => q.q)
    .slice(0, cap);
  return {
    fallback: false,
    formatFamily: famKey,
    name,
    outputFormat,
    media,
    platforms,
    questions,
    brief: String(raw?.brief || idea || '').slice(0, 2000),
    note: String(raw?.note || '').slice(0, 300),
  };
}

// Deterministic result when the LLM can't run — the wizard renders today's
// defaults and the build proceeds exactly as before. Never throws.
export function fallbackAnalysis(idea, formatFamily) {
  const famKey = familyOf(formatFamily);
  const fam = FORMAT_FAMILIES[famKey];
  return {
    fallback: true,
    formatFamily: famKey,
    name: smartName(String(idea || '')),
    outputFormat: fam.seed,
    media: withFormatMediaDefaults(mediaCapDefaults(), fam.seed),
    platforms: fam.seed === 'social-video' ? [...DEFAULT_PLATFORMS] : null,
    questions: [],
    brief: String(idea || '').slice(0, 2000),
    note: '',
  };
}

// RALPH_FORCE_TOOL stub: same deterministic base, but shaped like a REAL
// analysis (fallback:false + one question) so the wizard's happy path is
// exercised by the no-spend harness.
export function stubAnalysis(idea, formatFamily) {
  return {
    ...fallbackAnalysis(idea, formatFamily),
    fallback: false,
    note: 'stub analysis (RALPH_FORCE_TOOL)',
    questions: [{ q: 'Stub: who is the audience?', options: ['everyone', 'a niche'] }],
  };
}
