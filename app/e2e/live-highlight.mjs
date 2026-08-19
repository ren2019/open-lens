// E2E(US-A1):stub cv 验证实时 quad/fps/mode seam;cv 缺时验证静态指引降级。
import { chromium } from 'playwright';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  US-A1: ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
] });

async function openCamera(withCv) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.route('**/opencv.js', route => route.fulfill(withCv
    ? { status: 200, contentType: 'text/javascript', body: 'window.cv={Mat:function Mat(){},matFromImageData:function(){return {delete:function(){}}}}' }
    : { status: 404, body: '' }));
  if (withCv) await page.route('**/detector-oss.js', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'window.OSSDetector={detect:function(cv,src,opts){window.__liveDetectorOptions=opts;return {quad:[{x:48,y:42},{x:432,y:24},{x:418,y:238},{x:66,y:254}],ms:12}}}',
  }));
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.locator('button:has-text("开始扫描")').click({ force: true });
  await page.locator('.cam').waitFor();
  return { context, page };
}

try {
  const live = await openCamera(true);
  await live.page.waitForFunction(() => document.querySelector('.viewwrap canvas')?.dataset.highlight === 'quad'
    && Number((document.querySelector('.liveState')?.textContent || '').match(/([\d.]+) fps/)?.[1] || 0) >= 5);
  const liveText = await live.page.locator('.liveState').innerText();
  const fps = Number(liveText.match(/([\d.]+) fps/)?.[1] || 0);
  const options = await live.page.evaluate(() => window.__liveDetectorOptions);
  check('检测到真 quad 后绘制高亮', await live.page.locator('.viewwrap canvas').getAttribute('data-highlight') === 'quad');
  check('实时循环维持至少 5fps', fps >= 5, liveText);
  check('实时检测消费当前 screen 档且启用 fast', options?.mode === 'screen' && options?.fast === true, JSON.stringify(options));
  await live.page.screenshot({ path: '/tmp/ol-a1-live-quad.png', fullPage: true });
  await live.context.close();

  const fallback = await openCamera(false);
  await fallback.page.waitForTimeout(3000);
  const fallbackText = await fallback.page.locator('.liveState').innerText();
  check('cv 缺失时保留静态虚线指引',
    await fallback.page.locator('.viewwrap canvas').getAttribute('data-highlight') === 'guide'
      && fallbackText.includes('静态指引'), fallbackText);
  await fallback.context.close();
} finally {
  await browser.close();
}

console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
