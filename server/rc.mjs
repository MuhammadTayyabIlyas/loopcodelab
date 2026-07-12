// server/rc.mjs — Remote Control paired-device store + one-time pairing tokens.
// Owns the rcDevices array; routes go through the exported accessors.
import path from 'node:path';
import { parseCookie, findDevice } from '../ralph/rc-auth.mjs';
import { DATA_DIR, readJson, writeJson } from './config.mjs';

// --- Remote Control (RC): paired-device store + one-time pairing tokens ----------
const RC_DEVICES_FILE = path.join(DATA_DIR, 'rc-devices.json');
let rcDevices = [];                       // [{ id, hash, label, tenant, createdAt, lastSeen }]
export const rcPairTokens = new Map();           // token -> { token, expiresAt, used }
export async function loadRcDevices() { rcDevices = await readJson(RC_DEVICES_FILE, []); }
export async function saveRcDevices() { await writeJson(RC_DEVICES_FILE, rcDevices); }

// Resolve the device record from the rc_dev cookie; bumps lastSeen (best-effort).
export function rcDeviceFromReq(req) {
  const token = parseCookie(req.headers.cookie, 'rc_dev');
  const d = findDevice(rcDevices, token);
  if (d) { d.lastSeen = Date.now(); }
  return d || null;
}
export const rcTenantSlug = (req) => rcDeviceFromReq(req)?.tenant || null;

// Express gate for /rc/api/*: a valid device token is required.
export function requireDevice(req, res, next) {
  const d = rcDeviceFromReq(req);
  if (!d) return res.status(401).json({ error: 'Not paired. Scan the QR again.' });
  req.rcDevice = d;
  next();
}
// Accessors for the routes that read/mutate the device list (the array is
// module-private so a re-assignment can't silently diverge from the file).
export const getRcDevices = () => rcDevices;
export function setRcDevices(list) { rcDevices = list; }
