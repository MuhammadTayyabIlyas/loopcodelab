// Pure normalizer for a saved New Build draft (config + generated PRD). The server
// adds id/createdAt/updatedAt and persists it (per-tenant DB or a JSON file); on
// launch the draft's media/prd are handed to /api/ralph/start unchanged (which
// normalizeMedia/normalizePrd them). Pure → unit-tested.
import { familyOf } from './analyze.mjs';

const str = (v, n, def = '') => String(v ?? def).slice(0, n);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;

const ts = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

export function normalizeDraft(input) {
  const d = input || {};
  return {
    name: str(d.name || d.project || 'Untitled draft', 80),
    idea: str(d.idea, 8000),
    master: str(d.master || 'claude', 20),
    workers: Array.isArray(d.workers)
      ? [...new Set(d.workers.map((w) => str(w, 20)).filter(Boolean))].slice(0, 8) : [],
    model: str(d.model, 80),
    outputFormat: str(d.outputFormat || 'auto', 20),
    project: str(d.project, 63),
    media: obj(d.media),
    platforms: Array.isArray(d.platforms) ? d.platforms.map(String).slice(0, 8) : null,
    mediaModels: obj(d.mediaModels),
    clarify: Array.isArray(d.clarify) ? d.clarify.slice(0, 8) : [],
    prd: obj(d.prd),
    // Start timer: epoch ms when the draft should auto-start (null = no timer).
    startAt: ts(d.startAt),
    formatFamily: d?.formatFamily ? familyOf(d.formatFamily) : null,
  };
}

export function draftListItem(d) {
  return {
    id: d.id,
    name: d.name || 'Untitled draft',
    outputFormat: d.outputFormat || 'auto',
    stories: Array.isArray(d.prd?.stories) ? d.prd.stories.length : 0,
    updatedAt: d.updatedAt || 0,
    startAt: ts(d.startAt),
    startError: d.startError ? String(d.startError).slice(0, 300) : null,
  };
}

// --- start timer (one-shot, ChatGPT-tasks/Claude-routines style: the schedule lives on
// the stored task; the server clock fires it, the client need not be open) -------------

const MIN_START_DELAY_MS = 15_000;                 // floor: give the user a beat to cancel
const MAX_START_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// now + delay, clamped to sane bounds. null on a non-numeric delay.
export function scheduleAt(now, delayMs) {
  const d = Math.round(Number(delayMs));
  if (!Number.isFinite(d)) return null;
  return now + Math.min(MAX_START_DELAY_MS, Math.max(MIN_START_DELAY_MS, d));
}

// Drafts whose timer has passed (inclusive boundary; junk-tolerant).
export function dueDrafts(drafts, now) {
  return (Array.isArray(drafts) ? drafts : [])
    .filter((d) => d && Number.isFinite(Number(d.startAt)) && Number(d.startAt) > 0 && Number(d.startAt) <= now);
}

// Draft -> the /api/ralph/start request body. Timer/bookkeeping fields never leak in;
// a draft without an explicit project name lets the start route smart-name from the idea.
export function draftStartBody(d) {
  return {
    project: d?.project || '',
    idea: d?.idea || '',
    master: d?.master || 'claude',
    workers: Array.isArray(d?.workers) ? d.workers : [],
    model: d?.model || '',
    outputFormat: d?.outputFormat || 'auto',
    media: obj(d?.media),
    platforms: Array.isArray(d?.platforms) ? d.platforms.map(String).slice(0, 8) : null,
    mediaModels: obj(d?.mediaModels),
    prd: obj(d?.prd),
    clarify: Array.isArray(d?.clarify) ? d.clarify : [],
  };
}
