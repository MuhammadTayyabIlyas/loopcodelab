# Google Drive Media Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `social-video` build finishes, automatically upload its platform renders to Google Drive, record links in `DELIVERABLE.md` + `run.mediaShare` + both UIs, and delete the local media to free server storage (fail-soft: keep local copies if upload fails).

**Architecture:** Mirrors the proven APK/Windows delivery shape — a root-owned sudo wrapper (`webtmux-artifact-share`, allowlist extended for media extensions) invoked from a spawned tmux session (`ralph/ralph-media-deliver.sh`) that writes a sentinel JSON the 4s tick reaps in a new `media-delivering` phase; NEVER slow work inline in the tick. Pure logic (share list, result parsing, DELIVERABLE markdown, Drive-link gallery) in unit-tested `ralph/media-deliver.mjs`. To make deletion actually reclaim disk, social-video repos stop committing media binaries (scaffold-time `.gitignore` entries + SKILL.md rule change) — the deliverable of record becomes the Drive links.

**Tech Stack:** Node ESM + `node --test`, bash delivery script in tmux, existing `share-apk-to-drive.mjs` uploader via sudo wrapper, React/PWA UI touches.

**User decisions (2026-07-03):** automatic at finish (no button); NO local copies kept after successful upload.

## Global Constraints

