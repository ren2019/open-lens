// E2E(US-F2): OPFS 硬持久上传队列
// 场景 A: 上传连续 500 → 不丢弃,指数退避后自动补传成功(失败不丢弃/幂等续传)
// 场景 B: 离线成档 → OPFS 落盘 + 待传计数可见;杀死浏览器(关 context)重开 → 从 OPFS 重建队列自动续传
// 用 launchPersistentContext(userDataDir) 让 OPFS/localStorage 跨"重启"保留。
// 运行: node app/e2e/offline-queue.mjs(需要 app:5173 与 server:8787 在跑)
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
const API = process.env.OL_API || 'http://localhost:8787';
const H = { Authorization: 'Bearer dev-token' };
const PHOTO = '/Users/renzhen/projects/experiment/open-lens/spike/photos/real-test-1.jpg';
const pass = (n, ok, extra = '') => console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  ' + extra : ''));
let failed = 0;
const check = (n, ok, extra = '') => { pass(n, ok, extra); if (!ok) failed++; };

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-e2e-opfs-'));
const args = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const serverDocs = () => fetch(API + '/api/docs', { headers: H }).then(r => r.json());
const installFastTimers = context => context.addInitScript(() => {
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (handler, timeout = 0, ...args) =>
    nativeSetTimeout(handler, Math.min(timeout, 50), ...args);
});

async function scanOneDoc(page) {
  await page.locator('button:has-text("开始扫描")').click({ force: true });
  await page.waitForTimeout(600);
  await page.locator('label:has-text("相册") input[type=file]').setInputFiles([PHOTO]);
  await page.waitForFunction(() => !!document.querySelector('.crop'));
  await page.locator('button:has-text("✓")').click();
  await page.waitForFunction(() => !!document.querySelector('.cam'));
  await page.locator('.fab').click();
  await page.waitForFunction(() => document.querySelectorAll('.row .btn').length >= 4); // pageedit
}

async function waitServerCount(n, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await serverDocs().catch(() => []);
    if (list.length >= n) return list;
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

const baseN = (await serverDocs()).length;

// ---------- 场景 A: 连续 500 → 退避自动重试成功 ----------
const ctxA = await chromium.launchPersistentContext(userDir, { args });
await installFastTimers(ctxA);
const pageA = await ctxA.newPage();
await pageA.route('**/opencv.js', r => r.fulfill({ status: 404, body: '' }));
pageA.on('pageerror', e => console.log('PAGE-ERROR:', e.message.slice(0, 200)));
pageA.setDefaultTimeout(60000);

let fails = 0;
await pageA.route('**/api/docs', route => {
  if (route.request().method() === 'POST' && fails < 2) {
    fails++;
    return route.fulfill({ status: 500, body: 'boom' });
  }
  return route.continue();
});

await pageA.goto(BASE, { waitUntil: 'commit' });
await pageA.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
await pageA.fill('input.textField', 'dev-token');
await pageA.locator('button.btn.primary').first().click({ force: true });
await pageA.waitForTimeout(700);

await scanOneDoc(pageA);
const listA = await waitServerCount(baseN + 1, 60000); // 退避 4s+8s + 渲染,给足余量
check('US-F2: 上传 500 不丢弃,退避后自动补传成功', !!listA && fails === 2, `server 拦截 500 ×${fails}`);
await pageA.unroute('**/api/docs');

const opfsKeys = () => pageA.evaluate(async () => {
  const q = await (await navigator.storage.getDirectory()).getDirectoryHandle('ol-queue');
  const names = [];
  for await (const n of q.keys()) names.push(n);
  return names;
});
const inspectOnlyQueueEntry = page => page.evaluate(async () => {
  const q = await (await navigator.storage.getDirectory()).getDirectoryHandle('ol-queue');
  const names = [];
  for await (const n of q.keys()) names.push(n);
  if (names.length !== 1) return { names };
  const doc = await q.getDirectoryHandle(names[0]);
  const meta = JSON.parse(await (await (await doc.getFileHandle('meta.json')).getFile()).text());
  const payload = await doc.getDirectoryHandle(meta.payloadDir);
  const files = [];
  for await (const n of payload.keys()) files.push(n);
  return { names, meta, files: files.sort() };
});
await pageA.waitForTimeout(1000); // 上传成功后 OPFS 清除是异步的
const persistedA = await opfsKeys();
check('US-F2: 自动补传成功后清理 OPFS', persistedA.length === 0, persistedA.join(',') || '(空)');

// ---------- 场景 B: 离线成档 → OPFS 落盘 → 重开续传 ----------
await pageA.locator('text=‹ 网格').click();
await pageA.waitForTimeout(300);
await pageA.locator('text=← 主页').click();
await pageA.waitForTimeout(300);

await ctxA.setOffline(true);
await pageA.waitForTimeout(300);
await scanOneDoc(pageA);

await pageA.locator('text=‹ 网格').click();
await pageA.waitForTimeout(300);
await pageA.locator('text=← 主页').click();
await pageA.waitForTimeout(500);
const homeText = await pageA.evaluate(() => document.body.innerText);
const indicator = await pageA.evaluate(() => document.querySelector('.queueIndicator')?.textContent || '');
const browserOffline = await pageA.evaluate(() => !navigator.onLine);
check('US-F2: 离线成档不受阻,待传计数常显',
  browserOffline && homeText.includes('开始扫描') && /待上?传\s*1/.test(indicator),
  `${browserOffline ? 'browser offline' : 'browser online'} · ${indicator || '(无角标)'}`);

await pageA.waitForFunction(async () => {
  const q = await (await navigator.storage.getDirectory()).getDirectoryHandle('ol-queue');
  const names = [];
  for await (const n of q.keys()) names.push(n);
  if (names.length !== 1) return false;
  const doc = await q.getDirectoryHandle(names[0]);
  return !!(await doc.getFileHandle('meta.json').catch(() => null));
}, null, { timeout: 15000 });
const persisted = await inspectOnlyQueueEntry(pageA);
check('US-F2: 队列条目 OPFS 硬持久', persisted.names.length === persistedA.length + 1, persisted.names.join(','));
check('US-F2: OPFS 含 meta + Original + Scan',
  persisted.meta?.pages?.length === 1 && persisted.files?.includes('original_0.jpg') && persisted.files?.includes('scan_0.jpg'),
  persisted.files?.join(',') || '(payload 缺失)');

// 杀死"PWA"(关 context),重开: OPFS/localStorage 随 userDataDir 保留
await ctxA.close();

const ctxB = await chromium.launchPersistentContext(userDir, { args });
await installFastTimers(ctxB);
const pageB = await ctxB.newPage();
await pageB.route('**/opencv.js', r => r.fulfill({ status: 404, body: '' }));
pageB.on('pageerror', e => console.log('PAGE-ERROR:', e.message.slice(0, 200)));
pageB.setDefaultTimeout(60000);
await pageB.goto(BASE, { waitUntil: 'commit' });
await pageB.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);

