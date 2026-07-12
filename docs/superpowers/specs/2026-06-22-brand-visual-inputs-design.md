# Brand & Visual Inputs for a Ralph Build — Design

Date: 2026-06-22
Status: Approved design, pre-implementation

## Problem

When a user gives a content-heavy idea ("make a Shopify store"), Ralph plans and builds
without ever asking the brand/business questions that would make the result concrete —
brand colors, target audience, business type, existing social presence. The result is a
generic build off an under-specified prompt.

Three gaps, observed in production:

1. **Clarify asks the wrong kind of question.** A clarify step *does* exist
   (`clarifyQuestions()` at `server.js:834`, `POST /api/ralph/clarify`, wired into both
   frontends), but its system prompt restricts questions to engineering forks
   (`server.js:836-838`: "platform/stack, must-have features, data/persistence, styling,
   auth") and bails with `{questions:[]}` when the idea reads "clear enough"
   (`server.js:846`). A store reads as clear → zero questions → straight to planning.
2. **No way to supply brand assets.** The user cannot hand the build a logo, brand
   colors, or reference images.
3. **No imagery strategy.** When a build needs images the user didn't supply (product
   shots, hero images), nothing tells the workers to source free stock or use the
   provided assets.

## Scope

In scope (this spec):

- **Feature 1 — Format-aware clarify discovery.** Pass the chosen `outputFormat` into
  clarify; ask brand/content/audience questions for content-heavy formats; guarantee
  discovery but skip axes the idea already covers; raise the cap to 6 for content builds.
- **Feature 2 — Brand asset upload.** A single asset tray on the clarify dialog; staged
  server-side under a token; committed into the repo at `/start`; manifest threaded to
  the planner and the worker brief.
- **Feature 3 — Imagery skill.** A vendored skill telling any agent to use uploaded
  assets first, else source free stock images (keyless placeholders, or Unsplash/Pexels
  if a key is configured), with good alt text.

Out of scope (explicit follow-up spec):

- **AI image generation.** Needs an image-model API key and spend controls. Tracked
  separately. The imagery skill is written so a generation step slots in later without
  reshaping it.

## Decisions (resolved)

- Clarify scope: **format-aware discovery** (not generic/blanket).
- Skip behavior: **guarantee discovery for content formats, but skip any axis the idea
  already answers**; only a fully-specified idea yields zero questions.
- Question cap: **6 for content formats, 4 otherwise.** Assets captured as files (tray),
  text references (hex codes, social URLs, product list) still allowed via the existing
  free-write escape hatch.
- Asset UX: **single optional asset tray** on the clarify dialog, independent of the
  questions.
- Asset architecture: **token-staged temp dir, committed at `/start`** (Approach A).
- Upload transport: **`express.raw()`, one file per request** as
  `application/octet-stream` — no new multipart dependency (`multer`/`busboy`).
- Asset constraints: allow `png/jpg/jpeg/webp/gif/svg + pdf`; ≤ 10 MB each; ≤ 12 files.
- Staging location: `DATA_DIR/staged-assets/<token>/` + `meta.json`; **6 h TTL** prune.
- Repo location for committed assets: `<repo>/assets/brand/` + `MANIFEST.md`.
- Imagery: **stock now** (Unsplash/Pexels via env key, else keyless placeholders),
  **AI generation later**.

## Architecture

### Pure, unit-tested helpers (new modules)

Following the existing pattern (`solo-models.mjs`, `adopt-paths.mjs`, `sudo-prune.mjs` —
pure logic + a `*.test.mjs`):

#### `ralph/clarify-axes.mjs`

```
clarifyAxesFor(outputFormat) -> { axes: string[], cap: number, contentHeavy: boolean }
```

- Maps each `OUTPUT_FORMATS` value to its discovery axes and cap:
  - `web-app` → [brand identity & colors, target audience, business type, tone/voice,
    existing assets/social, key pages/features]; `cap 6`; contentHeavy `true`.
  - `google-doc` / `docx` / `pdf` → [audience, tone/voice, length/depth, sections,
    citations]; `cap 6`; contentHeavy `true`.
  - `google-slides` / `pptx` → [audience, slide count, tone, visual style]; `cap 6`;
    contentHeavy `true`.
  - `google-sheet` / `xlsx` → [data shape, columns, calculations, source data];
    `cap 4`; contentHeavy `false`.
  - `auto` / `downloadable` → engineering forks (stack, must-have features,
    data/persistence, styling, auth); `cap 4`; contentHeavy `false`. The system prompt
    still lets the model infer a content axis if the idea is clearly brand/content.
