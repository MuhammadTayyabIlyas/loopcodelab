// Tenant model + sandbox helpers (Phase 1.3 core). A tenant == a workspace row
// { id, slug, unix_user }. Its sandbox is a real OS user with its own home,
// projects dir and tmux socket → kernel-level FS isolation on the one VM.
//
// This module holds the PURE, testable helpers (path/session/subdomain naming)
// plus a thin provisioning wrapper that shells out to a root helper. ADDITIVE:
// not yet imported by server.js, and provisionTenant() is never auto-invoked.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// OS user name for a workspace slug. Prefixed + sanitised; Linux usernames ≤32.
export const unixUserFor = (slug) => `wt_${String(slug).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 28)}`;

// Per-tenant filesystem layout (mirrors today's single-tenant ~/.webtmux + projects).
export function tenantPaths(tenant) {
  const user = tenant.unix_user || unixUserFor(tenant.slug);
  const home = `/home/${user}`;
  return {
    user,
    home,
    projectsRoot: path.join(home, 'projects'),
    dataDir: path.join(home, '.webtmux'),
    // each tenant uses its own tmux server socket so sessions can't cross tenants
    tmuxSocket: `/tmp/tmux-${user}/default`,
  };
}

// tmux session names are tenant-prefixed so they never collide and listings can be
// filtered by tenant. `name` is the existing intra-tenant name (e.g. "r-video-s1").
export const tenantSession = (tenant, name) => `t-${tenant.slug}-${name}`;
export const sessionPrefix = (tenant) => `t-${tenant.slug}-`;
export const sessionBelongsTo = (tenant, session) => String(session).startsWith(sessionPrefix(tenant));

// Subdomain preview label: <project>--<slug>.BASE_DOMAIN. Globally unique because
// slug is unique. Double-hyphen separates project from tenant (single hyphens are
// legal inside each, so split on the LAST "--").
export const previewLabel = (tenant, project) => `${project}--${tenant.slug}`;
export function parsePreviewLabel(label) {
  const i = String(label).lastIndexOf('--');
  if (i < 0) return null; // not a tenant-scoped label
  return { project: label.slice(0, i), slug: label.slice(i + 2) };
}

// --- provisioning (executes only when explicitly called) --------------------
const PROVISION_HELPER = process.env.WEBTMUX_PROVISION_BIN || '/usr/local/sbin/webtmux-provision';

// Create the OS user + home/projects/.webtmux for a workspace (helper is
// idempotent), then record unix_user via the injected setter (store.setWorkspaceUnixUser).
// Requires the root helper installed + a sudoers grant — see saas/provision-tenant.sh.
export async function provisionTenant(workspace, { setUnixUser }) {
  const user = unixUserFor(workspace.slug);
  await execFileAsync('sudo', ['-n', PROVISION_HELPER, 'create', user]);
  if (setUnixUser) setUnixUser(workspace.id, user);
  return user;
}

// Remove a tenant's OS sandbox (kills its processes/tmux, archives + deletes the
// home). Used by admin "remove access". Idempotent; tolerant if already gone.
export async function deprovisionTenant(workspaceOrSlug) {
  const user = typeof workspaceOrSlug === 'string'
    ? unixUserFor(workspaceOrSlug)
    : (workspaceOrSlug.unix_user || unixUserFor(workspaceOrSlug.slug));
  await execFileAsync('sudo', ['-n', PROVISION_HELPER, 'delete', user]);
  return user;
}

// Run a command inside the tenant's sandbox (as its OS user) via the validated
// root helper. Used by the orchestrator once tenancy is wired (Stage 3b) so
// agents/tmux/git execute as the tenant uid, not the shared app uid. Flag-off
// code never calls this — legacy ops run as the app user, unchanged.
const RUN_HELPER = process.env.WEBTMUX_RUN_BIN || '/usr/local/sbin/webtmux-run';
export function tenantExecArgs(tenant, argv) {
  const { user } = tenantPaths(tenant);
  return ['sudo', '-n', RUN_HELPER, user, ...argv];
}

// Build the runtime tenant context the orchestrator threads through git()/tmux()
// and session naming. Accepts either a workspace row { id, slug, unix_user } or a
// previously-serialized context (same data shape) — so it can be rebuilt on load.
// The methods (wrap/session) don't survive JSON, so always rebuild via this.
export function tenantContext(src) {
  const slug = src.slug;
  const ctx = {
    id: src.id, slug, unix_user: src.unix_user || unixUserFor(slug),
    ...tenantPaths({ slug, unix_user: src.unix_user }),
    // wrap an argv (e.g. ['git', ...] / ['tmux', ...]) to run as the tenant's OS user
    wrap(argv) { return tenantExecArgs(this, argv); },
    // tenant-prefixed tmux session name (never collides across tenants)
    session(name) { return tenantSession(this, name); },
    // serializable descriptor to persist on the run (methods stripped)
    toJSON() { return { id: this.id, slug: this.slug, unix_user: this.unix_user }; },
  };
  return ctx;
}
