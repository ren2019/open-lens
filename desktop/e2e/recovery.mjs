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

function spawnDesktopProcess(data, port, failpoint = '', testMode = Boolean(failpoint), environment = {}) {
  let log = '';
  const child = spawn(process.execPath, ['desktop/server.js', '--data', data, '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPEN_LENS_DESKTOP_TEST_FAILPOINT: failpoint,
      OPEN_LENS_DESKTOP_TEST_MODE: testMode ? '1' : '',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = chunk => {
    const text = chunk.toString();
    log += text;
    serverLog += text;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return { child, log: () => log };
}

async function startDesktop(data, port, failpoint = '', testMode = Boolean(failpoint), environment = {}) {
  desktop = spawnDesktopProcess(data, port, failpoint, testMode, environment).child;
  await waitFor(`http://127.0.0.1:${port}/api/health`);
}

async function stopProcess(child) {
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
}

async function stopDesktop() {
  await stopProcess(desktop);
}

async function waitForExit(timeoutMs = 1500) {
  if (desktop.exitCode !== null) return desktop.exitCode;
  return await Promise.race([
    new Promise(resolve => desktop.once('exit', resolve)),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function waitForProcessExit(child, timeoutMs = 1500) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise(resolve => {
    const onExit = code => {
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(null);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function waitForReadyOrExit(instance, port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
      return { ready: false, exit: instance.child.exitCode, signal: instance.child.signalCode };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { ready: true, exit: null, signal: null };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { ready: false, exit: null, signal: null };
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`file did not appear: ${file}`);
}

async function saveArtifactPaths(data) {
  const root = (await readdir(data)).filter(name => name.startsWith('.desktop-save-transaction')
    || (name.startsWith('.batch-meta.json.') && name.endsWith('.tmp'))).map(name => join(data, name));
  const label = (await readdir(join(data, 'label'))).filter(name => name.startsWith('.ground-truth.json.') && name.endsWith('.tmp'))
    .map(name => join(data, 'label', name));
  const outputs = (await readdir(join(data, 'outputs'))).filter(name => name.includes('.save-backup') || name.endsWith('.tmp'))
    .map(name => join(data, 'outputs', name));
  return [...root, ...label, ...outputs].sort();
}

async function saveArtifacts(data) {
  return (await saveArtifactPaths(data)).map(file => file.slice(data.length + 1));
}

async function ownershipArtifacts(data) {
  return (await readdir(data)).filter(name => name.startsWith('.desktop-owner')).sort();
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
const ownerLockFile = join(data, '.desktop-owner.lock');
const sentinelFile = join(tmpdir(), `${basename(data)}-outside-sentinel.txt`);
const sentinelContents = 'outside-batch-must-not-change';
const transactionUuid = '12345678-1234-4234-8234-123456789abc';
const validMetaTemporary = `.batch-meta.json.123-${transactionUuid}.tmp`;
const validGtTemporary = `.ground-truth.json.123-${transactionUuid}.tmp`;
const validOutputTarget = basename(outputFile);
const validOutputBackup = `.${validOutputTarget}.${transactionUuid}.save-backup`;
const unusualRawId = 'slide\\draft.jpg';
const unusualGtId = 'slide-backslash.png';
const unusualOutputFile = join(data, 'outputs', 'slide\\draft-corrected.jpg');
const unusualOutput = Buffer.from('known-good-backslash-output');
const emptyStemOutputFile = join(data, 'outputs', '-corrected.jpg');
const emptyStemOutput = Buffer.from('known-good-empty-stem-output');
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

async function bufferFileEquals(file, expected) {
  try { return (await readFile(file)).equals(expected); }
  catch { return false; }
}

async function fileMissing(file) {
  try { await readFile(file); return false; }
  catch (e) { return e.code === 'ENOENT'; }
}

async function saveStateSnapshot() {
  const files = [metaFile, gtFile, outputFile, ...await saveArtifactPaths(data)];
  const entries = [];
  for (const file of [...new Set(files)].sort()) {
    try { entries.push([file.slice(data.length + 1), (await readFile(file)).toString('base64')]); }
    catch (e) { if (e.code !== 'ENOENT') throw e; else entries.push([file.slice(data.length + 1), null]); }
  }
  return JSON.stringify(entries);
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

async function checkUnusualNameRecovery(name, id, labelId, correctedFile, correctedContents) {
  const beforeMeta = await readFile(metaFile, 'utf8');
  const beforeGt = await readFile(gtFile, 'utf8');
  await writeFile(correctedFile, correctedContents);
  await startDesktop(data, port, 'crash-after-meta-rename');
  try {
    await fetch(`${base}/api/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        rec: { mode: 'screen', edited: true, noTarget: true },
        gtId: labelId,
        gtRec: { mode: 'screen', noTarget: true },
      }),
    });
  } catch {}
  const exit = await waitForExit();
  await stopDesktop();
  await startDesktop(data, port);
  check(`US-D9: ${name}的半提交可恢复且不留 artifact`,
    exit === 86
      && await fileEquals(metaFile, beforeMeta)
      && await fileEquals(gtFile, beforeGt)
      && await bufferFileEquals(correctedFile, correctedContents)
      && (await saveArtifacts(data)).length === 0,
    `exit=${exit} artifacts=${(await saveArtifacts(data)).join(',')}`);
  await stopDesktop();
  await rm(transactionFile, { force: true });
  const correctedName = basename(correctedFile);
  for (const artifact of await readdir(join(data, 'outputs'))) {
    if (artifact === correctedName || artifact.startsWith(`.${correctedName}.`)) {
      await rm(join(data, 'outputs', artifact), { force: true });
    }
  }
  await writeFile(metaFile, beforeMeta);
  await writeFile(gtFile, beforeGt);
}

try {
  run(process.execPath, ['desktop/ingest.js', '--data', data, fixture]);
  await restoreOriginals();

  const competingPort = await freePort();
  await startDesktop(data, port, 'pause-before-gt-rename', true,
    { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });
  const firstSave = fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
  }).then(async response => ({ status: response.status, body: await response.text() }))
    .catch(error => ({ status: 0, body: error.message }));
  await waitForFile(transactionFile);
  const suspendedOwner = process.platform !== 'win32';
  if (suspendedOwner) desktop.kill('SIGSTOP');
  await new Promise(resolve => setTimeout(resolve, 2500));
  const beforeCompetitors = await saveStateSnapshot();
  const samePortCompetitor = spawnDesktopProcess(data, port);
  const differentPortCompetitor = spawnDesktopProcess(data, competingPort, '', false,
    { LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai' });
  const [samePortExit, differentPortExit] = await Promise.all([
    waitForProcessExit(samePortCompetitor.child),
    waitForProcessExit(differentPortCompetitor.child),
  ]);
  const afterCompetitors = await saveStateSnapshot();
  check('US-D9: 同端口第二实例因批次所有权快速拒绝且不触碰进行中的保存',
    samePortExit === 1 && samePortCompetitor.log().includes('批次已被 desktop 进程占用')
      && afterCompetitors === beforeCompetitors,
    `exit=${samePortExit} log=${samePortCompetitor.log().trim()}`);
  check('US-D9: 不同 locale、时区与端口的第二实例仍识别同一 owner 并拒绝且不触碰保存',
    differentPortExit === 1 && differentPortCompetitor.log().includes('批次已被 desktop 进程占用')
      && afterCompetitors === beforeCompetitors,
    `exit=${differentPortExit} log=${differentPortCompetitor.log().trim()}`);
  await stopProcess(samePortCompetitor.child);
  await stopProcess(differentPortCompetitor.child);
  if (suspendedOwner) desktop.kill('SIGCONT');
  const firstSaveResult = await firstSave;
  const firstHealth = await fetch(`${base}/api/health`);
  check('US-D9: 暂停 owner 拒绝第二实例后恢复并完成保存且服务存活',
    firstSaveResult.status === 200 && firstHealth.ok && await noTargetCommitted()
      && (await saveArtifacts(data)).length === 0,
    `sigstop=${suspendedOwner} status=${firstSaveResult.status} body=${firstSaveResult.body} artifacts=${(await saveArtifacts(data)).join(',')}`);
  await stopDesktop();
  await startDesktop(data, port);
  await stopDesktop();
  await restoreOriginals();

  await startDesktop(data, port, 'pause-before-gt-rename');
  const crashedOwnerPid = desktop.pid;
  const crashedSave = fetch(`${base}/api/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noTargetSave),
  }).catch(() => null);
  await waitForFile(transactionFile);
  const crashedOwnerExitPromise = new Promise(resolve => desktop.once('exit', (code, signal) => resolve({ code, signal })));
  desktop.kill('SIGKILL');
  const crashedOwnerExit = await crashedOwnerExitPromise;
  await crashedSave;
  const secondTakeoverPort = await freePort();
  const takeoverCandidates = [
    { instance: spawnDesktopProcess(data, port), port },
    { instance: spawnDesktopProcess(data, secondTakeoverPort), port: secondTakeoverPort },
  ];
  const takeoverResults = await Promise.all(takeoverCandidates.map(candidate =>
    waitForReadyOrExit(candidate.instance, candidate.port)));
  const winnerIndexes = takeoverResults.flatMap((result, index) => result.ready ? [index] : []);
  const winnerIndex = winnerIndexes[0];
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  const winner = takeoverCandidates[winnerIndex];
  const loser = takeoverCandidates[loserIndex];
  const loserExit = loser ? await waitForProcessExit(loser.instance.child) : null;
  check('US-D9: 两个 stale 接管者并发启动时最多一台获得批次所有权',
    crashedOwnerExit.signal === 'SIGKILL' && winnerIndexes.length === 1 && loserExit === 1
      && loser.instance.log().includes('批次已被 desktop 进程占用'),
    `crash=${crashedOwnerExit.code}/${crashedOwnerExit.signal} ready=${winnerIndexes.length} loserExit=${loserExit}`);
  check('US-D9: stale owner 接管胜者恢复半提交且失败接管者不破坏数据',
    winner?.instance.log().includes(`接管 stale owner (pid ${crashedOwnerPid}, 进程已退出)`)
      && await originalsRestored() && (await saveArtifacts(data)).length === 0,
    `winnerLog=${winner?.instance.log().trim()} artifacts=${(await saveArtifacts(data)).join(',')}`);
  for (const candidate of takeoverCandidates) {
    if (candidate !== winner) await stopProcess(candidate.instance.child);
  }
  desktop = winner?.instance.child;
  await stopDesktop();
  check('US-D9: 接管实例正常退出后清理 owner 与 claim',
    await fileMissing(ownerLockFile) && (await ownershipArtifacts(data)).length === 0,
    `artifacts=${(await ownershipArtifacts(data)).join(',')}`);
  await restoreOriginals();

  const reusedPidToken = '87654321-4321-4321-8321-abcdefabcdef';
  const reusedPidOwner = { version: 1, pid: process.pid, identity: 'reused-owner-start-identity', token: reusedPidToken };
  const reusedPidClaim = join(data, `.desktop-owner.lock.reclaim-${reusedPidToken}`);
  const reusedClaimOwner = {
    version: 1, pid: process.pid, identity: 'reused-claim-start-identity',
    token: 'fedcba98-7654-4321-8fed-cba987654321',
  };
  await writeFile(ownerLockFile, JSON.stringify(reusedPidOwner));
  await writeFile(reusedPidClaim, JSON.stringify(reusedClaimOwner));
  const reusedPidLogStart = serverLog.length;
  await startDesktop(data, port);
  const reusedPidLog = serverLog.slice(reusedPidLogStart);
  const reusedPidHealth = await fetch(`${base}/api/health`);
  check('US-D9: PID 已复用但 owner 与 claim 启动身份不同时新实例可接管且服务正常',
    reusedPidHealth.ok && reusedPidLog.includes(`接管 stale owner (pid ${process.pid}, PID 已复用)`),
    `log=${reusedPidLog.trim()}`);
  await stopDesktop();
  check('US-D9: PID reuse 接管退出后不遗留所有权 artifact',
    (await ownershipArtifacts(data)).length === 0,
    `artifacts=${(await ownershipArtifacts(data)).join(',')}`);
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

  await checkUnusualNameRecovery('macOS 合法反斜杠 basename', unusualRawId, unusualGtId, unusualOutputFile, unusualOutput);
  await checkUnusualNameRecovery('空 stem basename', '.jpg', '.png', emptyStemOutputFile, emptyStemOutput);
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
  const unsafeExit = await waitForExit(5000);
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
