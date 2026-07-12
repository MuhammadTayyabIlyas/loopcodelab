// server/prefs.mjs — cross-project user memory: preference signals + distilled
// defaults, build drafts, subscription tracking, and the LLM-refreshed profile
// note. Per-tenant rows in the control DB when multitenant; JSON files otherwise.
import path from 'node:path';
import * as saasStore from '../saas/store.mjs';
import { DATA_DIR, readJson, writeJson } from './config.mjs';
import { openaiKey } from './secrets.mjs';
import { callPlanner, extractJson } from './llm.mjs';

// --- User preferences (cross-project memory) --------------------------------
// PER-TENANT in multi-tenant mode (a `prefs` row in the control DB per workspace
// — one user's choices must never shape another's defaults); the single global
// prefs file otherwise (byte-identical to the old behavior). We append the user's
// choices as capped raw `signals`, distill them deterministically into `prefs`
// (defaults the UI/planner seed from), and — after a run finishes — summarize
// them into a natural-language `profileNote` plus a list of user-model `facts`
// (one LLM call, on the tenant's own credential) injected into the planner.
// Suggest-only: every value is a default the user can still override at confirm.
const PREFS_FILE = path.join(DATA_DIR, 'preferences.json');
const PREFS_MAX_SIGNALS = 200;
let prefsCache = null;

export const prefsShape = (p) => ({
  signals: Array.isArray(p?.signals) ? p.signals : [],
  prefs: p?.prefs && typeof p.prefs === 'object' ? p.prefs : {},
  profileNote: typeof p?.profileNote === 'string' ? p.profileNote : '',
});
export async function loadPrefs(tenant = null) {
  if (tenant) {
    try { return prefsShape(saasStore.getPrefs(tenant.id)); } catch { return prefsShape(null); }
  }
  if (prefsCache) return prefsCache;
  prefsCache = prefsShape(await readJson(PREFS_FILE, null));
  return prefsCache;
}
export async function savePrefs(p, tenant = null) {
  if (tenant) { try { saasStore.setPrefs(tenant.id, p); } catch { /* best-effort */ } return; }
  prefsCache = p;
  await writeJson(PREFS_FILE, p);
}

