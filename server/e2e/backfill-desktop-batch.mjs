// E2E(#7): a desktop batch backfill is idempotent, copies both files, and reconciles telemetry.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const scratch = await mkdtemp(join(tmpdir(), 'open-lens-backfill-e2e-'));
const source = join(scratch, 'batch');
const data = join(scratch, 'data');
let failures = 0;
let checks = 0;

function check(name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  #7: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function backfill() {
  const result = spawnSync(join(ROOT, 'server/node_modules/.bin/tsx'), [
    'server/scripts/backfill-desktop-batch.ts', '--source', source, '--data', data,
    '--document-id', 'test-desktop-batch', '--name', 'Test desktop batch', '--apply',
  ], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  await mkdir(join(source, 'raw'), { recursive: true });
  await mkdir(join(source, 'outputs'), { recursive: true });
  const records = {
    'A.jpg': {
      mode: 'screen', edited: true, labelW: 1000, labelH: 750, sourceW: 2000, sourceH: 1500,
      proposal: { quad: [[10, 20], [900, 20], [900, 700], [10, 700]], ms: 17, mode: 'auto' },
      quad: [[20, 30], [910, 30], [910, 710], [20, 710]], labeledAt: '2026-08-17T17:11:53.196Z',
    },
    'B.png': {
      mode: 'document', edited: false, labelW: 500, labelH: 1000, sourceW: 1000, sourceH: 2000,
      proposal: null,
      quad: [[25, 50], [475, 50], [475, 950], [25, 950]], labeledAt: '2026-08-17T17:12:53.196Z',
    },
    'C.jpg': {
      mode: 'screen', edited: false, labelW: 1000, labelH: 750, sourceW: 2000, sourceH: 1500,
      proposal: { quad: [[20, 30], [910, 30], [910, 710], [20, 710]], ms: 19, mode: 'screen' },
      noTarget: true, labeledAt: '2026-08-17T17:13:53.196Z',
    },
  };
  const metaText = `${JSON.stringify(records, null, 2)}\n`;
  await writeFile(join(source, 'batch-meta.json'), metaText);
  await writeFile(join(source, 'raw/A.jpg'), 'original-a');
  await writeFile(join(source, 'raw/B.png'), 'original-b');
  await writeFile(join(source, 'raw/C.jpg'), 'original-c');
  await writeFile(join(source, 'outputs/A-corrected.jpg'), 'corrected-a');
  await writeFile(join(source, 'outputs/B-corrected.jpg'), 'corrected-b');

  const first = backfill();
  const second = backfill();
  const firstSummary = JSON.parse(first.slice(0, first.indexOf('\n{\n  "ok": true')));
  check('首次写入复制 Original 与 corrected 文件', first.includes('"copiedFiles": 4'));
  check('重复执行不重复复制未变化文件', second.includes('"copiedFiles": 0'));
  check('回填不改写源 batch-meta', await readFile(join(source, 'batch-meta.json'), 'utf8') === metaText);

  const db = new Database(join(data, 'openlens.db'), { readonly: true });
  const docs = db.prepare('SELECT id, name FROM docs').all();
  const rows = db.prepare('SELECT * FROM pages ORDER BY idx').all();
  check('US-D9: noTarget 记录单独计入 skipped 摘要且不写入 pages', firstSummary.expected.skipped.noTarget === 1
    && !rows.some(row => row.id.endsWith('_C')));
  check('幂等保持一个 document 与两页', docs.length === 1 && rows.length === 2);
  check('edited 与 mode 分布逐项一致', rows.filter(row => row.edited).length === 1
    && rows.map(row => JSON.parse(row.detect_meta).mode).join(',') === 'screen,document');
  check('US-D9: detect_meta 标记 desktop-batch 且顶层 proposal=null 原样落库', rows.every(row => JSON.parse(row.detect_meta).source === 'desktop-batch')
    && JSON.parse(rows[1].detect_meta).proposal === null);
  check('quad/proposal 放大到归档原图坐标系', JSON.stringify(JSON.parse(rows[0].quad)[0]) === '[40,60]'
    && JSON.stringify(JSON.parse(rows[0].detect_meta).proposal[0]) === '[20,40]');
  db.close();
  check('归档文件内容可独立读取', await readFile(join(data, rows[0].original_path), 'utf8') === 'original-a'
    && await readFile(join(data, rows[0].scan_path), 'utf8') === 'corrected-a');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `E2E DONE (${failures}/${checks} FAILED)` : `E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
