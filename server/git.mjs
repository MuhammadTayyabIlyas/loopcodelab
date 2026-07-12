// server/git.mjs — per-project git repos for the Ralph orchestrator: init,
// commit, story worktrees, merge/revert. Runs as the tenant that owns the repo
// (derived from the path) so git's "dubious ownership" guard never trips.
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileAsync, MT_ON } from './config.mjs';
import { tenantUserFromDir, wrapAsTenantUser } from './tmux.mjs';

// --- Git: per-project repos for the Ralph orchestrator ----------------------
// Every project is a git repo so each PRD story is an isolated, revertible
// commit/branch and the finished project can be pushed to GitHub. All calls use
// an argv array (never a shell string) and run with `-C <dir>` so the project
// folder is the only working tree touched.
export const WORKTREES_SUBDIR = '.worktrees';

export async function git(dir, args, opts = {}) {
  // Runs as the tenant that OWNS the repo when dir is inside a tenant home (derived
  // above), so the agent and the orchestrator share one consistent repo owner and
  // git never trips its "dubious ownership" guard. Single-tenant: runs as the app
  // user, byte-identical to before. Explicit opts.tenant wins.
  const { tenant, ...exec } = opts;
  const base = ['git', '-C', dir, ...args];
  const user = MT_ON() && !tenant ? tenantUserFromDir(dir) : null;
  const argv = tenant ? tenant.wrap(base) : user ? wrapAsTenantUser(user, base) : base;
  return execFileAsync(argv[0], argv.slice(1), { timeout: 60_000, ...exec });
}

export async function isGitRepo(dir) {
  try { await git(dir, ['rev-parse', '--is-inside-work-tree']); return true; }
  catch { return false; }
}

// Create the project root inside a tenant sandbox AS the tenant, so the git repo
// rooted there is tenant-owned and git's "dubious ownership" guard never trips (that
// guard can't be relaxed via -c/env — git only honours safe.directory from system/
// global config). App-side fs.* writes into the dir still work via the project ACL.
// Single-tenant (no tenant): a plain recursive mkdir, byte-identical to before.
export async function ensureProjectDir(dir, tenant) {
  if (tenant) {
    const argv = tenant.wrap(['mkdir', '-p', dir]);
    await execFileAsync(argv[0], argv.slice(1), { timeout: 10_000 });
  } else {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Initialise a fresh repo with an unattended identity and a first commit.
// Idempotent: a no-op if the dir is already a work tree.
export async function gitInitProject(dir) {
  if (await isGitRepo(dir)) return false;
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'webtmux']);
  await git(dir, ['config', 'user.email', 'webtmux@tayyabcheema.com']);
  // Agent config dirs hold the MCP gateway config (incl. its API key) Ralph writes
  // per worktree — never let a worker commit/push them.
  await fs.appendFile(path.join(dir, '.gitignore'),
    'node_modules/\n.worktrees/\n.ralph/\n*.log\n.claude/\n.codex/\n.qwen/\n.gemini/\n'
    // Flutter/Android secrets are materialized at build time and must never be committed.
    + '*.jks\n*.keystore\nkey.properties\ngoogle-services.json\nGoogleService-Info.plist\n*service-account*.json\n'
    // Windows code-signing material (installer signing is via Actions secrets, never files in-repo).
    + '*.pfx\n*.snk\n').catch(() => {});
  // progress.txt is append-only and edited by every worker — a union merge keeps
  // both sides instead of conflicting on every parallel merge.
  await fs.appendFile(path.join(dir, '.gitattributes'),
    'progress.txt merge=union\n').catch(() => {});
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--allow-empty', '-m', 'chore: initial project scaffold']);
  return true;
}

// Stage everything and commit; returns false (not an error) when nothing changed.
export async function gitCommitAll(dir, message) {
  await git(dir, ['add', '-A']);
  try { await git(dir, ['commit', '-m', message]); return true; }
  catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    if (/nothing to commit|no changes added/i.test(out)) return false;
    throw err;
  }
}

// Branch <branch> off main + a linked worktree at .worktrees/<id> so a worker
// can build a story without colliding with the other agents' working dirs.
export async function gitAddWorktree(dir, id, branch) {
  const wt = path.join(dir, WORKTREES_SUBDIR, id);
  // On a retry the branch already exists (with the prior attempt's commits): check
  // it out rather than recreating it. First time: branch fresh off main.
  const exists = await git(dir, ['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
  if (exists) await git(dir, ['worktree', 'add', wt, branch]);
  else await git(dir, ['worktree', 'add', '-b', branch, wt, 'main']);
  return wt;
}
export async function gitRemoveWorktree(dir, id) {
  await git(dir, ['worktree', 'remove', '--force', path.join(dir, WORKTREES_SUBDIR, id)]).catch(() => {});
}

// Master integration: merge a green story branch into main (always a merge commit
// so it can be reverted as a unit). Returns the merge commit SHA.
export async function gitMergeBranch(dir, branch, message) {
  // Defensive clean: `git merge` aborts if main's working tree/index has stray
  // changes or untracked files that the merge would touch. Main is only ever
  // mutated by the orchestrator, so discard any leftover state before merging.
  // `clean -fd` (no -x) keeps gitignored dirs — i.e. the orchestrator's own
  // `.ralph` sentinels/verdicts and `.worktrees`; `-e` guards them even if the
  // generated repo's .gitignore is missing.
  await git(dir, ['reset', '--hard', 'HEAD']).catch(() => {});
  await git(dir, ['clean', '-fd', '-e', '.ralph', '-e', '.worktrees']).catch(() => {});
  try {
    await git(dir, ['merge', '--no-ff', '-m', message, branch]);
  } catch (err) {
    // A conflict leaves the tree mid-merge — abort so main stays clean and usable.
    await git(dir, ['merge', '--abort']).catch(() => {});
    throw err;
  }
  const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}
// Reversibility: undo a merged story by reverting its merge commit (-m 1 = keep
// the main-line parent).
export async function gitRevertMerge(dir, sha) {
  await git(dir, ['revert', '--no-edit', '-m', '1', sha]);
}
