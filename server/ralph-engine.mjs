// server/ralph-engine.mjs — the Ralph orchestrator: run state (ralphRuns),
// the 4s tick, story worktree/worker/review/finalize spawning, mid-build
// supervision + MASTER.md, GitHub remote/push, flutter/windows delivery and
// packaging, and the start/adopt/startRunFromRequest entry points.
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as saasStore from '../saas/store.mjs';
import * as saasPlans from '../saas/plans.mjs';
import * as saasTenants from '../saas/tenants.mjs';
import { validModelId } from '../ralph/solo-models.mjs';
import { validateSource, validateSshTarget, shRemoteQuote } from '../ralph/adopt-paths.mjs';
import { isFlutterRun, diskOkForBuild, FLUTTER_BUILD_FORMAT } from '../ralph/flutter-env.mjs';
import { parseDeliverResult, deliverableMarkdown, apkFileName } from '../ralph/flutter-deliver.mjs';
import { pwaReport } from '../ralph/pwa-validate.mjs';
import {
  WINDOWS_WORKFLOW_PATH, WINDOWS_CHECKLIST_DOC, tauriConfJson, cargoToml, mainRs, buildRs,
  windowsPackageYaml, windowsChecklistMd, defaultWindowsAppId, sanitizeProductName, pngSolidIcon,
} from '../ralph/windows-scaffold.mjs';
import { installerShareName, parseWindowsDeliverResult, windowsDeliverableMarkdown } from '../ralph/windows-deliver.mjs';
import {
  STORE_WORKFLOW_PATH, STORE_DOC, electronPackageJson, electronMainJs, windowsStoreYaml,
  storeShareName, storeSubmissionMd,
} from '../ralph/windows-store.mjs';
import { normalizeMedia, normalizeMediaModels, withFormatMediaDefaults } from '../ralph/providers.mjs';
import { normalizePlatforms, probeArgs, parseProbe } from '../ralph/social-formats.mjs';
import { mediaOutputReport } from '../ralph/media-validate.mjs';
import { parseMediaDeliverResult, mediaDeliverableMarkdown, galleryDriveHtml } from '../ralph/media-deliver.mjs';
import { normalizeResearchBudget } from '../ralph/research.mjs';
import { detectAuthFailure } from '../ralph/agent-failure.mjs';
import { smartName, previewSafeProject } from '../ralph/smart-name.mjs';
import { parseRepoSlug } from '../ralph/github-secrets.mjs';
import {
  BASE_DOMAIN, DATA_DIR, MULTITENANT, NAME_RE, PROJECTS_ROOT, RALPH_DIR, REPO_ROOT,
  STAGED_ASSETS_DIR, STATIC_OUTPUT_DIRS, audit, execFileAsync, readJson, writeJson, validProject,
} from './config.mjs';
import { firebaseConfig, githubToken, mediaCapsEffective } from './secrets.mjs';
import { tmux, paneTail, paneSignature } from './tmux.mjs';
import {
  WORKTREES_SUBDIR, git, isGitRepo, ensureProjectDir, gitInitProject, gitCommitAll,
  gitAddWorktree, gitRemoveWorktree, gitMergeBranch,
} from './git.mjs';
import { listSshHosts, scaffoldContext } from './projects.mjs';
import {
  OUTPUT_SKILL, OUTPUT_TOOLS, getSkillMd, mcpCapabilitiesFor, mcpServersFor, writeMcpConfig,
} from './skills.mjs';
import {
  VALID_AGENTS, credFileLines, missingAgentCreds, missingKeysError, ralphEnvPrefix,
  researchKeysFor, runModelFlag, shq, tenantKey,
} from './agents.mjs';
import { callPlanner, extractJson } from './llm.mjs';
import { planPrd, normalizePrd } from './planner.mjs';
import {
  loadPrefs, recordOutcome, recordPrdEditSignal, recordPrefSignal, refreshProfileNote,
} from './prefs.mjs';
import { sendPush, sendPushRun } from './push.mjs';

// --- Ralph orchestrator engine ----------------------------------------------
// One run per project. Each story builds in its own worktree+branch via a worker
// tmux session; workers run in parallel, gated only by `deps`. A worker writes
// `.ralph/<id>.exit` when its loop ends; the tick reaps it, (M6: master-reviews,)
// merges the branch into main, and unblocks dependents. State persists so a
// restart can show the last-known status.
export const RALPH_STATE_DIR = path.join(DATA_DIR, 'ralph');
const RALPH_SH = path.join(RALPH_DIR, 'ralph.sh');
const RALPH_REVIEW_SH = path.join(RALPH_DIR, 'ralph-review.sh');
const RALPH_FINALIZE_SH = path.join(RALPH_DIR, 'ralph-finalize.sh');
const RALPH_DELIVER_SH = path.join(RALPH_DIR, 'ralph-deliver.sh');
const RALPH_WINDOWS_DELIVER_SH = path.join(RALPH_DIR, 'ralph-windows-deliver.sh');
const RALPH_RESEARCH_SH = path.join(RALPH_DIR, 'ralph-research.sh');
// Progress-aware reaping: a building/reviewing story is only reaped+retried when
// its agent has been *idle* (no new pane output) past RALPH_STALL_MS — heavy
// stories (npm install, big builds, long model turns) are slow but alive and must
// not be killed mid-flight. RALPH_HARD_CAP_MS is an absolute ceiling so an agent
// that loops forever (busy but never finishing) still gets bounded.
const RALPH_STALL_MS = Number(process.env.WEBTMUX_STALL_MS || 5 * 60 * 1000);
// Flutter builds are heavy (multi-GB, several minutes); give the delivery pass a
// longer leash before the tick gives up and finishes with just the web preview.
const FLUTTER_DELIVER_STALL_MS = Number(process.env.WEBTMUX_DELIVER_STALL_MS || 15 * 60 * 1000);
// Windows installers build off-box on GitHub Actions (Rust compile ~10-15 min) — a longer cap.
const WINDOWS_DELIVER_STALL_MS = Number(process.env.WEBTMUX_WINDOWS_DELIVER_STALL_MS || 25 * 60 * 1000);
// Social-video Drive delivery is a handful of small uploads via the artifact-share
// wrapper — much faster than the Windows/flutter delivery passes above.
const MEDIA_DELIVER_STALL_MS = Number(process.env.WEBTMUX_MEDIA_DELIVER_STALL_MS || 10 * 60 * 1000);
// Max flutter-app workers building at once — these builds are RAM-heavy, so on a small box
// running many in parallel OOMs it. Other output formats stay unbounded (the prior behavior).
const FLUTTER_MAX_PARALLEL = Number(process.env.WEBTMUX_FLUTTER_MAX_PARALLEL || 2);
const RALPH_HARD_CAP_MS = Number(process.env.WEBTMUX_HARD_CAP_MS || 30 * 60 * 1000);
// Some CLIs (claude/gemini/qwen in print mode) buffer ALL output until the end,
// so their pane looks frozen for the whole build. File writes are the truthful
// liveness signal: the agent touches the worktree as it works. One cheap
// `find -quit` only when the pane has already gone idle.
async function worktreeActive(run, storyId, sinceMs) {
  const wt = path.join(run.dir, WORKTREES_SUBDIR, storyId);
  try {
    const { stdout } = await execFileAsync('find', [
      wt, '-newermt', new Date(Date.now() - sinceMs).toISOString(),
      '-not', '-path', '*/node_modules/*', '-print', '-quit',
    ], { timeout: 10_000 });
    return !!stdout.trim();
  } catch { return false; }
}
// True only if the agent in `sessionName` is genuinely hung: no new pane output
// AND no file activity for RALPH_STALL_MS, or it has blown the absolute build
// ceiling. Side effect: refreshes story.lastActivity/paneSig while alive.
async function agentStalled(run, story, sessionName) {
  const now = Date.now();
  const sig = await paneSignature(sessionName);
  if (sig && sig !== story.paneSig) { story.paneSig = sig; story.lastActivity = now; }
  const total = now - (story.phaseSince || now);
  if (total > RALPH_HARD_CAP_MS) return true;
  const idle = now - (story.lastActivity || story.phaseSince || now);
  if (idle <= RALPH_STALL_MS) return false;
  // Pane is quiet past the threshold — check the filesystem before declaring
  // death (a silently-buffering CLI mid-build was previously reaped here and
  // redid all its work, the main cause of "builds take longer than usual").
  if (await worktreeActive(run, story.id, RALPH_STALL_MS)) { story.lastActivity = now; return false; }
  return true;
}

// ── Mid-build supervision: checkpoints + escalation ──────────────────────────
// Between spawn and exit a worker used to run unsupervised for its whole build.
// Two channels close that gap (both one-shot LLM calls in the master's persona,
// on the tenant's credential — fast and cheap, no extra tmux session):
//  1. CHECKPOINT — after RALPH_CHECKPOINT_MS of building, the supervisor reads
//     the worker's terminal and decides: continue, steer (drop a note into the
//     worktree's .ralph/steer.md, which prompt.md tells the worker to check
//     before each major step), or restart (kill + respawn with direction; the
//     branch survives so committed work carries over).
//  2. ESCALATION — prompt.md tells the worker to write a design-fork question to
//     .ralph/question.md and continue on its best guess; we answer once into
//     .ralph/answer.md, which the worker reads before committing.
// Skipped for glm (single-shot, can't follow the channel) and the stub harness.
const RALPH_CHECKPOINT_MS = Number(process.env.WEBTMUX_CHECKPOINT_MS || 6 * 60 * 1000);
const RALPH_CHECKPOINT_MAX = Number(process.env.WEBTMUX_CHECKPOINT_MAX || 2);
const supervisable = (story) => story.assignee !== 'glm' && !process.env.RALPH_FORCE_TOOL;

// One-line status of every story — lets the supervisor rule consistently with
// what the rest of the team already built or got rejected for.
const teamBoard = (run) => run.stories
  .map((s) => `- ${s.id} "${s.title}" [${s.status}]${s.lastReject ? ` (last reject: ${String(s.lastReject).slice(0, 100)})` : ''}`)
  .join('\n');

// ── MASTER.md — the master's logbook ─────────────────────────────────────────
// The master's persistent working memory for one build: a status board plus
// append-only decisions / steering / learnings. The ORCHESTRATOR writes it
// deterministically on every state change (no LLM call to document anything);
// every supervision call READS it, so rulings stay consistent without
// re-deriving the world each time, and new workers inherit prior rulings via
// their brief. Rendered to <run.dir>/.ralph/MASTER.md (gitignored) and exposed
// to the UI; the structured entries live in run state (survive restarts).
const mlog = (run) => (run.masterLog ||= { decisions: [], steering: [], learnings: [] });
const mlogPush = (list, entry, cap = 50) => { list.push(entry); if (list.length > cap) list.splice(0, list.length - cap); };
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
export function masterLogText(run) {
  const m = mlog(run);
  const sec = (title, list, fmt) => (list.length ? `\n## ${title}\n${list.map(fmt).join('\n')}\n` : '');
  return `# Master log — ${run.project}\nIdea: ${String(run.idea || '').slice(0, 300)}\nMaster: ${run.master} · phase: ${run.phase}\n`
    + `\n## Status board\n${teamBoard(run)}\n`
    + sec('Decisions & rulings', m.decisions, (d) => `- ${hhmm(d.at)} ${d.story} asked: ${d.q}\n  → ruling: ${d.a}`)
    + sec('Steering log', m.steering, (s) => `- ${hhmm(s.at)} ${s.story} checkpoint → ${s.action.toUpperCase()}: ${s.note}`)
    + sec('Learnings', m.learnings, (l) => `- ${hhmm(l.at)} ${l.note}`);
}
async function writeMasterLog(run) {
  try { await fs.writeFile(path.join(run.dir, '.ralph', 'MASTER.md'), masterLogText(run)); } catch { /* best-effort */ }
}
// A learning is one line about what went wrong/right — fed by reject/stall paths.
export function recordMasterLearning(run, note) {
  mlogPush(mlog(run).learnings, { at: Date.now(), note: String(note).slice(0, 200) });
}
// Human activity feed — one line per meaningful build event, rendered as a live
// timeline on the build page so waiting feels like watching a team work.
export function recordRunEvent(run, text) {
  (run.events ||= []).push({ at: Date.now(), text: String(text).slice(0, 220) });
  if (run.events.length > 120) run.events.splice(0, run.events.length - 120);
}
// What a freshly-spawned worker must know from the log: standing rulings + the
// most recent steers (so parallel/new workers don't re-litigate settled forks).
function masterNotesForBrief(run) {
  const m = mlog(run);
  const lines = [
    ...m.decisions.slice(-6).map((d) => `- Ruling (${d.story}): ${d.q.split('\n')[0].slice(0, 120)} → ${d.a.slice(0, 200)}`),
    ...m.learnings.slice(-4).map((l) => `- Learning: ${l.note}`),
  ];
  return lines.length ? lines.join('\n') : '';
}

async function answerWorkerQuestion(run, story) {
  const ctl = path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph');
  let q;
  try { q = (await fs.readFile(path.join(ctl, 'question.md'), 'utf8')).trim(); } catch { return; }
  // Dedupe on the SAME truncation as what we store, or a long question never
  // matches its stored copy and gets re-answered every tick (burning LLM calls
  // and flooding the log with duplicate rulings).
  const qKey = q.slice(0, 500);
  if (!q || story.qa?.q === qKey) return; // same question, already handled
  story.qa = { q: qKey, a: null };
  try {
    const raw = await callPlanner([
      { role: 'system', content: 'You are the master/integrator of an autonomous multi-agent software build. A worker hit a design decision and asked you to rule. Your MASTER LOG (status, prior rulings, steering, learnings) is provided — stay CONSISTENT with prior rulings. Decide NOW in <= 3 sentences, optimizing for consistency across the project and shipping fast. No hedging — one concrete ruling.' },
      { role: 'user', content: `Your master log:\n${masterLogText(run).slice(-3500)}\n\nWorker ${story.assignee} on story ${story.id} "${story.title}" asks:\n${q}` },
    ], { tenant: run.tenant || null });
    const a = String(raw || '').trim().slice(0, 800);
    if (!a) return;
    await fs.writeFile(path.join(ctl, 'answer.md'), a + '\n');
    story.qa.a = a;
    recordRunEvent(run, `🧠 ${story.id} asked the master · ruling: ${a.split('\n')[0].slice(0, 110)}`);
    const decisions = mlog(run).decisions;
    const qShort = q.slice(0, 200);
    if (!decisions.some((d) => d.story === story.id && d.q === qShort)) {
      mlogPush(decisions, { at: Date.now(), story: story.id, q: qShort, a: a.slice(0, 300) });
    }
    await writeMasterLog(run);
    audit({ ralph: run.project, story: story.id, question: q.slice(0, 120), answered: true });
  } catch { /* best-effort — never blocks the build */ }
}

