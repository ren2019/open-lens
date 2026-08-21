// E2E(US-D9 + US-D8, issue #56): EXIF-oriented Desktop labels keep one coordinate space through archive re-crop.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { terminateChild } from '../../e2e/child-process.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const scratch = await mkdtemp(join(tmpdir(), 'open-lens-exif-oriented-e2e-'));
const data = join(scratch, 'archive');
const token = 'issue-56-e2e-token';
const cases = [
  {
    orientation: 6,
    fixture: join(ROOT, 'desktop/e2e/fixtures/exif-orientation-examples/Landscape_6.jpg'),
    file: 'Landscape_6.jpg', fixtureBytes: 352727,
    fixtureSha256: '9b344e9f0c869d8637ea22e672df9451d8d3cc1d2d0b291af3b284e538e5f124',
    stored: [1200, 1800], oriented: [1800, 1200], label: [1000, 666],
    manualQuad: [[20, 20], [980, 20], [980, 646], [20, 646]],
    proposal: [[100, 80], [900, 80], [900, 586], [100, 586]],
    archiveQuad: [[36, 36], [1764, 36], [1764, 1164], [36, 1164]],
    archiveProposal: [[180, 144], [1620, 144], [1620, 1056], [180, 1056]],
    documentId: 'issue56-exif6', name: 'Issue 56 EXIF 6 regression',
  },
  {
    orientation: 1,
    fixture: join(ROOT, 'spike/photos/real-test-2.jpg'),
    file: 'real-test-2.jpg', fixtureBytes: 218085,
    fixtureSha256: '90abe99ae0327c5804448af019708895b9abe861d488f49979cc87278b86f257',
    stored: [1206, 2622], oriented: [1206, 2622], label: [460, 1000],
    manualQuad: [[20, 20], [440, 20], [440, 980], [20, 980]],
    proposal: [[40, 60], [420, 60], [420, 940], [40, 940]],
    archiveQuad: [[52, 52], [1154, 52], [1154, 2570], [52, 2570]],
    archiveProposal: [[105, 157], [1101, 157], [1101, 2465], [105, 2465]],
    documentId: 'issue56-exif1', name: 'Issue 56 EXIF 1 regression',
  },
];
let failures = 0;
let checks = 0;
let browser;
const children = [];

function check(us, name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${us}: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', chunk => { child.log += chunk; });
  child.stderr.on('data', chunk => { child.log += chunk; });
  children.push(child);
  return child;
}

async function stop(child) {
  await terminateChild(child, { label: 'EXIF-oriented E2E service', processGroup: true });
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

async function waitFor(url, options = {}) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become ready: ${url}`);
}

async function dragQuad(page, target) {
  const canvas = page.locator('#ov');
  for (let index = 0; index < target.length; index++) {
    const current = JSON.parse(await canvas.getAttribute('data-quad'));
    const box = await canvas.boundingBox();
    const size = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
    const from = current[index];
    const to = target[index];
    await page.mouse.move(box.x + from[0] * box.width / size.width, box.y + from[1] * box.height / size.height);
    await page.mouse.down();
    await page.mouse.move(box.x + to[0] * box.width / size.width, box.y + to[1] * box.height / size.height, { steps: 5 });
    await page.mouse.up();
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inBounds(quad, width, height) {
  return quad.every(([x, y]) => x >= 0 && y >= 0 && x <= width && y <= height);
}

async function desktopToArchive(definition) {
  const source = join(scratch, `batch-${definition.orientation}`);
  const fixtureBytes = await readFile(definition.fixture);
  check('US-D9', `orientation=${definition.orientation} fixture 的 bytes/hash 未漂移`,
    fixtureBytes.length === definition.fixtureBytes && sha256(fixtureBytes) === definition.fixtureSha256);
  run(process.execPath, ['desktop/ingest.js', '--data', source, definition.fixture]);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))[definition.file];
  check('US-D9', `ingest 记录 orientation=${definition.orientation} Original 的存储轴与定向轴`,
    manifest?.w === definition.stored[0] && manifest?.h === definition.stored[1]
      && manifest?.orientation === definition.orientation
      && manifest?.orientedW === definition.oriented[0] && manifest?.orientedH === definition.oriented[1],
    JSON.stringify(manifest));

  const desktopPort = await freePort();
  const desktopBase = `http://127.0.0.1:${desktopPort}`;
  const desktop = start(process.execPath, ['desktop/server.js', '--data', source, '--port', String(desktopPort)]);
  await waitFor(`${desktopBase}/api/health`);
  const labelPage = await browser.newPage({ viewport: { width: 1180, height: 1400 } });
  labelPage.setDefaultTimeout(60_000);
  await labelPage.route('**/detector-oss.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: `window.OSSDetector={detect(){return {quad:${JSON.stringify(definition.proposal.map(([x, y]) => ({ x, y })))}}}};`,
  }));
  await labelPage.goto(desktopBase, { waitUntil: 'domcontentloaded' });
  await labelPage.waitForFunction(expected => document.querySelector('#ov')?.dataset.proposal === JSON.stringify(expected), definition.proposal);
  const labelAxes = await labelPage.locator('#img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  check('US-D9', `浏览器 label 使用 orientation=${definition.orientation} 的定向坐标系`,
    labelAxes.width === definition.label[0] && labelAxes.height === definition.label[1], JSON.stringify(labelAxes));
  await dragQuad(labelPage, definition.manualQuad);
  check('US-D9', `orientation=${definition.orientation} 人工终值经真实拖角入口落在定向 label 轴`,
    await labelPage.locator('#ov').getAttribute('data-quad') === JSON.stringify(definition.manualQuad));
  await labelPage.locator('#save').click();
  await labelPage.waitForFunction(() => document.querySelector('#st')?.textContent?.startsWith('✓ '));

  const batchMeta = JSON.parse(await readFile(join(source, 'batch-meta.json'), 'utf8'))[definition.file];
  const raw = join(source, 'raw', definition.file);
  const scan = join(source, 'outputs', definition.file.replace(/\.[^.]+$/, '') + '-corrected.jpg');
  const scanDimensions = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', scan]);
  check('US-D9', `orientation=${definition.orientation} 浏览器保存 quad/proposal 与定向 label 尺寸`,
    batchMeta.labelW === definition.label[0] && batchMeta.labelH === definition.label[1]
      && JSON.stringify(batchMeta.quad) === JSON.stringify(definition.manualQuad)
      && JSON.stringify(batchMeta.proposal?.quad) === JSON.stringify(definition.proposal));
  check('US-D9', `orientation=${definition.orientation} Original 字节不变且 Scan 已生成`,
    sha256(await readFile(raw)) === definition.fixtureSha256 && (await stat(scan)).size > 1000
      && (definition.orientation !== 6 || (/pixelWidth: 1728/.test(scanDimensions) && /pixelHeight: 1128/.test(scanDimensions))),
    scanDimensions.trim());
  await labelPage.close();
  await stop(desktop);

  run(join(ROOT, 'server/node_modules/.bin/tsx'), [
    'server/scripts/backfill-desktop-batch.ts', '--source', source, '--data', data,
    '--document-id', definition.documentId, '--name', definition.name, '--apply',
  ]);
  const db = new Database(join(data, 'openlens.db'), { readonly: true });
  const row = db.prepare('SELECT quad, detect_meta, original_path, scan_path FROM pages WHERE doc_id=?').get(definition.documentId);
  db.close();
  const archivedQuad = JSON.parse(row.quad);
  const archivedProposal = JSON.parse(row.detect_meta).proposal;
  check('US-D9', `orientation=${definition.orientation} SQLite quad 使用浏览器重开 Original 的定向坐标`,
    JSON.stringify(archivedQuad) === JSON.stringify(definition.archiveQuad)
      && inBounds(archivedQuad, definition.oriented[0], definition.oriented[1]), JSON.stringify(archivedQuad));
  check('US-D9', `orientation=${definition.orientation} detect_meta.proposal 使用同一变换且四点在界内`,
    JSON.stringify(archivedProposal) === JSON.stringify(definition.archiveProposal)
      && inBounds(archivedProposal, definition.oriented[0], definition.oriented[1]), JSON.stringify(archivedProposal));
  check('US-D9', `orientation=${definition.orientation} 归档 Original/Scan 可独立读取`,
    sha256(await readFile(join(data, row.original_path))) === definition.fixtureSha256
      && (await stat(join(data, row.scan_path))).size > 1000);
  return { definition, row, archivedQuad };
}

