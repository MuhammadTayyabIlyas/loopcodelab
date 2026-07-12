// ralph/story-ops.mjs — pure logic for story-level editing: schedule clamping,
// manual-story validation, and the edit/regenerate/blocked decision per status.
// (Spec: docs/superpowers/specs/2026-07-03-story-editing-design.md)

export const MIN_STORY_DELAY_MS = 15_000;                    // floor: a beat to change your mind
export const MAX_STORY_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (mirrors draft timers)

// Epoch-ms start time for a story, clamped; anything non-finite -> null (= start now).
export function clampStoryStart(startAt, now) {
  if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return null;
  return Math.min(now + MAX_STORY_DELAY_MS, Math.max(now + MIN_STORY_DELAY_MS, startAt));
}

// Validate + shape a hand-written story. Caller owns run-level defaults
// (assignee -> run.master) and flags (revision), which need run state.
export function normalizeNewStory(input, existingIds, validAgents) {
  const title = String(input?.title || '').trim().slice(0, 200);
  if (!title) return { error: 'A story needs a title.' };
  const agent = String(input?.agent || '').trim();
  if (agent && !validAgents.includes(agent)) return { error: 'Invalid agent.' };
  const ids = Array.isArray(existingIds) ? existingIds : [];
  const n = Math.max(0, ...ids.map((i) => Number(/^s(\d+)$/.exec(String(i))?.[1] || 0))) + 1;
  const id = `s${n}`;
  return {
    story: {
      id,
      title,
      description: String(input?.description || '').slice(0, 4000),
      acceptanceCriteria: (Array.isArray(input?.acceptanceCriteria) ? input.acceptanceCriteria : [])
        .map((c) => String(c).slice(0, 500)).filter(Boolean).slice(0, 20),
      assignee: agent || null,
      deps: (Array.isArray(input?.deps) ? input.deps : []).filter((d) => ids.includes(d)),
      branch: `prd/${id}`,
      status: 'todo',
      iterations: 0,
    },
  };
}

// What an edit request means for a story in this status.
// merged -> rebuild-on-top regeneration; reverted -> refused (its code is gone
// from main — a "regenerate" would lie); everything else -> plain edit.
export function editKind(status) {
  if (status === 'merged') return 'regenerate';
  if (status === 'reverted') return null;
  return 'edit';
}
