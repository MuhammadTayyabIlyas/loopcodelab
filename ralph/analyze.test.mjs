import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT_FAMILIES, familyOf, clampHistory, analyzePrompt,
  normalizeAnalysis, fallbackAnalysis, stubAnalysis,
} from './analyze.mjs';

test('familyOf: known ids pass through, junk/absent -> auto', () => {
  assert.equal(familyOf('video'), 'video');
  assert.equal(familyOf('sheet'), 'sheet');
  assert.equal(familyOf('nonsense'), 'auto');
  assert.equal(familyOf(''), 'auto');
  assert.equal(familyOf(undefined), 'auto');
  for (const fam of Object.values(FORMAT_FAMILIES)) {
    assert.ok(fam.formats.includes(fam.seed), `${fam.label}: seed must be in formats`);
  }
});

test('clampHistory: caps count and length, coerces roles, drops empties', () => {
  const long = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(600) }));
  const out = clampHistory(long);
  assert.equal(out.length, 8);
  assert.ok(out.every((m) => m.text.length === 500));
  assert.ok(out.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.deepEqual(clampHistory([{ role: 'user', text: '' }, { role: 'evil', text: 'hi' }]),
    [{ role: 'user', text: 'hi' }]);
  assert.deepEqual(clampHistory('junk'), []);
});

test('normalizeAnalysis: clamps format to the family, junk fields -> sane result', () => {
  const r = normalizeAnalysis(
    { outputFormat: 'web-app', name: 'X'.repeat(99), media: 'junk', platforms: 'junk', questions: 'junk', brief: 42 },
    { idea: 'a cat dance video', formatFamily: 'video' },
  );
  assert.equal(r.outputFormat, 'social-video'); // web-app not in video family -> seed
  assert.equal(r.fallback, false);
  assert.equal(r.formatFamily, 'video');
  assert.ok(r.name.length <= 32 && r.name.length > 0);
  assert.ok(r.media.image && typeof r.media.image.enabled === 'boolean');
  assert.ok(Array.isArray(r.platforms) && r.platforms.length > 0); // defaults kick in
  assert.deepEqual(r.questions, []);
  assert.equal(typeof r.brief, 'string');
});

test('normalizeAnalysis: social-video result has media enabled + doc family clamps within family', () => {
  const v = normalizeAnalysis({ outputFormat: 'social-video', media: { video: { enabled: false, cap: 1 } }, platforms: ['tiktok', 'bogus'] },
    { idea: 'mj moonwalk tribute', formatFamily: 'video' });
  assert.equal(v.media.video.enabled, true);  // withFormatMediaDefaults floor
  assert.ok(v.media.video.cap >= 2);
  assert.deepEqual(v.platforms, ['tiktok']);
  const d = normalizeAnalysis({ outputFormat: 'pdf' }, { idea: 'annual report', formatFamily: 'doc' });
  assert.equal(d.outputFormat, 'pdf');        // pdf IS in the doc family
  assert.equal(d.platforms, null);            // platforms only for social-video
});

test('normalizeAnalysis: questions capped by the format clarify cap, options sanitized', () => {
  const qs = Array.from({ length: 12 }, (_, i) => ({ q: `Q${i}?`, options: ['a', 'b', 1] }));
  const r = normalizeAnalysis({ outputFormat: 'social-video', questions: qs },
    { idea: 'x', formatFamily: 'video' });
  assert.ok(r.questions.length <= 6); // content-heavy cap
  assert.deepEqual(r.questions[0].options, ['a', 'b', '1']);
  const rs = normalizeAnalysis({ outputFormat: 'google-sheet', questions: qs },
    { idea: 'x', formatFamily: 'sheet' });
  assert.ok(rs.questions.length <= 4); // technical cap
});

test('fallbackAnalysis: deterministic, flagged, family seed, no questions', () => {
  const r = fallbackAnalysis('a cat dance video for tiktok', 'video');
  assert.equal(r.fallback, true);
  assert.equal(r.outputFormat, 'social-video');
  assert.ok(Array.isArray(r.platforms) && r.platforms.length > 0);
  assert.deepEqual(r.questions, []);
  assert.ok(r.name.length > 0 && r.name.length <= 32);
  const w = fallbackAnalysis('a landing page', 'web');
  assert.equal(w.outputFormat, 'web-app');
  assert.equal(w.platforms, null);
  assert.deepEqual(fallbackAnalysis('a landing page', 'web'), w); // deterministic
});

test('stubAnalysis: deterministic, NOT flagged as fallback, has a question', () => {
  const r = stubAnalysis('anything', 'web');
  assert.equal(r.fallback, false);
  assert.ok(r.note.includes('stub'));
  assert.ok(r.questions.length >= 1);
  assert.deepEqual(stubAnalysis('anything', 'web'), r);
});

test('analyzePrompt: messages carry idea, family constraint, grounding, history, current', () => {
  const msgs = analyzePrompt({
    idea: 'a cat dance video',
    formatFamily: 'video',
    history: [{ role: 'user', text: 'make it funnier' }],
    current: { outputFormat: 'social-video', name: 'cat-dance' },
    grounding: 'RESEARCH: cats are popular',
  });
  assert.ok(Array.isArray(msgs) && msgs.length === 2);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('JSON'));
  const u = msgs[1].content;
  assert.ok(u.includes('a cat dance video'));
  assert.ok(u.includes('social-video'));          // allowed formats listed
  assert.ok(u.includes('RESEARCH: cats are popular'));
  assert.ok(u.includes('make it funnier'));
  assert.ok(u.includes('cat-dance'));             // current config folded in
  const bare = analyzePrompt({ idea: 'x', formatFamily: 'auto' });
  assert.ok(!bare[1].content.includes('Current web research'));
});
