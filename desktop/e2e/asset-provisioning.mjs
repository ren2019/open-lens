// E2E(US-D9): a clean checkout with npm dependencies can start Desktop without ignored app assets.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateChild } from '../../e2e/child-process.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'open-lens-desktop-assets-e2e-'));
const cleanRoot = join(scratch, 'checkout');
let failures = 0;
let checks = 0;
let child;

function check(name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  US-D9: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
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

async function waitForHealth(url, process) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && process.exitCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

try {
  await mkdir(cleanRoot, { recursive: true });
  const archive = join(scratch, 'checkout.tar');
  const gitArchive = spawnSync('git', ['archive', '--format=tar', '--output', archive, 'HEAD'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (gitArchive.status !== 0) throw new Error(`git archive failed: ${gitArchive.stderr}`);
  const extracted = spawnSync('tar', ['-xf', archive, '-C', cleanRoot], { encoding: 'utf8' });
  if (extracted.status !== 0) throw new Error(`checkout extraction failed: ${extracted.stderr}`);
  let ignoredOpenCvAbsent = false;
  try { await access(join(cleanRoot, 'app/public/opencv.js')); }
  catch { ignoredOpenCvAbsent = true; }
  const installed = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: cleanRoot, encoding: 'utf8', timeout: 120_000,
  });
  if (installed.status !== 0) throw new Error(`clean-checkout npm ci failed:\n${installed.stdout}\n${installed.stderr}`);

  const port = await freePort();
  child = spawn(process.execPath, ['desktop/server.js', '--data', join(cleanRoot, 'data'), '--port', String(port)], {
    cwd: cleanRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
  check('tracked clean checkout 只凭 npm ci 的 pinned OpenCV asset 即可启动 Desktop', ignoredOpenCvAbsent
    && health?.ok === true
    && log.includes('@techstark/opencv-js@4.12.0-release.1')
    && log.includes('bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103'),
  log.trim());
} finally {
  await terminateChild(child, { label: 'clean-checkout Desktop server', processGroup: true });
  await rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `ASSET E2E DONE (${failures}/${checks} FAILED)` : `ASSET E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