async function checkpointStory(run, story) {
  story.checkpoints = (story.checkpoints || 0) + 1;
  story.lastCheckpoint = Date.now();
  let pane = '';
  try { pane = (await tmux(['capture-pane', '-p', '-t', story.session])).stdout || ''; } catch { return; }
  const tail = pane.split('\n').filter((l) => l.trim()).slice(-50).join('\n');
  const elapsed = Math.round((Date.now() - (story.phaseSince || Date.now())) / 60000);
  // The terminal alone can mislead (some CLIs buffer all output until the end) —
  // give the supervisor the agent's actual file activity too.
  const wt = path.join(run.dir, WORKTREES_SUBDIR, story.id);
  const gitStat = await git(wt, ['status', '--porcelain']).then((r) => (r.stdout || '').split('\n').slice(0, 15).join('\n')).catch(() => '');
  const fileActive = await worktreeActive(run, story.id, 3 * 60 * 1000);
  let parsed;
  try {
    const raw = await callPlanner([
      { role: 'system', content: 'You supervise an autonomous AI coding agent mid-build. Your MASTER LOG (status, prior rulings, steering, learnings) is provided — keep direction consistent with it. Judge whether the agent is on track to meet the acceptance criteria soon. IMPORTANT: a quiet terminal does NOT mean stuck — some CLIs print nothing until they finish; weigh the FILE ACTIVITY signals instead. Reply ONLY JSON {"action":"continue"|"steer"|"restart","note":"one or two sentences of direction"}. "continue" = progressing on-scope (default when in doubt). "steer" = visibly off-scope or over-engineering — the note is delivered to it mid-run. "restart" = clearly down a dead end; starting over WITH your direction would be faster (uncommitted work is lost, commits survive).' },
      { role: 'user', content: `Your master log:\n${masterLogText(run).slice(-3000)}\n\nStory ${story.id} "${story.title}" — attempt ${(story.iterations || 0) + 1}, building for ${elapsed}m.\nAcceptance criteria:\n${(story.acceptanceCriteria || []).map((c) => '- ' + c).join('\n')}\n\nFile activity: ${fileActive ? 'files changed within the last 3 minutes (agent is actively working)' : 'no file changes in the last 3 minutes'}\nUncommitted changes (git status):\n${gitStat || '(none)'}\n\nWorker terminal (last lines — may be empty if the CLI buffers output):\n${tail}` },
    ], { json: true, tenant: run.tenant || null });
    parsed = extractJson(raw);
  } catch { return; }
  if (!parsed || !['steer', 'restart'].includes(parsed.action)) return;
  const note = sanitizeNote(String(parsed.note || '').slice(0, 400));
  if (!note) return;
  (story.steers = story.steers || []).push({ action: parsed.action, note, at: Date.now() });
  recordRunEvent(run, `🧭 master ${parsed.action === 'steer' ? 'steered' : 'restarted'} ${story.id}: ${note.slice(0, 110)}`);
  mlogPush(mlog(run).steering, { at: Date.now(), story: story.id, action: parsed.action, note: note.slice(0, 300) });
  await writeMasterLog(run);
  audit({ ralph: run.project, story: story.id, checkpoint: parsed.action, note: note.slice(0, 120) });
  if (parsed.action === 'steer') {
    const ctl = path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph');
    await fs.mkdir(ctl, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(ctl, 'steer.md'), note + '\n').catch(() => {});
  } else {
    try { await tmux(['kill-session', '-t', story.session]); } catch { /* gone */ }
    await fs.rm(path.join(run.dir, '.ralph', `${story.id}.exit`), { force: true }).catch(() => {});
    await gitRemoveWorktree(run.dir, story.id).catch(() => {});
    try { await spawnWorker(run, story, `the supervisor stopped your previous run mid-build: ${note}`); }
    catch { /* next tick's stall path will handle it */ }
  }
}
// Strip shell-unsafe characters from a master reject reason before it is embedded
// in a worker launch command and forwarded to the next attempt.
const sanitizeNote = (s) => String(s || '').replace(/[^\w .,:;!?()/-]/g, ' ').slice(0, 300);
export const clampInt = (v, lo, hi, def) => Math.min(Math.max(parseInt(v, 10) || def, lo), hi);
// DNS-safe project slug (lowercase, hyphenated) so it works as a subdomain label.
export const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'User-Agent': 'webtmux-ralph', 'X-GitHub-Api-Version': '2022-11-28',
});
export const ralphRuns = new Map(); // runKey -> run

// Storage/map key for a run. Multi-tenant: namespaced by the tenant slug so two
// tenants can hold a project with the same name without colliding (the slug is a
// DNS-safe label, so `slug--project` is a safe filename too). Single-tenant: the
// bare project name, byte-identical to before.
export const runKey = (project, tenant) => (tenant ? `${tenant.slug}--${project}` : project);
// Tenant context for an authed request (only when MULTITENANT); null single-tenant.
export const tenantOf = (req) => (MULTITENANT && req?.tenant ? saasTenants.tenantContext(req.tenant) : null);
// Live preview URL for a run: `<project>--<slug>.DOMAIN` for a tenant build (routed by
// the host middleware to the tenant's home), `<project>.DOMAIN` single-tenant. null
// when the project name isn't a valid DNS label.
export function previewUrlFor(run) {
  if (!/^[a-z0-9-]+$/.test(run.project)) return null;
  const slug = run.tenant?.slug;
  const label = slug ? `${run.project}--${slug}` : run.project;
  return `https://${label}.${BASE_DOMAIN}`;
}

export const storyById = (run, id) => run.stories.find((s) => s.id === id);
// A skipped dep is satisfied: the user explicitly chose to continue without it.
const depsSatisfied = (run, story) =>
  (story.deps || []).every((d) => ['merged', 'skipped'].includes(storyById(run, d)?.status));

export function ralphSessionName(project, id, kind = 'r', tenant = null) {
  // ALWAYS keep the story id at the END: a long project name must not truncate it away, or
  // every story collides on one tmux session name (each spawn kills the previous worker — this
  // really bit a long prompt-as-project-name). Truncate the project portion + add a short
  // project hash so distinct (project, story) pairs never collide.
  const proj = project.replace(/[^A-Za-z0-9]/g, '');
  const h = crypto.createHash('sha1').update(String(project)).digest('hex').slice(0, 4);
  const room = Math.max(3, 24 - kind.length - String(id).length);
  const base = `${kind}-${proj.slice(0, room)}${h}-${id}`;
  const name = NAME_RE.test(base) ? base : `${kind}-${h}-${id}`;
  // Multi-tenant: prefix with the tenant's OS user (`wt_…-`) so names never collide
  // across tenants AND so tmux() can derive the sandbox from the name (see tmux()).
  return tenant ? `${tenant.unix_user}-${name}` : name;
}
export function runSummary(run) {
  const total = run.stories.length;
  const merged = run.stories.filter((s) => s.status === 'merged').length;
  const elapsedMs = run.startedAt ? Date.now() - run.startedAt : null;
  const active = run.phase === 'building' || run.phase === 'finalizing';
  // Rough ETA: average time per merged story × stories still outstanding.
  const etaMs = (active && merged > 0 && merged < total && elapsedMs)
    ? Math.round((elapsedMs / merged) * (total - merged)) : null;
  // Surface failed/blocked stories so the UI can offer to switch the agent instead
  // of the run failing silently.
  const failed = run.stories.filter((s) => s.status === 'failed' || s.status === 'blocked');
  const authFailed = failed.filter((s) => s.authError);
  const attention = failed.length ? {
    stories: failed.map((s) => s.id),
    agents: [...new Set(failed.map((s) => s.assignee))],
    master: run.master,
    authError: authFailed.length > 0,
    message: authFailed.length
      ? `${authFailed.length} stor${authFailed.length === 1 ? 'y' : 'ies'} couldn't authenticate — the API key for ${[...new Set(authFailed.map((s) => s.assignee))].join(', ')} looks invalid or expired. Go to Settings → Providers, click Test to confirm, fix the key, then retry.`
      : `${failed.length} stor${failed.length === 1 ? 'y' : 'ies'} failed — the assigned agent(s) (${[...new Set(failed.map((s) => s.assignee))].join(', ')}) or the master (${run.master}) may not be working. Switch agent and retry?`,
  } : null;
  return {
    project: run.project, phase: run.phase, master: run.master, workers: run.workers,
    maxAttempts: run.maxAttempts ?? run.max ?? 3, workerPasses: run.workerPasses ?? 1,
    bypass: run.bypass !== false,
    apk: run.apk || null, // flutter-app: { shareLink, qr } once delivered
    deliverWarning: run.deliverWarning || null,
    submit: run.submit || null, // flutter-app: Play submission scaffold status
    windows: run.windows || null, // web-app: Windows installer/store scaffold + delivery status
    windowsDeliverKind: run.phase === 'windows-delivering' ? (run.windowsDeliverKind || 'installer') : null,
    outputFormat: run.outputFormat || 'auto',
    platforms: run.platforms || null,
    mediaModels: run.mediaModels && Object.keys(run.mediaModels).length ? run.mediaModels : null,
    mediaReport: run.mediaReport || null, // social-video: per-platform verification (advisory)
    mediaShare: run.mediaShare || null, // social-video: Drive links after auto-upload

    paused: !!run.paused,
    events: (run.events || []).slice(-60),
    repo: run.repo || null, error: run.error || null, pushWarning: run.pushWarning || null,
    startedAt: run.startedAt || null, elapsedMs, etaMs, attention,
    // Live preview link — tenant-scoped (<project>--<slug>) for tenant builds.
    previewUrl: previewUrlFor(run),
    stories: run.stories.map((s) => ({
      id: s.id, title: s.title, assignee: s.assignee, status: s.status,
      startAt: s.startAt || null, revision: !!s.revision,
      description: s.description || '', acceptanceCriteria: s.acceptanceCriteria || [],
      deps: s.deps || [], iterations: s.iterations || 0, error: s.error || null,
      progress: s.progress || null, // transient compose step (social-video)
      // Mid-build supervision trail: the worker's raised question (+ master's
      // ruling) and any steer/restart directions issued at checkpoints.
      question: s.qa || null,
      steers: (s.steers || []).map((x) => ({ action: x.action, note: x.note })),
    })),
  };
}
export async function persistRun(run) {
  writeMasterLog(run).catch(() => {}); // keep the logbook's status board current
  await fs.mkdir(RALPH_STATE_DIR, { recursive: true });
  await writeJson(path.join(RALPH_STATE_DIR, `${run.key || run.project}.json`), run);
  // Index is per-tenant (written into that tenant's projects root, scoped to its
  // runs) so one tenant's index never lists another's. Single-tenant: PROJECTS_ROOT.
  await regenerateProjectIndex(run.tenant).catch(() => {}); // keep the index in lockstep
}

// GitHub-style heading slug for in-page anchors (lowercase; keep word chars & -).
const mdAnchor = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');

// Regenerate the projects index (`projects.json` + `INDEX.md`) at PROJECTS_ROOT so
// an AI agent can discover every Ralph build from ONE file instead of crawling
// dirs and joining the external run state. Rebuilt on every state change and on
// deletion, so it always mirrors reality. Best-effort — never throws into callers.
const KEY_FILE_ANCHORS = [
  ['spec', 'prd.json'], ['readme', 'README.md'], ['deliverable', 'DELIVERABLE.md'],
  ['progress', 'progress.txt'], ['context', 'AGENTS.md'],
];
export async function regenerateProjectIndex(tenant = null) {
  try {
    const root = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
    const runs = [];
    for (const f of await fs.readdir(RALPH_STATE_DIR).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      const run = await readJson(path.join(RALPH_STATE_DIR, f), null);
      // Scope the index to the tenant whose root we're writing: a tenant index lists
      // only its runs; the single-tenant index lists only non-tenant runs.
      if (!run?.project) continue;
      if (tenant ? run.tenant?.slug !== tenant.slug : run.tenant) continue;
      runs.push(run);
    }
    runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); // most recent first

    const entries = [];
    for (const run of runs) {
      const dir = path.join(root, run.project);
      const dnsOk = /^[a-z0-9-]+$/.test(run.project);
      const stories = Array.isArray(run.stories) ? run.stories : [];
      // Guiding anchors: only link files that actually exist, so links never dangle.
      const files = {};
      for (const [k, fname] of KEY_FILE_ANCHORS) {
        if (await fs.stat(path.join(dir, fname)).then(() => true).catch(() => false)) files[k] = `${run.project}/${fname}`;
      }
      entries.push({
        name: run.project,
        description: run.description || run.idea || '',
        phase: run.phase || 'unknown',
        outputFormat: run.outputFormat || 'auto',
        master: run.master || null, workers: run.workers || [],
        stories: stories.length,
        merged: stories.filter((s) => s.status === 'merged').length,
        skills: [...new Set(stories.flatMap((s) => s.skills || []))],
        tools: [...new Set(stories.flatMap((s) => s.tools || []))],
        repo: run.repo || null,
        previewUrl: dnsOk ? previewUrlFor(run) : null,
        dir, files, updatedAt: run.startedAt || null,
      });
    }

    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'projects.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), count: entries.length, projects: entries }, null, 2));
    await fs.writeFile(path.join(root, 'INDEX.md'), renderProjectIndexMd(entries));
  } catch { /* index is best-effort */ }
}

