// E2E(US-D7):服务端列表→两页详情→改名/标签→单页/PDF/长图三种远程成品。
import { readFile, stat } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
const API = process.env.OL_API || 'http://localhost:8787';
const H = { Authorization: 'Bearer dev-token' };
const id = `d7-${Date.now()}`;
const createdAt = Date.parse('2026-08-22T12:34:00+08:00');
const defaultName = '2026-08-22 12:34';
const originalName = defaultName;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  US-D7: ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  timezoneId: 'Asia/Shanghai',
});
const page = await context.newPage();
await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
page.setDefaultTimeout(30000);

try {
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  const [jpegBase64, secondJpegBase64] = await page.evaluate(() => {
    function makeJpeg(background, label, accent) {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      context.fillStyle = background; context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#322f2b'; context.font = 'bold 28px sans-serif'; context.fillText(label, 42, 82);
      context.fillStyle = accent; context.fillRect(42, 105, 236, 12);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    }
    return [makeJpeg('#f5f2e9', 'Open-Lens D7 / P1', '#2456d8'),
      makeJpeg('#e9f5ef', 'Open-Lens D7 / P2', '#21a366')];
  });
  const jpeg = Buffer.from(jpegBase64, 'base64');
  const secondJpeg = Buffer.from(secondJpegBase64, 'base64');
  check('两页 fixture 使用不同 JPEG bytes', !jpeg.equals(secondJpeg), `${jpeg.length}B/${secondJpeg.length}B`);
  const form = new FormData();
  form.set('meta', JSON.stringify({
    id, name: originalName, createdAt, tags: ['板书'],
    pages: [
      { id: 'p1', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 0 },
      { id: 'p2', quad: [[0, 0], [320, 0], [320, 180], [0, 180]], enhancement: 'original', rotation: 0 },
    ],
    outfits: [],
  }));
  form.set('original_0', new Blob([jpeg], { type: 'image/jpeg' }), 'original.jpg');
  form.set('scan_0', new Blob([jpeg], { type: 'image/jpeg' }), 'scan.jpg');
  form.set('original_1', new Blob([secondJpeg], { type: 'image/jpeg' }), 'original-2.jpg');
  form.set('scan_1', new Blob([secondJpeg], { type: 'image/jpeg' }), 'scan-2.jpg');
  const seeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: H, body: form });
  check('测试文档写入服务端', seeded.ok);

  await page.fill('input.textField', 'dev-token');
  await page.locator('button.btn.primary').first().click({ force: true });
  await page.locator('button:has-text("历史")').click();
  const card = page.locator('.card').filter({ hasText: originalName }).first();
  await card.waitFor();
  await card.click();
  await page.locator('.remoteDetail').waitFor();
  const detailText = await page.locator('.remoteDetail').innerText();
  check('列表点击进入真实详情',
    await page.locator('input.detailName').inputValue() === originalName
      && detailText.includes('2 页') && detailText.includes('板书'));
  const initialFacts = await page.locator('.detailFacts').innerText();
  check('默认时间名称与日期元数据不重复',
    await page.locator('input.detailName').inputValue() === defaultName
      && !initialFacts.includes(defaultName) && initialFacts.includes('2 页') && initialFacts.includes('已归档'), initialFacts);
  check('详情显示服务端 Scan 缩略和大图',
    await page.locator('.hero img').count() === 1 && await page.locator('.filmstrip img').count() === 2);

  const heroBox = await page.locator('.hero').boundingBox();
  const filmstripBox = await page.locator('.filmstrip').boundingBox();
  const toolsBox = await page.locator('.detailTools').boundingBox();
  const recropBox = await page.locator('[data-recrop-trigger]').boundingBox();
  check('Scan 与页导航在 390x844 首屏形成主阅读区', heroBox && filmstripBox
    && heroBox.height >= 180 && heroBox.y < 220 && filmstripBox.y + filmstripBox.height <= 844,
  heroBox && filmstripBox ? `hero=${Math.round(heroBox.height)}px filmstripY=${Math.round(filmstripBox.y)}` : 'missing geometry');
  check('页导航紧邻 Scan，次级重切不插入主阅读流', filmstripBox && recropBox && filmstripBox.y < recropBox.y,
    filmstripBox && recropBox ? `filmstripY=${Math.round(filmstripBox.y)} recropY=${Math.round(recropBox.y)}` : 'missing geometry');
  check('页导航与 Scan 间距及操作区顺序受控', heroBox && filmstripBox && toolsBox
    && filmstripBox.y >= heroBox.y + heroBox.height
    && filmstripBox.y - (heroBox.y + heroBox.height) <= 20
    && filmstripBox.y < toolsBox.y,
  heroBox && filmstripBox && toolsBox ? `gap=${Math.round(filmstripBox.y - heroBox.y - heroBox.height)}px` : 'missing geometry');
  const actionHeights = await page.locator('.detailTools button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
  check('重切、标签与导出控件保持可触控尺寸', actionHeights.length > 0 && actionHeights.every(height => height >= 44),
    actionHeights.map(height => Math.round(height)).join(','));
  const tagSizes = await page.locator('.tagrow .chip').evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect(); return [box.width, box.height];
  }));
  check('标签控件保持 44px 双轴触控尺寸', tagSizes.length > 0 && tagSizes.every(([width, height]) => width >= 44 && height >= 44),
    tagSizes.map(([width, height]) => `${Math.round(width)}x${Math.round(height)}`).join(','));

  const firstSrc = await page.locator('.hero img').getAttribute('src');
  check('当前页按钮以 aria-current 标记第一页', await page.locator('.filmstrip button').nth(0).getAttribute('aria-current') === 'page'
    && await page.locator('.filmstrip button').nth(1).getAttribute('aria-current') === null);
  await page.locator('.filmstrip button').nth(1).click();
  const secondSrc = await page.locator('.hero img').getAttribute('src');
  check('切换第二页后当前页指示同步',
    await page.locator('.filmstrip button.on').getAttribute('aria-label') === '第 2 页'
      && await page.locator('.filmstrip button').nth(1).getAttribute('aria-current') === 'page'
      && await page.locator('.filmstrip button').nth(0).getAttribute('aria-current') === null
      && (await page.locator('.hero span').innerText()) === '第 2 页'
      && (await page.locator('.hero img').getAttribute('alt')) === '第 2 页扫描件'
      && firstSrc !== secondSrc, `${firstSrc} -> ${secondSrc}`);

  const renamed = `US-D7 ${id} 已改名`;
  await page.locator('input.detailName').fill(renamed);
  await page.locator('input.detailName').press('Enter');
  const renamedFacts = await page.locator('.detailFacts').innerText();
  check('自定义名称保存后日期元数据只出现一次', renamedFacts.includes('2026-08-22 12:34')
    && renamedFacts.match(/2026-08-22 12:34/g)?.length === 1, renamedFacts);
  const lectureTag = page.locator('button.chip:has-text("讲义")');
  check('标签按钮以 aria-pressed 标记当前状态', await lectureTag.getAttribute('aria-pressed') === 'false');
  await lectureTag.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.tagrow .chip')]
    .find(button => button.textContent?.includes('讲义'))?.getAttribute('aria-pressed') === 'true');
  check('标签按钮 aria-pressed 随选择更新', await lectureTag.getAttribute('aria-pressed') === 'true');
  const updated = await fetch(`${API}/api/docs/${id}`, { headers: H }).then(response => response.json());
  check('远程改名和标签写回服务端', updated.name === renamed && updated.tags.includes('讲义'));

  for (const [label, extension] of [['单页图片', '.jpg'], ['PDF', '.pdf'], ['长图拼接', '.jpg']]) {
    const pending = page.waitForEvent('download');
    await page.locator(`button:has-text("${label}")`).click();
    const download = await pending;
    const path = await download.path();
    const info = await stat(path);
    const contentMatches = label === '单页图片' && (await readFile(path)).equals(secondJpeg);
    let signature = '';
    if (extension === '.pdf') signature = (await readFile(path)).subarray(0, 4).toString();
    check(`${label}可从纯远程文档生成`,
      download.suggestedFilename().endsWith(extension) && info.size > 100
        && (extension !== '.pdf' || signature === '%PDF')
        && (label !== '单页图片' || contentMatches),
      `${download.suggestedFilename()} ${info.size}B`);
  }
  await page.screenshot({ path: '/tmp/ol-d7-remote-detail.png', fullPage: true });
} finally {
  const deleted = await fetch(`${API}/api/docs/${id}`, { method: 'DELETE', headers: H });
  const remaining = await fetch(`${API}/api/docs/${id}`, { headers: H });
  check('测试文档删除返回 2xx 且 ID 已消失', deleted.ok && remaining.status === 404,
    `delete=${deleted.status} remaining=${remaining.status}`);
  await browser.close();
}

console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
