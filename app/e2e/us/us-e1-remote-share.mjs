import {
  API, AUTH, checks,
} from '../lib/harness.mjs';
import { chromium } from 'playwright';

const t = checks('US-E1');
const id = `e1-share-${Date.now()}`;
const name = `US-E1 share ${id}`;
const shareProbe = `
  window.__olShares = [];
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: ({ files }) => Array.isArray(files) && files.length === 1
      && files[0] instanceof File && files[0].type === 'image/jpeg',
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async payload => {
      const { files } = payload;
      const file = files[0];
      window.__olShares.push({
        keys: Object.keys(payload).sort(),
        url: payload.url ?? null,
        text: payload.text ?? null,
        hasBlob: Object.prototype.hasOwnProperty.call(payload, 'blob'),
        name: file.name, type: file.type,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())) });
    },
  });
`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(shareProbe);
const page = await context.newPage();
page.setDefaultTimeout(30000);
const unexpectedPageErrors = [];
const unexpectedConsoleErrors = [];
page.on('pageerror', error => unexpectedPageErrors.push(error.stack || error.message));
page.on('console', message => {
  if (message.type() === 'error') {
    const location = message.location();
    if (message.text().includes('Failed to load resource') && location.url.endsWith('/opencv.js')) {
      console.warn('EXPECTED OpenCV fallback resource miss:', message.text());
      return;
    }
    if (message.text().includes('Failed to load resource')
      && location.url === `${API}/api/docs` && message.text().includes('503')) {
      console.warn('EXPECTED archive upload failure:', message.text());
      return;
    }
    unexpectedConsoleErrors.push(`${message.text()} @ ${JSON.stringify(location)}`);
  }
});
await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
async function waitForHandler(completion, label) {
  let timer;
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const jpegs = await page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 320, 180);
  context.fillStyle = '#111'; context.font = 'bold 28px sans-serif'; context.fillText('E1 remote page 1', 24, 90);
  const first = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  context.fillStyle = '#fff'; context.fillRect(0, 0, 320, 180);
  context.fillStyle = '#111'; context.fillText('E1 remote page 2', 24, 90);
  return [first, canvas.toDataURL('image/jpeg', 0.9).split(',')[1]];
});
const bytes = jpegs.map(jpeg => Buffer.from(jpeg, 'base64'));
const form = new FormData();
form.set('meta', JSON.stringify({
  id, name, createdAt: Date.now(), tags: [],
  pages: [
    { id: 'p1', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 0 },
    { id: 'p2', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 90 },
  ], outfits: [],
}));
form.set('original_0', new Blob([bytes[0]], { type: 'image/jpeg' }), 'original-1.jpg');
form.set('scan_0', new Blob([bytes[0]], { type: 'image/jpeg' }), 'scan-1.jpg');
form.set('original_1', new Blob([bytes[1]], { type: 'image/jpeg' }), 'original-2.jpg');
form.set('scan_1', new Blob([bytes[1]], { type: 'image/jpeg' }), 'scan-2.jpg');
const seeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: AUTH, body: form });
t.check('归档详情测试页准备完成', seeded.ok);

