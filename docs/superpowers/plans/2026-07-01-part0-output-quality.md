# Output-Quality Guidelines (Part 0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake research-backed quality rules (prompt structure + one consistent project style, web/slide placement, alt-text/WCAG, provenance) into the media skill and the planner brief so every generated deliverable is good by default.

**Architecture:** Pure prompt/instruction content — no new code. Expand the vendored `ralph/skills/imagery/SKILL.md` (already injected into worker AND finalize briefs by `writeRalphBrief` for `VISUAL_OUTPUT` formats) and add one imagery-quality bullet to `ralph/planner.md`'s existing quality section. This immediately improves the already-shipped Plan 2 output.

**Tech Stack:** Markdown prompt files consumed by `loadSkillsCatalog`/`getSkillMd` (skill) and `planPrd` (planner).

## Global Constraints

- Content-only change: no `.mjs`/`server.js` edits, so **no unit tests and no restart needed** — the skill/planner files are re-read from disk each build (`getSkillMd` reads the vendored file; `planPrd` reads `planner.md`).
- Keep the skill's existing **fallback order** (brand → generate → stock → placeholder) and its `$RALPH_GEN_IMAGE/VIDEO/AUDIO` helper commands + the **exit 3 = fall back** rule intact.
- The quality rules are copied verbatim from the spec `docs/superpowers/specs/2026-07-01-media-quality-backlog-design.md` Part 0: prompt structure `subject → setting → style → lighting → technical`; ONE reused project **style descriptor**; 2–3 quality modifiers; specific negative prompts; aspect ratio per slot; web hero + slide "one image/one idea" placement; informative `alt` ≤125 chars / decorative `alt=""` (WCAG 1.1.1); record model+prompt provenance in `DELIVERABLE.md`.
- Manual-checkpoint repo — commit only in the task's commit step.

---

### Task 1: Expand the imagery/media skill with the quality rules

**Files:**
- Modify: `ralph/skills/imagery/SKILL.md` (full rewrite — same fallback order, adds quality/placement/a11y sections)

**Interfaces:**
- Consumes: nothing. Produces: the injected media-quality guidance every visual build's worker + finalize agent reads.

- [ ] **Step 1: Replace the skill file** with this exact content:

```md
---
name: imagery
description: Use brand assets first, else generate images/video/audio via the media helpers (within budget) in ONE consistent project style, else free stock — always with good alt text and recorded provenance.
---

# Imagery & media

Media should look intentional and cohesive, never generic. When the project needs images (hero shots,
product photos, icons, backgrounds) — or video/audio when enabled — follow this order and these quality rules.

## Fallback order
1. **Brand assets first.** Check `assets/brand/` and read `assets/brand/MANIFEST.md`; use the provided
   logo/images and match the named brand colors. Reference them by relative path so the built site/app serves them.
2. **Generate (only when enabled)** — only when a brand asset or a good stock image won't do, and only where
   it adds real value (a hero shot, an illustration, a concept that can't be photographed). Never generate to
   fill space; prefer authentic representation where real people/places matter. See "Generating well".
3. **Free stock** — if `UNSPLASH_ACCESS_KEY`/`PEXELS_API_KEY` is set, fetch a relevant, correctly-licensed
   image and attribute it; otherwise a keyless placeholder `https://picsum.photos/seed/<slug>/<w>/<h>` for
   photos, or a simple inline SVG for logos/illustrations.
4. **A tasteful placeholder beats a wrong or generic image.** Never block the build on media.

## Generating well (the media helpers)
Decide ONE **project style descriptor** up front from the brand/idea — e.g. "flat vector, muted earth tones,
minimal shadows, generous negative space" — and REUSE it in every prompt so the whole site/deck is visually
cohesive (this prevents each image looking different). Structure every prompt as
**subject → setting → style (the descriptor) → lighting → technical**. Use 2–3 quality modifiers
(e.g. "sharp focus, professional product photography"), anchor in a familiar visual format rather than
abstract adjectives, and add specific negatives (`no text, no watermark, no extra elements`). Match the
aspect ratio to the slot: hero 16:9 or 21:9, card 4:3, slide 16:9 full-bleed, avatar 1:1.
- **Image:** `node "$RALPH_GEN_IMAGE" "<structured prompt>" <relative/output/path.png>` — prints the saved
  path. Exit 3 = budget reached/disabled → fall back to stock or a placeholder.
- **Video** (only if enabled): `node "$RALPH_GEN_VIDEO" "<prompt>" <path.mp4> [--duration 5] [--ratio 16:9]`.
- **Music** (only if enabled): `node "$RALPH_GEN_AUDIO" "<prompt>" <path.mp3> --type music [--instrumental]`.
- **Voiceover/narration** (only if enabled): `node "$RALPH_GEN_AUDIO" "<script>" <path.mp3> --type voiceover`.

## Placement
- **Web / landing:** the hero communicates the offer — a strong image OR a short looping video. Respect the
  order headline → subhead → hero media → benefits → social proof → CTA; keep the CTA the highest-contrast
  element; protect whitespace. Hero media reinforces the message; it is not decoration.
