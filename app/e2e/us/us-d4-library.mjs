import { readFile } from 'node:fs/promises';
import { API, AUTH, PHOTOS, checks, deleteDoc, login, openApp } from '../lib/harness.mjs';

const t = checks('US-D4');
const id = `e2e-d4-${Date.now()}`;
const name = `US-D4 ${id}`;
const jpeg = await readFile(PHOTOS.first);
const form = new FormData();
form.set('meta', JSON.stringify({
  id, name, createdAt: Date.now(), tags: ['板书'],
  pages: [{ id: 'p1', quad: [[40, 40], [980, 40], [980, 1300], [40, 1300]], enhancement: 'original', rotation: 0 }],
  outfits: [],
}));
form.set('original_0', new Blob([jpeg], { type: 'image/jpeg' }), 'original.jpg');
form.set('scan_0', new Blob([jpeg], { type: 'image/jpeg' }), 'scan.jpg');
const seeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: AUTH, body: form });
t.check('测试归档写入服务端', seeded.ok, `status=${seeded.status}`);

const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await page.locator('button:has-text("历史")').click();
  const card = page.locator('.card', { hasText: name });
  await card.waitFor();
  t.check('历史列表从服务端显示名称/页数/标签', (await card.innerText()).includes('1 页')
    && (await card.innerText()).includes('板书'));
  await card.click();
  await page.locator('.remoteDetail').waitFor();
  t.check('历史项可进入远程详情并读取 Scan', await page.locator('.remoteDetail .hero img').count() === 1);
} finally {
  await session.browser.close();
  await deleteDoc(id);
}
t.finish();
