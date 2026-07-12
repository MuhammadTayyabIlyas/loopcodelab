// server/routes/ralph.mjs — the Ralph orchestrator's HTTP surface: plan/
// clarify/start/adopt/revise, run status + supervision actions, windows/apk/
// store deliveries, doctor, prefs/drafts/tracking, and project deletion.
// Registration order matters within this file: the fixed-path routes (prefs,
// solo-models, media-caps, drafts, tracking) come before /api/ralph/:project.
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import express from 'express';
import * as saasStore from '../../saas/store.mjs';
import { SOLO_AGENTS, SOLO_MODEL_DEFAULTS } from '../../ralph/solo-models.mjs';
import { DENY_DIRS, validateSshTarget, shRemoteQuote, parseSshLs } from '../../ralph/adopt-paths.mjs';
import { validateAsset, sanitizeAssetName, assetKind, stagedAssetManifest, MAX_ASSETS } from '../../ralph/assets.mjs';
import { isFlutterRun } from '../../ralph/flutter-env.mjs';
import {
  playWorkflowYaml, codemagicYaml, playChecklistMd, iosChecklistMd, normalizeTrack,
  validBundleId, defaultBundleId, PLAY_WORKFLOW_PATH, IOS_WORKFLOW_PATH, submissionDoc, STORES,
} from '../../ralph/store-submit.mjs';
import { mediaCapDefaults, normalizeMedia } from '../../ralph/providers.mjs';
import {
  defaultWindowsAppId, sanitizeProductName, validateWindowsInput,
} from '../../ralph/windows-scaffold.mjs';
import { STORE_DOC, STORE_PACKAGINGS, validateStoreInput, storeSubmissionMd } from '../../ralph/windows-store.mjs';
import { normalizeDraft, draftListItem, scheduleAt } from '../../ralph/drafts.mjs';
import { normalizeTrackingEntry, validTrackingProvider } from '../../ralph/sub-tracking.mjs';
import { smartName, previewSafeProject } from '../../ralph/smart-name.mjs';
import { parseRepoSlug, playSecrets } from '../../ralph/github-secrets.mjs';
import { REVISE_PLANNER_RULES, clampReviseMedia } from '../../ralph/revise-scope.mjs';
import { editKind, clampStoryStart, normalizeNewStory } from '../../ralph/story-ops.mjs';
import {
  DATA_DIR, PROJECTS_ROOT, STAGED_ASSETS_DIR, audit, execFileAsync, validProject,
} from '../config.mjs';
import { githubToken, googlePlayKey, openaiKey, mediaCapsEffective, savedSoloModels, soloModelsEffective } from '../secrets.mjs';
import { tmux } from '../tmux.mjs';
import { git, gitCommitAll, gitRemoveWorktree, gitRevertMerge } from '../git.mjs';
import { listSshHosts } from '../projects.mjs';
import { OUTPUT_FORMATS, mcpCapabilitiesFor, loadSkillsCatalog } from '../skills.mjs';
import { VALID_AGENTS, missingAgentCreds, missingKeysError, tenantKey } from '../agents.mjs';
import { callOpenAI, callPlanner, extractJson } from '../llm.mjs';
import { planPrd, clarifyQuestions, groundIdea } from '../planner.mjs';
import { shouldGround } from '../../ralph/research.mjs';
import {
  FORMAT_FAMILIES, familyOf, clampHistory, analyzePrompt,
  normalizeAnalysis, fallbackAnalysis, stubAnalysis,
} from '../../ralph/analyze.mjs';
import {
  loadPrefs, savePrefs, loadDraftsList, saveDraftFor, deleteDraftFor, loadTracking,
  saveTracking, recordPrefSignal, stashPlannedPrd,
} from '../prefs.mjs';
import {
  RALPH_STATE_DIR, ralphRuns, runKey, slugify, prdFileShape, storyById, tenantOf,
  previewUrlFor, ralphSessionName, runSummary, persistRun, regenerateProjectIndex,
  masterLogText, recordMasterLearning, recordRunEvent, ensureRemote, gitPushRef, gitPushExisting,
  loadRun, listRuns, killProjectSessions, ralphTick, spawnWorker, spawnDelivery,
  spawnWindowsDelivery, prepareWindowsInstaller, prepareWindowsStore, loadStagedAssets,
  adoptRalphRun, startRunFromRequest,
} from '../ralph-engine.mjs';
import { dropAppProcess } from '../preview.mjs';

// Core swap logic extracted so both the dashboard route and /rc/api/swap can call it.
// Takes an already-resolved run. Throws on validation / conflict errors.
export async function ralphSwap(run, role, agent) {
  // The agent being replaced is a negative reliability signal for the prefs store.
  const fromAgent = role === 'master' ? run.master : (storyById(run, role)?.assignee || null);
  if (role === 'master') {
    if (agent === 'glm') throw Object.assign(new Error('glm cannot be the master — use claude, codex, or gemini.'), { status: 400 });
    // Master review affects every story, so only switch it when nothing's mid-flight.
    if (run.phase === 'building' || run.phase === 'finalizing') throw Object.assign(new Error('Wait for the build to settle before switching master.'), { status: 409 });
    run.master = agent;
    for (const s of run.stories) { // retry failed stories with the new master reviewing
      if (s.status === 'failed' || s.status === 'blocked') {
        await git(run.dir, ['branch', '-D', s.branch]).catch(() => {});
        s.status = 'todo'; s.iterations = 0; s.error = null; s.phaseSince = Date.now();
      }
    }
  } else {
    // Reassign ONE story to a new agent — allowed even mid-build (yank a flaky agent).
    const st = storyById(run, role);
    if (!st) throw Object.assign(new Error('Unknown story.'), { status: 404 });
    for (const kind of ['r', 'rv']) { try { await tmux(['kill-session', '-t', ralphSessionName(run.project, st.id, kind, run.tenant)]); } catch { /* gone */ } }
    await gitRemoveWorktree(run.dir, st.id).catch(() => {});
    await git(run.dir, ['branch', '-D', st.branch]).catch(() => {});
    st.assignee = agent; st.status = 'todo'; st.iterations = 0; st.error = null; st.phaseSince = Date.now();
  }
  if (run.phase !== 'building') run.phase = 'building';
  run.error = null;
  ralphRuns.set(run.key, run);
  await persistRun(run);
  ralphTick().catch(() => {});
  if (fromAgent && fromAgent !== agent) recordPrefSignal({ type: 'swap', from: fromAgent, to: agent, role }, run.tenant || null).catch(() => {});
}

