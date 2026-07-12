import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCounts, bumpCount, bumpBytes, writeStub } from './media-runtime.mjs';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'mrt-')); }

test('readCounts defaults to zeros when no file; bumpCount increments and persists', async () => {
  const dir = await tmp();
  assert.deepEqual(await readCounts(dir), { image: 0, video: 0, audio: 0 });
  assert.equal(await bumpCount(dir, 'image'), 1);
  assert.equal(await bumpCount(dir, 'image'), 2);
  assert.equal(await bumpCount(dir, 'video'), 1);
  assert.deepEqual(await readCounts(dir), { image: 2, video: 1, audio: 0 });
  await fs.rm(dir, { recursive: true, force: true });
});

test('writeStub writes a nonzero file (png bytes for image, text otherwise)', async () => {
  const dir = await tmp();
  const img = path.join(dir, 'a/hero.png'); await writeStub(img, 'image');
  const vid = path.join(dir, 'b/clip.mp4'); await writeStub(vid, 'video');
  assert.ok((await fs.stat(img)).size > 0);
  assert.ok((await fs.stat(vid)).size > 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('bumpBytes accumulates a byte counter alongside kind counts', async () => {
  const dir = await tmp();
  assert.equal(await bumpBytes(dir, 'composeBytes', 1000), 1000);
  assert.equal(await bumpBytes(dir, 'composeBytes', 500), 1500);
  const counts = await readCounts(dir);
  assert.equal(counts.composeBytes, 1500);
  await fs.rm(dir, { recursive: true, force: true });
});
