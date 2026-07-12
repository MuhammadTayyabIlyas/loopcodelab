# Media & Output-Quality Backlog — Design Spec

**Date:** 2026-07-01
**Status:** Backlog / decomposition spec (design approved per-feature before each build)
**Scope:** Three related follow-ups to the shipped media-generation subsystem (Plan 2), plus a
research-backed **quality-guidelines** layer that raises the bar of every generated deliverable.

## Goal

Move generated media from an *opportunistic build-time capability* to an *intentional, reviewable,
quality-guided* part of a Ralph build — and let a build be saved/resumed. Three sub-projects, one shared
quality layer:

- **Part 0 — Output-quality guidelines** (foundation): distilled best practices for generated imagery and
  for web / presentation output, encoded into the media skill + planner + finalize so output is good by
  default.
- **Part A — Media-aware planning:** the planner plans media into stories (and shows it in the confirm
  dialog) instead of the agent deciding on a whim.
- **Part B — Media-only output formats:** `image` / `video` / `audio` as first-class deliverables (the
  media file *is* the result), short-circuiting the multi-agent build.
- **Part C — Build drafts:** save a planned build and resume/edit/start it later.

These are independent — each gets its own spec → plan → build cycle. Build order + dependencies are in
the Roadmap. Part 0 is a prerequisite for A and improves the already-shipped Plan 2.

---

## Part 0 — Output-quality guidelines (foundation)

Distilled from current best-practice sources (see **Sources**). These become concrete rules baked into
`ralph/skills/imagery/SKILL.md` (the media skill), the planner brief, and the finalize brief — so quality
is the default, not luck.

### 0.1 When to generate (fallback order — unchanged intent, sharpened)
1. **Brand assets first** (`assets/brand/`). 2. **Generate** only when it adds real value — a hero shot,
an illustration, or a concept that isn't photographable — never to fill space. 3. **Free stock**
(Unsplash/Pexels). 4. **Tasteful placeholder**. *A wrong or generic image is worse than a good
placeholder.* Prefer authentic representation where real people/places matter.

### 0.2 Prompt quality (encode in the gen helpers' guidance / skill)
- **Structure every prompt:** subject → setting → **style** → lighting → technical (aspect ratio, quality).
- **Style = a project brand-guideline:** derive ONE project-level style descriptor (from brand/clarify —
  e.g. "flat vector, muted earth tones, minimal shadows, generous negative space") and **reuse it on every
  image** so the site/deck is visually cohesive (prevents the "each image looks different" drift).
- **2–3 quality modifiers** max ("sharp focus, professional product photography"); anchor in a familiar
  visual format rather than abstract adjectives.
- **Negative prompts** are specific: `no text, no watermark, no extra limbs, no extra UI`.
- **Aspect ratio matches the slot:** hero 16:9 / 21:9, card 4:3, slide full-bleed 16:9, avatar 1:1.

### 0.3 Placement quality
- **Web / landing:** the hero communicates the offer (a strong image *or* a short looping video); respect
  the hierarchy headline → subhead → hero media → benefits → social proof → CTA; keep the CTA the highest
  contrast; protect whitespace. Generated hero media reinforces the message — it is not decoration.
- **Presentation / slides:** **one high-res image per slide, one idea per slide**; full-bleed or
  supporting a single insight; no decorative clutter; never upscale past 100%. A data slide states one
  takeaway.

### 0.4 Accessibility (WCAG 1.1.1)
Every **informative** generated image gets descriptive `alt` (≤125 chars, essential info first, no
"image of"). **Decorative** images get `alt=""`. Video/audio: provide captions/transcript where it carries
meaning.

### 0.5 Licensing & provenance
The media providers here are **paid** (token-plan MaaS, BytePlus ModelArk, Suno, ElevenLabs) → commercial
rights generally apply; the user's **brand direction (clarify answers) is the human creative input** that
strengthens the position. Record provenance — **model + prompt per asset** — in `DELIVERABLE.md`. Surface
an "AI-assisted imagery" note where authenticity matters.

**Deliverable of Part 0:** an expanded media skill + a short `## Output quality` block injected into the
planner and finalize briefs. Small, high-leverage, no new subsystem.

---

## Part A — Media-aware planning

**Problem:** the planner is media-unaware (it never sees `run.media`), so media isn't planned, isn't shown
before you commit spend, and lands only if the building agent happens to generate it.

**Design:**
- **Feed the budget to the planner** (`planPrd` user prompt) alongside skills/tools/env: which kinds are
  enabled and their caps + the project style descriptor (0.2).
