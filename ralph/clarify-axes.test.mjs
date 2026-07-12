import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clarifyAxesFor } from './clarify-axes.mjs';

test('web-app is content-heavy with cap 6 and brand axes', () => {
  const r = clarifyAxesFor('web-app');
  assert.equal(r.cap, 6);
  assert.equal(r.contentHeavy, true);
  assert.ok(r.axes.some((a) => /brand/i.test(a)));
  assert.ok(r.axes.some((a) => /audience/i.test(a)));
});
test('flutter-app is content-heavy, cap 6, with brand + backend/Firebase axes', () => {
  const r = clarifyAxesFor('flutter-app');
  assert.equal(r.cap, 6);
  assert.equal(r.contentHeavy, true);
  assert.ok(r.axes.some((a) => /brand/i.test(a)));
  assert.ok(r.axes.some((a) => /firebase|backend|push|accounts/i.test(a)));
});
test('docx and slides are content-heavy', () => {
  assert.equal(clarifyAxesFor('docx').contentHeavy, true);
  assert.equal(clarifyAxesFor('google-slides').contentHeavy, true);
});
test('sheets are structured but not content-heavy, cap 4', () => {
  const r = clarifyAxesFor('xlsx');
  assert.equal(r.cap, 4);
  assert.equal(r.contentHeavy, false);
});
test('auto and unknown fall back to technical axes, cap 4', () => {
  for (const f of ['auto', 'downloadable', 'zzz', '', undefined]) {
    const r = clarifyAxesFor(f);
    assert.equal(r.cap, 4);
    assert.equal(r.contentHeavy, false);
    assert.ok(r.axes.some((a) => /stack/i.test(a)));
  }
});
test('social-video is content-heavy with platform + audio axes', () => {
  const { axes, cap, contentHeavy } = clarifyAxesFor('social-video');
  assert.equal(cap, 6);
  assert.equal(contentHeavy, true);
  assert.ok(axes.some((a) => a.includes('platform')));
  assert.ok(axes.some((a) => a.includes('voiceover')));
});