try {
  await page.goto(process.env.OL_BASE || 'http://127.0.0.1:5173', { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.getByRole('button', { name: /历史/ }).click();
  await page.locator('.libraryGrid .card').filter({ hasText: name }).click();
  await page.locator('.remoteDetail').waitFor();
  await page.locator('.remoteDetail .filmstrip button').nth(1).click();
  await page.locator('.remoteDetail .hero span').filter({ hasText: '第 2 页' }).waitFor();
  await page.locator('.remoteDetail[data-share-ready="true"]').waitFor();
  await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
  await page.waitForFunction(() => window.__olShares.length === 1);
  const shared = await page.evaluate(() => window.__olShares[0]);
  t.check('归档详情当前第二页分享真实 JPEG File 且仅含 File payload', shared.keys.join(',') === 'files'
    && shared.url === null && shared.text === null && shared.hasBlob === false
    && shared.type === 'image/jpeg'
    && shared.name.endsWith('-2.jpg') && shared.bytes.length > 100
    && Buffer.from(shared.bytes).equals(bytes[1]) && !Buffer.from(shared.bytes).equals(bytes[0]),
  `${shared.name} ${shared.type} ${shared.bytes.length}B`);
  t.check('归档详情分享后仍停留在第二页', await page.locator('.remoteDetail .hero span').innerText() === '第 2 页');

  await page.locator('.recropAction').click();
  const cropCanvas = page.locator('.crop canvas').first();
  await cropCanvas.waitFor();
  const beforeQuad = await cropCanvas.getAttribute('data-quad');
  const cropBox = await cropCanvas.boundingBox();
  await page.mouse.move(cropBox.x + 4, cropBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(cropBox.x + 42, cropBox.y + 32, { steps: 4 });
  await page.mouse.up();
  const afterQuad = await cropCanvas.getAttribute('data-quad');
  const applyRecrop = page.getByRole('button', { name: '应用选区并返回归档详情' });
  const delayedArchiveCompletions = [];
  let holdNextPatchResponse = false;
  let patchHandlerEntered;
  let metadataReleasedAfterArchive = false;
  let oldArchiveResponsePromise = Promise.resolve();
  const patchHandlerEnteredDone = new Promise(resolve => { patchHandlerEntered = resolve; });
  const delayedArchive = async route => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    const tracked = method === 'POST' && pathname === '/api/docs';
    let handled;
    const completion = new Promise(resolve => { handled = resolve; });
    if (tracked) delayedArchiveCompletions.push(completion);
    try {
      if (tracked) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else if (method === 'PATCH' && pathname === `/api/docs/${id}` && holdNextPatchResponse) {
        holdNextPatchResponse = false;
        patchHandlerEntered();
        const patchResponse = await route.fetch();
        await oldArchiveResponsePromise;
        metadataReleasedAfterArchive = true;
        await route.fulfill({ response: patchResponse });
        return;
      }
      await route.continue();
    } finally {
      if (tracked) handled();
    }
  };
  await page.route('**/api/docs**', delayedArchive);
  const archiveRequest = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/docs', { timeout: 5000 });
  const overlapName = `${name} overlap`;
  let expectedPatchedTags = [];
  try {
    await (await applyRecrop.count() ? applyRecrop : page.locator('button:has-text("确认重切")')).click();
    await archiveRequest;
    await page.locator('.remoteDetail').waitFor();
    await page.evaluate(async () => {
      const { state, actions } = await import('/src/store.ts');
      if (!state?.remoteDoc || !actions?.openRecrop(state.remoteDoc.id, state.remotePageIdx, 'remotedetail')) {
        throw new Error('second pending recrop could not be opened');
      }
    });
    const secondCropCanvas = page.locator('.crop canvas').first();
    await secondCropCanvas.waitFor();
    const secondBeforeQuad = await secondCropCanvas.getAttribute('data-quad');
    const secondCropBox = await secondCropCanvas.boundingBox();
    await page.mouse.move(secondCropBox.x + 6, secondCropBox.y + 6);
    await page.mouse.down();
    await page.mouse.move(secondCropBox.x + 58, secondCropBox.y + 40, { steps: 4 });
    await page.mouse.up();
    const secondAfterQuad = await secondCropCanvas.getAttribute('data-quad');
    const secondApplyRecrop = page.getByRole('button', { name: '应用选区并返回归档详情' });
    const secondArchiveRequest = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/docs', { timeout: 5000 });
    const secondArchiveResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/docs' && response.ok(), { timeout: 10000 });
    oldArchiveResponsePromise = secondArchiveResponse;
    await (await secondApplyRecrop.count() ? secondApplyRecrop : page.locator('button:has-text("确认重切")')).click();
    await secondArchiveRequest;
    await page.locator('.remoteDetail[data-share-ready="false"]').waitFor();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.locator('.toast').filter({ hasText: 'Scan 准备中，请稍候再试' }).waitFor();
    t.check('连续远端重切 pending 期间不调用 Web Share', secondAfterQuad !== secondBeforeQuad
      && await page.evaluate(() => window.__olShares.length) === 1);
    holdNextPatchResponse = true;
    const overlapPatchResponse = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/docs/${id}` && response.ok(), { timeout: 5000 });
    await page.locator('input.detailName').fill(overlapName);
    await page.locator('input.detailName').evaluate(element => element.blur());
    await page.waitForFunction(expected => document.querySelector('input.detailName')?.value === expected, overlapName);
    await waitForHandler(patchHandlerEnteredDone, 'delayed metadata route entered');
    await secondArchiveResponse;
    const overlapPatchResult = await overlapPatchResponse;
    if (!overlapPatchResult.ok()) throw new Error('overlap name PATCH was not successful');
    const overlapTagResponse = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/docs/${id}` && response.ok(), { timeout: 5000 });
    await page.locator('.tagrow .chip').first().click();
    const overlapTagResult = await overlapTagResponse;
    expectedPatchedTags = (await overlapTagResult.json()).tags;
    t.check('PATCH response 延迟到旧归档 POST 完成之后', metadataReleasedAfterArchive);
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    t.check('改名 PATCH 已完成但连续重切仍不提前解锁分享',
      await page.evaluate(() => window.__olShares.length) === 1);
    await page.locator('.remoteDetail[data-share-ready="true"]').waitFor();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.waitForFunction(() => window.__olShares.length === 2);
    const recropped = await page.evaluate(() => window.__olShares[1]);
    const finalRearchive = await fetch(`${API}/api/docs/${id}`, { headers: AUTH });
    if (!finalRearchive.ok) throw new Error(`final rearchive detail returned ${finalRearchive.status}`);
    const finalRearchiveDetail = await finalRearchive.json();
    const finalRearchivePage = finalRearchiveDetail.pages[1];
    const finalScanResponse = await fetch(new URL(finalRearchivePage.scan, `${API}/`).toString(), { headers: AUTH });
    if (!finalScanResponse.ok) throw new Error(`final rearchive scan returned ${finalScanResponse.status}`);
    const finalScanBytes = Buffer.from(await finalScanResponse.arrayBuffer());
    t.check('连续重切最终归档 quad 与最终 Scan bytes 均来自第二次变换',
      JSON.stringify(finalRearchivePage.quad) === secondAfterQuad
      && finalScanBytes.equals(Buffer.from(recropped.bytes)));
    t.check('归档重切后失效旧 Share 并准备当前 Scan', afterQuad !== beforeQuad
      && recropped.keys.join(',') === 'files'
      && recropped.name === `${overlapName}-2.jpg`
      && !Buffer.from(recropped.bytes).equals(Buffer.from(shared.bytes)));
  } finally {
    let completionError;
    for (const [index, completion] of delayedArchiveCompletions.entries()) {
      try {
        await waitForHandler(completion, `delayed archive route ${index + 1}`);
      } catch (error) {
        completionError ||= error;
      }
    }
    try { if (completionError) throw completionError; }
    finally { await page.unroute('**/api/docs**', delayedArchive); }
  }

  const renamed = `${overlapName} renamed`;
  let delayedPatchHandled;
  const delayedPatchDone = new Promise(resolve => { delayedPatchHandled = resolve; });
  const delayedPatch = async route => {
    const tracked = route.request().method() === 'PATCH';
    if (tracked) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        await route.continue();
      } finally {
        delayedPatchHandled();
      }
      return;
    }
    await route.continue();
  };
  await page.route(`**/api/docs/${id}`, delayedPatch);
  const patchRequest = page.waitForRequest(request => request.method() === 'PATCH'
    && new URL(request.url()).pathname === `/api/docs/${id}`, { timeout: 5000 });
  const patchResponse = page.waitForResponse(response => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === `/api/docs/${id}` && response.ok(), { timeout: 5000 });
  try {
    await page.locator('input.detailName').fill(renamed);
    await page.locator('input.detailName').evaluate(element => element.blur());
    await patchRequest;
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.waitForTimeout(100);
    t.check('远端改名 PATCH pending 期间重复分享均不调用 Web Share',
      await page.evaluate(() => window.__olShares.length) === 2);
    await patchResponse;
    await waitForHandler(delayedPatchDone, 'delayed patch route');
    await page.waitForFunction(expected => document.querySelector('input.detailName')?.value === expected, renamed);
    await page.locator('.remoteDetail[data-share-ready="true"]').waitFor();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.waitForFunction(() => window.__olShares.length === 3);
    const renamedShare = await page.evaluate(() => window.__olShares[2]);
    t.check('改名提交期间旧文件名不可分享且完成后使用新文件名', renamedShare.name === `${renamed}-2.jpg`
      && renamedShare.keys.join(',') === 'files');
  } finally {
    try {
      await waitForHandler(delayedPatchDone, 'delayed patch route');
    } finally {
      await page.unroute(`**/api/docs/${id}`, delayedPatch);
    }
  }

  await page.locator('.recropAction').click();
  const failedCropCanvas = page.locator('.crop canvas').first();
  await failedCropCanvas.waitFor();
  const failedCropBox = await failedCropCanvas.boundingBox();
  await page.mouse.move(failedCropBox.x + 4, failedCropBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(failedCropBox.x + 52, failedCropBox.y + 36, { steps: 4 });
  await page.mouse.up();
  const failedApply = page.getByRole('button', { name: '应用选区并返回归档详情' });
  let failedArchiveAttempts = 0;
  const failedArchiveCompletions = [];
  const failedArchive = async route => {
    const tracked = route.request().method() === 'POST'
      && new URL(route.request().url()).pathname === '/api/docs';
    let handled;
    const completion = new Promise(resolve => { handled = resolve; });
    if (tracked) failedArchiveCompletions.push(completion);
    try {
      if (tracked) {
        failedArchiveAttempts++;
        if (failedArchiveAttempts === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
          return;
        }
      }
      await route.continue();
    } finally {
      if (tracked) handled();
    }
  };
  await page.route('**/api/docs', failedArchive);
  const failedArchiveRequest = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/docs', { timeout: 5000 });
  try {
    await (await failedApply.count() ? failedApply : page.locator('button:has-text("确认重切")')).click();
    await failedArchiveRequest;
    const automaticRetryRequest = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/docs', { timeout: 10000 });
    await page.waitForFunction(async () => {
      const { state } = await import('/src/store.ts');
      const doc = state.docs.find(item => item.id === state.remoteDoc?.id);
      return doc?.archive.status === 'queued' && doc.archive.attempts === 1;
    });
    await page.locator('.remoteDetail[data-share-ready="false"]').waitFor();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.locator('.toast').filter({ hasText: 'Scan 准备中，请稍候再试' }).waitFor();
    t.check('重切归档失败已由 store 处理且自动 retry 前不泄漏旧 Scan', failedArchiveAttempts === 1
      && await page.evaluate(() => window.__olShares.length) === 3);
    await automaticRetryRequest;
    await page.waitForFunction(() => window.__olShares.length === 3);
    await page.locator('.remoteDetail[data-share-ready="true"]').waitFor();
    await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
    await page.waitForFunction(() => window.__olShares.length === 4);
    const retriedShare = await page.evaluate(() => window.__olShares[3]);
    const recroppedBytes = await page.evaluate(() => window.__olShares[1].bytes);
    t.check('独立自动退避 retry 归档成功后准备并分享新 Scan', failedArchiveAttempts === 2
      && retriedShare.name === `${renamed}-2.jpg`
      && !Buffer.from(retriedShare.bytes).equals(Buffer.from(recroppedBytes)));
    const finalMetadataResponse = await fetch(`${API}/api/docs/${id}`, { headers: AUTH });
    if (!finalMetadataResponse.ok) throw new Error(`final metadata detail returned ${finalMetadataResponse.status}`);
    const finalMetadata = await finalMetadataResponse.json();
    t.check('归档完成后 GET 保留 PATCH 的 name 与 tags', finalMetadata.name === renamed
      && JSON.stringify(finalMetadata.tags) === JSON.stringify(expectedPatchedTags));
  } finally {
    let completionError;
    for (const [index, completion] of failedArchiveCompletions.entries()) {
      try {
        await waitForHandler(completion, `failed archive route ${index + 1}`);
      } catch (error) {
        completionError ||= error;
      }
    }
    try { if (completionError) throw completionError; }
    finally { await page.unroute('**/api/docs', failedArchive); }
  }
  let latePatchHandled;
  const latePatchDone = new Promise(resolve => { latePatchHandled = resolve; });
  const deleteDuringPatch = async route => {
    const method = route.request().method();
    if (method === 'PATCH') {
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.continue();
      } finally {
        latePatchHandled();
      }
      return;
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  };
  await page.route(`**/api/docs/${id}`, deleteDuringPatch);
  const latePatchRequest = page.waitForRequest(request => request.method() === 'PATCH'
    && new URL(request.url()).pathname === `/api/docs/${id}`, { timeout: 5000 });
  try {
    const lateUpdate = page.evaluate(async () => {
      const { actions } = await import('/src/store.ts');
      await actions.updateRemoteDoc({ name: 'late response must not resurrect' });
    });
    await latePatchRequest;
    await page.evaluate(async () => {
      const { state, actions } = await import('/src/store.ts');
      if (!state.remoteDoc) throw new Error('remote doc missing for delete race');
      actions.deleteDoc(state.remoteDoc.id);
    });
    await lateUpdate;
    await waitForHandler(latePatchDone, 'late patch after delete');
    const deletedState = await page.evaluate(async () => {
      const { state } = await import('/src/store.ts');
      return { remoteDoc: state.remoteDoc, shareReady: state.shareReady, shareFallback: state.shareFallback };
    });
    t.check('删除期间迟到 PATCH 不复活文档或 Share 状态', deletedState.remoteDoc === null
      && deletedState.shareReady === null && deletedState.shareFallback === null);
  } finally {
    try {
      await waitForHandler(latePatchDone, 'late patch after delete');
    } finally {
      await page.unroute(`**/api/docs/${id}`, deleteDuringPatch);
    }
  }
  t.check('分享流程无非预期 pageerror/console error', unexpectedPageErrors.length === 0
    && unexpectedConsoleErrors.length === 0,
  JSON.stringify({ unexpectedPageErrors, unexpectedConsoleErrors }));
} finally {
  try {
    const deleted = await fetch(`${API}/api/docs/${id}`, { method: 'DELETE', headers: AUTH });
    if (!deleted.ok) throw new Error(`remote cleanup returned ${deleted.status}`);
    const remaining = await fetch(`${API}/api/docs`, { headers: AUTH }).then(response => response.json());
    if (remaining.some(doc => doc.id === id)) throw new Error('remote cleanup left the document in the API');
  } finally {
    await browser.close();
  }
}
t.finish();
