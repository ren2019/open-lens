import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(ROOT, 'spike/photos/02-perspective-whiteboard.png');
let failures = 0;
let checks = 0;

function check(name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  #43: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`desktop service did not become ready: ${url}`);
}

const data = await mkdtemp(join(tmpdir(), 'open-lens-desktop-save-failures-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const rawId = basename(fixture);
const gtId = rawId.replace(/\.[^.]+$/, '.png');
const gtFile = join(data, 'label/ground-truth.json');
const metaFile = join(data, 'batch-meta.json');
const outputDirectory = join(data, 'outputs');
const outputFile = join(outputDirectory, rawId.replace(/\.[^.]+$/, '') + '-corrected.jpg');
const initialRecord = {
  mode: 'screen', edited: false,
  labelW: 1000, labelH: 750, sourceW: 1600, sourceH: 1200,
  proposal: null,
  quad: [[100, 100], [900, 100], [900, 650], [100, 650]],
};
let desktop;
let browser;
let serverLog = '';

try {
  run(process.execPath, ['desktop/ingest.js', '--data', data, fixture]);
  desktop = spawn(process.execPath, ['desktop/server.js', '--data', data, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  desktop.stdout.on('data', chunk => { serverLog += chunk; });
  desktop.stderr.on('data', chunk => { serverLog += chunk; });
  await waitFor(`${base}/api/health`);

  const seedResponse = await fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rawId, rec: initialRecord, gtId, gtRec: { mode: 'screen', quad: initialRecord.quad } }),
  });
  if (!seedResponse.ok) throw new Error(`could not seed label: ${seedResponse.status} ${await seedResponse.text()}\n${serverLog}`);

  const beforeMeta = await stat(metaFile);
  const beforeGt = await stat(gtFile);
  const replaceResponse = await fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: rawId,
      rec: { ...initialRecord, mode: 'document' },
      gtId,
      gtRec: { mode: 'document', quad: initialRecord.quad },
    }),
  });
  const afterMeta = await stat(metaFile);
  const afterGt = await stat(gtFile);
  const temporaryFiles = [
    ...(await readdir(data)).filter(name => name.startsWith('.batch-meta.json.')),
    ...(await readdir(join(data, 'label'))).filter(name => name.startsWith('.ground-truth.json.')),
  ];
  check('US-D9: GT 与 meta 成功保存时以同目录临时文件原子替换且不留临时文件',
    replaceResponse.ok && beforeMeta.ino !== afterMeta.ino && beforeGt.ino !== afterGt.ino
      && temporaryFiles.length === 0,
    `status=${replaceResponse.status} meta=${beforeMeta.ino}->${afterMeta.ino} gt=${beforeGt.ino}->${afterGt.ino} temps=${temporaryFiles.join(',')}`);
  const validGt = await readFile(gtFile, 'utf8');
  const validMeta = await readFile(metaFile, 'utf8');
  await chmod(data, 0o500);
  try {
    const failedReplaceResponse = await fetch(`${base}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: rawId, rec: { renderedAt: new Date().toISOString() }, gtId, gtRec: null }),
    });
    const failedReplaceText = await failedReplaceResponse.text();
    const failedReplaceTemps = (await readdir(data)).filter(name => name.startsWith('.batch-meta.json.'));
    check('US-D9: JSON 原子替换失败返回 500 并清理同目录临时文件',
      failedReplaceResponse.status === 500 && failedReplaceText.includes('写入失败')
        && failedReplaceTemps.length === 0,
      `status=${failedReplaceResponse.status} body=${failedReplaceText} temps=${failedReplaceTemps.join(',')}`);
  } finally {
    await chmod(data, 0o700);
  }

  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.setDefaultTimeout(30000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#img')?.complete
    && document.querySelector('#ov')?.dataset.quad);

  const snapshotConflict = join(data, 'label/.gt-snapshots');
  await writeFile(snapshotConflict, 'occupied by a file');
  await page.locator('#expectFallback').click();
  const conflictResponsePromise = page.waitForResponse(response => response.url() === `${base}/api/save`
    && response.request().method() === 'POST');
  await page.locator('#save').click();
  const conflictResponse = await conflictResponsePromise;
  const conflictText = await conflictResponse.text();
  const conflictStatus = await page.locator('#st').innerText();
  check('US-D9: GT 快照命名冲突返回 500 且 UI 显示保存失败',
    conflictResponse.status() === 500 && conflictText.includes('保存失败')
      && conflictStatus.includes('保存失败') && !conflictStatus.includes('已存'),
    `status=${conflictResponse.status()} body=${conflictText} ui=${conflictStatus}`);
  check('US-D9: GT 快照冲突不会修改 GT 或 meta',
    await readFile(gtFile, 'utf8') === validGt && await readFile(metaFile, 'utf8') === validMeta);
  await rm(snapshotConflict);
  await page.locator('#expectFallback').click();

  const damagedGt = '{"damaged":';
  await writeFile(gtFile, damagedGt);
  await page.locator('#expectFallback').click();
  const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/save`
    && response.request().method() === 'POST');
  await page.locator('#save').click();
  const response = await responsePromise;
  const responseText = await response.text();
  let responseBody;
  try { responseBody = JSON.parse(responseText); } catch { responseBody = null; }
  const visibleStatus = await page.locator('#st').innerText();

  check('US-D9: 损坏 GT 的保存请求返回含错误内容的 500',
    response.status() === 500 && responseBody?.ok === false && Boolean(responseBody.error),
    `status=${response.status()} body=${responseText}`);
  check('US-D9: 损坏 GT 保存失败后保留原文件', await readFile(gtFile, 'utf8') === damagedGt);
  check('US-D9: 保存失败向操作者显示错误且不显示已存',
    visibleStatus.includes('保存失败') && !visibleStatus.includes('已存'), visibleStatus);
  const healthAfterFailure = await fetch(`${base}/api/health`);
  check('US-D9: 保存异常后 desktop 服务仍可响应', healthAfterFailure.ok, `status=${healthAfterFailure.status}`);

  await writeFile(gtFile, validGt);
  const damagedMeta = '{"damaged-meta":';
  await writeFile(metaFile, damagedMeta);
  const damagedMetaResponse = await fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rawId, rec: initialRecord, gtId, gtRec: { mode: 'screen', quad: initialRecord.quad } }),
  });
  const damagedMetaText = await damagedMetaResponse.text();
  check('US-D9: 损坏 meta 的保存请求返回 500 并保留 GT 与 meta 原文件',
    damagedMetaResponse.status === 500 && damagedMetaText.includes('batch-meta.json JSON 解析失败')
      && await readFile(metaFile, 'utf8') === damagedMeta && await readFile(gtFile, 'utf8') === validGt,
    `status=${damagedMetaResponse.status} body=${damagedMetaText}`);
  await writeFile(metaFile, validMeta);
  await page.evaluate(() => {
    window.__saveStatuses = [];
    window.__saveStatusObserver = new MutationObserver(() => {
      window.__saveStatuses.push(document.querySelector('#st')?.textContent || '');
    });
    window.__saveStatusObserver.observe(document.querySelector('#st'), { childList: true, subtree: true });
  });
  await page.route('**/api/output?*', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: '成品写入失败: test disk error' }),
  }), { times: 1 });
  await page.locator('#save').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#st')?.textContent || '';
    return status.startsWith('渲染失败 ') || status.startsWith('✓ ');
  });
  const outputFailureStatus = await page.locator('#st').innerText();
  const outputFailureStatuses = await page.evaluate(() => {
    window.__saveStatusObserver.disconnect();
    return window.__saveStatuses;
  });
  check('US-D9: 成品保存返回 500 时 UI 显示渲染失败且不显示完成',
    outputFailureStatus.includes('渲染失败') && outputFailureStatus.includes('成品写入失败')
      && !outputFailureStatus.startsWith('✓ ')
      && outputFailureStatuses.every(status => !status.includes('已存')),
    `${outputFailureStatus} statuses=${JSON.stringify(outputFailureStatuses)}`);

  const accountingFailure = async route => {
    const requestBody = JSON.parse(route.request().postData() || '{}');
    if (Object.hasOwn(requestBody.rec || {}, 'renderedAt')) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: '渲染记账失败: test meta disk error' }),
      });
    } else await route.continue();
  };
  await page.route('**/api/save', accountingFailure);
  await page.locator('#save').click();
  await page.waitForFunction(() => (document.querySelector('#st')?.textContent || '').includes('test meta disk error'));
  await page.unroute('**/api/save', accountingFailure);

  let retryOutputRequests = 0;
  const retryOutputFailure = async route => {
    retryOutputRequests++;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: '成品写入失败: retry disk error' }),
    });
  };
  await page.route('**/api/output?*', retryOutputFailure);
  await page.locator('#renderAll').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#st')?.textContent || '';
    return status.startsWith('批量渲染完成 ') || status.includes('retry disk error');
  });
  const retryFailureStatus = await page.locator('#st').innerText();
  await page.unroute('**/api/output?*', retryOutputFailure);
  check('US-D9: 渲染记账失败保留待办且批量重试失败不误报完成',
    retryOutputRequests === 1 && retryFailureStatus.includes('渲染失败')
      && retryFailureStatus.includes('retry disk error') && !retryFailureStatus.includes('批量渲染完成'),
    `requests=${retryOutputRequests} status=${retryFailureStatus}`);

  await rm(outputFile, { force: true });
  await chmod(outputDirectory, 0o500);
  let diskResponse = null;
  let diskResponseText = '';
  let diskError = '';
  try {
    diskResponse = await fetch(`${base}/api/output?name=${encodeURIComponent(rawId)}`, {
      method: 'POST', body: new Uint8Array([1, 2, 3]), signal: AbortSignal.timeout(5000),
    });
    diskResponseText = await diskResponse.text();
  } catch (e) { diskError = e.message; }
  check('US-D9: 成品磁盘写入失败返回含错误内容的 500',
    diskResponse?.status === 500 && diskResponseText.includes('成品写入失败'),
    diskResponse ? `status=${diskResponse.status} body=${diskResponseText}` : diskError);
  let healthAfterDiskFailure = null;
  try { healthAfterDiskFailure = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); } catch {}
  check('US-D9: 成品磁盘写入失败后 desktop 服务仍可响应',
    healthAfterDiskFailure?.ok === true, `status=${healthAfterDiskFailure?.status || 'unreachable'}`);

  await writeFile(gtFile, damagedGt);
  let listResponse = null;
  let listResponseText = '';
  let listError = '';
  try {
    listResponse = await fetch(`${base}/api/list`, { signal: AbortSignal.timeout(5000) });
    listResponseText = await listResponse.text();
  } catch (e) { listError = e.message; }
  check('US-D9: 损坏 JSON 的批次读取返回含错误内容的 500',
    listResponse?.status === 500 && listResponseText.includes('JSON 解析失败'),
    listResponse ? `status=${listResponse.status} body=${listResponseText}` : listError);
  let healthAfterListFailure = null;
  try { healthAfterListFailure = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); } catch {}
  check('US-D9: 损坏 JSON 的批次读取后 desktop 服务仍可响应',
    healthAfterListFailure?.ok === true, `status=${healthAfterListFailure?.status || 'unreachable'}`);
} finally {
  try { await chmod(outputDirectory, 0o700); } catch {}
  if (browser) await browser.close();
  if (desktop?.exitCode === null) {
    desktop.kill('SIGTERM');
    await new Promise(resolve => desktop.once('exit', resolve));
  }
  await rm(data, { recursive: true, force: true });
}

if (failures) console.log(`--- desktop server log (exit=${desktop?.exitCode}) ---\n${serverLog}`);
console.log(failures ? `DESKTOP SAVE E2E DONE (${failures}/${checks} FAILED)` : `DESKTOP SAVE E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
