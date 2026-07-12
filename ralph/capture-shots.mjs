// Capture store screenshots of a Flutter app by driving its release web build with headless
// Chromium at each store device viewport (the method proven on apkipa). Runs as the app user
// in the delivery pass; best-effort — always exits 0 so it never blocks delivery. Writes PNGs
// into <out> (default store-assets/) + a .shots.json manifest of what it produced.
//
// Usage: node capture-shots.mjs --dir <runDir> [--web build/web] [--out store-assets] [--stub]
import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEVICE_SHOTS, parseShotManifest, shotFileName } from './screenshots.mjs';
import { FEATURE_GRAPHIC, normalizeSpec, featureGraphicHtml } from './feature-graphic.mjs';

// Resolve an icon to a base64 data URI for the feature graphic: the spec's icon first, then
// the user's brand logo, then the Flutter web icons. Returns null if none found.
async function resolveIconDataUri(specIcon, webRoot, dir) {
  const candidates = [];
  if (specIcon) candidates.push(path.resolve(dir, specIcon));
  try { const brand = path.join(dir, 'assets', 'brand');
    for (const f of (await fs.readdir(brand)).sort()) if (/\.(png|jpe?g|webp)$/i.test(f)) { candidates.push(path.join(brand, f)); break; }
  } catch { /* no brand dir */ }
  candidates.push(path.join(webRoot, 'icons', 'Icon-512.png'), path.join(webRoot, 'icons', 'Icon-192.png'), path.join(webRoot, 'favicon.png'));
  for (const c of candidates) {
    try {
      const buf = await fs.readFile(c);
      const ext = path.extname(c).slice(1).toLowerCase();
      return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
    } catch { /* try next */ }
  }
  return null;
}

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/ms-playwright';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const dir = arg('--dir');
const webRel = arg('--web', 'build/web');
const outRel = arg('--out', 'store-assets');
const stub = process.argv.includes('--stub');

const log = (m) => console.log(`capture-shots: ${m}`);
if (!dir) { log('no --dir'); process.exit(0); }
const webRoot = path.resolve(dir, webRel);
const outDir = path.resolve(dir, outRel);

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  if (stub) { // no-spend harness: don't launch a browser
    await fs.writeFile(path.join(outDir, '.shots.json'), JSON.stringify({ stub: true, files: [] }));
    log('stub — skipped'); return;
  }
  if (!await fs.access(path.join(webRoot, 'index.html')).then(() => true).catch(() => false)) {
    log(`no web build at ${webRoot}`); return;
  }
  const manifest = parseShotManifest(await fs.readFile(path.join(dir, '.ralph', 'shots.json'), 'utf8').catch(() => null));

  // Minimal static server (SPA fallback) so Flutter web fetches canvaskit.wasm etc. over http.
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.symbol': 'application/octet-stream' };
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel.includes('..')) { res.writeHead(400).end(); return; }
      let file = path.join(webRoot, rel === '/' ? 'index.html' : rel);
      if (!await fs.access(file).then(() => true).catch(() => false)) file = path.join(webRoot, 'index.html'); // SPA fallback
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let browser;
  const { chromium } = await import('playwright-core');
  try {
    browser = await chromium.launch({ channel: 'chromium-headless-shell', args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
  } catch (e) { log(`browser launch failed: ${e.message}`); server.close(); return; }

  const files = [];
  for (const device of DEVICE_SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: device.w, height: device.h }, deviceScaleFactor: 1 });
    for (let i = 0; i < manifest.length; i++) {
      const shot = manifest[i];
      const page = await ctx.newPage();
      try {
        await page.goto(base + shot.path, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        // Flutter (CanvasKit) renders into flt-glass-pane/flutter-view; wait then settle.
        await page.waitForSelector('flt-glass-pane, flutter-view, canvas, #app, body', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3500);
        const name = shotFileName(device, shot, i);
        await page.screenshot({ path: path.join(outDir, name) });
        files.push(name);
      } catch (e) { log(`shot ${device.id}/${shot.name} failed: ${e.message}`); }
      finally { await page.close().catch(() => {}); }
    }
    await ctx.close().catch(() => {});
  }

  // Feature graphic (Play 1024×500) — a composed marketing banner, not a screenshot.
  try {
    const spec = normalizeSpec(await fs.readFile(path.join(dir, '.ralph', 'feature-graphic.json'), 'utf8').catch(() => null), { project: path.basename(dir) });
    const iconDataUri = await resolveIconDataUri(spec.icon, webRoot, dir);
    const ctx = await browser.newContext({ viewport: { width: FEATURE_GRAPHIC.w, height: FEATURE_GRAPHIC.h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(featureGraphicHtml({ ...spec, iconDataUri }), { waitUntil: 'load' });
    await page.waitForTimeout(400); // let the icon + fonts paint
    await page.screenshot({ path: path.join(outDir, FEATURE_GRAPHIC.file) });
    await ctx.close().catch(() => {});
    files.push(FEATURE_GRAPHIC.file);
    log(`feature graphic -> ${FEATURE_GRAPHIC.file}`);
  } catch (e) { log(`feature graphic failed: ${e.message}`); }

  await browser.close().catch(() => {});
  server.close();
  await fs.writeFile(path.join(outDir, '.shots.json'), JSON.stringify({ at: undefined, devices: DEVICE_SHOTS.map((d) => d.id), shots: manifest.map((s) => s.name), files }, null, 2));
  log(`captured ${files.length} screenshot(s) -> ${outRel}`);
}

main().catch((e) => log(`error: ${e.message}`)).finally(() => process.exit(0));
