import { createHash } from 'node:crypto';
import {
  PHOTOS, bytes, checks, confirmCrop, deleteDoc, finishBatch, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-F3');
const since = Date.now();
let docId = null;
let multiDocId = null;
const sha = data => createHash('sha256').update(data).digest('hex');
const BW_90_SCAN_ORACLE = {
  sha: 'e1bfb154fd2bbe4cc5a12dc52c06bd81b57971f72812417c35e86b080160f751',
  pixels: { width: 1400, height: 3161, pixelHash: 2213777303 },
};
const decodedScan = (page, data) => page.evaluate(async base64 => {
  const encoded = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([encoded], { type: 'image/jpeg' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let pixelHash = 2166136261;
  for (let index = 0; index < pixels.length; index += 4) {
    pixelHash ^= pixels[index]; pixelHash = Math.imul(pixelHash, 16777619);
    pixelHash ^= pixels[index + 1]; pixelHash = Math.imul(pixelHash, 16777619);
    pixelHash ^= pixels[index + 2]; pixelHash = Math.imul(pixelHash, 16777619);
  }
  return { width: canvas.width, height: canvas.height, pixelHash: pixelHash >>> 0 };
}, data.toString('base64'));
const session = await openApp({
  initScript: () => {
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.setTimeout = (handler, timeout = 0, ...args) =>
      nativeSetTimeout(handler, Math.min(timeout, 50), ...args);

    const writableProto = globalThis.FileSystemWritableFileStream?.prototype;
    if (writableProto && !writableProto.__openLensCloseWrapped) {
      const close = writableProto.close;
      Object.defineProperty(writableProto, '__openLensCloseWrapped', { value: true });
      writableProto.close = async function (...args) {
        while (globalThis.__openLensHoldOpfsClose) {
          await new Promise(resolve => nativeSetTimeout(resolve, 20));
        }
        return close.apply(this, args);
      };
    }

    const handleProto = globalThis.FileSystemFileHandle?.prototype;
    if (handleProto && !handleProto.__openLensWritableWrapped) {
      const createWritable = handleProto.createWritable;
      Object.defineProperty(handleProto, '__openLensWritableWrapped', { value: true });
      handleProto.createWritable = function (...args) {
        if (globalThis.__openLensFailOpfsWrites) {
          return Promise.reject(new DOMException('US-F3 forced OPFS failure', 'QuotaExceededError'));
        }
        return createWritable.apply(this, args);
      };
    }

    const canvasProto = globalThis.HTMLCanvasElement.prototype;
    if (!canvasProto.__openLensToBlobWrapped) {
      const toBlob = canvasProto.toBlob;
      Object.defineProperty(canvasProto, '__openLensToBlobWrapped', { value: true });
      canvasProto.toBlob = function (callback, ...args) {
        return toBlob.call(this, blob => {
          if (!globalThis.__openLensHoldNextScanBlob) {
            callback(blob);
            return;
          }
          globalThis.__openLensHoldNextScanBlob = false;
          globalThis.__openLensScanBlobHeld = true;
          globalThis.__openLensReleaseScanBlob = () => {
            globalThis.__openLensScanBlobHeld = false;
            globalThis.__openLensReleaseScanBlob = null;
            callback(blob);
          };
        }, ...args);
      };
    }
  },
});

try {
  const { context, page } = session;
  await login(page);
  await openScanner(page);
  await context.setOffline(true);
  await page.evaluate(() => { globalThis.__openLensHoldOpfsClose = true; });
  await importAlbum(page, PHOTOS.second);
  await confirmCrop(page);
  await finishBatch(page);

  const editor = page.locator('.pedit');
  const title = editor.locator('.pageTitle');
  const pageNumber = editor.locator('.pageNumber');
  const saveStatus = editor.locator('.saveStatus');
  t.check('新 Capture 进入编辑器后显示当前文档和 Page 上下文',
    await title.count() === 1
      && (await title.textContent())?.trim().length > 0
      && await pageNumber.textContent().catch(() => '') === '第 1 / 1 页');
  t.check('本机写入真实未完成时显示保存中且归档待上传',
    await saveStatus.count() === 1
      && (await saveStatus.textContent())?.includes('正在保存')
      && (await saveStatus.textContent())?.includes('待上传'));

  await page.evaluate(() => { globalThis.__openLensHoldOpfsClose = false; });
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('已自动保存到本机'))
    .catch(() => {});
  t.check('本机写入完成后才显示已自动保存且离线仍待上传',
    (await saveStatus.textContent().catch(() => ''))?.includes('已自动保存到本机')
      && (await saveStatus.textContent().catch(() => ''))?.includes('待上传'));

  const complete = editor.getByRole('button', { name: '完成编辑并返回文档' });
  t.check('页编辑器提供语义明确的完成出口', await complete.count() === 1);
  if (await complete.count()) await complete.click();
  else if (await editor.locator('button:has-text("网格")').count()) await editor.locator('button:has-text("网格")').click();
  await page.locator('.grid').waitFor();
  t.check('完成返回当前文档的页面工作区和当前 Page',
    await page.locator('.grid .cell').count() === 1
      && await page.locator('.grid .cell[data-current="true"]').count() === 1);

  await context.setOffline(false);
  docId = (await waitForCreatedDoc(since, doc => doc.pageCount === 1)).id;
  const currentPage = page.locator('.grid .cell[data-current="true"]');
  await currentPage.click();
  await editor.waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('pageTitle'));
  t.check('从文档页面进入同一 Page 并把焦点放到编辑上下文',
    await pageNumber.textContent() === '第 1 / 1 页'
      && await page.evaluate(() => document.activeElement?.classList.contains('pageTitle')));

  await page.evaluate(() => { globalThis.__openLensHoldOpfsClose = true; });
  await editor.getByRole('button', { name: '灰度' }).click();
  await editor.getByRole('button', { name: '旋转' }).click();
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('正在保存'));
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);
  await page.locator('.grid').waitFor();
  t.check('浏览器返回在保存中安全交接并回到同一文档当前 Page',
    await page.locator('.grid .cell[data-current="true"]').count() === 1
      && await page.evaluate(() => document.activeElement?.dataset.pageId?.length > 0));
  await page.evaluate(() => { globalThis.__openLensHoldOpfsClose = false; });

  const edited = await waitForDetail(docId, detail => detail.pages[0]?.enhancement === 'gray'
    && detail.pages[0]?.rotation === 90);
  t.check('保存中返回后 Enhancement 与旋转仍经真实归档生效',
    edited.pages[0].enhancement === 'gray' && edited.pages[0].rotation === 90);

  await page.locator('.grid .cell[data-current="true"]').click();
  await editor.waitFor();
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('已归档'));
  t.check('重新进入同一 Page 显示已自动保存与已归档的独立事实',
    (await saveStatus.textContent())?.includes('已自动保存')
      && (await saveStatus.textContent())?.includes('已归档')
      && await editor.locator('button.primary', { hasText: '灰度' }).count() === 1);

  for (let index = 0; index < 3; index++) await editor.getByRole('button', { name: '旋转' }).click();
  const staleBaseline = await waitForDetail(docId, detail => detail.pages[0]?.enhancement === 'gray'
    && detail.pages[0]?.rotation === 0);
  const staleScan = (await bytes(`${staleBaseline.pages[0].scan}?v=${Date.now()}`)).data;
  const stalePixels = await decodedScan(page, staleScan);

  await page.evaluate(() => { globalThis.__openLensHoldNextScanBlob = true; });
  await editor.getByRole('button', { name: '灰度' }).click();
  await page.waitForFunction(() => globalThis.__openLensScanBlobHeld === true);
  await editor.getByRole('button', { name: '黑白' }).click();
  await editor.getByRole('button', { name: '旋转' }).click();
  await page.evaluate(() => globalThis.__openLensReleaseScanBlob?.());
  const racedFinal = await waitForDetail(docId, detail => detail.pages[0]?.enhancement === 'bw'
    && detail.pages[0]?.rotation === 90);
  const racedFinalScan = (await bytes(`${racedFinal.pages[0].scan}?v=${Date.now()}`)).data;
  const racedFinalPixels = await decodedScan(page, racedFinalScan);
  t.check('快速 Enhancement 与旋转后公开归档 Scan 对应最终 Page 输入',
    sha(racedFinalScan) === BW_90_SCAN_ORACLE.sha
      && racedFinalPixels.pixelHash === BW_90_SCAN_ORACLE.pixels.pixelHash
      && racedFinalPixels.width === BW_90_SCAN_ORACLE.pixels.width
      && racedFinalPixels.height === BW_90_SCAN_ORACLE.pixels.height
      && sha(racedFinalScan) !== sha(staleScan)
      && racedFinalPixels.pixelHash !== stalePixels.pixelHash,
    JSON.stringify({
      expectedSha: BW_90_SCAN_ORACLE.sha, actualSha: sha(racedFinalScan), staleSha: sha(staleScan),
      expectedPixels: BW_90_SCAN_ORACLE.pixels, actualPixels: racedFinalPixels, stalePixels,
    }));

  let uploadFailures = 0;
  await page.route('**/api/docs', route => {
    if (route.request().method() === 'POST') {
      uploadFailures++;
      return route.fulfill({ status: 500, body: 'US-F3 forced upload failure' });
    }
    return route.continue();
  });
  await editor.getByRole('button', { name: '彩色增强' }).click();
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('上传失败'));
  t.check('上传失败不抹掉已完成的本机保存并提供上传重试',
    uploadFailures === 5
      && (await saveStatus.textContent())?.includes('已自动保存到本机')
      && await editor.getByRole('button', { name: '重试上传' }).count() === 1);
  await page.unroute('**/api/docs');
  await editor.getByRole('button', { name: '重试上传' }).click();
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('已归档'));
  const retried = await waitForDetail(docId, detail => detail.pages[0]?.enhancement === 'color');
  t.check('上传重试沿既有归档队列恢复且保留编辑结果', retried.pages[0].enhancement === 'color');

  await context.setOffline(true);
  await page.evaluate(() => { globalThis.__openLensFailOpfsWrites = true; });
  await editor.getByRole('button', { name: '黑白' }).click();
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('本机持久化失败'));
  t.check('本机持久化失败与上传失败分开反馈并保留会话内修改',
    (await saveStatus.textContent())?.includes('本次会话仍保留')
      && (await saveStatus.textContent())?.includes('待上传')
      && !(await saveStatus.textContent())?.includes('上传失败')
      && await editor.getByRole('button', { name: '重试本机保存' }).count() === 1);
  await page.evaluate(() => { globalThis.__openLensFailOpfsWrites = false; });
  await editor.getByRole('button', { name: '重试本机保存' }).click();
  await page.waitForFunction(() => document.querySelector('.saveStatus')?.textContent?.includes('已自动保存到本机'));
  t.check('本机保存重试由真实 OPFS 完成信号恢复并保持待上传',
    (await saveStatus.textContent())?.includes('已自动保存到本机')
      && (await saveStatus.textContent())?.includes('待上传'));
  const persistedRetry = await page.evaluate(async id => {
    const queue = await (await navigator.storage.getDirectory()).getDirectoryHandle('ol-queue');
    const doc = await queue.getDirectoryHandle(id);
    const meta = JSON.parse(await (await (await doc.getFileHandle('meta.json')).getFile()).text());
    const payload = await doc.getDirectoryHandle(meta.payloadDir);
    const files = [];
    for await (const name of payload.keys()) files.push(name);
    return files.sort();
  }, docId);
  t.check('本机保存重试提交完整 Original 与 Scan 后才报告成功',
    persistedRetry.includes('original_0.jpg') && persistedRetry.includes('scan_0.jpg'),
    persistedRetry.join(',') || '(空 payload)');
  await context.setOffline(false);
  const locallyRetried = await waitForDetail(docId, detail => detail.pages[0]?.enhancement === 'bw');
  t.check('本机保存恢复后黑白 Enhancement 最终归档', locallyRetried.pages[0].enhancement === 'bw');

  await complete.click();
  await page.locator('.grid').waitFor();
  await page.locator('button:has-text("主页")').click();
  const multiSince = Date.now();
  await openScanner(page);
  for (const photo of [PHOTOS.second, PHOTOS.third]) {
    await importAlbum(page, photo);
    await confirmCrop(page);
  }
  await finishBatch(page);
  multiDocId = (await waitForCreatedDoc(multiSince, doc => doc.id !== docId && doc.pageCount === 2)).id;
  const multiHistoryLength = await page.evaluate(() => history.length);
  await page.locator('.viewer .nav').first().click();
  await page.locator('.pageNumber').filter({ hasText: '第 1 / 2 页' }).waitFor();
  await page.getByRole('button', { name: '完成编辑并返回文档' }).click();
  await page.locator('.grid').waitFor();
  const completedHistoryLength = await page.evaluate(() => history.length);
  await page.locator('.grid .cell[data-current="true"]').click();
  await page.locator('.pedit').waitFor();
  const reopenedHistoryLength = await page.evaluate(() => history.length);
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForTimeout(100);
  t.check('多页翻页完成后重开再返回仍落在当前 Page 工作区且 history 不膨胀',
    await page.locator('.grid .cell').count() === 2
      && await page.locator('.grid .cell[data-current="true"]').count() === 1
      && await page.locator('.grid .cell[data-current="true"]').getAttribute('data-page-id')
        === await page.locator('.grid .cell').first().getAttribute('data-page-id')
      && completedHistoryLength === multiHistoryLength
      && reopenedHistoryLength === multiHistoryLength
      && await page.evaluate(() => history.length) === multiHistoryLength,
    JSON.stringify({ multiHistoryLength, completedHistoryLength, reopenedHistoryLength }));
} finally {
  await session.browser.close();
  await deleteDoc(docId);
  await deleteDoc(multiDocId);
}

t.finish();
