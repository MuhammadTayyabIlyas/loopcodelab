import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, pwaReport, REQUIRED_MANIFEST_FIELDS } from './pwa-validate.mjs';

const fullManifest = {
  name: 'Notes', short_name: 'Notes', description: 'A notes app', start_url: '/', scope: '/',
  display: 'standalone', theme_color: '#0b0b0b', background_color: '#ffffff',
  icons: [{ src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
};

test('validateManifest: a complete manifest is ok with no missing/warnings', () => {
  const r = validateManifest(fullManifest);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.warnings, []);
});

test('validateManifest: lists every missing/empty required field', () => {
  const r = validateManifest({ name: 'X', description: '  ', icons: [] });
  assert.equal(r.ok, false);
  // description is whitespace, icons empty -> both missing, plus the untouched fields
  for (const f of ['short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'description', 'icons']) {
    assert.ok(r.missing.includes(f), `expected ${f} missing`);
  }
  assert.ok(!r.missing.includes('name')); // present
});

test('validateManifest: non-installable display + missing icon sizes are warnings, not failures', () => {
  const r = validateManifest({ ...fullManifest, display: 'browser', icons: [{ src: '/a.png', sizes: '48x48' }] });
  assert.equal(r.ok, true); // all fields present -> ok
  assert.ok(r.warnings.some((w) => /display "browser"/.test(w)));
  assert.ok(r.warnings.some((w) => /192x192/.test(w)));
  assert.ok(r.warnings.some((w) => /512x512/.test(w)));
});

test('validateManifest: null/garbage manifest -> all fields missing', () => {
  assert.deepEqual(validateManifest(null).missing, [...REQUIRED_MANIFEST_FIELDS]);
  assert.deepEqual(validateManifest([]).missing, [...REQUIRED_MANIFEST_FIELDS]);
  assert.equal(validateManifest('nope').ok, false);
});

test('pwaReport: compliant when manifest ok + service worker present; offline is only a warning', () => {
  const r = pwaReport({ manifest: fullManifest, hasServiceWorker: true, hasOfflineFallback: false });
  assert.equal(r.compliant, true);
  assert.deepEqual(r.missing, []);
  assert.ok(r.warnings.some((w) => /offline/.test(w)));
});

test('pwaReport: missing service worker is a hard failure; manifest gaps are prefixed', () => {
  const r = pwaReport({ manifest: { name: 'X' }, hasServiceWorker: false, hasOfflineFallback: true });
  assert.equal(r.compliant, false);
  assert.ok(r.missing.includes('service-worker'));
  assert.ok(r.missing.includes('manifest.short_name'));
});

test('pwaReport: empty input is non-compliant, never throws', () => {
  const r = pwaReport();
  assert.equal(r.compliant, false);
  assert.ok(r.missing.includes('service-worker'));
});
