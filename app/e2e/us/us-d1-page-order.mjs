import {
  PHOTOS, apiDetail, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp,
  openScanner, waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-D1');
const since = Date.now();
let docId = null;
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, [PHOTOS.first, PHOTOS.second, PHOTOS.third]);
  await confirmCrop(page);
  await finishBatch(page);
  await goGrid(page);

  docId = (await waitForCreatedDoc(since, doc => doc.pageCount === 3)).id;
  const initial = await apiDetail(docId);
  const initialIds = initial.pages.map(pageInfo => pageInfo.id);
  await page.locator('.grid .cell').nth(0).locator('button').last().click();
  const reorderedIds = [initialIds[1], initialIds[0], initialIds[2]];
  const reordered = await waitForDetail(docId,
    doc => JSON.stringify(doc.pages.map(pageInfo => pageInfo.id)) === JSON.stringify(reorderedIds));
  t.check('页序调整后服务端 idx 顺序同步',
    JSON.stringify(reordered.pages.map(pageInfo => pageInfo.id)) === JSON.stringify(reorderedIds),
    reordered.pages.map(pageInfo => pageInfo.id.slice(-8)).join(' → '));

  await page.locator('.grid .cell').nth(2).click();
  await page.locator('.pedit').waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('button:has-text("删页")').click();
  const afterDelete = await waitForDetail(docId, doc => doc.pages.length === 2);
  t.check('删页后服务端页数减少且保留当前顺序', afterDelete.pages.length === 2
    && JSON.stringify(afterDelete.pages.map(pageInfo => pageInfo.id)) === JSON.stringify(reorderedIds.slice(0, 2)),
  `pages=${afterDelete.pages.length}`);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
