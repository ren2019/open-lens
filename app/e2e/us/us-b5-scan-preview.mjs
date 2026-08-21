import {
  API, AUTH, PHOTOS, apiDocs, canvasHash, checks, deleteDoc, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('CROP-SCAN-PREVIEW');
const session = await openApp();
const remoteId = `b5-preview-${Date.now()}`;
const captureSince = Date.now();
let captureId = null;

async function expectedScan(page, options) {
  return page.evaluate(async ({ enhancement, rotation }) => {
    const { state } = await import('/src/store.ts');
    const { warpPage } = await import('/src/imaging.ts');
    const item = state.session.items[0];
    const scan = await warpPage({
      id: item.pageId,
      originalBlob: item.blob,
      originalW: item.w,
      originalH: item.h,
      quad: item.quad.map(point => point.slice()),
      enhancement,
      rotation,
      edited: item.edited,
      detectMeta: item.detectMeta,
    }, 130);
    const data = scan.getContext('2d').getImageData(0, 0, scan.width, scan.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    }
    return { width: scan.width, height: scan.height, hash: hash >>> 0 };
  }, options);
}

async function previewSignature(page) {
  const preview = page.locator('.warpprev canvas');
  await preview.waitFor();
  return {
    width: await preview.evaluate(canvas => canvas.width),
    height: await preview.evaluate(canvas => canvas.height),
    hash: await canvasHash(preview),
  };
}

async function isGrayscale(preview) {
  return preview.evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    let sampled = 0;
    for (let i = 0; i < data.length; i += 16) {
      sampled++;
      if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 2) colored++;
    }
    return sampled > 0 && colored / sampled < 0.01;
  });
}

async function dragFirstCorner(page, dx = 78, dy = 62) {
  const canvas = page.locator('.crop canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 6 });
  await page.mouse.up();
}

async function assertPreview(page, story, label, { rotation, enhancement }) {
  const crop = page.locator('.crop');
  t.check(`${label}明确标注 Scan 预览`, await crop.getByRole('heading', { name: 'Scan 预览' }).count() === 1, '', story);
  const preview = page.locator('.warpprev canvas');
  const before = await previewSignature(page);
  const expected = await expectedScan(page, { rotation, enhancement: enhancement === '灰度' ? 'gray' : 'bw' });
  t.check(`${label}预览尺寸跟随最终 Scan`, before.width === expected.width && before.height === expected.height,
    `${before.width}x${before.height} vs ${expected.width}x${expected.height}`, story);
  t.check(`${label}预览像素遵循最终 Scan 的增强与旋转`, before.hash === expected.hash,
    `${before.hash} vs ${expected.hash}`, story);
  t.check(`${label}${enhancement}预览保留增强语义`, await isGrayscale(preview), '', story);
  await dragFirstCorner(page);
  await page.waitForFunction(previous => {
    const canvas = document.querySelector('.warpprev canvas');
    if (!canvas) return false;
    const context = canvas.getContext('2d');
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) !== previous;
  }, before);
  const after = await previewSignature(page);
  const changedExpected = await expectedScan(page, { rotation, enhancement: enhancement === '灰度' ? 'gray' : 'bw' });
  t.check(`${label}拖动 quad 后即时更新 Scan 像素`, after.hash !== before.hash, `${before.hash} -> ${after.hash}`, story);
  t.check(`${label}拖动 quad 后预览仍遵循最终 Scan`, after.width === changedExpected.width
    && after.height === changedExpected.height && after.hash === changedExpected.hash,
  `${after.width}x${after.height}/${after.hash} vs ${changedExpected.width}x${changedExpected.height}/${changedExpected.hash}`, story);
}

try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, PHOTOS.second);
  await page.locator('button:has-text("提交")').click();
  await page.locator('.cam').waitFor();
  await page.locator('.fab').click();
  await page.locator('.pedit').waitFor();
  await page.locator('button.btn:has-text("灰度")').click();
  await page.locator('button:has-text("旋转")').click();
  await page.locator('button:has-text("旋转")').click();
  await page.locator('button:has-text("旋转")').click();
  captureId = (await waitForCreatedDoc(captureSince, doc => doc.pageCount === 1)).id;
  await page.locator('[data-recrop-trigger]').click();
  await page.locator('.crop').waitFor();
  await assertPreview(page, 'US-B5', 'Capture/PageEdit 入口', { rotation: 270, enhancement: '灰度' });

  await page.getByRole('button', { name: '放弃修改并返回页编辑器' }).click();
  await page.locator('.pedit').waitFor();
  await page.getByRole('button', { name: '完成编辑并返回文档' }).click();
  await page.locator('.grid').waitFor();
  await page.getByRole('button', { name: '主页' }).click();
  await page.locator('.pad').waitFor();

  const seeded = await page.evaluate(async ({ api, auth, id }) => {
    const source = document.createElement('canvas');
    source.width = 640; source.height = 360;
    const context = source.getContext('2d');
    context.fillStyle = '#f4ecd8'; context.fillRect(0, 0, source.width, source.height);
    context.fillStyle = '#172238'; context.font = 'bold 42px sans-serif';
    context.fillText('Open-Lens Scan Preview', 56, 150);
    context.fillStyle = '#b95c28'; context.fillRect(56, 190, 528, 18);
    const blob = await (await fetch(source.toDataURL('image/jpeg', 0.92))).blob();
    const form = new FormData();
    form.set('meta', JSON.stringify({
      id, name: `US-D8 scan preview ${id}`, createdAt: Date.now(), tags: [],
      pages: [{ id: 'p0', quad: [[0, 0], [640, 0], [640, 360], [0, 360]], enhancement: 'bw', rotation: 90 }],
      outfits: [],
    }));
    form.set('original_0', blob, 'original.jpg');
    form.set('scan_0', blob, 'scan.jpg');
    const response = await fetch(`${api}/api/docs`, { method: 'POST', headers: auth, body: form });
    return response.ok;
  }, { api: API, auth: AUTH, id: remoteId });
  t.check('RemoteDetail 入口测试归档写入 Original/Scan', seeded, '', 'US-D8');

  await page.locator('button:has-text("历史")').click();
  await page.locator(`text=US-D8 scan preview ${remoteId}`).click();
  await page.locator('.remoteDetail').waitFor();
  await page.locator('.recropAction').click();
  await page.locator('.crop').waitFor();
  await assertPreview(page, 'US-D8', '资料库 RemoteDetail 入口', { rotation: 90, enhancement: '黑白' });
} finally {
  async function cleanDoc(id, story, label) {
    let deleted = false;
    try {
      if (id) {
        await deleteDoc(id);
        deleted = true;
      }
    } catch (error) {
      console.error(`cleanup ${label} delete failed:`, error.message);
    }
    let gone = false;
    try {
      const docs = await apiDocs();
      gone = !docs.some(doc => doc.id === id);
    } catch (error) {
      console.error(`cleanup ${label} verification failed:`, error.message);
    }
    t.check(`${label}文档清理后不再出现在归档列表`, deleted && gone, '', story);
  }
  try {
    await cleanDoc(captureId, 'US-B5', 'Capture');
  } finally {
    try {
      await cleanDoc(remoteId, 'US-D8', 'RemoteDetail');
    } finally {
      await session.browser.close();
    }
  }
}
t.finish();
