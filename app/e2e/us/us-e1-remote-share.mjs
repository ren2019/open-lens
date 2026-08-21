import {
  API, AUTH, checks,
} from '../lib/harness.mjs';
import { chromium } from 'playwright';

const t = checks('US-E1');
const id = `e1-share-${Date.now()}`;
const name = `US-E1 share ${id}`;
const shareProbe = `
  window.__olShares = [];
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: ({ files }) => Array.isArray(files) && files.length === 1
      && files[0] instanceof File && files[0].type === 'image/jpeg',
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async ({ files }) => {
      const file = files[0];
      window.__olShares.push({ name: file.name, type: file.type,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())) });
    },
  });
`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(shareProbe);
const page = await context.newPage();
page.setDefaultTimeout(30000);
const jpegs = await page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 320, 180);
  context.fillStyle = '#111'; context.font = 'bold 28px sans-serif'; context.fillText('E1 remote page 1', 24, 90);
  const first = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  context.fillStyle = '#fff'; context.fillRect(0, 0, 320, 180);
  context.fillStyle = '#111'; context.fillText('E1 remote page 2', 24, 90);
  return [first, canvas.toDataURL('image/jpeg', 0.9).split(',')[1]];
});
const bytes = jpegs.map(jpeg => Buffer.from(jpeg, 'base64'));
const form = new FormData();
form.set('meta', JSON.stringify({
  id, name, createdAt: Date.now(), tags: [],
  pages: [
    { id: 'p1', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 0 },
    { id: 'p2', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 90 },
  ], outfits: [],
}));
form.set('original_0', new Blob([bytes[0]], { type: 'image/jpeg' }), 'original-1.jpg');
form.set('scan_0', new Blob([bytes[0]], { type: 'image/jpeg' }), 'scan-1.jpg');
form.set('original_1', new Blob([bytes[1]], { type: 'image/jpeg' }), 'original-2.jpg');
form.set('scan_1', new Blob([bytes[1]], { type: 'image/jpeg' }), 'scan-2.jpg');
const seeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: AUTH, body: form });
t.check('归档详情测试页准备完成', seeded.ok);

try {
  await page.goto(process.env.OL_BASE || 'http://127.0.0.1:5173', { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.getByRole('button', { name: /历史/ }).click();
  await page.locator('.libraryGrid .card').filter({ hasText: name }).click();
  await page.locator('.remoteDetail').waitFor();
  await page.locator('.remoteDetail .filmstrip button').nth(1).click();
  await page.locator('.remoteDetail .hero span').filter({ hasText: '第 2 页' }).waitFor();
  await page.locator('.remoteDetail[data-share-ready="true"]').waitFor();
  await page.locator('.remoteDetail').getByRole('button', { name: '分享当前 Scan' }).click();
  await page.waitForFunction(() => window.__olShares.length === 1);
  const shared = await page.evaluate(() => window.__olShares[0]);
  t.check('归档详情当前第二页分享真实 JPEG File', shared.type === 'image/jpeg'
    && shared.name.endsWith('-2.jpg') && shared.bytes.length > 100
    && Buffer.from(shared.bytes).equals(bytes[1]) && !Buffer.from(shared.bytes).equals(bytes[0]),
  `${shared.name} ${shared.type} ${shared.bytes.length}B`);
  t.check('归档详情分享后仍停留在第二页', await page.locator('.remoteDetail .hero span').innerText() === '第 2 页');
} finally {
  const deleted = await fetch(`${API}/api/docs/${id}`, { method: 'DELETE', headers: AUTH });
  if (!deleted.ok) throw new Error(`remote cleanup returned ${deleted.status}`);
  const remaining = await fetch(`${API}/api/docs`, { headers: AUTH }).then(response => response.json());
  if (remaining.some(doc => doc.id === id)) throw new Error('remote cleanup left the document in the API');
  await browser.close();
}
t.finish();