- **Per-story media intent:** `prd.json` stories gain an optional `media: {image?:n, video?:n, audio?:n}`
  hint, sanitized in `normalizePrd` and **clamped to the per-kind cap across the whole PRD** (so the plan
  can't exceed the build budget). The worker for that story generates exactly those assets and embeds them
  per Part 0's placement rules.
- **Reviewable in the confirm dialog:** planned media shown as editable chips per story ("hero video ×1",
  "product images ×3") with a running total vs. the cap, so the user approves the spend up front.
- **Final development:** unchanged shape — assets land in `assets/`, the deliverable references them, the
  preview/APK serves them, `DELIVERABLE.md` logs provenance — but now intentional and pre-approved.

**Depends on:** Part 0 (style descriptor + placement rules). **Touches:** `planner.md`, `planPrd`,
`normalizePrd`, `writeRalphBrief`, the confirm dialog in `web/` (+ optionally `public/`).

---

## Part B — Media-only output formats

**Problem:** there's no output where the deliverable *is* a generated video/image/audio — only media
*embedded in* a code/doc deliverable.

**Design (short-circuit, chosen):** add `image` / `video` / `audio` to `OUTPUT_FORMATS`. When one is
chosen, the orchestrator **skips the planner/stories/workers/master** entirely and runs a minimal path:
1. idea = the media prompt; a clarify step gathers style/duration/model/count.
2. the tick (or a dedicated `spawnMediaOnly`) calls the gen helper(s) **directly** (like
   `capture-shots.mjs` / `ralph-deliver.sh` are called — no agent), within the cap.
3. commit the file(s) + write `DELIVERABLE.md` (download link/QR, provenance); phase → `done`.

Reuses the existing run/status/preview/delivery/Web-Push/GitHub plumbing; a media build appears alongside
code builds with the same delivery. **Rejected alternatives:** forcing it through the full agent pipeline
(overkill, conceptual mismatch); a wholly separate UI (duplicates the studio).

**Note:** `video.tayyabcheema.com` is a purpose-built media studio (iteration, multi-model compare,
editing). Part B is for users who want *one* asset delivered through the same New Build surface; for
heavy media work, the studio remains the better tool — call this out in the UI.

**Depends on:** Part 0 (prompt quality). **Touches:** `OUTPUT_FORMATS`/`VISUAL_OUTPUT`, `ralphTick` (a
media-only branch), a `spawnMediaOnly` helper, `clarify-axes.mjs`, both New Build UIs.

---

## Part C — Build drafts

**Problem:** New Build is one-way — plan then start; closing loses the (expensive) generated PRD.

**Design (Option B — separate drafts store, chosen):** a per-tenant drafts store mirroring the
`prefs`/`soloModels` pattern (control.db table in multitenant, `drafts.json` single-tenant). A draft
captures the full pre-start state: idea, master/workers, output format, per-run model, media caps,
**clarify answers**, and the **generated PRD**.
- **Routes:** `GET /api/ralph/drafts` (list), `POST /api/ralph/drafts` (save/update), `DELETE
  /api/ralph/drafts/:id`.
- **UI:** a **"Save draft"** button beside "Start build" in the review step; a **Drafts** section (list /
  reopen / rename / delete); reopen loads config + PRD back into the review step; **Start** posts the
  draft's config to the existing `/api/ralph/start` (no re-plan).
- **Why not a `phase:'draft'` run:** keeps non-running drafts out of the `ralphRuns` map/tick entirely —
  zero risk to the orchestrator.

**Depends on:** nothing (independent). **Touches:** a `ralph/drafts.mjs` store + `saas/store.mjs`/`db.mjs`
(multitenant), 3 routes, the `web/` New Build review step + a Drafts list.

---

## Roadmap / build order

1. **Part 0 — quality guidelines** first: small, no new subsystem, and it immediately improves the
   *already-shipped* Plan 2 output. Prerequisite for A.
2. **Part C — drafts**: fully independent, high everyday UX value, low risk (no orchestrator changes).
   Good parallel/early win.
3. **Part A — media-aware planning**: the substantive one; needs Part 0's style/placement rules.
4. **Part B — media-only outputs**: last; niche vs. the studio, and benefits from A's media plumbing.

Each part is a separate spec → writing-plans → subagent-driven build (like Plans 1 & 2). Parts 0 and C can
proceed immediately and independently.

## Non-goals
- No changes to the media *providers* (Plan 2 already shipped them). Video/audio stay **off by default**.
- Part B does not replace the media studio; no in-loop video editing.
- No AI copyright/legal advice beyond recording provenance + surfacing a note.

## Sources
- AI images in web design: [Meta AI](https://ai.meta.com/learn/ai-creativity/how-to-use-ai-for-design-use-cases-and-best-practices/), [McGill Web Services](https://www.mcgill.ca/web-services/article/news-policies-directives-tips/best-practices-ai-generated-images-mcgill-websites), [Figma](https://www.figma.com/resource-library/how-to-use-ai-to-create-a-website/)
- Landing/hero: [ContentMation](https://contentmation.com/conversion/hero-section-design-guide), [Monet](https://www.monet.design/blog/posts/hero-section-design-pro-tips)
- Presentations: [UCSD Multimedia](https://multimedia.ucsd.edu/best-practices/presentation-design.html), [Garr Reynolds](https://www.garrreynolds.com/design-tips)
- Alt text / WCAG: [W3C WAI Decorative](https://www.w3.org/WAI/tutorials/images/decorative/), [W3C WAI alt decision tree](https://www.w3.org/WAI/tutorials/images/decision-tree/)
- AI prompt quality: [LTX prompt guide](https://ltx.io/blog/ai-image-prompt-guide), [OpenAI image-gen prompting](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide), [Leonardo.Ai](https://leonardo.ai/news/ai-image-prompts)
- Licensing: [getimg.ai](https://getimg.ai/blog/can-ai-generated-images-and-videos-be-used-commercially), [VLP Law Group](https://www.vlplawgroup.com/blog/2025/06/02/copyright-and-ai-generated-images-what-you-need-to-know-a-blog-post-by-michael-whitener/), [FADEL](https://fadel.com/resources/who-owns-ai-generated-content-the-truth-about-rights-and-licensing/)
