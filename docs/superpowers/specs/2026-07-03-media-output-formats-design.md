# Media output formats: social video, music track, image set — design

**Date:** 2026-07-03
**Status:** Draft — pending user review (user was away during brainstorm; assumption
choices are flagged inline with **[ASSUMED]** and are easy to reverse)

## Idea (user's words, paraphrased)

Add output formats where the media IS the deliverable, with light editing:

- Combine audio with images; text overlays on images; stitch video + images into a
  ~30-second story for LinkedIn / Instagram / TikTok / YouTube — every platform has
  its own dimensions.
- Music generation with control over pronunciation (spoken/sung lines), instrument
  type, and sometimes background-music removal.
- Image generation sometimes needs editing: a particular region, text/typography,
  and branded colour schemes.

## What already exists (why this is smaller than it looks)

- **Generation is done.** `ralph/gen-image.mjs` (token-plan / Grok Imagine),
  `gen-video.mjs` (Grok / Seedance, `--duration/--ratio`), `gen-audio.mjs`
  (Suno music / ElevenLabs voiceover / Grok TTS) — capped via
  `.ralph/media-count.json`, stub-aware, injected by `ralphEnvPrefix`.
- **Composition tools are on the box.** ffmpeg 8.0 + ImageMagick are installed —
  overlays, slideshows, stitching, per-platform resizing are free local CPU.
- **The delivery machinery is done.** DELIVERABLE.md, preview subdomain, Web Push,
  Drive share wrapper, stub e2e patterns.

What's new: **media as the deliverable** (new `OUTPUT_FORMATS`) and the
**composition/editing layer** (all new).

## Decision: entry point **[ASSUMED]**

**Chosen: new Ralph output formats** (`social-video`, `music-track`, `image-set`),
built by the normal planner → workers → review pipeline. A standalone
"media studio" quick-create is deferred: once the formats work, it is just a canned
single-story PRD posted to `/api/ralph/start` (the `startRunFromRequest` reuse
pattern from the draft timer).

Rejected alternatives:

- **Server-side deterministic pipeline** (orchestrator composes, no agents): cheap
  and predictable, but every style/pacing/layout decision becomes orchestrator
  code. Composition is fuzzy creative work — exactly what worker agents are for.
- **Standalone media studio subsystem**: fastest UX but duplicates clarify, brand
  assets, prefs, delivery.

## Architecture

Follows the proven media-gen pattern: pure tested module + stub-aware CLI helper +
vendored SKILL.md + env injection. Key budget distinction: **generation costs money**
(existing per-kind caps stay), **composition is free** (local ffmpeg) — so compose is
bounded by output count + total size, not spend.

### 1. New output formats

`server/skills.mjs`: `OUTPUT_FORMATS` += `social-video`, `music-track`, `image-set`.
All three join `VISUAL_OUTPUT` (imagery skill auto-injects). `OUTPUT_SKILL` maps:
`social-video` → `social-video`, `music-track` → `music-track`, `image-set` →
`imagery` (+ editing additions). Mirrored in both UIs (`web/` `FORMATS`, PWA
`<select>` + `ralphOutputFormats`).

### 2. `ralph/social-formats.mjs` (pure, unit-tested)

- `PLATFORM_SPECS`: `tiktok`, `instagram-reel`, `instagram-feed`, `linkedin`,
  `youtube`, `youtube-short` → `{w, h, fps, maxSeconds, label}`.
  9:16 1080×1920 (TikTok / Reels / Shorts), 16:9 1920×1080 (YouTube, LinkedIn
  landscape), 1:1 1080×1080 and 4:5 1080×1350 (feed posts). Default story length
  30 s, clamped to the platform max.
- Pure **arg builders** returning ffmpeg/magick argv arrays (tests never run the
  binaries): `slideshowArgs(images, audio, spec)` (Ken Burns zoom/pan),
  `stitchArgs(clips, spec)` (normalize + concat), `drawTextArgs(text, brand, spec)`
  (safe-area-aware overlay, brand font/colour), `renderPlatformArgs(master, spec)`
  (scale/crop/pad + duration clamp), `vocalRemovalArgs(in, out)` (stereo
  centre-cancel "karaoke" filter — baseline quality, honest about limits),
  plus `probeChecks(spec)` → expected `{width,height,maxDuration}` for verification.

### 3. `ralph/compose-media.mjs` (CLI helper, `$RALPH_COMPOSE`)

