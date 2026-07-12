import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_WORKFLOW_PATH, STORE_DOC, STORE_PACKAGINGS,
  validIdentityName, validPublisherId, validateStoreInput,
  electronApplicationId, electronPackageJson, electronMainJs,
  windowsStoreYaml, storeShareName, storeSubmissionMd,
} from './windows-store.mjs';

const IDENTITY = {
  identityName: '12345TayyabCheema.EidCard',
  publisher: 'CN=1DE2F3A4-0000-4B5C-8D6E-7F8A9B0C1D2E',
  publisherDisplayName: 'Tayyab Cheema',
};

test('constants: workflow + doc paths, packagings', () => {
  assert.equal(STORE_WORKFLOW_PATH, '.github/workflows/windows-store.yml');
  assert.equal(STORE_DOC, 'SUBMISSION-WINDOWS.md');
  assert.deepEqual(STORE_PACKAGINGS, ['electron', 'pwa']);
});

test('validIdentityName: Partner Center shape (3-50, alnum . -, may start with a digit)', () => {
  assert.equal(validIdentityName('12345TayyabCheema.EidCard'), true);
  assert.equal(validIdentityName('My.App-2'), true);
  assert.equal(validIdentityName('ab'), false);              // too short
  assert.equal(validIdentityName('has space.App'), false);
  assert.equal(validIdentityName('a'.repeat(51)), false);
  assert.equal(validIdentityName(''), false);
});

test('validPublisherId: CN=… required', () => {
  assert.equal(validPublisherId('CN=1DE2F3A4-0000-4B5C-8D6E-7F8A9B0C1D2E'), true);
  assert.equal(validPublisherId('1DE2F3A4'), false);
  assert.equal(validPublisherId('CN='), false);
});

test('validateStoreInput: ok for a full electron config', () => {
  const r = validateStoreInput({ packaging: 'electron', ...IDENTITY, productName: 'Eid Card', version: '1.0.0' });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('validateStoreInput: fail-closed — names every missing/invalid key', () => {
  const r = validateStoreInput({ packaging: 'electron', identityName: 'x', publisher: 'nope', publisherDisplayName: '', productName: 'App', version: '1.2' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /identityName/.test(e)));
  assert.ok(r.errors.some((e) => /publisher\b/.test(e)));
  assert.ok(r.errors.some((e) => /publisherDisplayName/.test(e)));
  assert.ok(r.errors.some((e) => /version/.test(e)));
});

test('validateStoreInput: publisherDisplayName must differ from the product name', () => {
  const r = validateStoreInput({ packaging: 'electron', ...IDENTITY, publisherDisplayName: 'Eid Card', productName: 'Eid Card', version: '1.0.0' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /differ|same/.test(e)));
});

test('validateStoreInput: pwa packaging needs an HTTPS preview URL', () => {
  const ok = validateStoreInput({ packaging: 'pwa', ...IDENTITY, productName: 'App', version: '1.0.0', previewUrl: 'https://x.example.com' });
  assert.equal(ok.ok, true);
  const bad = validateStoreInput({ packaging: 'pwa', ...IDENTITY, productName: 'App', version: '1.0.0', previewUrl: 'http://x.example.com' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /https/i.test(e)));
});

test('validateStoreInput: unknown packaging rejected', () => {
  const r = validateStoreInput({ packaging: 'tauri', ...IDENTITY, productName: 'App', version: '1.0.0' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /packaging/.test(e)));
});

test('electronApplicationId: letters/digits, starts with a letter, falls back to App', () => {
  assert.equal(electronApplicationId('Eid Card!'), 'EidCard');
  assert.equal(electronApplicationId('123'), 'App');
  assert.equal(electronApplicationId(''), 'App');
});

test('electronPackageJson: appx identity wired; web assets + main in files; own buildResources', () => {
  const p = electronPackageJson({ productName: 'Eid Card', appId: 'com.webtmux.eidcard', version: '1.0.0', ...IDENTITY });
  assert.equal(p.version, '1.0.0');
  assert.equal(p.main, 'main.js');
  assert.deepEqual(p.build.win.target, ['appx']);
  assert.equal(p.build.appx.identityName, IDENTITY.identityName);
  assert.equal(p.build.appx.publisher, IDENTITY.publisher);
  assert.equal(p.build.appx.publisherDisplayName, IDENTITY.publisherDisplayName);
  assert.equal(p.build.appx.applicationId, 'EidCard');
  assert.ok(p.build.files.includes('main.js'));
  assert.ok(p.build.files.some((f) => f.startsWith('web/')));
  // "build/" may be the repo's web output — the wrapper must NOT use it as buildResources.
  assert.notEqual(p.build.directories.buildResources, 'build');
  assert.ok(p.devDependencies.electron);
  assert.ok(p.devDependencies['electron-builder']);
});

test('electronMainJs: loads the bundled web output, quits on close', () => {
  const js = electronMainJs();
  assert.match(js, /loadFile/);
  assert.match(js, /web.+index\.html|'web'/);
  assert.match(js, /window-all-closed/);
});

test('windowsStoreYaml: robocopy stages the web output, electron-builder builds appx, artifact windows-store', () => {
  const y = windowsStoreYaml({ frontendDir: 'dist', hasNodeBuild: true });
  assert.match(y, /runs-on: windows-latest/);
  assert.match(y, /npm run build/);
  assert.match(y, /robocopy/);
  assert.match(y, /electron-builder --win appx/);
  assert.match(y, /name: windows-store/);
  assert.match(y, /\.appx/);
  // robocopy exit codes < 8 are success — the step must not fail the job on 1 (files copied).
  assert.match(y, /LASTEXITCODE/);
  const staticY = windowsStoreYaml({ frontendDir: '.', hasNodeBuild: false });
  assert.doesNotMatch(staticY, /npm run build/);
  // repo-root output must exclude the wrapper + scaffold dirs from the copy
  assert.match(staticY, /\/XD[^\n]*store-electron/);
});

test('storeShareName: slugged + -store.appx', () => {
  assert.equal(storeShareName('Eid Card'), 'eid-card-store.appx');
  assert.equal(storeShareName(''), 'app-store.appx');
});

test('storeSubmissionMd: reserve-first checklist covers both packagings + identity', () => {
  const md = storeSubmissionMd({
    project: 'eid-card', packaging: 'electron', ...IDENTITY,
    version: '1.0.0', previewUrl: 'https://eid-card.example.com', appId: 'com.webtmux.eidcard',
  });
  assert.match(md, /Partner Center/);
  assert.match(md, /reserve/i);
  assert.match(md, new RegExp(IDENTITY.identityName));
  assert.match(md, /pwabuilder\.com/i);
  assert.match(md, /windows-store/);          // the artifact/workflow name
  assert.match(md, /re-signs|re-sign/i);      // unsigned is fine for the Store
});
