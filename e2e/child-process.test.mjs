// E2E(US-D9): test gates must reclaim children that hang or ignore SIGTERM.
import { spawn } from 'node:child_process';
import { terminateChild, waitForChildExit } from './child-process.mjs';

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

async function stubbornChild() {
  const child = spawn(process.execPath, ['--eval', `
    process.on('SIGTERM', () => {});
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stubborn child did not become ready')), 2000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.once('data', chunk => {
      clearTimeout(timeout);
      if (chunk.includes('ready')) resolve();
      else reject(new Error(`unexpected child output: ${chunk}`));
    });
  });
  return child;
}

async function guardLifecycle(operation, child, label) {
  let watchdog;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${label} exceeded the 2500ms self-test watchdog`));
        }, 2500);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

const stopped = await stubbornChild();
const stoppedPid = stopped.pid;
let stoppedExit;
try {
  stoppedExit = await guardLifecycle(terminateChild(stopped, {
    label: 'ignore-SIGTERM termination self-test',
    termTimeoutMs: 50,
    killTimeoutMs: 1000,
  }), stopped, 'ignore-SIGTERM termination');
} finally {
  await terminateChild(stopped, { label: 'ignore-SIGTERM termination self-test cleanup' });
}
check('主动停止对 ignore-SIGTERM 子进程升级 SIGKILL 并确认退出',
  stoppedExit.signal === 'SIGKILL' && !isAlive(stoppedPid), JSON.stringify(stoppedExit));

const timedOut = await stubbornChild();
const timedOutPid = timedOut.pid;
const startedAt = Date.now();
let timeoutError;
try {
  await guardLifecycle(waitForChildExit(timedOut, {
    label: 'hung wait self-test',
    timeoutMs: 50,
    termTimeoutMs: 50,
    killTimeoutMs: 1000,
  }), timedOut, 'hung wait');
} catch (error) {
  timeoutError = error;
} finally {
  await terminateChild(timedOut, { label: 'hung wait self-test cleanup' });
}
check('等待 hung 子进程有界失败且回收进程', timeoutError?.message.includes('timed out after 50ms')
  && Date.now() - startedAt < 2000 && !isAlive(timedOutPid), timeoutError?.message || 'no error');

console.log(failures
  ? `CHILD PROCESS E2E DONE (${failures}/${checks} FAILED)`
  : `CHILD PROCESS E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