Subcommands: `slideshow`, `stitch`, `overlay-text`, `render-platforms`,
`remove-vocals`, plus two **reuse-first** commands that collapse the boilerplate an
agent would otherwise re-derive every build (agents produce declarative intent —
data; vendored code executes it):

- `story <storyboard.json> --platforms …` — the one-shot recipe: a validated
  storyboard (scenes with image/clip paths + seconds, optional audio bed, optional
  text overlay) is expanded by a pure `storyboardSteps()` planner into the full
  slideshow/stitch/mux/overlay/render chain and executed. The agent's per-build
  work reduces to the creative artifact (storyboard + generation prompts);
  revisions are "edit storyboard.json, re-run one command".
- `gallery` — deterministically generates the preview `index.html` (one `<video>`
  per `output/*.mp4`, platform labels, brand color) from a pure `galleryHtml()`
  template instead of the agent hand-writing it each build.

Behaviour rules (same contract as `gen-*`):

- Stub-aware: `RALPH_FORCE_TOOL` → tiny deterministic placeholder file, no ffmpeg
  requirement in CI (though ffmpeg IS free — the stub e2e can still exercise it).
- Verifies its own output with ffprobe (exact dimensions, duration ≤ max); a bad
  render exits 2 with a clear message; disabled/over-cap exits 3 = skipped.
- Bounds: max compose outputs per build (default 12) and total output MB
  (default 200) tracked in the existing `.ralph/media-count.json` counters.
- `ralphEnvPrefix` injects `RALPH_COMPOSE=<path to node + script>` for the three
  new formats (and harmlessly for other visual formats later).

### 4. Vendored skills

- `ralph/skills/social-video/SKILL.md`: storyboard first (scenes summing ≤ target
  length); ONE style descriptor reused across all `$RALPH_GEN_*` prompts (existing
  imagery rule); generate scene assets → voiceover (ElevenLabs — best pronunciation)
  and/or music (Suno) → `$RALPH_COMPOSE slideshow|stitch` into a master →
  `overlay-text` for hooks/CTA (brand colours from `assets/brand/MANIFEST.md`) →
  `render-platforms` for every requested platform → write `output/index.html`
  gallery (preview subdomain shows the result) → provenance in `DELIVERABLE.md`.
- `ralph/skills/music-track/SKILL.md`: genre/instrument prompt structure for Suno;
  pronunciation guidance (spoken lines → ElevenLabs voiceover mixed over an
  `--instrumental` Suno bed, sung lines → Suno with explicit lyrics); when the user
  asked for vocal-free output prefer `--instrumental` at generation time,
  `remove-vocals` only as a post-fix; export mp3 + a short preview clip.
- `image-set` extends the existing `imagery` skill with an editing section:
  typography via `overlay-text`/magick (brand font/colour rules, contrast, safe
  margins), brand palette application, alt-text and provenance rules unchanged.

`getSkillMd` reads fresh per build — skill iteration needs no restart.

### 5. Clarify axes (`ralph/clarify-axes.mjs`)

All three are content-heavy (cap 6):

- `social-video`: target platforms (multi-select), purpose (promo / story /
  viral), voiceover vs music vs both, hook + CTA text, brand assets, length.
- `music-track`: genre + instruments, vocals or instrumental, lyrics (user-written
  vs generated), duration, intended use (background / jingle / standalone).
- `image-set`: how many images, where used, overlay text y/n, brand colours/fonts.

Note: the `web/` flow gained a clarify step with flutter-app, so both UIs get these.

### 6. Planning & budget defaults **[ASSUMED]**

Per-format `run.media` defaults when the user doesn't touch them:
`social-video` → image 8 / video 2 / audio 2 (a 30 s story is mostly stills +
1–2 clips + one audio bed); `music-track` → audio 3, others 0;
`image-set` → image 8, others 0. `applyMediaPlan` unchanged.

### 6b. Per-build media model selection (UI) — user-requested

Today media provider choice is deployment-level (`secrets.imageProvider/videoProvider`)
or key-presence fallback — invisible to the user. New: a **"Media models" section in
the New Build configure step** (both UIs), shown when the chosen format generates
media (the three new formats; collapsed/optional for `web-app` etc.):

- Per kind — image / video / music / voiceover — a picker of what the tenant can
  actually use (derived from vault keys + platform fallbacks, same signal as
  `/api/keys`): image → token-plan image models or Grok Imagine; video → Grok
  Imagine or Seedance (ark); music → Suno; voiceover → ElevenLabs or Grok TTS.
  Default = current auto-resolution, labelled "(auto)".
