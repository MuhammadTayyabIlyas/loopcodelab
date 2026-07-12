// server/planner.mjs — turns an idea into a normalised prd.json: environment
// probe, optional web grounding, the PRD planner + clarify prompts, and the
// sanitiser every PRD passes through (stories clamped to known agents/formats).
import path from 'node:path';
import fs from 'node:fs/promises';
import * as saasStore from '../saas/store.mjs';
import { clarifyAxesFor } from '../ralph/clarify-axes.mjs';
import { normalizeMedia, applyMediaPlan } from '../ralph/providers.mjs';
import { SONAR_MODEL, shouldGround, researchPrompt, parseSonar, groundingBlock } from '../ralph/research.mjs';
import { execFileAsync, RALPH_DIR } from './config.mjs';
import { perplexityKey } from './secrets.mjs';
import { OUTPUT_FORMATS, mcpCapabilitiesFor, loadSkillsCatalog } from './skills.mjs';
import { VALID_AGENTS } from './agents.mjs';
import { callPlanner, extractJson } from './llm.mjs';
import { loadPrefs } from './prefs.mjs';

// Planner: idea + agent roster -> a normalised prd.json (stories assigned to
// agents). Unknown/missing assignees are clamped to the master; ids/branches are
// regenerated so downstream code can trust their shape.
// Probe which runtimes/tools the deploy box actually has, so the planner targets
// a viable stack instead of guessing. Cached briefly (the env rarely changes).
export const ENV_TOOLS = ['node', 'npm', 'pnpm', 'yarn', 'python3', 'pip3', 'flutter', 'dart', 'go', 'php', 'ruby', 'java', 'deno', 'bun'];
let envCache = null, envCacheAt = 0;
export async function detectEnvironment() {
  if (envCache && Date.now() - envCacheAt < 60_000) return envCache;
  const probe = ENV_TOOLS.map((t) => `command -v ${t} >/dev/null 2>&1 && echo ${t}`).join('; ');
  let avail = [];
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', probe], { timeout: 8000 });
    avail = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* fall back to empty */ }
  envCache = avail; envCacheAt = Date.now();
  return avail;
}

// Phase B (perplexity/apify plan): ground the PRD in current reality. One cheap Sonar
// call (web search + citations built in) fetches domain/competitor/library facts the
// planner cannot know from training data. Suggest-only and best-effort: no key, a
// timeout, an API error, or the stub harness all yield '' and planning proceeds as before.
export async function groundIdea(idea, outputFormat, tenant) {
  if (process.env.RALPH_FORCE_TOOL) return ''; // no-spend harness: deterministic planning
  let key = null;
  if (tenant) { try { key = saasStore.getProviderKey(tenant.id, 'perplexity'); } catch { key = null; } }
  key = key || perplexityKey();
  if (!key || !shouldGround(idea, outputFormat)) return '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SONAR_MODEL,
        messages: researchPrompt(idea, outputFormat),
        max_tokens: 900,
        web_search_options: { search_context_size: 'low' }, // cheapest request tier
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return '';
    const { content, citations } = parseSonar(await res.json());
    return groundingBlock(content, citations);
  } catch { return ''; }
}

