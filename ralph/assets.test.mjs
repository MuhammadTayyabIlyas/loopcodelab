import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAsset, sanitizeAssetName, assetKind, stagedAssetManifest, staleStagedAssets, MAX_ASSETS } from './assets.mjs';

test('validateAsset accepts allowed types under the size cap', () => {
  assert.equal(validateAsset({ name: 'logo.png', size: 1000 }).ok, true);
  assert.equal(validateAsset({ name: 'brand.PDF', size: 1000 }).ok, true);
});
test('validateAsset rejects bad type, empty, and oversize', () => {
  assert.equal(validateAsset({ name: 'evil.exe', size: 10 }).ok, false);
  assert.equal(validateAsset({ name: 'noext', size: 10 }).ok, false);
  assert.equal(validateAsset({ name: 'a.png', size: 0 }).ok, false);
  assert.equal(validateAsset({ name: 'a.png', size: 11 * 1024 * 1024 }).ok, false);
});
test('sanitizeAssetName strips paths and unsafe chars', () => {
  assert.equal(sanitizeAssetName('../../etc/passwd.png'), 'passwd.png');
  assert.equal(sanitizeAssetName('my logo!.png'), 'my_logo_.png');
  assert.equal(sanitizeAssetName('...'), 'asset');
  assert.equal(sanitizeAssetName(''), 'asset');
});
test('assetKind classifies', () => {
  assert.equal(assetKind('company-logo.svg'), 'logo');
  assert.equal(assetKind('guide.pdf'), 'doc');
  assert.equal(assetKind('hero.jpg'), 'image');
});
test('stagedAssetManifest renders names, kinds, notes', () => {
  assert.equal(
    stagedAssetManifest([{ name: 'logo.png', kind: 'logo' }, { name: 'h.jpg', kind: 'image', note: 'hero' }]),
    'logo.png (logo); h.jpg (image: hero)');
});
test('staleStagedAssets returns tokens past the TTL', () => {
  const now = 1_000_000_000;
  const ttl = 6 * 60 * 60 * 1000;
  const entries = [
    { token: 'old', createdAt: now - ttl - 1 },
    { token: 'fresh', createdAt: now - 10 },
    { token: 'bad', createdAt: NaN },
  ];
  assert.deepEqual(staleStagedAssets(entries, now, ttl), ['old']);
});
test('MAX_ASSETS is 12', () => assert.equal(MAX_ASSETS, 12));
