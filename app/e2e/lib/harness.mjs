import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BASE = process.env.OL_BASE || 'http://127.0.0.1:5173';
export const API = process.env.OL_API || 'http://127.0.0.1:8787';
export const TOKEN = process.env.OL_TOKEN || 'dev-token';
export const AUTH = { Authorization: `Bearer ${TOKEN}` };
const require = createRequire(import.meta.url);
export const PHOTOS = {
  first: resolve(ROOT, 'spike/photos/real-test-1.jpg'),
  second: resolve(ROOT, 'spike/photos/real-test-2.jpg'),
  third: resolve(ROOT, 'spike/photos/real-test-3.jpg'),
  c1: resolve(ROOT, 'spike/photos-batch/label/IMG_4170.png'),
};

export function checks(us) {
  let total = 0;
  let failed = 0;
  return {
    check(name, ok, extra = '', story = us) {
      total++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${story}: ${name}${extra ? `  ${extra}` : ''}`);
      if (!ok) failed++;
    },
    finish() {
      console.log(`${us} DONE (${total - failed}/${total} PASS)`);
      if (failed) throw new Error(`${us}: ${failed} assertion(s) failed`);
    },
  };
}

export async function openApp({ cv = 'fallback', viewport = { width: 390, height: 844 }, initScript = null } = {}) {
  let openCvAsset = null;
  if (cv === 'real') {
    try {
      openCvAsset = require.resolve('@techstark/opencv-js/dist/opencv.js');
    } catch {
      throw new Error(
        'Real OpenCV E2E asset is missing. Run `npm ci` from the repository root to install '
        + 'lockfile-pinned @techstark/opencv-js@4.12.0-release.1.',
      );
    }
  }
  const browser = await chromium.launch({ args: [
    '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ] });
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 700, hasTouch: viewport.width < 700 });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  if (cv === 'fallback') await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
  if (openCvAsset) await page.route('**/opencv.js', route => route.fulfill({
    path: openCvAsset,
    contentType: 'text/javascript',
  }));
  page.on('pageerror', error => console.error('PAGE-ERROR:', error.message));
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  return { browser, context, page };
}

export async function login(page, token = TOKEN) {
  await page.fill('input.textField', token);
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.locator('button:has-text("开始扫描")').waitFor();
}

export async function openScanner(page) {
  await page.locator('button:has-text("开始扫描")').click({ force: true });
  await page.locator('.cam').waitFor();
}

export async function importAlbum(page, paths) {
  await page.locator('label:has-text("相册") input[type=file]').setInputFiles(paths);
  await page.locator('.crop').waitFor();
}

export async function confirmCrop(page) {
  await page.locator('button:has-text("提交")').click();
}

export async function finishBatch(page) {
  await page.locator('.cam').waitFor();
  await page.locator('.fab').click();
  await page.locator('.pedit').waitFor();
}

export async function goGrid(page) {
  if (await page.locator('.pedit').count()) {
    await page.getByRole('button', { name: '完成编辑并返回文档' }).click();
  }
  await page.locator('.grid').waitFor();
}

export async function canvasHash(locator) {
  return locator.evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  });
}

export async function apiDocs() {
  const response = await fetch(`${API}/api/docs`, { headers: AUTH });
  if (!response.ok) throw new Error(`list docs returned ${response.status}`);
  return response.json();
}

export async function apiDetail(id) {
  const response = await fetch(`${API}/api/docs/${id}`, { headers: AUTH });
  if (!response.ok) throw new Error(`detail ${id} returned ${response.status}`);
  return response.json();
}

export async function waitForCreatedDoc(since, predicate = () => true, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const docs = await apiDocs();
    const found = docs.find(doc => doc.createdAt >= since - 1000 && predicate(doc));
    if (found) return found;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('created document did not reach server');
}

export async function waitForDetail(id, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await apiDetail(id);
    if (predicate(detail)) return detail;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`document ${id} did not reach expected state`);
}

export async function deleteDoc(id) {
  if (!id) return;
  await fetch(`${API}/api/docs/${id}`, { method: 'DELETE', headers: AUTH });
}

export async function bytes(url) {
  const response = await fetch(`${API}${url}`);
  return { ok: response.ok, type: response.headers.get('content-type') || '', data: Buffer.from(await response.arrayBuffer()) };
}
