// Pure validation for per-provider subscription tracking notes (Settings "Track" dialog):
// start/end dates, peak hours, current usage, notes, and a dashboard link the user keeps
// to plan around their plans. Display-only metadata — never used to gate builds, and never
// a secret (the key itself stays in the vault). Server routes store one map per tenant:
// { <provider>: entry }.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' and actually a real calendar date (2026-13-40 is not).
function validDate(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

const str = (v, n) => String(v ?? '').trim().slice(0, n);

// Sanitized entry, or null when nothing valid remains (null = clear the entry).
export function normalizeTrackingEntry(input) {
  const d = input || {};
  const link = str(d.link, 500);
  const e = {
    startDate: validDate(str(d.startDate, 10)) ? str(d.startDate, 10) : '',
    endDate: validDate(str(d.endDate, 10)) ? str(d.endDate, 10) : '',
    peakHours: str(d.peakHours, 120),
    usage: str(d.usage, 200),
    notes: str(d.notes, 2000),
    link: /^https?:\/\//.test(link) ? link : '',
  };
  return Object.values(e).some(Boolean) ? e : null;
}

// Whole days until the end of endDate (UTC): 0 = ends today, negative = already ended.
export function trackingDaysLeft(endDate, now) {
  if (!validDate(endDate)) return null;
  return Math.floor((Date.parse(`${endDate}T23:59:59Z`) - now) / 86_400_000);
}

export function validTrackingProvider(p) {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(p || ''));
}