export async function planPrd({ idea, master, workers, answers, outputFormat, tenant = null, research = '', media = null }) {
  const roster = [master, ...workers].filter((a, i, arr) => VALID_AGENTS.includes(a) && arr.indexOf(a) === i);
  const system = await fs.readFile(path.join(RALPH_DIR, 'planner.md'), 'utf8');
  const env = await detectEnvironment();
  const catalog = await loadSkillsCatalog();
  const skillList = catalog.map((s) => `- ${s.id}: ${s.description}`).join('\n') || '(none)';
  const fmt = OUTPUT_FORMATS.includes(outputFormat) ? outputFormat : 'auto';
  const prefsObj = (await loadPrefs(tenant).catch(() => null)) || {};
  const profileNote = prefsObj.profileNote || '';
  // Deterministic negative signal: agents the user keeps swapping away from. The
  // master is fixed by the user (can't be reassigned by the planner) so exclude it.
  const unreliable = (prefsObj.prefs?.unreliableAgents || []).filter((a) => roster.includes(a) && a !== master);
  // Observed reliability from past builds (C: self-learning routing). Higher score
  // = assign the central/complex stories there; cheaper/less-proven agents are fine
  // for simple, independent leaf stories.
  const rel = prefsObj.prefs?.agentReliability || {};
  const relLine = Object.entries(rel).filter(([a]) => roster.includes(a))
    .sort((a, b) => b[1] - a[1]).map(([a, s]) => `${a} ${s}`).join(', ');
  // Media-aware planning: tell the planner which generatable media kinds are
  // enabled for this build and their caps, so it can plan a per-story `media`
  // object the user reviews before any spend. Disabled kinds are omitted.
  const mediaBudget = normalizeMedia(media);
  const mediaEnabled = ['image', 'video', 'audio'].filter((k) => mediaBudget[k]?.enabled && mediaBudget[k].cap > 0);
  const mediaLine = mediaEnabled.length
    ? mediaEnabled.map((k) => `${k} up to ${mediaBudget[k].cap}`).join(', ')
    : '';
  // Live-web grounding (Sonar): cited, current facts about whatever the idea references.
  // Best-effort — '' when no perplexity key, the idea doesn't need it, or the call fails.
  const grounding = await groundIdea(idea, fmt, tenant);
  const user = `Idea:\n${idea}\n\n` +
    (research ? `You are modifying an EXISTING codebase. Its research summary follows — stories MUST fit it; do NOT recreate what exists; prefer minimal, targeted changes; reference real files.\n--- RESEARCH.md ---\n${research.slice(0, 12000)}\n--- end ---\n\n` : '') +
    (grounding ? `Current-web research on this idea (cited, fetched moments ago — for names, versions, competitor features and market facts, TRUST THIS over training knowledge; reflect the cited facts in story descriptions and acceptance criteria):\n--- research ---\n${grounding}\n--- end ---\n\n` : '') +
    (answers ? `Clarifications from the user (use these to make stories specific and correct):\n${answers}\n\n` : '') +
    (profileNote ? `Learned preferences for THIS user (treat as soft defaults — honour unless the idea or clarifications say otherwise):\n${profileNote}\n\n` : '') +
    (unreliable.length ? `Agents this user has repeatedly swapped away from — AVOID assigning these as a story \`assignee\` unless a story specifically needs one: ${unreliable.join(', ')}\n\n` : '') +
    (relLine ? `Observed agent reliability from past builds (story-acceptance rate 0–1; assign architecturally central / complex stories to the higher-scoring agents, and route simple independent leaf stories to cheaper/less-proven ones):\n${relLine}\n\n` : '') +
    `Available agent keys: ${roster.join(', ')}\nMaster agent: ${master}\n\n` +
    `Project output format the user picked up front: ${fmt}\n\n` +
    (mediaLine
      ? `Generated-media budget for THIS build (per-kind TOTAL across ALL stories — these are the ONLY kinds you may plan; generate NOTHING for a kind not listed): ${mediaLine}.\n`
        + `For each story whose deliverable genuinely benefits from generated media (a hero image, one figure per slide, a short intro video, a voiceover), add an OPTIONAL "media" object to that story: {"image":<n>,"video":<n>,"audio":<n>} with small, purposeful counts for the ENABLED kinds only. Keep the per-kind total within the caps above; omit "media" for stories that need none. All imagery must share the project's ONE consistent visual style.\n\n`
      : `Generated media is OFF for this build — do NOT add a "media" object to any story.\n\n`) +
    `Available skills catalog (assign per-story \`skills\` by id; instructions are injected into the agent prompt so they work for any agent):\n${skillList}\n\n` +
    `Connected MCP tools (already authorized — assign relevant ids per-story as \`tools\`): ${mcpCapabilitiesFor(tenant).join(', ') || '(none connected — do not assign tools)'}\n\n` +
    `Installed runtimes/tools on the deploy server (use ONLY these — there is NO sudo, so anything ` +
    `not listed CANNOT be installed): ${env.join(', ') || '(none detected)'}\n` +
    `Workers MAY install project-level dependencies with the listed package managers (e.g. npm/pip), ` +
    `but cannot install system runtimes/SDKs. Pick a stack that runs with the tools above.\n\n` +
    `Produce the prd.json now.`;
  const raw = await callPlanner(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { json: true, tenant },
  );
  const prd = extractJson(raw);
  if (!prd) throw new Error('Planner did not return valid JSON.');
  return normalizePrd(prd, { idea, master, workers, outputFormat: fmt, mcpCaps: mcpCapabilitiesFor(tenant), media });
}

