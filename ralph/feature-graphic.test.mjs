import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_GRAPHIC, normalizeSpec, featureGraphicHtml } from './feature-graphic.mjs';

test('FEATURE_GRAPHIC is the Play 1024x500 spec', () => {
  assert.equal(FEATURE_GRAPHIC.w, 1024);
  assert.equal(FEATURE_GRAPHIC.h, 500);
  assert.equal(FEATURE_GRAPHIC.file, 'feature-1024x500.png');
});

test('normalizeSpec applies defaults + derives a name from the project', () => {
  const s = normalizeSpec(null, { project: 'snake-game' });
  assert.equal(s.name, 'Snake Game');
  assert.equal(s.bg, '#1e3a8a');
  assert.equal(s.accent, '#6d28d9');
  assert.equal(s.tagline, '');
  assert.equal(s.icon, null);
});

test('normalizeSpec honors valid fields + sanitizes bad colors / long text', () => {
  const s = normalizeSpec(JSON.stringify({ name: 'My App', tagline: 'x'.repeat(200), bg: '#fff', accent: 'red', icon: 'a/b.png' }), { project: 'p' });
  assert.equal(s.name, 'My App');
  assert.equal(s.tagline.length, 90);     // capped
  assert.equal(s.bg, '#fff');             // valid hex kept
  assert.equal(s.accent, '#6d28d9');      // 'red' rejected -> default
  assert.equal(s.icon, 'a/b.png');
});

test('normalizeSpec tolerates junk JSON', () => {
  assert.equal(normalizeSpec('not json', { project: 'foo-bar' }).name, 'Foo Bar');
});

test('featureGraphicHtml embeds name/tagline/gradient/icon and escapes HTML', () => {
  const html = featureGraphicHtml({ name: 'A & B', tagline: 'fast <fun>', bg: '#111111', accent: '#222222', iconDataUri: 'data:image/png;base64,XYZ' });
  assert.match(html, /1024px/);
  assert.match(html, /500px/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /fast &lt;fun&gt;/);
  assert.match(html, /#111111 0%, #222222 100%/);
  assert.match(html, /data:image\/png;base64,XYZ/);
});

test('featureGraphicHtml omits the tagline + icon when absent', () => {
  const html = featureGraphicHtml({ name: 'Solo', bg: '#111111', accent: '#222222' });
  assert.doesNotMatch(html, /<p>/);
  assert.doesNotMatch(html, /<img/);
});
