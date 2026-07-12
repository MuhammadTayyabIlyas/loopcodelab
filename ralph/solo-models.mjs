// Per-agent model selection for SOLO (single-developer) Ralph runs. A solo run is one
// agent that builds every story on a low-cost model and reviews/finalizes on a top
// model. Pure + side-effect free so it unit-tests in isolation; server.js owns the
// file/env I/O and the spawn wiring.

// Agents that can run solo. glm is excluded: it is never a master and runs as a worker
// via direct.mjs (a single-shot API call), so a --model flag does not apply.
export const SOLO_AGENTS = ['claude', 'codex', 'qwen', 'gemini'];

// Built-in defaults. Only Claude is known-good; other agents stay unset (= the CLI's
// own default model, no --model passed) until an admin configures them, so a blank or
// wrong id can never break a build.
export const SOLO_MODEL_DEFAULTS = {
  claude: { build: 'claude-sonnet-4-6', review: 'claude-opus-4-8' },
};

// Ids are not secrets but ARE spliced into a shell command string, so restrict to a
// safe charset (letters, digits, dot, underscore, colon, slash, hyphen).
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
export function validModelId(s) { return typeof s === 'string' && MODEL_ID_RE.test(s); }

// Keep only known agents/roles and valid ids; drop blanks/unknowns. Throws on a present
// but invalid id so the admin PUT can report it.
export function sanitizeModels(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const agent of SOLO_AGENTS) {
    const row = input[agent];
    if (!row || typeof row !== 'object') continue;
    const clean = {};
    for (const role of ['build', 'review']) {
      const v = typeof row[role] === 'string' ? row[role].trim() : '';
      if (v === '') continue;
      if (!validModelId(v)) throw new Error(`Invalid model id for ${agent}.${role}: "${v}"`);
      clean[role] = v;
    }
    if (Object.keys(clean).length) out[agent] = clean;
  }
  return out;
}

// RALPH_SOLO_MODELS env override (JSON, same shape). Best-effort: {} on absence/parse error.
export function soloModelsFromEnv(env = process.env) {
  const raw = env.RALPH_SOLO_MODELS;
  if (!raw) return {};
  try { return sanitizeModels(JSON.parse(raw)); } catch { return {}; }
}

// Merge precedence (lowest -> highest): defaults < file < env, per agent/role.
export function effectiveModels(fileMap = {}, envMap = {}) {
  const out = {};
  for (const agent of SOLO_AGENTS) {
    const merged = {
      ...(SOLO_MODEL_DEFAULTS[agent] || {}),
      ...(fileMap[agent] || {}),
      ...(envMap[agent] || {}),
    };
    if (merged.build || merged.review) out[agent] = merged;
  }
  return out;
}

export function resolveSoloModel(models, agent, role) {
  return (models && models[agent] && models[agent][role]) || '';
}

// The single decision point the spawn builders call. Returns a command fragment
// (' --model <id>') to splice into the CLI invocation, or '' to leave the CLI on its
// default. Suppressed when not solo, or when a coding plan already pins the model.
// A run is solo when it has no worker agent OTHER than the master — the master
// builds every story and also reviews/finalizes. (The master may appear in the
// workers list; the roster dedups to just the master.)
export function isSolo(run) {
  return (run?.workers || []).filter((w) => w !== run?.master).length === 0;
}

export function soloModelFlag({ solo, agent, role, codingPlan, models }) {
  if (!solo || codingPlan) return '';
  const id = resolveSoloModel(models, agent, role);
  return id ? ` --model ${id}` : '';
}