// Ask the user a few clarifying questions before planning, so the stories are
// smarter/more specific. Each question carries 2–4 concrete answer OPTIONS (one
// flagged the recommended default); the UI renders them as picks plus an always-
// present free-write escape hatch. Returns [] if the idea is already clear or on
// any error (clarify is best-effort — planning can proceed without it).
export async function clarifyQuestions(idea, outputFormat = 'auto', tenant = null) {
  const profileNote = (await loadPrefs(tenant).catch(() => null))?.profileNote || '';
  const { axes, cap, contentHeavy } = clarifyAxesFor(outputFormat);
  const sys = `You are a product analyst scoping a build whose output format is "${outputFormat || 'auto'}". `
    + 'Ask SHORT, high-value clarifying questions, each with 2–4 concrete answer options the user can pick from. '
    + `Cover these discovery axes, but ONLY where the idea does not already answer them: ${axes.join('; ')}. `
    + (contentHeavy
        ? 'This is a content/brand-heavy build: ask about every axis above the idea has NOT already specified, and return at least one question unless the idea fully specifies all axes. Do NOT re-ask an axis the idea already states. '
        : 'Skip anything already obvious from the idea; if the idea is already clear enough, return {"questions":[]}. ')
    + 'Do NOT add an "other"/"something else" option yourself — the UI always provides a free-write escape hatch. '
    + 'Mark EXACTLY ONE option per question with "recommended": true: the sensible default for this idea, biased toward the user\'s learned preferences (below) when an option matches them. '
    + 'Set "multiSelect": true only when several options can sensibly be combined (e.g. "which features?"); otherwise false. '
    + 'Return ONLY JSON: {"questions":[{"q":"...","header":"<=12-char tag","multiSelect":false,"options":[{"label":"short choice","description":"one-line tradeoff","recommended":false}]}]}.';
  const user = `Idea:\n${idea}`
    + (profileNote ? `\n\nLearned preferences for THIS user (use to pick the recommended default when an option matches; do NOT invent a question just to surface them): ${profileNote}` : '');
  try {
    const raw = await callPlanner([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, tenant });
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions.slice(0, cap).map((q) => {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => ({
          label: String(o?.label ?? o ?? '').trim().slice(0, 80),
          description: String(o?.description ?? '').trim().slice(0, 160),
          recommended: !!o?.recommended,
        }))
        .filter((o) => o.label)
        .slice(0, 4);
      // Force exactly one recommended default (first option if the model marked none or several).
      let seen = false;
      for (const o of options) { if (o.recommended && !seen) seen = true; else o.recommended = false; }
      if (options.length && !seen) options[0].recommended = true;
      return {
        q: String(q?.q || q || '').trim(),
        header: String(q?.header || '').trim().slice(0, 12),
        multiSelect: !!q?.multiSelect,
        options,
      };
    }).filter((q) => q.q);
  } catch { return []; }
}

// Validate + normalise any prd (planner output or a client-supplied replay) into
// the canonical shape the orchestrator trusts. Unknown assignees clamp to master.
export function normalizePrd(prd, { idea, master, workers, outputFormat, mcpCaps = null, media = null }) {
  const roster = [master, ...workers].filter((a, i, arr) => VALID_AGENTS.includes(a) && arr.indexOf(a) === i);
  if (!prd || !Array.isArray(prd.stories) || !prd.stories.length) throw new Error('PRD has no stories.');
  // Clean an arbitrary list of short id-like strings (skills/tools) the planner or
  // a client supplied: lower-kebab, deduped, capped. Unknown skill ids are harmless
  // (getSkillMd just returns '') so we don't hard-validate against the catalog here.
  const cleanIds = (v, allow) => {
    if (!Array.isArray(v)) return [];
    const out = v.map((x) => String(x).toLowerCase().trim().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean).filter((x) => !allow || allow.includes(x));
    return [...new Set(out)].slice(0, 8);
  };
  const fmt = OUTPUT_FORMATS.includes(prd.outputFormat) ? prd.outputFormat
    : (OUTPUT_FORMATS.includes(outputFormat) ? outputFormat : 'auto');
  const out = {
    project: String(prd.project || 'project'),
    description: String(prd.description || ''),
    outputFormat: fmt,
    idea, master, workers,
    stories: prd.stories.map((s, i) => {
      const id = /^s\d+$/.test(s.id || '') ? s.id : `s${i + 1}`;
      return {
        id,
        title: String(s.title || `Story ${i + 1}`),
        description: String(s.description || ''),
        acceptanceCriteria: Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.map(String) : [],
        assignee: roster.includes(s.assignee) ? s.assignee : master,
        skills: cleanIds(s.skills),
        tools: cleanIds(s.tools, mcpCaps || []),
        outputType: OUTPUT_FORMATS.includes(s.outputType) ? s.outputType : 'auto',
        priority: Number.isInteger(s.priority) ? s.priority : i + 1,
        deps: Array.isArray(s.deps) ? s.deps.map(String) : [],
        status: 'todo',
        branch: `prd/${id}`,
        iterations: 0,
        passes: false,
        // Optional per-story media plan (image/video/audio counts); sanitized +
        // clamped to the build budget across the whole PRD by applyMediaPlan below.
        media: (s.media && typeof s.media === 'object' && !Array.isArray(s.media)) ? s.media : undefined,
      };
    }),
  };
  out.stories = applyMediaPlan(out.stories, media);
  return out;
}