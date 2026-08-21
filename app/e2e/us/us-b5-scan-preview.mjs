import {
  API, AUTH, PHOTOS, canvasHash, checks, deleteDoc, importAlbum, login, openApp, openScanner,
} from '../lib/harness.mjs';

const t = checks('CROP-SCAN-PREVIEW');
const session = await openApp();
const remoteId = `b5-preview-${Date.now()}`;

async function expectedRatio(canvas) {
  const quad = JSON.parse(await canvas.getAttribute('data-quad'));
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const width = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  return width / height;
}

async function previewRatio(page) {
  const preview = page.locator('.warpprev canvas');
  await preview.waitFor();
  return {
    actual: await preview.evaluate(canvas => canvas.width / canvas.height),
    expected: await expectedRatio(page.locator('.crop canvas').first()),
  };
}

async function dragFirstCorner(page, dx = 78, dy = 62) {
  const canvas = page.locator('.crop canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 6 });
  await page.mouse.up();
}

async function assertPreview(page, story, label) {
  const crop = page.locator('.crop');
  t.check(`${label}明确标注 Scan 预览`, await crop.getByRole('heading', { name: 'Scan 预览' }).count() === 1, '', story);
  const before = await canvasHash(page.locator('.warpprev canvas'));
  const ratio = await previewRatio(page);
  t.check(`${label}预览比例跟随当前 Scan`, Math.abs(ratio.actual - ratio.expected) < 0.03,
    `${ratio.actual.toFixed(3)} vs ${ratio.expected.toFixed(3)}`, story);
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
  const after = await canvasHash(page.locator('.warpprev canvas'));
  t.check(`${label}拖动 quad 后即时更新 Scan 像素`, after !== before, `${before} -> ${after}`, story);
  const changedRatio = await previewRatio(page);
  t.check(`${label}拖动 quad 后预览仍跟随 Scan 比例`, Math.abs(changedRatio.actual - changedRatio.expected) < 0.03,
    `${changedRatio.actual.toFixed(3)} vs ${changedRatio.expected.toFixed(3)}`, story);
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
  await page.locator('[data-recrop-trigger]').click();
  await page.locator('.crop').waitFor();
  await assertPreview(page, 'US-B5', 'Capture/PageEdit 入口');

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
      pages: [{ id: 'p0', quad: [[0, 0], [640, 0], [640, 360], [0, 360]], enhancement: 'original', rotation: 0 }],
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
  await assertPreview(page, 'US-D8', '资料库 RemoteDetail 入口');
} finally {
  await deleteDoc(remoteId);
  await session.browser.close();
}
t.finish();
