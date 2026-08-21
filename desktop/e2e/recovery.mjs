import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(ROOT, 'spike/photos/02-perspective-whiteboard.png');
let failures = 0;
let checks = 0;
let desktop;
let serverLog = '';

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
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`desktop service did not become ready: ${url}`);
}

async function startDesktop(data, port, failpoint = '') {
  desktop = spawn(process.execPath, ['desktop/server.js', '--data', data, '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, OPEN_LENS_DESKTOP_TEST_FAILPOINT: failpoint },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  desktop.stdout.on('data', chunk => { serverLog += chunk; });
  desktop.stderr.on('data', chunk => { serverLog += chunk; });
  await waitFor(`http://127.0.0.1:${port}/api/health`);
}

async function stopDesktop() {
  if (desktop?.exitCode === null) {
    desktop.kill('SIGTERM');
    await new Promise(resolve => desktop.once('exit', resolve));
  }
}

async function waitForExit(timeoutMs = 1500) {
  if (desktop.exitCode !== null) return desktop.exitCode;
  return await Promise.race([
    new Promise(resolve => desktop.once('exit', resolve)),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function saveArtifacts(data) {
  const root = (await readdir(data)).filter(name => name.startsWith('.desktop-save-transaction')
    || (name.startsWith('.batch-meta.json.') && name.endsWith('.tmp')));
  const label = (await readdir(join(data, 'label'))).filter(name => name.startsWith('.ground-truth.json.') && name.endsWith('.tmp'));
  const outputs = (await readdir(join(data, 'outputs'))).filter(name => name.includes('.save-backup') || name.endsWith('.tmp'));
  return [...root, ...label, ...outputs];
}

const data = await mkdtemp(join(tmpdir(), 'open-lens-desktop-recovery-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const rawId = basename(fixture);
const gtId = rawId.replace(/\.[^.]+$/, '.png');
const metaFile = join(data, 'batch-meta.json');
const gtFile = join(data, 'label/ground-truth.json');
const outputFile = join(data, 'outputs', rawId.replace(/\.[^.]+$/, '') + '-corrected.jpg');
const originalMeta = `${JSON.stringify({
  [rawId]: {
    mode: 'screen', edited: false, labelW: 1000, labelH: 750, sourceW: 1600, sourceH: 1200,
    quad: [[100, 100], [900, 100], [900, 650], [100, 650]], labeledAt: '2026-08-21T00:00:00.000Z',
  },
}, null, 2)}\n`;
const originalGt = `${JSON.stringify({
  [gtId]: { mode: 'screen', quad: [[100, 100], [900, 100], [900, 650], [100, 650]], labeledAt: '2026-08-21T00:00:00.000Z' },
}, null, 2)}\n`;
const originalOutput = Buffer.from('known-good-corrected-jpeg');
const noTargetSave = {
  id: rawId,
  rec: { mode: 'screen', edited: true, noTarget: true },
  gtId,
  gtRec: { mode: 'screen', noTarget: true },
};

async function restoreOriginals() {
  await writeFile(metaFile, originalMeta);
  await writeFile(gtFile, originalGt);
  await writeFile(outputFile, originalOutput);
}

async function originalsRestored() {
  try {
    return await readFile(metaFile, 'utf8') === originalMeta
      && await readFile(gtFile, 'utf8') === originalGt
      && (await readFile(outputFile)).equals(originalOutput);
  } catch {
    return false;
  }
}

try {
  run(process.execPath, ['desktop/ingest.js', '--data', data, fixture]);
  await restoreOriginals();

  await startDesktop(data, port, 'crash-after-meta-rename');
  let crashRequestError = '';
  try {
    await fetch(`${base}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
    });
  } catch (e) { crashRequestError = e.message; }
  const crashExit = await waitForExit();
  check('US-D9: 第二阶段提交前崩溃真实终止 desktop 进程',
    crashExit === 86, `exit=${crashExit} request=${crashRequestError || 'completed'}`);
  await stopDesktop();

  await startDesktop(data, port);
  check('US-D9: 重启恢复半提交的 GT、meta 与旧成品且清理事务文件',
    await originalsRestored() && (await saveArtifacts(data)).length === 0,
    `artifacts=${(await saveArtifacts(data)).join(',')}`);
  await stopDesktop();
  await restoreOriginals();

  await startDesktop(data, port, 'before-gt-rename');
  const secondStageResponse = await fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
  });
  const secondStageText = await secondStageResponse.text();
  check('US-D9: GT 第二阶段 rename 失败返回 500 并回滚全部原文件与临时文件',
    secondStageResponse.status === 500 && secondStageText.includes('before-gt-rename')
      && await originalsRestored() && (await saveArtifacts(data)).length === 0,
    `status=${secondStageResponse.status} body=${secondStageText} artifacts=${(await saveArtifacts(data)).join(',')}`);
  const healthAfterSecondStage = await fetch(`${base}/api/health`);
  check('US-D9: GT 第二阶段恢复后 desktop 服务仍可响应', healthAfterSecondStage.ok);
  await stopDesktop();
  await restoreOriginals();

  await startDesktop(data, port, 'before-output-rename');
  const outputResponse = await fetch(`${base}/api/output?name=${encodeURIComponent(rawId)}`, {
    method: 'POST', body: Buffer.from('replacement-output'),
  });
  const outputText = await outputResponse.text();
  check('US-D9: 成品 rename 失败返回 500 并保留旧成品字节且清理 temp',
    outputResponse.status === 500 && outputText.includes('before-output-rename')
      && (await readFile(outputFile)).equals(originalOutput) && (await saveArtifacts(data)).length === 0,
    `status=${outputResponse.status} body=${outputText} artifacts=${(await saveArtifacts(data)).join(',')}`);
  const healthAfterOutputFailure = await fetch(`${base}/api/health`);
  check('US-D9: 成品原子替换失败后 desktop 服务仍可响应', healthAfterOutputFailure.ok);
} finally {
  await stopDesktop();
  await rm(data, { recursive: true, force: true });
}

if (failures) console.log(`--- desktop recovery server log ---\n${serverLog}`);
console.log(failures ? `DESKTOP RECOVERY E2E DONE (${failures}/${checks} FAILED)` : `DESKTOP RECOVERY E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
