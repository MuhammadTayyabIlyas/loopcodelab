// ralph/media-deliver.mjs
// Pure logic for the automatic social-video -> Google Drive delivery: which
// files to upload, how to parse the delivery sentinel, the DELIVERABLE.md
// body, and the Drive-link gallery that replaces the local-file gallery after
// the local media is deleted. Fs/tmux/sudo live in ralph-media-deliver.sh and
// the orchestrator — this module is deterministic and unit-tested.
import { PLATFORM_SPECS, platformForFile } from './social-formats.mjs';

export function mediaShareList(names, project) {
  if (!Array.isArray(names)) return [];
  const out = [];
  for (const n of names) {
    const platform = platformForFile(String(n));
    if (!platform) continue;
    out.push({ file: `output/${n}`, driveName: `${project}-${platform}.mp4`, platform });
  }
  return out;
}

export function parseMediaDeliverResult(raw) {
  if (!raw || !String(raw).trim()) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (j && typeof j.error === 'string') return { error: j.error.slice(0, 300) };
  if (!j || !Array.isArray(j.files)) return { error: 'malformed delivery result' };
  const files = j.files
    .filter((f) => f && typeof f === 'object' && f.shareLink)
    .map((f) => ({
      name: String(f.name || ''), platform: String(f.platform || ''),
      shareLink: String(f.shareLink), directDownload: String(f.directDownload || f.shareLink),
      qr: String(f.qr || ''), size: Number(f.size) || 0,
    }));
  return { files };
}

export function mediaDeliverableMarkdown({ project, previewUrl, files }) {
  const lines = [
    `# ${project} — deliverable`,
    '',
    previewUrl ? `Preview gallery: ${previewUrl}` : '',
    '',
    '## Video renders (Google Drive)',
    '',
    ...files.map((f) => `- **${f.platform}** — [${f.name}](${f.shareLink})${f.qr ? ` · [QR](${f.qr})` : ''}`),
    '',
    '_Local copies were removed after upload; Drive is the copy of record._',
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function galleryDriveHtml(files, { title = 'Story video', color = '#3b82f6' } = {}) {
  const cards = files.map((f) => {
    const s = PLATFORM_SPECS[f.platform];
    const label = s ? s.label : f.platform;
    return `  <figure>\n    <video controls preload="none" src="${esc(f.directDownload)}"></video>\n`
      + `    <figcaption>${esc(label)} · <a href="${esc(f.shareLink)}" target="_blank" rel="noopener">Open in Drive ↗</a>`
      + `${f.qr ? ` · <a href="${esc(f.qr)}" target="_blank" rel="noopener">QR</a>` : ''}</figcaption>\n  </figure>`;
  }).join('\n');
  return `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n`
    + `<title>${esc(title)}</title>\n<style>\n`
    + `body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem}\n`
    + `h1{border-bottom:3px solid ${esc(color)};padding-bottom:.5rem}\n`
    + `main{display:flex;flex-wrap:wrap;gap:1.5rem}\nfigure{margin:0;max-width:300px}\n`
    + `video{width:100%;border-radius:8px;background:#000}\nfigcaption{font-size:.85rem;margin-top:.4rem}\n`
    + `a{color:${esc(color)}}\n</style>\n<h1>${esc(title)}</h1>\n<main>\n${cards}\n</main>\n`;
}