export function registerRalphRoutes(app) {
  // --- Ralph orchestrator -----------------------------------------------------
  // Planner: turn an idea + agent roster into a prd.json (not yet written to disk;
  // the start flow will init the repo and commit it).
  // Stage one uploaded brand asset (octet-stream body, filename in ?name) under a token.
  // Repeated calls with the same ?token accumulate. Validated + sanitized here; the files
  // are committed into the repo at /start (commitStagedAssets). Best-effort, optional.
  app.post('/api/ralph/assets', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
    const tenant = tenantOf(req);
    const rawName = (req.query?.name || '').toString();
    const note = (req.query?.note || '').toString().slice(0, 120);
    let token = (req.query?.token || '').toString().replace(/[^a-f0-9]/g, '').slice(0, 32);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const v = validateAsset({ name: rawName, size: buf.length });
    if (!v.ok) return res.status(400).json({ error: v.reason });
    try {
      if (!token) token = crypto.randomBytes(16).toString('hex');
      const dir = path.join(STAGED_ASSETS_DIR, token);
      await fs.mkdir(dir, { recursive: true });
      const metaPath = path.join(dir, 'meta.json');
      let meta = { token, tenant: tenant?.slug || null, createdAt: Date.now(), files: [] };
      try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { /* new token */ }
      if (meta.tenant !== (tenant?.slug || null)) return res.status(403).json({ error: 'Token belongs to another account.' });
      if (meta.files.length >= MAX_ASSETS) return res.status(400).json({ error: `At most ${MAX_ASSETS} assets per build.` });
      let name = sanitizeAssetName(rawName);
      const taken = new Set(meta.files.map((f) => f.name));
      if (taken.has(name)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2; while (taken.has(`${stem}-${i}${ext}`)) i++;
        name = `${stem}-${i}${ext}`;
      }
      await fs.writeFile(path.join(dir, name), buf);
      meta.files.push({ name, kind: assetKind(name), size: buf.length, note });
      await fs.writeFile(metaPath, JSON.stringify(meta));
      res.json({ assetToken: token, assets: meta.files });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Clarifying questions for an idea (best-effort; [] if clear or on error).
  app.post('/api/ralph/clarify', async (req, res) => {
    const idea = (req.body?.idea || '').trim();
    const outputFormat = (req.body?.outputFormat || '').trim();
    if (!idea) return res.status(400).json({ error: 'Describe the idea/project.' });
    res.json({ questions: await clarifyQuestions(idea, outputFormat, tenantOf(req)) });
  });

  // Idea-first wizard: ONE combined inference call — deliverable format, short
  // name, media needs, platforms, clarify questions, refined brief. Optionally
  // grounded in live web research (same suggest-only Perplexity pipe as the
  // planner). Best-effort by construction: any failure returns the
  // deterministic fallback — inference can never block a build.
  app.post('/api/ralph/analyze', async (req, res) => {
    const idea = String(req.body?.idea || '').trim().slice(0, 4000);
    const formatFamily = familyOf(req.body?.formatFamily);
    if (!idea) return res.status(400).json({ error: 'idea is required' });
    if (process.env.RALPH_FORCE_TOOL) return res.json(stubAnalysis(idea, formatFamily));
    const tenant = tenantOf(req);
    try {
      const seed = FORMAT_FAMILIES[formatFamily].seed;
      const grounding = shouldGround(idea, seed) ? await groundIdea(idea, seed, tenant) : '';
      // Clamp `current` (the in-progress wizard state echoed back on refine) so a
      // large media/platforms/name blob can't blow up the prompt — refine still
      // works from history+idea alone when it's dropped.
      const rawCurrent = req.body?.current && typeof req.body.current === 'object' ? req.body.current : null;
      const current = rawCurrent && JSON.stringify(rawCurrent).length <= 2000 ? rawCurrent : null;
      const messages = analyzePrompt({
        idea,
        formatFamily,
        history: clampHistory(req.body?.history),
        current,
        grounding,
      });
      let timer;
      const raw = await Promise.race([
        callPlanner(messages, { json: true, tenant }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('analyze timeout')), 15_000); }),
      ]).finally(() => clearTimeout(timer));
      const parsed = extractJson(raw);
      res.json(parsed ? normalizeAnalysis(parsed, { idea, formatFamily }) : fallbackAnalysis(idea, formatFamily));
    } catch {
      res.json(fallbackAnalysis(idea, formatFamily));
    }
  });

  app.post('/api/ralph/plan', async (req, res) => {
    const idea = (req.body?.idea || '').trim();
    let projectName = slugify(req.body?.project || ''); // blank -> smart-named below
    const master = (req.body?.master || '').trim();
    const workers = Array.isArray(req.body?.workers) ? req.body.workers.map((w) => String(w).trim()) : [];
    const answers = typeof req.body?.answers === 'string' ? req.body.answers.slice(0, 4000) : '';
    const outputFormat = (req.body?.outputFormat || '').trim();
    const assetToken = (req.body?.assetToken || '').toString();
    // Per-build media budget the plan should be aware of; blank body -> deploy default.
    const media = normalizeMedia(req.body?.media || mediaCapsEffective());
    if (!idea) return res.status(400).json({ error: 'Describe the idea/project.' });
    if (!VALID_AGENTS.includes(master)) return res.status(400).json({ error: 'Invalid master agent.' });
    if (master === 'glm') return res.status(400).json({ error: 'glm cannot be the master — it is unreliable for agentic review. Use claude, codex, or gemini.' });
    const bad = workers.filter((w) => !VALID_AGENTS.includes(w));
    if (bad.length) return res.status(400).json({ error: `Unknown worker(s): ${bad.join(', ')}` });
    try {
      const tenant = tenantOf(req);
      let answersForPlan = answers;
      const staged = await loadStagedAssets(assetToken, tenant);
      if (staged && staged.meta.files.length) {
        answersForPlan = (answers ? answers + '\n\n' : '')
          + `User-provided brand assets (committed to the repo at assets/brand/): ${stagedAssetManifest(staged.meta.files)}. Use these brand assets in the build.`;
      }
      const prd = await planPrd({ idea, master, workers, answers: answersForPlan, outputFormat, tenant, media });
      // Smart-name when the user left the field blank, then cap to a DNS-safe preview label so
      // the confirm dialog shows the exact slug the build (and preview subdomain) will use.
      if (!projectName && idea) projectName = smartName(idea);
      prd.project = previewSafeProject(projectName, tenant?.slug || '', (x) => crypto.createHash('sha1').update(x).digest('hex'));
      stashPlannedPrd(tenant, prd); // diffed against the prd the user actually starts
      // Surface the catalog + tool list so the confirm dialog can render editable
      // skill/tool chips and the output-format select.
      const skillsCatalog = (await loadSkillsCatalog()).map((s) => ({ id: s.id, description: s.description }));
      res.json({ prd, skillsCatalog, mcpTools: mcpCapabilitiesFor(tenant), outputFormats: OUTPUT_FORMATS });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });


  app.post('/api/ralph/start', async (req, res) => {
    // Multi-tenant: build the run inside the authed tenant's sandbox (requireAuth, active
    // only when MULTITENANT, sets req.tenant). The run is keyed per-tenant so two tenants
    // can each hold a same-named project without colliding.
    try {
      const run = await startRunFromRequest(req.body || {}, tenantOf(req));
      res.status(201).json(runSummary(run));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  });

  app.post('/api/ralph/adopt', async (req, res) => {
    const project = slugify(req.body?.project || '');
    const master = (req.body?.master || '').trim();
    const workers = Array.isArray(req.body?.workers) ? req.body.workers.map((w) => String(w).trim()) : [];
    const outputFormat = (req.body?.outputFormat || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    if (!VALID_AGENTS.includes(master) || master === 'glm') return res.status(400).json({ error: 'Pick a valid master (claude, codex, qwen, gemini).' });
    const bad = workers.filter((w) => !VALID_AGENTS.includes(w));
    if (bad.length) return res.status(400).json({ error: `Unknown worker(s): ${bad.join(', ')}` });
    // Source: { type:'local', path } | { type:'ssh', host, path }. Back-compat: bare sourcePath = local.
    let source = req.body?.source;
    if (!source || typeof source !== 'object') {
      source = { type: 'local', path: String(req.body?.sourcePath || '').trim() };
    }
    if (source.type === 'ssh') {
      const host = String(source.host || '').trim();
      const rpath = String(source.path || '').trim();
      if (!host || !rpath) return res.status(400).json({ error: 'Remote adopt needs an SSH host and path.' });
      if (!(await listSshHosts().catch(() => [])).includes(host)) return res.status(403).json({ error: 'Unknown SSH host (not in ~/.ssh/config).' });
      source = { type: 'ssh', host, path: rpath };
    } else {
      const p = String(source.path || '').trim();
      if (!p) return res.status(400).json({ error: 'Provide the source directory path.' });
      source = { type: 'local', path: p };
    }
    try {
      const run = await adoptRalphRun({ project, source, master, workers, outputFormat, tenant: tenantOf(req) });
      audit({ ralphAdopt: project, source: source.type === 'ssh' ? `${source.host}:${source.path}` : source.path });
      res.json({ ok: true, project: run.project, phase: run.phase });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/ralph/instruct', async (req, res) => {
    const project = slugify(req.body?.project || '');
    const idea = String(req.body?.idea || '').trim();
    if (!idea) return res.status(400).json({ error: 'Describe the change to make.' });
    const tenant = tenantOf(req);
    const run = await loadRun(project, tenant);
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.phase !== 'awaiting') return res.status(409).json({ error: `Run is "${run.phase}", not awaiting instructions.` });
    let research = '';
    try { research = await fs.readFile(path.join(run.dir, 'RESEARCH.md'), 'utf8'); } catch { /* none */ }
    try {
      const prd = await planPrd({ idea, master: run.master, workers: run.workers || [], outputFormat: run.outputFormat, tenant, research, media: run.media });
      prd.project = project;
      await fs.writeFile(path.join(run.dir, 'prd.json'), JSON.stringify(prd, null, 2));
      await fs.writeFile(path.join(run.dir, 'progress.txt'), `# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`).catch(() => {});
      await gitCommitAll(run.dir, 'plan: add prd.json from instructions').catch(() => {});
      run.idea = idea;
      run.outputFormat = prd.outputFormat || run.outputFormat || 'auto';
      run.stories = prd.stories.map((s) => ({ ...s }));
      run.phase = 'building';
      run.attention = null;
      recordRunEvent(run, `📋 plan ready — ${run.stories.length} stor${run.stories.length === 1 ? 'y' : 'ies'} on the adopted codebase`);
      try { await ensureRemote(run); await gitPushRef(run, 'main'); } catch (err) { run.pushWarning = err.message; }
      await persistRun(run);
      ralphTick().catch(() => {});
      res.json({ ok: true, stories: run.stories.length });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // The master's logbook for one build (status board + rulings + steering +
  // learnings) — what the supervisor reads; shown in the build UI.
  app.get('/api/ralph/masterlog', async (req, res) => {
    const project = (req.query?.project || '').trim();
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    res.json({ log: masterLogText(run) });
  });

  app.get('/api/ralph/research', async (req, res) => {
    const run = await loadRun(slugify(req.query.project || ''), tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    try {
      const content = await fs.readFile(path.join(run.dir, 'RESEARCH.md'), 'utf8');
      res.json({ project: run.project, phase: run.phase, research: content });
    } catch { res.json({ project: run.project, phase: run.phase, research: '' }); }
  });

  // Read-only directory-browse for the adopt picker dialog.
  // GET /api/ralph/fs-list?path=<abs path>
  // → { path, parent, dirs:[{name,path}] }  or  { error } with 400/403/500
  app.get('/api/ralph/fs-list', async (req, res) => {
    const adoptRoot = process.env.WEBTMUX_ADOPT_ROOT || '';
    const defaultPath = adoptRoot || process.env.HOME || '/home';
    const reqPath = (req.query.path || '').trim() || defaultPath;
    let real;
    try {
      real = await fs.realpath(reqPath);
    } catch {
      return res.status(400).json({ error: 'Path does not exist or cannot be resolved.' });
    }
    // Must be a directory.
    try {
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path is not a directory.' });
    } catch {
      return res.status(400).json({ error: 'Path does not exist.' });
    }
    // Policy: reject denied system trees.
    if (DENY_DIRS.some((d) => d === '/' ? real === '/' : (real === d || real.startsWith(d + path.sep)))) {
      return res.status(403).json({ error: 'Access to this directory is not permitted.' });
    }
    // Policy: if WEBTMUX_ADOPT_ROOT is set, path must be inside it.
    if (adoptRoot) {
      if (real !== adoptRoot && !real.startsWith(adoptRoot + path.sep)) {
        return res.status(403).json({ error: 'Path is outside the permitted root.' });
      }
    }
    // List immediate subdirectories, skip dotfiles and node_modules.
    let dirs;
    try {
      const entries = await fs.readdir(real, { withFileTypes: true });
      dirs = entries
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ name: d.name, path: path.join(real, d.name) }));
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read directory.' });
    }
    // Compute parent: null at the policy boundary.
    const boundary = adoptRoot || '/';
    const parent = real === boundary ? null : await fs.realpath(path.dirname(real)).catch(() => null);
    res.json({ path: real, parent, dirs });
  });

  // Remote directory browse over SSH (host = an allowlisted ~/.ssh/config alias). Read-only.
  app.get('/api/ralph/ssh-list', async (req, res) => {
    const host = String(req.query.host || '').trim();
    const reqPath = String(req.query.path || '').trim() || '.';
    const hosts = await listSshHosts().catch(() => []);
    const v = validateSshTarget(host, hosts, reqPath);
    if (v.error) return res.status(/Unknown SSH host/.test(v.error) ? 403 : 400).json({ error: v.error });
    // ssh joins the trailing args into one remote-shell command; single-quote the path.
    const remoteCmd = `cd ${shRemoteQuote(reqPath)} 2>/dev/null && pwd && ls -1Ap`;
    try {
      const { stdout } = await execFileAsync('ssh',
        [host, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remoteCmd], { timeout: 20_000 });
      const { path: canon, dirs } = parseSshLs(stdout);
      if (!canon) return res.status(400).json({ error: 'Remote path not found or not a directory.' });
      const base = canon.replace(/\/+$/, '');
      const parent = base === '' ? null : (base.split('/').slice(0, -1).join('/') || '/');
      res.json({
        host, path: canon, parent,
        dirs: dirs.map((name) => ({ name, path: (base === '' ? '' : base) + '/' + name })),
      });
    } catch (e) {
      console.warn(`[ssh-list] ${host}: ${e.message}`);
      res.status(502).json({ error: 'SSH failed — check ~/.ssh/config and the key for this host.' });
    }
  });

  // Status of one run (?project=) or all active runs.
  app.get('/api/ralph/status', async (req, res) => {
    const project = (req.query?.project || '').trim();
    const tenant = tenantOf(req);
    if (project) {
      const run = await loadRun(project, tenant); // reload from disk so a finished run survives a restart
      if (!run) return res.status(404).json({ error: 'No run for that project.' });
      return res.json(runSummary(run));
    }
    res.json({ runs: await listRuns(tenant) });
  });


  // Roll back a single merged story by reverting its merge commit, then re-push.
  app.post('/api/ralph/revert', async (req, res) => {
    const project = (req.body?.project || '').trim();
    const storyId = (req.body?.story || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.phase === 'building' || run.phase === 'finalizing') {
      return res.status(409).json({ error: 'Wait for the build to finish before reverting.' });
    }
    const story = storyById(run, storyId);
    if (!story) return res.status(404).json({ error: 'Unknown story.' });
    if (!story.mergeSha) return res.status(400).json({ error: 'That story is not merged; nothing to revert.' });
    try {
      await gitRevertMerge(run.dir, story.mergeSha);
      story.revertedFrom = story.mergeSha;
      story.status = 'reverted';
      delete story.mergeSha;
      let pushed = false;
      if (run.repo) { try { await gitPushExisting(run); pushed = true; } catch (err) { run.error = `revert push: ${err.message}`; } }
      await persistRun(run);
      audit({ ralph: project, revert: storyId, pushed });
      res.json({ ...runSummary(run), pushed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Revise a finished project: plan extra stories from a new instruction, append
  // them, and resume the build (commit the updated prd; auto-push on completion).
  app.post('/api/ralph/revise', async (req, res) => {
    const project = (req.body?.project || '').trim();
    const idea = (req.body?.idea || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    if (!idea) return res.status(400).json({ error: 'Describe the revision.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.phase === 'building' || run.phase === 'finalizing') {
      return res.status(409).json({ error: 'A build is already in progress.' });
    }
    try {
      // Give the revise planner sight of the EXISTING app (file tree + README/DELIVERABLE)
      // so targeted stories reference real files instead of guessing — planPrd's brownfield
      // research block ("modify, don't recreate") does the rest.
      const SKIP = new Set(['node_modules', '.git', '.ralph', '.worktrees', 'dist', 'build']);
      const tree = [];
      const walk = async (d, rel = '', depth = 0) => {
        if (depth > 3 || tree.length >= 150) return;
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
          if (tree.length >= 150) return;
          tree.push(rel + e.name + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory()) await walk(path.join(d, e.name), rel + e.name + '/', depth + 1);
        }
      };
      await walk(run.dir);
      const readme = await fs.readFile(path.join(run.dir, 'README.md'), 'utf8').catch(() => '');
      const deliver = await fs.readFile(path.join(run.dir, 'DELIVERABLE.md'), 'utf8').catch(() => '');
      const research = `This is a REVISION of the finished app below. Change ONLY what the instruction asks; keep everything else working.\n\n${REVISE_PLANNER_RULES}\n\nFile tree:\n${tree.join('\n')}\n\nREADME.md:\n${readme.slice(0, 2500)}\n\nDELIVERABLE.md:\n${deliver.slice(0, 1500)}`;
      const planned = await planPrd({ idea, master: run.master, workers: run.workers, outputFormat: run.outputFormat, tenant: run.tenant || null, media: run.media, research });
      // Renumber the new stories after the existing ones; remap their internal deps.
      const offset = run.stories.length;
      const idMap = {};
      planned.stories.forEach((s, i) => { idMap[s.id] = `s${offset + i + 1}`; });
      const added = planned.stories.map((s) => {
        const id = idMap[s.id];
        // revision: true => spawnReview switches the master to diff-focused review.
        return { ...s, id, branch: `prd/${id}`, deps: (s.deps || []).map((d) => idMap[d]).filter(Boolean), status: 'todo', iterations: 0, revision: true };
      });
      // Planner rules say "no unrequested media"; this enforces it deterministically.
      clampReviseMedia(added, idea);
      run.stories.push(...added);
      run.phase = 'building';
      run.error = null;
      // A revision says what the finished build got WRONG — the strongest taste
      // signal we get. Recorded for the post-run distillation pass.
      recordPrefSignal({ type: 'revise', project: run.project, idea: idea.slice(0, 240) }, run.tenant || null).catch(() => {});
      await fs.writeFile(path.join(run.dir, 'prd.json'), JSON.stringify(prdFileShape(run), null, 2));
      await gitCommitAll(run.dir, `plan: revise — add ${added.length} story(ies)`);
      await persistRun(run);
      ralphTick().catch(() => {});
      res.json(runSummary(run));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── Play release signing + GitHub Actions secret auto-wiring ───────────────
  const SIGNING_FILE = path.join(DATA_DIR, 'flutter-signing.json'); // single-tenant store
  async function loadSigning(run) {
    if (run.tenant) { try { return JSON.parse(tenantKey(run, 'flutter-signing') || 'null'); } catch { return null; } }
    try { return JSON.parse(await fs.readFile(SIGNING_FILE, 'utf8')); } catch { return null; }
  }
  async function saveSigning(run, obj) {
    const s = JSON.stringify(obj);
    if (run.tenant) { saasStore.setProviderKey(run.tenant.id, 'flutter-signing', s); return; }
    await fs.writeFile(SIGNING_FILE, s, { mode: 0o600 }).catch(() => {});
  }
  // Get-or-generate a STABLE per-tenant Android upload key (Play App Signing means Google holds
  // the real app signing key; this is just the upload key, reused across the tenant's apps).
  async function ensureUploadKeystore(run) {
    const existing = await loadSigning(run);
    if (existing?.keystoreBase64) return existing;
    const pw = crypto.randomBytes(18).toString('base64');
    const tmp = path.join(DATA_DIR, `.ks-${crypto.randomBytes(6).toString('hex')}.jks`);
    const dname = `CN=${String(run.project || 'app').replace(/[^A-Za-z0-9 ]/g, '') || 'app'}, OU=webtmux, O=webtmux, C=US`;
    await execFileAsync('keytool', ['-genkeypair', '-v', '-keystore', tmp, '-storetype', 'JKS',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-alias', 'upload',
      '-storepass', pw, '-keypass', pw, '-dname', dname], { timeout: 30_000 });
    const keystoreBase64 = (await fs.readFile(tmp)).toString('base64');
    await fs.rm(tmp, { force: true }).catch(() => {});
    const obj = { keystoreBase64, storePassword: pw, keyPassword: pw, keyAlias: 'upload' };
    await saveSigning(run, obj);
    return obj;
  }
  // Set one GitHub Actions secret/variable via `gh`, value piped over stdin (never in argv).
  function ghSet(kind, name, slug, token, value) {
    return new Promise((resolve) => {
      const p = spawn('gh', [kind, 'set', name, '--repo', slug], { env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' } });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      try { p.stdin.write(String(value)); p.stdin.end(); } catch { resolve(false); }
    });
  }
  // Best-effort: set the repo's Actions secrets + variables on the run's GitHub repo using the
  // tenant's github token. Returns { set:[], failed:[] } so the caller can report partial success.
  async function setGithubSecrets(run, { secrets = {}, variables = {} }) {
    const token = tenantKey(run, 'github') || githubToken();
    const slug = parseRepoSlug(run.repo);
    const all = [...Object.keys(secrets), ...Object.keys(variables)];
    if (!token || !slug) return { set: [], failed: all, reason: 'no github token or repo' };
    const set = [], failed = [];
    await Promise.all([
      ...Object.entries(secrets).map(async ([n, v]) => { ((await ghSet('secret', n, slug, token, v)) ? set : failed).push(n); }),
      ...Object.entries(variables).map(async ([n, v]) => { ((await ghSet('variable', n, slug, token, v)) ? set : failed).push(n); }),
    ]);
    return { set, failed };
  }

  // Submit a finished flutter-app to an app store — a SEPARATE, user-triggered step (not
  // part of the build). "Scaffold CI, manual submit": write the proven CI config (modeled on
  // the apkipa pipeline) + a checklist of the manual Console steps, commit + push. The actual
  // build+upload runs on the user's OWN CI — GitHub Actions for Play, Codemagic cloud-macOS
  // for iOS — with their secrets; production release stays manual.
  // On-demand: build the installable APK, upload it to Google Drive, and return a shareable
  // QR + link. Decoupled from finishing the build (the web preview is already live) so the
  // heavy capped Gradle/APK build only runs when the user clicks "Create APK" — before "Submit
  // to Play". Reuses the delivery pass + the `delivering`-phase reaper (sets run.apk).
  app.post('/api/ralph/apk', async (req, res) => {
    const project = (req.body?.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (!isFlutterRun(run)) return res.status(409).json({ error: 'APK builds are only for Flutter app builds.' });
    if (run.phase === 'delivering') return res.status(409).json({ error: 'An APK build is already in progress.' });
    if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first, then create the APK.' });
    try {
      run.deliverWarning = null;
      run.phase = 'delivering';
      recordRunEvent(run, '📦 building the installable APK and sharing a link…');
      await spawnDelivery(run);
      ralphRuns.set(run.key, run);
      await persistRun(run);
      ralphTick().catch(() => {});
      res.json(runSummary(run));
    } catch (err) {
      run.phase = 'done';
      await persistRun(run).catch(() => {});
      res.status(502).json({ error: `Could not start the APK build: ${err.message}` });
    }
  });

  app.post('/api/ralph/submit', async (req, res) => {
    const project = (req.body?.project || '').trim();
    const store = (req.body?.store || 'play').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    if (!STORES.includes(store)) return res.status(400).json({ error: 'Unknown store (use play or ios).' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (!isFlutterRun(run)) return res.status(409).json({ error: 'Store submission is only for Flutter app builds.' });
    if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first — submit once it is done.' });
    const track = normalizeTrack(req.body?.track);
    const bundleId = validBundleId(req.body?.bundleId) ? req.body.bundleId.trim() : defaultBundleId(run.project);
    const packageName = validBundleId(req.body?.packageName) ? req.body.packageName.trim() : null; // Play: PLAY_PACKAGE_NAME (must match the app's applicationId)
    const doc = submissionDoc(store);
    try {
      let meta, msg;
      if (store === 'play') {
        const wfPath = path.join(run.dir, PLAY_WORKFLOW_PATH);
        await fs.mkdir(path.dirname(wfPath), { recursive: true });
        await fs.writeFile(wfPath, playWorkflowYaml({ track }));
        await fs.writeFile(path.join(run.dir, doc), playChecklistMd({ project: run.project, track }));
        meta = { track, workflow: PLAY_WORKFLOW_PATH };
        msg = `Scaffolded Play upload (${track}).`;
      } else { // ios — Codemagic cloud-macOS (managed App Store Connect signing)
        await fs.writeFile(path.join(run.dir, IOS_WORKFLOW_PATH), codemagicYaml({ bundleId }));
        await fs.writeFile(path.join(run.dir, doc), iosChecklistMd({ project: run.project, bundleId }));
        meta = { bundleId, workflow: IOS_WORKFLOW_PATH };
        msg = `Scaffolded iOS (Codemagic) build for ${bundleId}. Follow ${doc} (Apple Developer Program + the CodemagicAppStoreKey integration), then push to main / trigger Codemagic.`;
      }
      await gitCommitAll(run.dir, `ci(${store}): scaffold ${store === 'ios' ? 'Codemagic iOS' : 'Play'} submission`);
      const pushed = await gitPushRef(run, 'main').catch(() => false);
      // Play: auto-wire the GitHub Actions secrets so the workflow runs without manual GitHub
      // setup — generate/persist an upload keystore, then push the SA JSON + keystore (+ package
      // name if given) via `gh`. Best-effort: partial/failed sets fall back to the checklist.
      if (store === 'play' && pushed) {
        try {
          const keystore = await ensureUploadKeystore(run);
          const sa = tenantKey(run, 'google-play') || googlePlayKey() || '';
          const wired = await setGithubSecrets(run, playSecrets({ serviceAccountJson: sa || undefined, keystore, packageName: packageName || undefined }));
          meta.secrets = { set: wired.set, failed: wired.failed };
          msg = wired.failed.length
            ? `Scaffolded Play upload (${track}); auto-set ${wired.set.length} GitHub secret(s), but ${wired.failed.join(', ')} failed — your github token may lack "Secrets" write, so set those by hand (${doc}). Then do the one-time Play Console steps.`
            : `Scaffolded Play upload (${track}) and auto-set the GitHub Actions secrets${packageName ? '' : ' (also set the PLAY_PACKAGE_NAME variable to your applicationId — none was provided)'}. Do the one-time Play Console steps in ${doc} (create app, first .aab upload, invite the service account), then run the "Play Release" Action.`;
        } catch (e) { msg = `Scaffolded Play upload (${track}); auto-setting secrets failed (${e.message}) — set them by hand per ${doc}.`; }
      }
      run.submit = run.submit || {};
      run.submit[store] = { status: pushed ? 'scaffolded' : 'scaffolded_local', at: Date.now(), ...meta };
      recordRunEvent(run, `🏪 ${store === 'ios' ? 'iOS (Codemagic)' : 'Play'} submission scaffolded — see ${doc}`);
      recordPrefSignal({ type: 'submit', project: run.project, store }, run.tenant || null).catch(() => {});
      await persistRun(run);
      audit({ ralph: run.project, submit: store });
      res.json({ ...runSummary(run), message: msg });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Phase 2a: scaffold a Tauri Windows installer + a windows-latest Actions workflow into a
  // finished web-app repo (user runs the workflow and downloads the installer artifact). The
  // build runs on Actions, not here; no Drive/dispatch (that is Phase 2b).
  app.post('/api/ralph/windows/installer', async (req, res) => {
    const project = (req.body?.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.outputFormat !== 'web-app') return res.status(409).json({ error: 'Windows installers are only for web-app builds.' });
    if (run.phase === 'windows-delivering') return res.status(409).json({ error: 'A Windows installer build is already in progress.' });
    if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first, then build the Windows installer.' });
    const appId = (req.body?.appId || '').trim() || defaultWindowsAppId(run.project);
    const productName = sanitizeProductName(req.body?.productName, run.project);
    const version = (req.body?.version || '1.0.0').trim();
    const check = validateWindowsInput({ appId, productName, version });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    try {
      const info = await prepareWindowsInstaller(run, { appId, productName, version });
      const iconNote = info.iconSeeded ? '' : ' (no brand icon found — a placeholder icon was used; replace src-tauri/icons/source.png, ≥512px square, for branding)';
      if (!info.pushed) {
        recordRunEvent(run, '🪟 Windows installer scaffolded locally, but the GitHub push failed');
        await persistRun(run);
        return res.json({ ...runSummary(run), message: `Scaffolded the Windows installer for ${productName} (${appId} v${version}) locally, but the GitHub push failed — fix the repo/token (Doctor) and retry. See ${info.doc}.${iconNote}` });
      }
      // Pushed — now build it off-box on Actions and deliver the installer to Drive (Phase 2b).
      run.windows.installer.deliverWarning = null;
      run.phase = 'windows-delivering';
      recordRunEvent(run, '📦 building the Windows installer on GitHub Actions and sharing a link…');
      await spawnWindowsDelivery(run);
      ralphRuns.set(run.key, run);
      await persistRun(run);
      ralphTick().catch(() => {});
      audit({ ralph: run.project, windows: 'installer' });
      res.json({ ...runSummary(run), message: `Scaffolded ${productName} (${appId} v${version}) and started the Windows installer build on GitHub Actions. The download link + QR appear here when it is ready (~10–15 min).${iconNote}` });
    } catch (err) {
      // The endpoint gated on phase==='done'; if we advanced to windows-delivering then threw,
      // roll it back so the run doesn't sit in a delivering phase (mirrors the APK endpoint's catch).
      if (run && run.phase === 'windows-delivering') { run.phase = 'done'; await persistRun(run).catch(() => {}); }
      res.status(502).json({ error: `Could not start the Windows installer build: ${err.message}` });
    }
  });

  // Phase 3: package a finished web-app for the Microsoft Store. electron packaging builds an
  // unsigned appx off-box (windows-store.yml on Actions) and delivers it to Drive via the same
  // windows-delivering phase as the installer; pwa packaging is a validated manual step
  // (pwabuilder.com has no CLI/API) — the checklist is written + pushed, no phase change.
  // Partner Center identity comes from the request body, else the tenant's `windows-store`
  // vault key (JSON {identityName, publisher, publisherDisplayName}).
  app.post('/api/ralph/windows/store', async (req, res) => {
    const project = (req.body?.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.outputFormat !== 'web-app') return res.status(409).json({ error: 'Store packaging is only for web-app builds.' });
    if (run.phase === 'windows-delivering') return res.status(409).json({ error: 'A Windows build is already in progress.' });
    if (run.phase !== 'done') return res.status(409).json({ error: 'Finish the build first, then package for the Store.' });
    let vaultId = {};
    try { vaultId = JSON.parse(tenantKey(run, 'windows-store') || '{}'); } catch { /* body must supply it */ }
    const packaging = STORE_PACKAGINGS.includes(req.body?.packaging) ? req.body.packaging : 'electron';
    const identityName = (req.body?.identityName || '').trim() || vaultId.identityName || '';
    const publisher = (req.body?.publisher || '').trim() || vaultId.publisher || '';
    const publisherDisplayName = (req.body?.publisherDisplayName || '').trim() || vaultId.publisherDisplayName || '';
    const version = (req.body?.version || '').trim() || run.windows?.store?.version || '1.0.0';
    const productName = sanitizeProductName(run.windows?.installer?.productName, run.project);
    const check = validateStoreInput({ packaging, identityName, publisher, publisherDisplayName, productName, version, previewUrl: previewUrlFor(run) });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    try {
      const info = await prepareWindowsStore(run, { packaging, identityName, publisher, publisherDisplayName, version });
      if (packaging === 'pwa' || !info.pushed) {
        recordRunEvent(run, packaging === 'pwa'
          ? `🏪 Store checklist ready (pwabuilder path) — see ${STORE_DOC}`
          : '⚠️ Store packaging scaffolded locally, but the GitHub push failed');
        await persistRun(run);
        return res.json({ ...runSummary(run), message: packaging === 'pwa'
          ? `Wrote ${STORE_DOC}: package this PWA at pwabuilder.com from the live preview URL (PWABuilder has no CLI — ~2 min manual), then upload the MSIX in Partner Center.`
          : `Scaffolded the Store packaging locally, but the GitHub push failed — fix the repo/token (Doctor) and retry. See ${STORE_DOC}.` });
      }
      run.windows.store.deliverWarning = null;
      run.phase = 'windows-delivering';
      recordRunEvent(run, '📦 building the Microsoft Store package on GitHub Actions and sharing a link…');
      await spawnWindowsDelivery(run, 'store');
      ralphRuns.set(run.key, run);
      await persistRun(run);
      ralphTick().catch(() => {});
      audit({ ralph: run.project, windows: 'store' });
      res.json({ ...runSummary(run), message: `Started the Store package build (unsigned appx — the Store re-signs it) on GitHub Actions. The download link + QR appear here when it is ready (~10 min). Then follow ${STORE_DOC} to submit in Partner Center.` });
    } catch (err) {
      if (run && run.phase === 'windows-delivering') { run.phase = 'done'; await persistRun(run).catch(() => {}); }
      res.status(502).json({ error: `Could not start the Store packaging: ${err.message}` });
    }
  });

  // Phase 3: refresh the Partner Center submission checklist and (best-effort) wire the
  // OPTIONAL installer code-signing cert as Actions secrets (vault `windows-signing`, JSON
  // {pfxBase64, password} -> WINDOWS_CERT_BASE64/WINDOWS_CERT_PASSWORD). Store packages
  // need no signing (the Store re-signs); this is for SmartScreen-clean sideloading only.
  app.post('/api/ralph/windows/submit', async (req, res) => {
    const project = (req.body?.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.outputFormat !== 'web-app') return res.status(409).json({ error: 'Store submission is only for web-app builds.' });
    if (!run.windows?.store) return res.status(409).json({ error: 'Build the Store package first (it validates the Partner Center identity).' });
    try {
      const s = run.windows.store;
      await fs.writeFile(path.join(run.dir, STORE_DOC), storeSubmissionMd({
        project: run.project, packaging: s.packaging, identityName: s.identityName,
        publisher: s.publisher, publisherDisplayName: s.publisherDisplayName,
        version: s.version, previewUrl: previewUrlFor(run), appId: run.windows?.installer?.appId || defaultWindowsAppId(run.project),
      }));
      let signing = null;
      try { signing = JSON.parse(tenantKey(run, 'windows-signing') || 'null'); } catch { /* optional */ }
      let wired = { set: [], failed: [] };
      if (signing?.pfxBase64) {
        wired = await setGithubSecrets(run, { secrets: {
          WINDOWS_CERT_BASE64: signing.pfxBase64,
          ...(signing.password ? { WINDOWS_CERT_PASSWORD: signing.password } : {}),
        } });
      }
      await gitCommitAll(run.dir, 'docs(windows): refresh Microsoft Store submission checklist').catch(() => {});
      await gitPushRef(run, 'main').catch(() => {});
      run.windows.submit = { at: Date.now(), secrets: wired };
      recordRunEvent(run, `🏬 Store submission checklist refreshed — follow ${STORE_DOC} in the repo`);
      await persistRun(run);
      audit({ ralph: run.project, windows: 'submit' });
      res.json({ ...runSummary(run), message: `Submission checklist pushed (${STORE_DOC}). Reserve the app in Partner Center, upload the package, submit for certification.${signing?.pfxBase64 ? (wired.failed.length ? ' (⚠️ signing secrets could not all be set — token needs Secrets write)' : ' Signing secrets wired for the installer workflow.') : ''}` });
    } catch (err) {
      res.status(502).json({ error: `Could not prepare the submission: ${err.message}` });
    }
  });

  // Pause / resume a run. Pause is a SOFT stop: nothing new spawns and finalize
  // waits, but in-flight stories drain to review (no work is killed mid-edit).
  app.post('/api/ralph/pause', async (req, res) => {
    const run = await loadRun((req.body?.project || '').trim(), tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    run.paused = true;
    recordRunEvent(run, '⏸ paused by you — running stories finish, nothing new starts');
    await persistRun(run);
    audit({ ralph: run.project, paused: true });
    res.json(runSummary(run));
  });
  app.post('/api/ralph/resume', async (req, res) => {
    const run = await loadRun((req.body?.project || '').trim(), tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    run.paused = false;
    recordRunEvent(run, '▶ resumed');
    ralphRuns.set(run.key, run);
    await persistRun(run);
    ralphTick().catch(() => {});
    audit({ ralph: run.project, paused: false });
    res.json(runSummary(run));
  });

  // Skip ONE story mid-flight: kill its sessions, drop its branch, mark it
  // `skipped` — a RESOLVED state, so dependents proceed without it and finalize
  // isn't blocked. Also revives a failed run when the user skips its dead story.
  app.post('/api/ralph/skip', async (req, res) => {
    const project = (req.body?.project || '').trim();
    const id = (req.body?.story || '').trim();
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    const st = storyById(run, id);
    if (!st) return res.status(404).json({ error: 'Unknown story.' });
    if (['merged', 'skipped', 'reverted'].includes(st.status)) {
      return res.status(409).json({ error: `Story is already ${st.status}.` });
    }
    for (const kind of ['r', 'rv']) {
      try { await tmux(['kill-session', '-t', ralphSessionName(run.project, st.id, kind, run.tenant)]); } catch { /* gone */ }
    }
    await fs.rm(path.join(run.dir, '.ralph', `${st.id}.exit`), { force: true }).catch(() => {});
    await fs.rm(path.join(run.dir, '.ralph', `${st.id}.verdict`), { force: true }).catch(() => {});
    await gitRemoveWorktree(run.dir, st.id).catch(() => {});
    await git(run.dir, ['branch', '-D', st.branch]).catch(() => {});
    st.status = 'skipped';
    st.error = null;
    st.startAt = null; // abandoning a scheduled story cancels its timer
    // Unblock dependents that were blocked by this story's earlier failure.
    for (const s of run.stories) {
      if (s.status === 'blocked' && (s.deps || []).includes(st.id)) { s.status = 'todo'; s.error = null; s.phaseSince = Date.now(); }
    }
    if (run.phase === 'failed' && !run.stories.some((s) => ['failed', 'blocked'].includes(s.status))) {
      run.phase = 'building'; run.error = null;
    }
    recordMasterLearning(run, `${st.id} skipped by the user — dependents proceed without it`);
    recordRunEvent(run, `⏭ you skipped ${st.id} · "${st.title}" — the rest continue`);
    ralphRuns.set(run.key, run);
    await persistRun(run);
    ralphTick().catch(() => {});
    audit({ ralph: run.project, story: st.id, skipped: true });
    res.json(runSummary(run));
  });

  // Edit a story's instructions (title/description/acceptance criteria) — and
  // optionally its agent — typically while paused. An in-flight story is stopped
  // and re-queued so the next attempt builds from the NEW instructions; prd.json
  // on main is rewritten + committed so fresh worktrees see them.
  app.post('/api/ralph/story-edit', async (req, res) => {
    const project = (req.body?.project || '').trim();
    const id = (req.body?.story || '').trim();
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    const st = storyById(run, id);
    if (!st) return res.status(404).json({ error: 'Unknown story.' });
    const kind = editKind(st.status);
    if (!kind) return res.status(409).json({ error: 'This story was reverted — add a new story instead.' });
    if (kind === 'regenerate') {
      // Rebuild-on-top (spec §"Approach A"): only when the run isn't mid-flight.
      if (['building', 'researching', 'awaiting'].includes(run.phase)) return res.status(409).json({ error: 'A build is already in progress.' });
      if (['finalizing', 'delivering', 'windows-delivering'].includes(run.phase)) return res.status(409).json({ error: 'The build is finishing up — try again in a minute, or pause it first.' });
    }
    if (typeof req.body?.title === 'string' && req.body.title.trim()) st.title = req.body.title.trim().slice(0, 200);
    if (typeof req.body?.description === 'string') st.description = req.body.description.slice(0, 4000);
    if (Array.isArray(req.body?.acceptanceCriteria)) {
      st.acceptanceCriteria = req.body.acceptanceCriteria.map((c) => String(c).slice(0, 500)).filter(Boolean).slice(0, 20);
    }
    const agent = (req.body?.agent || '').trim();
    if (agent) {
      if (!VALID_AGENTS.includes(agent)) return res.status(400).json({ error: 'Invalid agent.' });
      const missing = await missingAgentCreds(tenantOf(req), [agent]);
      if (missing.length) return res.status(400).json({ error: missingKeysError(missing) });
      st.assignee = agent;
    }
    // Optional schedule: a number is clamped to [now+15s, now+30d]; an explicit
    // null clears it (the UI's "Start now"); absent leaves it untouched.
    if ('startAt' in (req.body || {})) {
      st.startAt = req.body.startAt === null ? null : clampStoryStart(req.body.startAt, Date.now());
    }
    // Stop any in-flight attempt; re-queue so the next spawn uses the new text.
    if (['building', 'review'].includes(st.status)) {
      for (const kind of ['r', 'rv']) {
        try { await tmux(['kill-session', '-t', ralphSessionName(run.project, st.id, kind, run.tenant)]); } catch { /* gone */ }
      }
      await fs.rm(path.join(run.dir, '.ralph', `${st.id}.exit`), { force: true }).catch(() => {});
      await fs.rm(path.join(run.dir, '.ralph', `${st.id}.verdict`), { force: true }).catch(() => {});
      await gitRemoveWorktree(run.dir, st.id).catch(() => {});
      await git(run.dir, ['branch', '-D', st.branch]).catch(() => {});
    }
    if (kind === 'regenerate') {
      // Fresh branch off the CURRENT main — the old one still points at the
      // pre-merge tip. The merge commit itself is untouched (history preserved).
      await gitRemoveWorktree(run.dir, st.id).catch(() => {});
      await git(run.dir, ['branch', '-D', st.branch]).catch(() => {});
      st.revision = true; // diff-focused master review (the Revise machinery)
    }
    if (st.status !== 'todo') { st.status = 'todo'; st.iterations = 0; st.error = null; st.phaseSince = Date.now(); }
    if (['failed', 'done', 'push_failed'].includes(run.phase)) { run.phase = 'building'; run.error = null; }
    await fs.writeFile(path.join(run.dir, 'prd.json'), JSON.stringify(prdFileShape(run), null, 2)).catch(() => {});
    await gitCommitAll(run.dir, `plan: edit ${st.id} instructions`).catch(() => {});
    recordMasterLearning(run, `${st.id} ${kind === 'regenerate' ? 'regeneration requested' : 'instructions edited'} by the user${agent ? ` (agent → ${agent})` : ''}`);
    recordRunEvent(run, kind === 'regenerate'
      ? `↻ you asked for ${st.id} to be redone — rebuilding on the current app${st.startAt ? ` (⏰ starts ${new Date(st.startAt).toLocaleString()})` : ''}`
      : `✏ you edited ${st.id}${agent ? ` and handed it to ${agent}` : ''} — rebuilding with the new instructions${st.startAt ? ` (⏰ starts ${new Date(st.startAt).toLocaleString()})` : ''}`);
    ralphRuns.set(run.key, run);
    await persistRun(run);
    ralphTick().catch(() => {});
    audit({ ralph: run.project, story: st.id, edited: true, agent: agent || undefined });
    res.json(runSummary(run));
  });

  // Hand-written story — no planner call. Queued like any other story; on a
  // finished build it's a revision (the agent changes the existing app, and the
  // master reviews the diff). Allowed mid-build too (just another todo); only
  // the finalize/deliver window is closed (those briefs are already written).
  app.post('/api/ralph/story-add', async (req, res) => {
    const project = (req.body?.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (['finalizing', 'delivering', 'windows-delivering'].includes(run.phase)) {
      return res.status(409).json({ error: 'The build is finishing up — try again in a minute, or pause it first.' });
    }
    if (['researching', 'awaiting'].includes(run.phase)) {
      return res.status(409).json({ error: 'This project has no plan yet — give it instructions first.' });
    }
    const wasFinished = ['done', 'failed', 'push_failed'].includes(run.phase);
    const { story, error } = normalizeNewStory(req.body, run.stories.map((s) => s.id), VALID_AGENTS);
    if (error) return res.status(400).json({ error });
    story.assignee = story.assignee || run.master;
    {
      const missing = await missingAgentCreds(tenantOf(req), [story.assignee]);
      if (missing.length) return res.status(400).json({ error: missingKeysError(missing) });
    }
    story.revision = wasFinished; // diff-focused review only when the app already shipped
    story.startAt = 'startAt' in (req.body || {}) && req.body.startAt !== null
      ? clampStoryStart(req.body.startAt, Date.now()) : null;
    run.stories.push(story);
    if (wasFinished) { run.phase = 'building'; run.error = null; }
    await fs.writeFile(path.join(run.dir, 'prd.json'), JSON.stringify(prdFileShape(run), null, 2)).catch(() => {});
    await gitCommitAll(run.dir, `plan: add ${story.id} (manual)`).catch(() => {});
    recordPrefSignal({ type: 'story-add', project: run.project, idea: story.title.slice(0, 240) }, run.tenant || null).catch(() => {});
    recordMasterLearning(run, `${story.id} added by hand by the user (assignee ${story.assignee})`);
    recordRunEvent(run, `＋ you added ${story.id} — ${story.startAt ? `starts at ${new Date(story.startAt).toLocaleString()} ⏰` : 'building it now'}`);
    ralphRuns.set(run.key, run);
    await persistRun(run);
    ralphTick().catch(() => {});
    audit({ ralph: run.project, story: story.id, added: true });
    res.json(runSummary(run));
  });

  // Switch the master (or one story's agent) when an agent isn't working, then
  // re-queue failed stories and resume — so the user is never stuck waiting on a
  // dead LLM.
  app.post('/api/ralph/swap', async (req, res) => {
    const project = (req.body?.project || '').trim();
    const role = (req.body?.role || '').trim(); // 'master' or a story id
    const agent = (req.body?.agent || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    if (!VALID_AGENTS.includes(agent)) return res.status(400).json({ error: 'Invalid agent.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    {
      const missing = await missingAgentCreds(tenantOf(req), [agent]);
      if (missing.length) return res.status(400).json({ error: missingKeysError(missing) });
    }
    try {
      await ralphSwap(run, role, agent);
      res.json(runSummary(run));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  });

  // --- Doctor: diagnose a failed run and auto-treat it ------------------------
  // Rules classify each failure and map it to one of the orchestrator's own
  // recovery primitives (rebuild on current main, swap a flaky agent, re-run
  // finalize, re-attempt the remote); one OpenAI pass turns the findings into a
  // plain-English diagnosis, falling back to rules text if the key/call is absent.

  // Pick a different agent than `current` from the run's roster, preferring the
  // reliable CLIs and never glm (unreliable in the agentic loop).
  function alternateAgent(current, run) {
    const roster = [...new Set([run.master, ...(run.workers || [])])];
    const prefer = ['claude', 'codex', 'gemini', 'qwen'].filter((a) => roster.includes(a) && a !== current);
    return prefer[0] || roster.find((a) => a !== current && a !== 'glm') || current;
  }

  // Reset a story so the tick rebuilds it fresh on the current main (mirrors the
  // swap endpoint's reset, plus the progress-aware activity fields).
  async function resetStoryForRetry(run, story) {
    for (const kind of ['r', 'rv']) {
      try { await tmux(['kill-session', '-t', ralphSessionName(run.project, story.id, kind, run.tenant)]); } catch { /* gone */ }
    }
    await gitRemoveWorktree(run.dir, story.id).catch(() => {});
    await git(run.dir, ['branch', '-D', story.branch]).catch(() => {});
    story.status = 'todo'; story.iterations = 0; story.error = null; story.lastReject = null;
    story.phaseSince = story.lastActivity = Date.now(); story.paneSig = '';
  }

  // Rules: classify one failed/blocked story into a failure class + remedy.
  function classifyStory(story) {
    const e = String(story.error || '').toLowerCase();
    if (story.status === 'blocked' || /dependency failed/.test(e))
      return { cls: 'blocked', remedy: 'rebuild once its failed dependency is healed' };
    if (/merge conflict/.test(e))
      return { cls: 'merge-conflict', remedy: 'rebuild on the current main and re-merge' };
    if (/stall/.test(e))
      return { cls: 'stalled', remedy: 'reassign to a fresh agent and rebuild', swap: true };
    if (/reject/.test(e))
      return { cls: 'rejected', remedy: 'reassign to a fresh agent and rebuild', swap: true };
    if (/respawn|spawn/.test(e))
      return { cls: 'spawn-error', remedy: 'rebuild (likely transient)' };
    return { cls: 'unknown', remedy: 'rebuild on the current main' };
  }

  // Apply the rules-chosen remedies in place and arrange to resume the run.
  async function doctorTreat(run) {
    const failed = run.stories.filter((s) => s.status === 'failed' || s.status === 'blocked');
    const finalizeFailed = !failed.length && /finalize/i.test(run.error || '');
    const pushFailed = run.phase === 'push_failed' || (!failed.length && /push/i.test(run.error || ''));

    const findings = [];
    for (const story of failed) {
      const c = classifyStory(story);
      const f = { id: story.id, title: story.title, status: story.status, error: story.error || null, cls: c.cls, remedy: c.remedy, agent: story.assignee };
      if (c.swap) {
        const next = alternateAgent(story.assignee, run);
        if (next && next !== story.assignee) { f.swapFrom = story.assignee; f.swapTo = next; story.assignee = next; }
      }
      await resetStoryForRetry(run, story); // also re-evaluates blocked stories
      findings.push(f);
    }

    let remoteFix = null;
    if (pushFailed) { // re-attempt the remote from scratch — the ensureRemote fixes may now succeed
      await git(run.dir, ['remote', 'remove', 'origin']).catch(() => {});
      run.repo = null; run.pushWarning = null; run.repoCreateForbidden = false;
      try { remoteFix = (await ensureRemote(run), await gitPushRef(run, 'main')) ? 'remote re-created and main pushed' : `push still failing: ${run.pushWarning}`; }
      catch (e) { remoteFix = `remote retry failed: ${e.message}`; }
    }

    // Resume. 'building' re-spawns todo/unblocked stories; with everything already
    // merged it re-triggers finalize. A clean remote re-push resolves push_failed.
    if (failed.length || finalizeFailed) { run.phase = 'building'; run.error = null; }
    else if (pushFailed) { run.phase = run.repo ? 'done' : 'push_failed'; if (run.repo) run.error = null; }
    return { findings, finalizeFailed, pushFailed, remoteFix };
  }

  // Hybrid diagnosis: rules build the structured findings; OpenAI writes the prose.
  async function doctorDiagnosis(run, treat) {
    const rulesText = treat.findings.length
      ? `Diagnosed ${treat.findings.length} failed/blocked stor${treat.findings.length === 1 ? 'y' : 'ies'}: `
        + treat.findings.map((f) => `${f.id} (${f.cls})${f.swapTo ? ` → reassigned ${f.swapFrom}→${f.swapTo}` : ''} → ${f.remedy}`).join('; ') + '.'
      : (treat.finalizeFailed ? 'Finalize did not pass; re-running it.'
        : treat.pushFailed ? `Remote push had failed; ${treat.remoteFix}.` : 'No failures found.');
    if (!openaiKey()) return rulesText;
    const lines = treat.findings.map((f) => `- ${f.id} [${f.cls}]${f.swapTo ? ` (reassigned ${f.swapFrom}→${f.swapTo})` : ''}: ${f.error || 'no error text'}`);
    if (treat.finalizeFailed) lines.push(`- finalize: ${run.error || 'did not pass'} (re-running)`);
    if (treat.pushFailed) lines.push(`- remote: ${treat.remoteFix}`);
    try {
      const out = await callOpenAI([
        { role: 'system', content: 'You are the build-doctor for an autonomous multi-agent code orchestrator (planner + master review + parallel workers, each story on its own git branch/worktree). Given failure findings and the remedy ALREADY applied, write a SHORT 2-4 sentence plain-English diagnosis a developer can skim: what went wrong, the likely cause, and what was just done to fix it. No preamble, no markdown headers, no bullet list.' },
        { role: 'user', content: `Project: ${run.project}\nFindings and remedy applied:\n${lines.join('\n')}` },
      ]);
      return String(out || '').trim() || rulesText;
    } catch { return rulesText; }
  }

  // One-click: diagnose + auto-treat a failed/push_failed run, then resume it.
  app.post('/api/ralph/:project/doctor', async (req, res) => {
    const project = (req.params.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const run = await loadRun(project, tenantOf(req));
    if (!run) return res.status(404).json({ error: 'No run for that project.' });
    if (run.phase === 'building' || run.phase === 'finalizing') return res.status(409).json({ error: 'The run is still active — let it settle before calling the doctor.' });
    if (!['failed', 'push_failed'].includes(run.phase)) return res.status(409).json({ error: 'This run has not failed — nothing to treat.' });
    try {
      const treat = await doctorTreat(run);
      const diagnosis = await doctorDiagnosis(run, treat);
      ralphRuns.set(run.key, run);
      await persistRun(run);
      ralphTick().catch(() => {});
      audit({ ralphDoctor: project, findings: treat.findings.map((f) => `${f.id}:${f.cls}`), resumePhase: run.phase });
      res.json({ ok: true, diagnosis, treatments: treat.findings, finalizeFailed: treat.finalizeFailed, pushFailed: treat.pushFailed, remoteFix: treat.remoteFix, run: runSummary(run) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Learned user preferences (cross-project memory). GET seeds the start dialog;
  // PUT hand-edits; DELETE forgets. Defined before the :project routes so "prefs"
  // is never mistaken for a project name. Suggest-only — the user always overrides.
  app.get('/api/ralph/prefs', async (req, res) => {
    const tenant = tenantOf(req);
    const p = await loadPrefs(tenant).catch(() => null);
    const facts = tenant ? (() => { try { return saasStore.listFacts(tenant.id); } catch { return []; } })() : [];
    res.json({ prefs: p?.prefs || {}, profileNote: p?.profileNote || '', signals: (p?.signals || []).length, facts });
  });
  app.put('/api/ralph/prefs', async (req, res) => {
    try {
      const tenant = tenantOf(req);
      const p = await loadPrefs(tenant);
      if (req.body && typeof req.body.prefs === 'object') p.prefs = req.body.prefs;
      if (typeof req.body?.profileNote === 'string') p.profileNote = req.body.profileNote.slice(0, 600);
      await savePrefs(p, tenant);
      res.json({ prefs: p.prefs, profileNote: p.profileNote });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  // Forget a single learned fact (the user-facing "that's wrong about me" control),
  // or with no :id — wipe the whole memory (signals, prefs, note, facts).
  app.delete('/api/ralph/prefs/facts/:id', (req, res) => {
    const tenant = tenantOf(req);
    if (!tenant) return res.status(400).json({ error: 'Multi-tenant only.' });
    try { saasStore.deleteFact(tenant.id, req.params.id); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.delete('/api/ralph/prefs', async (req, res) => {
    try {
      const tenant = tenantOf(req);
      await savePrefs({ signals: [], prefs: {}, profileNote: '' }, tenant);
      if (tenant) { try { saasStore.clearFacts(tenant.id); } catch { /* best-effort */ } }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Solo-build model map (read-only; ids are not secrets). Registered before the
  // :project routes so "solo-models" is never treated as a project name.
  app.get('/api/ralph/solo-models', (_req, res) =>
    res.json({ models: soloModelsEffective(), saved: savedSoloModels(), defaults: SOLO_MODEL_DEFAULTS, agents: SOLO_AGENTS }));

  // Media-generation caps/toggles (read-only; ids/caps are not secrets). Registered
  // before the :project routes so "media-caps" is never treated as a project name.
  app.get('/api/ralph/media-caps', (_req, res) => res.json({ caps: mediaCapsEffective(), defaults: mediaCapDefaults() }));

  // Build drafts (before the :project routes so "drafts" isn't parsed as a project).
  app.get('/api/ralph/drafts', async (req, res) => {
    res.json({ drafts: (await loadDraftsList(tenantOf(req))).map(draftListItem) });
  });
  app.get('/api/ralph/drafts/:id', async (req, res) => {
    const d = (await loadDraftsList(tenantOf(req))).find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Draft not found.' }); // fail() is scoped inside the MT block
    res.json({ draft: d });
  });
  app.post('/api/ralph/drafts', async (req, res) => {
    const draft = normalizeDraft(req.body?.draft || req.body);
    const id = await saveDraftFor(tenantOf(req), (req.body?.id || '').toString() || null, draft);
    res.json({ ok: true, id });
  });
  app.delete('/api/ralph/drafts/:id', async (req, res) => {
    await deleteDraftFor(tenantOf(req), req.params.id);
    res.json({ ok: true });
  });
  // Subscription tracking notes: what the user records per provider to plan around their
  // plans (start/end dates, peak hours, current usage, notes, dashboard link). CRUD on the
  // per-tenant map; entries are sanitized by ralph/sub-tracking.mjs (an all-empty entry clears).
  app.get('/api/tracking', async (req, res) => {
    res.json({ tracking: await loadTracking(tenantOf(req)) });
  });
  app.put('/api/tracking/:provider', async (req, res) => {
    const provider = String(req.params.provider || '');
    if (!validTrackingProvider(provider)) return res.status(400).json({ error: 'Invalid provider id.' });
    const tenant = tenantOf(req);
    const map = await loadTracking(tenant);
    const entry = normalizeTrackingEntry(req.body?.entry || req.body);
    if (entry) map[provider] = { ...entry, updatedAt: Date.now() };
    else delete map[provider];
    await saveTracking(tenant, map);
    res.json({ ok: true, tracking: map });
  });
  app.delete('/api/tracking/:provider', async (req, res) => {
    const provider = String(req.params.provider || '');
    if (!validTrackingProvider(provider)) return res.status(400).json({ error: 'Invalid provider id.' });
    const tenant = tenantOf(req);
    const map = await loadTracking(tenant);
    delete map[provider];
    await saveTracking(tenant, map);
    res.json({ ok: true, tracking: map });
  });

  // Start timer: schedule a draft to auto-start (one-shot; the draft-timer scan in
  // monitorTick fires it). Body: { delayMs } (clamped 15s..30d) or an absolute { startAt }.
  app.post('/api/ralph/drafts/:id/schedule', async (req, res) => {
    const tenant = tenantOf(req);
    const d = (await loadDraftsList(tenant)).find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Draft not found.' });
    const now = Date.now();
    const startAt = req.body?.startAt != null
      ? Math.round(Number(req.body.startAt))
      : scheduleAt(now, req.body?.delayMs);
    if (!Number.isFinite(startAt) || startAt == null || startAt < now - 60_000) {
      return res.status(400).json({ error: 'Give delayMs (min 15s) or a future startAt epoch-ms timestamp.' });
    }
    const { id, updatedAt, ...rest } = d;
    await saveDraftFor(tenant, d.id, { ...rest, startAt, startError: null });
    audit({ draft: d.id, schedule: startAt, tenant: tenant?.slug });
    res.json({ ok: true, startAt });
  });
  app.delete('/api/ralph/drafts/:id/schedule', async (req, res) => {
    const tenant = tenantOf(req);
    const d = (await loadDraftsList(tenant)).find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Draft not found.' });
    const { id, updatedAt, ...rest } = d;
    await saveDraftFor(tenant, d.id, { ...rest, startAt: null, startError: null });
    res.json({ ok: true });
  });

  // Delete a project: stop its processes and remove all files + state (free space).
  app.delete('/api/ralph/:project', async (req, res) => {
    const project = (req.params.project || '').trim();
    if (!validProject(project)) return res.status(400).json({ error: 'Invalid project name.' });
    const tenant = tenantOf(req);
    const root = tenant ? tenant.projectsRoot : PROJECTS_ROOT;
    const dir = path.join(root, project);
    if (path.dirname(dir) !== root) return res.status(400).json({ error: 'Invalid project.' });
    const key = runKey(project, tenant);
    try {
      await killProjectSessions(project, tenant);
      dropAppProcess(key);
      ralphRuns.delete(key);
      await fs.rm(path.join(RALPH_STATE_DIR, `${key}.json`), { force: true }).catch(() => {});
      if (tenant) {
        // Tenant files are tenant-owned and the projects dir is sticky-bitted —
        // the app user can't unlink them. Remove AS the tenant, like all other
        // mutations inside the sandbox.
        const argv = tenant.wrap(['rm', '-rf', dir]);
        await execFileAsync(argv[0], argv.slice(1), { timeout: 60_000 });
      } else {
        await fs.rm(dir, { recursive: true, force: true });
      }
      await regenerateProjectIndex(tenant).catch(() => {}); // drop the deleted project from the index
      audit({ ralphDelete: key });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
