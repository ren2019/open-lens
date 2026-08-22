// Mixed-US E2E: the visual workspace shares one Lucide action language without inventing a new user story.
import {
  checks, confirmCrop, deleteDoc, finishBatch, importAlbum, login, openApp, openScanner, PHOTOS,
  waitForCreatedDoc,
} from '../lib/harness.mjs';

const t = checks('US-A3');
const TARGET_GLYPHS = /[✕⧉✓⚠‹›↝⟳↗▧▤▥]/u;
const session = await openApp();
const since = Date.now();
let docId = null;

async function hasTargetGlyph(root) {
  return TARGET_GLYPHS.test(await root.innerText());
}

async function touchSizes(locator) {
  return locator.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
}

function allTouchable(sizes) {
  return sizes.length > 0 && sizes.every(({ width, height }) => width >= 44 && height >= 44);
}

async function iconOnlyFacts(root) {
  return root.locator('[data-icon-only]').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return {
      ariaLabel: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      text: element.innerText.trim(),
      width: rect.width,
      height: rect.height,
    };
  }));
}

function iconOnlyControlsAreAccessible(facts) {
  return facts.length > 0 && facts.every(fact => fact.ariaLabel && fact.title
    && fact.width >= 44 && fact.height >= 44);
}

async function viewportLayoutFacts(row) {
  return row.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const actions = [...element.children]
      .filter(child => child instanceof HTMLButtonElement)
      .map(child => {
        const actionRect = child.getBoundingClientRect();
        return {
          name: child.getAttribute('aria-label') || child.innerText.trim(),
          text: child.innerText.trim(),
          left: actionRect.left,
          right: actionRect.right,
          width: actionRect.width,
          top: actionRect.top,
          bottom: actionRect.bottom,
          clientWidth: child.clientWidth,
          scrollWidth: child.scrollWidth,
        };
      });
    const root = document.documentElement;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: root.scrollWidth, height: root.scrollHeight },
      row: {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        top: rect.top,
        bottom: rect.bottom,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      },
      actions,
    };
  });
}

