#!/usr/bin/env node
// Fetch REAL data into the repo via Apify — for agents that need real content, not lorem ipsum.
// Two modes (both count against the per-build data budget):
//   run a store actor:      node fetch-data.mjs --actor apify/google-maps-scraper --input '<json>' [--max-items N] [--out data/x.json]
//   deploy a custom scraper: node fetch-data.mjs --create my-scraper --source scrapers/main.js --input '<json>' [...]
// create-mode authors a PRIVATE actor on the user's Apify account from the given main.js
// (Actor.init/getInput/pushData/exit; apify + crawlee available), builds it on the platform,
// then runs it the same way. Prefer store actors — only create when none fits.
// Exit: 0 wrote dataset (prints path + count) | 2 error | 3 skipped (disabled/cap/no key).
import { parseFetchDataArgs, runSyncUrl, actorScaffoldFiles, createActorPayload } from './research.mjs';
import { readCounts, bumpCount, writeBinary } from './media-runtime.mjs';
import { promises as fs } from 'node:fs';

const args = parseFetchDataArgs(process.argv.slice(2));
if (args.error) { console.error(`[fetch-data] ${args.error}`); process.exit(2); }

const dir = process.env.RALPH_MEDIA_COUNT_DIR || process.cwd();
const enabled = process.env.RALPH_DATA !== '0';
const cap = Number(process.env.RALPH_DATA_CAP || 2);
const counts = await readCounts(dir);
if (!enabled) { console.log('[fetch-data] skipped: data fetching is disabled for this build. Use realistic hand-written seed data instead.'); process.exit(3); }
if ((counts.data || 0) >= cap) { console.log(`[fetch-data] skipped: data budget reached (${counts.data}/${cap}). Reuse the datasets already in data/.`); process.exit(3); }

// No-spend stub harness: deterministic fixture rows.
if (process.env.RALPH_FORCE_TOOL) {
  const items = [1, 2, 3].map((i) => ({ id: i, title: `stub item ${i}`, source: args.actor || args.name }));
  await writeBinary(Buffer.from(JSON.stringify(items, null, 2) + '\n'), args.out);
  await bumpCount(dir, 'data');
  console.log(`${args.out} (${items.length} items, stub)`); process.exit(0);
}

const token = process.env.RALPH_DATA_KEY;
if (!token) { console.log('[fetch-data] skipped: no Apify key connected — use realistic hand-written seed data instead.'); process.exit(3); }
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
};

try {
  let actorId = args.actor;

  if (args.mode === 'create') {
    const mainJs = await fs.readFile(args.source, 'utf8');
    const files = actorScaffoldFiles({ name: args.name, mainJs });
    // Create the private actor; if the name already exists on this account, reuse it and
    // push the new source as version 0.0 (agents iterate on their scraper this way).
    const created = await api('POST', 'https://api.apify.com/v2/acts', createActorPayload(args.name, files));
    if (created.ok) actorId = created.data?.data?.id;
    else if (created.data?.error?.type === 'actor-name-not-unique') {
      const mine = await api('GET', 'https://api.apify.com/v2/acts?my=1&limit=1000');
      const hit = (mine.data?.data?.items || []).find((x) => x.name === args.name);
      if (!hit) { console.error('[fetch-data] actor name taken but not found in your account'); process.exit(2); }
      actorId = hit.id;
      const put = await api('PUT', `https://api.apify.com/v2/acts/${actorId}/versions/0.0`,
        { versionNumber: '0.0', sourceType: 'SOURCE_FILES', buildTag: 'latest', sourceFiles: files });
      if (!put.ok) { console.error(`[fetch-data] version update ${put.status}: ${JSON.stringify(put.data).slice(0, 200)}`); process.exit(2); }
    } else { console.error(`[fetch-data] create ${created.status}: ${JSON.stringify(created.data).slice(0, 200)}`); process.exit(2); }

    // Build 0.0 on the platform and wait for it (poll; ~5 min cap).
    const build = await api('POST', `https://api.apify.com/v2/acts/${actorId}/builds?version=0.0&tag=latest&waitForFinish=60`);
    if (!build.ok) { console.error(`[fetch-data] build start ${build.status}: ${JSON.stringify(build.data).slice(0, 200)}`); process.exit(2); }
    let st = build.data?.data;
    for (let i = 0; i < 5 && st && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(st.status); i++) {
      const poll = await api('GET', `https://api.apify.com/v2/actor-builds/${st.id}?waitForFinish=60`);
      st = poll.data?.data || st;
    }
    if (st?.status !== 'SUCCEEDED') { console.error(`[fetch-data] actor build ${st?.status || 'unknown'} — check main.js (build log: https://console.apify.com/actors/${actorId})`); process.exit(2); }
    console.error(`[fetch-data] built private actor ${args.name} (${actorId})`);
  }

  // Run synchronously and collect the dataset in one call.
  const run = await fetch(runSyncUrl(actorId, { maxItems: args.maxItems }), {
    method: 'POST', headers: H, body: JSON.stringify(args.input),
  });
  const text = await run.text();
  if (!run.ok) { console.error(`[fetch-data] run ${run.status}: ${text.slice(0, 300)}`); process.exit(2); }
  let items; try { items = JSON.parse(text); } catch { console.error('[fetch-data] non-JSON dataset response'); process.exit(2); }
  if (!Array.isArray(items)) items = [items];
  await writeBinary(Buffer.from(JSON.stringify(items, null, 2) + '\n'), args.out);
  await bumpCount(dir, 'data');
  console.log(`${args.out} (${items.length} items from ${args.actor || args.name})`);
} catch (e) { console.error(`[fetch-data] ${e.message}`); process.exit(2); }
