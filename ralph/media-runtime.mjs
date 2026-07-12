// Runtime (fs + http) helpers shared by the gen-*.mjs media helpers. Kept out of
// media-gen.mjs so that module stays pure/unit-tested; the fs bits here are tested
// against a temp dir, downloadTo() is exercised live by the helpers.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const COUNT_FILE = '.ralph/media-count.json';
const ZERO = () => ({ image: 0, video: 0, audio: 0 });

export async function readCounts(dir) {
  try {
    const c = JSON.parse(await fs.readFile(path.join(dir, COUNT_FILE), 'utf8'));
    return { ...ZERO(), ...c };
  } catch { return ZERO(); }
}
export async function bumpCount(dir, kind) {
  const c = await readCounts(dir);
  c[kind] = (c[kind] || 0) + 1;
  await fs.mkdir(path.join(dir, '.ralph'), { recursive: true });
  await fs.writeFile(path.join(dir, COUNT_FILE), JSON.stringify(c));
  return c[kind];
}
export async function bumpBytes(dir, key, n) {
  const c = await readCounts(dir);
  c[key] = (Number(c[key]) || 0) + (Number(n) || 0);
  await fs.mkdir(path.join(dir, '.ralph'), { recursive: true });
  await fs.writeFile(path.join(dir, COUNT_FILE), JSON.stringify(c));
  return c[key];
}
export async function writeBinary(bytes, outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, bytes);
}
export async function downloadTo(url, outPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeBinary(buf, outPath);
  return buf.length;
}
// Deterministic placeholder for the no-spend stub harness (RALPH_FORCE_TOOL set).
const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
export async function writeStub(outPath, kind) {
  if (kind === 'image') return writeBinary(STUB_PNG, outPath);
  return writeBinary(Buffer.from(`stub ${kind} placeholder (no-spend harness)\n`), outPath);
}
