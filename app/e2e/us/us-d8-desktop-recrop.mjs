import { createHash } from 'node:crypto';
import { AUTH, API, checks, deleteDoc, login, openApp } from '../lib/harness.mjs';

const t = checks('US-D8');
const id = `d8-${Date.now()}`;
const name = `US-D8 desktop ${id}`;
const otherId = `${id}-other`;
const otherName = `US-D8 stale remote ${id}`;
const session = await openApp({ viewport: { width: 1100, height: 900 } });

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const isArchivePost = request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/docs';

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
      edited: index === 1,
      detectMeta: { mode: 'screen', proposal: [[0, 0], [640, 0], [640, 360], [0, 360]], ms: 12, edited: index === 1, source: 'desktop-import' },
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

  const otherForm = new FormData();
  otherForm.set('meta', JSON.stringify({
    id: otherId, name: otherName, createdAt: Date.now() + 1, tags: ['desktop'],
    pages: [{
      id: `${otherId}_p0`, quad: [[0, 0], [640, 0], [640, 360], [0, 360]], enhancement: 'original', rotation: 0,
      edited: false,
      detectMeta: { mode: 'screen', proposal: [[0, 0], [640, 0], [640, 360], [0, 360]], ms: 12, edited: false, source: 'desktop-import' },
    }],
    outfits: [],
  }));
  const otherBlob = new Blob([Buffer.from(jpegs[0], 'base64')], { type: 'image/jpeg' });
  otherForm.set('original_0', otherBlob, 'original-0.jpg');
  otherForm.set('scan_0', otherBlob, 'scan-0.jpg');
  const otherSeeded = await fetch(`${API}/api/docs`, { method: 'POST', headers: AUTH, body: otherForm });
  t.check('测试归档写入另一文档用于历史隔离', otherSeeded.ok);

  const beforeDetail = await fetch(`${API}/api/docs/${id}`, { headers: AUTH }).then(response => response.json());
  const beforeScans = await Promise.all(beforeDetail.pages.map(async item =>
    Buffer.from(await fetch(`${API}${item.scan}`).then(response => response.arrayBuffer()))));

  await login(page);
  await page.locator('button:has-text("历史")').click();
  await page.locator(`text=${name}`).click();
  await page.locator('.remoteDetail').waitFor();
  const columns = await page.locator('.filmstrip').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  t.check('桌面详情批量展示归档页', columns >= 2 && await page.locator('.filmstrip button').count() === 2);

  const noopArchivePosts = [];
  let activeNoopPageIndex = null;
  const guardNoopArchivePosts = async route => {
    const request = route.request();
    if (isArchivePost(request)) {
      noopArchivePosts.push({ pageIndex: activeNoopPageIndex });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  };
  await page.route('**/api/docs', guardNoopArchivePosts);

  const confirmNoop = async (pageIndex, expectedEdited) => {
    await page.locator('.filmstrip button').nth(pageIndex).click();
    const beforeNoopSrc = await page.locator('.hero img').getAttribute('src');
    await page.locator('.recropAction').click();
    const canvas = page.locator('.crop canvas').first();
    await canvas.waitFor();
    const crop = page.locator('.crop');
    t.check(`第 ${pageIndex + 1} 页重切上下文不串页`, (await crop.innerText()).includes(name)
      && (await crop.innerText()).includes(`第 ${pageIndex + 1} 页，共 2 页`));
    t.check(`第 ${pageIndex + 1} 页重切图像角色与标签语义准确`,
      await crop.getByRole('heading', { name: 'Original 与当前选区' }).count() === 1
      && await crop.getByRole('heading', { name: 'Scan 预览' }).count() === 1
      && await canvas.getAttribute('role') === 'img'
      && await canvas.getAttribute('aria-label') === 'Original 与当前选区'
      && await canvas.getAttribute('tabindex') === null);
    t.check(`第 ${pageIndex + 1} 页归档入口操作说明返回目标`,
      await crop.getByRole('button', { name: '放弃修改并返回归档详情' }).count() === 1
      && await crop.getByRole('button', { name: '应用选区并返回归档详情' }).count() === 1);
    const unchangedQuad = JSON.parse(await canvas.getAttribute('data-quad'));
    const phasePostStart = noopArchivePosts.length;
    activeNoopPageIndex = pageIndex;
    const semanticConfirm = crop.getByRole('button', { name: '应用选区并返回归档详情' });
    await (await semanticConfirm.count() ? semanticConfirm : crop.locator('button:has-text("确认重切")')).click();
    await page.locator('.remoteDetail').waitFor();
    await page.locator('.queueIndicator').filter({ hasText: '待上传 0 个文档' }).waitFor();
    activeNoopPageIndex = null;

    const afterNoop = await fetch(`${API}/api/docs/${id}`, { headers: AUTH }).then(response => response.json());
    const afterNoopScan = Buffer.from(await fetch(`${API}${afterNoop.pages[pageIndex].scan}`)
      .then(response => response.arrayBuffer()));
    const phasePosts = noopArchivePosts.slice(phasePostStart);
    t.check(`第 ${pageIndex + 1} 页未移动 quad 保留 edited=${expectedEdited}`,
      afterNoop.pages[pageIndex].edited === expectedEdited
      && afterNoop.pages[pageIndex].detectMeta?.edited === expectedEdited
      && JSON.stringify(afterNoop.pages[pageIndex].quad) === JSON.stringify(unchangedQuad));
    t.check(`第 ${pageIndex + 1} 页 no-op 未越过归档 POST 边界`, phasePosts.length === 0
      && sha(afterNoopScan) === sha(beforeScans[pageIndex])
      && await page.locator('.hero img').getAttribute('src') === beforeNoopSrc,
      phasePosts.map(post => `page=${post.pageIndex}`).join(','));
  };

  await confirmNoop(0, false);
  await confirmNoop(1, true);
  await page.unroute('**/api/docs', guardNoopArchivePosts);

  await page.locator('.filmstrip button').first().click();
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

  let changedArchiveRequestObservedAt = 0;
  const changedArchiveRequestPromise = page.waitForRequest(request => {
    if (!isArchivePost(request)) return false;
    changedArchiveRequestObservedAt = Date.now();
    return true;
  });
  const changedConfirmStartedAt = Date.now();
  const semanticConfirm = page.getByRole('button', { name: '应用选区并返回归档详情' });
  await (await semanticConfirm.count() ? semanticConfirm : page.locator('button:has-text("确认重切")')).click();
  const changedArchiveRequest = await changedArchiveRequestPromise;
  await page.locator('.remoteDetail').waitFor();
  const changedPostData = changedArchiveRequest.postDataBuffer();
  const changedPostContentType = await changedArchiveRequest.headerValue('content-type');
  const changedPostForm = await new Response(changedPostData, {
    headers: { 'content-type': changedPostContentType },
  }).formData();
  const changedMeta = JSON.parse(changedPostForm.get('meta'));
  const changedPage = changedMeta.pages.find(item => item.id === 'p0');
  const changedPostMatches = {
    timing: changedArchiveRequestObservedAt >= changedConfirmStartedAt,
    id: changedMeta.id === id,
    quad: JSON.stringify(changedPage?.quad) === JSON.stringify(adjustedQuad),
    edited: changedPage?.edited === true,
  };
  const changedPostMatchesRecrop = Object.values(changedPostMatches).every(Boolean);
  t.check('真实 quad 变化确认触发对应整档上传',
    changedPostMatchesRecrop, changedPostMatchesRecrop ? '' : JSON.stringify({
      ...changedPostMatches,
      requestObservedAt: changedArchiveRequestObservedAt,
      confirmStartedAt: changedConfirmStartedAt,
    }));
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
  t.check('浏览器重渲染 Scan 且 Original 保持归档', sha(afterScan) !== sha(beforeScans[0])
    && (await fetch(`${API}${updated.pages[0].original}`).then(response => response.ok)));
  await page.waitForFunction(() => document.querySelector('.hero img')?.getAttribute('src')?.includes('?v='));
  t.check('归档完成后详情刷新当前成品', (await page.locator('.hero img').getAttribute('src')).includes('?v='));

  await page.locator('.filmstrip button').nth(1).click();
  await page.locator('.recropAction').click();
  await page.locator('.crop canvas').first().waitFor();
  const remoteCancel = page.getByRole('button', { name: '放弃修改并返回归档详情' });
  await (await remoteCancel.count() ? remoteCancel : page.locator('button:has-text("放弃")')).click();
  t.check('归档入口取消返回原文档和当前页', await page.locator('.remoteDetail').count() === 1
    && (await page.locator('.hero span').innerText()) === '第 2 页');

  await page.locator('.recropAction').click();
  await page.locator('.crop canvas').first().waitFor();
  const remotePageId = await page.evaluate(() => history.state?.openLensRecrop?.pageId);
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);
  t.check('浏览器返回归档详情的原文档和当前页', await page.locator('.remoteDetail').count() === 1
    && (await page.locator('.hero span').innerText()) === '第 2 页');
  await page.goForward({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForTimeout(100);
  const restoredRemoteContext = await page.evaluate(() => history.state?.openLensRecrop);
  const remoteForwardRestored = await page.locator('.crop').count() === 1;
  t.check('浏览器前进恢复归档重切且上下文不串页', remoteForwardRestored
    && (await page.locator('.crop').innerText()).includes(name)
    && (await page.locator('.crop').innerText()).includes('第 2 页，共 2 页')
    && await page.getByRole('button', { name: '放弃修改并返回归档详情' }).count() === 1
    && JSON.stringify(Object.keys(restoredRemoteContext ?? {}).sort()) === JSON.stringify(['docId', 'pageId', 'pageIndex', 'returnTo'])
    && restoredRemoteContext?.docId === id
    && restoredRemoteContext?.pageId === remotePageId
    && restoredRemoteContext?.pageIndex === 1
    && restoredRemoteContext?.returnTo === 'remotedetail');
  if (!remoteForwardRestored) await page.locator('.recropAction').click();
  await page.getByRole('button', { name: '放弃修改并返回归档详情' }).click();

  await page.locator('.recropAction').click();
  await page.locator('.crop canvas').first().waitFor();
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);
  await page.locator('button:has-text("资料库")').click();
  await page.locator('.library').waitFor();
  await page.locator('.libraryGrid .card').filter({ hasText: otherName }).click();
  await page.locator('.remoteDetail').waitFor();
  await page.goForward({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForTimeout(100);
  const staleRemoteState = await page.evaluate(() => history.state);
  t.check('远程文档身份变化后前进拒绝过期重切上下文', await page.locator('.crop').count() === 0
    && await page.locator('.remoteDetail').count() === 1
    && await page.locator('.detailName').inputValue() === otherName
    && staleRemoteState?.openLensRecrop === undefined);

  await page.locator('.recropAction').click();
  await page.locator('.crop canvas').first().waitFor();
  const prefixedOriginalPageId = await page.evaluate(() => history.state?.openLensRecrop?.pageId);
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);
  await page.goForward({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForTimeout(100);
  const prefixedForwardRestored = await page.locator('.crop').count() === 1;
  const prefixedForwardState = await page.evaluate(() => history.state?.openLensRecrop);
  t.check('原始 Page ID 带文档前缀时同顺序前进仍恢复', prefixedForwardRestored
    && (await page.locator('.crop').innerText()).includes(otherName)
    && prefixedOriginalPageId === `${otherId}_p0`
    && prefixedForwardState?.pageId === `${otherId}_p0`);
  if (!prefixedForwardRestored) await page.locator('.recropAction').click();
  await page.locator('.crop canvas').first().waitFor();
  await page.getByRole('button', { name: '放弃修改并返回归档详情' }).click();

  await page.locator('button:has-text("资料库")').click();
  await page.locator('.libraryGrid .card').filter({ hasText: name }).click();
  await page.locator('.remoteDetail').waitFor();
  await page.locator('.filmstrip button').nth(1).click();
  await page.locator('.recropAction').click();
  await page.locator('.crop canvas').first().waitFor();
  await page.goBack({ waitUntil: 'commit' }).catch(() => null);

  const beforePageOrder = await fetch(`${API}/api/docs/${id}`, { headers: AUTH }).then(response => response.json());
  const reorderedPageIds = [...beforePageOrder.pages.map(item => item.id)].reverse();
  const reorderedResponse = await fetch(`${API}/api/docs/${id}`, {
    method: 'PATCH', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageOrder: reorderedPageIds }),
  });
  t.check('公开 pageOrder 路径重排同一归档', reorderedResponse.ok);
  await page.locator('button:has-text("资料库")').click();
  await page.locator('.libraryGrid .card').filter({ hasText: name }).click();
  await page.locator('.remoteDetail').waitFor();

  const staleOrderWrites = [];
  const recordStaleOrderWrite = request => {
    if (isArchivePost(request)) staleOrderWrites.push(request);
  };
  page.on('request', recordStaleOrderWrite);
  await page.goForward({ waitUntil: 'commit' }).catch(() => null);
  await page.waitForTimeout(100);
  const staleOrderEnteredCrop = await page.locator('.crop').count() === 1;
  const staleOrderForwardState = await page.evaluate(() => history.state);
  if (staleOrderEnteredCrop) {
    const staleCanvas = page.locator('.crop canvas').first();
    const staleBox = await staleCanvas.boundingBox();
    await page.mouse.move(staleBox.x + 4, staleBox.y + 4);
    await page.mouse.down();
    await page.mouse.move(staleBox.x + 78, staleBox.y + 62, { steps: 6 });
    await page.mouse.up();
    const staleWriteResponse = page.waitForResponse(response => isArchivePost(response.request()));
    await page.getByRole('button', { name: '应用选区并返回归档详情' }).click();
    await staleWriteResponse;
  }
  await page.waitForTimeout(100);
  page.off('request', recordStaleOrderWrite);
  const afterStaleOrder = await fetch(`${API}/api/docs/${id}`, { headers: AUTH }).then(response => response.json());
  t.check('同一归档远端换序后前进拒绝旧快照且不写入或回滚', !staleOrderEnteredCrop
    && await page.locator('.remoteDetail').count() === 1
    && await page.locator('.detailName').inputValue() === name
    && staleOrderForwardState?.openLensRecrop === undefined
    && staleOrderWrites.length === 0
    && JSON.stringify(afterStaleOrder.pages.map(item => item.id)) === JSON.stringify(reorderedPageIds),
  `writes=${staleOrderWrites.length} order=${afterStaleOrder.pages.map(item => item.id).join(',')}`);
} finally {
  await session.browser.close();
  await deleteDoc(id);
  await deleteDoc(otherId);
}
t.finish();