- Delivery is ADVISORY: any failure/stall (10 min, `WEBTMUX_MEDIA_DELIVER_STALL_MS`) → `run.mediaShare = { error }`, local files KEPT, phase still reaches `done`, build never fails.
- The deliver script ALWAYS writes its sentinel (`emit`/`fail` pattern, `|| true`) so the tick can't hang; `--stub` (from `RALPH_FORCE_TOOL`) emits deterministic links with zero uploads.
- Upload path is ONLY via `sudo -n /usr/local/sbin/webtmux-artifact-share <file> <name>` (Drive tokens are www-data-owned; the wrapper chowns them back — never bypass it).
- Drive filenames: `<project>-<platform>.mp4` (must pass the wrapper's `^[A-Za-z0-9._-]+\.(…)$` regex — project names are already DNS-safe slugs).
- The host wrapper and the repo template `docs/ops/webtmux-artifact-share.sh` must stay byte-identical after the allowlist change (edit template → verify current host copy matches old template → install).
- After success: delete `output/*.mp4` + generated media in `scenes/` and `audio/` (keep `storyboard.json`, `DELIVERABLE.md`, `index.html`); rewrite the root `index.html` gallery to Drive links; commit + push.
- New-repo `.gitignore` for social-video adds `output/`, `scenes/`, `audio/` (disk actually freed on delete; existing repos keep their history — no rewriting).
- Tests: `node --test ralph/media-deliver.test.mjs`; syntax `bash -n ralph/ralph-media-deliver.sh`, `node --check` sweep. `public/` edits bump `public/sw.js` VERSION (currently `webtmux-v47` → `v48`, once, in the UI task). `web/` edits need `cd web && npm run build`. Server edits need `systemctl restart webtmux` + clean journal.
- Commit per task, specific files only, never `-A`.

---

### Task 1: `ralph/media-deliver.mjs` — pure share-list / parse / markdown / gallery + tests

**Files:**
- Create: `ralph/media-deliver.mjs`
- Create: `ralph/media-deliver.test.mjs`

**Interfaces:**
- Consumes: `platformForFile(name)` from `./social-formats.mjs`; `PLATFORM_SPECS` from `./social-formats.mjs`.
- Produces (Tasks 2/3 rely on exact names):
  - `mediaShareList(names, project) -> [{ file, driveName, platform }]` — filters to `*-<platform>.mp4`, driveName `<project>-<platform>.mp4`
  - `parseMediaDeliverResult(raw) -> { files:[{name,platform,shareLink,directDownload,qr,size}] } | { error } | null`
  - `mediaDeliverableMarkdown({ project, previewUrl, files }) -> string`
  - `galleryDriveHtml(files, { title, color }) -> string` — self-contained gallery page whose `<video src>` is each file's `directDownload` URL with an "Open in Drive ↗" link + QR per card, HTML-escaped

- [ ] **Step 1: Write the failing tests**

Create `ralph/media-deliver.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaShareList, parseMediaDeliverResult, mediaDeliverableMarkdown, galleryDriveHtml,
} from './media-deliver.mjs';

test('mediaShareList: only platform renders, drive-safe names, junk skipped', () => {
  const l = mediaShareList(['story-tiktok.mp4', 'story-youtube.mp4', 'notes.txt', 'raw.mp4'], 'moon-walk');
  assert.deepEqual(l, [
    { file: 'output/story-tiktok.mp4', driveName: 'moon-walk-tiktok.mp4', platform: 'tiktok' },
    { file: 'output/story-youtube.mp4', driveName: 'moon-walk-youtube.mp4', platform: 'youtube' },
  ]);
  assert.deepEqual(mediaShareList([], 'x'), []);
  assert.deepEqual(mediaShareList('junk', 'x'), []);
});

test('parseMediaDeliverResult: success, error, pending', () => {
  const ok = parseMediaDeliverResult(JSON.stringify({
    files: [{ name: 'p-tiktok.mp4', platform: 'tiktok', shareLink: 'https://d/1', directDownload: 'https://d/dl/1', qr: 'https://q/1', size: 5 }],
  }));
  assert.equal(ok.files.length, 1);
  assert.equal(ok.files[0].platform, 'tiktok');
  assert.deepEqual(parseMediaDeliverResult('{"error":"upload failed"}'), { error: 'upload failed' });
  assert.equal(parseMediaDeliverResult(''), null);
  assert.equal(parseMediaDeliverResult('not json'), null);
  assert.deepEqual(parseMediaDeliverResult('{"files":"junk"}'), { error: 'malformed delivery result' });
});

test('mediaDeliverableMarkdown: project, preview, one line per file with link + qr', () => {
  const md = mediaDeliverableMarkdown({
    project: 'moon-walk', previewUrl: 'https://moon-walk.example.com',
    files: [{ name: 'moon-walk-tiktok.mp4', platform: 'tiktok', shareLink: 'https://d/1', qr: 'https://q/1' }],
  });
  assert.ok(md.includes('# moon-walk') && md.includes('https://moon-walk.example.com'));
  assert.ok(md.includes('tiktok') && md.includes('https://d/1') && md.includes('https://q/1'));
});

test('galleryDriveHtml: video src = directDownload, drive link, escaped title', () => {
  const html = galleryDriveHtml(
    [{ name: 'p-tiktok.mp4', platform: 'tiktok', shareLink: 'https://d/1', directDownload: 'https://d/dl/1', qr: 'https://q/1' }],
    { title: 'Promo <x>', color: '#123456' },
  );
  assert.ok(html.includes('src="https://d/dl/1"'));
  assert.ok(html.includes('href="https://d/1"'));
  assert.ok(html.includes('#123456'));
  assert.ok(html.includes('Promo &lt;x&gt;') && !html.includes('Promo <x>'));
  assert.ok(html.includes('TikTok')); // platform label from PLATFORM_SPECS
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ralph/media-deliver.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `ralph/media-deliver.mjs`:

```js
// ralph/media-deliver.mjs
// Pure logic for the automatic social-video -> Google Drive delivery: which
// files to upload, how to parse the delivery sentinel, the DELIVERABLE.md
// body, and the Drive-link gallery that replaces the local-file gallery after
// the local media is deleted. Fs/tmux/sudo live in ralph-media-deliver.sh and
// the orchestrator — this module is deterministic and unit-tested.
import { PLATFORM_SPECS, platformForFile } from './social-formats.mjs';

export function mediaShareList(names, project) {
  if (!Array.isArray(names)) return [];
  const out = [];
  for (const n of names) {
    const platform = platformForFile(String(n));
    if (!platform) continue;
    out.push({ file: `output/${n}`, driveName: `${project}-${platform}.mp4`, platform });
  }
  return out;
}

export function parseMediaDeliverResult(raw) {
  if (!raw || !String(raw).trim()) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (j && typeof j.error === 'string') return { error: j.error.slice(0, 300) };
  if (!j || !Array.isArray(j.files)) return { error: 'malformed delivery result' };
  const files = j.files
    .filter((f) => f && typeof f === 'object' && f.shareLink)
    .map((f) => ({
      name: String(f.name || ''), platform: String(f.platform || ''),
      shareLink: String(f.shareLink), directDownload: String(f.directDownload || f.shareLink),
      qr: String(f.qr || ''), size: Number(f.size) || 0,
    }));
  return { files };
}

export function mediaDeliverableMarkdown({ project, previewUrl, files }) {
  const lines = [
    `# ${project} — deliverable`,
    '',
    previewUrl ? `Preview gallery: ${previewUrl}` : '',
    '',
    '## Video renders (Google Drive)',
    '',
    ...files.map((f) => `- **${f.platform}** — [${f.name}](${f.shareLink})${f.qr ? ` · [QR](${f.qr})` : ''}`),
    '',
    '_Local copies were removed after upload; Drive is the copy of record._',
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function galleryDriveHtml(files, { title = 'Story video', color = '#3b82f6' } = {}) {
  const cards = files.map((f) => {
    const s = PLATFORM_SPECS[f.platform];
    const label = s ? s.label : f.platform;
    return `  <figure>\n    <video controls preload="none" src="${esc(f.directDownload)}"></video>\n`
      + `    <figcaption>${esc(label)} · <a href="${esc(f.shareLink)}" target="_blank" rel="noopener">Open in Drive ↗</a>`
      + `${f.qr ? ` · <a href="${esc(f.qr)}" target="_blank" rel="noopener">QR</a>` : ''}</figcaption>\n  </figure>`;
  }).join('\n');
  return `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n`
    + `<title>${esc(title)}</title>\n<style>\n`
    + `body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem}\n`
    + `h1{border-bottom:3px solid ${esc(color)};padding-bottom:.5rem}\n`
    + `main{display:flex;flex-wrap:wrap;gap:1.5rem}\nfigure{margin:0;max-width:300px}\n`
    + `video{width:100%;border-radius:8px;background:#000}\nfigcaption{font-size:.85rem;margin-top:.4rem}\n`
    + `a{color:${esc(color)}}\n</style>\n<h1>${esc(title)}</h1>\n<main>\n${cards}\n</main>\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ralph/media-deliver.test.mjs` — Expected: 4/4 PASS. Then `node --test ralph/*.test.mjs` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add ralph/media-deliver.mjs ralph/media-deliver.test.mjs
git commit -m "feat(ralph): media-deliver pure logic — share list, sentinel parse, deliverable md, Drive gallery"
```

---

### Task 2: deliver script + wrapper allowlist (host + template)

**Files:**
- Create: `ralph/ralph-media-deliver.sh`
- Modify: `docs/ops/webtmux-artifact-share.sh` (allowlist regex, line ~21)
- Host install: `/usr/local/sbin/webtmux-artifact-share` (root; verify-then-install)

**Interfaces:**
- Consumes: `sudo -n /usr/local/sbin/webtmux-artifact-share <file> <driveName>` → stdout JSON `{fileId, name, size, shareLink, directDownload, qr}` or `{"error":...}`.
- Produces: sentinel `.ralph/media-deliver.json` — `{files:[{name,platform,shareLink,directDownload,qr,size}]}` on success (even partial: files that uploaded), `{"error":"..."}` on total failure. Task 3's reap consumes it via `parseMediaDeliverResult`.

- [ ] **Step 1: Extend the wrapper template allowlist**

In `docs/ops/webtmux-artifact-share.sh` line ~21, change the regex:

```bash
[[ "$name" =~ ^[A-Za-z0-9._-]+\.(exe|msi|apk|aab|appx|msix|mp4|mp3|wav|png|jpg|jpeg|webp|zip)$ ]] || { echo '{"error":"bad output name"}'; exit 1; }
```

- [ ] **Step 2: Install to the host (verify first)**

```bash
# the host copy must still match the PRE-edit template (byte-identical install model)
git show HEAD:docs/ops/webtmux-artifact-share.sh > /tmp/was-old.sh
diff /tmp/was-old.sh /usr/local/sbin/webtmux-artifact-share && \
  install -m 0755 docs/ops/webtmux-artifact-share.sh /usr/local/sbin/webtmux-artifact-share
diff docs/ops/webtmux-artifact-share.sh /usr/local/sbin/webtmux-artifact-share && echo HOST-SYNCED
```
Expected: both diffs empty, `HOST-SYNCED`. If the first diff is NOT empty, STOP and report BLOCKED (host copy has drifted from the template — do not clobber).

- [ ] **Step 3: Write the deliver script**

Create `ralph/ralph-media-deliver.sh`:

```bash
#!/usr/bin/env bash
# Upload a finished social-video build's platform renders to Google Drive via
# the privileged webtmux-artifact-share wrapper, then write ONE sentinel JSON
# the orchestrator tick reaps. ALWAYS writes the sentinel (emit/fail) so the
# tick can never hang on us. --stub (RALPH_FORCE_TOOL) fakes links, no uploads.
# Usage: ralph-media-deliver.sh --dir <run.dir> --project <slug> --out <sentinel> [--stub]
set -u
DIR="" PROJECT="" OUT="" STUB=0
while [ $# -gt 0 ]; do case "$1" in
  --dir) DIR="$2"; shift 2;; --project) PROJECT="$2"; shift 2;;
  --out) OUT="$2"; shift 2;; --stub) STUB=1; shift;;
  *) shift;;
