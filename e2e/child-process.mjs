import { spawn } from 'node:child_process';

const hasExited = child => child.exitCode !== null || child.signalCode !== null;

const exitStatus = child => ({ code: child.exitCode, signal: child.signalCode });

export function assertProcessGroupSupport() {
  if (process.platform === 'win32') {
    throw new Error('detached process groups require a POSIX platform; refusing to spawn');
  }
}

export function spawnProcessGroup(command, args, options = {}) {
  assertProcessGroupSupport();
  return spawn(command, args, { ...options, detached: true });
}

function processGroupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function targetExited(child, processGroup) {
  return hasExited(child) && (!processGroup || !processGroupAlive(child.pid));
}

function signalTarget(child, signal, processGroup) {
  if (!processGroup) return child.kill(signal);
  assertProcessGroupSupport();
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForExitEvent(child, timeoutMs, label, processGroup) {
  if (targetExited(child, processGroup)) return Promise.resolve(exitStatus(child));
  return new Promise((resolve, reject) => {
    let settled = false;
    let poll;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(status);
    };
    const inspect = () => {
      if (targetExited(child, processGroup)) finish(exitStatus(child));
    };
    const onExit = () => inspect();
    const onError = error => finish(null, error);
    const timeout = setTimeout(() => {
      const error = new Error(`${label} did not exit within ${timeoutMs}ms`);
      error.code = 'OPEN_LENS_CHILD_TIMEOUT';
      finish(null, error);
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    if (processGroup) poll = setInterval(inspect, 10);
    inspect();
  });
}

export async function terminateChild(child, {
  label = 'child process',
  termTimeoutMs = 5000,
  killTimeoutMs = 5000,
  processGroup = false,
} = {}) {
  if (!child) return { code: null, signal: null };
  if (targetExited(child, processGroup)) return exitStatus(child);
  signalTarget(child, 'SIGTERM', processGroup);
  try {
    return await waitForExitEvent(child, termTimeoutMs, `${label} after SIGTERM`, processGroup);
  } catch (termError) {
    if (targetExited(child, processGroup)) return exitStatus(child);
    signalTarget(child, 'SIGKILL', processGroup);
    try {
      return await waitForExitEvent(child, killTimeoutMs, `${label} after SIGKILL`, processGroup);
    } catch (killError) {
      throw new Error(`${label} could not be reclaimed after SIGTERM then SIGKILL`, {
        cause: new AggregateError([termError, killError]),
      });
    }
  }
}

export async function waitForChildExit(child, {
  label = 'child process',
  timeoutMs = 60_000,
  termTimeoutMs = 5000,
  killTimeoutMs = 5000,
  processGroup = false,
} = {}) {
  try {
    return await waitForExitEvent(child, timeoutMs, label, processGroup);
  } catch (timeoutError) {
    if (timeoutError?.code !== 'OPEN_LENS_CHILD_TIMEOUT') throw timeoutError;
    try {
      await terminateChild(child, { label, termTimeoutMs, killTimeoutMs, processGroup });
    } catch (terminationError) {
      throw new Error(`${label} timed out after ${timeoutMs}ms and could not be reclaimed`, {
        cause: new AggregateError([timeoutError, terminationError]),
      });
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms; child reclaimed`, { cause: timeoutError });
  }
}

export async function runProcessGroup(command, args, {
  label = String(command),
  timeoutMs = 60_000,
  termTimeoutMs = 5000,
  killTimeoutMs = 5000,
  encoding = 'utf8',
  input,
  ...options
} = {}) {
  const child = spawnProcessGroup(command, args, {
    ...options,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  if (encoding) {
    child.stdout?.setEncoding(encoding);
    child.stderr?.setEncoding(encoding);
  }
  child.stdout?.on('data', chunk => stdout.push(chunk));
  child.stderr?.on('data', chunk => stderr.push(chunk));
  child.stdin?.end(input);
  const output = chunks => encoding ? chunks.join('') : Buffer.concat(chunks);
  try {
    const status = await waitForChildExit(child, {
      label, timeoutMs, termTimeoutMs, killTimeoutMs, processGroup: true,
    });
    return {
      status: status.code,
      signal: status.signal,
      stdout: output(stdout),
      stderr: output(stderr),
      pid: child.pid,
    };
  } catch (error) {
    error.childPid = child.pid;
    error.stdout = output(stdout);
    error.stderr = output(stderr);
    throw error;
  }
}
