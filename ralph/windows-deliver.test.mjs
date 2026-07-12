import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installerShareName, parseWindowsDeliverResult, windowsDeliverableMarkdown } from './windows-deliver.mjs';

test('installerShareName: safe slug + extension; defaults to exe', () => {
  assert.equal(installerShareName('My Notes!'), 'my-notes.exe');
  assert.equal(installerShareName('notes', 'msi'), 'notes.msi');
  assert.equal(installerShareName('', 'exe'), 'app.exe');
  assert.equal(installerShareName('a'.repeat(80)).length <= 52, true); // capped + .exe
  assert.equal(installerShareName('x', 'bogus'), 'x.exe'); // unknown kind -> exe
});

test('parseWindowsDeliverResult: success, error, and pending', () => {
  assert.deepEqual(parseWindowsDeliverResult('{"shareLink":"https://drive/x","qr":"https://drive/qr"}'),
    { shareLink: 'https://drive/x', qr: 'https://drive/qr' });
  assert.deepEqual(parseWindowsDeliverResult('{"shareLink":"https://drive/x"}'),
    { shareLink: 'https://drive/x', qr: null });
  assert.deepEqual(parseWindowsDeliverResult('{"error":"actions run failed"}'), { error: 'actions run failed' });
  assert.equal(parseWindowsDeliverResult(''), null);
  assert.equal(parseWindowsDeliverResult(null), null);
  assert.deepEqual(parseWindowsDeliverResult('not json'), { error: 'unparseable delivery result' });
  assert.deepEqual(parseWindowsDeliverResult('{"foo":1}'), { error: 'no share link returned' });
});

test('windowsDeliverableMarkdown: records the install link, QR, and provenance', () => {
  const md = windowsDeliverableMarkdown({ project: 'notes', previewUrl: 'https://notes.example', shareLink: 'https://drive/x', qr: 'https://drive/qr', appId: 'com.acme.notes', version: '1.0.0', kind: 'exe' });
  assert.match(md, /Windows/);
  assert.match(md, /https:\/\/drive\/x/);
  assert.match(md, /https:\/\/drive\/qr/);
  assert.match(md, /com\.acme\.notes/);
  assert.match(md, /1\.0\.0/);
  assert.match(md, /https:\/\/notes\.example/);
});

test('windowsDeliverableMarkdown: composes the Store package section when present', () => {
  const md = windowsDeliverableMarkdown({
    project: 'p', previewUrl: 'https://p.example.com',
    shareLink: 'https://drive/exe', qr: 'https://qr/exe',
    appId: 'com.a.b', version: '1.0.0',
    store: { shareLink: 'https://drive/appx', qr: 'https://qr/appx' },
  });
  assert.match(md, /Install on Windows/);
  assert.match(md, /Microsoft Store package/);
  assert.match(md, /https:\/\/drive\/appx/);
  assert.match(md, /Partner Center/);
  // store-only (no installer yet) still renders the store section
  const only = windowsDeliverableMarkdown({ project: 'p', store: { shareLink: 'https://drive/appx', qr: null } });
  assert.match(only, /Microsoft Store package/);
  assert.doesNotMatch(only, /Install on Windows/);
});
