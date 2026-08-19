import {
  PHOTOS, checks, confirmCrop, deleteDoc, finishBatch, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-C1');
const since = Date.now();
let docId = null;
const session = await openApp();
const snapshot = () => session.page.locator('.imgwrap canvas').evaluate(canvas => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261;
  let opaque = 0;
  let nonWhite = 0;
  let grayViolations = 0;
  let binaryViolations = 0;
  for (let i = 0; i < data.length; i += 4) {
    hash ^= data[i]; hash = Math.imul(hash, 16777619);
    hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
    hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    if (data[i + 3]) opaque++;
    if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
    if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) grayViolations++;
    if (![0, 255].includes(data[i]) || ![0, 255].includes(data[i + 1]) || ![0, 255].includes(data[i + 2])) binaryViolations++;
  }
  return { hash: hash >>> 0, opaque, nonWhite, grayViolations, binaryViolations };
});

try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, PHOTOS.c1);
  await confirmCrop(page);
  await finishBatch(page);

  const modes = [['original', '原图'], ['gray', '灰度'], ['bw', '黑白'], ['color', '彩色增强']];
  const outputs = {};
  for (const [key, label] of modes) {
    const previous = Object.values(outputs).at(-1)?.hash;
    await page.locator('.sheetbody button', { hasText: label }).click();
    if (previous !== undefined) await page.waitForFunction(oldHash => {
      const canvas = document.querySelector('.imgwrap canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 4) {
        hash ^= data[i]; hash = Math.imul(hash, 16777619);
        hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
        hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0) !== oldHash;
    }, previous);
    outputs[key] = await snapshot();
    t.check(`${label}产物非空`, outputs[key].opaque > 0, `hash=${outputs[key].hash}`);
  }
  t.check('四档真实产物互不相同', new Set(Object.values(outputs).map(output => output.hash)).size === 4);
  t.check('透视产物保留真实内容而非空白塌缩', outputs.original.nonWhite / outputs.original.opaque > 0.2);
  t.check('灰度档 RGB 三通道相等', outputs.gray.grayViolations === 0, `violations=${outputs.gray.grayViolations}`);
  t.check('黑白档只有 0/255 二值像素', outputs.bw.binaryViolations === 0, `violations=${outputs.bw.binaryViolations}`);
  docId = (await waitForCreatedDoc(since)).id;
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
