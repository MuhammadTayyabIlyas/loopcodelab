// Pure helpers for the Perplexity (Sonar) planner-grounding pass: decide when an idea
// benefits from a live-web research call, shape the request, and turn the response into
// a compact cited block for the planner prompt. The fetch lives in server.js
// (groundIdea); everything here is unit-tested. Grounding is suggest-only — a missing
// key, a timeout, or an API error must never block planning.

export const SONAR_MODEL = 'sonar'; // cheapest web-grounded tier; enough for plan facts

// Formats whose deliverable is mostly CONTENT (facts, copy, market claims) — these gain
// the most from grounded, cited inputs. Mirrors clarify-axes' content-heavy split.
const CONTENT_FORMATS = new Set(['web-app', 'flutter-app', 'google-docs', 'google-slides', 'docx', 'pptx']);

// Markers that the idea references something in the live world the planner can't know
// from training data: products to imitate, things to integrate with, market claims.
const EXTERNAL_RE = /\bhttps?:\/\/|(\ba |an )?app like |similar to |clone of |competitor|market|pricing|integrat\w+ with|api of |latest |current(ly)? |202\d\b/i;

export function shouldGround(idea, outputFormat) {
  const text = String(idea || '');
  if (!text.trim()) return false;
  return CONTENT_FORMATS.has(String(outputFormat || '')) || EXTERNAL_RE.test(text);
}

// Chat messages for the Sonar call: short, factual grounding notes for a build plan.
export function researchPrompt(idea, outputFormat) {
  return [
    {
      role: 'system',
      content: 'You ground software build plans in current reality. Answer with at most 10 terse bullet points: '
        + 'facts about the domain/products the idea references, the features users expect (from real competitors), '
        + 'the currently recommended libraries/APIs for this kind of build (with major versions), and pitfalls. '
        + 'Only include facts you found in sources. No preamble, no advice essays.',
    },
    { role: 'user', content: `Build idea (output format: ${outputFormat || 'auto'}):\n${String(idea || '').slice(0, 2000)}` },
  ];
}

// Tolerant parse of a Perplexity chat response -> { content, citations[] }.
// Citations arrive as `citations: [url]` and/or `search_results: [{title,url}]`.
export function parseSonar(json) {
  const content = String(json?.choices?.[0]?.message?.content || '').trim();
  const urls = [];
  for (const c of Array.isArray(json?.citations) ? json.citations : []) {
    if (typeof c === 'string' && /^https?:\/\//.test(c)) urls.push(c);
  }
  for (const r of Array.isArray(json?.search_results) ? json.search_results : []) {
    if (r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)) urls.push(r.url);
  }
  return { content, citations: [...new Set(urls)] };
}

// The block folded into the planner prompt: capped notes + up to 8 numbered sources.
// '' when there is no content (the caller then omits the section entirely).
export function groundingBlock(content, citations = [], cap = 4000) {
  const body = String(content || '').trim().slice(0, cap);
  if (!body) return '';
  const src = (citations || []).slice(0, 8).map((u, i) => `[${i + 1}] ${u}`).join('\n');
  return src ? `${body}\n\nSources:\n${src}` : body;
}

// --- Phase C: worker helpers ($RALPH_GEN_RESEARCH / $RALPH_FETCH_DATA) --------------
// Pure logic for the two agent-invoked CLIs (ralph/gen-research.mjs, ralph/fetch-data.mjs),
// mirroring the media-gen split: request/arg shaping here (tested), fs/http in the CLIs.

const clampCap = (v, def, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : def;
};

// Per-run budget: research = cited web answers (perplexity, cheap — on by default);
// data = apify actor runs (spend platform credits — connecting the key is the opt-in,
// the helper skips cleanly when no key is present). Caps are TOTAL per build.
export function normalizeResearchBudget(input) {
  const d = (input && typeof input === 'object') ? input : {};
  return {
    research: { enabled: d.research?.enabled !== false, cap: clampCap(d.research?.cap, 5, 20) },
    data: { enabled: d.data?.enabled !== false, cap: clampCap(d.data?.cap, 2, 10) },
  };
}