esac; done
emit() { printf '%s\n' "$1" > "$OUT" 2>/dev/null || true; exit 0; }
fail() { printf '{"error":"%s"}\n' "$1" > "$OUT" 2>/dev/null || true; exit 0; }
[ -n "$DIR" ] && [ -n "$PROJECT" ] && [ -n "$OUT" ] || fail "bad args"
cd "$DIR" 2>/dev/null || fail "bad dir"

FILES=$(ls output/*.mp4 2>/dev/null | head -12) || true
[ -n "$FILES" ] || fail "no output renders found"

json_items=""
for f in $FILES; do
  base=$(basename "$f")
  # platform = the -<id>.mp4 suffix; skip files that don't match the contract
  plat="${base##*-}"; plat="${plat%.mp4}"
  case "$base" in *-"$plat".mp4) ;; *) continue;; esac
  name="${PROJECT}-${plat}.mp4"
  if [ "$STUB" = 1 ]; then
    item="{\"name\":\"$name\",\"platform\":\"$plat\",\"shareLink\":\"https://drive.example/stub/$name\",\"directDownload\":\"https://drive.example/dl/$name\",\"qr\":\"https://drive.example/qr/$name\",\"size\":1024}"
  else
    OUTJSON="$(sudo -n /usr/local/sbin/webtmux-artifact-share "$(readlink -f "$f")" "$name" 2>/dev/null)" || OUTJSON=""
    case "$OUTJSON" in
      *shareLink*)
        item=$(printf '%s' "$OUTJSON" | tr -d '\n')
        # inject the platform key the orchestrator groups by
        item="${item%\}},\"platform\":\"$plat\"}"
        ;;
      *) continue;;
    esac
  fi
  [ -n "$json_items" ] && json_items="$json_items,"
  json_items="$json_items$item"
done

[ -n "$json_items" ] || fail "all uploads failed (is webtmux-artifact-share installed with media extensions?)"
emit "{\"files\":[$json_items]}"
```

- [ ] **Step 4: Verify the script logic without spend**

```bash
bash -n ralph/ralph-media-deliver.sh
T=$(mktemp -d); mkdir -p "$T/output"; : > "$T/output/story-tiktok.mp4"; : > "$T/output/story-youtube.mp4"; : > "$T/output/junk.txt"
bash ralph/ralph-media-deliver.sh --dir "$T" --project demo --out "$T/s.json" --stub
cat "$T/s.json"
node -e "import('./ralph/media-deliver.mjs').then(m => { const r = m.parseMediaDeliverResult(require('fs').readFileSync('$T/s.json','utf8')); if (!r.files || r.files.length !== 2 || r.files[0].platform !== 'tiktok') throw new Error('bad: '+JSON.stringify(r)); console.log('stub sentinel parses OK'); })"
rm -rf "$T"
```
Expected: sentinel has 2 stub files; `stub sentinel parses OK`.

- [ ] **Step 5: Commit**

```bash
git add ralph/ralph-media-deliver.sh docs/ops/webtmux-artifact-share.sh
git commit -m "feat(ralph): media deliver script (stub-aware, always-emit) + artifact-share media extensions"
```

---

### Task 3: orchestrator — spawn at finish, `media-delivering` phase, delete-after-upload

**Files:**
- Modify: `server/ralph-engine.mjs` (finalize-PASS branch ~line 1360; new spawn fn next to `spawnWindowsDelivery` ~723; new reap branch next to `phase === 'delivering'` ~1389; `runSummary` ~336; stall const ~80; gitignore scaffold in `startRalphRun`)
- Modify: `ralph/skills/social-video/SKILL.md` (commit rule)

**Interfaces:**
- Consumes: Task 1's `mediaShareList` (unused server-side — the script builds its own list; do NOT import it), `parseMediaDeliverResult`, `mediaDeliverableMarkdown`, `galleryDriveHtml` from `../ralph/media-deliver.mjs`; existing `launchRalphSession`, `ralphSessionName`, `gitCommitAll`, `gitPushRef`, `recordRunEvent`, `previewUrlFor`, `persistRun`.
- Produces: `run.mediaShare = { files:[...], at } | { error, at }`; phase flow `finalizing → media-delivering → done` (social-video with outputs only); `runSummary.mediaShare`.

- [ ] **Step 1: Stall const + spawn function**

Next to `WINDOWS_DELIVER_STALL_MS` (~line 80):

```js
const MEDIA_DELIVER_STALL_MS = Number(process.env.WEBTMUX_MEDIA_DELIVER_STALL_MS || 10 * 60 * 1000);
```

Next to `spawnWindowsDelivery` (~line 723), same shape (no tenant prefix — it sudos as the app user):

```js
// Social-video: upload platform renders to Drive from a spawned session (slow
// work never runs inline in the tick), sentinel-reaped below. Auto-invoked at
// finalize PASS; failure keeps local files and never fails the build.
async function spawnMediaDelivery(run) {
  const out = path.join(run.dir, '.ralph', 'media-deliver.json');
  await fs.rm(out, { force: true }).catch(() => {});
  const script = path.join(RALPH_DIR, 'ralph-media-deliver.sh');
  const stub = process.env.RALPH_FORCE_TOOL ? ' --stub' : '';
  const session = ralphSessionName(run.project, 'mediadeliver', 'rd');
  const cmd = `bash ${script} --dir ${run.dir} --project ${run.project} --out ${out}${stub}; exit`;
  await launchRalphSession(session, run.dir, cmd, []);
  run.mediaDeliverSince = Date.now();
  run.phase = 'media-delivering';
  recordRunEvent(run, '📤 uploading video renders to Google Drive…');
}
```

(Match the surrounding file's actual `launchRalphSession`/session-name helper signatures — read `spawnWindowsDelivery` first and mirror it exactly; if it passes cred lines or uses a different arg order, follow it.)

- [ ] **Step 2: Hook into the finalize-PASS branch**

In the `phase === 'finalizing'` PASS branch (currently: `ensureReadme` → `gitPushRef` → `checkPwaCompliance` → `checkMediaOutputs` → `run.phase = 'done'`), replace the unconditional `run.phase = 'done'` with:

```js
            await checkMediaOutputs(run).catch(() => {});
            const hasRenders = run.outputFormat === 'social-video'
              && Array.isArray(run.mediaReport?.outputs) && run.mediaReport.outputs.length > 0;
            if (hasRenders) {
              await spawnMediaDelivery(run).catch(() => { run.phase = 'done'; });
            } else {
              run.phase = 'done';
            }
```

Keep the existing `recordRunEvent('🎉 build finished …')` where phase becomes `done` — move it into the `else`, and let the reap branch emit its own 🎉 when delivery concludes (see Step 3) so the user still gets exactly one finish event.

- [ ] **Step 3: Reap branch**

Next to the `phase === 'delivering'` reap (~line 1389), add:

```js
      if (run.phase === 'media-delivering') {
        const out = path.join(run.dir, '.ralph', 'media-deliver.json');
        const raw = await fs.readFile(out, 'utf8').catch(() => '');
        const info = parseMediaDeliverResult(raw);
        const stalled = Date.now() - (run.mediaDeliverSince || 0) > MEDIA_DELIVER_STALL_MS;
        if (!info && !stalled) continue;
        if (info && Array.isArray(info.files) && info.files.length) {
          run.mediaShare = { files: info.files, at: Date.now() };
          const md = mediaDeliverableMarkdown({ project: run.project, previewUrl: previewUrlFor(run), files: info.files });
          await fs.writeFile(path.join(run.dir, 'DELIVERABLE.md'), md).catch(() => {});
          await fs.writeFile(path.join(run.dir, 'index.html'),
            galleryDriveHtml(info.files, { title: run.project, color: '#3b82f6' })).catch(() => {});
          // no-local-copies: Drive is now the copy of record
          for (const d of ['output', 'scenes', 'audio']) {
            await fs.rm(path.join(run.dir, d), { recursive: true, force: true }).catch(() => {});
          }
          await gitCommitAll(run.dir, 'docs: record Drive links; remove local media (Drive is the copy of record)').catch(() => {});
          await gitPushRef(run, 'main').catch(() => {});
          recordRunEvent(run, `🎉 build finished — ${info.files.length} render(s) on Drive · ${info.files[0].shareLink}`);
        } else {
          run.mediaShare = { error: (info && info.error) || 'Drive upload timed out', at: Date.now() };
          recordRunEvent(run, `⚠️ Drive upload: ${run.mediaShare.error} — local files kept, preview still live`);
        }
        run.phase = 'done';
        changed = true;
        continue;
      }
```

Import at the top of the file: `parseMediaDeliverResult, mediaDeliverableMarkdown, galleryDriveHtml` from `'../ralph/media-deliver.mjs'`.

- [ ] **Step 4: runSummary + scaffold gitignore + SKILL rule**

`runSummary` (next to `mediaReport`): add

```js
    mediaShare: run.mediaShare || null, // social-video: Drive links after auto-upload
```

In `startRalphRun`, right after the repo scaffold/gitignore setup, add (format-gated):

```js
  if (outputFormat === 'social-video') {
    await fs.appendFile(path.join(dir, '.gitignore'),
      '\n# media binaries ship to Google Drive at finish — never committed\noutput/\nscenes/\naudio/\n').catch(() => {});
  }
```

(Locate the actual scaffold point by reading `startRalphRun` — it calls `gitInitProject`; append AFTER that and BEFORE the initial commit so the ignore lands in the scaffold commit.)

In `ralph/skills/social-video/SKILL.md`, replace the rule line `- Commit generated assets and outputs (they are the deliverable).` with:

```markdown
- Do NOT commit the media binaries (`output/`, `scenes/`, `audio/` are gitignored) — the
  finished renders upload to Google Drive automatically when the build completes. DO commit
  `storyboard.json`, `DELIVERABLE.md`, and `index.html`.
```

- [ ] **Step 5: Verify**

```bash
node --check server.js server/*.mjs server/routes/*.mjs ralph/media-deliver.mjs
node --test ralph/*.test.mjs
systemctl restart webtmux && sleep 2 && journalctl -u webtmux -n 8 --no-pager
```
Expected: clean boot, "ralph: resumed N in-progress run(s)".

- [ ] **Step 6: Commit**

```bash
git add server/ralph-engine.mjs ralph/skills/social-video/SKILL.md
git commit -m "feat(ralph): auto Drive delivery for social-video — media-delivering phase, delete-after-upload, gitignored media"
```

---

### Task 4: UI — Drive links in both frontends

**Files:**
- Modify: `web/src/pages/BuildDetail.jsx` (Media outputs card)
- Modify: `public/js/dashboard/ralph.js` (status dialog line)
- Modify: `public/sw.js` (VERSION v47 → v48)

**Interfaces:** consumes `runSummary.mediaShare` (`{files:[{name,platform,shareLink,qr}], at}` or `{error, at}`).

- [ ] **Step 1: BuildDetail card**

In the existing "Media outputs" card (gated on `run.mediaReport`), extend the header row and table:

After the `Preview gallery ↗` link, add:

```jsx
        {run.mediaShare?.files?.length > 0 && (
          <span className="text-xs text-muted">· on Drive ✓</span>
        )}
```

Below the existing table (inside the card), add:

```jsx
      {run.mediaShare?.files?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {run.mediaShare.files.map((f) => (
            <a key={f.name} className="btn-ghost text-xs" href={f.shareLink} target="_blank" rel="noreferrer">
              📤 {f.platform} on Drive ↗
            </a>
          ))}
        </div>
      )}
      {run.mediaShare?.error && (
        <p className="mt-2 text-xs text-amber-600">⚠ Drive upload: {run.mediaShare.error} (local files kept)</p>
      )}
```

Also render the card when `run.mediaShare` exists even if `mediaReport` is missing: change the card's gate from `{run.mediaReport && (` to `{(run.mediaReport || run.mediaShare) && (` and guard the table with `{run.mediaReport && (<table …/>)}`.

- [ ] **Step 2: PWA status line**

In `public/js/dashboard/ralph.js`, next to `mediaReportHtml`, add:

```js
  const mediaShareHtml = s.mediaShare
    ? (s.mediaShare.files && s.mediaShare.files.length
      ? `📤 On Drive: ${s.mediaShare.files.map((f) => `<a class="b" href="${esc(f.shareLink)}" target="_blank" rel="noopener">${esc(f.platform)} ↗</a>`).join(' · ')}`
      : `<span class="ralph-story-err">⚠️ Drive upload: ${esc(s.mediaShare.error || 'failed')} (local files kept)</span>`)
    : '';
```

and add `mediaShareHtml` to the `lines` array right after `mediaReportHtml`. Bump `public/sw.js` VERSION to `webtmux-v48`.

- [ ] **Step 3: Verify + commit**

```bash
node --check public/js/dashboard.js public/js/dashboard/*.js
cd web && npm run build && cd ..
git add web/src/pages/BuildDetail.jsx public/js/dashboard/ralph.js public/sw.js
git commit -m "feat(ui): Drive links for media outputs in web + PWA; sw v48"
```

---

### Task 5: stub e2e + docs

**Files:**
- Modify: `docs/ops/social-video-stub-e2e.sh` (assert mediaShare)
- Modify: `CLAUDE.md` (media section paragraph)

- [ ] **Step 1: Extend the e2e assertions**

In `docs/ops/social-video-stub-e2e.sh`, the stubbed orchestrator phase asserts on the status JSON. The stub worker writes no real renders, so `mediaReport.outputs` is empty and delivery does NOT spawn — assert that contract (phase done, mediaShare null), and add a direct script-level stub check:

After the existing final assertions, add:

```bash
# delivery contract: no renders in stub build -> no media-delivering phase, mediaShare stays null
echo "$j" | grep -q '"mediaShare":null' || { echo "FAIL: expected mediaShare null on renderless stub build"; exit 1; }
# the deliver script itself, stubbed, emits a parseable sentinel
T=$(mktemp -d); mkdir -p "$T/output"; : > "$T/output/x-tiktok.mp4"
bash "$ROOT/ralph/ralph-media-deliver.sh" --dir "$T" --project e2e --out "$T/s.json" --stub
grep -q '"platform":"tiktok"' "$T/s.json" || { echo "FAIL: stub deliver sentinel"; exit 1; }
rm -rf "$T"
echo "media delivery stub OK"
```

(Use the script's existing variable for the repo root if it differs from `$ROOT` — read the script first.)

Run: `bash docs/ops/social-video-stub-e2e.sh` — Expected: `media delivery stub OK` + `PASS social-video stub e2e`, no leftovers (`ss -tlnp | grep 812` empty afterward).

- [ ] **Step 2: CLAUDE.md paragraph**

In the media-generation section (after the social-video/compose paragraph), add:

```markdown
**Drive delivery (social-video).** A finished social-video build auto-uploads its platform
renders to Google Drive: finalize PASS → `spawnMediaDelivery` (`ralph/ralph-media-deliver.sh`
in a tmux session; NEVER inline in the tick) → each render via
`sudo webtmux-artifact-share` (allowlist now includes media extensions — host + template must
stay byte-identical) → tick reaps `.ralph/media-deliver.json` (`media-delivering` phase,
10m stall) → `run.mediaShare` + DELIVERABLE.md + the root gallery rewritten to Drive links
(pure logic `ralph/media-deliver.mjs`, tested) → **local `output/`/`scenes/`/`audio/` deleted**
(they are gitignored at scaffold for social-video — Drive is the copy of record). Failure is
advisory: local files kept, phase still `done`. Stub: `--stub` via `RALPH_FORCE_TOOL`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ops/social-video-stub-e2e.sh CLAUDE.md
git commit -m "test+docs: Drive media delivery stub assertions + CLAUDE.md"
```

---

## Self-review notes

- Spec coverage: auto at finish (T3 hook), no local copies (T3 delete + gitignore + SKILL rule), wrapper reuse + allowlist (T2), sentinel/spawn pattern with stall (T3), links in DELIVERABLE + both UIs (T3/T4), fail-soft everywhere, stub path (T2/T5).
- Known tradeoff (user-approved direction): the preview gallery's inline `<video>` now streams from Drive `directDownload` URLs — Drive may interstitial very large files; the per-card "Open in Drive ↗" link is the guaranteed path.
- Existing already-finished builds are untouched (delivery only triggers on new finalize-PASS flows).
- The wrapper's host-drift guard (T2 Step 2) BLOCKS rather than clobbers if the installed copy doesn't match the committed template.