// Build drafts: per-tenant DB (multi-row) in multitenant, a JSON file otherwise
// (object keyed by id). Mirrors the prefs file-vs-tenant split.
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
export async function loadDraftsList(tenant) {
  if (tenant) { try { return saasStore.listDrafts(tenant.id); } catch { return []; } }
  const map = await readJson(DRAFTS_FILE, {});
  return Object.entries(map).map(([id, d]) => ({ ...d, id }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function saveDraftFor(tenant, id, draft) {
  const ts = Date.now();
  if (tenant) return saasStore.saveDraft(tenant.id, id || null, { ...draft, updatedAt: ts });
  const map = await readJson(DRAFTS_FILE, {});
  const draftId = id || crypto.randomUUID();
  map[draftId] = { ...draft, updatedAt: ts, createdAt: map[draftId]?.createdAt || ts };
  await writeJson(DRAFTS_FILE, map);
  return draftId;
}
export async function deleteDraftFor(tenant, id) {
  if (tenant) { try { saasStore.deleteDraft(tenant.id, id); } catch { /* best-effort */ } return; }
  const map = await readJson(DRAFTS_FILE, {});
  delete map[id];
  await writeJson(DRAFTS_FILE, map);
}

// Subscription tracking notes (Settings "Track" dialog): per-tenant map of
// provider -> {startDate,endDate,peakHours,usage,notes,link}. Display-only planning
// metadata (never a secret, never gates a build). Tenant DB row / a JSON file otherwise.
const TRACKING_FILE = path.join(DATA_DIR, 'tracking.json');
export async function loadTracking(tenant) {
  if (tenant) { try { return saasStore.getTracking(tenant.id); } catch { return {}; } }
  return readJson(TRACKING_FILE, {});
}
export async function saveTracking(tenant, map) {
  if (tenant) { try { saasStore.setTracking(tenant.id, map); } catch { /* best-effort */ } return; }
  await writeJson(TRACKING_FILE, map);
}

// Append a signal, re-distill the deterministic prefs, persist. Best-effort —
// memory must never break a build or a request.
export async function recordPrefSignal(sig, tenant = null) {
  try {
    const p = await loadPrefs(tenant);
    p.signals.push({ ...sig, ts: Date.now() });
    if (p.signals.length > PREFS_MAX_SIGNALS) p.signals = p.signals.slice(-PREFS_MAX_SIGNALS);
    p.prefs = distillPrefs(p.signals);
    await savePrefs(p, tenant);
  } catch { /* best-effort */ }
}

// Record how one story attempt resolved, attributed to the agent that did it — the
// richest reliability signal (drives distilled scores + auto-rerouting). Fire-and-
// forget; never block the tick on memory.
export function recordOutcome(run, story, result) {
  recordPrefSignal({
    type: 'outcome', agent: story.assignee, result, // 'accept' | 'reject' | 'stall'
    outputType: story.outputType || 'auto',
    skills: Array.isArray(story.skills) ? story.skills.slice(0, 4) : [],
  }, run.tenant || null).catch(() => {});
}

// The plan the user APPROVES often differs from what the planner proposed —
// removed stories, added stories, swapped agents, changed formats. That diff is
// the most direct statement of taste we get; stash the proposal at /plan time and
// diff it against the prd the user actually starts with. Keyed per tenant (or
// 'local' single-tenant), 1h TTL — best-effort, never blocks a start.
const lastPlannedPrd = new Map(); // key -> { prd, at }
const plannedKeyFor = (tenant) => (tenant ? tenant.slug : 'local');
export function stashPlannedPrd(tenant, prd) {
  lastPlannedPrd.set(plannedKeyFor(tenant), { prd, at: Date.now() });
  if (lastPlannedPrd.size > 200) lastPlannedPrd.delete(lastPlannedPrd.keys().next().value);
}
export async function recordPrdEditSignal(tenant, finalPrd) {
  if (!finalPrd || typeof finalPrd !== 'object') return; // no client-side prd → nothing user-edited
  const stash = lastPlannedPrd.get(plannedKeyFor(tenant));
  if (!stash || Date.now() - stash.at > 60 * 60 * 1000) return;
  lastPlannedPrd.delete(plannedKeyFor(tenant));
  const a = Array.isArray(stash.prd?.stories) ? stash.prd.stories : [];
  const b = Array.isArray(finalPrd.stories) ? finalPrd.stories : [];
  const byId = (l) => new Map(l.filter((s) => s?.id).map((s) => [s.id, s]));
  const am = byId(a), bm = byId(b);
  const removed = a.filter((s) => s?.id && !bm.has(s.id)).map((s) => String(s.title || s.id).slice(0, 80));
  const added = b.filter((s) => s?.id && !am.has(s.id)).map((s) => String(s.title || s.id).slice(0, 80));
  let assigneeSwaps = 0, outputChanges = 0;
  for (const [id, s] of bm) {
    const o = am.get(id);
    if (!o) continue;
    if (s.assignee && o.assignee && s.assignee !== o.assignee) assigneeSwaps++;
    if (s.outputType && o.outputType && s.outputType !== o.outputType) outputChanges++;
  }
  if (!removed.length && !added.length && !assigneeSwaps && !outputChanges) return;
  await recordPrefSignal({
    type: 'prd-edit',
    removed: removed.slice(0, 6), added: added.slice(0, 6),
    assigneeSwaps, outputChanges,
  }, tenant);
}

// Deterministic distillation: recency-weighted tallies over the signals (14-day
// half-life, so recent choices win). Returns the modal master/workers/output and
// agents the user has repeatedly swapped away from.
export function distillPrefs(signals) {
  const now = Date.now();
  const HALF_LIFE = 1000 * 60 * 60 * 24 * 14;
  const wOf = (s) => Math.pow(0.5, (now - (s.ts || now)) / HALF_LIFE);
  const tally = {};
  const bump = (cat, key, w) => { if (!key) return; (tally[cat] = tally[cat] || {})[key] = (tally[cat][key] || 0) + w; };
  const penalty = {};
  const rel = {}; // agent -> recency-weighted {pos, neg} from build outcomes
  for (const s of signals) {
    const w = wOf(s);
    if (s.type === 'start') {
      bump('master', s.master, w);
      if (s.outputFormat && s.outputFormat !== 'auto') bump('outputFormat', s.outputFormat, w);
      for (const wk of s.workers || []) bump('worker', wk, w);
      for (const ot of s.storyOutputs || []) if (ot && ot !== 'auto') bump('outputFormat', ot, w * 0.5);
    } else if (s.type === 'swap' && s.from) {
      penalty[s.from] = (penalty[s.from] || 0) + w;
    } else if (s.type === 'outcome' && s.agent) {
      const r = (rel[s.agent] = rel[s.agent] || { pos: 0, neg: 0 });
      if (s.result === 'accept') r.pos += w; else r.neg += w; // reject / stall
    }
  }
  const top = (cat) => { const t = tally[cat]; return t ? (Object.entries(t).sort((a, b) => b[1] - a[1])[0]?.[0] || null) : null; };
  const topN = (cat, n) => { const t = tally[cat]; return t ? Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k) : []; };
  // Smoothed acceptance rate per agent (Laplace prior so tiny samples aren't 0/1).
  const agentReliability = {};
  for (const [a, r] of Object.entries(rel)) agentReliability[a] = Number(((r.pos + 0.5) / (r.pos + r.neg + 1)).toFixed(2));
  // "Unreliable" = the user keeps swapping away from it, OR poor acceptance over a
  // meaningful number of observed attempts.
  const swapUnreliable = Object.entries(penalty).filter(([, v]) => v >= 1.5).map(([k]) => k);
  const outcomeUnreliable = Object.keys(agentReliability).filter((a) => (rel[a].pos + rel[a].neg) >= 2 && agentReliability[a] < 0.4);
  return {
    preferredMaster: top('master'),
    workers: topN('worker', 3),
    defaultOutputFormat: top('outputFormat'),
    agentReliability,
    unreliableAgents: [...new Set([...swapUnreliable, ...outcomeUnreliable])],
    updatedAt: now,
  };
}

// One short natural-language profile note + (multi-tenant) a consolidated list of
// user-model FACTS from recent signals, for the planner to read. Runs on the
// tenant's own credential via callPlanner. Best-effort, called when a run finishes.
const FACT_KINDS = ['stack', 'design', 'feature', 'workflow', 'agent', 'other'];
export async function refreshProfileNote(tenant = null) {
  try {
    if (!tenant && !openaiKey()) return;
    const p = await loadPrefs(tenant);
    if (!p.signals.length) return;
    const oldFacts = tenant ? (() => { try { return saasStore.listFacts(tenant.id); } catch { return []; } })() : [];
    const sys = 'You distill ONE user\'s software-build preferences from their recent choices — agent '
      + 'picks, output formats, edits they made to proposed plans ("prd-edit" signals: stories they removed/'
      + 'added), revision requests ("revise" signals: what the build got wrong), and their answers to '
      + 'scoping questions (the "clarify" signals: stack, styling, features, auth, persistence). Produce: '
      + '(1) "profileNote": one short paragraph (<= 70 words) of their CONSISTENT preferences, usable by a '
      + 'planner to pick better defaults — state only patterns the data supports; '
      + '(2) "facts": the user model as <= 20 short standalone statements, each {"kind": one of '
      + `${JSON.stringify(FACT_KINDS)}, "text": "<= 120 chars", "weight": 1-5 confidence}. You are given the `
      + 'PREVIOUS facts — keep the ones still supported (raise weight if reconfirmed), drop or rewrite '
      + 'contradicted ones, add new ones. Facts must be specific and actionable ("always removes auth '
      + 'stories from plans"), never vague ("likes good design"). '
      + 'Return ONLY JSON: {"profileNote":"...","facts":[...]}.';
    const raw = await callPlanner([
      { role: 'system', content: sys },
      { role: 'user', content: `Recent choices (JSON):\n${JSON.stringify(p.signals.slice(-60))}\n\n`
        + `Distilled prefs:\n${JSON.stringify(p.prefs)}\n\n`
        + `Previous facts:\n${JSON.stringify(oldFacts.map((f) => ({ kind: f.kind, text: f.text, weight: f.weight })))}` },
    ], { json: true, tenant });
    const parsed = extractJson(raw) || {};
    if (typeof parsed.profileNote === 'string' && parsed.profileNote.trim()) {
      p.profileNote = parsed.profileNote.trim().slice(0, 600);
      await savePrefs(p, tenant);
    }
    if (tenant && Array.isArray(parsed.facts)) {
      const facts = parsed.facts
        .map((f) => ({
          kind: FACT_KINDS.includes(f?.kind) ? f.kind : 'other',
          text: String(f?.text || '').trim().slice(0, 160),
          weight: Math.min(5, Math.max(1, Number(f?.weight) || 1)),
        }))
        .filter((f) => f.text)
        .slice(0, 20);
      try { saasStore.replaceFacts(tenant.id, facts); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}
