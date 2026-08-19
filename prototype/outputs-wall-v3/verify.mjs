import { chromium } from '/Users/renzhen/node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto('file:///Users/renzhen/projects/experiment/open-lens/prototype/outputs-wall-v3/index.html');
await page.waitForTimeout(800);
const R = [];
const ok = (name, cond) => R.push((cond ? 'PASS' : 'FAIL') + ' ' + name);

// 点选默认开
ok('点选默认开', await page.evaluate(() => document.querySelector('.modeBtn:nth-of-type(2)').classList.contains('on')));
// ←/→ = 切原图/成品(不翻页)
const pg0 = await page.textContent('#pgInfo');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
ok('→ 切到成品视图', await page.evaluate(() => document.querySelectorAll('.stage .frame')[1].style.display !== 'none'));
const pg1 = await page.textContent('#pgInfo');
ok('→ 未翻页 (' + pg1.trim() + ')', pg1 === pg0);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(300);
ok('← 切回原图', await page.evaluate(() => document.querySelectorAll('.stage .frame')[0].style.display !== 'none'));
// 点选:点击 → 最近角点移动 → dirty
const fr = await page.$('.stage .frame');
const fb = await fr.boundingBox();
const ar0 = await page.textContent('.arBig');
await page.mouse.click(fb.x + fb.width * 0.9, fb.y + fb.height * 0.85);
await page.waitForTimeout(200);
const ar1 = await page.textContent('.arBig');
ok('点选移动角点 ' + ar0.trim() + '→' + ar1.trim(), ar0 !== ar1);
// ⌘Z 撤销
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
ok('⌘Z 撤销恢复', (await page.textContent('.arBig')).trim() === ar0.trim());
// ⌘+点击 ×4 = 重标
await page.keyboard.down('Meta');
const pts = [[0.3, 0.25], [0.75, 0.22], [0.78, 0.7], [0.28, 0.72]];
for (let i = 0; i < 4; i++) {
  await page.mouse.click(fb.x + fb.width * pts[i][0], fb.y + fb.height * pts[i][1]);
  if (i === 0) ok('⌘点击第1下进入重标(保存禁用)', await page.evaluate(() => document.querySelector('.saveBtn').disabled));
}
await page.keyboard.up('Meta');
await page.waitForTimeout(200);
ok('⌘点击 4 点成框', await page.evaluate(() => document.querySelectorAll('.handle').length === 4 && !document.querySelector('.saveBtn').disabled));
// ⌘S 保存 → toast + 状态变 suspect(ar 1.33 出带)
await page.keyboard.press('Meta+s');
await page.waitForTimeout(300);
ok('⌘S 保存 toast', await page.evaluate(() => document.getElementById('toast').classList.contains('show')));
ok('保存后状态 ar 可疑', await page.evaluate(() => document.querySelector('.stageHead .stag').textContent.includes('可疑')));
// 分页条按钮仍可用
await page.click('#pgNext');
await page.waitForTimeout(300);
ok('分页按钮翻页 2/14', (await page.textContent('#pgInfo')).trim() === '2 / 14');
ok('无 JS 错误', errs.length === 0);
if (errs.length) console.log('ERRS:', errs);
console.log(R.join('\n'));
await page.screenshot({ path: '/tmp/proto-shots/v32-main.png' });
await browser.close();
