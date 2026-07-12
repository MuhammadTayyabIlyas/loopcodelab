// Presentational pieces for the idea-first New Build wizard: goal tiles
// (PowerDVD-style large cards, light theme) and the slide-transition wrapper.
// All state lives in pages/NewBuild.jsx — these are dumb components.

// Mirrors ralph/analyze.mjs FORMAT_FAMILIES (ids must match exactly).
export const FAMILIES = [
  { id: 'video', icon: '🎬', label: 'Video', hint: 'Story video for TikTok, Reels, Shorts, YouTube', ask: 'What kind of video?', chips: ['Promo', 'Story / tribute', 'Product demo', 'Explainer'] },
  { id: 'web', icon: '🌐', label: 'Website / Web app', hint: 'Landing page, SaaS tool, dashboard, store', ask: 'What kind of website or app?', chips: ['Landing page', 'SaaS tool', 'Dashboard', 'Online store'] },
  { id: 'mobile', icon: '📱', label: 'Mobile app', hint: 'Flutter app — Android + web preview', ask: 'What kind of mobile app?', chips: ['Utility', 'Social', 'Tracker', 'Game'] },
  { id: 'doc', icon: '📄', label: 'Document', hint: 'Report, proposal, guide — Doc / Word / PDF', ask: 'What kind of document?', chips: ['Report', 'Proposal', 'Guide'] },
  { id: 'sheet', icon: '📊', label: 'Spreadsheet', hint: 'Model, tracker, analysis — Sheet / Excel', ask: 'What kind of spreadsheet?', chips: ['Financial model', 'Tracker', 'Analysis'] },
  { id: 'slides', icon: '📽️', label: 'Presentation', hint: 'Pitch deck, slides — Slides / PowerPoint', ask: 'What kind of presentation?', chips: ['Pitch deck', 'Training', 'Portfolio'] },
  { id: 'auto', icon: '✨', label: 'Anything else', hint: 'Describe it — the planner picks the format', ask: 'What do you want to build?', chips: [] },
];

const FORMAT_TO_FAMILY = {
  'social-video': 'video', 'web-app': 'web', 'flutter-app': 'mobile',
  'google-doc': 'doc', docx: 'doc', pdf: 'doc',
  'google-sheet': 'sheet', xlsx: 'sheet',
  'google-slides': 'slides', pptx: 'slides',
};
export function familyForFormat(outputFormat) {
  return FORMAT_TO_FAMILY[outputFormat] || 'auto';
}

// Horizontal slide-in wrapper: remounts on `k` change so the CSS animation
// replays; dir 'back' slides from the left instead.
export function Slide({ k, dir = 'fwd', children }) {
  return (
    <div key={k} data-dir={dir} className="wizard-slide">
      {children}
    </div>
  );
}

export function GoalScreen({ onPick }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">What do you want to build?</h2>
      <p className="mt-1 text-sm text-muted">Pick a goal — everything else is inferred from your idea and stays editable.</p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {FAMILIES.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onPick(f)}
            className="card group flex flex-col items-start gap-2 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-accent hover:shadow-glow"
          >
            <span className="text-3xl">{f.icon}</span>
            <span className="text-sm font-semibold">{f.label}</span>
            <span className="text-xs text-muted">{f.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
