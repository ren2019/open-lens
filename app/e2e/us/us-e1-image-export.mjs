import { readFile } from 'node:fs/promises';
import {
  PHOTOS, bytes, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp,
  openScanner, waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-E1');
const since = Date.now();
let docId = null;

function jpegSize(data) {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset++; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (sof.has(marker)) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, PHOTOS.first);
  await confirmCrop(page);
  await finishBatch(page);
  await goGrid(page);
  docId = (await waitForCreatedDoc(since)).id;

  const pending = page.waitForEvent('download');
  await page.locator('button:has-text("单页图")').click();
  const download = await pending;
  const file = await readFile(await download.path());
  const size = jpegSize(file);
  const detail = await waitForDetail(docId, doc => doc.outfits.some(outfit => outfit.kind === 'image'));
  const quad = detail.pages[0].quad;
  const distance = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1]);
  const expectedRatio = (distance(quad[0], quad[3]) + distance(quad[1], quad[2]))
    / (distance(quad[0], quad[1]) + distance(quad[3], quad[2]));
  t.check('单页 JPEG 下载落文件且可解码', download.suggestedFilename().endsWith('.jpg')
    && file.length > 100 && !!size, `${download.suggestedFilename()} ${file.length}B`);
  t.check('JPEG 尺寸与 Scan 的 quad 边长比一致', size.width === 1400
    && Math.abs(size.height / size.width - expectedRatio) < 0.02,
  `${size.width}x${size.height} expected=${expectedRatio.toFixed(3)}`);

  const outfit = detail.outfits.find(item => item.kind === 'image');
  const archived = await bytes(outfit.file);
  t.check('单页 JPEG Outfit 同步归档且文件可取', archived.ok && jpegSize(archived.data)?.width === size.width,
    `${archived.data.length}B`);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
