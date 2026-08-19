import { createHash } from 'node:crypto';
import { AUTH, API, checks, deleteDoc, login, openApp } from '../lib/harness.mjs';

const t = checks('US-D8');
const id = `d8-${Date.now()}`;
const name = `US-D8 desktop ${id}`;
const session = await openApp({ viewport: { width: 1100, height: 900 } });

const sha = buffer => createHash('sha256').update(buffer).digest('hex');

try {
  const { page } = session;
  const jpegs = await page.evaluate(() => [0, 1].map(index => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    context.fillStyle = index ? '#e8eff8' : '#f4ecd8'; context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#172238'; context.font = 'bold 42px sans-serif';
    context.fillText(`Open-Lens D8 / ${index + 1}`, 72, 150);
    context.fillStyle = index ? '#2c6fd6' : '#b95c28'; context.fillRect(72, 190, 496, 18);
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  }));
  const form = new FormData();
  form.set('meta', JSON.stringify({
    id, name, createdAt: Date.now(), tags: ['desktop'],
    pages: [0, 1].map(index => ({
      id: `p${index}`, quad: [[0, 0], [640, 0], [640, 360], [0, 360]], enhancement: 'original', rotation: 0,
    })),
    outfits: [],
  }));
  jpegs.forEach((value, index) => {
    const blob = new Blob([Buffer.from(value, 'base64')], { type: 'image/jpeg' });
    form.set(`original_${index}`, blob, `original-${index}.jpg`);
    form.set(`scan_${index}`, blob, `scan-${index}.jpg`);
  });
  const seeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: AUTH, body: form });
  t.check('测试归档写入两页 Original/Scan', seeded.ok);

  const beforeDetail = await fetch(`${API}/api/docs/${id}`, { headers: AUTH }).then(response => response.json());
  const beforeScan = Buffer.from(await fetch(`${API}${beforeDetail.pages[0].scan}`).then(response => response.arrayBuffer()));

  await login(page);
  await page.locator('button:has-text("历史")').click();
  await page.locator(`text=${name}`).click();
  await page.locator('.remoteDetail').waitFor();
  const columns = await page.locator('.filmstrip').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  t.check('桌面详情批量展示归档页', columns >= 2 && await page.locator('.filmstrip button').count() === 2);

  await page.locator('.recropAction').click();
  const canvas = page.locator('.crop canvas').first();
  await canvas.waitFor();
  const beforeQuad = JSON.parse(await canvas.getAttribute('data-quad'));
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 78, box.y + 62, { steps: 6 });
  await page.mouse.up();
  const adjustedQuad = JSON.parse(await canvas.getAttribute('data-quad'));
  t.check('远程 Original 进入同一拖角重切器', JSON.stringify(adjustedQuad) !== JSON.stringify(beforeQuad));

  await page.locator('button:has-text("确认重切")').click();
  await page.locator('.remoteDetail').waitFor();
  const deadline = Date.now() + 60_000;
  let updated;
  while (Date.now() < deadline) {
    updated = await fetch(`${API}/api/docs/${id}`, { headers: AUTH }).then(response => response.json());
    if (updated.pages[0].edited && JSON.stringify(updated.pages[0].quad) === JSON.stringify(adjustedQuad)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  t.check('重切终值经既有归档队列覆盖服务端', updated?.pages[0].edited === true
    && JSON.stringify(updated.pages[0].quad) === JSON.stringify(adjustedQuad));

  const afterScan = Buffer.from(await fetch(`${API}${updated.pages[0].scan}?v=${Date.now()}`).then(response => response.arrayBuffer()));
  t.check('浏览器重渲染 Scan 且 Original 保持归档', sha(afterScan) !== sha(beforeScan)
    && (await fetch(`${API}${updated.pages[0].original}`).then(response => response.ok)));
  await page.waitForFunction(() => document.querySelector('.hero img')?.getAttribute('src')?.includes('?v='));
  t.check('归档完成后详情刷新当前成品', (await page.locator('.hero img').getAttribute('src')).includes('?v='));
} finally {
  await session.browser.close();
  await deleteDoc(id);
}
t.finish();
