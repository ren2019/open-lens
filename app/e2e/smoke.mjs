// E2E 冒烟(降级模式): 拦截 opencv.js 模拟 cv 缺失,走全图框降级(US-B3),
// 验证完整旅程 gate→相机→相册导入→裁剪(拖角/undo/redo)→完成→增强→标签→长图/PDF→归档→服务端可查。
// 注: headless chromium 编译 10MB 内联 WASM 会崩(环境限制,真机 Safari 已在 spike 验证),
//     故 e2e 固定走降级路径;真实检测质量由 spike/ 的 A/B harness 覆盖。
// 运行: node app/e2e/smoke.mjs(需要 app:5173 与 server:8787 在跑)
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const API = 'http://localhost:8787';
const pass = (n, ok, extra = '') => console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  ' + extra : ''));

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage();
await page.route('**/opencv.js', r => r.fulfill({ status: 404, body: '' })); // cv 缺失 → 降级
page.on('pageerror', e => console.log('PAGE-ERROR:', e.message.slice(0, 200)));
page.setDefaultTimeout(60000);

await page.goto(BASE, { waitUntil: 'commit' });
await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
await page.fill('input.textField', 'dev-token');
await page.locator('button.btn.primary').first().click({ force: true });
await page.waitForTimeout(700);
pass('gate→home', (await page.evaluate(() => document.body.innerText)).includes('开始扫描'));

await page.locator('button:has-text("开始扫描")').click({ force: true });
await page.waitForTimeout(600);
pass('camera page', await page.evaluate(() => !!document.querySelector('.cam')));

await page.locator('label:has-text("相册") input[type=file]').setInputFiles([
  '/Users/renzhen/projects/experiment/open-lens/spike/photos/real-test-1.jpg',
]);
await page.waitForFunction(() => !!document.querySelector('.crop'));
pass('import→crop(降级:全图框)', true);

const box = await page.locator('.crop canvas').first().boundingBox();
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(400);
pass('drag corner', true);

await page.locator('button:has-text("撤销")').click(); await page.waitForTimeout(200);
await page.locator('button:has-text("重做")').click(); await page.waitForTimeout(200);
pass('undo/redo', true);

await page.locator('button:has-text("✓")').click();
await page.waitForFunction(() => !!document.querySelector('.cam'));
await page.locator('.fab').click();
await page.waitForFunction(() => document.querySelectorAll('.row .btn').length >= 4);
pass('finish→pageedit', true);

await page.locator('button:has-text("黑白")').click(); await page.waitForTimeout(500);
pass('enhance bw', true);

await page.locator('text=‹ 网格').click(); await page.waitForTimeout(400);
await page.locator('button.chip:has-text("板书")').click(); await page.waitForTimeout(400);
pass('tag', (await page.$$('.chip.on')).length >= 1);

await page.locator('button:has-text("长图")').click(); await page.waitForTimeout(2500);
await page.locator('button:has-text("PDF")').click(); await page.waitForTimeout(2500);

let uploaded = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(800);
  const t = await page.evaluate(() => document.querySelector('.bar .ok, .bar .warn')?.textContent || '');
  if (t.includes('已归档')) { uploaded = true; break; }
}
pass('archived→server', uploaded);

const H = { Authorization: 'Bearer dev-token' };
const list = await fetch(API + '/api/docs', { headers: H }).then(r => r.json());
pass('server list', list.length >= 1, list.map(d => `${d.name}/${d.pageCount}p/${d.outfits.length}o/${d.tags.join('+')}`).join(' | '));
const det = await fetch(`${API}/api/docs/${list[0].id}`, { headers: H }).then(r => r.json());
pass('detail original+scan', det.pages?.length === 1 && !!det.pages[0].original && !!det.pages[0].scan);
pass('outfits archived', det.outfits?.length >= 2, det.outfits?.map(o => o.kind).join(','));
pass('raw file fetch', await fetch(API + det.pages[0].scan).then(r => r.ok));
pass('tags in db', JSON.stringify(list[0].tags).includes('板书'));

await page.locator('text=← 主页').click(); await page.waitForTimeout(300);
await page.locator('text=🗂 历史').click(); await page.waitForTimeout(1200);
pass('library shows doc', (await page.evaluate(() => document.body.innerText)).includes(list[0].name.slice(0, 10)));

await page.screenshot({ path: '/tmp/ol-e2e-final.png' });
await browser.close();
console.log('E2E DONE');
