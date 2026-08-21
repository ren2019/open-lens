import { readFile, stat } from 'node:fs/promises';
import {
  PHOTOS, bytes, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp,
  openScanner, waitForCreatedDoc, waitForDetail,
} from '../lib/harness.mjs';

const t = checks('US-E2');
const since = Date.now();
let docId = null;
const shareProbe = `
  window.__olShares = [];
  window.__olShareOutcomes = [];
  window.__olDownloads = [];
  window.__olShareMode = 'success';
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: blob => {
    const url = createObjectURL(blob);
    const record = { url, name: blob.name ?? null, type: blob.type, bytes: null, revoked: false };
    window.__olDownloads.push(record);
    void blob.arrayBuffer().then(buffer => { record.bytes = Array.from(new Uint8Array(buffer)); });
    return url;
  }});
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: url => {
    const record = window.__olDownloads.find(item => item.url === url);
    if (record) record.revoked = true;
    revokeObjectURL(url);
  }});
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: ({ files }) => Array.isArray(files) && files.length === 1
      && files[0] instanceof File && files[0].type === 'application/pdf',
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async payload => {
      if (window.__olShareMode === 'cancel') {
        window.__olShareOutcomes.push('cancelled');
        throw new DOMException('cancelled', 'AbortError');
      }
      if (window.__olShareMode === 'fail') {
        window.__olShareOutcomes.push('failed');
        throw new Error('share failed');
      }
      const file = payload.files?.[0];
      window.__olShares.push({
        keys: Object.keys(payload).sort(),
        url: payload.url ?? null,
        text: payload.text ?? null,
        name: file?.name ?? null,
        type: file?.type ?? null,
        bytes: file ? Array.from(new Uint8Array(await file.arrayBuffer())) : null,
      });
      window.__olShareOutcomes.push('shared');
    },
  });
`;

function isFileOnlyPayload(share) {
  return share.keys.join(',') === 'files' && share.url === null && share.text === null;
}
function shareSummary(share) {
  return share && { keys: share.keys, url: share.url, text: share.text,
    name: share.name, type: share.type, bytes: share.bytes?.length,
    head: share.bytes ? Buffer.from(share.bytes).subarray(0, 4).toString() : null };
}

async function observePdfAction(page, click, { shareCount = null, shareOutcome = null, fallback = false, timeout = 2000 } = {}) {
  let timer;
  let onDownload;
  const download = new Promise(resolve => {
    onDownload = async downloadEvent => {
      const path = await downloadEvent.path();
      resolve({ kind: 'download', name: downloadEvent.suggestedFilename(), bytes: (await readFile(path)).length });
    };
    page.on('download', onDownload);
  });
  const share = shareOutcome !== null ? page
    .waitForFunction(expected => window.__olShareOutcomes.includes(expected), shareOutcome, { timeout })
    .then(() => ({ kind: shareOutcome }))
    .catch(() => ({ kind: 'unavailable' })) : shareCount === null ? new Promise(() => {}) : page
    .waitForFunction(expected => window.__olShares.length === expected, shareCount, { timeout })
    .then(() => ({ kind: 'share' }))
    .catch(() => ({ kind: 'unavailable' }));
  const saved = fallback ? page.getByRole('button', { name: '保存 PDF' })
    .waitFor({ timeout }).then(() => ({ kind: 'fallback' }))
    .catch(() => ({ kind: 'unavailable' })) : new Promise(() => {});
  try {
    await page.evaluate(() => { window.__olDownloads = []; });
    await click();
    timer = setTimeout(() => {}, timeout);
    return await Promise.race([
      download,
      share,
      saved,
      new Promise(resolve => setTimeout(() => resolve({ kind: 'timeout' }), timeout)),
    ]);
  } finally {
    clearTimeout(timer);
    page.off('download', onDownload);
  }
}

