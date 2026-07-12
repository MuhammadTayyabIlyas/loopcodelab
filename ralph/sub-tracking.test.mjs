import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrackingEntry, trackingDaysLeft, validTrackingProvider } from './sub-tracking.mjs';

test('normalizeTrackingEntry: keeps valid fields, caps lengths', () => {
  const e = normalizeTrackingEntry({
    startDate: '2026-07-01', endDate: '2026-08-01', peakHours: '00:00–08:00 UTC (off-peak 50%)',
    usage: '~40% of monthly quota', notes: 'renews monthly; consider yearly', link: 'https://platform.moonshot.ai/console',
  });
  assert.equal(e.startDate, '2026-07-01');
  assert.equal(e.endDate, '2026-08-01');
  assert.match(e.peakHours, /off-peak/);
  assert.equal(e.link, 'https://platform.moonshot.ai/console');
  assert.equal(normalizeTrackingEntry({ notes: 'n'.repeat(5000) }).notes.length, 2000);
});

test('normalizeTrackingEntry: rejects bad dates and non-http links', () => {
  const e = normalizeTrackingEntry({ startDate: 'tomorrow', endDate: '01/08/2026', link: 'javascript:alert(1)' });
  assert.equal(e, null); // nothing valid left -> null (delete semantics)
  const e2 = normalizeTrackingEntry({ startDate: '2026-13-40', usage: 'ok' });
  assert.equal(e2.startDate, '');   // impossible date dropped
  assert.equal(e2.usage, 'ok');
});

test('normalizeTrackingEntry: all-empty -> null (used to clear an entry)', () => {
  assert.equal(normalizeTrackingEntry({}), null);
  assert.equal(normalizeTrackingEntry({ startDate: '', notes: '  ' }), null);
  assert.equal(normalizeTrackingEntry(null), null);
});

test('trackingDaysLeft: whole days until the end date (inclusive-ish), null without one', () => {
  const now = Date.parse('2026-07-02T12:00:00Z');
  assert.equal(trackingDaysLeft('2026-07-03', now), 1);
  assert.equal(trackingDaysLeft('2026-08-01', now), 30);
  assert.equal(trackingDaysLeft('2026-07-01', now), -1);  // already ended
  assert.equal(trackingDaysLeft('', now), null);
  assert.equal(trackingDaysLeft('nope', now), null);
});

test('validTrackingProvider: provider ids only', () => {
  assert.equal(validTrackingProvider('kimi'), true);
  assert.equal(validTrackingProvider('claude-plan'), true);
  assert.equal(validTrackingProvider('windows-store'), true);
  assert.equal(validTrackingProvider('../etc'), false);
  assert.equal(validTrackingProvider(''), false);
  assert.equal(validTrackingProvider('x'.repeat(50)), false);
});
