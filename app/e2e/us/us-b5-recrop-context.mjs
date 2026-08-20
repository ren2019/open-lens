import {
  PHOTOS, checks, confirmCrop, deleteDoc, finishBatch, goGrid, importAlbum, login, openApp, openScanner,
  waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-B5');
const since = Date.now();
const name = `US-B5 recrop ${since}`;
let docId = null;
const session = await openApp();

async function dragFirstCorner(page) {
  const canvas = page.locator('.crop canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 58, box.y + 46, { steps: 5 });
  await page.mouse.up();
}

async function openSecondPageRecrop(page) {
  await page.locator('.grid .cell').nth(1).click();
  await page.locator('.pedit').waitFor();
  await page.locator('button:has-text("重切")').click();
  await page.locator('.crop canvas').first().waitFor();
}

try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  for (const photo of [PHOTOS.second, PHOTOS.third]) {
    await importAlbum(page, photo);
    await confirmCrop(page);
  }
  await finishBatch(page);
  await goGrid(page);
  docId = (await waitForCreatedDoc(since, doc => doc.pageCount === 2)).id;

  await page.locator('.bar b').click();
  const input = page.locator('.bar input.textField');
  await input.fill(name);
  await input.press('Enter');
  await openSecondPageRecrop(page);

  const crop = page.locator('.crop');
  t.check('本地入口说明唯一任务', await crop.getByRole('heading', { name: '重新选择本页的扫描范围' }).count() === 1);
  t.check('本地入口显示来源文档与当前页', (await crop.innerText()).includes(name)
    && (await crop.innerText()).includes('第 2 页，共 2 页'));
  t.check('Original 和 Scan 预览的图像角色与标签语义准确',
    await crop.getByRole('heading', { name: 'Original 与当前选区' }).count() === 1
    && await crop.getByRole('heading', { name: 'Scan 预览' }).count() === 1
    && await crop.locator('canvas[role="img"][aria-label="Original 与当前选区"]:not([tabindex])').count() === 1);
  t.check('本地操作文案说明结果与返回目标',
    await crop.getByRole('button', { name: '放弃修改并返回页编辑器' }).count() === 1
    && await crop.getByRole('button', { name: '应用选区并返回页编辑器' }).count() === 1);

  const savedQuad = await crop.locator('canvas').first().getAttribute('data-quad');
  await dragFirstCorner(page);
  const semanticCancel = crop.getByRole('button', { name: '放弃修改并返回页编辑器' });
  await (await semanticCancel.count() ? semanticCancel : crop.locator('button:has-text("放弃")')).click();
  await page.locator('.pedit').waitFor();
  t.check('本地取消返回来源 Page 并恢复重切入口焦点', await page.locator('.pedit .bar b').innerText() === '2/2'
    && await page.evaluate(() => document.activeElement?.hasAttribute('data-recrop-trigger')));

  await page.locator('button:has-text("重切")').click();
  await crop.locator('canvas').first().waitFor();
  t.check('本地取消不改变当前 Page', await crop.locator('canvas').first().getAttribute('data-quad') === savedQuad);
  await dragFirstCorner(page);
  const appliedQuad = await crop.locator('canvas').first().getAttribute('data-quad');
  const semanticConfirm = crop.getByRole('button', { name: '应用选区并返回页编辑器' });
  await (await semanticConfirm.count() ? semanticConfirm : crop.locator('button:has-text("确认重切")')).click();
  await page.locator('.pedit').waitFor();
  t.check('本地确认应用选区并返回同一 Page', await page.locator('.pedit .bar b').innerText() === '2/2');

  await page.locator('button:has-text("重切")').click();
  await crop.locator('canvas').first().waitFor();
  t.check('本地确认后的选区再次进入时保持', await crop.locator('canvas').first().getAttribute('data-quad') === appliedQuad);
  await dragFirstCorner(page);
  await crop.locator('.recropBack').click();
  await page.locator('.pedit').waitFor();
  t.check('顶部返回与取消一致，丢弃未应用选区并回到来源 Page', await page.locator('.pedit .bar b').innerText() === '2/2');

  await page.locator('button:has-text("重切")').click();
  await crop.locator('canvas').first().waitFor();
  t.check('顶部返回没有改变当前 Page', await crop.locator('canvas').first().getAttribute('data-quad') === appliedQuad);
  await dragFirstCorner(page);
  const recropHistoryLength = await page.evaluate(() => history.length);
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);
  t.check('浏览器返回与取消一致，仍回到来源 Page', page.url().startsWith(process.env.OL_BASE || 'http://127.0.0.1:5173')
    && await page.locator('.pedit .bar b').count() === 1
    && await page.locator('.pedit .bar b').innerText() === '2/2');

  await page.goForward({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForTimeout(100);
  const restoredLocalContext = await page.evaluate(() => history.state?.openLensRecrop);
  const localForwardRestored = await crop.count() === 1;
  t.check('浏览器前进恢复本地重切且上下文不串页', localForwardRestored
    && (await crop.innerText()).includes(name)
    && (await crop.innerText()).includes('第 2 页，共 2 页')
    && await crop.getByRole('button', { name: '放弃修改并返回页编辑器' }).count() === 1
    && JSON.stringify(Object.keys(restoredLocalContext ?? {}).sort()) === JSON.stringify(['docId', 'pageIndex', 'returnTo'])
    && restoredLocalContext?.docId === docId
    && restoredLocalContext?.pageIndex === 1
    && restoredLocalContext?.returnTo === 'pageedit'
    && await page.evaluate(() => history.length) === recropHistoryLength);

  if (!localForwardRestored) await page.locator('button:has-text("重切")').click();
  await crop.locator('canvas').first().waitFor();
  t.check('浏览器 Back→Forward 没有改变当前 Page', await crop.locator('canvas').first().getAttribute('data-quad') === appliedQuad);
  await crop.getByRole('button', { name: '放弃修改并返回页编辑器' }).click();
} finally {
  await session.browser.close();
  await deleteDoc(docId);
}
t.finish();
