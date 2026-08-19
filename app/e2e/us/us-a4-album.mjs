import { PHOTOS, canvasHash, checks, importAlbum, login, openApp, openScanner } from '../lib/harness.mjs';

const t = checks('US-A4');
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  await importAlbum(page, [PHOTOS.first, PHOTOS.second]);

  const header = page.locator('.crop .bar b');
  const canvas = page.locator('.crop canvas').first();
  await page.waitForFunction(() => document.querySelector('.crop canvas')?.width > 0);
  const secondHash = await canvasHash(canvas);
  t.check('多选两张后进入 2/2 裁剪页', (await header.innerText()).includes('2/2'));

  await page.locator('button:has-text("上一张")').click();
  await page.waitForFunction(() => document.querySelector('.crop .bar b')?.textContent?.includes('1/2'));
  await page.waitForFunction(oldHash => {
    const canvas = document.querySelector('.crop canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) !== oldHash;
  }, secondHash);
  const firstHash = await canvasHash(canvas);
  t.check('两张照片逐张进入裁剪且内容不同', firstHash !== secondHash, `${firstHash} != ${secondHash}`);

  await page.locator('button:has-text("提交")').click();
  await page.waitForFunction(() => document.querySelector('.crop .bar b')?.textContent?.includes('2/2'));
  t.check('第一张确认后自动进入第二张', (await header.innerText()).includes('2/2'));
  await page.locator('button:has-text("提交")').click();
  await page.locator('.cam').waitFor();
  t.check('两张全部并入当前会话', (await page.locator('.strip').innerText()).includes('已拍 2 页'));
} finally {
  await session.browser.close();
}
t.finish();
