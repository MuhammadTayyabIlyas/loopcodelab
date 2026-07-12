import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_SHOTS, parseShotManifest, shotFileName, devicesForStore } from './screenshots.mjs';

test('DEVICE_SHOTS covers Play + iOS at store pixel sizes', () => {
  const ids = DEVICE_SHOTS.map((d) => d.id);
  assert.ok(ids.includes('phone') && ids.includes('iphone-6_5') && ids.includes('ipad-13'));
  const phone = DEVICE_SHOTS.find((d) => d.id === 'phone');
  assert.deepEqual([phone.w, phone.h], [1080, 1920]);
  assert.equal(devicesForStore('ios').length, 2);
  assert.equal(devicesForStore('play').length, 2);
});

test('parseShotManifest falls back to a home shot', () => {
  assert.deepEqual(parseShotManifest(null), [{ name: 'home', path: '/' }]);
  assert.deepEqual(parseShotManifest('not json'), [{ name: 'home', path: '/' }]);
  assert.deepEqual(parseShotManifest('{}'), [{ name: 'home', path: '/' }]);
  assert.deepEqual(parseShotManifest('[]'), [{ name: 'home', path: '/' }]);
});

test('parseShotManifest cleans names + paths and drops unsafe ones', () => {
  const r = parseShotManifest(JSON.stringify([
    { name: 'Sign In', path: '/login' },
    { name: 'Game!', route: 'play/now' },
    { name: 'evil', path: 'https://x.com/steal' }, // scheme -> home
    { name: 'up', path: '../../etc' },              // traversal -> home
  ]));
  assert.equal(r[0].name, 'sign-in');
  assert.equal(r[0].path, '/login');
  assert.equal(r[1].path, '/play/now');
  assert.equal(r[2].path, '/');
  assert.equal(r[3].path, '/');
});

test('parseShotManifest caps at 6', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, path: `/p${i}` }));
  assert.equal(parseShotManifest(JSON.stringify(many)).length, 6);
});

test('shotFileName mirrors apkipa naming', () => {
  assert.equal(shotFileName({ id: 'phone' }, { name: 'sign-in' }, 0), 'phone-1-sign-in.png');
  assert.equal(shotFileName({ id: 'ipad-13' }, { name: 'Home Screen' }, 2), 'ipad-13-3-home-screen.png');
});
