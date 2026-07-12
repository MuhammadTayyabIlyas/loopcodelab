// Pure helper: the discovery axes + question cap a clarify pass should use for a
// given output format. No I/O — unit-tested. Drives both the clarify system prompt
// and the clamp on how many questions come back (replacing a hardcoded slice).
const CONTENT_AXES = {
  'web-app': ['brand identity and color palette', 'target audience', 'type of business / industry', 'tone & voice', 'existing brand assets or social media presence', 'key pages / core features'],
  'flutter-app': ['app category / purpose', 'brand identity and color palette', 'target audience', 'key screens / core features', 'backend needs — user accounts, cloud sync, or push notifications (Firebase) vs local-only', 'offline behavior & data persistence'],
  'google-doc': ['target audience', 'tone & voice', 'desired length / depth', 'required sections', 'sources / citations'],
  'docx': ['target audience', 'tone & voice', 'desired length / depth', 'required sections', 'sources / citations'],
  'pdf': ['target audience', 'tone & voice', 'desired length / depth', 'required sections', 'sources / citations'],
  'google-slides': ['target audience', 'number of slides', 'tone & voice', 'visual style'],
  'pptx': ['target audience', 'number of slides', 'tone & voice', 'visual style'],
  'social-video': ['target platforms (TikTok / Instagram Reel & Feed / YouTube & Shorts / LinkedIn)', 'purpose — promo, brand story, or viral hook', 'voiceover, music, or both', 'opening hook + call-to-action text', 'brand identity and color palette', 'story length (default ~30 seconds)'],
};
const SHEET_AXES = ['data shape / structure', 'columns / fields', 'calculations', 'source data'];
const TECH_AXES = ['platform / stack', 'must-have features', 'data / persistence', 'styling', 'auth'];

export function clarifyAxesFor(outputFormat) {
  const fmt = String(outputFormat || 'auto').trim();
  if (CONTENT_AXES[fmt]) return { axes: CONTENT_AXES[fmt], cap: 6, contentHeavy: true };
  if (fmt === 'google-sheet' || fmt === 'xlsx') return { axes: SHEET_AXES, cap: 4, contentHeavy: false };
  return { axes: TECH_AXES, cap: 4, contentHeavy: false };
}
