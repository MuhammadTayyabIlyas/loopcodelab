// server/projects.mjs — project folders under PROJECTS_ROOT: listing, safe path
// resolution, SSH connect targets, and the shared AGENTS.md context scaffold.
import path from 'node:path';
import fs from 'node:fs/promises';
import { HOME, PROJECTS_ROOT, validProject } from './config.mjs';

export async function listProjects() {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return []; // root not created yet
    throw err;
  }
}

// Resolve a project name to an absolute directory inside PROJECTS_ROOT. Empty
// → the home dir (a "no project" session). Returns null for anything invalid
// or that resolves (via symlink/..) outside the root.
export async function resolveProjectDir(project) {
  if (!project) return HOME;
  if (!validProject(project)) return null;
  const rootReal = await fs.realpath(PROJECTS_ROOT).catch(() => null);
  if (!rootReal) return null;
  let real;
  try { real = await fs.realpath(path.join(PROJECTS_ROOT, project)); } catch { return null; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
  const st = await fs.stat(real).catch(() => null);
  return st && st.isDirectory() ? real : null;
}

// SSH "Connect" targets are simply the Host aliases in the service user's
// ~/.ssh/config (wildcards excluded). Adding a server = adding a Host block;
// the dashboard then offers it as a one-tap connect. The parsed list also acts
// as an allowlist so a launched `ssh <host>` can never carry injected args.
export const SSH_CONFIG = path.join(HOME, '.ssh', 'config');
export const SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function listSshHosts() {
  let txt;
  try {
    txt = await fs.readFile(SSH_CONFIG, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const hosts = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*Host\s+(.+?)\s*$/i);
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) {
      if (!h.includes('*') && !h.includes('?') && SSH_HOST_RE.test(h)) hosts.push(h);
    }
  }
  return [...new Set(hosts)].sort();
}


// so notes/instructions carry across Claude, Codex, Gemini and Qwen. AGENTS.md
// is the source of truth; each tool's conventional filename is a symlink to it.
export const CONTEXT_FILE = 'AGENTS.md';
export const PROVIDER_FILES = ['CLAUDE.md', 'GEMINI.md', 'QWEN.md'];

export function contextTemplate(name) {
  return `# ${name}

Shared project context for AI assistants. CLAUDE.md, GEMINI.md and QWEN.md are
symlinks to this file, so Claude, Codex, Gemini and Qwen all read the same
instructions and you can switch providers without losing context.

## Project
<!-- What this is, the goal, and any hard constraints. -->

## Conventions
<!-- Build/test commands, code style, things to avoid. -->

## Running notes
<!-- Decisions and state to carry across sessions and across providers. -->
`;
}

// Create the shared context file and provider symlinks if they don't exist.
// Never clobbers anything already there (the user may have a real CLAUDE.md).
export async function scaffoldContext(dir, name) {
  try {
    await fs.writeFile(path.join(dir, CONTEXT_FILE), contextTemplate(name), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  for (const file of PROVIDER_FILES) {
    try {
      await fs.symlink(CONTEXT_FILE, path.join(dir, file));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}
