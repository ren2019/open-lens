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

async function startDesktop(data, port, failpoint = '', testMode = Boolean(failpoint)) {
  desktop = spawn(process.execPath, ['desktop/server.js', '--data', data, '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPEN_LENS_DESKTOP_TEST_FAILPOINT: failpoint,
      OPEN_LENS_DESKTOP_TEST_MODE: testMode ? '1' : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  desktop.stdout.on('data', chunk => { serverLog += chunk; });
  desktop.stderr.on('data', chunk => { serverLog += chunk; });
  await waitFor(`http://127.0.0.1:${port}/api/health`);
}

async function stopDesktop() {
  if (desktop?.exitCode === null && desktop.signalCode === null) {
    const exited = new Promise(resolve => desktop.once('exit', resolve));
    desktop.kill('SIGTERM');
    await exited;
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
const transactionFile = join(data, '.desktop-save-transaction.json');
const sentinelFile = join(tmpdir(), `${basename(data)}-outside-sentinel.txt`);
const sentinelContents = 'outside-batch-must-not-change';
const transactionUuid = '12345678-1234-4234-8234-123456789abc';
const validMetaTemporary = `.batch-meta.json.123-${transactionUuid}.tmp`;
const validGtTemporary = `.ground-truth.json.123-${transactionUuid}.tmp`;
const validOutputTarget = basename(outputFile);
const validOutputBackup = `.${validOutputTarget}.${transactionUuid}.save-backup`;
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

async function fileEquals(file, expected) {
  try { return await readFile(file, 'utf8') === expected; }
  catch { return false; }
}

async function noTargetCommitted() {
  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    const gt = JSON.parse(await readFile(gtFile, 'utf8'));
    let outputMissing = false;
    try { await readFile(outputFile); }
    catch (e) { outputMissing = e.code === 'ENOENT'; }
    return meta[rawId]?.noTarget === true && !meta[rawId]?.quad
      && gt[gtId]?.noTarget === true && !gt[gtId]?.quad && outputMissing;
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
  await stopDesktop();

  await restoreOriginals();
  await startDesktop(data, port, 'crash-after-meta-stage');
  try {
    await fetch(`${base}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
    });
  } catch {}
  const metaStageExit = await waitForExit();
  check('US-D9: JSON stage 后、journal 前的注入点真实终止 desktop 进程', metaStageExit === 86, `exit=${metaStageExit}`);
  await stopDesktop();
  await startDesktop(data, port);
  check('US-D9: 重启清理 journal 前崩溃留下的 JSON temp 且不改原文件',
    await originalsRestored() && (await saveArtifacts(data)).length === 0,
    `artifacts=${(await saveArtifacts(data)).join(',')}`);
  await stopDesktop();

  await restoreOriginals();
  await startDesktop(data, port, 'crash-before-output-rename');
  try {
    await fetch(`${base}/api/output?name=${encodeURIComponent(rawId)}`, {
      method: 'POST', body: Buffer.from('replacement-output'),
    });
  } catch {}
  const outputStageExit = await waitForExit();
  check('US-D9: JPEG stage 后、rename 前的注入点真实终止 desktop 进程', outputStageExit === 86, `exit=${outputStageExit}`);
  await stopDesktop();
  await startDesktop(data, port);
  check('US-D9: 重启清理 JPEG temp 并保留旧成品字节',
    (await readFile(outputFile)).equals(originalOutput) && (await saveArtifacts(data)).length === 0,
    `artifacts=${(await saveArtifacts(data)).join(',')}`);
  await stopDesktop();

  await restoreOriginals();
  await startDesktop(data, port, 'crash-after-commit');
  try {
    await fetch(`${base}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
    });
  } catch {}
  const committedExit = await waitForExit();
  check('US-D9: journal 提交点后、backup 清理前的注入点真实终止 desktop 进程', committedExit === 86, `exit=${committedExit}`);
  await stopDesktop();
  await startDesktop(data, port);
  check('US-D9: 重启保留已提交 noTarget 状态并清理孤儿 backup',
    await noTargetCommitted() && (await saveArtifacts(data)).length === 0,
    `artifacts=${(await saveArtifacts(data)).join(',')}`);
  await stopDesktop();

  await restoreOriginals();
  await startDesktop(data, port, 'crash-after-meta-rename', false);
  let unarmedResponse = null;
  let unarmedError = '';
  try {
    unarmedResponse = await fetch(`${base}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
    });
  } catch (e) { unarmedError = e.message; }
  const unarmedExit = await waitForExit(300);
  const unarmedHealth = unarmedExit === null ? await fetch(`${base}/api/health`) : null;
  check('US-D9: 仅设置 failpoint 而未启用测试模式时保存正常且进程存活',
    unarmedResponse?.ok === true && unarmedExit === null && unarmedHealth?.ok === true
      && await noTargetCommitted() && (await saveArtifacts(data)).length === 0,
    `status=${unarmedResponse?.status || unarmedError} exit=${unarmedExit}`);
  await stopDesktop();
  await startDesktop(data, port);
  await stopDesktop();

  const unsafeData = await mkdtemp(join(tmpdir(), 'open-lens-production-like-'));
  desktop = spawn(process.execPath, ['desktop/server.js', '--data', unsafeData, '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPEN_LENS_DESKTOP_TEST_FAILPOINT: 'crash-after-meta-rename',
      OPEN_LENS_DESKTOP_TEST_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  desktop.stdout.on('data', chunk => { serverLog += chunk; });
  desktop.stderr.on('data', chunk => { serverLog += chunk; });
  const unsafeExit = await waitForExit(1000);
  check('US-D9: 测试模式拒绝在非测试命名的临时批次目录启用 failpoint', unsafeExit === 1, `exit=${unsafeExit}`);
  await stopDesktop();
  await rm(unsafeData, { recursive: true, force: true });
  await restoreOriginals();

  const maliciousJournals = [
    {
      name: 'meta temp 越界',
      change: transaction => { transaction.temporary.meta = `../${basename(sentinelFile)}`; },
    },
    {
      name: 'GT temp 越界',
      change: transaction => { transaction.temporary.gt = `../../${basename(sentinelFile)}`; },
    },
    {
      name: '成品 target 越界',
      change: transaction => {
        transaction.output = { target: `../../${basename(sentinelFile)}`, backup: validOutputBackup };
      },
      setup: async () => { await writeFile(join(data, 'outputs', validOutputBackup), 'forged-backup'); },
    },
    {
      name: '成品 backup 越界',
      change: transaction => {
        transaction.output = { target: validOutputTarget, backup: `../../${basename(sentinelFile)}` };
      },
    },
    {
      name: 'previous meta 损坏 JSON',
      change: transaction => { transaction.previous.meta = '{"damaged":'; },
    },
    {
      name: 'previous GT 非对象 JSON',
      change: transaction => { transaction.previous.gt = '[]'; },
    },
    {
      name: '额外 schema 字段',
      change: transaction => { transaction.unexpected = true; },
    },
  ];

  for (const malicious of maliciousJournals) {
    await restoreOriginals();
    await writeFile(sentinelFile, sentinelContents);
    await rm(join(data, 'outputs', validOutputBackup), { force: true });
    const transaction = {
      version: 1,
      id: transactionUuid,
      previous: { meta: originalMeta, gt: originalGt },
      temporary: { meta: validMetaTemporary, gt: validGtTemporary },
      output: null,
    };
    malicious.change(transaction);
    if (malicious.setup) await malicious.setup();
    const transactionContents = JSON.stringify(transaction, null, 2);
    await writeFile(transactionFile, transactionContents);

    await startDesktop(data, port);
    const listResponse = await fetch(`${base}/api/list`);
    const listText = await listResponse.text();
    const healthResponse = await fetch(`${base}/api/health`);
    await stopDesktop();
    check(`US-D9: 恶意 journal 的${malicious.name}被拒绝且批次外文件不变`,
      listResponse.status === 500 && listText.includes('事务日志') && healthResponse.ok
        && await fileEquals(sentinelFile, sentinelContents)
        && await fileEquals(transactionFile, transactionContents)
        && await originalsRestored(),
      `status=${listResponse.status} body=${listText}`);
    await rm(transactionFile, { force: true });
  }

  const nearMatchArtifacts = [
    join(data, '.batch-meta.json.manual.tmp'),
    join(data, '.batch-meta.json.0-00000000-0000-0000-0000-000000000000.tmp'),
    join(data, 'label/.ground-truth.json.manual.tmp'),
    join(data, 'label/.ground-truth.json.123-12345678-1234-4234-8234-123456789ABC.tmp'),
    join(data, 'outputs/.notes-corrected.jpg.not-a-uuid.save-backup'),
    join(data, 'outputs/.notes-corrected.jpg.123-00000000-0000-0000-0000-000000000000.tmp'),
    join(data, 'outputs/.notes-corrected.jpg.00000000-0000-0000-0000-000000000000.save-backup'),
  ];
  for (const artifact of nearMatchArtifacts) await writeFile(artifact, 'must-remain');
  await startDesktop(data, port);
  await stopDesktop();
  check('US-D9: 启动清理不删除仅近似本工具命名的批次文件',
    (await Promise.all(nearMatchArtifacts.map(artifact => fileEquals(artifact, 'must-remain')))).every(Boolean));
} finally {
  await stopDesktop();
  await rm(sentinelFile, { force: true });
  await rm(data, { recursive: true, force: true });
}

if (failures) console.log(`--- desktop recovery server log ---\n${serverLog}`);
console.log(failures ? `DESKTOP RECOVERY E2E DONE (${failures}/${checks} FAILED)` : `DESKTOP RECOVERY E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