async function verifyRecrop(appBase, vite, result) {
  const { definition } = result;
  const appPage = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  let appBrowserLog = '';
  appPage.on('pageerror', error => { appBrowserLog += `pageerror: ${error.stack || error}\n`; });
  appPage.on('console', message => { appBrowserLog += `console.${message.type()}: ${message.text()}\n`; });
  await appPage.goto(appBase, { waitUntil: 'domcontentloaded' });
  await appPage.evaluate(value => localStorage.setItem('ol_token', value), token);
  await appPage.reload({ waitUntil: 'domcontentloaded' });
  await appPage.locator('button').first().waitFor().catch(async error => {
    throw new Error(`${error.message}\nurl=${appPage.url()}\nbody=${(await appPage.locator('body').innerText()).slice(0, 1000)}\nbrowser=${appBrowserLog.slice(-2000)}\nvite=${vite.log.slice(-2000)}`);
  });
  await appPage.getByRole('button', { name: /历史/ }).click();
  await appPage.locator('.libraryGrid .card').filter({ hasText: definition.name }).click();
  await appPage.locator('.remoteDetail').waitFor();
  await appPage.locator('.recropAction').click();
  const recropCanvas = appPage.locator('canvas[aria-label="Original 与当前选区"]');
  await recropCanvas.waitFor();
  const recrop = await recropCanvas.evaluate(canvas => ({
    width: Number(canvas.dataset.sourceWidth),
    height: Number(canvas.dataset.sourceHeight),
    quad: JSON.parse(canvas.dataset.quad),
  }));
  check('US-D8', `orientation=${definition.orientation} 归档重切重新打开同一定向 Original 坐标`,
    recrop.width === definition.oriented[0] && recrop.height === definition.oriented[1]
    && JSON.stringify(recrop.quad) === JSON.stringify(definition.archiveQuad)
    && inBounds(recrop.quad, recrop.width, recrop.height), JSON.stringify(recrop));
  await appPage.close();
}

try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const results = [];
  for (const definition of cases) results.push(await desktopToArchive(definition));

  const serverPort = await freePort();
  const serverBase = `http://127.0.0.1:${serverPort}`;
  const archiveServer = start(join(ROOT, 'server/node_modules/.bin/tsx'), ['server/index.ts'], {
    PORT: String(serverPort), DATA_DIR: data, OL_TOKEN: token,
  });
  await waitFor(`${serverBase}/api/docs`, { headers: { Authorization: `Bearer ${token}` } });
  const appPort = await freePort();
  const appBase = `http://127.0.0.1:${appPort}`;
  const vite = start('npm', ['--prefix', 'app', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(appPort)], {
    VITE_API_BASE: serverBase,
  });
  await waitFor(appBase);
  for (const result of results) await verifyRecrop(appBase, vite, result);
  await stop(vite);
  await stop(archiveServer);
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
  await rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `E2E DONE (${failures}/${checks} FAILED)` : `E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
