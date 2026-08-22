import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  API, AUTH, PHOTOS, checks, confirmCrop, finishBatch, importAlbum, login, openApp,
  openScanner, waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-E1');
const since = Date.now();
let localDocId = null;
// Tracked PHOTOS.second/third fixture oracle, recorded independently of the production transform chain.
const EXPECTED_SCAN_SHA256 = Object.freeze({
  page1: 'cd1652cca64fa9794807bd373f541306794cb594d2c57579e337f922af13bec9',
  page2: '6c2fefbfa2b347ee1ae782664004617b4800b14427c96a899f12e9d693909462',
});

const shareProbe = `
  window.__olShares = [];
  window.__olShareMode = 'success';
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: ({ files }) => Array.isArray(files) && files.length === 1
      && files[0] instanceof File && files[0].type === 'image/jpeg',
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async payload => {
      const { files } = payload;
      if (window.__olShareMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
      if (window.__olShareMode === 'fail') throw new Error('share failed');
      const file = files[0];
      window.__olShares.push({
        keys: Object.keys(payload).sort(),
        url: payload.url ?? null,
        text: payload.text ?? null,
        hasBlob: Object.prototype.hasOwnProperty.call(payload, 'blob'),
        name: file.name,
        type: file.type,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      });
    },
  });
`;

async function probe(page, count) {
  await page.waitForFunction(expected => window.__olShares.length >= expected, count);
  return page.evaluate(() => window.__olShares);
}

async function transformedOracle(page, bytes) {
  const ui = await page.locator('.pedit canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  const decoded = await page.evaluate(async data => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let gray = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
        - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) <= 3) gray++;
    }
    return { width: canvas.width, height: canvas.height, grayRatio: gray / (pixels.length / 4) };
  }, bytes);
  return { ui, decoded };
}

function isFileOnlyPayload(share) {
  return share.keys.join(',') === 'files'
    && share.url === null && share.text === null && share.hasBlob === false;
}
const sha256 = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

const session = await openApp({ initScript: shareProbe });
const { page } = session;
try {
  await login(page);
  await openScanner(page);
  await importAlbum(page, [PHOTOS.second, PHOTOS.third]);
  await confirmCrop(page);
  await page.context().setOffline(true);
  await finishBatch(page);
  localDocId = await page.locator('.pedit').getAttribute('data-doc-id');
  const queueBefore = await page.locator('.queueIndicator').innerText();
  const docsBeforeShare = await fetch(`${API}/api/docs`, { headers: AUTH }).then(response => response.json());
  t.check('离线本地 Page 有确定 docId 且尚未归档', !!localDocId && !docsBeforeShare.some(doc => doc.id === localDocId));

  await page.getByRole('button', { name: '旋转' }).click();
  await page.getByRole('button', { name: '灰度' }).click();
  await page.locator('.pedit[data-share-ready="true"]').waitFor();
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  const first = (await probe(page, 1)).at(-1);
  const firstOracle = await transformedOracle(page, first.bytes);
  t.check('离线当前页分享真实 JPEG File 且仅含 File payload', isFileOnlyPayload(first)
    && first.type === 'image/jpeg'
    && first.name.endsWith('-2.jpg')
    && !(await fetch(`${API}/api/docs`, { headers: AUTH }).then(response => response.json())).some(doc => doc.id === localDocId)
    && await page.locator('.queueIndicator').innerText() === queueBefore);
  t.check('分享 JPEG 是旋转后灰度 Scan 的独立变换结果', firstOracle.decoded.grayRatio > 0.98
    && sha256(first.bytes) === EXPECTED_SCAN_SHA256.page2
    && Math.abs(firstOracle.decoded.height / firstOracle.decoded.width
      - firstOracle.ui.height / firstOracle.ui.width) < 0.02,
  `${firstOracle.decoded.width}x${firstOracle.decoded.height} gray=${firstOracle.decoded.grayRatio.toFixed(3)} sha256=${sha256(first.bytes)}`);

  await page.getByRole('button', { name: '上一页' }).click();
  await page.locator('.pedit[data-share-ready="true"]').waitFor();
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  const second = (await probe(page, 2)).at(-1);
  t.check('切换当前页后分享对应 Scan 而非固定第一页', isFileOnlyPayload(second)
    && second.name.endsWith('-1.jpg')
    && sha256(second.bytes) === EXPECTED_SCAN_SHA256.page1
    && second.bytes.join(',') !== first.bytes.join(','), `${second.name} sha256=${sha256(second.bytes)}`);

  await page.evaluate(() => { window.__olShareMode = 'cancel'; });
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  await page.waitForTimeout(50);
  t.check('取消分享不报错且仍在原页', await page.locator('.pedit').count() === 1
    && await page.locator('.toast').count() === 0);

  await page.evaluate(() => { window.__olShareMode = 'fail'; });
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  await page.locator('.toast').filter({ hasText: '分享失败，请重试' }).waitFor();
  t.check('分享失败可见且仍在原页', await page.locator('.pedit').count() === 1);
  await page.evaluate(() => { window.__olShareMode = 'success'; });
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  const retryShares = await probe(page, 3);
  const retry = retryShares.at(-1);
  t.check('失败后可重试成功且仍仅分享当前 JPEG File', retryShares.length === 3
    && isFileOnlyPayload(retry)
    && retry.type === 'image/jpeg'
    && retry.name === second.name
    && retry.bytes.join(',') === second.bytes.join(','));

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  });
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  await page.getByRole('button', { name: '保存 JPEG' }).waitFor();
  await page.getByRole('button', { name: '下一页' }).click();
  t.check('切换页后旧 JPEG 回退不可保存', await page.getByRole('button', { name: '保存 JPEG' }).count() === 0);
  await page.getByRole('button', { name: '上一页' }).click();
  await page.locator('.pedit[data-share-ready="true"]').waitFor();
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  await page.getByRole('button', { name: '保存 JPEG' }).waitFor();
  await page.getByRole('button', { name: '灰度' }).click();
  t.check('Scan Enhancement 变化后旧 JPEG 回退不可保存', await page.getByRole('button', { name: '保存 JPEG' }).count() === 0);
  await page.locator('.pedit[data-share-ready="true"]').waitFor();
  await page.getByRole('button', { name: '分享当前 Scan' }).click();
  await page.getByRole('button', { name: '保存 JPEG' }).waitFor();
  const fallbackDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存 JPEG' }).click();
  const fallbackDownload = await fallbackDownloadPromise;
  const fallbackBytes = await readFile(await fallbackDownload.path());
  const fallbackOracle = await transformedOracle(page, [...fallbackBytes]);
  t.check('JPEG 回退是当前灰度 Scan 且具备文件名与内容', fallbackDownload.suggestedFilename().endsWith('.jpg')
    && fallbackBytes.length > 100 && fallbackOracle.decoded.grayRatio > 0.98,
  `${fallbackDownload.suggestedFilename()} ${fallbackBytes.length}B gray=${fallbackOracle.decoded.grayRatio.toFixed(3)}`);
} finally {
  try {
    if (localDocId) {
      await page.context().setOffline(false);
      await waitForCreatedDoc(since, doc => doc.id === localDocId);
      const deleted = await fetch(`${API}/api/docs/${localDocId}`, { method: 'DELETE', headers: AUTH });
      if (!deleted.ok) throw new Error(`local cleanup returned ${deleted.status}`);
      const remaining = await fetch(`${API}/api/docs`, { headers: AUTH }).then(response => response.json());
      if (remaining.some(doc => doc.id === localDocId)) throw new Error('local cleanup left the document in the API');
    }
  } finally {
    await session.browser.close();
  }
}
t.finish();
