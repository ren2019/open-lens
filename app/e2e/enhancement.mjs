// E2E(US-C1):真实投影照片四档预览非空、互不相同;灰度/黑白像素语义成立。
import { chromium } from 'playwright';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
const PHOTO = new URL('../../spike/photos-batch/label/IMG_4170.png', import.meta.url).pathname;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
page.setDefaultTimeout(30000);

const snapshot = () => page.locator('.imgwrap canvas').evaluate(canvas => {
  const context = canvas.getContext('2d');
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
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
  return { hash: hash >>> 0, opaque, nonWhite, grayViolations, binaryViolations, dataUrl: canvas.toDataURL('image/png') };
});

try {
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.locator('button:has-text("开始扫描")').click({ force: true });
  await page.locator('label:has-text("相册") input[type=file]').setInputFiles(PHOTO);
  await page.locator('.crop').waitFor();
  await page.locator('button:has-text("提交")').click();
  await page.locator('.cam').waitFor();
  await page.locator('.fab').click();
  await page.locator('.pedit').waitFor();

  const modes = [
    ['original', '原图'], ['gray', '灰度'], ['bw', '黑白'], ['color', '彩色增强'],
  ];
  const outputs = {};
  for (const [key, label] of modes) {
    const previous = Object.values(outputs).at(-1)?.hash;
    await page.locator('.sheetbody button', { hasText: label }).click();
    if (previous !== undefined) {
      await page.waitForFunction(oldHash => {
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
    }
    outputs[key] = await snapshot();
    check(`US-C1: ${label}产物非空`, outputs[key].opaque > 0, `hash=${outputs[key].hash}`);
  }

  check('US-C1: 四档真实产物互不相同', new Set(Object.values(outputs).map(output => output.hash)).size === 4,
    Object.entries(outputs).map(([key, output]) => `${key}=${output.hash}`).join(' '));
  check('US-C1: 透视产物保留真实内容而非空白塌缩', outputs.original.nonWhite / outputs.original.opaque > 0.2,
    `nonWhite=${(outputs.original.nonWhite / outputs.original.opaque).toFixed(3)}`);
  check('US-C1: 灰度档 RGB 三通道相等', outputs.gray.grayViolations === 0,
    `violations=${outputs.gray.grayViolations}`);
  check('US-C1: 黑白档只有 0/255 二值像素', outputs.bw.binaryViolations === 0,
    `violations=${outputs.bw.binaryViolations}`);

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(({ modes, outputs }) => {
    document.body.innerHTML = `<main style="background:#0b0b0d;color:#f2f2f7;min-height:100vh;padding:24px;font-family:-apple-system,sans-serif"><h1 style="font-size:24px">US-C1 · 真实投影照片四档排雷</h1><p style="color:#9a9aa2;margin:6px 0 18px">IMG_4170 · 浏览器显式 sRGB canvas</p><section style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${modes.map(([key, label]) => `<figure style="margin:0;background:#18181c;border:1px solid #34343a;border-radius:12px;padding:10px"><img src="${outputs[key].dataUrl}" style="display:block;width:100%;border-radius:7px"><figcaption style="padding:9px 2px 2px">${label} · ${outputs[key].hash}</figcaption></figure>`).join('')}</section></main>`;
  }, { modes, outputs });
  await page.screenshot({ path: '/tmp/ol-c1-four-presets.png', fullPage: true });
} finally {
  await browser.close();
}

console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
