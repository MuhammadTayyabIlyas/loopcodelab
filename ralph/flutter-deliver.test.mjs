import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apkFileName, parseDeliverResult, deliverableMarkdown } from './flutter-deliver.mjs';

test('apkFileName slugifies and always ends .apk', () => {
  assert.equal(apkFileName('My Cool App!'), 'my-cool-app.apk');
  assert.equal(apkFileName(''), 'app.apk');
  assert.equal(apkFileName(null), 'app.apk');
  assert.equal(apkFileName('snake-game'), 'snake-game.apk');
});

test('parseDeliverResult handles success, error, junk, empty', () => {
  assert.deepEqual(parseDeliverResult('{"shareLink":"https://d/x","qr":"https://q/y"}'),
    { shareLink: 'https://d/x', qr: 'https://q/y' });
  assert.equal(parseDeliverResult('{"shareLink":"https://d/x"}').qr, null);
  assert.deepEqual(parseDeliverResult('{"error":"upload failed"}'), { error: 'upload failed' });
  assert.equal(parseDeliverResult('not json').error, 'unparseable delivery result');
  assert.equal(parseDeliverResult('{}').error, 'no share link returned');
  assert.equal(parseDeliverResult(''), null);
  assert.equal(parseDeliverResult(null), null);
});

test('deliverableMarkdown includes preview + install link + QR when present', () => {
  const md = deliverableMarkdown({ project: 'snake', previewUrl: 'https://snake.x', shareLink: 'https://d/x', qr: 'https://q/y' });
  assert.match(md, /# snake — Deliverable/);
  assert.match(md, /https:\/\/snake\.x/);
  assert.match(md, /install link.*https:\/\/d\/x/);
  assert.match(md, /QR code.*https:\/\/q\/y/);
  assert.match(md, /debug-signed/);
});

test('deliverableMarkdown omits sections when data missing', () => {
  const md = deliverableMarkdown({ project: 'x' });
  assert.doesNotMatch(md, /Install on Android/);
  assert.doesNotMatch(md, /Live web preview/);
});
