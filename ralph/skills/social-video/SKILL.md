---
name: social-video
description: Build a short (~30s) social story video and render it per platform (TikTok/Instagram/YouTube/LinkedIn dimensions) using the media helpers and $RALPH_COMPOSE.
---

# Social video deliverable

You are producing a short story video (default ~30 seconds) delivered as ONE file
per target platform, each at that platform's exact dimensions. The target platform
list is in `$RALPH_PLATFORMS` (comma-separated) and in your brief.

## Workflow (in this order)

1. **Storyboard first.** Write `STORYBOARD.md`: 4–8 scenes, each with a one-line
   visual description, on-screen text (if any), and seconds — total duration ≈ the
   target length. Commit it before generating anything.
2. **One style.** Define ONE project style descriptor (subject → setting → style →
   lighting → technical) and reuse it in EVERY generation prompt (imagery skill rule).
   Use `assets/brand/` colors/logo when present.
3. **Generate scene assets** with the media helpers (they enforce the build's budget;
   exit 3 = skipped → use a brand asset or stock instead, never block):
   - stills: `$RALPH_GEN_IMAGE "<style> — <scene>" scenes/s1.png`
   - motion moments (budget is small — use for 1–2 hero scenes only):
     `$RALPH_GEN_VIDEO "<style> — <scene>" scenes/s2.mp4 --duration 5 --ratio 9:16`
   - audio bed: `$RALPH_GEN_AUDIO "<mood, genre, instruments>" audio/bed.mp3 --type music --instrumental`
     and/or voiceover: `$RALPH_GEN_AUDIO "<script text>" audio/vo.mp3 --type voiceover`
     (voiceover = best pronunciation; write the script with plain spellings).
4. **Write `storyboard.json`** — the machine-readable version of your storyboard.
   This is your main creative artifact; the vendored pipeline executes it:

   ```json
   {
     "title": "Product promo",
     "platform": "tiktok",
     "audio": "audio/bed.mp3",
     "text": { "content": "Your hook line", "color": "#FF5500" },
     "scenes": [
       { "image": "scenes/s1.png", "seconds": 3 },
       { "clip":  "scenes/s2.mp4" },
       { "image": "scenes/s3.png", "seconds": 4 }
     ]
   }
   ```

   Scenes play in order (each needs an `image` or `clip` path; `seconds` 1–10 for
   stills). `audio` and `text` are optional; text is drawn inside the platform-safe
   bottom margin — keep it ≤ 8 words.
5. **Compose + render every platform in ONE call:**
   `node "$RALPH_COMPOSE" story storyboard.json --out output/story --platforms $RALPH_PLATFORMS`
   → slideshow/stitch/audio/text/per-platform renders all happen internally, each
   output self-verified, written as `output/story-<platform>.mp4`. These names are
   REQUIRED — the build's verification report matches `*-<platform>.mp4`.
   To revise: edit `storyboard.json` (or regenerate one asset) and re-run the same
   command. Advanced/manual subcommands (`slideshow`, `stitch`, `overlay-text`,
   `render-platforms`) exist for cases the storyboard shape can't express.
6. **Preview gallery in ONE call:**
   `node "$RALPH_COMPOSE" gallery output --out index.html --title "<project name>" --color '<brand hex>'`
   writes the repo-root gallery page (one player per platform render). Do not
   hand-write it. (The project's preview subdomain serves it.)
7. **Provenance.** Record every generated asset (helper, model if known, prompt) and
   every output file in `DELIVERABLE.md`.

## Rules

- Never run raw `ffmpeg` yourself — always `node "$RALPH_COMPOSE" …` (it enforces caps
  and verifies dimensions). If it exits 3 (cap reached), ship what exists and note it.
- Respect the media budget from your brief; prefer stills over video clips.
- Keep total scene text readable: ≤ 8 words per overlay.
- Do NOT commit the media binaries (`output/`, `scenes/`, `audio/` are gitignored) — the
  finished renders upload to Google Drive automatically when the build completes. DO commit
  `storyboard.json`, `DELIVERABLE.md`, and `index.html`.
