// Pure revision-scoping helpers for /api/ralph/revise (server.js).
// A revision edits a FINISHED app: stories must be proportional to the
// instruction, and media generation must be explicitly asked for — the
// motivating bug was a one-line retheme that got 8 acceptance criteria
// plus media:{image:2} and burned a full reject/retry cycle.

// Appended to the revise planner's `research` context (planPrd). Prompt-level
// on purpose: instructing the planner degrades gracefully; code-truncating
// its output can drop the requested change itself.
export const REVISE_PLANNER_RULES = `Revision story rules (MANDATORY):
- Prefer ONE story unless the instruction lists clearly independent changes.
- Acceptance criteria: at most 4 per story, and they must test ONLY the
  requested change plus exactly one regression criterion ("everything not
  mentioned still works and the app still builds/renders").
- Do NOT add criteria about README updates, HTML validation, responsive
  sweeps, light/dark polish, or accessibility audits unless the instruction
  asks for them.
- Do NOT assign story media (image/video/audio counts) unless the instruction
  explicitly asks for new imagery, video, or audio.`;

const KIND_RE = {
  image: /\b(image|images|imagery|photo|photos|picture|pictures|illustration|graphic|logo|icon|banner|artwork)\b/i,
  video: /\b(video|videos|animation|clip|footage)\b/i,
  audio: /\b(audio|music|sound|soundtrack|voiceover|voice-over|narration|jingle)\b/i,
};

// Which media kinds does the revision instruction actually ask for?
export function mentionsMediaKinds(idea) {
  const s = String(idea || '');
  return {
    image: KIND_RE.image.test(s),
    video: KIND_RE.video.test(s),
    audio: KIND_RE.audio.test(s),
  };
}

// Deterministic guard behind REVISE_PLANNER_RULES: even if the planner
// assigns media anyway, strip kinds the instruction never mentioned
// (media = spend + one more thing a strict reviewer can reject on).
export function clampReviseMedia(stories, idea) {
  const asked = mentionsMediaKinds(idea);
  for (const story of stories || []) {
    if (!story || typeof story.media !== 'object' || !story.media) continue;
    const kept = {};
    for (const [kind, n] of Object.entries(story.media)) {
      if (asked[kind] && Number(n) > 0) kept[kind] = n;
    }
    if (Object.keys(kept).length) story.media = kept;
    else delete story.media;
  }
  return stories;
}
