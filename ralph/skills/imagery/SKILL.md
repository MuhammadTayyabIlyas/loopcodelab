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
