import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIR_TTL_MS, sha256, randomToken, makePairToken, pairTokenValid,
  makeDevice, findDevice, parseCookie,
} from './rc-auth.mjs';

test('randomToken has prefix and entropy', () => {
  const a = randomToken('pt'), b = randomToken('pt');
  assert.match(a, /^pt_[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(a, b);
});

test('pair token valid until used or expired', () => {
  const now = 1_000_000;
  const rec = makePairToken(now);
  assert.equal(rec.expiresAt, now + PAIR_TTL_MS);
  assert.ok(pairTokenValid(rec, now));
  assert.ok(!pairTokenValid(rec, now + PAIR_TTL_MS + 1)); // expired
  assert.ok(!pairTokenValid({ ...rec, used: true }, now)); // used
  assert.ok(!pairTokenValid(null, now));
});

test('makeDevice returns token + record whose hash matches', () => {
  const { token, record } = makeDevice({ label: 'iPhone', tenant: 't1' }, 5);
  assert.match(token, /^dev_/);
  assert.equal(record.hash, sha256(token));
  assert.equal(record.tenant, 't1');
  assert.equal(record.label, 'iPhone');
  assert.equal(record.createdAt, 5);
  assert.ok(record.id.length >= 8);
});

test('findDevice matches by hash, constant-time, else null', () => {
  const { token, record } = makeDevice({ label: '', tenant: null });
  const devices = [{ hash: sha256('dev_other'), id: 'x' }, record];
  assert.equal(findDevice(devices, token), record);
  assert.equal(findDevice(devices, 'dev_nope'), null);
  assert.equal(findDevice([], token), null);
  assert.equal(findDevice(devices, ''), null);
});

test('parseCookie extracts the named cookie', () => {
  assert.equal(parseCookie('a=1; rc_dev=dev_abc; b=2', 'rc_dev'), 'dev_abc');
  assert.equal(parseCookie('', 'rc_dev'), null);
  assert.equal(parseCookie('x=y', 'rc_dev'), null);
});
