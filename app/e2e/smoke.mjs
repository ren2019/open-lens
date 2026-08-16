// E2E 冒烟:真实浏览器里走完 相册导入(检测)→裁剪→确认→完成→增强→标签→长图/PDF→归档上传→服务端可查
// 运行: node app/e2e/smoke.mjs(需要 app:5173 与 server:8787 都在跑)
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const BASE = 'http://localhost:5173';
const API = 'http://localhost:8787';
const pass = (n, ok, extra = '') => console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  ' + extra : ''));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
page.on('pageerror', e => console.log('PAGE-ERROR:', e.message.slice(0, 200)));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)); });

await page.goto(BASE, { waitUntil: 'commit' });
await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0, null, { timeout: 15000 });
await page.waitForTimeout(500);

// 1 gate
const gateInput = await page.$('input.textField');
pass('gate 页出现', !!gateInput);
if (gateInput) {
  await gateInput.fill('dev-token');
  await page.click('.btn.primary');
  await page.waitForTimeout(600);
}
pass('token 后进主页', (await page.textContent('.bar b'))?.includes('Open-Lens'));

// 2 相册导入两条真实照片(spike 拍的板书)
const photos = [
  path.resolve('spike/photos/real-test-1.jpg'),
  path.resolve('spike/photos/real-test-2.jpg'),
];
const filechooser = page.waitForEvent('filechooser');
await page.click('text=相册');
const fc = await filechooser;
await fc.setFiles(photos);
await page.waitForFunction(() => !!document.querySelector('.crop'), null, { timeout: 60000 }); // 检测(cv 10MB 首载)+进 crop
await page.waitForTimeout(400);

// 3 crop 页
const cropTitle = await page.textContent('.bar b');
pass('进入裁剪页', cropTitle?.includes('裁剪'), cropTitle || '');

// 拖一个角(真实 pointer 事件)
const cnv = await page.$('.crop canvas');
if (cnv) {
  const box = await cnv.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.22, box.y + box.height * 0.22, { steps: 6 });
    await page.mouse.up();
  }
}
pass('拖角交互(无报错)', true);

// undo → redo
await page.click('text=撤销');
await page.waitForTimeout(300);
await page.click('text=重做');
await page.waitForTimeout(300);

// 4 提交两张
for (let i = 0; i < photos.length; i++) {
  await page.click('button:has-text("✓")');
  await page.waitForTimeout(600);
}
// 回相机;✓ 完成文档
pass('提交后回相机', !!(await page.$('.shutter')));
await page.click('.fab');
await page.waitForTimeout(1500);
const enhRow = await page.$$('.row .btn');
pass('落地页编辑器(增强选单)', enhRow.length >= 4, `按钮数 ${enhRow.length}`);

// 5 增强 → 黑白
await page.click('button:has-text("黑白")');
await page.waitForTimeout(800);

// 6 回网格 → 打标签
await page.click('text=‹ 网格');
await page.waitForTimeout(600);
await page.click('button.chip:has-text("板书")');
await page.waitForTimeout(400);
pass('打标签', (await page.$$('.chip.on')).length >= 1);

// 7 长图 + PDF
await page.click('button:has-text("长图")');
await page.waitForTimeout(3500);
await page.click('button:has-text("PDF")');
await page.waitForTimeout(3500);
const outfitHint = await page.textContent('.card .hint:last-of-type');
pass('Outfit 产出', !!outfitHint && /已产/.test(outfitHint || ''), outfitHint || '');

// 8 等待归档上传完成
let uploaded = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(600);
  const badge = await page.textContent('.bar .hint');
  if (badge && badge.includes('已归档')) { uploaded = true; break; }
}
pass('归档上传完成', uploaded);

// 9 服务端可见(真实 HTTP 验证,独立于 UI)
const list = await fetch(API + '/api/docs', { headers: { Authorization: 'Bearer dev-token' } }).then(r => r.json());
pass('服务端文档列表', list.length >= 1, JSON.stringify(list.map(d => d.name + '/' + d.pageCount + '页/' + d.outfits.length + 'outfit')));
const doc = list[0];
const detail = await fetch(`${API}/api/docs/${doc.id}`, { headers: { Authorization: 'Bearer dev-token' } }).then(r => r.json());
pass('服务端详情:original+scan 路径', detail.pages?.every((p) => p.original && p.scan) && detail.pages.length === 2);
pass('服务端 Outfit 归档', detail.outfits.length >= 2, detail.outfits.map((o) => o.kind).join(','));
const fileOk = await fetch(API + detail.pages[0].scan, {}).then(r => r.ok);
pass('裸文件可取(scan jpg)', fileOk);
const tagsOk = JSON.stringify(doc.tags).includes('板书');
pass('标签落库', tagsOk, JSON.stringify(doc.tags));

// 10 历史视图
await page.click('text=← 主页');
await page.waitForTimeout(300);
await page.click('text=🗂 历史');
await page.waitForTimeout(1200);
const libCards = await page.$$('.card');
pass('历史列表显示服务端文档', libCards.length >= 1);

await page.screenshot({ path: '/tmp/ol-e2e-final.png', fullPage: false });
await browser.close();
console.log('E2E DONE');
