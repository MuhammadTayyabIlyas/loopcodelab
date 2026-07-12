// server/skills.mjs — MCP connections for builds, the model-agnostic skills
// catalog (vendored + optional anthropics/skills clone), and the deliverable
// output-format tables used to brief workers and the finalize pass.
import path from 'node:path';
import fs from 'node:fs/promises';
import * as saasStore from '../saas/store.mjs';
import { apifyMcpServer } from '../ralph/providers.mjs';
import { DATA_DIR, RALPH_DIR, execFileAsync } from './config.mjs';
import { apifyToken } from './secrets.mjs';

// ── MCP connections ────────────────────────────────────────────────────────
// Data-driven: the admin manages PLATFORM servers in the Admin dashboard
// (`mcp_servers` rows, workspace_id NULL) and each tenant can attach their OWN
// (e.g. a personal Composio/Pipedream Gmail/Drive URL) in Settings. The legacy
// hardcoded gateway remains as the owner's fallback so single-tenant behavior
// is unchanged. Tenant builds see ONLY their own servers + platform rows the
// admin explicitly marked `shared` — never the owner's personal Google grants.
export const MCP_GATEWAY = 'https://mcp.tayyabcheema.com/sse';
const MCP_API_KEY = process.env.WEBTMUX_MCP_API_KEY || 'mcp_7cf6b0be78afb02e4f366e622b40a2c3a466829cb00d7b54';
const MCP_LEGACY_CAPS = ['google-docs', 'google-sheets', 'google-slides', 'google-drive', 'gmail', 'calendar'];

// Servers (with decrypted auth) applicable to a build. tenant null = owner.
export function mcpServersFor(tenant) {
  let rows = [];
  try { rows = saasStore.mcpServersForBuild(tenant ? tenant.id : null); } catch { /* DB unavailable */ }
  if (!tenant && !rows.some((r) => r.name === 'tayyabcheema-mcp')) {
    rows.push({ name: 'tayyabcheema-mcp', url: MCP_GATEWAY, auth: MCP_API_KEY, capabilities: MCP_LEGACY_CAPS });
  }
  // Apify MCP (Phase D): actor discovery/docs/RAG-browsing for stories planned with
  // `web-data`. Wired only when a token exists (tenant vault → platform); execution
  // stays with $RALPH_FETCH_DATA so the data budget holds.
  if (!rows.some((r) => r.name === 'apify')) {
    let tok = null;
    if (tenant) { try { tok = saasStore.getProviderKey(tenant.id, 'apify'); } catch { tok = null; } }
    const row = apifyMcpServer(tok || apifyToken());
    if (row) rows.push(row);
  }
  return rows;
}
// Tool ids the planner may assign for this build = union over applicable servers.
export const mcpCapabilitiesFor = (tenant) => [...new Set(mcpServersFor(tenant).flatMap((s) => s.capabilities))];

// Write every applicable server into the agent's MCP config file in `dir`.
export async function writeMcpConfig(dir, tool, servers) {
  if (!servers || !servers.length) return;
  const FILES = { qwen: '.qwen/settings.json', claude: '.claude/settings.json', codex: '.codex/settings.json', glm: '.claude/settings.json' };
  const file = FILES[tool];
  if (!file) return; // shell or gemini — no config path known

  const fullPath = path.join(dir, file);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(fullPath, 'utf8')); } catch { /* no existing config */ }
  if (!existing.mcpServers) existing.mcpServers = {};
  for (const s of servers) {
    // Remote servers default to SSE (the legacy gateway); rows may override with
    // transport 'http' (streamable HTTP — e.g. Apify, which deprecated SSE). `type`
    // is written alongside `transport` because the CLIs disagree on the field name.
    const t = s.transport || 'sse';
    existing.mcpServers[s.name] = s.command
      ? { command: s.command, args: s.args || [] } // local stdio server (e.g. firebase)
      : { transport: t, type: t, url: s.url, ...(s.auth ? { headers: { Authorization: 'Bearer ' + s.auth } } : {}) };
  }
  await fs.writeFile(fullPath, JSON.stringify(existing, null, 2));
}