- Pure and deterministic — no I/O. Drives both the system-prompt text and the result
  clamp (replacing the hardcoded `slice(0,4)` at `server.js:853`).

#### `ralph/assets.mjs`

```
validateAsset({ name, size, mime }) -> { ok: true } | { ok: false, reason }
sanitizeAssetName(name) -> string        // strips dirs, traversal, unsafe chars; keeps ext
stagedAssetManifest(entries) -> string   // "logo.png (logo); hero.jpg (image)" for planner
staleStagedAssets(entries, now, ttlMs) -> string[]  // token dirs to prune
assetKind(name|mime) -> 'logo'|'image'|'doc'  // best-effort classification for the manifest
```

- `validateAsset`: extension/mime allowlist (`png jpg jpeg webp gif svg pdf`), ≤ 10 MB,
  returns a human reason on failure.
- `sanitizeAssetName`: basename only, no `..`, ASCII-safe, collision-suffix on caller side.
- `staleStagedAssets`: mirrors `deadSudoSessions` in `sudo-prune.mjs` — takes
  `[{ token, createdAt }]`, returns tokens older than `ttlMs`.

### Server routes & changes (`server.js`)

1. **`clarifyQuestions(idea, outputFormat, tenant)`** — new `outputFormat` param. Builds
   its system prompt from `clarifyAxesFor(outputFormat)`: lists the axes, instructs
   "ask about every listed axis the idea does not already answer; do not re-ask an axis
   the idea already states; for content-heavy builds return at least one question unless
   the idea is fully specified", and clamps the returned questions to `cap`.
2. **`POST /api/ralph/clarify`** — read `outputFormat` from the body, pass it through.
3. **`POST /api/ralph/assets`** (new) — `express.raw({ type: 'application/octet-stream',
   limit: '10mb' })`. Query: `name`, optional `token` (to append to an existing token),
   optional `note`. Flow: `validateAsset` → `sanitizeAssetName` (collision-suffix) →
   write to `STAGED_ASSETS_DIR/<token>/`, update `meta.json`
   (`{ tenant, createdAt, files: [...] }`). Returns `{ assetToken, assets: [{ name, kind,
   size }] }`. `requireAuth`-gated (active under multitenant); token bound to tenant slug,
   cross-tenant reuse rejected. New const `STAGED_ASSETS_DIR = path.join(DATA_DIR,
   'staged-assets')`.
4. **`POST /api/ralph/plan`** — accept `assetToken`; when present, load the staged
   manifest and append a "User-provided brand assets: …" block to the planner context
   (server-side, so filenames/notes are accurate). `planPrd` already injects an `answers`
   block (`server.js:807`); the asset block rides alongside it.
5. **`startRalphRun({ ..., assetToken })`** — after `gitInitProject(dir)`
   (`server.js:2293`): if a valid, non-expired token for this tenant exists, move staged
   files → `<dir>/assets/brand/`, write `assets/brand/MANIFEST.md` (filenames + user
   notes + provenance), `gitCommitAll` (tenant-wrapped under multitenant), delete the
   staging dir. Expired/missing token → proceed without assets and record a warning event.
6. **`monitorTick`** — call `staleStagedAssets` over `STAGED_ASSETS_DIR` entries and
   remove dirs older than 6 h (guards disk against abandoned dialogs).
7. **`writeRalphBrief`** — append the imagery skill text (modeled on `OUTPUT_SKILL`) when
   the run's `outputFormat` is visual (`web-app`, `google-slides`, `pptx`) OR brand
   assets exist, so it reaches the brief for every agent. The planner prompt is also told
   the imagery skill exists so it can assign it per-story.

### Imagery skill (`ralph/skills/imagery/SKILL.md`, new)

Auto-discovered by `loadSkillsCatalog()` (reads `ralph/skills/*/SKILL.md`). Instructs any
agent, in priority order:

1. Use brand assets in `assets/brand/` and the colors/notes in `assets/brand/MANIFEST.md`.
2. If imagery is needed and none was provided: source **free stock** — if
   `UNSPLASH_ACCESS_KEY` or `PEXELS_API_KEY` is set in the environment, fetch relevant,
   correctly-attributed images; otherwise use keyless placeholders
   (`https://picsum.photos/seed/<slug>/<w>/<h>` or a local SVG placeholder) with
   descriptive `alt` text.
