import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldGround, researchPrompt, parseSonar, groundingBlock, SONAR_MODEL, normalizeResearchBudget, workerResearchMessages, parseFetchDataArgs, runSyncUrl, actorScaffoldFiles, createActorPayload } from './research.mjs';

test('shouldGround: content-heavy formats always ground; auto only on external markers', () => {
  assert.equal(shouldGround('a todo list', 'web-app'), true);           // content format
  assert.equal(shouldGround('a slide deck about our team', 'google-slides'), true);
  assert.equal(shouldGround('a todo list', 'auto'), false);             // self-contained idea
  assert.equal(shouldGround('an app like Airbnb for boats', 'auto'), true);
  assert.equal(shouldGround('scrape https://example.com daily', 'auto'), true);
  assert.equal(shouldGround('compare competitor pricing pages', 'auto'), true);
  assert.equal(shouldGround('', 'web-app'), false);                     // no idea -> nothing to ground
});

test('researchPrompt: system+user messages, idea capped', () => {
  const msgs = researchPrompt('x'.repeat(5000), 'web-app');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /bullet/i);
  assert.ok(msgs[1].content.length < 2200);
  assert.match(msgs[1].content, /web-app/);
  assert.equal(typeof SONAR_MODEL, 'string');
});

test('parseSonar: content + deduped citations from both fields; junk-tolerant', () => {
  const r = parseSonar({
    choices: [{ message: { content: '- fact one\n- fact two' } }],
    citations: ['https://a.com/x', 'notaurl', 'https://b.com/y'],
    search_results: [{ title: 't', url: 'https://a.com/x' }, { url: 'https://c.com/z' }, null],
  });
  assert.equal(r.content, '- fact one\n- fact two');
  assert.deepEqual(r.citations, ['https://a.com/x', 'https://b.com/y', 'https://c.com/z']);
  assert.deepEqual(parseSonar(null), { content: '', citations: [] });
  assert.deepEqual(parseSonar({}), { content: '', citations: [] });
});

test('groundingBlock: caps content, numbers up to 8 sources, empty content -> empty string', () => {
  const b = groundingBlock('facts here', ['https://a.com', 'https://b.com']);
  assert.match(b, /facts here/);
  assert.match(b, /\[1\] https:\/\/a\.com/);
  assert.match(b, /\[2\] https:\/\/b\.com/);
  assert.equal(groundingBlock('', ['https://a.com']), '');
  assert.equal(groundingBlock('x'.repeat(9000), []).length, 4000);
  const many = groundingBlock('x', Array.from({ length: 12 }, (_, i) => `https://s${i}.com`));
  assert.match(many, /\[8\]/);
  assert.doesNotMatch(many, /\[9\]/);
});

// --- Phase C: worker helpers (budget, args, apify request shaping) -------------

test('normalizeResearchBudget: defaults + clamps; junk-safe', () => {
  const d = normalizeResearchBudget(null);
  assert.deepEqual(d, { research: { enabled: true, cap: 5 }, data: { enabled: true, cap: 2 } });
  const c = normalizeResearchBudget({ research: { enabled: false, cap: 99 }, data: { cap: -3 } });
  assert.equal(c.research.enabled, false);
  assert.equal(c.research.cap, 20);       // cap ceiling
  assert.equal(c.data.cap, 0);            // floor
  assert.equal(normalizeResearchBudget('junk').research.cap, 5);
});

test('workerResearchMessages: concise cited-answer prompt, question capped', () => {
  const m = workerResearchMessages('how do I paginate the Stripe API in 2026? ' + 'x'.repeat(3000));
  assert.equal(m.length, 2);
  assert.match(m[0].content, /cite|source/i);
  assert.ok(m[1].content.length < 2100);
});

test('parseFetchDataArgs: run mode', () => {
  const a = parseFetchDataArgs(['--actor', 'apify/google-maps-scraper', '--input', '{"query":"karachi boats"}', '--max-items', '50', '--out', 'data/boats.json']);
  assert.equal(a.error, undefined);
  assert.equal(a.mode, 'run');
  assert.equal(a.actor, 'apify/google-maps-scraper');
  assert.deepEqual(a.input, { query: 'karachi boats' });
  assert.equal(a.maxItems, 50);
  assert.equal(a.out, 'data/boats.json');
});

test('parseFetchDataArgs: create mode + defaults + validation errors', () => {
  const a = parseFetchDataArgs(['--create', 'my-scraper', '--source', 'scrapers/main.js', '--input', '{}']);
  assert.equal(a.mode, 'create');
  assert.equal(a.name, 'my-scraper');
  assert.equal(a.source, 'scrapers/main.js');
  assert.equal(a.maxItems, 100);                       // default
  assert.match(a.out, /^data\//);                      // default out dir
  assert.ok(parseFetchDataArgs([]).error);             // no actor/create
  assert.ok(parseFetchDataArgs(['--actor', 'x/y', '--input', 'not json']).error);
  assert.ok(parseFetchDataArgs(['--create', 'Bad Name!', '--source', 'm.js']).error); // actor name charset
  assert.ok(parseFetchDataArgs(['--actor', 'x/y', '--input', '{}', '--max-items', '99999']).maxItems <= 1000);
});

test('runSyncUrl: user/name -> user~name path, clean output, capped wait', () => {
  const u = runSyncUrl('apify/web-scraper', { maxItems: 25 });
  assert.match(u, /^https:\/\/api\.apify\.com\/v2\/acts\/apify~web-scraper\/run-sync-get-dataset-items\?/);
  assert.match(u, /clean=true/);
  assert.match(u, /maxItems=25/);
  assert.match(u, /timeout=\d+/);
  assert.match(runSyncUrl('K2mZlA9', {}), /acts\/K2mZlA9\//); // bare actor id untouched
});

test('actorScaffoldFiles + createActorPayload: private SOURCE_FILES actor, v0.0 latest', () => {
  const files = actorScaffoldFiles({ name: 'my-scraper', mainJs: 'console.log(1)' });
  const names = files.map((f) => f.name);
  assert.ok(names.includes('Dockerfile'));
  assert.ok(names.includes('package.json'));
  assert.ok(names.includes('main.js'));
  assert.ok(files.every((f) => f.format === 'TEXT' && typeof f.content === 'string'));
  const pkg = JSON.parse(files.find((f) => f.name === 'package.json').content);
  assert.ok(pkg.dependencies.apify);
  const p = createActorPayload('my-scraper', files);
  assert.equal(p.isPublic, false);                     // never publish agent actors
  assert.equal(p.versions[0].versionNumber, '0.0');
  assert.equal(p.versions[0].sourceType, 'SOURCE_FILES');
  assert.equal(p.versions[0].buildTag, 'latest');
  assert.equal(p.versions[0].sourceFiles, files);
});
