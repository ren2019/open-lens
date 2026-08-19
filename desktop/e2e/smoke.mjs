// E2E(#4): isolated desktop ingest + real OpenCV proposal + correction persistence/render/review.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = [
  join(ROOT, 'spike/photos/02-perspective-whiteboard.png'),
  join(ROOT, 'spike/photos/real-test-2.jpg'),
  join(ROOT, 'spike/photos/real-test-3.jpg'),
];
let failures = 0;
let checks = 0;

function check(name, condition, extra = '', issue = '#4') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${issue}: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
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
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`desktop service did not become ready: ${url}`);
}

const data = await mkdtemp(join(tmpdir(), 'open-lens-desktop-e2e-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let desktop;
let browser;

try {
  run(process.execPath, ['desktop/ingest.js', '--data', data, ...fixtures]);
  const firstManifest = await readFile(join(data, 'manifest.json'), 'utf8');
  run(process.execPath, ['desktop/ingest.js', '--data', data, ...fixtures]);
  const secondManifest = await readFile(join(data, 'manifest.json'), 'utf8');
  const parsedManifest = JSON.parse(secondManifest);
  const labelSizes = Object.keys(parsedManifest).map(name => {
    const output = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(data, 'label', name.replace(/\.[^.]+$/, '.png'))]);
    return [Number(/pixelWidth: (\d+)/.exec(output)?.[1]), Number(/pixelHeight: (\d+)/.exec(output)?.[1])];
  });
  check('目录 ingest 接受 PNG/JPEG 并生成三条 manifest', Object.keys(parsedManifest).length === 3);
  check('重复 ingest 幂等', firstManifest === secondManifest);
  check('label 归一为长边 1000 px', labelSizes.every(([w, h]) => Math.max(w, h) === 1000), JSON.stringify(labelSizes));

  desktop = spawn(process.execPath, ['desktop/server.js', '--data', data, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  desktop.stdout.on('data', chunk => { serverLog += chunk; });
  desktop.stderr.on('data', chunk => { serverLog += chunk; });
  const health = await waitFor(`${base}/api/health`);
  check('隔离数据服务启动且列出三张标注图', health.ok === true && health.files === 3, JSON.stringify(health));

  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.setDefaultTimeout(30000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#ov')?.dataset.cvReady === 'true');
  check('真实加载 app/public OpenCV 与 detector', (await page.locator('#st').innerText()).includes('cv 就绪'));
  check('批次导航生成三枚状态点', await page.locator('.dot').count() === 3);

  let proposal = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForFunction(() => document.querySelector('#img')?.complete && document.querySelector('#ov')?.dataset.quad);
    proposal = JSON.parse(await page.locator('#ov').getAttribute('data-proposal') || '[]');
    if (proposal.length === 4) break;
    await page.locator('#next').click();
  }
  check('真实检测器给出四角提案', proposal.length === 4, `proposal=${JSON.stringify(proposal)}`);
  if (proposal.length !== 4) throw new Error(`no real detector proposal\n${serverLog}`);

  const before = JSON.parse(await page.locator('#ov').getAttribute('data-quad'));
  const box = await page.locator('#ov').boundingBox();
  await page.mouse.move(box.x + before[0][0], box.y + before[0][1]);
  await page.mouse.down();
  await page.mouse.move(box.x + before[0][0] + 24, box.y + before[0][1] + 18, { steps: 3 });
  await page.mouse.up();
  const after = JSON.parse(await page.locator('#ov').getAttribute('data-quad'));
  check('绿色最终框角点可拖动', after[0][0] !== before[0][0] || after[0][1] !== before[0][1]);

  const positionText = await page.locator('#pos').innerText();
  const labelId = positionText.split(' ').at(-1);
  const rawId = Object.keys(parsedManifest).find(name => name.replace(/\.[^.]+$/, '') === labelId.replace(/\.png$/i, ''));
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#st')?.textContent?.startsWith('✓ '));

  const gt = JSON.parse(await readFile(join(data, 'label/ground-truth.json'), 'utf8'));
  const meta = JSON.parse(await readFile(join(data, 'batch-meta.json'), 'utf8'));
  const output = join(data, 'outputs', rawId.replace(/\.[^.]+$/, '') + '-corrected.jpg');
  check('拖角 GT 与 edited 元数据持久化', gt[labelId]?.quad?.length === 4 && meta[rawId]?.edited === true);
  check('保存即写出 JPEG 0.92 成品', (await stat(output)).size > 1000);
  check('成品由原图分辨率渲染', meta[rawId].sourceH > meta[rawId].labelH || meta[rawId].sourceW > meta[rawId].labelW,
    `${meta[rawId].sourceW}x${meta[rawId].sourceH} from ${meta[rawId].labelW}x${meta[rawId].labelH}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const savedDot = page.locator(`.dot[title^="${labelId}"]`);
  await savedDot.waitFor();
  const savedClass = await savedDot.getAttribute('class');
  check('刷新后保留人工修正状态', savedClass.includes('edited') || savedClass.includes('ar-warn'), savedClass);

  const reviewIds = [labelId.replace(/\.png$/i, ''), basename(fixtures[1]).replace(/\.[^.]+$/, '')];
  await page.goto('about:blank');
  await page.goto(`${base}/#review=${encodeURIComponent(reviewIds.join(','))}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.dot').length === 2);
  check('review URL 只呈现指定子集', await page.locator('.dot').count() === 2 && (await page.locator('#tip').innerText()).includes('复审模式'));

  await page.goto('about:blank');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#ov')?.dataset.cvReady === 'true');
  await page.locator('#showWall').click();
  await page.locator('#wall:not([hidden])').waitFor();
  check('成品墙列出全批次并区分已渲染/待处理',
    await page.locator('.wallCard').count() === 3
      && await page.locator('.wallCard.rendered').count() === 1
      && await page.locator('.wallCard.pending').count() === 2, '', '#5');
  check('比例可疑成品以黄色状态标记并在 hover 文案给出 ar',
    await page.locator('.wallCard.warning').count() === 1
      && (await page.locator('.wallCard.warning').getAttribute('title')).includes('ar='), '', '#5');

  const outputBefore = await readFile(output);
  const imageBefore = await page.locator(`.wallCard[data-id="${labelId}"] img`).getAttribute('src');
  await page.locator(`.wallCard[data-id="${labelId}"]`).click();
  await page.locator('#editor:not([hidden])').waitFor();
  await page.waitForFunction(id => document.querySelector('#pos')?.textContent?.includes(id)
    && document.querySelector('#img')?.complete && document.querySelector('#ov')?.dataset.quad, labelId);
  const recropBefore = JSON.parse(await page.locator('#ov').getAttribute('data-quad'));
  const recropBox = await page.locator('#ov').boundingBox();
  await page.mouse.move(recropBox.x + recropBefore[0][0], recropBox.y + recropBefore[0][1]);
  await page.mouse.down();
  await page.mouse.move(recropBox.x + recropBefore[0][0] + 31, recropBox.y + recropBefore[0][1] + 22, { steps: 3 });
  await page.mouse.up();
  const recropAfter = JSON.parse(await page.locator('#ov').getAttribute('data-quad'));
  check('点墙上缩略图定位同图且可再次拖角',
    (await page.locator('#pos').innerText()).includes(labelId)
      && (recropAfter[0][0] !== recropBefore[0][0] || recropAfter[0][1] !== recropBefore[0][1]), '', '#5');
  await page.locator('#save').click();
  await page.locator('#wall:not([hidden])').waitFor();
  const outputAfter = await readFile(output);
  const imageAfter = await page.locator(`.wallCard[data-id="${labelId}"] img`).getAttribute('src');
  check('重标保存后自动回墙且覆盖成品字节变化', !outputBefore.equals(outputAfter), '', '#5');
  check('墙上同位置使用新 renderedAt 刷新缩略图', imageBefore !== imageAfter, `${imageBefore} → ${imageAfter}`, '#5');

  const noTargetId = basename(fixtures[1]).replace(/\.[^.]+$/, '.png');
  await page.locator(`.wallCard[data-id="${noTargetId}"]`).click();
  await page.locator('#noTarget').click();
  await page.locator('#save').click();
  await page.locator('#wall:not([hidden])').waitFor();
  check('墙上明确区分无目标与仍未渲染',
    await page.locator('.wallCard.noTarget').count() === 1 && await page.locator('.wallCard.pending').count() === 1, '', '#5');
} finally {
  if (browser) await browser.close();
  if (desktop) {
    desktop.kill('SIGTERM');
    await new Promise(resolve => desktop.once('exit', resolve));
  }
  await rm(data, { recursive: true, force: true });
}

console.log(failures ? `E2E DONE (${failures}/${checks} FAILED)` : `E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
