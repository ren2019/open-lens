// US 级 e2e runner。无现成服务时自动启动隔离 API + Vite；可用 `... run.mjs US-A4` 单跑。
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = process.env.OL_BASE || 'http://127.0.0.1:5173';
const API = process.env.OL_API || 'http://127.0.0.1:8787';
const TOKEN = process.env.OL_TOKEN || 'dev-token';
const suites = new Map([
  ['US-G3', 'us/us-g3-auth.mjs'],
  ['US-A2', 'us/us-a2-shutter.mjs'],
  ['US-A3', 'us/us-a3-multipage.mjs'],
  ['US-A4', 'us/us-a4-album.mjs'],
  ['US-B1', 'us/us-b1-crop.mjs'],
  ['US-B1-B2-CV', 'us/us-b1-b2-real-detection.mjs'],
  ['US-DETECTOR-MODE', 'us/us-detector-mode.mjs'],
  ['US-C1', 'us/us-c1-enhancement.mjs'],
  ['US-D3', 'us/us-d3-tags.mjs'],
  ['US-D1', 'us/us-d1-page-order.mjs'],
  ['US-D2', 'us/us-d2-rename.mjs'],
  ['US-E1', 'us/us-e1-image-export.mjs'],
  ['US-E2-E3', 'us/us-e2-e3-outfits.mjs'],
  ['US-F1', 'us/us-f1-archive.mjs'],
  ['US-D4', 'us/us-d4-library.mjs'],
]);

const requested = process.argv.slice(2).map(value => value.toUpperCase());
const selected = requested.length ? [...suites].filter(([id]) => requested.includes(id)) : [...suites];
if (!selected.length || selected.length !== (requested.length || selected.length)) {
  console.error(`Unknown suite. Available: ${[...suites.keys()].join(', ')}`);
  process.exit(2);
}

const children = [];
let dataDir = null;

async function reachable(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch { return false; }
}

async function waitFor(url, headers = {}) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await reachable(url, headers)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error(`service did not become ready: ${url}`);
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  return child;
}

async function ensureServices() {
  if (!await reachable(`${API}/api/docs`, { Authorization: `Bearer ${TOKEN}` })) {
    const apiUrl = new URL(API);
    dataDir = await mkdtemp(join(tmpdir(), 'open-lens-e2e-'));
    start('npm', ['--prefix', 'server', 'run', 'start'], {
      PORT: apiUrl.port || '8787', DATA_DIR: dataDir, OL_TOKEN: TOKEN,
    });
    await waitFor(`${API}/api/docs`, { Authorization: `Bearer ${TOKEN}` });
  }
  if (!await reachable(BASE)) {
    const appUrl = new URL(BASE);
    start('npm', ['--prefix', 'app', 'run', 'dev', '--', '--host', appUrl.hostname, '--port', appUrl.port || '5173'], {
      VITE_API_BASE: API,
    });
    await waitFor(BASE);
  }
}

async function runSuite(file) {
  return await new Promise(resolveRun => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
      cwd: ROOT,
      env: { ...process.env, OL_BASE: BASE, OL_API: API, OL_TOKEN: TOKEN },
      stdio: 'inherit',
    });
    child.on('exit', code => resolveRun(code ?? 1));
  });
}

let failed = 0;
try {
  await ensureServices();
  for (const [id, file] of selected) {
    console.log(`\n=== ${id} ===`);
    if (await runSuite(file)) failed++;
  }
} finally {
  for (const child of children.reverse()) child.kill('SIGTERM');
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

console.log(`\nE2E GROUPS DONE (${selected.length - failed}/${selected.length} PASS)`);
process.exit(failed ? 1 : 0);
