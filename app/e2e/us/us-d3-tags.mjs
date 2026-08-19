import {
  PHOTOS, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-D3');
const since = Date.now();
let docId = null;
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, PHOTOS.first);
  await confirmCrop(page);
  await finishBatch(page);
  await goGrid(page);
  await page.locator('button.chip:has-text("板书")').click();
  t.check('手机端标签切换立即生效', await page.locator('button.chip.on:has-text("板书")').count() === 1);
  docId = (await waitForCreatedDoc(since)).id;
  const detail = await waitForDetail(docId, doc => doc.tags.includes('板书'));
  t.check('标签持久化到服务端 SQLite', detail.tags.includes('板书'), detail.tags.join(','));
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