// ── Skills catalog (model-agnostic SKILL.md files) ─────────────────────────
// Ralph injects a skill's SKILL.md text into the worker prompt ("inject only"),
// so skills behave identically for every agent (claude/codex/gemini/qwen). Two
// sources: a vendored baseline that ships in the repo (always present) and an
// optional shallow clone of github.com/anthropics/skills layered on top.
// MCP capabilities are now resolved per-build from the configured connections —
// see mcpCapabilitiesFor (the admin's platform servers + the tenant's own).
// Canonical deliverable formats. The user picks one up front (project-level);
// the planner assigns a per-story `outputType` from the same set ('auto' = let
// the master decide). Anything outside the set normalises back to 'auto'.
export const OUTPUT_FORMATS = ['auto', 'web-app', 'flutter-app', 'social-video', 'google-doc', 'google-sheet', 'google-slides', 'docx', 'pdf', 'xlsx', 'pptx', 'downloadable'];
// Which vendored skill / MCP tools back each output format — used to brief the
// finalize pass so the master produces the deliverable the user asked for.
export const OUTPUT_SKILL = {
  'web-app': 'web-deliverable', 'flutter-app': 'flutter-deliverable', 'social-video': 'social-video',
  'google-doc': 'google-workspace',
  'google-sheet': 'google-workspace', 'google-slides': 'google-workspace',
  'docx': 'docx', 'pdf': 'pdf', 'xlsx': 'xlsx', 'pptx': 'pptx', 'downloadable': 'docx',
};
export const OUTPUT_TOOLS = {
  'google-doc': ['google-docs', 'google-drive'],
  'google-sheet': ['google-sheets', 'google-drive'],
  'google-slides': ['google-slides', 'google-drive'],
};

const VENDORED_SKILLS_DIR = path.join(RALPH_DIR, 'skills');
const SKILLS_REPO_DIR = process.env.WEBTMUX_SKILLS_DIR || path.join(DATA_DIR, 'skills', 'anthropic');
const SKILLS_REPO_URL = 'https://github.com/anthropics/skills.git';

// Best-effort: shallow-clone the Anthropic skills repo once so the catalog is
// richer than the vendored baseline. Never fatal — a failure just means we run
// on the vendored set. Skipped if the clone already exists.
let skillsRepoReady;
async function ensureSkillsRepo() {
  if (skillsRepoReady !== undefined) return skillsRepoReady;
  try {
    const hasClone = await fs.stat(path.join(SKILLS_REPO_DIR, '.git')).then(() => true).catch(() => false);
    if (!hasClone) {
      await fs.mkdir(path.dirname(SKILLS_REPO_DIR), { recursive: true });
      await execFileAsync('git', ['clone', '--depth', '1', SKILLS_REPO_URL, SKILLS_REPO_DIR], { timeout: 60_000 });
    }
    skillsRepoReady = SKILLS_REPO_DIR;
  } catch { skillsRepoReady = null; } // fall back to the vendored baseline only
  return skillsRepoReady;
}

// Recursively find SKILL.md files under a root (Anthropic nests them as
// <category>/<skill>/SKILL.md). Bounded depth; skips .git / node_modules.
async function findSkillFiles(root, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) await findSkillFiles(full, depth + 1, out);
    else if (e.name === 'SKILL.md') out.push(full);
  }
  return out;
}

// Parse a SKILL.md's leading YAML frontmatter for { name, description }.
// Line-based (no YAML dep); reads the first --- ... --- block only.
function parseSkillFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

// Build the catalog: vendored baseline first (authoritative ids), then any cloned
// skills whose id isn't already taken. Cached briefly. Each entry keeps its file
// path so getSkillMd can return the full text for prompt injection.
let skillCache = null, skillCacheAt = 0;
export async function loadSkillsCatalog() {
  if (skillCache && Date.now() - skillCacheAt < 5 * 60_000) return skillCache;
  const repo = await ensureSkillsRepo();
  const sources = [VENDORED_SKILLS_DIR, ...(repo ? [repo] : [])];
  const byId = new Map();
  for (const src of sources) {
    for (const file of await findSkillFiles(src)) {
      let text;
      try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
      const fm = parseSkillFrontmatter(text);
      const id = (fm.name || path.basename(path.dirname(file))).trim();
      if (!id || byId.has(id)) continue; // vendored wins over cloned
      byId.set(id, { id, name: fm.name || id, description: fm.description || '', path: file });
    }
  }
  skillCache = [...byId.values()];
  skillCacheAt = Date.now();
  return skillCache;
}

// Full SKILL.md text for a skill id, for injecting into a worker prompt. '' if unknown.
export async function getSkillMd(id) {
  const entry = (await loadSkillsCatalog()).find((s) => s.id === id);
  if (!entry) return '';
  try { return await fs.readFile(entry.path, 'utf8'); } catch { return ''; }
}