// Direct worker question -> concise cited answer (unlike researchPrompt, which shapes
// plan-level grounding notes).
export function workerResearchMessages(question) {
  return [
    {
      role: 'system',
      content: 'You answer one technical/factual question for a software agent mid-build. Be concise '
        + '(under 400 words), give the current answer with exact names/versions/endpoints where relevant, '
        + 'and only state facts backed by your search results — cite sources. No preamble.',
    },
    { role: 'user', content: String(question || '').slice(0, 2000) },
  ];
}

// $RALPH_FETCH_DATA argv -> { mode:'run'|'create', ... } | { error }.
// run:    --actor <user/name|id> --input '<json>' [--max-items N] [--out data/x.json]
// create: --create <name> --source <main.js> [--input '<json>'] [--max-items N] [--out ...]
export function parseFetchDataArgs(argv) {
  const a = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const k = args[i], v = args[i + 1];
    if (k === '--actor') { a.actor = v; i++; }
    else if (k === '--create') { a.name = v; i++; }
    else if (k === '--source') { a.source = v; i++; }
    else if (k === '--input') { a.rawInput = v; i++; }
    else if (k === '--max-items') { a.maxItems = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
  }
  if (!a.actor && !a.name) return { error: 'need --actor <user/name> (run a store actor) or --create <name> --source <main.js> (deploy a custom one)' };
  if (a.actor && !/^[\w.-]+(\/[\w.-]+)?$/.test(a.actor)) return { error: `invalid actor id: ${a.actor}` };
  if (a.name && !/^[a-z0-9][a-z0-9-]{2,49}$/.test(a.name)) return { error: 'actor name must be lowercase letters/numbers/hyphens (3-50 chars)' };
  if (a.name && !a.source) return { error: '--create needs --source <main.js>' };
  let input = {};
  if (a.rawInput != null) {
    try { input = JSON.parse(a.rawInput); } catch { return { error: '--input must be valid JSON' }; }
  }
  const maxItems = Math.min(1000, Math.max(1, Math.round(Number(a.maxItems)) || 100));
  const slug = (a.actor || a.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    mode: a.actor ? 'run' : 'create',
    actor: a.actor, name: a.name, source: a.source, input, maxItems,
    out: a.out || `data/${slug || 'dataset'}.json`,
  };
}

// Run an actor synchronously and get the dataset back in one call (<=5-min server wait).
// Path ids use ~ instead of / (user~name); clean=true strips apify bookkeeping fields.
export function runSyncUrl(actorId, { maxItems = 100, timeoutSecs = 290 } = {}) {
  const id = String(actorId || '').replace('/', '~');
  return `https://api.apify.com/v2/acts/${encodeURIComponent(id)}/run-sync-get-dataset-items`
    + `?clean=true&format=json&maxItems=${maxItems}&timeout=${timeoutSecs}`;
}

// Standard minimal Apify actor around an agent-authored main.js (Actor.init/getInput/
// pushData/exit). The platform builds it from these SOURCE_FILES; no local docker needed.
export function actorScaffoldFiles({ name, mainJs }) {
  const pkg = {
    name: String(name || 'ralph-actor'),
    version: '0.0.1',
    type: 'module',
    scripts: { start: 'node main.js' },
    dependencies: { apify: '^3.2.0', crawlee: '^3.11.0' },
  };
  return [
    {
      name: 'Dockerfile', format: 'TEXT',
      content: 'FROM apify/actor-node:20\n'
        + 'COPY package*.json ./\n'
        + 'RUN npm --quiet set progress=false && npm install --omit=dev\n'
        + 'COPY . ./\n'
        + 'CMD npm start --silent\n',
    },
    { name: 'package.json', format: 'TEXT', content: JSON.stringify(pkg, null, 2) + '\n' },
    { name: 'main.js', format: 'TEXT', content: String(mainJs || '') },
  ];
}

// POST /v2/acts body: a PRIVATE actor (never published), one version 0.0 tagged latest.
export function createActorPayload(name, sourceFiles) {
  return {
    name,
    isPublic: false,
    versions: [{ versionNumber: '0.0', sourceType: 'SOURCE_FILES', buildTag: 'latest', sourceFiles }],
    defaultRunOptions: { build: 'latest', timeoutSecs: 300, memoryMbytes: 1024 },
  };
}
