import { PHOTOS, canvasHash, checks, importAlbum, login, openApp, openScanner } from '../lib/harness.mjs';

const t = checks('US-B1');
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, PHOTOS.first);
  const canvas = page.locator('.crop canvas').first();
  await page.waitForFunction(() => document.querySelector('.crop canvas')?.width > 0);
  t.check('cv 缺失时仍进入手动拉角页', (await page.locator('.crop .bar .hint').innerText()).includes('手动拉角'));

  const before = await canvasHash(canvas);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 85, { steps: 6 });
  await page.mouse.up();
  const changed = await canvasHash(canvas);
  t.check('拖角后裁剪叠加产物发生变化', changed !== before, `${before} -> ${changed}`);

  await page.locator('button:has-text("撤销")').click();
  await page.waitForFunction(expected => {
    const canvas = document.querySelector('.crop canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) === expected;
  }, before);
  t.check('撤销恢复拖角前产物', await canvasHash(canvas) === before);

  await page.locator('button:has-text("重做")').click();
  await page.waitForTimeout(500);
  const redone = await canvasHash(canvas);
  t.check('重做恢复拖角后产物', redone === changed, `${changed} -> ${redone}`);
} finally {
  await session.browser.close();
}
t.finish();
