// 真 cv e2e：使用 1000x750 GT PNG 控制输入规模，避开已知的 headless 超大 canvas/WASM 内存崩溃；
// opencv.js 与 detector-oss.js 均走 app 自己的 fetch/Blob loader，不拦截、不 stub。
import { readFile } from 'node:fs/promises';
import {
  PHOTOS, apiDetail, checks, deleteDoc, finishBatch, importAlbum, login, openApp, openScanner, waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-B1/B2');
const gt = JSON.parse(await readFile(new URL('../../../spike/photos-batch/label/ground-truth.json', import.meta.url)))[
  'IMG_4170.png'
];
const since = Date.now();
let docId = null;

function polygonIoU(a, b) {
  const size = 500;
  const width = Math.max(...a.concat(b).map(point => point[0])) + 1;
  const height = Math.max(...a.concat(b).map(point => point[1])) + 1;
  const raster = quad => {
    const grid = new Uint8Array(size * size);
    const points = quad.map(([x, y]) => [x / width * size, y / height * size]);
    for (let y = 0; y < size; y++) {
      const intersections = [];
      for (let index = 0; index < points.length; index++) {
        const [x1, y1] = points[index];
        const [x2, y2] = points[(index + 1) % points.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) intersections.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
      }
      intersections.sort((left, right) => left - right);
      for (let index = 0; index + 1 < intersections.length; index += 2) {
        for (let x = Math.max(0, Math.ceil(intersections[index])); x <= Math.min(size - 1, Math.floor(intersections[index + 1])); x++) {
          grid[y * size + x] = 1;
        }
      }
    }
    return grid;
  };
  const first = raster(a);
  const second = raster(b);
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < first.length; index++) {
    if (first[index] && second[index]) intersection++;
    if (first[index] || second[index]) union++;
  }
  return union ? intersection / union : 0;
}

const session = await openApp({ cv: 'real' });
try {
  const { page } = session;
  page.setDefaultTimeout(60000);
  await login(page);
  await page.waitForFunction(() => document.body.innerText.includes('cv ✓'));
  t.check('真实 opencv.js 在 headless Chromium 初始化', (await page.locator('.bar').innerText()).includes('cv ✓'));

  await openScanner(page);
  await importAlbum(page, PHOTOS.c1);
  const cropCanvas = page.locator('.crop canvas').first();
  const detected = await cropCanvas.evaluate(canvas => ({
    detected: canvas.dataset.detected === 'true',
    quad: JSON.parse(canvas.dataset.quad),
    width: Number(canvas.dataset.sourceWidth),
    height: Number(canvas.dataset.sourceHeight),
  }));
  const iou = polygonIoU(gt.quad, detected.quad);
  t.check('US-B1 真检测 quad 与 GT IoU 不低于 0.7', detected.detected && iou >= 0.7,
    `IoU=${iou.toFixed(3)} ${detected.width}x${detected.height}`);

  const box = await cropCanvas.boundingBox();
  const [x, y] = detected.quad[0];
  await page.mouse.move(box.x + x / detected.width * box.width, box.y + y / detected.height * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + x / detected.width * box.width + 35, box.y + y / detected.height * box.height + 28, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(before => document.querySelector('.crop canvas')?.dataset.quad !== before,
    JSON.stringify(detected.quad));
  const adjusted = JSON.parse(await cropCanvas.getAttribute('data-quad'));
  t.check('US-B1 拖角修正后 quad 坐标真实变化', JSON.stringify(adjusted) !== JSON.stringify(detected.quad),
    `${detected.quad[0].join(',')} -> ${adjusted[0].join(',')}`);

  await page.locator('button:has-text("提交")').click();
  await finishBatch(page);
  const output = await page.locator('.imgwrap canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  const distance = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1]);
  const expectedRatio = (distance(adjusted[0], adjusted[3]) + distance(adjusted[1], adjusted[2]))
    / (distance(adjusted[0], adjusted[1]) + distance(adjusted[3], adjusted[2]));
  const actualRatio = output.height / output.width;
  t.check('US-B2 warp 尺寸比与 quad 平均边长比一致', Math.abs(actualRatio - expectedRatio) < 0.02,
    `actual=${actualRatio.toFixed(3)} expected=${expectedRatio.toFixed(3)} ${output.width}x${output.height}`);
  docId = (await waitForCreatedDoc(since)).id;
  const detail = await apiDetail(docId);
  const telemetry = detail.pages[0].detectMeta;
  t.check('US-T4: 真检测提案/模式/耗时随修正页归档', detail.pages[0].edited === true
    && telemetry?.mode === 'screen'
    && telemetry?.source === 'mobile-album'
    && telemetry?.proposal?.length === 4
    && telemetry.ms >= 0);
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
