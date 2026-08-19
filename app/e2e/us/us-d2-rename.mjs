import {
  PHOTOS, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-D2');
const since = Date.now();
const renamed = `US-D2 e2e ${since}`;
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
  docId = (await waitForCreatedDoc(since)).id;

  await page.locator('.bar b').click();
  const input = page.locator('.bar input.textField');
  await input.fill(renamed);
  await input.press('Enter');
  t.check('文档标题在本地改名并退出编辑态', await page.locator('.bar b', { hasText: renamed }).count() === 1);
  const detail = await waitForDetail(docId, doc => doc.name === renamed);
  t.check('改名同步到服务端', detail.name === renamed, detail.name);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
