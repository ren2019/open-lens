import {
  PHOTOS, apiDetail, apiDocs, bytes, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login,
  openApp, openScanner, waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-F1');
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
  await page.locator('.bar .ok').waitFor();
  t.check('会话结束后自动归档完成', (await page.locator('.bar .ok').innerText()).includes('已归档'));

  const summary = await waitForCreatedDoc(since);
  docId = summary.id;
  const list = await apiDocs();
  t.check('服务端列表出现新文档', list.some(doc => doc.id === docId && doc.pageCount === 1));
  const detail = await apiDetail(docId);
  t.check('详情保存 Original 与 Scan 路径', detail.pages.length === 1
    && !!detail.pages[0].original && !!detail.pages[0].scan);
  t.check('US-T4: 未修正页上传检测模式/耗时/来源', detail.pages[0].edited === false
    && detail.pages[0].detectMeta?.mode === 'screen'
    && detail.pages[0].detectMeta?.source === 'mobile-album'
    && Number.isFinite(detail.pages[0].detectMeta?.ms));
  const original = await bytes(detail.pages[0].original);
  const scan = await bytes(detail.pages[0].scan);
  t.check('Original 文件可读取', original.ok && original.type === 'image/jpeg' && original.data.length > 100, `${original.data.length}B`);
  t.check('Scan 文件可读取', scan.ok && scan.type === 'image/jpeg' && scan.data.length > 100, `${scan.data.length}B`);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
