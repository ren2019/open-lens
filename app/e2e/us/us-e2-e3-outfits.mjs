import { readFile, stat } from 'node:fs/promises';
import {
  PHOTOS, bytes, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp,
  openScanner, waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-E2/E3');
const since = Date.now();
let docId = null;
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, [PHOTOS.first, PHOTOS.second]);
  await confirmCrop(page);
  await finishBatch(page);
  await goGrid(page);

  for (const [label, extension, signature] of [['长图', '.jpg', Buffer.from([0xff, 0xd8])], ['PDF', '.pdf', Buffer.from('%PDF')]]) {
    const pending = page.waitForEvent('download');
    await page.locator(`button:has-text("${label}")`).click();
    const download = await pending;
    const path = await download.path();
    const info = await stat(path);
    const head = (await readFile(path)).subarray(0, signature.length);
    t.check(`${label}下载产物可读且签名正确`, download.suggestedFilename().endsWith(extension)
      && info.size > 100 && head.equals(signature), `${info.size}B`);
  }

  docId = (await waitForCreatedDoc(since, doc => doc.outfits.length >= 2)).id;
  const detail = await waitForDetail(docId, doc => doc.outfits.length >= 2);
  const long = detail.outfits.find(outfit => outfit.kind === 'long');
  const pdf = detail.outfits.find(outfit => outfit.kind === 'pdf');
  const longFile = await bytes(long.file);
  const pdfFile = await bytes(pdf.file);
  t.check('US-E3 长图 Outfit 已归档且是 JPEG', longFile.ok && longFile.data.length > 100
    && longFile.data[0] === 0xff && longFile.data[1] === 0xd8, `${longFile.data.length}B`);
  t.check('US-E2 PDF Outfit 已归档且是 PDF', pdfFile.ok && pdfFile.data.subarray(0, 4).toString() === '%PDF', `${pdfFile.data.length}B`);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
