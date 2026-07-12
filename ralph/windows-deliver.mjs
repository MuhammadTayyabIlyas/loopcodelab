// Pure helpers for the Windows-installer delivery step (Phase 2b): off-box Actions build ->
// download artifact -> Google Drive link. No I/O — orchestration (dispatch/poll/download/share)
// lives in ralph-windows-deliver.sh; this shapes names, parses the result, and renders DELIVERABLE.md.

const KINDS = new Set(['exe', 'msi']);

export function installerShareName(project, kind = 'exe') {
  const k = KINDS.has(kind) ? kind : 'exe';
  const s = String(project || 'app').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'app';
  return `${s}.${k}`;
}

// Tolerant parse of ralph-windows-deliver.sh's --out JSON. { shareLink, qr } on success,
// { error } otherwise, null if nothing written yet.
export function parseWindowsDeliverResult(raw) {
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

export function windowsDeliverableMarkdown({ project, previewUrl, shareLink, qr, appId, version, kind = 'exe', store = null } = {}) {
  const lines = [`# ${project || 'project'} — Deliverable`, '', '**Type:** Windows desktop app (Tauri installer)', ''];
  if (appId || version) lines.push(`**Identity:** ${appId || '(app id)'} · **Version:** ${version || '1.0.0'}`, '');
  if (previewUrl) lines.push('## Live web preview', previewUrl, '');
  if (shareLink) {
    lines.push('## Install on Windows', `- **Installer (${kind.toUpperCase()}) download:** ${shareLink}`);
    if (qr) lines.push(`- **QR code (scan with your phone):** ${qr}`);
    lines.push('',
      '> Download and run the installer on Windows. Unsigned builds show a SmartScreen prompt',
      '> ("More info" → "Run anyway") until the app earns reputation or you sign it with your own',
      '> code-signing certificate. For the Microsoft Store, use the Store step (Phase 3).', '');
  }
  if (store && store.shareLink) {
    lines.push('## Microsoft Store package', `- **Store package (AppX/MSIX) download:** ${store.shareLink}`);
    if (store.qr) lines.push(`- **QR code:** ${store.qr}`);
    lines.push('',
      '> Unsigned on purpose — upload it in Partner Center (the Store re-signs it for free).',
      '> Steps: SUBMISSION-WINDOWS.md.', '');
  }
  return lines.join('\n') + '\n';
}
