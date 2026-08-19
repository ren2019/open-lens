// E2E(US-H1):manifest/图标可取 + standalone 模拟下相机接口可用。
// 运行: node app/e2e/pwa-install.mjs(需要 app dev server 在跑)
import { chromium } from 'playwright';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(() => {
  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = nativeMatchMedia(query);
    if (query === '(display-mode: standalone)')
      Object.defineProperty(result, 'matches', { configurable: true, value: true });
    return result;
  };
});
const page = await context.newPage();
await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
page.setDefaultTimeout(15000);
await page.goto(BASE, { waitUntil: 'commit' });
await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);

const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
check('US-H1: HTML 声明 manifest', manifestHref === '/manifest.webmanifest', manifestHref || '(missing)');
const manifestResponse = await page.request.get(new URL(manifestHref, BASE).href);
const manifest = await manifestResponse.json();
check('US-H1: manifest 可解析且 standalone',
  manifestResponse.ok() && manifest.display === 'standalone' && manifest.start_url === '/');

const iconSizes = new Set(manifest.icons?.map(icon => icon.sizes));
const iconResponses = await Promise.all((manifest.icons || []).map(icon => page.request.get(new URL(icon.src, BASE).href)));
check('US-H1: manifest 提供可取的 192/512 PNG 图标',
  iconSizes.has('192x192') && iconSizes.has('512x512')
    && iconResponses.every(response => response.ok() && response.headers()['content-type']?.includes('image/png')),
  `sizes=${[...iconSizes].join(',')}`);

const appleHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
const appleResponse = await page.request.get(new URL(appleHref, BASE).href);
check('US-H1: apple-touch-icon 180x180 可取',
  appleHref === '/icons/apple-touch-icon.png'
    && appleResponse.ok() && appleResponse.headers()['content-type']?.includes('image/png'));

const camera = await page.evaluate(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  const tracks = stream.getVideoTracks();
  const result = { count: tracks.length, live: tracks.every(track => track.readyState === 'live') };
  tracks.forEach(track => track.stop());
  return result;
});
check('US-H1: standalone 模拟下 getUserMedia 可出视频轨', camera.count > 0 && camera.live, JSON.stringify(camera));
check('US-H1: standalone 下不显示安装引导', await page.locator('.installGuide').count() === 0);

await browser.close();
console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