// INDEX.md: a guide header for AI agents + one section per project with "guiding
// anchors" (relative links to each project's key files).
function renderProjectIndexMd(entries) {
  const PHASE = { done: '✅ done', failed: '❌ failed', push_failed: '⚠️ built (push failed)', building: '🛠️ building', finalizing: '🛠️ finalizing' };
  const L = [];
  L.push('# Projects index', '');
  L.push('> Auto-generated by webtmux Ralph — do NOT hand-edit; rewritten on every build state');
  L.push('> change and on deletion. For agents: this is the single source of truth for what lives here.', '');
  L.push('**Layout:** each project is a git repo at `./<name>/`; authoritative run state is');
  L.push('`~/.webtmux/ralph/<name>.json`. Per project, start from these anchors — `prd.json` = spec/');
  L.push('stories · `README.md` = overview · `DELIVERABLE.md` = what/where the output is · `progress.txt`');
  L.push('= build learnings · `AGENTS.md` = conventions.', '');
  L.push(`_${entries.length} project(s) · generated ${new Date().toISOString()}_`, '');
  if (!entries.length) { L.push('_No Ralph projects yet._'); return L.join('\n') + '\n'; }
  L.push('## Contents');
  for (const e of entries) L.push(`- [${e.name}](#${mdAnchor(e.name)}) — ${PHASE[e.phase] || e.phase}`);
  L.push('');
  for (const e of entries) {
    L.push(`## ${e.name}`);
    if (e.description) L.push(e.description, '');
    const meta = [`status: ${PHASE[e.phase] || e.phase}`, `output: ${e.outputFormat}`, `stories: ${e.merged}/${e.stories} merged`];
    if (e.master) meta.push(`master: ${e.master}`);
    L.push('- ' + meta.join(' · '));
    if (e.previewUrl) L.push(`- live: [${e.previewUrl}](${e.previewUrl})`);
    if (e.repo) L.push(`- repo: ${e.repo}`);
    if (e.skills.length) L.push(`- skills: ${e.skills.join(', ')}`);
    if (e.tools.length) L.push(`- tools: ${e.tools.join(', ')}`);
    const anchors = Object.entries(e.files).map(([k, p]) => `[${k}](${p})`);
    if (anchors.length) L.push(`- files: ${anchors.join(' · ')}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}
async function readExitCode(file) {
  try { const n = parseInt((await fs.readFile(file, 'utf8')).trim(), 10); return Number.isFinite(n) ? n : null; }
  catch { return null; }
}

// Build the skills/tools/output brief that gets injected into an agent's prompt,
// and (when the work uses MCP tools) write the gateway config into `dir` so the
// agent can reach Google Docs/Sheets/Slides. Returns the brief file path, or '' if
// there's nothing to add. The brief is model-agnostic text, so it works for any
// agent. Writes under `<dir>/.ralph/` (gitignored, so it's never committed).
async function writeRalphBrief(dir, tool, { skills = [], tools = [], outputType, outputFormat, finalize = false, mcp = null, masterNotes = '', media = null, storyMedia = null, research = null, platforms = null }) {
  const parts = [];
  // Standing rulings + learnings from the master's logbook, so a new/parallel
  // worker doesn't re-litigate settled design forks or repeat known mistakes.
  if (masterNotes) parts.push(`## Master's standing rulings & learnings (follow these)\n${masterNotes}`);
  const VISUAL_OUTPUT = new Set(['web-app', 'flutter-app', 'social-video', 'google-slides', 'pptx']);
  // A story with an approved per-story media plan (Part A) must get the imagery skill +
  // generation instruction even when the project output format isn't a classic visual one,
  // or the media the user reviewed and approved in the confirm dialog would silently never
  // be generated (e.g. the default `auto` output with images enabled).
  const hasStoryMedia = !!storyMedia && ['image', 'video', 'audio'].some((k) => storyMedia[k] > 0);
  const wantsMedia = VISUAL_OUTPUT.has(outputFormat) || hasStoryMedia;
  // Every web-app build is an installable PWA by default (Part 1): inject the
  // pwa-baseline skill into worker AND finalize briefs. Dedup below handles overlap.
  const wantsPwa = outputFormat === 'web-app';
  const briefSkills = [
    ...(wantsPwa ? ['pwa-baseline'] : []),
    ...(outputFormat === 'social-video' ? ['social-video'] : []), // storyboard schema + naming contract
    ...(wantsMedia ? ['imagery'] : []),
    // Research/data helpers (Phase C): only when the tenant actually has the key —
    // a skill telling the agent to call a helper that will just skip is noise.
    ...(research?.web ? ['web-research'] : []),
    ...(research?.data ? ['real-data'] : []),
    ...skills,
  ];
  const seen = new Set();
  for (const id of briefSkills) {
    if (!id || seen.has(id)) continue; seen.add(id);
    const md = await getSkillMd(id);
    if (md) parts.push(md.trim());
  }
  // MCP wiring: the Google-workspace gateway (when a story uses those tools) and/or the
  // local Firebase MCP server (when the firebase skill is active — flutter-app backends),
  // so the agent can manage the project/Firestore/rules/auth beyond the bare CLI.
  const needFirebase = briefSkills.includes('firebase');
  const servers = [];
  if (tools.length && mcp?.length) servers.push(...mcp);
  if (needFirebase) servers.push({ name: 'firebase', command: 'firebase', args: ['experimental:mcp', '--dir', dir] });
  if (servers.length) {
    await writeMcpConfig(dir, tool, servers).catch(() => {});
    if (tools.length && mcp?.length) parts.push(`## MCP tools available\nThe MCP connection is already authorized — no auth needed. You may call these MCP tools: ${tools.join(', ')}.\n`
      + `When you create a live Google file, capture its shareable link into DELIVERABLE.md (repo root) and progress.txt. Never print or commit tokens/secrets.`);
    if (tools.includes('web-data') && servers.some((s) => s.name === 'apify')) {
      parts.push('## Apify MCP (web-data)\nThe Apify MCP server is wired in for DISCOVERY: search the actor store, read an actor\'s docs/input schema, and browse the web via the RAG browser tool. '
        + 'To actually RUN an actor and save its dataset, use the real-data skill\'s `$RALPH_FETCH_DATA` helper — it enforces the build\'s data budget; do not start actor runs through MCP.');
    }
    if (needFirebase) parts.push('## Firebase MCP\nA Firebase MCP server is wired in (it runs against the signed-in Firebase CLI). Use its tools — or the `firebase`/`flutterfire` CLI — to create/select the project, provision Firestore, deploy rules, and configure auth, per the firebase skill.');
  }
  if (finalize) {
    parts.push(`## Final deliverable format\nThe user chose project output format: ${outputFormat || 'auto'}. Present the finished project in this form (follow the skill instructions above). Record where the deliverable lives — a file path or a shareable link — in DELIVERABLE.md and the README.`);
  } else if (outputType && outputType !== 'auto') {
    parts.push(`## Intended output\nThis story's result should be presented as: ${outputType}.`);
  }
  if (wantsMedia && media) {
    const on = (k) => media[k]?.enabled ? `on (up to ${media[k].cap})` : 'off';
    parts.push(`## Media budget for this build\nGenerated media is: image ${on('image')}, video ${on('video')}, audio ${on('audio')}.\n`
      + `Use the media helpers from the imagery skill only for the enabled kinds and within budget; otherwise use brand assets, stock, or a placeholder.`);
    // Per-story plan (Part A): the planner budgeted specific counts for THIS story.
    const planned = storyMedia && typeof storyMedia === 'object'
      ? ['image', 'video', 'audio'].filter((k) => storyMedia[k] > 0).map((k) => `${k} ×${storyMedia[k]}`)
      : [];
    if (planned.length) {
      parts.push(`## Media planned for THIS story\nThe plan budgeted generated media for this story: ${planned.join(', ')}.\n`
        + `Generate that many (a sensible number is fine if the layout needs slightly fewer), embed them per the imagery skill's placement rules with good alt text, and record each in DELIVERABLE.md. Reuse the project's ONE consistent visual style.`);
    }
  }
  if (outputFormat === 'social-video') {
    const list = (platforms?.length ? platforms : []).join(', ') || 'tiktok, instagram-reel, youtube-short';
    parts.push(`## Social video target\nThe deliverable is a ~30-second story video rendered for: ${list}.\n`
      + `Follow the social-video skill: storyboard first, generate scene assets, then ONE \`node "$RALPH_COMPOSE" story storyboard.json\` call `
      + `renders every platform as output/<name>-<platform>.mp4, and \`node "$RALPH_COMPOSE" gallery\` writes the preview page.`);
  }
  if (!parts.length) return '';
  const briefDir = path.join(dir, '.ralph');
  await fs.mkdir(briefDir, { recursive: true });
  const file = path.join(briefDir, finalize ? 'finalize.skills.md' : 'skills.md');
  await fs.writeFile(file, parts.join('\n\n---\n\n') + '\n');
  return file;
}

// Launch a Ralph command in a fresh tmux session DETERMINISTICALLY. We used to
// `new-session -d` and then `send-keys` the command — but that races the shell's
// startup: if the keystrokes land before bash is ready they are silently dropped,
// the worker never runs, no exit sentinel is written, and the story hangs until
// the stall reaper (minutes of dead air — the "agent failed to run" symptom).
// Instead we run the command AS the session's own command via a tiny script, then
// `exec bash` so the pane stays alive to inspect/attach. PATH is set explicitly
// because ~/.bashrc returns early for non-interactive shells, so the agent CLIs in
// ~/.npm-global/bin and ~/.local/bin would otherwise be missing.
async function launchRalphSession(session, dir, cmd, pre = []) {
  try { await tmux(['kill-session', '-t', session]); } catch { /* none */ }
  await fs.mkdir(path.join(dir, '.ralph'), { recursive: true });
  const script = path.join(dir, '.ralph', `.session.${session}.sh`);
  await fs.writeFile(script,
    '#!/bin/bash\n'
    // /usr/local/bin holds the SHARED agent CLIs (claude/codex/qwen/gemini) so a
    // tenant's sandbox session can find them (tmuxweb's ~/.local/bin is unreadable
    // to tenants). Listed explicitly so it never depends on runuser's default PATH.
    + 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"\n'
    + pre.map((l) => l + '\n').join('')
    + cmd + '\n');
  await tmux(['new-session', '-d', '-s', session, '-c', dir, `bash ${script}; exec bash`]);
}

// flutter-app fallback: stage the tenant's google-services.json (vault/secrets) at
// `<dir>/.ralph/google-services.json` so the firebase skill can copy it into android/app/
// during the build. The preferred CLI-login path uses `flutterfire configure` instead and
// needs none of this. No-op for non-flutter runs or when no Firebase cred is set.
async function stageFirebaseConfig(run, dir) {
  if (!isFlutterRun(run)) return;
  const cfg = tenantKey(run, 'firebase') || firebaseConfig();
  if (!cfg) return;
  try {
    await fs.mkdir(path.join(dir, '.ralph'), { recursive: true });
    await fs.writeFile(path.join(dir, '.ralph', 'google-services.json'), cfg);
  } catch { /* best-effort */ }
}

// Cap Gradle/Kotlin heap for flutter-app builds so an agent's `flutter build apk` can't OOM
// this RAM-limited box (Flutter's default daemon is -Xmx8G > the whole machine). Writes the
// runner's GRADLE_USER_HOME/gradle.properties (overrides the project's value; daemon=false so
// nothing lingers). Prepended to the worker/review/finalize session command — runs as the
// runner, so `$HOME` is its own home. No-op for non-flutter runs.
function flutterGradleCapCmd(run) {
  if (!isFlutterRun(run)) return '';
  return 'mkdir -p "$HOME/.gradle" && { echo "org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m"; '
    + 'echo "org.gradle.daemon=false"; echo "org.gradle.workers.max=2"; echo "org.gradle.parallel=false"; '
    + 'echo "kotlin.daemon.jvmargs=-Xmx1024m"; } > "$HOME/.gradle/gradle.properties"; ';
}

// Create the story's branch+worktree off the CURRENT main (so already-merged
// deps are present) and launch its worker loop in a fresh tmux session.
export async function spawnWorker(run, story, note) {
  const wt = path.join(run.dir, WORKTREES_SUBDIR, story.id);
  await fs.rm(path.join(run.dir, '.ralph', `${story.id}.exit`), { force: true }).catch(() => {});
  await gitAddWorktree(run.dir, story.id, story.branch);
  await stageFirebaseConfig(run, wt).catch(() => {});
  const session = ralphSessionName(run.project, story.id, 'r', run.tenant);
  const noteEnv = note ? `RALPH_REVIEW_NOTE="${sanitizeNote(note)}" ` : '';
  // Inject this story's skills/tools/output brief (and wire MCP if it uses tools).
  const briefFile = await writeRalphBrief(wt, story.assignee, {
    skills: story.skills || [], tools: story.tools || [],
    outputType: story.outputType, outputFormat: run.outputFormat,
    mcp: mcpServersFor(run.tenant || null),
    masterNotes: masterNotesForBrief(run),
    media: run.media, storyMedia: story.media || null,
    research: researchKeysFor(run),
    platforms: run.platforms,
  }).catch(() => '');
  const skillsEnv = briefFile ? `RALPH_SKILLS_FILE="${briefFile}" ` : '';
  const modelFlag = runModelFlag(story.assignee, 'build', run);
  const cmd = `${flutterGradleCapCmd(run)}mkdir -p .ralph && ${noteEnv}${skillsEnv}${ralphEnvPrefix(story.assignee, run)}bash ${RALPH_SH} --tool ${story.assignee} ` +
    `--story ${story.id} --dir ${wt} --max ${run.workerPasses || 1}${modelFlag}; echo $? > .ralph/${story.id}.exit`;
  await launchRalphSession(session, run.dir, cmd, credFileLines(story.assignee, run));
  story.status = 'building';
  story.phaseSince = story.lastActivity = Date.now();
  story.paneSig = '';
  story.session = session;
  run.sessions[story.id] = session;
  recordRunEvent(run, note
    ? `🔁 ${story.assignee} retrying ${story.id} — ${note.slice(0, 90)}`
    : `🛠 ${story.assignee} started ${story.id} · "${story.title}"`);
  audit({ ralph: run.project, story: story.id, tool: story.assignee, session, retry: !!note });
}

// Master reviews one finished story branch; writes ACCEPT / REJECT to a verdict file.
async function spawnReview(run, story) {
  const verdict = path.join(run.dir, '.ralph', `${story.id}.verdict`);
  await fs.rm(verdict, { force: true }).catch(() => {});
  const session = ralphSessionName(run.project, story.id, 'rv', run.tenant);
  // Review runs INSIDE the story's worktree (the branch is already checked out
  // there), NOT the main checkout. review.md mandates the reviewer actually build
  // and run the branch; doing that in `main` dirties its working tree/index and
  // makes the subsequent merge abort ("local changes would be overwritten").
  const wt = path.join(run.dir, WORKTREES_SUBDIR, story.id);
  const modelFlag = runModelFlag(run.master, 'review', run);
  const revFlag = story.revision ? ' --revision 1' : '';
  const cmd = `${flutterGradleCapCmd(run)}mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_REVIEW_SH} --tool ${run.master} ` +
    `--story ${story.id} --dir ${wt} --branch ${story.branch} --verdict ${verdict}${revFlag}${modelFlag}`;
  await launchRalphSession(session, run.dir, cmd, credFileLines(run.master, run));
  story.reviewSession = session;
}

// Master finalize/compile pass over main; writes PASS / FAIL to a result file.
async function spawnFinalize(run) {
  const result = path.join(run.dir, '.ralph', 'finalize.result');
  await fs.rm(result, { force: true }).catch(() => {});
  await stageFirebaseConfig(run, run.dir).catch(() => {});
  const session = ralphSessionName(run.project, 'final', 'rf', run.tenant);
  // Brief the master with the chosen deliverable format: the backing skill's
  // instructions + the MCP tools needed to produce it (e.g. Google Docs).
  const fmt = run.outputFormat || 'auto';
  const skills = [...new Set([OUTPUT_SKILL[fmt], ...run.stories.flatMap((s) => s.skills || [])].filter(Boolean))];
  const briefFile = await writeRalphBrief(run.dir, run.master, {
    skills, tools: OUTPUT_TOOLS[fmt] || [], outputFormat: fmt, finalize: true,
    mcp: mcpServersFor(run.tenant || null),
    media: run.media,
    research: researchKeysFor(run),
    platforms: run.platforms,
  }).catch(() => '');
  const skillsEnv = briefFile ? `RALPH_SKILLS_FILE="${briefFile}" ` : '';
  const modelFlag = runModelFlag(run.master, 'review', run);
  const cmd = `${flutterGradleCapCmd(run)}mkdir -p .ralph && ${skillsEnv}${ralphEnvPrefix(run.master, run)}bash ${RALPH_FINALIZE_SH} --tool ${run.master} ` +
    `--dir ${run.dir} --result ${result}${modelFlag}`;
  await launchRalphSession(session, run.dir, cmd, credFileLines(run.master, run));
  run.finalizeSession = session;
}

// Flutter-app delivery: build the web preview + an installable APK and share the APK to
// the admin Google Drive. Runs AS THE APP USER (tmuxweb) — it needs the 'flutterbuild'
// group (shared SDK cache) and the sudo grant for webtmux-apk-share (the Drive OAuth is
// owned by www-data), so the session name has NO tenant prefix. Writes .ralph/deliver.json
// (always — success or {error}) which the tick reaps. Stub-aware for the no-spend harness.
// Firebase Android builds need android/app/google-services.json (the google-services Gradle
// plugin requires it) — unlike the web build, which uses firebase_options.dart. When Firebase
// was connected via CLI login (no pasted config in the vault), there's no staged file and
// `flutter build apk` fails. Fetch it from the project with the tenant's logged-in firebase
// CLI and stage it at .ralph/google-services.json (the deliver script copies that into
// android/app/). Best-effort: on failure the APK build just reports the missing file as before.
async function ensureAndroidFirebaseConfig(run) {
  const staged = path.join(run.dir, '.ralph', 'google-services.json');
  if (await fs.access(staged).then(() => true).catch(() => false)) return; // vault config already staged
  if (await fs.access(path.join(run.dir, 'android', 'app', 'google-services.json')).then(() => true).catch(() => false)) return;
  let opts = '';
  try { opts = await fs.readFile(path.join(run.dir, 'lib', 'firebase_options.dart'), 'utf8'); } catch { return; }
  const block = opts.split(/static const FirebaseOptions android/)[1] || '';
  const appId = (block.match(/appId:\s*'([^']+)'/) || [])[1];
  const projectId = (block.match(/projectId:\s*'([^']+)'/) || [])[1];
  if (!appId || !projectId) return; // not a Firebase android app
  const sh = 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; cd ' + shq(run.dir)
    + '; mkdir -p .ralph; firebase apps:sdkconfig android ' + shq(appId) + ' --project ' + shq(projectId)
    + ' --out .ralph/google-services.json';
  try {
    const argv = run.tenant?.wrap ? run.tenant.wrap(['bash', '-c', sh]) : ['bash', '-c', sh];
    await execFileAsync(argv[0], argv.slice(1), { timeout: 45_000 });
  } catch (e) { console.warn(`[deliver] android firebase config fetch failed: ${e.message}`); }
}

export async function spawnDelivery(run) {
  const out = path.join(run.dir, '.ralph', 'deliver.json');
  await fs.rm(out, { force: true }).catch(() => {});
  await stageFirebaseConfig(run, run.dir).catch(() => {});
  await ensureAndroidFirebaseConfig(run).catch(() => {}); // fetch google-services.json if missing
  const session = ralphSessionName(run.project, 'deliver', 'rd'); // app-user (no tenant prefix)
  const stub = process.env.RALPH_FORCE_TOOL ? ' --stub' : '';
  const cmd = `bash ${RALPH_DELIVER_SH} --dir ${run.dir} --name ${apkFileName(run.project)} `
    + `--out ${out} --url ${previewUrlFor(run) || ''}${stub}`;
  await launchRalphSession(session, run.dir, cmd, []);
  run.deliverSession = session;
  run.deliverSince = Date.now();
}

// Phase 2b: dispatch the scaffolded "Windows Package" Action, poll it, download the installer,
// and share it to Drive — off-box. Runs AS THE APP USER (no tenant prefix) so it can sudo the
// Drive uploader. gh auth via GH_TOKEN (tenant token). Writes .ralph/windows-deliver.json (reaped).
export async function spawnWindowsDelivery(run, kind = 'installer') {
  const out = path.join(run.dir, '.ralph', 'windows-deliver.json');
  await fs.rm(out, { force: true }).catch(() => {});
  const token = tenantKey(run, 'github') || githubToken();
  const repo = parseRepoSlug(run.repo) || '';
  const name = kind === 'store' ? storeShareName(run.project) : installerShareName(run.project, 'exe');
  const session = ralphSessionName(run.project, 'windeliver', 'rd'); // app-user (no tenant prefix)
  const stub = process.env.RALPH_FORCE_TOOL ? ' --stub' : '';
  const cmd = `bash ${RALPH_WINDOWS_DELIVER_SH} --dir ${run.dir} --repo ${shq(repo)} --name ${shq(name)} `
    + `--kind ${shq(kind)} --out ${out} --url ${shq(previewUrlFor(run) || '')}${stub}`;
  // Pass the github token to the session's environment (not the command line) for gh auth.
  await launchRalphSession(session, run.dir, cmd, [`export GH_TOKEN=${shq(token)}`]);
  run.windowsDeliverSession = session;
  run.windowsDeliverKind = kind; // the reap records the result on installer vs store
  run.windowsDeliverSince = Date.now();
}

// Social-video: upload platform renders to Drive from a spawned session (slow
// work never runs inline in the tick), sentinel-reaped below. Auto-invoked at
// finalize PASS; failure keeps local files and never fails the build.
async function spawnMediaDelivery(run) {
  const out = path.join(run.dir, '.ralph', 'media-deliver.json');
  await fs.rm(out, { force: true }).catch(() => {});
  const script = path.join(RALPH_DIR, 'ralph-media-deliver.sh');
  const stub = process.env.RALPH_FORCE_TOOL ? ' --stub' : '';
  const session = ralphSessionName(run.project, 'mediadeliver', 'rd'); // app-user (no tenant prefix)
  const cmd = `bash ${script} --dir ${run.dir} --project ${run.project} --out ${out}${stub}; exit`;
  await launchRalphSession(session, run.dir, cmd, []);
  run.mediaDeliverSession = session;
  run.mediaDeliverSince = Date.now();
  run.phase = 'media-delivering';
  recordRunEvent(run, '📤 uploading video renders to Google Drive…');
}

// Advisory PWA-baseline check on a finished web-app build. NON-BLOCKING: records
// run.pwa and surfaces a warning if the generated app isn't an installable PWA, but
// never fails the build — the app still works, and this is the prerequisite signal for
// the later Store PWA packaging path. Scans the served static output (same order the
// host serves) for a manifest, a service worker, and an offline fallback.
const PWA_SW_NAMES = ['sw.js', 'service-worker.js', 'serviceworker.js'];
const PWA_MANIFEST_NAMES = ['manifest.webmanifest', 'manifest.json'];
async function checkPwaCompliance(run) {
  if (run.outputFormat !== 'web-app') return;
  const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
  let root = null;
  for (const d of STATIC_OUTPUT_DIRS) {
    const cand = path.join(run.dir, d);
    if (await exists(path.join(cand, 'index.html'))) { root = cand; break; }
  }
  if (!root) return; // server app or no static output — skip the advisory check
  let manifest = null;
  for (const base of [root, run.dir]) {
    for (const name of PWA_MANIFEST_NAMES) {
      try { manifest = JSON.parse(await fs.readFile(path.join(base, name), 'utf8')); break; } catch { /* next */ }
    }
    if (manifest) break;
  }
  const anyExists = async (names, bases) => {
    for (const base of bases) for (const n of names) if (await exists(path.join(base, n))) return true;
    return false;
  };
  let hasServiceWorker = await anyExists(PWA_SW_NAMES, [root, run.dir]);
  if (!hasServiceWorker) {
    try { hasServiceWorker = /serviceWorker\s*\.\s*register/.test(await fs.readFile(path.join(root, 'index.html'), 'utf8')); }
    catch { /* none */ }
  }
  const hasOfflineFallback = await anyExists(['offline.html'], [root, run.dir]);
  const report = pwaReport({ manifest, hasServiceWorker, hasOfflineFallback });
  run.pwa = { ...report, at: Date.now() };
  if (report.compliant) recordRunEvent(run, '📲 PWA-ready — installable from the browser');
  else recordRunEvent(run, `⚠️ PWA baseline incomplete: missing ${report.missing.join(', ')} (app works, but not yet installable as a PWA)`);
}

// Advisory social-video output verification (spec §7b). NON-BLOCKING, mirrors
// checkPwaCompliance: ffprobe every output/*.mp4, judge against PLATFORM_SPECS via
// the pure mediaOutputReport, record run.mediaReport for the UIs. Never fails a build.
async function checkMediaOutputs(run) {
  if (run.outputFormat !== 'social-video') return;
  const outDir = path.join(run.dir, 'output');
  let names = [];
  try { names = (await fs.readdir(outDir)).filter((f) => f.endsWith('.mp4')); } catch { /* none */ }
  // Bounded: this runs inside the global tick — cap the file count (mirrors the
  // compose cap) and probe timeout so N corrupt mp4s can't stall other runs' supervision.
  const files = [];
  for (const f of names.slice(0, 12)) {
    let probe = null;
    try { probe = parseProbe((await execFileAsync('ffprobe', probeArgs(path.join(outDir, f)), { timeout: 10_000 })).stdout); }
    catch { /* unreadable -> null probe = issue */ }
    files.push({ file: `output/${f}`, probe });
  }
  const report = mediaOutputReport(files, run.platforms || []);
  run.mediaReport = { ...report, at: Date.now() };
  if (report.ok) recordRunEvent(run, `🎬 Media outputs verified — ${report.outputs.length} platform render(s) OK`);
  else recordRunEvent(run, `⚠️ Media output check: ${[...report.missing.map((p) => `missing ${p}`), ...report.outputs.filter((o) => !o.ok).map((o) => `${o.file}: ${o.issues[0]}`)].join('; ')}`);
}

// Scaffold a Tauri Windows-installer project + a windows-latest GitHub Actions workflow
// into a finished web-app repo, commit + push. The installer BUILDS ON ACTIONS, not here
// (Phase 2a: scaffold + user runs it). Locates the built static web dir the same way the
// host serves and points Tauri's frontendDist at it; copies a source icon if one is found.
export async function prepareWindowsInstaller(run, { appId, productName, version }) {
  const dir = run.dir;
  const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
  // Detect the built web output (relative to repo root) for Tauri's frontendDist.
  let webRel = '.';
  for (const d of STATIC_OUTPUT_DIRS) {
    if (await exists(path.join(dir, d, 'index.html'))) { webRel = d; break; }
  }
  const hasNodeBuild = await exists(path.join(dir, 'package.json'));
  const frontendDist = `../${webRel}`; // src-tauri sits one level under the repo root
  const conf = tauriConfJson({ productName, appId, version, frontendDist, beforeBuildCommand: '' });

  const srcTauri = path.join(dir, 'src-tauri');
  await fs.mkdir(path.join(srcTauri, 'src'), { recursive: true });
  await fs.mkdir(path.join(srcTauri, 'icons'), { recursive: true });
  await fs.writeFile(path.join(srcTauri, 'Cargo.toml'), cargoToml({ crateName: 'app' }));
  await fs.writeFile(path.join(srcTauri, 'build.rs'), buildRs());
  await fs.writeFile(path.join(srcTauri, 'src', 'main.rs'), mainRs());
  await fs.writeFile(path.join(srcTauri, 'tauri.conf.json'), JSON.stringify(conf, null, 2) + '\n');

  // Seed the icon source from the PWA icon set if present (Phase 1 emits 512/maskable).
  const iconCandidates = ['icons/512.png', 'icons/512x512.png', 'icons/icon-512.png', 'icons/icon-512x512.png',
    'icons/pwa-512x512.png', 'pwa-512x512.png', 'android-chrome-512x512.png', 'icon.png', 'icon-512.png', 'assets/brand/icon.png'];
  let seeded = false;
  for (const c of iconCandidates) {
    for (const base of [path.join(dir, webRel), dir]) {
      if (await exists(path.join(base, c))) {
        await fs.copyFile(path.join(base, c), path.join(srcTauri, 'icons', 'source.png')).catch(() => {});
        seeded = await exists(path.join(srcTauri, 'icons', 'source.png'));
        break;
      }
    }
    if (seeded) break;
  }
  // Tauri's `tauri icon` step (and `tauri build`) REQUIRE src-tauri/icons/source.png — a
  // missing icon fails the whole Actions run. When no brand icon matched, write a valid
  // placeholder so the build always succeeds; the user replaces it for branding.
  if (!seeded) {
    await fs.writeFile(path.join(srcTauri, 'icons', 'source.png'), pngSolidIcon(512, [37, 99, 235])).catch(() => {});
  }

  const wfPath = path.join(dir, WINDOWS_WORKFLOW_PATH);
  await fs.mkdir(path.dirname(wfPath), { recursive: true });
  await fs.writeFile(wfPath, windowsPackageYaml({ frontendDir: webRel, hasNodeBuild }));
  await fs.writeFile(path.join(dir, WINDOWS_CHECKLIST_DOC), windowsChecklistMd({ project: run.project, appId, version }));

  await gitCommitAll(dir, `ci(windows): scaffold Tauri installer + Actions workflow`);
  const pushed = await gitPushRef(run, 'main').catch(() => false);
  run.windows = run.windows || {};
  run.windows.installer = {
    status: pushed ? 'scaffolded' : 'scaffolded_local',
    appId, productName, version, iconSeeded: seeded,
    workflow: WINDOWS_WORKFLOW_PATH, doc: WINDOWS_CHECKLIST_DOC, at: Date.now(),
  };
  return { pushed, appId, productName, version, workflow: WINDOWS_WORKFLOW_PATH, doc: WINDOWS_CHECKLIST_DOC, iconSeeded: seeded };
}

// Phase 3: scaffold the Microsoft Store packaging into a finished web-app repo. electron
// packaging commits an Electron wrapper (store-electron/) + a windows-store.yml Actions
// workflow that builds an UNSIGNED appx (the Store re-signs uploads); pwa packaging is a
// validated manual step (pwabuilder.com has no CLI/API) — only the checklist is written.
export async function prepareWindowsStore(run, { packaging, identityName, publisher, publisherDisplayName, version }) {
  const dir = run.dir;
  const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
  let webRel = '.';
  for (const d of STATIC_OUTPUT_DIRS) {
    if (await exists(path.join(dir, d, 'index.html'))) { webRel = d; break; }
  }
  const hasNodeBuild = await exists(path.join(dir, 'package.json'));
  const productName = sanitizeProductName(run.windows?.installer?.productName, run.project);
  const appId = run.windows?.installer?.appId || defaultWindowsAppId(run.project);

  if (packaging === 'electron') {
    const wrap = path.join(dir, 'store-electron');
    await fs.mkdir(path.join(wrap, 'build-res'), { recursive: true });
    const pkg = electronPackageJson({ productName, appId, version, identityName, publisher, publisherDisplayName });
    await fs.writeFile(path.join(wrap, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    await fs.writeFile(path.join(wrap, 'main.js'), electronMainJs());
    // electron-builder derives appx tiles from buildResources/icon.png; reuse the Tauri
    // source icon when the installer step seeded one, else the placeholder.
    const srcIcon = path.join(dir, 'src-tauri', 'icons', 'source.png');
    if (await exists(srcIcon)) await fs.copyFile(srcIcon, path.join(wrap, 'build-res', 'icon.png')).catch(() => {});
    else await fs.writeFile(path.join(wrap, 'build-res', 'icon.png'), pngSolidIcon(512, [37, 99, 235])).catch(() => {});
    const wfPath = path.join(dir, STORE_WORKFLOW_PATH);
    await fs.mkdir(path.dirname(wfPath), { recursive: true });
    await fs.writeFile(wfPath, windowsStoreYaml({ frontendDir: webRel, hasNodeBuild }));
  }
  await fs.writeFile(path.join(dir, STORE_DOC), storeSubmissionMd({
    project: run.project, packaging, identityName, publisher, publisherDisplayName,
    version, previewUrl: previewUrlFor(run), appId,
  }));

  await gitCommitAll(dir, packaging === 'electron'
    ? 'ci(windows): scaffold Store packaging (Electron appx wrapper + Actions workflow)'
    : 'docs(windows): Microsoft Store submission checklist (pwabuilder path)');
  const pushed = await gitPushRef(run, 'main').catch(() => false);
  run.windows = run.windows || {};
  run.windows.store = {
    status: pushed ? 'scaffolded' : 'scaffolded_local',
    packaging, identityName, publisher, publisherDisplayName, version,
    workflow: packaging === 'electron' ? STORE_WORKFLOW_PATH : null, doc: STORE_DOC, at: Date.now(),
  };
  return { pushed, packaging, doc: STORE_DOC };
}

// Record the finished deliverable (web preview + APK install link) and commit it.
async function writeDeliverable(run, info) {
  const md = deliverableMarkdown({
    project: run.project, previewUrl: previewUrlFor(run), shareLink: info.shareLink, qr: info.qr,
  });
  await fs.writeFile(path.join(run.dir, 'DELIVERABLE.md'), md).catch(() => {});
  try { await gitCommitAll(run.dir, 'docs: record APK install link in DELIVERABLE.md'); } catch { /* best-effort */ }
}

// One-shot research pass over an adopted repo; writes RESEARCH.md + .ralph/research.done.
async function spawnResearch(run) {
  const result = path.join(run.dir, '.ralph', 'research.done');
  await fs.rm(result, { force: true }).catch(() => {});
  const session = ralphSessionName(run.project, 'research', 'rf', run.tenant);
  const modelFlag = runModelFlag(run.master, 'review', run);
  const cmd = `mkdir -p .ralph && ${ralphEnvPrefix(run.master, run)}bash ${RALPH_RESEARCH_SH} --tool ${run.master} ` +
    `--dir ${run.dir} --result ${result}${modelFlag}`;
  await launchRalphSession(session, run.dir, cmd, credFileLines(run.master, run));
  run.researchSession = session;
  run.researchSince = Date.now();
}

// Ensure the GitHub repo exists and `origin` is configured. Idempotent: a no-op
// once origin is set. For tests, RALPH_FAKE_REMOTE points at a local bare repo
// and skips the GitHub API. Throws only if it genuinely can't set up a remote.
export async function ensureRemote(run) {
  const hasOrigin = await git(run.dir, ['remote', 'get-url', 'origin']).then(() => true).catch(() => false);
  if (hasOrigin) return;
  const fake = process.env.RALPH_FAKE_REMOTE;
  if (fake) {
    await git(run.dir, ['remote', 'add', 'origin', fake]);
    run.repo = fake;
    return;
  }
  // Multi-tenant: push to the TESTER's GitHub with their own token so the repo lands
  // in their account; fall back to the server token (best-effort — push never fatal).
  const token = tenantKey(run, 'github') || githubToken();
  if (!token) throw new Error('No GitHub token configured.');
  const meResp = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
  const me = await meResp.json().catch(() => ({}));
  if (!meResp.ok) throw new Error(me?.message || `GitHub /user HTTP ${meResp.status}`);
  // GitHub rejects a repo `description` containing control chars (newlines/tabs) —
  // the idea is multi-line markdown, so flatten whitespace and strip C0/DEL first
  // or create 422s ("description control characters are not allowed").
  const description = (run.idea || '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const createResp = await fetch('https://api.github.com/user/repos', {
    method: 'POST', headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: run.project, private: true, description }),
  });
  run.repoCreateForbidden = createResp.status === 403;
  if (!createResp.ok && createResp.status !== 422 && createResp.status !== 403) {
    const e = await createResp.json().catch(() => ({}));
    throw new Error(e?.message || `GitHub create HTTP ${createResp.status}`);
  }
  const owner = me.login;
  // 422 (name taken / validation error) and 403 (fine-grained PAT can't create)
  // do NOT prove the repo exists under us. The old code assumed it did and added
  // an origin anyway — when the repo wasn't really there, every push 404'd with a
  // confusing "Repository not found". Verify existence before wiring up origin so
  // a genuinely-missing repo surfaces as an actionable warning, not a phantom remote.
  if (!createResp.ok) {
    const check = await fetch(`https://api.github.com/repos/${owner}/${run.project}`,
      { headers: ghHeaders(token) });
    if (!check.ok) {
      const e = await createResp.json().catch(() => ({}));
      const detail = e?.errors?.[0]?.message || e?.message;
      throw new Error(run.repoCreateForbidden
        ? `GitHub token can't create repos and "${owner}/${run.project}" doesn't exist — pre-create a private repo named "${run.project}" or use a classic PAT with "repo" scope`
        : `couldn't create GitHub repo "${owner}/${run.project}" (HTTP ${createResp.status}${detail ? `: ${detail}` : ''}) and it does not already exist`);
    }
  }
  await git(run.dir, ['remote', 'add', 'origin',
    `https://x-access-token:${token}@github.com/${owner}/${run.project}.git`]);
  run.repoOwner = owner;
  run.repo = `https://github.com/${owner}/${run.project}`;
}

// Best-effort push of one ref (a story branch or 'main'). Never throws: a push
// failure is recorded as a warning so a transient/offline glitch can't kill the
// build — the local repo is the source of truth and a later push catches up.
export async function gitPushRef(run, ref) {
  try {
    if (!run.repo) await ensureRemote(run);
    await git(run.dir, ['push', '-u', 'origin', ref]);
    run.pushWarning = null;
    return true;
  } catch (err) {
    run.pushWarning = run.repoCreateForbidden
      ? `push failed — token can't create repos; pre-create a private repo "${run.project}" or use a classic PAT with "repo" scope`
      : (err.stderr?.trim() || err.message);
    return false;
  }
}

// Push main to origin (used after a revise/revert).
export async function gitPushExisting(run) { await gitPushRef(run, 'main'); }

// On boot, re-register any in-progress run so the tick resumes it (a restart must
// never orphan a build).
// A persisted run stores its tenant as plain {id,slug,unix_user} (methods don't
// survive JSON); rebuild the live context so the orchestrator can run git/tmux as
// the tenant again after a restart. No-op single-tenant (run.tenant undefined).
function rehydrateTenant(run) {
  if (run && run.tenant && typeof run.tenant.wrap !== 'function') {
    run.tenant = saasTenants.tenantContext(run.tenant);
  }
  return run;
}

export async function initRalphRuns() {
  for (const f of await fs.readdir(RALPH_STATE_DIR).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const run = await readJson(path.join(RALPH_STATE_DIR, f), null);
    if (run?.project && ['building', 'finalizing', 'researching', 'awaiting'].includes(run.phase)) {
      // The filename IS the storage key (project, or slug--project for a tenant).
      run.key = run.key || f.slice(0, -5);
      // Give resumed stories a fresh idle window — the persisted lastActivity is
      // stale across the downtime and would otherwise trip an instant false reap.
      // Also clear transient supervision flags (a true persisted mid-LLM-call
      // would permanently mute the channel for that story).
      for (const s of run.stories || []) {
        if (s.status === 'building' || s.status === 'review') { s.lastActivity = Date.now(); s.paneSig = ''; }
        s.qaBusy = false; s.checkpointing = false;
      }
      if (run.phase === 'researching') run.researchSince = Date.now();
      ralphRuns.set(run.key, rehydrateTenant(run));
    }
  }
  if (ralphRuns.size) console.log(`ralph: resumed ${ralphRuns.size} in-progress run(s)`);
  await regenerateProjectIndex().catch(() => {}); // refresh the index on boot
}

// Recover a run after a restart (in-memory map is empty) from its persisted state.
// tenant scopes the lookup so two tenants' same-named projects never collide.
export async function loadRun(project, tenant = null) {
  const key = runKey(project, tenant);
  if (ralphRuns.has(key)) return ralphRuns.get(key);
  const run = await readJson(path.join(RALPH_STATE_DIR, `${key}.json`), null);
  if (run) { run.key = key; ralphRuns.set(key, rehydrateTenant(run)); }
  return run;
}

// Guarantee a README before the final push (keeps a substantial agent-written one).
async function ensureReadme(run) {
  const p = path.join(run.dir, 'README.md');
  const existing = await fs.readFile(p, 'utf8').catch(() => '');
  if (existing.trim().length > 120) return false; // agent already documented it
  const live = /^[a-z0-9-]+$/.test(run.project) ? `https://${run.project}.${BASE_DOMAIN}` : null;
  const body = [
    `# ${run.project}`, '',
    run.idea ? `> ${run.idea}\n` : '',
    live ? `**Live:** ${live}\n` : '',
    '## Stories', '',
    ...run.stories.map((s) => `- \`${s.id}\` ${s.title} — _${s.assignee}, ${s.status}_`),
    '', '## How it was built', '',
    `Autonomously built by webtmux Ralph: an OpenAI planner split the idea into stories, `
      + `worker agents (${(run.workers || []).join(', ') || '—'}) implemented them in parallel on separate `
      + `git branches, and the master agent (${run.master}) reviewed and integrated each into \`main\`.`,
    '',
  ].filter((l) => l !== '');
  await fs.writeFile(p, body.join('\n'));
  await gitCommitAll(run.dir, 'docs: add project README');
  return true;
}

// Kill every tmux session belonging to a project (workers, reviews, finalize, app).
export async function killProjectSessions(project, tenant = null) {
  const safe = project.replace(/[^A-Za-z0-9]/g, '');
  // Multi-tenant: worker/review/finalize AND the preview app session live on the
  // TENANT's tmux socket, prefixed with its unix user. Sweep the tenant socket
  // (prefixed names incl. app-) and the app socket (single-tenant app-<safe>).
  const sockets = tenant ? [tenant, null] : [null];
  for (const sock of sockets) {
    let names = [];
    try { names = (await tmux(['ls', '-F', '#{session_name}'], { tenant: sock })).stdout.split('\n').map((s) => s.trim()).filter(Boolean); } catch { /* no server */ }
    const pfx = sock ? `${sock.unix_user}-` : '';
    const re = new RegExp(`^${pfx}(r|rv|rf|app)-${safe}|^app-${safe}`);
    for (const n of names) if (re.test(n)) await tmux(['kill-session', '-t', n], { tenant: sock }).catch(() => {});
  }
}

// The clean prd.json written into the repo (drops orchestrator runtime fields).
export const prdFileShape = (run) => ({
  project: run.project, idea: run.idea, master: run.master, workers: run.workers,
  description: run.description || '', outputFormat: run.outputFormat || 'auto',
  stories: run.stories.map((s) => ({
    id: s.id, title: s.title, description: s.description || '',
    acceptanceCriteria: s.acceptanceCriteria || [], assignee: s.assignee,
    skills: s.skills || [], tools: s.tools || [], outputType: s.outputType || 'auto',
    priority: s.priority, deps: s.deps || [], branch: s.branch,
    status: s.status, passes: s.status === 'merged',
  })),
});

// When a story has exhausted its attempts with one agent, hand it to the best
// UNTRIED agent in the roster (by observed reliability) instead of failing the
// whole run. Bounded by roster size (each agent is tried at most once). Resets the
// story to `todo` so the tick respawns it fresh off main. Returns true if rerouted.
async function autoReroute(run, story, why) {
  const from = story.assignee;
  story.triedAgents = [...new Set([...(story.triedAgents || []), from])];
  const roster = [run.master, ...(run.workers || [])].filter((a, i, arr) => VALID_AGENTS.includes(a) && arr.indexOf(a) === i);
  const rel = (await loadPrefs(run.tenant || null).catch(() => null))?.prefs?.agentReliability || {};
  const needsTools = (story.tools || []).length > 0; // glm worker has no MCP wiring
  const next = roster
    .filter((a) => !story.triedAgents.includes(a))
    .filter((a) => !(needsTools && a === 'glm'))
    .sort((a, b) => (rel[b] ?? 0.5) - (rel[a] ?? 0.5))[0];
  if (!next) return false;
  await git(run.dir, ['branch', '-D', story.branch]).catch(() => {}); // new agent starts clean off main
  story.assignee = next;
  story.status = 'todo';
  story.iterations = 0;
  story.error = null;
  story.lastReject = null;
  story.authError = false; // fresh agent — don't carry the prior agent's auth verdict
  story.phaseSince = Date.now();
  story.rerouted = (story.rerouted || 0) + 1;
  recordPrefSignal({ type: 'reroute', from, to: next, why: String(why || '').slice(0, 120) }, run.tenant || null).catch(() => {});
  audit({ ralph: run.project, story: story.id, reroute: { from, to: next } });
  return true;
}

let ralphTicking = false;
export async function ralphTick() {
  if (ralphTicking) return;
  ralphTicking = true;
  try {
    for (const run of ralphRuns.values()) {
      let changed = false;
      const prevPhase = run.phase;

      if (run.phase === 'building') {
        // 1) Reap finished workers -> hand to the master for review (incl. stalls).
        for (const story of run.stories) {
          if (story.status !== 'building') continue;
          const exitFile = path.join(run.dir, '.ralph', `${story.id}.exit`);
          const code = await readExitCode(exitFile);
          if (code === null) {
            if (await agentStalled(run, story, story.session)) { // worker idle/hung, not just slow
              try { await tmux(['kill-session', '-t', story.session]); } catch { /* gone */ }
              await fs.rm(exitFile, { force: true }).catch(() => {});
              await gitRemoveWorktree(run.dir, story.id).catch(() => {});
              story.iterations = (story.iterations || 0) + 1;
              recordOutcome(run, story, 'stall');
              recordMasterLearning(run, `${story.id} worker (${story.assignee}) stalled on attempt ${story.iterations}`);
              recordRunEvent(run, `⏱ ${story.id} went quiet — restarting it`);
              if (story.iterations < (run.maxAttempts || 3)) {
                await git(run.dir, ['branch', '-D', story.branch]).catch(() => {});
                try { await spawnWorker(run, story, 'your previous attempt stalled with no result — start fresh on the current main'); }
                catch (e) { story.status = 'failed'; story.error = `respawn after stall: ${e.message}`; }
              } else if (!(await autoReroute(run, story, `stalled after ${story.iterations} attempts`))) {
                story.status = 'failed'; story.error = `worker stalled after ${story.iterations} attempts`;
              }
              changed = true;
            } else if (supervisable(story)) {
              // Alive and building: answer any raised design question, and past the
              // checkpoint interval let the supervisor look at its screen. Both are
              // fire-and-forget — the tick never waits on an LLM.
              if (!story.qaBusy) {
                story.qaBusy = true;
                answerWorkerQuestion(run, story).finally(() => { story.qaBusy = false; });
              }
              const since = story.lastCheckpoint || story.phaseSince || 0;
              if ((story.checkpoints || 0) < RALPH_CHECKPOINT_MAX && Date.now() - since > RALPH_CHECKPOINT_MS && !story.checkpointing) {
                story.checkpointing = true;
                checkpointStory(run, story).finally(() => { story.checkpointing = false; });
              }
            }
            // RC push: notify phone when a new unanswered question.md appears.
            if (story.status === 'building') {
              const ctl = path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph');
              const hasQ = await fs.access(path.join(ctl, 'question.md')).then(() => true).catch(() => false);
              const ans = await fs.access(path.join(ctl, 'answer.md')).then(() => true).catch(() => false);
              if (hasQ && !ans && run._rcQ !== story.id) { run._rcQ = story.id; sendPushRun(run, { title: `${run.project}: master needs you`, body: 'A question is waiting.' }).catch(() => {}); }
              if (ans || !hasQ) run._rcQ = run._rcQ === story.id ? null : run._rcQ;
              // Compose progress breadcrumb (social-video): surface the CLI's current
              // ffmpeg step in run events + the story row so a long render never looks hung.
              if (run.outputFormat === 'social-video') {
                try {
                  const pg = JSON.parse(await fs.readFile(path.join(ctl, 'compose-progress.json'), 'utf8'));
                  const tag = `${pg.step}/${pg.total}`;
                  if (pg.total && story.composeStep !== tag) {
                    story.composeStep = tag;
                    story.progress = `compose ${tag} · ${pg.kind}`;
                    recordRunEvent(run, `🎬 ${story.id} compose ${tag} (${pg.kind})`);
                    changed = true;
                  }
                } catch { if (story.progress) { story.progress = null; changed = true; } }
              }
            }
            continue;
          }
          // Capture the pane BEFORE killing the session. A worker that exits having committed
          // NOTHING and whose last output is a credential/auth error (401, not-logged-in, dead
          // key) didn't "build something the master rejected" — it never authenticated. Surface
          // that honestly and reroute/fail fast instead of sending an empty branch to review,
          // which returns a misleading "did not meet acceptance criteria" verdict and then burns
          // every retry on the same dead key (this is exactly what a dead Kimi key did).
          const pane = await paneTail(story.session, 40);
          try { await tmux(['kill-session', '-t', story.session]); } catch { /* gone */ }
          await fs.rm(exitFile, { force: true }).catch(() => {});
          let commits = 1;
          try { commits = Number((await git(run.dir, ['rev-list', '--count', `main..${story.branch}`])).stdout.trim()) || 0; } catch { commits = 1; }
          const af = commits === 0 ? detectAuthFailure(pane) : { auth: false };
          if (af.auth) {
            await gitRemoveWorktree(run.dir, story.id).catch(() => {});
            story.authError = true;
            recordMasterLearning(run, `${story.id}: ${story.assignee} AUTH failure (dead/expired key, not a code problem) — ${af.snippet}`);
            recordRunEvent(run, `🔑 ${story.id}: ${story.assignee} could not authenticate (invalid/expired key) — fix it in Settings → Providers (Test the key), then retry.`);
            const failedAgent = story.assignee;
            if (await autoReroute(run, story, `${failedAgent} auth failure: ${af.snippet}`)) {
              recordRunEvent(run, `↪ ${story.id} rerouted from ${failedAgent} to ${story.assignee} (auth failure)`);
            } else {
              story.status = 'failed';
              story.error = `${story.assignee} could not authenticate — check its API key in Settings → Providers (${af.snippet || 'auth/startup failure'})`;
            }
            changed = true;
            continue;
          }
          story.workerExit = code;
          story.status = 'review';
          story.phaseSince = story.lastActivity = Date.now();
          story.paneSig = '';
          await gitPushRef(run, story.branch); // publish the story branch live
          recordRunEvent(run, `🔍 master (${run.master}) reviewing ${story.id}`);
          try { await spawnReview(run, story); }
          catch (err) { story.status = 'failed'; story.error = `review spawn: ${err.message}`; }
          changed = true;
        }

        // 2) Reap reviews -> ACCEPT merges; REJECT retries (<max) or fails.
        for (const story of run.stories) {
          if (story.status !== 'review') continue;
          const verdictFile = path.join(run.dir, '.ralph', `${story.id}.verdict`);
          let verdict;
          try { verdict = (await fs.readFile(verdictFile, 'utf8')).trim(); }
          catch {
            if (await agentStalled(run, story, story.reviewSession)) { // review idle/hung, not just slow
              try { await tmux(['kill-session', '-t', story.reviewSession]); } catch { /* gone */ }
              await gitRemoveWorktree(run.dir, story.id).catch(() => {});
              story.iterations = (story.iterations || 0) + 1;
              recordOutcome(run, story, 'stall');
              if (story.iterations < (run.maxAttempts || 3)) {
                await git(run.dir, ['branch', '-D', story.branch]).catch(() => {});
                try { await spawnWorker(run, story, 'the review stalled — re-implement this story on the current main'); }
                catch (e) { story.status = 'failed'; story.error = `respawn after review stall: ${e.message}`; }
              } else if (!(await autoReroute(run, story, `review stalled after ${story.iterations} attempts`))) {
                story.status = 'failed'; story.error = `review stalled after ${story.iterations} attempts`;
              }
              changed = true;
            }
            continue;
          }
          try { await tmux(['kill-session', '-t', story.reviewSession]); } catch { /* gone */ }
          await fs.rm(verdictFile, { force: true }).catch(() => {});
          if (/^ACCEPT/i.test(verdict)) {
            let mergeErr = null;
            try {
              story.mergeSha = await gitMergeBranch(run.dir, story.branch, `integrate ${story.id}: ${story.title}`);
              story.status = 'merged';
              recordOutcome(run, story, 'accept');
              recordRunEvent(run, `✅ ${story.id} accepted & merged · "${story.title}" — preview updated`);
            } catch (err) { mergeErr = err; }
            await gitRemoveWorktree(run.dir, story.id);
            if (story.status === 'merged') {
              await gitPushRef(run, 'main'); // publish each merge
            } else {
              // Merge conflict: a sibling merged into main first and touched the same
              // files. Rebuild this story fresh on top of the CURRENT main (so it
              // includes the sibling's changes) and retry, up to maxAttempts.
              story.iterations = (story.iterations || 0) + 1;
              if (story.iterations < (run.maxAttempts || 3)) {
                await git(run.dir, ['branch', '-D', story.branch]).catch(() => {}); // drop stale branch
                try { await spawnWorker(run, story, 'your branch conflicted when merging — re-implement this story on top of the current main'); }
                catch (e) { story.status = 'failed'; story.error = `respawn after conflict: ${e.message}`; }
              } else {
                story.status = 'failed';
                story.error = `merge conflict after ${story.iterations} attempts: ${mergeErr?.message || 'conflict'}`;
              }
            }
          } else {
            const reason = sanitizeNote(verdict.replace(/^REJECT:?/i, '').trim());
            story.iterations = (story.iterations || 0) + 1;
            recordOutcome(run, story, 'reject');
            recordMasterLearning(run, `${story.id} rejected (attempt ${story.iterations}): ${reason.slice(0, 140)}`);
            recordRunEvent(run, `❌ master rejected ${story.id}: ${reason.slice(0, 110)}`);
            await gitRemoveWorktree(run.dir, story.id);
            if (story.iterations < (run.maxAttempts || 3)) {
              story.lastReject = reason;
              try { await spawnWorker(run, story, reason); } // status -> building
              catch (err) { story.status = 'failed'; story.error = `respawn: ${err.message}`; }
            } else if (!(await autoReroute(run, story, `rejected: ${reason}`))) {
              story.status = 'failed'; story.error = `rejected after ${story.iterations} attempts: ${reason}`;
            }
          }
          changed = true;
        }

        // 3) Spawn newly-unblocked stories (deps merged/skipped). A dep failure
        //    blocks dependents. PAUSED runs spawn nothing new (and don't finalize)
        //    — in-flight stories still get reaped/reviewed above, so pause drains
        //    gracefully rather than killing work mid-edit.
        if (!run.paused) {
        // Concurrency cap: flutter-app builds are RAM-heavy, so limit how many workers build at
        // once (a small box OOMs otherwise — the lesson from the first real run). Unbounded for
        // other formats. Remaining ready stories simply spawn on a later tick as slots free up.
        const parallelCap = isFlutterRun(run) ? FLUTTER_MAX_PARALLEL : Infinity;
        let buildingNow = run.stories.filter((s) => s.status === 'building').length;
        for (const story of run.stories) {
          if (story.status !== 'todo') continue;
          if ((story.deps || []).some((d) => ['failed', 'blocked'].includes(storyById(run, d)?.status))) {
            story.status = 'blocked'; story.error = 'a dependency failed'; changed = true; continue;
          }
          if (!depsSatisfied(run, story)) continue;
          if (story.startAt && story.startAt > Date.now()) continue; // ⏰ scheduled — not due yet
          if (buildingNow >= parallelCap) break; // hold remaining ready stories for a later tick
          if (story.startAt) { // due now — announce the timer fired, then clear it
            story.startAt = null;
            recordRunEvent(run, `⏰ ${story.id} started on schedule`);
            sendPush({ title: `⏰ ${run.project}: story ${story.id} started`, body: 'Your scheduled rebuild is running.', tag: `ralph-${run.project}`, url: '/' }).catch(() => {});
            sendPushRun(run, { title: `${run.project}: story ${story.id} started ⏰`, body: 'Your scheduled rebuild is running.' }).catch(() => {});
          }
          try { await spawnWorker(run, story); buildingNow++; changed = true; }
          catch (err) { story.status = 'failed'; story.error = `spawn: ${err.message}`; changed = true; }
        }

        // 4) Transition once nothing is active. A real failure (failed/blocked)
        //    fails the run; otherwise every story is resolved (merged, skipped
        //    and/or reverted) and the master finalizes. `reverted`/`skipped` are
        //    resolved states, not failures, so they must not block finalize.
        const active = run.stories.some((s) => ['building', 'review', 'todo'].includes(s.status));
        if (!active) {
          if (run.stories.some((s) => ['failed', 'blocked'].includes(s.status))) {
            run.phase = 'failed';
          } else {
            run.phase = 'finalizing';
            recordRunEvent(run, `🏁 all stories resolved — master (${run.master}) running the final integration pass`);
            try { await spawnFinalize(run); }
            catch (err) { run.phase = 'failed'; run.error = `finalize spawn: ${err.message}`; }
          }
          changed = true;
        }
        }

        // RC push: notify phone once when a run enters the attention state.
        if (run.attention && !run._rcAttn) { run._rcAttn = true; sendPushRun(run, { title: `${run.project}: needs attention`, body: run.attention.message?.slice(0, 120) || 'A run hit a problem.' }).catch(() => {}); }
        if (!run.attention) run._rcAttn = false;

      } else if (run.phase === 'finalizing') {
        // 5) Master finalize result -> on PASS, auto-push to GitHub.
        const resultFile = path.join(run.dir, '.ralph', 'finalize.result');
        let result = null;
        try { result = (await fs.readFile(resultFile, 'utf8')).trim(); } catch { /* pending */ }
        if (result !== null) {
          try { await tmux(['kill-session', '-t', run.finalizeSession]); } catch { /* gone */ }
          await fs.rm(resultFile, { force: true }).catch(() => {});
          if (/^PASS/i.test(result)) {
            await ensureReadme(run).catch(() => {}); // guarantee docs, then push
            // main was pushed after each merge; this catches README + finalize commits.
            if (await gitPushRef(run, 'main')) {
              // Every web-app build is a PWA by default — record its installability
              // (advisory; never blocks). This also seeds the later Store PWA path.
              await checkPwaCompliance(run).catch(() => {});
              await checkMediaOutputs(run).catch(() => {});
              // flutter-app: don't finish yet — build the installable APK + Drive link
              // in a separate (non-blocking) delivery pass the tick reaps below.
              // The web preview is already live (finalize built build/web). The installable
              // APK + Drive link is now an ON-DEMAND step (POST /api/ralph/apk) so the build
              // finishes fast and the heavy capped Gradle/APK build only runs when the user
              // asks for it (and before "Submit to Play").
              // social-video: don't finish yet either — verified renders auto-upload to Drive
              // in a separate (non-blocking) delivery pass the tick reaps below (media-delivering).
              // No verified renders (e.g. a stub build) -> finish immediately as before.
              const hasRenders = run.outputFormat === 'social-video'
                && Array.isArray(run.mediaReport?.outputs) && run.mediaReport.outputs.length > 0;
              if (hasRenders) {
                await spawnMediaDelivery(run).catch(() => {
                  run.phase = 'done';
                  recordRunEvent(run, `🎉 build finished — live at ${previewUrlFor(run)}`);
                });
              } else {
                run.phase = 'done';
                recordRunEvent(run, `🎉 build finished — live at ${previewUrlFor(run)}${isFlutterRun(run) ? ' · tap “Create APK” for an installable build + QR' : ''}`);
              }
            }
            else { run.phase = 'push_failed'; run.error = run.pushWarning || 'push failed'; recordRunEvent(run, '⚠️ built, but the GitHub push failed'); }
          } else { run.phase = 'failed'; run.error = 'finalize did not pass'; recordRunEvent(run, '❌ the final integration check did not pass'); }
          changed = true;
        }
      } else if (run.phase === 'delivering') {
        // 5b) flutter-app delivery: reap the APK->Drive result, record the link, finish.
        //     A failure here doesn't fail the build — the web preview is already live.
        const out = path.join(run.dir, '.ralph', 'deliver.json');
        let raw = null;
        try { raw = await fs.readFile(out, 'utf8'); } catch { /* pending */ }
        const stalled = Date.now() - (run.deliverSince || 0) > FLUTTER_DELIVER_STALL_MS;
        if (raw !== null || stalled) {
          try { await tmux(['kill-session', '-t', run.deliverSession]); } catch { /* gone */ }
          await fs.rm(out, { force: true }).catch(() => {});
          const info = parseDeliverResult(raw);
          const url = previewUrlFor(run);
          if (info && info.shareLink) {
            run.apk = { shareLink: info.shareLink, qr: info.qr || null, at: Date.now() };
            await writeDeliverable(run, info).catch(() => {});
            await gitPushRef(run, 'main').catch(() => {});
            recordRunEvent(run, `🎉 build finished — live at ${url} · 📲 install: ${info.shareLink}`);
          } else {
            run.deliverWarning = (info && info.error) || (stalled ? 'delivery timed out' : 'delivery failed');
            recordRunEvent(run, `🎉 build finished — live at ${url} (⚠️ APK link unavailable: ${run.deliverWarning})`);
          }
          run.phase = 'done';
          changed = true;
        }
      } else if (run.phase === 'media-delivering') {
        // 5c) social-video delivery: reap the Drive-upload result, swap local media for
        //     Drive links (delete-after-upload), finish. A failure here doesn't fail the
        //     build — local files are kept and the preview is still live.
        const out = path.join(run.dir, '.ralph', 'media-deliver.json');
        let raw = null;
        try { raw = await fs.readFile(out, 'utf8'); } catch { /* pending */ }
        const stalled = Date.now() - (run.mediaDeliverSince || 0) > MEDIA_DELIVER_STALL_MS;
        if (raw !== null || stalled) {
          try { await tmux(['kill-session', '-t', run.mediaDeliverSession]); } catch { /* gone */ }
          await fs.rm(out, { force: true }).catch(() => {});
          const info = parseMediaDeliverResult(raw);
          if (info && Array.isArray(info.files) && info.files.length) {
            run.mediaShare = { files: info.files, at: Date.now() };
            const md = mediaDeliverableMarkdown({ project: run.project, previewUrl: previewUrlFor(run), files: info.files });
            await fs.writeFile(path.join(run.dir, 'DELIVERABLE.md'), md).catch(() => {});
            await fs.writeFile(path.join(run.dir, 'index.html'),
              galleryDriveHtml(info.files, { title: run.project, color: '#3b82f6' })).catch(() => {});
            // no-local-copies: Drive is now the copy of record — never leave finished
            // renders sitting on this box once they're safely uploaded.
            for (const d of ['output', 'scenes', 'audio']) {
              await fs.rm(path.join(run.dir, d), { recursive: true, force: true }).catch(() => {});
            }
            await gitCommitAll(run.dir, 'docs: record Drive links; remove local media (Drive is the copy of record)').catch(() => {});
            await gitPushRef(run, 'main').catch(() => {});
            recordRunEvent(run, `🎉 build finished — ${info.files.length} render(s) on Drive · ${info.files[0].shareLink}`);
          } else {
            run.mediaShare = { error: (info && info.error) || (stalled ? 'Drive upload timed out' : 'Drive upload failed'), at: Date.now() };
            recordRunEvent(run, `⚠️ Drive upload: ${run.mediaShare.error} — local files kept, preview still live`);
          }
          run.phase = 'done';
          changed = true;
        }
      } else if (run.phase === 'windows-delivering') {
        // 5d) Windows installer delivery: reap the off-box Actions build -> Drive link, record it.
        //     A failure here does NOT fail the build (the scaffold + web preview already exist).
        const out = path.join(run.dir, '.ralph', 'windows-deliver.json');
        let raw = null;
        try { raw = await fs.readFile(out, 'utf8'); } catch { /* pending */ }
        const stalled = Date.now() - (run.windowsDeliverSince || 0) > WINDOWS_DELIVER_STALL_MS;
        if (raw !== null || stalled) {
          try { await tmux(['kill-session', '-t', run.windowsDeliverSession]); } catch { /* gone */ }
          await fs.rm(out, { force: true }).catch(() => {});
          const info = parseWindowsDeliverResult(raw);
          const url = previewUrlFor(run);
          const kind = run.windowsDeliverKind === 'store' ? 'store' : 'installer';
          const label = kind === 'store' ? 'Store package' : 'installer';
          run.windows = run.windows || {}; run.windows[kind] = run.windows[kind] || {};
          if (info && info.shareLink) {
            Object.assign(run.windows[kind], { shareLink: info.shareLink, qr: info.qr || null, deliveredAt: Date.now() });
            const inst = run.windows.installer || {};
            const md = windowsDeliverableMarkdown({
              project: run.project, previewUrl: url, shareLink: inst.shareLink, qr: inst.qr,
              appId: inst.appId, version: inst.version || run.windows.store?.version, kind: 'exe',
              store: run.windows.store?.shareLink ? run.windows.store : null,
            });
            await fs.writeFile(path.join(run.dir, 'DELIVERABLE.md'), md).catch(() => {});
            await gitCommitAll(run.dir, `docs: record Windows ${label} link in DELIVERABLE.md`).catch(() => {});
            await gitPushRef(run, 'main').catch(() => {});
            recordRunEvent(run, kind === 'store'
              ? `🏪 Microsoft Store package ready — 💾 download: ${info.shareLink} (upload it in Partner Center — see ${STORE_DOC})`
              : `🪟 Windows installer ready — 💾 download: ${info.shareLink}`);
          } else {
            run.windows[kind].deliverWarning = (info && info.error) || (stalled ? 'delivery timed out' : 'delivery failed');
            recordRunEvent(run, `⚠️ Windows ${label} delivery: ${run.windows[kind].deliverWarning} (the "${kind === 'store' ? 'Windows Store Package' : 'Windows Package'}" Action can still be run/downloaded manually)`);
          }
          run.phase = 'done';
          changed = true;
        }
      } else if (run.phase === 'researching') {
        // Brownfield: reap the research pass -> commit RESEARCH.md -> await instructions.
        const resultFile = path.join(run.dir, '.ralph', 'research.done');
        let result = null;
        try { result = (await fs.readFile(resultFile, 'utf8')).trim(); } catch { /* pending */ }
        const stalled = !run.researchSession || (Date.now() - (run.researchSince || 0) > RALPH_STALL_MS);
        if (result !== null || stalled) {
          try { await tmux(['kill-session', '-t', run.researchSession]); } catch { /* gone */ }
          await fs.rm(resultFile, { force: true }).catch(() => {});
          const hasFile = await fs.access(path.join(run.dir, 'RESEARCH.md')).then(() => true).catch(() => false);
          if (!hasFile) {
            await fs.writeFile(path.join(run.dir, 'RESEARCH.md'),
              '# RESEARCH.md\n\nResearch did not complete — proceeding without a code summary.\n').catch(() => {});
            run.attention = { message: 'Research pass did not finish; instruct anyway or re-adopt.' };
          }
          await gitCommitAll(run.dir, 'research: add RESEARCH.md').catch(() => {});
          run.phase = 'awaiting';
          run.researchSession = null;
          recordRunEvent(run, hasFile ? '🔎 research complete — review RESEARCH.md and give instructions'
            : '⚠️ research incomplete — give instructions to proceed');
          changed = true;
        }
      } else {
        continue; // awaiting / done / failed / push_failed: nothing for the tick to do
      }

      if (changed) await persistRun(run);
      // Web Push once, when the build reaches a terminal phase this tick.
      if (['done', 'failed', 'push_failed'].includes(run.phase) && run.phase !== prevPhase) {
        notifyRalphDone(run);
        if (run.tenant) {
          try {
            saasStore.recordUsage({
              workspaceId: run.tenant.id, type: 'run_finished', project: run.project,
              meta: { phase: run.phase, merged: run.stories.filter((s) => s.status === 'merged').length, total: run.stories.length, durationMs: Date.now() - (run.startedAt || Date.now()) },
            });
          } catch { /* best-effort */ }
        }
        // A finished run is a good, bounded moment to refresh the learned profile.
        if (run.phase === 'done') refreshProfileNote(run.tenant || null).catch(() => {});
      }
    }
  } finally { ralphTicking = false; }
}

// Notify subscribers that a build finished (no-op if nobody is subscribed).
function notifyRalphDone(run) {
  const body = run.phase === 'done'
    ? (run.apk?.shareLink ? `✅ Build complete — install the APK: ${run.apk.shareLink}` : '✅ Build complete — pushed to GitHub')
    : run.phase === 'push_failed' ? '⚠️ Built, but the GitHub push failed'
    : '❌ Build failed';
  sendPush({ title: `Ralph: ${run.project}`, body, tag: `ralph-${run.project}`, url: '/' }).catch(() => {});
  sendPushRun(run, { title: `${run.project}: build done ✅`, body: 'Your project finished.' }).catch(() => {});
}

// Create a fresh project repo, plan it, and kick off the build.
// Copy a token's staged brand assets into <repo>/assets/brand/, write MANIFEST.md,
// commit, and delete the staging dir. No-op if the token is missing/empty/expired.
// fs writes are app-side; the commit is tenant-wrapped by gitCommitAll under MT.
async function commitStagedAssets(dir, assetToken, tenant) {
  const staged = await loadStagedAssets(assetToken, tenant);
  if (!staged || !staged.meta.files.length) return;
  const brandDir = path.join(dir, 'assets', 'brand');
  await fs.mkdir(brandDir, { recursive: true });
  const lines = ['# Brand assets', '', 'User-provided assets committed for this build:', ''];
  for (const f of staged.meta.files) {
    await fs.copyFile(path.join(staged.dir, f.name), path.join(brandDir, f.name)).catch(() => {});
    lines.push(`- \`assets/brand/${f.name}\` — ${f.kind}${f.note ? `: ${f.note}` : ''}`);
  }
  await fs.writeFile(path.join(brandDir, 'MANIFEST.md'), lines.join('\n') + '\n');
  await gitCommitAll(dir, 'assets: add user-provided brand assets');
  await fs.rm(staged.dir, { recursive: true, force: true }).catch(() => {});
}

export async function startRalphRun({ project, idea, master, workers, maxAttempts = 3, workerPasses = 1, bypass = true, outputFormat, model = null, prd: prdInput, tenant = null, assetToken = null, media = null, platforms = null, mediaModels = null }) {
  // Multi-tenant: the project lives under the tenant's own home (/home/wt_x/projects)
  // so it inherits the kernel-level sandbox; the app reaches it via ACL. Single-tenant
  // keeps PROJECTS_ROOT. git/tmux auto-run as the tenant because the path/name encode it.
  const projectsRoot = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
  const dir = path.join(projectsRoot, project);
  if (path.dirname(dir) !== projectsRoot) throw new Error('Invalid project name.');
  if (await fs.stat(dir).then(() => true).catch(() => false)) {
    throw new Error('Project already exists — choose a new name for a Ralph build.');
  }
  await ensureProjectDir(dir, tenant); // tenant-owned root (see ensureProjectDir)
  await scaffoldContext(dir, project);
  await gitInitProject(dir);
  // Per-build media budget (defaults when absent). Re-clamped into the PRD here so
  // a client that edited the caps down after planning can't exceed the new budget.
  const runMedia = normalizeMedia(media);
  // A client-supplied prd (replay/test) skips the OpenAI planner.
  const prd = prdInput
    ? normalizePrd(prdInput, { idea, master, workers, outputFormat, mcpCaps: mcpCapabilitiesFor(tenant), media: runMedia })
    : await planPrd({ idea, master, workers, outputFormat, tenant, media: runMedia });
  prd.project = project;
  await fs.writeFile(path.join(dir, 'prd.json'), JSON.stringify(prd, null, 2));
  await fs.writeFile(path.join(dir, 'progress.txt'),
    `# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`);
  // social-video: renders ship to Google Drive at finish (delete-after-upload) — never
  // committed. Gated on the planner's resolved format (not the request param, which the
  // planner may override) and appended before the scaffold's first commit below.
  if (prd.outputFormat === 'social-video') {
    await fs.appendFile(path.join(dir, '.gitignore'),
      '\n# media binaries ship to Google Drive at finish — never committed\noutput/\nscenes/\naudio/\n').catch(() => {});
  }
  await gitCommitAll(dir, 'plan: add prd.json and progress log');
  await commitStagedAssets(dir, assetToken, tenant).catch(() => {}); // best-effort; never block the build
  const fmt = prd.outputFormat || 'auto';
  const run = {
    project, key: runKey(project, tenant), dir, idea, master, workers, maxAttempts, workerPasses, bypass,
    outputFormat: fmt,
    model: (model && validModelId(model)) ? model : null, // per-run model override (optional)
    media: runMedia, // per-build media caps/toggles (image/video/audio)
    platforms: fmt === 'social-video' ? normalizePlatforms(platforms) : null,
    mediaModels: normalizeMediaModels(mediaModels),
    // Phase C: per-build research/data budgets ($RALPH_GEN_RESEARCH / $RALPH_FETCH_DATA).
    // Key presence is the real opt-in — the helpers skip cleanly when no key is connected.
    research: normalizeResearchBudget(null),
    phase: 'building', startedAt: Date.now(),
    stories: prd.stories.map((s) => ({ ...s })),
    sessions: {},
    // In-memory tenant context (has wrap/session); persists as {id,slug,unix_user}
    // via toJSON and is rebuilt on load (see loadRun/initRalphRuns).
    tenant: tenant || undefined,
  };
  recordRunEvent(run, `📋 plan ready — ${run.stories.length} stor${run.stories.length === 1 ? 'y' : 'ies'}, master ${master}, workers ${[...new Set(run.stories.map((s) => s.assignee))].join('/')}`);
  // Usage metering (multi-tenant): one event per run start; the matching
  // run_finished lands when the run reaches a terminal phase in the tick.
  if (tenant) {
    try { saasStore.recordUsage({ workspaceId: tenant.id, type: 'run_started', project, meta: { master, stories: run.stories.length } }); } catch { /* best-effort */ }
  }
  // Create the GitHub repo up front and push the scaffold so the project fills in
  // live as Ralph builds. Best-effort: a remote failure is a warning, not a stop.
  try { await ensureRemote(run); await gitPushRef(run, 'main'); }
  catch (err) { run.pushWarning = err.message; }
  ralphRuns.set(run.key, run);
  await persistRun(run);
  ralphTick().catch(() => {}); // launch dependency-free stories immediately
  return run;
}

// Brownfield: copy an existing local dir into a project, then research it. No idea/prd yet
// (the user provides instructions after reading RESEARCH.md — see POST /api/ralph/instruct).
export async function adoptRalphRun({ project, source, master, workers, outputFormat, tenant = null }) {
  const projectsRoot = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
  const dir = path.join(projectsRoot, project);
  if (path.dirname(dir) !== projectsRoot) throw new Error('Invalid project name.');
  if (await fs.stat(dir).then(() => true).catch(() => false)) {
    throw new Error('Project already exists — choose a new name.');
  }
  let sourceKind = 'local', sshHost = null, sourceLabel = '';
  await ensureProjectDir(dir, tenant);
  try {
    if (source?.type === 'ssh') {
      if (tenant) throw new Error('SSH adopt is single-tenant only.');
      // Remote source over an allowlisted ~/.ssh/config Host alias. Runs as the app user
      // (its ssh config). Single-tenant intended.
      const hosts = await listSshHosts().catch(() => []);
      const v = validateSshTarget(source.host, hosts, source.path);
      if (v.error) throw new Error(v.error);
      sourceKind = 'ssh'; sshHost = v.host; sourceLabel = `${v.host}:${v.path}`;
      const sshOpt = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
      // Detect a remote git repo (read-only).
      const isRepo = await execFileAsync('ssh', [v.host, ...sshOpt, `test -d ${shRemoteQuote(v.path + '/.git')}`], { timeout: 20_000 })
        .then(() => true).catch(() => false);
      if (isRepo) {
        await execFileAsync('git', ['clone', '--', `${v.host}:${v.path}`, dir], {
          timeout: 600_000, env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
        });
      } else {
        // -s (--protect-args): the remote path is sent as-is, not re-split by the remote shell.
        await execFileAsync('rsync', ['-az', '-s', '--exclude=node_modules', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10',
          `${v.host}:${v.path}/`, dir + '/'], { timeout: 600_000 });
      }
    } else {
      // Local source (existing behavior).
      const rawPath = source?.path || '';
      let real;
      try { real = await fs.realpath(rawPath); } catch { throw new Error('Source path not found.'); }
      const st = await fs.stat(real).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error('Source path must be a directory.');
      const pv = validateSource(real, { projectsRoot, repoDir: REPO_ROOT, allowRoot: process.env.WEBTMUX_ADOPT_ROOT || '' });
      if (pv.error) throw new Error(pv.error);
      const maxMb = Number(process.env.WEBTMUX_ADOPT_MAX_MB || 500);
      try {
        const { stdout } = await execFileAsync('du', ['-sm', '--exclude=node_modules', '--exclude=.git', real], { timeout: 60_000 });
        if ((parseInt(stdout, 10) || 0) > maxMb) throw new Error(`Source exceeds ${maxMb} MB cap (WEBTMUX_ADOPT_MAX_MB).`);
      } catch (e) { if (/cap|MB/.test(e.message)) throw e; }
      sourceLabel = path.basename(real);
      const runAs = (argv) => (tenant ? tenant.wrap(argv) : argv);
      if (await isGitRepo(real)) {
        const argv = runAs(['git', 'clone', '--no-local', real, dir]);
        await execFileAsync(argv[0], argv.slice(1), { timeout: 300_000 });
      } else {
        const cp = runAs(['cp', '-a', real + '/.', dir]);
        await execFileAsync(cp[0], cp.slice(1), { timeout: 300_000 });
        const rm = runAs(['rm', '-rf', path.join(dir, 'node_modules')]);
        await execFileAsync(rm[0], rm.slice(1), { timeout: 60_000 });
      }
    }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to fetch the source into the project: ${e.message}`);
  }
  await scaffoldContext(dir, project);
  await gitInitProject(dir);
  await gitCommitAll(dir, 'chore: adopt existing project').catch(() => {});

  const run = {
    project, key: runKey(project, tenant), dir, mode: 'brownfield',
    idea: '', master, workers, outputFormat: outputFormat || 'auto',
    maxAttempts: 3, workerPasses: 1, bypass: true,
    phase: 'researching', startedAt: Date.now(), stories: [], sessions: {},
    sourceKind, sshHost, tenant: tenant || undefined,
  };
  recordRunEvent(run, `📥 adopted ${sourceLabel || project} → researching the codebase (master ${master})`);
  ralphRuns.set(run.key, run);
  await spawnResearch(run);
  await persistRun(run);
  return run;
}

// Load a staged-asset token's metadata, scoped to the caller's tenant. null if the
// token is missing/expired or belongs to a different tenant.
export async function loadStagedAssets(token, tenant) {
  const t = String(token || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
  if (!t) return null;
  const dir = path.join(STAGED_ASSETS_DIR, t);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (meta.tenant !== (tenant?.slug || null)) return null;
    return { dir, meta };
  } catch { return null; }
}


// Start a full Ralph build: fresh repo -> plan -> parallel workers -> merges.
// The whole start pipeline (validation → tenant plan gates → credential remapping →
// startRalphRun → learning signals), shared by POST /api/ralph/start and the draft
// start-timer (scheduled drafts fire with no HTTP request). Throws Error with .status
// for client-caused failures (the route maps it; the scheduler records it on the draft).
export async function startRunFromRequest(body, tenant) {
  const bad = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  let project = slugify(body?.project || ''); // DNS-safe so the preview link works
  const idea = (body?.idea || '').trim();
  // Smart auto-name: when no name is given, distill a short, meaningful slug from the idea
  // rather than slugifying the whole prompt — that produced 63-char names that overflowed the
  // DNS 63-char label limit once "--<tenant>" was appended, making the preview unreachable.
  if (!project && idea) project = smartName(idea);
  let master = (body?.master || '').trim();
  let workers = Array.isArray(body?.workers) ? body.workers.map((w) => String(w).trim()) : [];
  // Two independent caps so they don't compound: how many times the master will
  // retry a story, and how many self-retry passes the worker makes per spawn.
  const maxAttempts = clampInt(body?.maxAttempts, 1, 10, 3);
  const workerPasses = clampInt(body?.workerPasses, 1, 5, 1);
  const bypass = body?.bypass !== false; // default on; agents need it for autonomy
  const outputFormat = (body?.outputFormat || '').trim();
  // Optional per-run model override (e.g. any openrouter.ai/models id). Blank = use
  // the connected default. Spliced into a shell command, so restrict to the safe
  // model-id charset before it goes anywhere near the spawn.
  const model = (body?.model || '').trim();
  const assetToken = (body?.assetToken || '').toString();
  // Per-build media caps/toggles (image/video/audio). Falls back to the deploy defaults,
  // format-aware (social-video needs video+audio on) ONLY when the client sent no explicit media.
  const media = body?.media ? normalizeMedia(body.media)
    : withFormatMediaDefaults(mediaCapsEffective(), outputFormat);
  const platforms = Array.isArray(body?.platforms) ? body.platforms : null;
  const mediaModels = normalizeMediaModels(body?.mediaModels);
  // Structured clarify picks (header/q/answer) — recorded as a learning signal so
  // future scoping questions can pre-pick the recommended option (suggest-only).
  const clarify = Array.isArray(body?.clarify)
    ? body.clarify.slice(0, 8).map((c) => ({
        header: String(c?.header || '').slice(0, 40),
        q: String(c?.q || '').slice(0, 200),
        a: String(c?.a || '').slice(0, 200),
      })).filter((c) => c.a)
    : [];
  if (!validProject(project)) bad(400, 'Invalid project name. Letters, numbers, . _ - (max 64).');
  if (!idea) bad(400, 'Describe the idea/project.');
  if (!VALID_AGENTS.includes(master)) bad(400, 'Invalid master agent.');
  if (master === 'glm') bad(400, 'glm cannot be the master — it is unreliable for agentic review. Use claude, codex, or gemini.');
  if (model && !validModelId(model)) bad(400, 'Invalid model id (letters, digits and . _ : / - only).');
  const unknown = workers.filter((w) => !VALID_AGENTS.includes(w));
  if (unknown.length) bad(400, `Unknown worker(s): ${unknown.join(', ')}`);
  // Cap so the preview host <project>--<tenant>.<domain> always fits one 63-char DNS label.
  if (project) project = previewSafeProject(project, tenant?.slug || '', (x) => crypto.createHash('sha1').update(x).digest('hex'));
  if (ralphRuns.has(runKey(project, tenant))) bad(409, 'A run for that project is already active.');
  // Plan limits (multi-tenant): cap concurrent runs + total projects per the tenant's
  // subscription. 402 = needs an upgrade. Inert single-tenant.
  if (tenant) {
    const active = [...ralphRuns.values()].filter((r) => r.tenant?.slug === tenant.slug && (r.phase === 'building' || r.phase === 'finalizing')).length;
    const projects = (await listRuns(tenant)).length;
    const gate = saasPlans.canStartRun(tenant.id, active, projects);
    if (!gate.ok) bad(402, gate.reason);
    // One own key is enough to build: tenants are strictly BYO-key, but the UI
    // defaults to claude, so a learner who configured only (say) codex would hit
    // "No credential for claude". If the chosen agent has no credential but the
    // tenant DOES have one for another agent, route the unsatisfiable agent(s) to
    // an agent they can actually run (master-preference order; glm can't be master).
    // Only a tenant with NO usable credential at all still fails preflight.
    {
      const MASTER_PREF = ['claude', 'codex', 'qwen', 'gemini'];
      const unrunnable = new Set(await missingAgentCreds(tenant, MASTER_PREF));
      const sub = MASTER_PREF.find((a) => !unrunnable.has(a)); // their preferred runnable agent
      if (sub) {
        if (unrunnable.has(master)) master = sub;
        workers = [...new Set(workers.map((w) => (unrunnable.has(w) && w !== 'glm' ? sub : w)))];
      }
    }
    const missing = await missingAgentCreds(tenant, [master, ...workers]);
    if (missing.length) bad(400, missingKeysError(missing));
  }
  const prd = body?.prd && typeof body.prd === 'object' ? body.prd : null;
  const run = await startRalphRun({ project, idea, master, workers, maxAttempts, workerPasses, bypass, outputFormat, model, prd, tenant, assetToken, media, platforms, mediaModels });
  // Learn from the user's final choices (suggest-only; never blocks the start).
  recordPrefSignal({
    type: 'start', master: run.master, workers: run.workers, outputFormat: run.outputFormat,
    storyOutputs: run.stories.map((s) => s.outputType),
    storyAgents: run.stories.map((s) => s.assignee),
  }, tenant).catch(() => {});
  // Design-level choices feed the profile note (refreshed on run completion), so
  // future scoping questions can pre-pick what this user usually goes with.
  if (clarify.length) recordPrefSignal({ type: 'clarify', items: clarify }, tenant).catch(() => {});
  // What the user CHANGED between the planner's proposal and the plan they
  // approved is a direct statement of taste — capture the diff as a signal.
  recordPrdEditSignal(tenant, prd).catch(() => {});
  return run;
}

// Every build (persisted + in-memory), newest first — backs the Builds gallery.
// Scoped to the tenant (multi-tenant) so a tenant only ever sees their own runs.
export async function listRuns(tenant = null) {
  const byKey = new Map();
  const mine = (run) => (tenant ? run.tenant?.slug === tenant.slug : !run.tenant);
  try {
    for (const f of await fs.readdir(RALPH_STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const run = await readJson(path.join(RALPH_STATE_DIR, f), null);
      if (run?.project && mine(run)) byKey.set(run.key || run.project, run);
    }
  } catch { /* no runs yet */ }
  for (const run of ralphRuns.values()) if (mine(run)) byKey.set(run.key || run.project, run); // in-memory is freshest
  return [...byKey.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).map(runSummary);
}