- **Slides / presentation:** ONE high-resolution image per slide, ONE idea per slide, full-bleed or
  supporting a single insight; never upscale past 100%; avoid decorative clutter.

## Accessibility & provenance
- **Informative** images get descriptive `alt` (≤125 chars, essential info first, no "image of"/"picture of").
  **Decorative** images get `alt=""` so screen readers skip them (WCAG 1.1.1). Provide captions/a transcript
  for video/audio that carries meaning.
- Record each generated or sourced asset in `DELIVERABLE.md` — for generated media the model + prompt; for
  stock the provider + query/URL. Never hotlink paid/copyrighted images or embed credentials in URLs.
```

- [ ] **Step 2: Verify the skill still parses + is discovered**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
node --input-type=module -e "import('./ralph/solo-models.mjs').then(()=>{})" 2>/dev/null; head -4 ralph/skills/imagery/SKILL.md
grep -c '\$RALPH_GEN_IMAGE\|\$RALPH_GEN_VIDEO\|\$RALPH_GEN_AUDIO' ralph/skills/imagery/SKILL.md
```
Expected: the frontmatter (`---`/`name: imagery`/`description:`/`---`) is intact, and the grep prints `3` (all three helper commands preserved).

- [ ] **Step 3: Commit**

```bash
git add ralph/skills/imagery/SKILL.md
git commit -m "feat(skill): imagery quality rules — consistent style, placement, alt text, provenance"
```

---

### Task 2: Add imagery-quality guidance to the planner

**Files:**
- Modify: `ralph/planner.md` (the "Production-grade quality & design" section, currently ending at the bullet about embedding guidance in stories — the block at lines ~95-109)

**Interfaces:**
- Consumes: nothing. Produces: the planner now bakes a consistent visual style + alt-text expectation into story descriptions (without over-specifying individual assets — that's a later feature).

- [ ] **Step 1: Add the media bullet.** In `ralph/planner.md`, find this exact line (the last bullet of the quality section):

```md
- Keep this as guidance EMBEDDED in the build stories (their description +
  acceptanceCriteria) — do NOT add a separate "make it pretty" story. Every story
  carries its own slice of the quality and design bar.
```

Insert immediately BEFORE it:

```md
- Imagery & media: when a UI, deck, or site benefits from imagery, name ONE consistent
  visual style for the project (a "style descriptor" — palette, illustration/photo style,
  mood) in the relevant stories so all imagery is cohesive, and require descriptive alt
  text (decorative images get empty alt). Say WHERE imagery genuinely adds value (e.g. a
  hero shot, section illustrations) rather than specifying every asset — the build's
  imagery skill generates within the build's media budget.
```

- [ ] **Step 2: Verify**

Run:
```bash
cd /var/www/tmux.tayyabcheema.com
grep -n "style descriptor" ralph/planner.md && grep -c "Every story" ralph/planner.md
```
Expected: the new bullet is present (one `style descriptor` match) and the original closing bullet is still there (`Every story` → `1`).

- [ ] **Step 3: Commit**

```bash
git add ralph/planner.md
git commit -m "feat(planner): imagery quality — one consistent style + alt text in stories"
```

---

### Task 3: Regression check + docs

**Files:**
- Modify: `CLAUDE.md` (the Imagery skill note in the Brand & visual inputs section — one sentence)

- [ ] **Step 1: Full suite still green** (nothing code changed, but confirm no accidental edits):

```bash
cd /var/www/tmux.tayyabcheema.com && node --test ralph/*.test.mjs 2>&1 | tail -3
```
Expected: `# fail 0`.

- [ ] **Step 2: Note the quality rules in CLAUDE.md.** Find the sentence in the "Imagery skill" bullet that begins `Vendored \`ralph/skills/imagery/SKILL.md\`` and append to that paragraph:

```md
The skill now also carries the output-quality rules (one consistent project style descriptor reused across
all prompts; prompt structure subject→setting→style→lighting→technical; web-hero / one-image-per-slide
placement; informative alt ≤125 chars vs decorative alt=""; model+prompt provenance in DELIVERABLE.md) — see
`docs/superpowers/specs/2026-07-01-media-quality-backlog-design.md` Part 0.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): note imagery quality rules in the imagery skill"
```

---

## Self-Review
- **Spec coverage (Part 0):** prompt structure + style descriptor → Task 1 (Generating well). Web/slide placement → Task 1 (Placement). Alt text/WCAG → Task 1 (Accessibility). Provenance/licensing → Task 1 (provenance) + the paid-provider commercial note lives in the spec. Planner bakes style+alt into stories → Task 2. Docs → Task 3. ✓
- **Placeholder scan:** none — the full skill file and the exact planner bullet are given verbatim.
- **Type consistency:** n/a (content only). The helper command names (`$RALPH_GEN_IMAGE/VIDEO/AUDIO`) match what `ralphEnvPrefix` injects (Plan 2).
- **Note:** this plan is intentionally content-only and small; it has no TDD cycle because there is no logic to test — verification is "the files parse + inject and the suite is unaffected." If executed subagent-driven, a single implementer can do all three tasks; the review checks the prose is accurate and the fallback order/helper commands are intact.