try {
  const { page } = session;
  await login(page);
  await openScanner(page);

  const camera = page.locator('.cam');
  const batch = camera.locator('.cambar button.ghost');
  const finish = camera.locator('.fab');
  t.check('Capture 常用操作不再渲染临时 Unicode glyph', !await hasTargetGlyph(camera), '', 'US-A3');
  t.check('Capture 相册、连拍与完成动作使用 Lucide SVG',
    await camera.locator('.cambar label.ghost svg.lucide').count() === 1
      && await batch.locator('svg.lucide').count() === 1
      && await finish.locator('svg.lucide').count() === 1, '', 'US-A3');
  const selectedBatchColor = await batch.evaluate(button => getComputedStyle(button).color);
  t.check('Capture 连拍选中态同时暴露 aria-pressed 与黄色视觉状态',
    await batch.getAttribute('aria-pressed') === 'true'
      && await batch.evaluate(button => button.classList.contains('sel'))
      && selectedBatchColor === 'rgb(255, 214, 10)',
    selectedBatchColor, 'US-A3');
  await batch.click();
  const unselectedBatchColor = await batch.evaluate(button => getComputedStyle(button).color);
  t.check('Capture 切到单拍时同步清除选中语义与视觉状态',
    await batch.getAttribute('aria-pressed') === 'false'
      && !await batch.evaluate(button => button.classList.contains('sel'))
      && unselectedBatchColor !== 'rgb(255, 214, 10)',
    unselectedBatchColor, 'US-A3');
  await batch.click();
  t.check('Capture 无 Page 时完成动作保留 Lucide 且真实禁用',
    await finish.isDisabled() && await finish.locator('svg.lucide').count() === 1, '', 'US-A3');
  const cameraIconOnly = await iconOnlyFacts(camera);
  t.check('Capture icon-only 操作有可访问名称、title 与 44px 命中区',
    iconOnlyControlsAreAccessible(cameraIconOnly), JSON.stringify(cameraIconOnly), 'US-A3');
  await page.screenshot({ path: '/tmp/open-lens-33-camera-390x844.png', fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => innerWidth === 844 && innerHeight === 390);
  await page.screenshot({ path: '/tmp/open-lens-33-camera-844x390.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => innerWidth === 390 && innerHeight === 844);

  await importAlbum(page, PHOTOS.second);
  const crop = page.locator('.crop');
  const undo = crop.getByRole('button', { name: '撤销', exact: true });
  const redo = crop.getByRole('button', { name: '重做', exact: true });
  t.check('Crop 常用操作不再渲染临时 Unicode glyph', !await hasTargetGlyph(crop), '', 'US-B1');
  t.check('Crop 撤销与重做初始均有 Lucide 且真实禁用',
    await undo.isDisabled() && await redo.isDisabled()
      && await undo.locator('svg.lucide').count() === 1 && await redo.locator('svg.lucide').count() === 1,
    '', 'US-B1');
  const cropIconOnly = await iconOnlyFacts(crop);
  t.check('Crop icon-only 操作有可访问名称、title 与 44px 命中区',
    iconOnlyControlsAreAccessible(cropIconOnly), JSON.stringify(cropIconOnly), 'US-B1');
  await page.screenshot({ path: '/tmp/open-lens-33-crop-390x844.png', fullPage: true });

  const canvas = crop.locator('canvas').first();
  await page.waitForFunction(() => document.querySelector('.crop canvas')?.width > 0);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 85, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('.crop button')]
    .some(button => (button.getAttribute('aria-label') === '撤销' || button.textContent?.includes('撤销')) && !button.disabled));
  t.check('Crop 拖角后仅撤销启用', await undo.isEnabled() && await redo.isDisabled(), '', 'US-B1');
  await undo.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.crop button')]
    .some(button => (button.getAttribute('aria-label') === '重做' || button.textContent?.includes('重做')) && !button.disabled));
  t.check('Crop 撤销后重做启用且撤销回到禁用', await undo.isDisabled() && await redo.isEnabled(), '', 'US-B1');
  t.check('Crop 撤销与重做命中区均至少 44px', allTouchable(await touchSizes(undo.or(redo))), '', 'US-B1');

  await confirmCrop(page);
  await page.locator('.cam').waitFor();
  t.check('Capture 已有 Page 时完成动作启用且状态文案无临时 glyph',
    await finish.isEnabled() && !await hasTargetGlyph(page.locator('.cam')), '', 'US-A3');
  await finishBatch(page);
  const editor = page.locator('.pedit');
  await editor.waitFor();
  docId = (await waitForCreatedDoc(since, doc => doc.pageCount === 1)).id;

  const editorRecrop = editor.locator('[data-recrop-trigger]');
  const editorRotate = editor.getByRole('button', { name: '旋转', exact: true });
  const editorShare = editor.getByRole('button', { name: '分享当前 Scan', exact: true });
  const editorDelete = editor.getByRole('button', { name: '删页', exact: true });
  const editorActionRow = editorRecrop.locator('xpath=..');
  t.check('PageEdit 常用操作不再渲染临时 Unicode glyph', !await hasTargetGlyph(editor), '', 'US-B5');
  t.check('PageEdit 重切、旋转、分享与删除使用 Lucide SVG',
    await editorRecrop.locator('svg.lucide-crop').count() === 1
      && await editorRotate.locator('svg.lucide-rotate-cw').count() === 1
      && await editorShare.locator('svg.lucide-share-2').count() === 1
      && await editorDelete.locator('svg.lucide-trash-2').count() === 1, '', 'US-B5');
  const editorActionIconOnly = await iconOnlyFacts(editorActionRow);
  t.check('PageEdit 重切与旋转为无可见文字的 44px icon-only 操作',
    editorActionIconOnly.length === 2
      && editorActionIconOnly.every(fact => fact.text === '' && fact.width === 44 && fact.height === 44)
      && editorActionIconOnly.map(fact => fact.ariaLabel).join(',') === '重切,旋转'
      && editorActionIconOnly.every(fact => fact.title === fact.ariaLabel),
    JSON.stringify(editorActionIconOnly), 'US-B5');
  t.check('PageEdit 完成、分享与删除等关键动作保留可见文字',
    (await editor.getByRole('button', { name: '完成编辑并返回文档' }).innerText()).includes('完成')
      && (await editorShare.innerText()).includes('分享当前 Scan')
      && (await editorDelete.innerText()).includes('删页'), '', 'US-D1');
  const editorIconOnly = await iconOnlyFacts(editor);
  t.check('PageEdit icon-only 导航与操作有可访问名称、title 与 44px 命中区',
    iconOnlyControlsAreAccessible(editorIconOnly), JSON.stringify(editorIconOnly), 'US-D1');
  const editorLayout = await viewportLayoutFacts(editorActionRow);
  const editorShareLayout = editorLayout.actions.find(action => action.name === '分享当前 Scan');
  const editorDeleteLayout = editorLayout.actions.find(action => action.name === '删页');
  t.check('PageEdit 390x844 四个核心操作保持同一行且均在首屏内',
    editorLayout.viewport.width === 390 && editorLayout.viewport.height === 844
      && editorLayout.actions.length === 4
      && editorLayout.actions.every(action => Math.abs(action.top - editorLayout.actions[0].top) < 1)
      && editorLayout.row.bottom <= editorLayout.viewport.height
      && editorLayout.actions.every(action => action.bottom <= editorLayout.viewport.height),
    JSON.stringify(editorLayout), 'US-D1');
  t.check('PageEdit 四个核心操作完整落在 action row 且互不重叠',
    editorLayout.row.scrollWidth <= editorLayout.row.clientWidth
      && editorLayout.actions.every(action => action.width >= 44
        && action.left >= editorLayout.row.left && action.right <= editorLayout.row.right
        && action.left >= 0 && action.right <= editorLayout.viewport.width)
      && editorLayout.actions.slice(1).every((action, index) => action.left >= editorLayout.actions[index].right),
    JSON.stringify(editorLayout), 'US-D1');
  t.check('PageEdit 分享与删除保留完整可见文字且无裁切',
    editorShareLayout?.text === '分享当前 Scan' && editorShareLayout.scrollWidth <= editorShareLayout.clientWidth
      && editorDeleteLayout?.text === '删页' && editorDeleteLayout.scrollWidth <= editorDeleteLayout.clientWidth,
    JSON.stringify({ share: editorShareLayout, delete: editorDeleteLayout }), 'US-D1');
  t.check('PageEdit 390x844 不产生非预期 document overflow',
    editorLayout.document.width <= editorLayout.viewport.width
      && editorLayout.document.height <= editorLayout.viewport.height,
    JSON.stringify(editorLayout), 'US-D1');
  if (await page.locator('.toast').count()) await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: '/tmp/open-lens-33-pageedit-390x844.png' });

  await page.evaluate(async id => {
    const { actions } = await import('/src/store.ts');
    await actions.openRemoteDoc(id);
  }, docId);
  const remote = page.locator('.remoteDetail');
  await remote.waitFor();
  const remoteRecrop = remote.locator('[data-recrop-trigger]');
  const remoteShare = remote.getByRole('button', { name: '分享当前 Scan', exact: true });
  t.check('RemoteDetail 常用操作不再渲染临时 Unicode glyph', !await hasTargetGlyph(remote), '', 'US-D7');
  t.check('PageEdit 与 RemoteDetail 的重切和分享复用同一 Lucide 图标',
    await remoteRecrop.locator('svg.lucide-crop').count() === 1
      && await remoteShare.locator('svg.lucide-share-2').count() === 1, '', 'US-D7');
  t.check('RemoteDetail 单页、PDF 与长图动作使用 Lucide SVG',
    await remote.locator('.exportrow button').count() === 3
      && await remote.locator('.exportrow button svg.lucide').count() === 3, '', 'US-D7');
  t.check('RemoteDetail 重切、分享与成品导出保留简洁可见文字',
    (await remoteRecrop.innerText()).includes('重切当前 Original')
      && (await remoteShare.innerText()).includes('分享当前 Scan')
      && (await remote.locator('.exportrow').innerText()).includes('单页图片')
      && (await remote.locator('.exportrow').innerText()).includes('PDF')
      && (await remote.locator('.exportrow').innerText()).includes('长图拼接'), '', 'US-D7');
  const remoteActionSizes = await touchSizes(remote.locator('.detailTools button'));
  t.check('RemoteDetail 操作保持至少 44px 触控高度', allTouchable(remoteActionSizes),
    JSON.stringify(remoteActionSizes), 'US-D7');
  await page.screenshot({ path: '/tmp/open-lens-33-remote-390x844.png', fullPage: true });
} finally {
  try {
    if (docId) await deleteDoc(docId);
  } finally {
    await session.browser.close();
  }
}
t.finish();