- Curated ids live in `ralph/providers.mjs` (new `MEDIA_MODELS` map, the
  `TOKEN_PLAN_TEXT_MODELS` pattern), surfaced via `/api/keys` as `mediaModels`.
- Selection posts as `mediaModels: {image:{provider,model}, video:{…}, music:{…},
  voiceover:{…}}` on `/api/ralph/plan`/`start`; validated by a pure
  `normalizeMediaModels` (unknown provider/model → dropped to auto); stored on
  `run.mediaModels`; `ralphEnvPrefix` injects `RALPH_IMAGE_PROVIDER/_MODEL`,
  `RALPH_VIDEO_PROVIDER/_MODEL`, `RALPH_AUDIO_*` so `gen-*` helpers obey it
  (helpers already read provider env; add the model override env).
- Round-trips through drafts and the confirm/review step like `media` counts.

### 7. Delivery

Outputs live in `output/` in the repo (small enough to commit; the 200 MB compose
bound keeps repos sane) → normal push + DELIVERABLE.md + preview-subdomain gallery.
Big-file Drive sharing reuses `webtmux-artifact-share` — **ops change required:**
extend its allowlist with `.mp4 .mp3 .png .jpg .zip` (script lives out-of-repo;
update `docs/ops/webtmux-artifact-share.sh` and re-install).

### 7b. Output verification (user-facing) — user-requested

The `checkPwaCompliance`/`run.pwa` pattern, applied to media deliverables:

- New pure module `ralph/media-validate.mjs` (tested): given ffprobe JSON + the
  requested platforms, produce `{outputs:[{file, platform, ok, issues[]}],
  missing[], warnings[]}` — checks exact dimensions per `PLATFORM_SPECS`, duration
  ≤ platform max, non-trivial file size, and that every requested platform has a
  render. ffprobe execution lives in the runtime side (compose helper already
  shells ffprobe); the parser/verdict logic is pure.
- At finalize PASS the orchestrator runs it over `output/` and records
  `run.mediaReport` — **advisory only, never fails a build** (same rule as
  `run.pwa`).
- **UI:** the finished-build view (`web/` BuildDetail + PWA status dialog) shows a
  "Media outputs" card: per-platform rows with ✓/⚠ + issue text, file size,
  and a preview link into the preview-subdomain gallery (`output/index.html`) so
  the user can eyeball every render before publishing. The compose helper's own
  ffprobe self-check (below) is the first line of defence; this report is the
  user-visible second.

### 8. Error handling

Same rule as APK/Windows delivery: a compose/render failure never fails the build —
the deliverable degrades (fewer platforms, no vocal-removed variant) and the miss is
recorded in DELIVERABLE.md. Generation failures already fail soft (exit 3).

### 9. Testing

- `ralph/social-formats.test.mjs` — arg builders, platform specs, probe checks.
- Stub e2e `docs/ops/social-video-stub-e2e.sh` (flutter-stub-e2e pattern): isolated
  instance, `RALPH_FORCE_TOOL=stub`, canned `prd`, asserts per-platform outputs +
  DELIVERABLE.md exist. Composition can run REAL ffmpeg on placeholder assets —
  free — so the e2e genuinely exercises the filter graphs.

## Phasing

1. **Phase 1 — `social-video` end-to-end**: social-formats module + compose CLI +
   skill + clarify + `OUTPUT_FORMATS`/UI wiring + **media model pickers (6b)** +
   **output verification report + UI card (7b)** + stub e2e. (The flagship; proves
   the compose layer.)
2. **Phase 2 — `music-track`**: skill + `remove-vocals` + pronunciation guidance.
3. **Phase 3 — `image-set`**: typography/brand editing additions to imagery.

## Deferred backlog (explicitly out of scope now)

- **Regional image editing / inpainting** — token-plan image-edit models (e.g.
  qwen-image-edit) as a `gen-image --edit` mode; needs call-shape verification.
- **True stem separation** — demucs is RAM-risky on this 8 GB box; an API provider
  (new vault key) is the safer path if the ffmpeg baseline disappoints.
- **Quick-create media studio** — canned single-story PRD over `startRunFromRequest`.
- **Auto-captioning / subtitles** (whisper) for social video accessibility.