const session = await openApp({ initScript: shareProbe });
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, [PHOTOS.first, PHOTOS.second]);
  await confirmCrop(page);
  await finishBatch(page);
  await goGrid(page);

  for (const [story, label, extension, signature] of [
    ['US-E3', '长图', '.jpg', Buffer.from([0xff, 0xd8])],
  ]) {
    const pending = page.waitForEvent('download');
    await page.locator(`button:has-text("${label}")`).click();
    const download = await pending;
    const path = await download.path();
    const info = await stat(path);
    const head = (await readFile(path)).subarray(0, signature.length);
    t.check(`${label}下载产物可读且签名正确`, download.suggestedFilename().endsWith(extension)
      && info.size > 100 && head.equals(signature), `${info.size}B`, story);
  }

  const pdfButton = page.getByRole('button', { name: 'PDF', exact: true });
  const localPdfOutcome = await observePdfAction(page, () => pdfButton.click(), { shareCount: 1 });
  const localPdfShare = await page.evaluate(() => window.__olShares[0] ?? null);
  t.check('新生成 PDF Outfit 直接分享真实 PDF File', localPdfOutcome.kind === 'share'
    && localPdfShare && isFileOnlyPayload(localPdfShare)
    && localPdfShare.name.endsWith('.pdf')
    && localPdfShare.type === 'application/pdf'
    && localPdfShare.bytes?.length > 100
    && Buffer.from(localPdfShare.bytes).subarray(0, 4).toString() === '%PDF',
  JSON.stringify(localPdfOutcome.kind === 'share' ? shareSummary(localPdfShare) : localPdfOutcome), 'US-E2');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  const unsupportedOutcome = await observePdfAction(page, () => pdfButton.click(), { fallback: true });
  t.check('不支持文件分享时提供 PDF 保存 fallback', unsupportedOutcome.kind === 'fallback',
    JSON.stringify(unsupportedOutcome), 'US-E2');

  const fallbackDownload = await observePdfAction(page, () => page.getByRole('button', { name: '保存 PDF' }).click());
  await page.waitForFunction(() => window.__olDownloads.some(item => item.revoked && item.bytes));
  const fallbackUrl = await page.evaluate(() => window.__olDownloads.at(-1));
  const fallbackFile = await page.evaluate(() => ({ name: document.querySelector('.shareFallback')?.textContent ?? '' }));
  t.check('PDF fallback 下载保持文件名与 PDF 类型', fallbackDownload.kind === 'download'
    && fallbackDownload.name.endsWith('.pdf') && fallbackDownload.bytes > 100
    && fallbackFile.name.includes('保存 PDF')
    && fallbackUrl.name.endsWith('.pdf') && fallbackUrl.type === 'application/pdf'
    && fallbackUrl.bytes.length === fallbackDownload.bytes && fallbackUrl.revoked,
  JSON.stringify({ fallbackDownload, fallbackFile, url: { name: fallbackUrl.name, type: fallbackUrl.type,
    bytes: fallbackUrl.bytes.length, revoked: fallbackUrl.revoked } }), 'US-E2');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    window.__olShareMode = 'cancel';
  });
  const cancelOutcome = await observePdfAction(page, () => pdfButton.click(), { shareOutcome: 'cancelled' });
  t.check('取消 PDF 分享留在原页面且无误报', cancelOutcome.kind === 'cancelled'
    && await page.locator('.toast').filter({ hasText: '分享失败' }).count() === 0
    && await page.locator('.pad').count() === 1, JSON.stringify(cancelOutcome), 'US-E2');

  await page.evaluate(() => { window.__olShareMode = 'fail'; });
  const failedOutcome = await observePdfAction(page, () => pdfButton.click(), { shareOutcome: 'failed' });
  await page.getByText('分享失败，请重试').waitFor();
  t.check('PDF 分享失败可见且不导航', failedOutcome.kind === 'failed'
    && await page.locator('.pad').count() === 1, JSON.stringify(failedOutcome), 'US-E2');

  docId = (await waitForCreatedDoc(since, doc => doc.outfits.length >= 2)).id;
  const detail = await waitForDetail(docId, doc => doc.outfits.length >= 2);
  const long = detail.outfits.find(outfit => outfit.kind === 'long');
  const pdf = detail.outfits.find(outfit => outfit.kind === 'pdf');
  const longFile = await bytes(long.file);
  const pdfFile = await bytes(pdf.file);
  t.check('长图 Outfit 已归档且是 JPEG', longFile.ok && longFile.data.length > 100
    && longFile.data[0] === 0xff && longFile.data[1] === 0xd8, `${longFile.data.length}B`, 'US-E3');
  t.check('PDF Outfit 已归档且是 PDF', pdfFile.ok && pdfFile.data.subarray(0, 4).toString() === '%PDF', `${pdfFile.data.length}B`);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
