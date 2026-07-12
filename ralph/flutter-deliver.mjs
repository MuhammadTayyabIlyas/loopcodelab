// Pure helpers for the flutter-app delivery step (build + APK -> Google Drive link).
// No I/O — unit-tested. The orchestration (spawn session, poll sentinel, push) lives
// in server.js; this just shapes names, parses the delivery result, and renders the
// DELIVERABLE.md the orchestrator writes once the link is known.

export function apkFileName(project) {
  const s = String(project || 'app').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
  return `${s}.apk`;
}

// Tolerant parse of ralph-deliver.sh's --out JSON. Returns { shareLink, qr } on
// success, { error } otherwise, or null if nothing was written yet.
export function parseDeliverResult(raw) {
  if (raw == null) return null;
  const txt = String(raw).trim();
  if (!txt) return null;
  let j;
  try { j = JSON.parse(txt); } catch { return { error: 'unparseable delivery result' }; }
  if (j && typeof j.shareLink === 'string' && j.shareLink) {
    return { shareLink: j.shareLink, qr: typeof j.qr === 'string' && j.qr ? j.qr : null };
  }
  if (j && j.error) return { error: String(j.error) };
  return { error: 'no share link returned' };
}

export function deliverableMarkdown({ project, previewUrl, shareLink, qr } = {}) {
  const lines = [`# ${project || 'project'} — Deliverable`, '', '**Type:** Flutter app (Android + web)', ''];
  if (previewUrl) lines.push('## Live web preview', previewUrl, '');
  if (shareLink) {
    lines.push('## Install on Android', `- **APK (install link):** ${shareLink}`);
    if (qr) lines.push(`- **QR code (scan with your phone):** ${qr}`);
    lines.push('',
      '> This is a debug-signed test build for sideloading. Open the link on your phone,',
      '> download the APK, and allow "install unknown apps" when prompted. For a Google Play',
      '> release, use the Submit step (which builds a release-signed AAB).', '');
  }
  return lines.join('\n') + '\n';
}
