import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaShareList, parseMediaDeliverResult, mediaDeliverableMarkdown, galleryDriveHtml,
} from './media-deliver.mjs';

test('mediaShareList: only platform renders, drive-safe names, junk skipped', () => {
  const l = mediaShareList(['story-tiktok.mp4', 'story-youtube.mp4', 'notes.txt', 'raw.mp4'], 'moon-walk');
  assert.deepEqual(l, [
    { file: 'output/story-tiktok.mp4', driveName: 'moon-walk-tiktok.mp4', platform: 'tiktok' },
    { file: 'output/story-youtube.mp4', driveName: 'moon-walk-youtube.mp4', platform: 'youtube' },
  ]);
  assert.deepEqual(mediaShareList([], 'x'), []);
  assert.deepEqual(mediaShareList('junk', 'x'), []);
});

test('parseMediaDeliverResult: success, error, pending', () => {
  const ok = parseMediaDeliverResult(JSON.stringify({
    files: [{ name: 'p-tiktok.mp4', platform: 'tiktok', shareLink: 'https://d/1', directDownload: 'https://d/dl/1', qr: 'https://q/1', size: 5 }],
  }));
  assert.equal(ok.files.length, 1);
  assert.equal(ok.files[0].platform, 'tiktok');
  assert.deepEqual(parseMediaDeliverResult('{"error":"upload failed"}'), { error: 'upload failed' });
  assert.equal(parseMediaDeliverResult(''), null);
  assert.equal(parseMediaDeliverResult('not json'), null);
  assert.deepEqual(parseMediaDeliverResult('{"files":"junk"}'), { error: 'malformed delivery result' });
});

test('mediaDeliverableMarkdown: project, preview, one line per file with link + qr', () => {
  const md = mediaDeliverableMarkdown({
    project: 'moon-walk', previewUrl: 'https://moon-walk.example.com',
    files: [{ name: 'moon-walk-tiktok.mp4', platform: 'tiktok', shareLink: 'https://d/1', qr: 'https://q/1' }],
  });
  assert.ok(md.includes('# moon-walk') && md.includes('https://moon-walk.example.com'));
  assert.ok(md.includes('tiktok') && md.includes('https://d/1') && md.includes('https://q/1'));
});

test('galleryDriveHtml: video src = directDownload, drive link, escaped title', () => {
  const html = galleryDriveHtml(
    [{ name: 'p-tiktok.mp4', platform: 'tiktok', shareLink: 'https://d/1', directDownload: 'https://d/dl/1', qr: 'https://q/1' }],
    { title: 'Promo <x>', color: '#123456' },
  );
  assert.ok(html.includes('src="https://d/dl/1"'));
  assert.ok(html.includes('href="https://d/1"'));
  assert.ok(html.includes('#123456'));
  assert.ok(html.includes('Promo &lt;x&gt;') && !html.includes('Promo <x>'));
  assert.ok(html.includes('TikTok')); // platform label from PLATFORM_SPECS
});
