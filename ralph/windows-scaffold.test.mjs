import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS_WORKFLOW_PATH, WINDOWS_CHECKLIST_DOC,
  defaultWindowsAppId, validWindowsAppId, sanitizeProductName, semverTo4Part,
  validateWindowsInput, tauriConfJson, cargoToml, mainRs, buildRs,
  windowsPackageYaml, windowsChecklistMd, pngSolidIcon,
} from './windows-scaffold.mjs';

test('appId: default is reverse-DNS from the project; validity rules', () => {
  assert.equal(defaultWindowsAppId('My Notes App!'), 'com.webtmux.mynotesapp');
  assert.equal(validWindowsAppId('com.acme.app'), true);
  assert.equal(validWindowsAppId('com.acme'), true);
  assert.equal(validWindowsAppId('acme'), false);          // needs at least two segments
  assert.equal(validWindowsAppId('com.acme.'), false);     // trailing dot
  assert.equal(validWindowsAppId('com.1acme.app'), false); // segment starting with a digit
  assert.equal(validWindowsAppId('com.acme.my-app'), true);
});

test('semverTo4Part: x.y.z -> x.y.z.0; rejects non-semver', () => {
  assert.equal(semverTo4Part('1.2.3'), '1.2.3.0');
  assert.equal(semverTo4Part('0.0.1'), '0.0.1.0');
  assert.equal(semverTo4Part('1.2'), null);
  assert.equal(semverTo4Part('v1.2.3'), null);
  assert.equal(semverTo4Part('1.2.3.4'), null);
});

test('sanitizeProductName: falls back to the project, strips control chars, caps length', () => {
  assert.equal(sanitizeProductName('', 'notes'), 'notes');
  assert.equal(sanitizeProductName('  Cool App  ', 'x'), 'Cool App');
  assert.equal(sanitizeProductName('a'.repeat(200), 'x').length <= 60, true);
});

test('validateWindowsInput: reports every bad field; ok when all valid', () => {
  assert.deepEqual(validateWindowsInput({ appId: 'com.acme.app', productName: 'Notes', version: '1.0.0' }),
    { ok: true, errors: [] });
  const r = validateWindowsInput({ appId: 'acme', productName: '', version: '1.2' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /appId/i.test(e)));
  assert.ok(r.errors.some((e) => /version/i.test(e)));
});

test('tauriConfJson: v2 shape with identity/frontendDist/bundle targets', () => {
  const c = tauriConfJson({ productName: 'Notes', appId: 'com.acme.notes', version: '1.0.0', frontendDist: '../dist', beforeBuildCommand: '' });
  assert.equal(c.productName, 'Notes');
  assert.equal(c.version, '1.0.0');
  assert.equal(c.identifier, 'com.acme.notes');
  assert.equal(c.build.frontendDist, '../dist');
  assert.deepEqual(c.bundle.targets, ['nsis', 'msi']);
  assert.ok(Array.isArray(c.app.windows) && c.app.windows[0].title === 'Notes');
});

test('cargoToml/mainRs/buildRs: minimal valid Tauri v2 crate text', () => {
  const cargo = cargoToml({ crateName: 'app' });
  assert.match(cargo, /name = "app"/);
  assert.match(cargo, /tauri-build = \{ version = "2"/);
  assert.match(cargo, /tauri = \{ version = "2"/);
  assert.match(buildRs(), /tauri_build::build\(\)/);
  assert.match(mainRs(), /tauri::Builder::default\(\)/);
});

test('windowsPackageYaml: dispatchable windows-latest job that builds Tauri + uploads artifacts', () => {
  const y = windowsPackageYaml({ frontendDir: 'dist', hasNodeBuild: true });
  assert.match(y, /on:\s*\n\s*workflow_dispatch:/);
  assert.match(y, /runs-on: windows-latest/);
  assert.match(y, /tauri icon/);            // generates the icon set from the source png
  assert.match(y, /tauri build/);
  assert.match(y, /upload-artifact/);
  assert.match(y, /npm run build/);          // hasNodeBuild -> builds the web app first
});

test('windowsChecklistMd: names the workflow, run steps, and where the installer lands', () => {
  const md = windowsChecklistMd({ project: 'notes', appId: 'com.acme.notes', version: '1.0.0' });
  assert.match(md, /Windows installer/i);
  assert.match(md, /Actions/);
  assert.match(md, /com\.acme\.notes/);
  assert.match(md, /\.msi|\.exe/);
});

test('paths are the fixed constants', () => {
  assert.equal(WINDOWS_WORKFLOW_PATH, '.github/workflows/windows-package.yml');
  assert.equal(WINDOWS_CHECKLIST_DOC, 'WINDOWS-INSTALLER.md');
});

test('pngSolidIcon: returns a valid PNG buffer with the signature, size, and IEND', () => {
  const png = pngSolidIcon(16, [10, 20, 30]);
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
  assert.equal(png.readUInt32BE(16), 16); // IHDR width
  assert.equal(png.readUInt32BE(20), 16); // IHDR height
  assert.ok(png.length > 60);
  assert.equal(png.subarray(-8, -4).toString('ascii'), 'IEND');
});
