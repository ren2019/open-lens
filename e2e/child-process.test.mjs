// E2E(US-D9): test gates must reclaim children that hang or ignore SIGTERM.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcessGroup, spawnProcessGroup, terminateChild, waitForChildExit } from './child-process.mjs';

let failures = 0;
let checks = 0;

function check(name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  US-D9: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function reclaimTestGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 1000;
  while (isAlive(-child.pid)) {
    if (Date.now() >= deadline) throw new Error('test process group did not exit after SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function guardLifecycle(operation, child, label) {
  let watchdog;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          void reclaimTestGroup(child).catch(() => {});
          reject(new Error(`${label} exceeded the 2500ms self-test watchdog`));
        }, 2500);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

async function stubbornProcessGroup() {
  const grandchildProgram = `
    process.on('SIGTERM', () => {});
    console.log('grandchild-ready');
    setInterval(() => {}, 1000);
  `;
  const wrapperProgram = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const grandchild = spawn(process.execPath, ['--eval', ${JSON.stringify(grandchildProgram)}], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    grandchild.stdout.setEncoding('utf8');
    let output = '';
    grandchild.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('grandchild-ready')) process.stdout.write('ready:' + grandchild.pid + '\\n');
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawnProcessGroup(process.execPath, ['--eval', wrapperProgram], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.setEncoding('utf8');
  try {
    const grandchildPid = await new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (pid, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdout.off('data', onData);
        if (error) reject(error);
        else resolve(pid);
      };
      const onError = error => finish(null, error);
      const onExit = (code, signal) => finish(null,
        new Error(`stubborn wrapper exited before ready: code=${code} signal=${signal}`));
      const onData = chunk => {
        output += chunk;
        const match = /ready:(\d+)\r?\n/.exec(output);
        if (match) finish(Number(match[1]));
      };
      const timeout = setTimeout(() => finish(null,
        new Error('stubborn process group did not become ready')), 2000);
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout.on('data', onData);
    });
    return { child, grandchildPid };
  } catch (error) {
    await reclaimTestGroup(child);
    throw error;
  }
}

const unsupportedMarker = join(tmpdir(), `open-lens-win32-process-group-${process.pid}-${Date.now()}`);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
let unsupportedChild;
let unsupportedError;
Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
try {
  unsupportedChild = spawnProcessGroup(process.execPath, ['--eval', `
    require('node:fs').writeFileSync(${JSON.stringify(unsupportedMarker)}, String(process.pid));
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
} catch (error) {
  unsupportedError = error;
} finally {
  Object.defineProperty(process, 'platform', platformDescriptor);
}
await new Promise(resolve => setTimeout(resolve, 100));
const unsupportedPid = existsSync(unsupportedMarker) ? Number(readFileSync(unsupportedMarker, 'utf8')) : null;
if (unsupportedChild) await terminateChild(unsupportedChild, {
  label: 'unexpected unsupported-platform child', processGroup: true,
});
else if (unsupportedPid && isAlive(unsupportedPid)) {
  try { process.kill(-unsupportedPid, 'SIGKILL'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }
}
check('不支持 POSIX process group 的平台在 spawn 前 fail-closed 且不产生 PID',
  unsupportedError?.message.includes('POSIX') && !existsSync(unsupportedMarker) && unsupportedChild === undefined,
  `${unsupportedError?.message || 'no error'} pid=${unsupportedPid}`);
rmSync(unsupportedMarker, { force: true });

const boundedGrandchildProgram = `
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
`;
const boundedWrapperProgram = `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => {});
  const grandchild = spawn(process.execPath, ['--eval', ${JSON.stringify(boundedGrandchildProgram)}], {
    stdio: 'ignore',
  });
  console.log('grandchild:' + grandchild.pid);
  setInterval(() => {}, 1000);
`;
const boundedStartedAt = Date.now();
let boundedError;
try {
  await runProcessGroup(process.execPath, ['--eval', boundedWrapperProgram], {
    label: 'hung process-tree self-test',
    timeoutMs: 500,
    termTimeoutMs: 50,
    killTimeoutMs: 1000,
    encoding: 'utf8',
  });
} catch (error) {
  boundedError = error;
}
const boundedPid = boundedError?.childPid;
const boundedGrandchildPid = Number(/grandchild:(\d+)/.exec(boundedError?.stdout || '')?.[1]);
check('hung 命令有界失败并确认两级进程全部退出', boundedError?.message.includes('timed out after 500ms')
  && Date.now() - boundedStartedAt < 2500
  && Boolean(boundedPid) && Boolean(boundedGrandchildPid)
  && !isAlive(boundedPid) && !isAlive(boundedGrandchildPid),
`${boundedError?.message || 'no error'} pid=${boundedPid} grandchild=${boundedGrandchildPid}`);
if (boundedPid) await reclaimTestGroup({ pid: boundedPid });

const stopped = await stubbornProcessGroup();
const stoppedPid = stopped.child.pid;
let stoppedExit;
let stoppedGrandchildSurvived;
try {
  stoppedExit = await guardLifecycle(terminateChild(stopped.child, {
    label: 'ignore-SIGTERM termination self-test',
    termTimeoutMs: 50,
    killTimeoutMs: 1000,
    processGroup: true,
  }), stopped.child, 'ignore-SIGTERM termination');
  stoppedGrandchildSurvived = isAlive(stopped.grandchildPid);
} finally {
  await reclaimTestGroup(stopped.child);
}
check('主动停止对 ignore-SIGTERM 进程组升级 SIGKILL 并确认两级进程退出',
  stoppedExit.signal === 'SIGKILL' && !isAlive(stoppedPid) && !stoppedGrandchildSurvived,
  `${JSON.stringify(stoppedExit)} grandchildSurvived=${stoppedGrandchildSurvived}`);

const timedOut = await stubbornProcessGroup();
const timedOutPid = timedOut.child.pid;
const startedAt = Date.now();
let timeoutError;
let timedOutGrandchildSurvived;
try {
  await guardLifecycle(waitForChildExit(timedOut.child, {
    label: 'hung wait self-test',
    timeoutMs: 50,
    termTimeoutMs: 50,
    killTimeoutMs: 1000,
    processGroup: true,
  }), timedOut.child, 'hung wait');
} catch (error) {
  timeoutError = error;
  timedOutGrandchildSurvived = isAlive(timedOut.grandchildPid);
} finally {
  await reclaimTestGroup(timedOut.child);
}
check('等待 hung 进程组有界失败且回收两级进程', timeoutError?.message.includes('timed out after 50ms')
  && Date.now() - startedAt < 2000 && !isAlive(timedOutPid) && !timedOutGrandchildSurvived,
  `${timeoutError?.message || 'no error'} grandchildSurvived=${timedOutGrandchildSurvived}`);

console.log(failures
  ? `CHILD PROCESS E2E DONE (${failures}/${checks} FAILED)`
  : `CHILD PROCESS E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
