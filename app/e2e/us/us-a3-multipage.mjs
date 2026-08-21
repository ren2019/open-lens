import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  API, AUTH, PHOTOS, bytes, checks, confirmCrop, deleteDoc, finishBatch, importAlbum, login, openApp,
  openScanner, waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-A3');
const since = Date.now();
const inputs = [PHOTOS.first, PHOTOS.second, PHOTOS.third];
const digest = data => createHash('sha256').update(data).digest('hex');
const expectedOrder = await Promise.all(inputs.map(async path => digest(await readFile(path))));
let docId = null;
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  for (let index = 0; index < inputs.length; index++) {
    await importAlbum(page, inputs[index]);
    await confirmCrop(page);
    await page.locator('.cam').waitFor();
    t.check(`第 ${index + 1} 页确认后返回取景继续采集`,
      (await page.locator('.strip').innerText()).includes(`已拍 ${index + 1} 页`));
  }
  await finishBatch(page);
  t.check('完成会话后生成 3 页文档', (await page.locator('.pedit .bar b').innerText()) === '第 3 / 3 页');

  const summary = await waitForCreatedDoc(since, doc => doc.pageCount === 3);
  docId = summary.id;
  const detail = await fetch(`${API}/api/docs/${docId}`, { headers: AUTH }).then(response => response.json());
  const actualOrder = [];
  for (const pageInfo of detail.pages) actualOrder.push(digest((await bytes(pageInfo.original)).data));
  t.check('服务端 3 页 Original 顺序等于采集顺序', JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    actualOrder.map(value => value.slice(0, 8)).join(' → '));
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
