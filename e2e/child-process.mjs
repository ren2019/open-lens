const hasExited = child => child.exitCode !== null || child.signalCode !== null;

const exitStatus = child => ({ code: child.exitCode, signal: child.signalCode });

function waitForExitEvent(child, timeoutMs, label) {
  if (hasExited(child)) return Promise.resolve(exitStatus(child));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(status);
    };
    const onExit = (code, signal) => finish({ code, signal });
    const timeout = setTimeout(() => finish(null,
      new Error(`${label} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', onExit);
    if (hasExited(child)) finish(exitStatus(child));
  });
}

export async function terminateChild(child, {
  label = 'child process',
  termTimeoutMs = 5000,
  killTimeoutMs = 5000,
} = {}) {
  if (!child || hasExited(child)) return child ? exitStatus(child) : { code: null, signal: null };
  child.kill('SIGTERM');
  try {
    return await waitForExitEvent(child, termTimeoutMs, `${label} after SIGTERM`);
  } catch (termError) {
    if (hasExited(child)) return exitStatus(child);
    child.kill('SIGKILL');
    try {
      return await waitForExitEvent(child, killTimeoutMs, `${label} after SIGKILL`);
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
} = {}) {
  try {
    return await waitForExitEvent(child, timeoutMs, label);
  } catch (timeoutError) {
    try {
      await terminateChild(child, { label, termTimeoutMs, killTimeoutMs });
    } catch (terminationError) {
      throw new Error(`${label} timed out after ${timeoutMs}ms and could not be reclaimed`, {
        cause: new AggregateError([timeoutError, terminationError]),
      });
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms; child reclaimed`, { cause: timeoutError });
  }
}
