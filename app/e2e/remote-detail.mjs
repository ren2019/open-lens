// E2E(US-D7):服务端列表→详情→改名/标签→单页/PDF/长图三种远程成品。
import { readFile, stat } from 'node:fs/promises';
import { chromium } from 'playwright';
import { observeFileAction } from './lib/file-actions.mjs';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
const API = process.env.OL_API || 'http://localhost:8787';
const H = { Authorization: 'Bearer dev-token' };
const id = `d7-${Date.now()}`;
const originalName = `US-D7 ${id}`;
let failed = 0;
const check = (name, ok, extra = '', story = 'US-D7') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${story}: ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.addInitScript(`
  window.__olShares = [];
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: ({ files }) => Array.isArray(files) && files.length === 1
      && files[0] instanceof File && files[0].type === 'application/pdf',
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async payload => {
      const file = payload.files?.[0];
      window.__olShares.push({
        keys: Object.keys(payload).sort(),
        url: payload.url ?? null,
        text: payload.text ?? null,
        name: file?.name ?? null,
        type: file?.type ?? null,
        active: navigator.userActivation?.isActive === true,
        bytes: file ? Array.from(new Uint8Array(await file.arrayBuffer())) : null,
      });
    },
  });
`);
await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
page.setDefaultTimeout(30000);

try {
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  const jpegBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    context.fillStyle = '#f5f2e9'; context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#322f2b'; context.font = 'bold 28px sans-serif'; context.fillText('Open-Lens D7', 42, 82);
    context.fillStyle = '#2456d8'; context.fillRect(42, 105, 236, 12);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  const jpeg = Buffer.from(jpegBase64, 'base64');
  const form = new FormData();
  form.set('meta', JSON.stringify({
    id, name: originalName, createdAt: Date.now(), tags: ['板书'],
    pages: [{ id: 'p1', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 0 }],
    outfits: [],
  }));
  form.set('original_0', new Blob([jpeg], { type: 'image/jpeg' }), 'original.jpg');
  form.set('scan_0', new Blob([jpeg], { type: 'image/jpeg' }), 'scan.jpg');
  const seeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: H, body: form });
  check('测试文档写入服务端', seeded.ok);

  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.locator('button:has-text("历史")').click();
  await page.locator(`text=${originalName}`).waitFor();
  await page.locator(`text=${originalName}`).click();
  await page.locator('.remoteDetail').waitFor();
  const detailText = await page.locator('.remoteDetail').innerText();
  check('列表点击进入真实详情',
    await page.locator('input.detailName').inputValue() === originalName
      && detailText.includes('1 页') && detailText.includes('板书'));
  check('详情显示服务端 Scan 缩略和大图',
    await page.locator('.hero img').count() === 1 && await page.locator('.filmstrip img').count() === 1);

  const renamed = `${originalName} 已改名`;
  await page.locator('input.detailName').fill(renamed);
  await page.locator('input.detailName').press('Enter');
  await page.locator('button.chip:has-text("讲义")').click();
  const updated = await fetch(`${API}/api/docs/${id}`, { headers: H }).then(response => response.json());
  check('远程改名和标签写回服务端', updated.name === renamed && updated.tags.includes('讲义'));

  for (const [label, extension] of [['单页图片', '.jpg'], ['长图拼接', '.jpg']]) {
    const pending = page.waitForEvent('download');
    await page.locator(`button:has-text("${label}")`).click();
    const download = await pending;
    const path = await download.path();
    const info = await stat(path);
    let signature = '';
    if (extension === '.pdf') signature = (await readFile(path)).subarray(0, 4).toString();
    check(`${label}可从纯远程文档生成`,
      download.suggestedFilename().endsWith(extension) && info.size > 100 && (extension !== '.pdf' || signature === '%PDF'),
      `${download.suggestedFilename()} ${info.size}B`);
  }
  await page.locator('.exportrow button').filter({ hasText: 'PDF' }).click();
  const sharePdfButton = page.getByRole('button', { name: /分享 PDF/ });
  await sharePdfButton.waitFor();
  const shareOutcome = await observeFileAction(page, () => sharePdfButton.click(), { shareCount: 1 });
  const sharedPdf = await page.evaluate(() => window.__olShares[0]);
  check('PDF 可从纯远程文档分享真实 File', sharedPdf.keys.join(',') === 'files'
    && sharedPdf.url === null && sharedPdf.text === null
    && sharedPdf.name.endsWith('.pdf') && sharedPdf.type === 'application/pdf'
    && sharedPdf.active
    && sharedPdf.bytes.length > 100
    && Buffer.from(sharedPdf.bytes).subarray(0, 4).toString() === '%PDF'
    && shareOutcome.kind === 'share' && await page.locator('.remoteDetail').count() === 1,
  `${sharedPdf.name} ${sharedPdf.type} ${sharedPdf.bytes.length}B`, 'US-E2');
  await page.screenshot({ path: '/tmp/ol-d7-remote-detail.png', fullPage: true });
} finally {
  await fetch(`${API}/api/docs/${id}`, { method: 'DELETE', headers: H }).catch(() => {});
  await browser.close();
}

console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
