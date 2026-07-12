// server/routes/rc.mjs — the phone remote-control surface under /rc/: static
// assets, device-gated status/push, and the supervise actions (answer/steer/
// continue/swap/restart). nginx exempts /rc/ from basic-auth; requireDevice is
// the gate here.
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { MULTITENANT, REPO_ROOT, audit } from '../config.mjs';
import { WORKTREES_SUBDIR } from '../git.mjs';
import { VALID_AGENTS } from '../agents.mjs';
import { requireDevice, rcDeviceFromReq } from '../rc.mjs';
import { vapidPublicKey, addRcSubscription, removeSubscriptions } from '../push.mjs';
import { ralphRuns, persistRun, spawnWorker } from '../ralph-engine.mjs';
import { ralphSwap } from './ralph.mjs';

export function registerRcRoutes(app) {
  // RC static assets (nginx exempts /rc/ so the phone can load these without basic-auth).
  // NOTE: GET /rc (the pairing landing) is registered EARLY (before express.static) to prevent
  // express.static's extensions:['html'] from masking it with public/rc.html.
  const RC_PUBLIC = path.join(REPO_ROOT, 'public');
  app.get('/rc/', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'rc.html')));
  app.get('/rc/rc.js', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'js/rc.js')));
  app.get('/rc/rc.webmanifest', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'rc.webmanifest')));
  app.use('/rc/vendor', express.static(path.join(RC_PUBLIC, 'vendor'))); // xterm assets
  app.use('/rc/icons', express.static(path.join(RC_PUBLIC, 'icons')));
  app.get('/rc/sw.js', (_req, res) => res.sendFile(path.join(RC_PUBLIC, 'rc.sw.js')));

  // Device-gated push subscribe/unsubscribe/key for RC clients.
  app.get('/rc/api/push/key', requireDevice, (_req, res) => res.json({ key: vapidPublicKey() }));
  app.post('/rc/api/push/subscribe', requireDevice, async (req, res) => {
    const sub = req.body?.subscription;
    if (!sub?.endpoint) return res.status(400).json({ error: 'bad subscription' });
    await addRcSubscription(sub, { deviceId: req.rcDevice.id, tenant: req.rcDevice.tenant || null });
    res.status(201).json({ ok: true });
  });
  app.post('/rc/api/push/unsubscribe', requireDevice, async (req, res) => {
    await removeSubscriptions((s) => s.endpoint === req.body?.endpoint); res.json({ ok: true });
  });

  // Read run status for the device's tenant. Reuses the run model; surfaces any pending
  // (unanswered) worker question so the phone can answer it.
  app.get('/rc/api/status', requireDevice, async (req, res) => {
    const wanted = String(req.query.project || '');
    const out = [];
    for (const run of ralphRuns.values()) {
      if (MULTITENANT && run.tenant?.slug !== req.rcDevice.tenant) continue;
      if (wanted && run.project !== wanted) continue;
      const story = run.stories?.find((s) => s.status === 'building') || run.stories?.find((s) => s.status === 'reviewing') || null;
      let question = null;
      if (story) {
        const ctl = path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph');
        try {
          const q = (await fs.readFile(path.join(ctl, 'question.md'), 'utf8')).trim();
          const answered = await fs.access(path.join(ctl, 'answer.md')).then(() => true).catch(() => false);
          if (q && !answered) question = { story: story.id, text: q.slice(0, 2000) };
        } catch { /* none */ }
      }
      out.push({
        project: run.project, phase: run.phase, master: run.master,
        story: story ? { id: story.id, title: story.title, status: story.status } : null,
        question, attention: run.attention || null,
      });
    }
    res.json({ runs: out });
  });

  // Helper: find the in-memory run for the device's tenant + a project name.
  function rcRun(req, project) {
    for (const run of ralphRuns.values()) {
      if (MULTITENANT && run.tenant?.slug !== req.rcDevice.tenant) continue;
      if (run.project === project) return run;
    }
    return null;
  }
  // Helper: resolve the target story's control dir (by explicit id, or the active story).
  function rcCtlDir(run, storyId) {
    const story = run.stories.find((s) => s.id === storyId)
      || run.stories.find((s) => s.status === 'building' || s.status === 'reviewing');
    return story ? { story, ctl: path.join(run.dir, WORKTREES_SUBDIR, story.id, '.ralph') } : null;
  }

  app.post('/rc/api/answer', requireDevice, async (req, res) => {
    const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
    const tgt = rcCtlDir(run, String(req.body?.story || '')); if (!tgt) return res.status(409).json({ error: 'no active story' });
    await fs.mkdir(tgt.ctl, { recursive: true });
    await fs.writeFile(path.join(tgt.ctl, 'answer.md'), String(req.body?.text || '').slice(0, 4000) + '\n');
    audit({ rcAnswer: run.project, story: tgt.story.id, device: req.rcDevice.id });
    res.json({ ok: true });
  });

  app.post('/rc/api/steer', requireDevice, async (req, res) => {
    const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
    const tgt = rcCtlDir(run, String(req.body?.story || '')); if (!tgt) return res.status(409).json({ error: 'no active story' });
    await fs.mkdir(tgt.ctl, { recursive: true });
    await fs.writeFile(path.join(tgt.ctl, 'steer.md'), String(req.body?.text || '').slice(0, 2000) + '\n');
    audit({ rcSteer: run.project, story: tgt.story.id, device: req.rcDevice.id });
    res.json({ ok: true });
  });

  app.post('/rc/api/continue', requireDevice, async (req, res) => {
    const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
    if (run.paused) { run.paused = false; await persistRun(run); audit({ rcContinue: run.project, device: req.rcDevice.id }); }
    res.json({ ok: true });
  });

  app.post('/rc/api/swap', requireDevice, async (req, res) => {
    const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
    const agent = String(req.body?.agent || ''); const role = String(req.body?.role || 'master');
    if (!VALID_AGENTS.includes(agent)) return res.status(400).json({ error: 'Invalid agent.' });
    try { await ralphSwap(run, role, agent); audit({ rcSwap: run.project, device: req.rcDevice.id }); res.json({ ok: true }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  app.post('/rc/api/restart', requireDevice, async (req, res) => {
    const run = rcRun(req, String(req.body?.project || '')); if (!run) return res.status(404).json({ error: 'no run' });
    const tgt = rcCtlDir(run, String(req.body?.story || '')); if (!tgt) return res.status(409).json({ error: 'no active story' });
    if (!['building', 'reviewing'].includes(tgt.story.status)) return res.status(409).json({ error: 'Story is not active.' });
    try { await spawnWorker(run, tgt.story, 'remote restart requested'); audit({ rcRestart: run.project, story: tgt.story.id, device: req.rcDevice.id }); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}
