// E2E(US-H2):9MB OpenCV 等价资产仅下载一次,显示进度;二次离线重开可用相机和检测降级。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const DIST = new URL('../dist/', import.meta.url).pathname;
const OPENCV_BYTES = 9 * 1024 * 1024;
const OPENCV_SUFFIX = Buffer.from('\nwindow.cv={Mat:function Mat(){}};\n');
const MIME = {
  '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
let opencvRequests = 0;
let opencvBytesServed = 0;

await stat(join(DIST, 'index.html'));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/opencv.js') {
    opencvRequests++;
    response.writeHead(200, {
      'Content-Type': 'text/javascript',
      'Content-Length': OPENCV_BYTES,
      'Cache-Control': 'no-store',
    });
    let whitespaceLeft = OPENCV_BYTES - OPENCV_SUFFIX.byteLength;
    const pump = () => {
      if (response.destroyed) return;
      if (whitespaceLeft <= 0) {
        response.end(OPENCV_SUFFIX);
        opencvBytesServed += OPENCV_SUFFIX.byteLength;
        return;
      }
      const size = Math.min(128 * 1024, whitespaceLeft);
      whitespaceLeft -= size;
      opencvBytesServed += size;
      response.write(Buffer.alloc(size, 0x20));
      setTimeout(pump, 18);
    };
    pump();
    return;
  }

  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '');
  const file = join(DIST, relative);
  if (!file.startsWith(DIST)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const BASE = `http://127.0.0.1:${address.port}`;

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.setDefaultTimeout(20000);

try {
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.locator('button:has-text("开始扫描")').waitFor();

  const progress = page.locator('.cvLoadIndicator');
  await progress.waitFor({ state: 'visible' });
  const progressText = await progress.innerText();
  const progressValue = Number(await progress.getAttribute('aria-valuenow'));
  check('US-H2: 9MB 首次加载有可见字节进度',
    progressText.includes('OpenCV 本地能力') && progressValue >= 0 && progressValue < 100,
    `value=${progressValue}`);
  await page.screenshot({ path: '/tmp/ol-h2-progress.png', fullPage: true });
  await page.waitForFunction(() => document.body.innerText.includes('cv ✓'), null, { timeout: 20000 });

  const cachedBytes = await page.evaluate(async () => {
    const cache = await caches.open('open-lens-opencv-0.1.0');
    const response = await cache.match('/opencv.js');
    return response ? (await response.blob()).size : 0;
  });
  check('US-H2: 首次加载写入版本化 Cache Storage',
    cachedBytes === OPENCV_BYTES && opencvRequests === 1,
    `cache=${cachedBytes} requests=${opencvRequests}`);

  const requestsAfterFirstOpen = opencvRequests;
  await context.setOffline(true);
  await page.reload({ waitUntil: 'commit' });
  await page.locator('button:has-text("开始扫描")').waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('cv ✓ · 缓存'), null, { timeout: 20000 });
  check('US-H2: 二次离线打开命中缓存且不重复下载',
    opencvRequests === requestsAfterFirstOpen && opencvBytesServed === OPENCV_BYTES,
    `requests=${opencvRequests} bytes=${opencvBytesServed}`);

  await page.locator('button:has-text("开始扫描")').click({ force: true });
  await page.locator('.cam').waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    const stream = video.srcObject;
    return stream instanceof MediaStream
      && stream.getVideoTracks().some(track => track.readyState === 'live')
      && !video.paused
      && !document.querySelector('.camhint');
  });
  check('US-H2: 离线重开后相机仍可运行', true);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  await page.locator('label:has-text("相册") input[type=file]').setInputFiles({
    name: 'offline.png', mimeType: 'image/png', buffer: png,
  });
  await page.locator('.crop').waitFor();
  check('US-H2: 离线缓存下检测异常可降级到手动裁剪',
    (await page.locator('.crop').innerText()).includes('手动拉角'));
  await page.screenshot({ path: '/tmp/ol-h2-offline.png', fullPage: true });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
