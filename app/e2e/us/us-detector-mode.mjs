import {
  PHOTOS, apiDetail, checks, confirmCrop, deleteDoc, finishBatch, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-A1/T4');
const since = Date.now();
let docId = null;
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);

  const modes = page.locator('.modechoice');
  t.check('五档检测模式在取景页常驻', await modes.count() === 5
    && (await modes.allTextContents()).join(',') === '自动,拍屏,文档,白板,名片');
  t.check('首次进入默认拍屏', await page.locator('.modechoice.active').getAttribute('data-mode') === 'screen');

  await page.locator('.modechoice[data-mode="businesscard"]').click();
  t.check('模式切换立即持久化', await page.evaluate(() => localStorage.getItem('ol_detection_mode')) === 'businesscard');

  await page.reload({ waitUntil: 'commit' });
  await page.locator('button:has-text("开始扫描")').waitFor();
  await openScanner(page);
  t.check('重进 app 恢复上次模式', await page.locator('.modechoice.active').getAttribute('data-mode') === 'businesscard');

  await importAlbum(page, PHOTOS.first);
  await confirmCrop(page);
  await finishBatch(page);
  docId = (await waitForCreatedDoc(since)).id;
  const detail = await apiDetail(docId);
  t.check('所选模式随页归档且裁剪确认流程可用', detail.pages.length === 1
    && detail.pages[0].detectMeta?.mode === 'businesscard');
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
