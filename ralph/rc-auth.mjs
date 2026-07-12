// Pure auth helpers for phone Remote Control (RC). Token mint/hash/compare + cookie
// parsing, no I/O — server.js owns the device store and HTTP. Unit-tested in isolation.
import crypto from 'node:crypto';

export const PAIR_TTL_MS = 5 * 60 * 1000; // one-time QR pairing token lifetime

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

export function makePairToken(now = Date.now()) {
  return { token: randomToken('pt'), expiresAt: now + PAIR_TTL_MS, used: false };
}
export function pairTokenValid(rec, now = Date.now()) {
  return !!rec && !rec.used && rec.expiresAt > now;
}

// Device record persists (hashed token). The raw token only ever lives in the cookie.
export function makeDevice({ label = '', tenant = null }, now = Date.now()) {
  const token = randomToken('dev');
  return {
    token,
    record: {
      id: crypto.randomBytes(8).toString('hex'),
      hash: sha256(token),
      label: String(label).slice(0, 120),
      tenant: tenant || null,
      createdAt: now,
      lastSeen: now,
    },
  };
}

export function findDevice(devices, token) {
  if (!token || typeof token !== 'string') return null;
  const h = Buffer.from(sha256(token), 'hex');
  for (const d of devices || []) {
    const stored = Buffer.from(String(d.hash || ''), 'hex');
    if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) return d;
  }
  return null;
}

export function parseCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      const raw = part.slice(i + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return null;
}
