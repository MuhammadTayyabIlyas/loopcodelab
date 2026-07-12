# Idea-First New Build Wizard (web/) — Design

Date: 2026-07-03 · Status: approved (user brainstorm session)

## Problem

The web/ New Build form shows every capability up front — name, master, format,
brand assets, model override, three media cap rows, four media-model selects,
eight worker checkboxes — before the user's idea has been used for anything.
The user must understand Ralph's internals to fill it correctly; wrong media
toggles caused real build failures (workers hand-synthesizing art because image
generation was off). The system already owns the smarts the form ignores:
`smartName`, format-aware `clarifyQuestions`, `withFormatMediaDefaults`,
Perplexity `groundIdea`, learned prefs.

## Goal

A guided wizard: the user states a GOAL with one tap, describes the idea with
AI-assisted refinement (research-grounded), and then sees ONLY the fields that
matter for that goal, pre-filled. Everything else stays reachable under one
Advanced expander. Look and feel: professional tile buttons and horizontal
slide transitions (CyberLink PowerDVD-inspired) in the EXISTING light theme —
no dark mode, no app-wide restyle.

## Flow (4 screens, slide left/right between them)

### Screen 1 — Goal (tile buttons, no typing)
Large icon tiles, one tap advances:

| Tile | formatFamily | outputFormat seed |
|---|---|---|
| 🎬 Video | video | social-video |
| 🌐 Website / Web app | web | web-app |
| 📱 Mobile app | mobile | flutter-app |
| 📄 Document | doc | google-doc (analyze may pick docx/pdf) |
| 📊 Spreadsheet | sheet | google-sheet (or xlsx) |
| 📽 Presentation | slides | google-slides (or pptx) |
| ✨ Anything else | auto | auto |

### Screen 2 — Describe & refine (AI-assisted)
Header adapts to the goal ("What kind of video?"). Contains:
- Sub-type chips per family (video: promo · story/tribute · product demo ·
  explainer; web: landing page · SaaS tool · dashboard · store; doc: report ·
  proposal · guide; etc.). Chips are prompt seeds, not hard state.
- Idea textarea (chip taps prepend/augment it).
- Brand-assets tray (existing component, moved here).
- **Analyze** button → ONE combined call (below). Result renders inline: the
  refined brief, inferred name/format/media/platforms, and that format's
  clarify questions.
- **Refine with AI** conversation box: each message re-calls analyze with
  `history` (idea + prior result + messages). Use it to refine one part
  ("also Instagram", "make it 60s") or brainstorm the idea. Stateless on the
  server; client keeps the last 8 messages.
- Clarify questions answered inline on this screen (same answer shape the
  planner already accepts).

### Screen 3 — Options (only relevant fields, pre-filled)
Per formatFamily visible fields (everything editable):
- video → name · platforms checkboxes · image/video/audio toggles+caps ·
  master agent
- web → name · master · workers · images toggle
- mobile → name · master · workers · images toggle (+ Firebase note from clarify)
- doc/sheet/slides → name · master
- auto → name · master · format select (visible here only for auto)

Plus one collapsed **Advanced** expander containing ALL remaining controls
(format switch, per-run model override, media model pickers, worker checkboxes,
caps not shown above). Prefs/`defaultAgent` still seed defaults; analyze output
wins where present; the user's edits win over both.

### Screen 4 — Review plan (unchanged)
Existing PRD generation + editable story table + Save draft / Start. The start
payload is EXACTLY today's `/api/ralph/start` body — the wizard is a new way to
fill the same state. Drafts round-trip: reopening a draft jumps straight to
Screen 3 with state restored (no re-analyze).

## The analyze endpoint

`POST /api/ralph/analyze { idea, formatFamily, history?, current? }` →
`{ name, outputFormat, media, platforms, questions, brief, note }`

- One planner-credential LLM call (`callPlanner`), prompt scoped by
  formatFamily. When `shouldGround(idea, fmt)` fires, fold the existing
  Perplexity `groundIdea` block into the prompt (the "search online / proper
  research" step — suggest-only, best-effort, exactly like planner grounding).
- Response sanitization in a PURE, unit-tested `ralph/analyze.mjs`:
  format ∈ `OUTPUT_FORMATS` (clamped to the family's allowed set), media via
  `normalizeMedia` + `withFormatMediaDefaults`, platforms via
  `normalizePlatforms`, name via `smartName` fallback, questions capped by
  `clarifyAxesFor`'s cap. `history` is clamped (≤8 messages, each ≤500 chars).
- Route registered in `server/routes/ralph.mjs` BEFORE `/api/ralph/:project`.

## Fail-soft (non-negotiable)

Analyze is advisory. Timeout (15s), missing key, or unparseable output →
`{ fallback: true }`; Screen 3 renders with today's defaults (prefs +
`withFormatMediaDefaults(family seed)`) and the goal tile's format seed.
Inference can never block or fail a build. `RALPH_FORCE_TOOL` → deterministic
stub response (tests/e2e).

## UI treatment (PowerDVD-inspired, light theme)

- Tiles: large rounded cards, icon + label, subtle border, accent glow on
  hover/selected (existing indigo `accent` token), grid `2×4 / responsive`.
- Transitions: horizontal slide (CSS transform/translateX + opacity, ~250ms)
  between screens; back navigation slides right. Step badges update (Goal ·
  Describe · Options · Review).
- No new dependencies; Tailwind classes + a tiny CSS transition block.

## Out of scope

- PWA (public/) port — later, its own pass.
- App-wide theming / dark mode.
- Any orchestrator/planner change beyond the analyze endpoint.

## Testing

- `ralph/analyze.test.mjs` — pure normalization: family clamping, junk format,
  media/platform sanitization, history clamp, fallback shape, stub mode.
- `cd web && npm run build` clean; manual wizard walk-through on the live
  instance (goal → analyze (stubbed + real) → options → start with a stub
  build).
- Existing draft round-trip test extended if draft shape gains `formatFamily`
  (single additive optional field; absent = legacy draft opens Screen 3 as
  today's Configure equivalent).
