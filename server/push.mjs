// server/push.mjs — Web Push: self-provisioned VAPID keys + the subscription
// store. Owns `vapid` and `subscriptions`; routes use the exported accessors.
import webpush from 'web-push';
import { VAPID_FILE, SUBS_FILE, readJson, writeJson, MULTITENANT } from './config.mjs';

// --- Web Push: self-provisioned VAPID keys + subscription store -------------
let vapid = null;        // { publicKey, privateKey }
let subscriptions = [];  // [PushSubscription]

export async function initPush() {
  vapid = await readJson(VAPID_FILE, null);
  if (!vapid?.publicKey) {
    vapid = webpush.generateVAPIDKeys();
    await writeJson(VAPID_FILE, vapid);
  }
  webpush.setVapidDetails('mailto:tayyabcheema777@gmail.com', vapid.publicKey, vapid.privateKey);
  subscriptions = await readJson(SUBS_FILE, []);
}

export async function sendPush(payload) {
  if (!vapid || !subscriptions.length) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  if (dead.length) {
    subscriptions = subscriptions.filter((s) => !dead.includes(s.endpoint));
    await writeJson(SUBS_FILE, subscriptions);
  }
}

// Device-scoped push: filter subscriptions, prune dead endpoints.
export async function sendPushTo(filterFn, payload) {
  if (!vapid) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subscriptions.filter(filterFn).map(async (sub) => {
    try { await webpush.sendNotification(sub, body); }
    catch (err) { if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint); }
  }));
  if (dead.length) { subscriptions = subscriptions.filter((s) => !dead.includes(s.endpoint)); await writeJson(SUBS_FILE, subscriptions); }
}
// RC notifications go to the paired devices of a run's tenant (single-tenant: all RC subs).
export const sendPushRun = (run, payload) => sendPushTo(
  (s) => s.rc && (!MULTITENANT || s.tenant === (run.tenant?.slug || null)),
  { ...payload, url: `/rc/#/${run.project}`, tag: `rc-${run.project}` });


export const pushReady = () => !!vapid;
export const vapidPublicKey = () => vapid?.publicKey || null;
export const subscriptionCount = () => subscriptions.length;
// Add unless the endpoint is already subscribed (idempotent re-subscribe).
export async function addSubscription(sub) {
  if (!subscriptions.some((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    await writeJson(SUBS_FILE, subscriptions);
  }
}
export async function removeSubscriptions(pred) {
  subscriptions = subscriptions.filter((s) => !pred(s));
  await writeJson(SUBS_FILE, subscriptions);
}
// RC subscribe replaces any prior subscription for the same endpoint.
export async function addRcSubscription(sub, extra) {
  subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  subscriptions.push({ ...sub, rc: true, ...extra });
  await writeJson(SUBS_FILE, subscriptions);
}