// 无手动操作: 启动恢复应从 OPFS 重建队列并自动续传
await pageB.waitForFunction(() => document.querySelectorAll('.docline').length >= 1, null, { timeout: 15000 })
  .catch(() => {});
const restoredUI = await pageB.evaluate(() => document.querySelectorAll('.docline').length);
check('US-F2: 重开后从 OPFS 重建队列(UI 可见)', restoredUI >= 1, `docline ×${restoredUI}`);

const listB = await waitServerCount(baseN + 2, 60000);
check('US-F2: 重开后自动续传到服务端(无手动触发)', !!listB,
  listB ? `${listB.length} docs` : 'timeout');

await pageB.waitForTimeout(1000); // OPFS 清除异步
const leftOver = await pageB.evaluate(async () => {
  const q = await (await navigator.storage.getDirectory()).getDirectoryHandle('ol-queue');
  const names = [];
  for await (const n of q.keys()) names.push(n);
  return names;
});
check('US-F2: 上传成功后 OPFS 条目已清除', leftOver.length === 0, leftOver.join(',') || '(空)');

// ---------- 场景 C:重试超限 → 待人工单条重试 ----------
let forcedFailures = 0;
await pageB.route('**/api/docs', route => {
  if (route.request().method() === 'POST') {
    forcedFailures++;
    return route.fulfill({ status: 500, body: 'still broken' });
  }
  return route.continue();
});
await scanOneDoc(pageB);
await pageB.locator('text=‹ 网格').click();
await pageB.locator('text=← 主页').click();
for (let i = 0; i < 150 && forcedFailures < 5; i++)
  await new Promise(resolve => setTimeout(resolve, 100));
await pageB.waitForTimeout(200);
const failedIndicator = await pageB.locator('.queueIndicator').textContent();
const retryVisible = await pageB.locator('button.retrybtn').isVisible().catch(() => false);
check('US-F2: 重试超限转人工且条目不丢弃',
  forcedFailures === 5 && retryVisible && /1 个待重试/.test(failedIndicator || ''),
  `POST 500 ×${forcedFailures} · retry=${retryVisible} · ${failedIndicator || '(无角标)'}`);

const failedMeta = await pageB.evaluate(async () => {
  const q = await (await navigator.storage.getDirectory()).getDirectoryHandle('ol-queue');
  for await (const name of q.keys()) {
    const doc = await q.getDirectoryHandle(name);
    return JSON.parse(await (await (await doc.getFileHandle('meta.json')).getFile()).text());
  }
  return null;
});
check('US-F2: 失败次数随条目持久化', failedMeta?.attempts === 5, `attempts=${failedMeta?.attempts ?? 'missing'}`);

await pageB.unroute('**/api/docs');
if (retryVisible) await pageB.locator('button.retrybtn').click();
const listC = retryVisible ? await waitServerCount(baseN + 3, 30000) : null;
check('US-F2: 人工单条重试后归档成功', !!listC, listC ? `${listC.length} docs` : 'timeout');

// ---------- 场景 D:服务端已落库但响应丢失后的整条重传仍幂等 ----------
const idemId = `idem-${Date.now()}`;
const uploadSameOutfit = async () => {
  const form = new FormData();
  form.set('meta', JSON.stringify({
    id: idemId, name: 'idempotency probe', createdAt: Date.now(), tags: [], pages: [],
    outfits: [{ id: 'outfit-one', kind: 'pdf', ext: 'pdf' }],
  }));
  form.set('outfit_0', new Blob(['%PDF-1.4\n'], { type: 'application/pdf' }), 'probe.pdf');
  return fetch(API + '/api/docs', { method: 'POST', headers: H, body: form });
};
const idemResponses = [await uploadSameOutfit(), await uploadSameOutfit()];
const idemDetail = await fetch(`${API}/api/docs/${idemId}`, { headers: H }).then(r => r.json());
check('US-F2: 同一 Outfit 整条重传不增生',
  idemResponses.every(r => r.ok) && idemDetail.outfits?.length === 1 && idemDetail.outfits[0].id === `${idemId}_outfit-one`,
  `responses=${idemResponses.map(r => r.status).join(',')} · outfits=${idemDetail.outfits?.length ?? 'missing'}`);
await fetch(`${API}/api/docs/${idemId}`, { method: 'DELETE', headers: H });

await ctxB.close();
fs.rmSync(userDir, { recursive: true, force: true });
console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
