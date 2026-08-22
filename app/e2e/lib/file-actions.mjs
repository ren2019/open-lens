import { readFile } from 'node:fs/promises';

export async function observeFileAction(page, click, {
  shareCount = null,
  shareOutcome = null,
  fallbackSelector = null,
  timeout = 30000,
} = {}) {
  let interval;
  let timeoutId;
  let onDownload;
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const download = new Promise(resolve => {
    onDownload = async event => {
      const path = await event.path();
      const data = await readFile(path);
      resolve({ kind: 'download', name: event.suggestedFilename(), bytes: data.length, data });
    };
    page.on('download', onDownload);
  });
  const poll = async () => {
    try {
      const state = await page.evaluate(({ expectedShareCount, expectedShareOutcome, selector }) => ({
        share: expectedShareCount !== null && window.__olShares?.length === expectedShareCount,
        outcome: expectedShareOutcome !== null && window.__olShareOutcomes?.includes(expectedShareOutcome),
        fallback: !!selector && !!document.querySelector(selector),
      }), { expectedShareCount: shareCount, expectedShareOutcome: shareOutcome, selector: fallbackSelector });
      if (state.share) resolveResult({ kind: 'share' });
      else if (state.outcome) resolveResult({ kind: shareOutcome });
      else if (state.fallback) resolveResult({ kind: 'fallback' });
    } catch { resolveResult({ kind: 'unavailable' }); }
  };
  interval = setInterval(() => { void poll(); }, 50);
  timeoutId = setTimeout(() => resolveResult({ kind: 'timeout' }), timeout);
  try {
    await click();
    return await Promise.race([result, download]);
  } finally {
    clearInterval(interval);
    clearTimeout(timeoutId);
    page.off('download', onDownload);
  }
}