3. Never hotlink paid/copyrighted media. Record image provenance (source + query/URL) in
   the deliverable notes.

The `(future) AI generation` path is named in the skill as a TODO hook so a later spec can
extend it without restructuring.

## Data flow (end to end)

1. New Build dialog: idea + `outputFormat` + master/workers → "Plan stories".
2. Client → `POST /api/ralph/clarify { idea, outputFormat }` → format-aware questions.
3. Clarify dialog renders questions + a single asset tray. User answers + optionally drops
   files.
4. On submit: client uploads each file → `POST /api/ralph/assets` (raw, per file),
   accumulating into one `assetToken`; collects the answers string.
5. Client → `POST /api/ralph/plan { idea, answers, outputFormat, assetToken }` → server
   appends the asset manifest to the planner context → editable PRD preview.
6. User confirms → `POST /api/ralph/start { …, assetToken }` → `startRalphRun` creates the
   repo, commits assets to `assets/brand/`, writes `MANIFEST.md`; workers get the imagery
   skill in their brief.

## Error handling

- Assets are optional throughout. Per-file validation failures return `400` with a reason;
  the UI shows the error inline and does **not** block planning or start.
- Upload is best-effort: a failed upload still lets the user plan/start without that file.
- A stale/expired/pruned `assetToken` at `/start` → proceed without assets + warn (run
  event).
- The 6 h staging prune guards disk usage.
- Clarify stays best-effort: any error → `[]`, planning proceeds (unchanged).
- Imagery: stock-fetch failures fall back to placeholders, worker-side, in bypass mode.
- Multitenant: `assetToken` bound to the tenant slug; cross-tenant token use rejected;
  files written app-side into the tenant's project dir, git commit tenant-wrapped.

## Frontends (both — UI behavior can differ between them)

- `public/` PWA: add the asset tray markup to the clarify dialog in `index.html`; in
  `js/dashboard.js` add upload logic, pass `outputFormat` to `/clarify`, thread
  `assetToken` into `/plan` and `/start`. Bump `VERSION` in `public/sw.js`.
- `web/` React SaaS: mirror in the new-build flow — `src/api.js` (`clarify`/`plan`/`start`
  signatures + an `uploadAsset` call) and the new-build page (tray + state). Rebuild
  (`cd web && npm run build`).

## Testing (no-spend)

- Pure helpers via Node's built-in runner (`node --test ralph/*.test.mjs`):
  - `ralph/clarify-axes.test.mjs` — axis/cap/contentHeavy per format; unknown format →
    safe default.
  - `ralph/assets.test.mjs` — `validateAsset` (good/oversize/bad-type), `sanitizeAssetName`
    (traversal, unicode, collision), `stagedAssetManifest`, `staleStagedAssets` (TTL
    boundary), `assetKind`.
- End-to-end through the existing stub harness (`RALPH_FORCE_TOOL=stub`,
  `RALPH_FAKE_REMOTE=/path/to/bare.git`, `POST /api/ralph/start` with a `prd` object):
  confirm a run started with an `assetToken` commits `assets/brand/` + `MANIFEST.md` and
  that the imagery skill text lands in the worker brief. Tear down the drop-in and kill
  leftover `r-/rv-/rf-/app-` sessions afterward.
- The LLM clarify call itself stays untested (side-effectful), per existing convention —
  logic worth testing lives in `clarify-axes.mjs`.

## Files

New:
- `ralph/clarify-axes.mjs` + `ralph/clarify-axes.test.mjs`
- `ralph/assets.mjs` + `ralph/assets.test.mjs`
- `ralph/skills/imagery/SKILL.md`

Edit:
- `server.js` — clarify signature + prompt (via `clarify-axes`), `/api/ralph/clarify`
  body, new `POST /api/ralph/assets`, `/api/ralph/plan` asset manifest, `startRalphRun`
  asset commit, `monitorTick` prune, `writeRalphBrief` imagery wiring, `STAGED_ASSETS_DIR`
  const.
- `public/index.html`, `public/js/dashboard.js`, `public/sw.js` (VERSION bump).
- `web/src/api.js` + new-build page.
- `CLAUDE.md` (document the asset flow + imagery skill); `README.md` (Unsplash/Pexels env
  keys, optional).

## Follow-up (not this spec)

- AI image generation: image-model API key + spend controls, extending the imagery skill.
- Lightweight post-build visual/prompt editing (separate, larger effort).
