# UI Overhaul — Part 1: Design Kit + Builds Gallery (web/)

Date: 2026-07-03 · Status: draft — AWAITING USER REVIEW (several decisions [ASSUMED]
while the user was away; each is flagged and easily overridden).

## Decomposition (the umbrella request)

The user asked for: Settings restructure (one long scroll today), builds in a
separate gallery/artifacts view, and a whole-UI visual/UX pass, with design
inspiration from the Stitch actor on Apify. That is three sub-projects; each
gets its own spec → plan → build:

1. **THIS SPEC — design kit + `/builds` gallery** (highest daily value; the
   shared pieces the others reuse). [ASSUMED order — user was AFK at the
   ordering question; recommended option chosen]
2. Settings restructure (grouped tabs + provider quick-search) — next spec.
3. Consistency sweep (BuildDetail artifact strip, icon adoption everywhere,
   density/empty-state polish) — final spec.

## Problem (from code audit, web/src)

- Dashboard `BuildCard` shows phase/progress/Open/Repo only, while
  `runSummary` already returns APK, Windows installer/Store links+QRs, media
  verification, preview URL, attention state — artifacts are invisible until
  you open each build.
- No search/filter/sort anywhere; builds render as an unbounded grid.
- Icons are raw emoji (no icon system); artifact boxes in BuildDetail are
  three differently-styled one-offs.

## Design

### New dependency: `lucide-react` [ASSUMED]

The app has zero icon infrastructure. lucide-react is tree-shaken, styleable
via Tailwind classes, and keeps bundle growth to the icons imported. Emoji
stay where they carry personality (goal tiles, event feed); functional
affordances (buttons, chips, badges) move to icons progressively — Part 1
converts only the components it touches.

### Shared components (new `web/src/components/ui.jsx`)

- `PhaseBadge({phase})` — the phase→color/label map lifted out of
  Dashboard.jsx so gallery/dashboard/detail render identical badges.
- `ArtifactChips({run, compact})` — one row of link-chips derived from a run
  summary: `Preview` (previewUrl), `Repo`, `APK` (apk.shareLink),
  `Installer` / `Store pkg` (windows.*.shareLink), `Drive media`
  (mediaShare.files → first link, count badge) — each an icon + short label,
  target _blank; `compact` renders icon-only with tooltips (dashboard cards).
  QR links render as a small popover on hover/tap where a qr URL exists.
- `SearchInput({value, onChange, placeholder})` — styled `.input` with a
  search icon and clear button.
- `SegTabs({tabs, active, onSelect})` — extraction of BuildDetail's existing
  segmented-control tab bar (`.seg/.seg-item` classes) into a reusable
  component (Part 2's Settings tabs will reuse it).

### `/builds` — the Builds Gallery (new page, new hash route)

- Route: `if (route.startsWith('/builds'))` in App.jsx (trivial per audit);
  linked from the Dashboard header ("Builds") and the dashboard builds
  section header ("All builds →").
- Layout: page header (title + count + New build button), then a control row:
  `SearchInput` (matches project name, idea; client-side) + filter chips
  (All · Running · Done · Failed/Attention) + format filter (dropdown of
  OUTPUT_FORMATS actually present) + sort (Recent · Name) [client-side only —
  `api.builds()` already returns everything needed; no backend changes].
- Grid of gallery cards (sm:2 lg:3 cols, same `.card` language):
  format icon + project name + `PhaseBadge`; master/progress line
  (running builds show the story progress bar + live 🎬 compose step when
  present); `ArtifactChips` row; failed/attention builds show the reason line
  and a Doctor shortcut. Cards click through to `/build/:project`.
- Empty states: no builds at all → hero-style call to action; no matches →
  "no builds match" + clear-filters button.
- Dashboard changes: builds section renders the 6 most recent + "All builds →"
  link; `BuildCard` gains `ArtifactChips compact` so ready artifacts are
  visible at a glance. Drafts section unchanged.

### Stitch actor (Apify) — scoped role

Investigated live: the only Stitch actor on the Apify store is
`alizarin_refrigerator-owner/google-stitch-ai-landing-page-generator`
(pay-per-event, ~185 total runs) — a LANDING-PAGE generator (competitor
analysis → branded HTML), not an app-screen designer. Scoped use:

- **Inspiration input at implementation time**: one run, prompted with the
  webtmux brand + product description; its output (palette/typography/section
  rhythm/hero patterns) is distilled into the design-kit styling decisions
  (documented in the plan task that consumes it).
- **Optional follow-up**: regenerate the public Landing page from its output
  (separate small task, explicitly opt-in).
- **Access note**: the ops shell cannot decrypt the tenant vault (permission-
  gated cross-tenant secret access — correctly denied). The run needs either
  the platform `apifyToken` in `~/.webtmux/secrets.json` (currently empty) or
  the user pasting a token for the one-off run. If neither is available at
  implementation time, the design kit ships from the audit + existing design
  language alone and the actor step is skipped. [ASSUMED acceptable]

### Out of scope (Parts 2–3)

Settings restructure; BuildDetail redesign beyond consuming `ArtifactChips`
for its artifact strip (small, included here since the component replaces
three inconsistent one-off boxes); app-wide emoji→icon conversion; dark mode
(explicitly rejected earlier — light theme stays).

## Error handling / fail-soft

Gallery is a pure consumer of `GET /api/ralph/status` (existing polling
pattern); zero new endpoints. `mediaShare` chips appear only when the Drive
delivery feature (in flight) populates `runSummary.mediaShare` — absent field
renders nothing. All chips guard on their field's presence.

## Testing

- `cd web && npm run build` clean; no `web/dist` commits.
- No pure-module changes → no new node tests; manual walk: /builds renders,
  search/filters/sort work on live data, chips deep-link correctly, dashboard
  recent-6 + link, BuildDetail strip renders via ArtifactChips.
