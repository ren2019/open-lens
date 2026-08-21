// E2E(US-D9): a desktop batch backfill is idempotent, copies both files, and reconciles telemetry.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { copyFile, link, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const Database = require('better-sqlite3');
const { orientedDimensions } = require('../desktop/image-orientation.js');
const scratch = await mkdtemp(join(tmpdir(), 'open-lens-backfill-e2e-'));
const source = join(scratch, 'batch');
const data = join(scratch, 'data');
let failures = 0;
let checks = 0;

function check(name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  US-D9: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function backfillResult({ targetData = data, documentId = 'test-desktop-batch' } = {}) {
  return spawnSync(join(ROOT, 'server/node_modules/.bin/tsx'), [
    'server/scripts/backfill-desktop-batch.ts', '--source', source, '--data', targetData,
    '--document-id', documentId, '--name', 'Test desktop batch', '--apply',
  ], { cwd: ROOT, encoding: 'utf8' });
}

function startPausedBackfill(control, {
  targetData = data,
  documentId = 'test-desktop-batch',
  pause = 'before-final-precondition',
} = {}) {
  const child = spawn(join(ROOT, 'server/node_modules/.bin/tsx'), [
    'server/scripts/backfill-desktop-batch.ts', '--source', source, '--data', targetData,
    '--document-id', documentId, '--name', 'Test desktop batch', '--apply',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPEN_LENS_BACKFILL_TEST_MODE: '1',
      OPEN_LENS_BACKFILL_TEST_PAUSE: pause,
      OPEN_LENS_BACKFILL_TEST_CONTROL: control,
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.output = '';
  child.errorOutput = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', chunk => { child.errorOutput += chunk; });
  return child;
}

async function waitForPause(child, readyFile) {
  if (existsSync(readyFile)) return true;
  if (child.exitCode !== null) return false;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let poll;
    let timeout;
    const finish = (paused, error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(paused);
    };
    const inspect = () => {
      if (existsSync(readyFile)) finish(true);
      else if (child.exitCode !== null) finish(false);
    };
    const onExit = () => finish(existsSync(readyFile));

    child.once('exit', onExit);
    poll = setInterval(inspect, 10);
    // The child waits up to 10 seconds after publishing ready; allow loaded tsx startup and scan margin too.
    timeout = setTimeout(() => {
      if (existsSync(readyFile)) {
        finish(true);
        return;
      }
      const termination = child.kill('SIGTERM') ? 'SIGTERM sent' : 'child already exited';
      finish(false, new Error(`timed out after 60s waiting for backfill pause ${readyFile}; ${termination}`));
    }, 60_000);
    inspect();
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise(resolve => child.once('exit', resolve));
}

function backfill() {
  const result = backfillResult();
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function databaseSnapshot(targetData = data) {
  const db = new Database(join(targetData, 'openlens.db'), { readonly: true });
  const snapshot = {
    docs: db.prepare('SELECT * FROM docs ORDER BY id').all(),
    pages: db.prepare('SELECT * FROM pages ORDER BY id').all(),
  };
  db.close();
  return JSON.stringify(snapshot);
}

async function artifactSnapshot(targetData = data) {
  const db = new Database(join(targetData, 'openlens.db'), { readonly: true });
  const paths = db.prepare('SELECT original_path, scan_path FROM pages ORDER BY id').all()
    .flatMap(row => [row.original_path, row.scan_path]);
  db.close();
  const hashes = [];
  for (const relative of paths) {
    hashes.push([relative, createHash('sha256').update(await readFile(join(targetData, relative))).digest('hex')]);
  }
  return JSON.stringify(hashes);
}

async function createLegacySchema(targetData, foreignCandidateId = '') {
  await mkdir(targetData, { recursive: true });
  const db = new Database(join(targetData, 'openlens.db'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE docs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE pages (
      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL, quad TEXT NOT NULL, enhancement TEXT NOT NULL DEFAULT 'original',
      rotation INTEGER NOT NULL DEFAULT 0, ocr TEXT, original_path TEXT NOT NULL, scan_path TEXT NOT NULL
    );
  `);
  if (foreignCandidateId) {
    db.prepare('INSERT INTO docs (id, name, created_at, tags) VALUES (?, ?, ?, ?)')
      .run('legacy-foreign-doc', 'Legacy foreign document', 1, '[]');
    db.prepare(`
      INSERT INTO pages (id, doc_id, idx, quad, enhancement, rotation, original_path, scan_path)
      VALUES (?, ?, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'original', 0, 'foreign-original.jpg', 'foreign-scan.jpg')
    `).run(foreignCandidateId, 'legacy-foreign-doc');
  }
  db.close();
}

async function checkFileOnlyDivergence(name, archiveFile, replacement, sourceFile) {
  const beforeDb = databaseSnapshot();
  const replacementBytes = Buffer.from(replacement);
  await writeFile(archiveFile, replacementBytes);
  const beforeArtifacts = await artifactSnapshot();
  const result = backfillResult();
  const afterBytes = await readFile(archiveFile);
  const afterDb = databaseSnapshot();
  check(name, result.status !== 0 && result.stderr.includes('artifact has diverged')
    && afterBytes.equals(replacementBytes) && afterDb === beforeDb
    && await artifactSnapshot() === beforeArtifacts,
  `status=${result.status} stderr=${result.stderr.trim()}`);
  await copyFile(sourceFile, archiveFile);
}

try {
  await mkdir(join(source, 'raw'), { recursive: true });
  await mkdir(join(source, 'outputs'), { recursive: true });
  const records = {
    'A.jpg': {
      mode: 'screen', edited: true, labelW: 1000, labelH: 750, sourceW: 2000, sourceH: 1500,
      sourceOrientation: 1, orientedSourceW: 2000, orientedSourceH: 1500,
      proposal: { quad: [[10, 20], [900, 20], [900, 700], [10, 700]], ms: 17, mode: 'auto' },
      quad: [[20, 30], [910, 30], [910, 710], [20, 710]], labeledAt: '2026-08-17T17:11:53.196Z',
    },
    'B.jpg': {
      mode: 'document', edited: false, labelW: 500, labelH: 1000, sourceW: 1000, sourceH: 2000,
      sourceOrientation: 1, orientedSourceW: 1000, orientedSourceH: 2000,
      proposal: null,
      quad: [[25, 50], [475, 50], [475, 950], [25, 950]], labeledAt: '2026-08-17T17:12:53.196Z',
    },
    'C.jpg': {
      mode: 'screen', edited: false, labelW: 1000, labelH: 750, sourceW: 2000, sourceH: 1500,
      sourceOrientation: 1, orientedSourceW: 2000, orientedSourceH: 1500,
      proposal: { quad: [[20, 30], [910, 30], [910, 710], [20, 710]], ms: 19, mode: 'screen' },
      noTarget: true, labeledAt: '2026-08-17T17:13:53.196Z',
    },
    'D.jpg': {
      mode: 'screen', edited: true, labelW: 1000, labelH: 666, sourceW: 1200, sourceH: 1800,
      proposal: { quad: [[100, 80], [900, 80], [900, 586], [100, 586]], ms: 23, mode: 'screen' },
      quad: [[20, 20], [980, 20], [980, 646], [20, 646]], labeledAt: '2026-08-17T17:14:53.196Z',
    },
  };
  const metaText = `${JSON.stringify(records, null, 2)}\n`;
  await writeFile(join(source, 'batch-meta.json'), metaText);
  const orientationOneFixture = join(ROOT, 'spike/photos/real-test-2.jpg');
  const orientationSixFixture = join(ROOT, 'desktop/e2e/fixtures/exif-orientation-examples/Landscape_6.jpg');
  await copyFile(orientationOneFixture, join(source, 'raw/A.jpg'));
  await copyFile(orientationOneFixture, join(source, 'raw/B.jpg'));
  await copyFile(orientationOneFixture, join(source, 'raw/C.jpg'));
  await copyFile(orientationSixFixture, join(source, 'raw/D.jpg'));
  await writeFile(join(source, 'outputs/A-corrected.jpg'), 'corrected-a');
  await writeFile(join(source, 'outputs/B-corrected.jpg'), 'corrected-b');
  await writeFile(join(source, 'outputs/D-corrected.jpg'), 'corrected-d');

  const orientationAudit = [
    [1, orientedDimensions(1200, 1800, 1)],
    [6, orientedDimensions(1200, 1800, 6)],
  ];
  check('已验证的 EXIF 1 保持存储轴、6 交换为浏览器定向轴',
    orientationAudit[0][1].width === 1200 && orientationAudit[0][1].height === 1800
      && orientationAudit[1][1].width === 1800 && orientationAudit[1][1].height === 1200,
    JSON.stringify(orientationAudit));

  const first = backfill();
  const second = backfill();
  const firstSummary = JSON.parse(first.slice(0, first.indexOf('\n{\n  "ok": true')));
  check('首次写入复制 Original 与 corrected 文件', first.includes('"copiedFiles": 6'));
  check('重复执行不重复复制未变化文件', second.includes('"copiedFiles": 0'));
  check('回填不改写源 batch-meta', await readFile(join(source, 'batch-meta.json'), 'utf8') === metaText);

  const db = new Database(join(data, 'openlens.db'));
  const docs = db.prepare('SELECT id, name FROM docs').all();
  const rows = db.prepare('SELECT * FROM pages ORDER BY idx').all();
  check('noTarget 记录单独计入 skipped 摘要且不写入 pages', firstSummary.expected.skipped.noTarget === 1
    && !rows.some(row => row.id.endsWith('_C')));
  check('幂等保持一个 document 与三页', docs.length === 1 && rows.length === 3);
  check('edited 与 mode 分布逐项一致', rows.filter(row => row.edited).length === 2
    && rows.map(row => JSON.parse(row.detect_meta).mode).join(',') === 'screen,document,screen');
  check('detect_meta 标记 desktop-batch 且顶层 proposal=null 原样落库', rows.every(row => JSON.parse(row.detect_meta).source === 'desktop-batch')
    && JSON.parse(rows[1].detect_meta).proposal === null);
  check('quad/proposal 放大到归档原图坐标系', JSON.stringify(JSON.parse(rows[0].quad)[0]) === '[40,60]'
    && JSON.stringify(JSON.parse(rows[0].detect_meta).proposal[0]) === '[20,40]');
  const orientationSixRow = rows.find(row => row.id.endsWith('_D'));
  check('旧 orientation=6 batch 缺少新方向字段时仍从 Original EXIF 得到 1800x1200 归档轴',
    JSON.stringify(JSON.parse(orientationSixRow.quad)) === '[[36,36],[1764,36],[1764,1164],[36,1164]]'
      && JSON.stringify(JSON.parse(orientationSixRow.detect_meta).proposal) === '[[180,144],[1620,144],[1620,1056],[180,1056]]');
  check('归档文件内容可独立读取', (await readFile(join(data, rows[0].original_path))).equals(await readFile(orientationOneFixture))
    && await readFile(join(data, rows[0].scan_path), 'utf8') === 'corrected-a');

  const legacyQuad = [[24, 54], [1176, 54], [1176, 1746], [24, 1746]];
  const legacyProposal = [[120, 216], [1080, 216], [1080, 1584], [120, 1584]];
  const legacyDetectMeta = JSON.parse(orientationSixRow.detect_meta);
  legacyDetectMeta.proposal = legacyProposal;
  delete legacyDetectMeta.coordinateSpace;
  db.close();

  const archivedOriginal = join(data, orientationSixRow.original_path);
  const archivedScan = join(data, orientationSixRow.scan_path);
  const sourceScan = join(source, 'outputs/D-corrected.jpg');
  await checkFileOnlyDivergence('current 行下 Original-only divergence 在复制/DB 写前 fail-closed',
    archivedOriginal, 'user-current-original-d', orientationSixFixture);
  await checkFileOnlyDivergence('current 行下 Scan-only divergence 在复制/DB 写前 fail-closed',
    archivedScan, 'user-current-scan-d', sourceScan);

  const setLegacyState = () => {
    const legacyDb = new Database(join(data, 'openlens.db'));
    legacyDb.prepare('UPDATE pages SET quad=?, detect_meta=? WHERE id=?')
      .run(JSON.stringify(legacyQuad), JSON.stringify(legacyDetectMeta), orientationSixRow.id);
    legacyDb.close();
  };
  setLegacyState();
  await checkFileOnlyDivergence('legacy 行下 Original-only divergence 在复制/DB 写前 fail-closed',
    archivedOriginal, 'user-legacy-original-d', orientationSixFixture);
  setLegacyState();
  await checkFileOnlyDivergence('legacy 行下 Scan-only divergence 在复制/DB 写前 fail-closed',
    archivedScan, 'user-legacy-scan-d', sourceScan);
  setLegacyState();

  backfill();
  let auditDb = new Database(join(data, 'openlens.db'));
  const migrated = auditDb.prepare('SELECT quad, detect_meta FROM pages WHERE id=?').get(orientationSixRow.id);
  check('仍精确等于旧 backfill 产物的 archive 自动迁移到定向坐标',
    JSON.stringify(JSON.parse(migrated.quad)) === '[[36,36],[1764,36],[1764,1164],[36,1164]]'
      && JSON.parse(migrated.detect_meta).coordinateSpace === 'oriented-original-v1');

  auditDb.close();
  const beforeLinkAttackDb = databaseSnapshot();
  const sourceOriginalBytes = await readFile(orientationSixFixture);
  await rm(archivedOriginal);
  await symlink(orientationSixFixture, archivedOriginal);
  const symlinkResult = backfillResult();
  const symlinkIdentity = await lstat(archivedOriginal);
  check('same-hash symlink Original 被拒绝且不改外部源文件/DB', symlinkResult.status !== 0
    && symlinkResult.stderr.includes('symlink')
    && symlinkIdentity.isSymbolicLink()
    && databaseSnapshot() === beforeLinkAttackDb
    && (await readFile(orientationSixFixture)).equals(sourceOriginalBytes),
  `status=${symlinkResult.status} stderr=${symlinkResult.stderr.trim()}`);
  await rm(archivedOriginal);
  await copyFile(orientationSixFixture, archivedOriginal);

  await rm(archivedOriginal);
  await link(orientationSixFixture, archivedOriginal);
  const hardlinkResult = backfillResult();
  const sourceHardlinkIdentity = await lstat(orientationSixFixture);
  const archiveHardlinkIdentity = await lstat(archivedOriginal);
  check('same-hash hardlink Original 被拒绝且不改外部源文件/DB', hardlinkResult.status !== 0
    && hardlinkResult.stderr.includes('multiple hard links')
    && sourceHardlinkIdentity.ino === archiveHardlinkIdentity.ino
    && sourceHardlinkIdentity.nlink > 1 && archiveHardlinkIdentity.nlink > 1
    && databaseSnapshot() === beforeLinkAttackDb
    && (await readFile(orientationSixFixture)).equals(sourceOriginalBytes),
  `status=${hardlinkResult.status} stderr=${hardlinkResult.stderr.trim()}`);
  await rm(archivedOriginal);
  await copyFile(orientationSixFixture, archivedOriginal);

  const raceControl = join(data, '.backfill-race');
  const raceReady = `${raceControl}.ready`;
  const raceResume = `${raceControl}.resume`;
  const race = startPausedBackfill(raceControl);
  const paused = await waitForPause(race, raceReady);
  const racedQuad = [[70, 80], [1730, 80], [1730, 1120], [70, 1120]];
  let racedDbSnapshot = '';
  if (paused) {
    const concurrentDb = new Database(join(data, 'openlens.db'));
    const concurrentMeta = JSON.parse(migrated.detect_meta);
    concurrentMeta.edited = true;
    concurrentDb.prepare('UPDATE pages SET quad=?, detect_meta=? WHERE id=?')
      .run(JSON.stringify(racedQuad), JSON.stringify(concurrentMeta), orientationSixRow.id);
    concurrentDb.close();
    racedDbSnapshot = databaseSnapshot();
    await writeFile(raceResume, 'resume');
  }
  const racedArtifactSnapshot = await artifactSnapshot();
  const raceStatus = await waitForExit(race);
  check('只读预检后的并发重切由写事务内最终重验拒绝且不覆盖文件/DB', paused && raceStatus !== 0
    && race.errorOutput.includes('archived page has diverged')
    && databaseSnapshot() === racedDbSnapshot
    && await artifactSnapshot() === racedArtifactSnapshot
    && (await readFile(archivedOriginal)).equals(await readFile(orientationSixFixture))
    && (await readFile(archivedScan)).equals(await readFile(sourceScan)),
  `paused=${paused} status=${raceStatus} stderr=${race.errorOutput.trim()}`);

  auditDb = new Database(join(data, 'openlens.db'));
  auditDb.prepare('UPDATE pages SET quad=?, detect_meta=? WHERE id=?')
    .run(migrated.quad, migrated.detect_meta, orientationSixRow.id);
  auditDb.close();

  const beforeMetaRaceDb = databaseSnapshot();
  const beforeMetaRaceArtifacts = await artifactSnapshot();
  const metaRaceControl = join(data, '.backfill-meta-race');
  const metaRace = startPausedBackfill(metaRaceControl);
  const metaRacePaused = await waitForPause(metaRace, `${metaRaceControl}.ready`);
  if (metaRacePaused) {
    await writeFile(join(source, 'batch-meta.json'), `${metaText}\n`);
    await writeFile(`${metaRaceControl}.resume`, 'resume');
  }
  const metaRaceStatus = await waitForExit(metaRace);
  check('只读预检后 batch-meta 变化会在任何复制/DB 写前 fail-closed', metaRacePaused && metaRaceStatus !== 0
    && metaRace.errorOutput.includes('batch-meta.json changed during backfill')
    && databaseSnapshot() === beforeMetaRaceDb
    && await artifactSnapshot() === beforeMetaRaceArtifacts,
  `paused=${metaRacePaused} status=${metaRaceStatus} stderr=${metaRace.errorOutput.trim()}`);
  await writeFile(join(source, 'batch-meta.json'), metaText);

  const snapshotData = join(scratch, 'snapshot-race-data');
  await mkdir(snapshotData, { recursive: true });
  const snapshotControl = join(snapshotData, '.backfill-original-race');
  const snapshotRace = startPausedBackfill(snapshotControl, {
    targetData: snapshotData,
    documentId: 'snapshot-race-batch',
    pause: 'after-original-snapshot',
  });
  const snapshotPaused = await waitForPause(snapshotRace, `${snapshotControl}.ready`);
  if (snapshotPaused) {
    await copyFile(orientationSixFixture, join(source, 'raw/A.jpg'));
    await writeFile(`${snapshotControl}.resume`, 'resume');
  }
  const snapshotStatus = await waitForExit(snapshotRace);
  check('Original 的 orientation/hash 来自同一 bytes 快照且中途替换会 fail-closed', snapshotPaused && snapshotStatus !== 0
    && snapshotRace.errorOutput.includes('source Original changed during backfill'),
  `paused=${snapshotPaused} status=${snapshotStatus} stderr=${snapshotRace.errorOutput.trim()}`);
  await copyFile(orientationOneFixture, join(source, 'raw/A.jpg'));

  const freshData = join(scratch, 'fresh-artifact-race-data');
  await mkdir(freshData, { recursive: true });
  const freshControl = join(freshData, '.backfill-fresh-file-race');
  const freshRace = startPausedBackfill(freshControl, {
    targetData: freshData,
    documentId: 'fresh-file-race-batch',
  });
  const freshPaused = await waitForPause(freshRace, `${freshControl}.ready`);
  const freshOriginal = join(freshData, '2026/08/fresh-file-race-batch/original_0.jpg');
  if (freshPaused) {
    await writeFile(freshOriginal, 'concurrent-fresh-original');
    await writeFile(`${freshControl}.resume`, 'resume');
  }
  const freshStatus = await waitForExit(freshRace);
  const freshDb = new Database(join(freshData, 'openlens.db'), { readonly: true });
  const freshTables = freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all();
  freshDb.close();
  check('fresh archive 的文件漂移在 schema/data mutation 前被拒绝', freshPaused && freshStatus !== 0
    && freshRace.errorOutput.includes('artifact has diverged')
    && JSON.stringify(freshTables) === '[]'
    && await readFile(freshOriginal, 'utf8') === 'concurrent-fresh-original',
  `paused=${freshPaused} status=${freshStatus} tables=${JSON.stringify(freshTables)} stderr=${freshRace.errorOutput.trim()}`);

  const postInstallData = join(scratch, 'post-install-race-data');
  await mkdir(postInstallData, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(postInstallData, 'openlens.db'));
  const postInstallDbBefore = databaseSnapshot(postInstallData);
  const postInstallControl = join(postInstallData, '.backfill-post-install-race');
  const postInstallRace = startPausedBackfill(postInstallControl, {
    targetData: postInstallData,
    documentId: 'post-install-race-batch',
    pause: 'after-artifact-install',
  });
  const postInstallPaused = await waitForPause(postInstallRace, `${postInstallControl}.ready`);
  const postInstallOriginal = join(postInstallData, '2026/08/post-install-race-batch/original_0.jpg');
  if (postInstallPaused) {
    await writeFile(postInstallOriginal, 'user-replaced-after-install');
    await writeFile(`${postInstallControl}.resume`, 'resume');
  }
  const postInstallStatus = await waitForExit(postInstallRace);
  check('安装后的用户替换被拒绝且失败路径保留用户字节与其他已安装 artifact', postInstallPaused && postInstallStatus !== 0
    && postInstallRace.errorOutput.includes('artifact has diverged')
    && databaseSnapshot(postInstallData) === postInstallDbBefore
    && await readFile(postInstallOriginal, 'utf8') === 'user-replaced-after-install'
    && await readFile(join(postInstallData, '2026/08/post-install-race-batch/scan_0.jpg'), 'utf8') === 'corrected-a',
  `paused=${postInstallPaused} status=${postInstallStatus} stderr=${postInstallRace.errorOutput.trim()}`);

  const stageFailureData = join(scratch, 'stage-failure-data');
  await mkdir(stageFailureData, { recursive: true });
  const stageFailureControl = join(stageFailureData, '.backfill-stage-failure');
  const stageFailure = startPausedBackfill(stageFailureControl, {
    targetData: stageFailureData,
    documentId: 'stage-failure-batch',
    pause: 'before-artifact-staging',
  });
  const stageFailurePaused = await waitForPause(stageFailure, `${stageFailureControl}.ready`);
  if (stageFailurePaused) {
    await rm(join(source, 'outputs/A-corrected.jpg'));
    await writeFile(`${stageFailureControl}.resume`, 'resume');
  }
  const stageFailureStatus = await waitForExit(stageFailure);
  const stageFailureArchive = join(stageFailureData, '2026/08/stage-failure-batch');
  const stageFailureFiles = existsSync(stageFailureArchive) ? await readdir(stageFailureArchive) : [];
  check('第二项 source 失败时清理此前已生成 stage 且不创建 DB/final artifact', stageFailurePaused
    && stageFailureStatus !== 0
    && stageFailureFiles.length === 0
    && !existsSync(join(stageFailureData, 'openlens.db')),
  `paused=${stageFailurePaused} status=${stageFailureStatus} files=${stageFailureFiles.join(',')} stderr=${stageFailure.errorOutput.trim()}`);
  await writeFile(join(source, 'outputs/A-corrected.jpg'), 'corrected-a');

  const cleanupRaceData = join(scratch, 'cleanup-path-race-data');
  await mkdir(cleanupRaceData, { recursive: true });
  const cleanupRaceControl = join(cleanupRaceData, '.backfill-cleanup-path-race');
  const cleanupRace = startPausedBackfill(cleanupRaceControl, {
    targetData: cleanupRaceData,
    documentId: 'cleanup-path-race-batch',
  });
  const cleanupRacePaused = await waitForPause(cleanupRace, `${cleanupRaceControl}.ready`);
  const cleanupRaceArchive = join(cleanupRaceData, '2026/08/cleanup-path-race-batch');
  const cleanupRaceHeld = `${cleanupRaceArchive}-held`;
  const cleanupRaceOutside = join(scratch, 'cleanup-path-race-outside');
  let cleanupStageNames = [];
  if (cleanupRacePaused) {
    cleanupStageNames = await readdir(cleanupRaceArchive);
    await rename(cleanupRaceArchive, cleanupRaceHeld);
    await mkdir(cleanupRaceOutside, { recursive: true });
    for (const name of cleanupStageNames) await writeFile(join(cleanupRaceOutside, name), `outside-${name}`);
    await symlink(cleanupRaceOutside, cleanupRaceArchive);
    await writeFile(`${cleanupRaceControl}.resume`, 'resume');
  }
  const cleanupRaceStatus = await waitForExit(cleanupRace);
  const outsideStageBytes = cleanupStageNames.length
    ? await Promise.all(cleanupStageNames.map(async name => {
      const outsideFile = join(cleanupRaceOutside, name);
      return [name, existsSync(outsideFile) ? await readFile(outsideFile, 'utf8') : null];
    }))
    : [];
  const heldStageNames = cleanupRacePaused ? await readdir(cleanupRaceHeld) : [];
  check('archiveDir identity 漂移时 cleanup 不沿 symlink 删除外部同名文件', cleanupRacePaused
    && cleanupStageNames.length > 0
    && cleanupRaceStatus !== 0
    && cleanupRace.errorOutput.includes('symlink path component')
    && outsideStageBytes.every(([name, bytes]) => bytes === `outside-${name}`)
    && JSON.stringify(heldStageNames.sort()) === JSON.stringify(cleanupStageNames.sort())
    && !existsSync(join(cleanupRaceData, 'openlens.db')),
  `paused=${cleanupRacePaused} status=${cleanupRaceStatus} staged=${cleanupStageNames.length} outside=${outsideStageBytes.length} stderr=${cleanupRace.errorOutput.trim()}`);

  const stageSwapData = join(scratch, 'stage-inode-race-data');
  await mkdir(stageSwapData, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(stageSwapData, 'openlens.db'));
  const stageSwapDbBefore = databaseSnapshot(stageSwapData);
  const stageSwapControl = join(stageSwapData, '.backfill-stage-inode-race');
  const stageSwap = startPausedBackfill(stageSwapControl, {
    targetData: stageSwapData,
    documentId: 'stage-inode-race-batch',
  });
  const stageSwapPaused = await waitForPause(stageSwap, `${stageSwapControl}.ready`);
  const stageSwapArchive = join(stageSwapData, '2026/08/stage-inode-race-batch');
  let swappedStage = '';
  if (stageSwapPaused) {
    swappedStage = (await readdir(stageSwapArchive)).find(name => name.startsWith('.original_0.jpg.backfill-')) || '';
    await rm(join(stageSwapArchive, swappedStage));
    await writeFile(join(stageSwapArchive, swappedStage), 'replacement-stage-bytes');
    await writeFile(`${stageSwapControl}.resume`, 'resume');
  }
  const stageSwapStatus = await waitForExit(stageSwap);
  const swappedStageBytes = swappedStage && existsSync(join(stageSwapArchive, swappedStage))
    ? await readFile(join(stageSwapArchive, swappedStage), 'utf8') : null;
  check('安装前 stage inode 漂移时拒绝 link/unlink 且不创建 final/改 DB', stageSwapPaused
    && swappedStage
    && stageSwapStatus !== 0
    && swappedStageBytes === 'replacement-stage-bytes'
    && !existsSync(join(stageSwapArchive, 'original_0.jpg'))
    && databaseSnapshot(stageSwapData) === stageSwapDbBefore,
  `paused=${stageSwapPaused} status=${stageSwapStatus} stage=${swappedStage} stderr=${stageSwap.errorOutput.trim()}`);

  const installRaceData = join(scratch, 'install-path-race-data');
  await mkdir(installRaceData, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(installRaceData, 'openlens.db'));
  const installRaceDbBefore = databaseSnapshot(installRaceData);
  const installRaceControl = join(installRaceData, '.backfill-install-path-race');
  const installRace = startPausedBackfill(installRaceControl, {
    targetData: installRaceData,
    documentId: 'install-path-race-batch',
    pause: 'after-first-artifact-link',
  });
  const installRacePaused = await waitForPause(installRace, `${installRaceControl}.ready`);
  const installRaceArchive = join(installRaceData, '2026/08/install-path-race-batch');
  const installRaceHeld = `${installRaceArchive}-held`;
  const installRaceOutside = join(scratch, 'install-path-race-outside');
  let installStageName = '';
  const installDestinationName = 'original_0.jpg';
  if (installRacePaused) {
    installStageName = (await readdir(installRaceArchive)).find(name => name.startsWith('.original_0.jpg.backfill-')) || '';
    await rename(installRaceArchive, installRaceHeld);
    await mkdir(installRaceOutside, { recursive: true });
    await writeFile(join(installRaceOutside, installStageName), 'outside-install-stage');
    await writeFile(join(installRaceOutside, installDestinationName), 'outside-install-destination');
    await symlink(installRaceOutside, installRaceArchive);
    await writeFile(`${installRaceControl}.resume`, 'resume');
  }
  const installRaceStatus = await waitForExit(installRace);
  const installHeldNames = installRacePaused ? await readdir(installRaceHeld) : [];
  const outsideInstallStage = installStageName && existsSync(join(installRaceOutside, installStageName))
    ? await readFile(join(installRaceOutside, installStageName), 'utf8') : null;
  const outsideInstallDestination = existsSync(join(installRaceOutside, installDestinationName))
    ? await readFile(join(installRaceOutside, installDestinationName), 'utf8') : null;
  check('hardlink install 后的目录漂移不沿 symlink unlink stage 或覆盖 DB', installRacePaused
    && installStageName
    && installRaceStatus !== 0
    && databaseSnapshot(installRaceData) === installRaceDbBefore
    && outsideInstallStage === 'outside-install-stage'
    && outsideInstallDestination === 'outside-install-destination'
    && installHeldNames.includes(installStageName) && installHeldNames.includes(installDestinationName),
  `paused=${installRacePaused} status=${installRaceStatus} stage=${installStageName} stderr=${installRace.errorOutput.trim()}`);

  const rollbackTakeoverData = join(scratch, 'rollback-directory-takeover-data');
  await mkdir(rollbackTakeoverData, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(rollbackTakeoverData, 'openlens.db'));
  const rollbackTakeoverDbBefore = databaseSnapshot(rollbackTakeoverData);
  const rollbackTakeoverControl = join(rollbackTakeoverData, '.backfill-rollback-directory-takeover');
  const rollbackTakeover = startPausedBackfill(rollbackTakeoverControl, {
    targetData: rollbackTakeoverData,
    documentId: 'rollback-directory-takeover-batch',
    pause: 'after-first-artifact-link',
  });
  const rollbackTakeoverPaused = await waitForPause(rollbackTakeover, `${rollbackTakeoverControl}.ready`);
  const rollbackTakeoverArchive = join(rollbackTakeoverData, '2026/08/rollback-directory-takeover-batch');
  const rollbackTakeoverHeld = `${rollbackTakeoverArchive}-held`;
  const rollbackTakeoverReplacement = `${rollbackTakeoverArchive}-replacement`;
  let rollbackTakeoverStage = '';
  const rollbackTakeoverDestination = 'original_0.jpg';
  let installedIdentity;
  if (rollbackTakeoverPaused) {
    rollbackTakeoverStage = (await readdir(rollbackTakeoverArchive))
      .find(name => name.startsWith('.original_0.jpg.backfill-')) || '';
    installedIdentity = await lstat(join(rollbackTakeoverArchive, rollbackTakeoverDestination));
    await mkdir(rollbackTakeoverReplacement, { recursive: true });
    await link(join(rollbackTakeoverArchive, rollbackTakeoverDestination),
      join(rollbackTakeoverReplacement, rollbackTakeoverDestination));
    await writeFile(join(rollbackTakeoverReplacement, 'owner-sentinel'), 'replacement-directory-owner');
    await rename(rollbackTakeoverArchive, rollbackTakeoverHeld);
    await rename(rollbackTakeoverReplacement, rollbackTakeoverArchive);
    await rm(join(rollbackTakeoverHeld, rollbackTakeoverStage));
    await rm(join(rollbackTakeoverHeld, rollbackTakeoverDestination));
    await writeFile(`${rollbackTakeoverControl}.resume`, 'resume');
  }
  const rollbackTakeoverStatus = await waitForExit(rollbackTakeover);
  const takeoverDestinationPath = join(rollbackTakeoverArchive, rollbackTakeoverDestination);
  const takeoverDestinationIdentity = existsSync(takeoverDestinationPath)
    ? await lstat(takeoverDestinationPath) : null;
  const takeoverDestinationBytes = takeoverDestinationIdentity ? await readFile(takeoverDestinationPath) : null;
  check('rollback 前 archiveDir identity 漂移时不删除接管目录内的最后 hardlink', rollbackTakeoverPaused
    && rollbackTakeoverStage
    && rollbackTakeoverStatus !== 0
    && rollbackTakeover.errorOutput.includes('archive directory identity changed')
    && rollbackTakeover.errorOutput.includes('manual reconciliation required')
    && databaseSnapshot(rollbackTakeoverData) === rollbackTakeoverDbBefore
    && takeoverDestinationIdentity?.dev === installedIdentity.dev
    && takeoverDestinationIdentity?.ino === installedIdentity.ino
    && takeoverDestinationIdentity?.nlink === 1
    && takeoverDestinationBytes?.equals(await readFile(orientationOneFixture))
    && await readFile(join(rollbackTakeoverArchive, 'owner-sentinel'), 'utf8') === 'replacement-directory-owner',
  `paused=${rollbackTakeoverPaused} status=${rollbackTakeoverStatus} destination=${Boolean(takeoverDestinationIdentity)} stderr=${rollbackTakeover.errorOutput.trim()}`);

  const retainedFailureData = join(scratch, 'retained-failure-data');
  await mkdir(retainedFailureData, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(retainedFailureData, 'openlens.db'));
  const retainedFailureDbBefore = databaseSnapshot(retainedFailureData);
  const retainedFailureControl = join(retainedFailureData, '.backfill-retained-failure');
  const retainedFailure = startPausedBackfill(retainedFailureControl, {
    targetData: retainedFailureData,
    documentId: 'retained-failure-batch',
    pause: 'after-artifact-install',
  });
  const retainedFailurePaused = await waitForPause(retainedFailure, `${retainedFailureControl}.ready`);
  if (retainedFailurePaused) {
    await writeFile(join(source, 'batch-meta.json'), `${metaText}\n`);
    await writeFile(`${retainedFailureControl}.resume`, 'resume');
  }
  const retainedFailureStatus = await waitForExit(retainedFailure);
  await writeFile(join(source, 'batch-meta.json'), metaText);
  const retainedFailureArchive = join(retainedFailureData, '2026/08/retained-failure-batch');
  const retainedFailureFiles = existsSync(retainedFailureArchive)
    ? await readdir(retainedFailureArchive) : [];
  check('DB commit 前受控失败保留已安装 artifact 且 DB 不变', retainedFailurePaused
    && retainedFailureStatus !== 0
    && retainedFailure.errorOutput.includes('batch-meta.json changed during backfill')
    && databaseSnapshot(retainedFailureData) === retainedFailureDbBefore
    && retainedFailureFiles.filter(name => !name.startsWith('.')).length === 6
    && !retainedFailureFiles.some(name => name.includes('.backfill-')),
  `paused=${retainedFailurePaused} status=${retainedFailureStatus} files=${retainedFailureFiles} stderr=${retainedFailure.errorOutput.trim()}`);
  const retainedFailureRetry = backfillResult({
    targetData: retainedFailureData,
    documentId: 'retained-failure-batch',
  });
  check('保留的已安装 artifact 可由幂等重跑直接收敛', retainedFailureRetry.status === 0
    && retainedFailureRetry.stdout.includes('"copiedFiles": 0'),
  `status=${retainedFailureRetry.status} stderr=${retainedFailureRetry.stderr.trim()}`);

  const collisionData = join(scratch, 'page-id-collision-data');
  await mkdir(collisionData, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(collisionData, 'openlens.db'));
  const collisionDb = new Database(join(collisionData, 'openlens.db'));
  collisionDb.prepare('INSERT INTO docs (id, name, created_at, tags) VALUES (?, ?, ?, ?)')
    .run('foreign-doc', 'Foreign document', 1, '[]');
  collisionDb.prepare(`
    INSERT INTO pages (id, doc_id, idx, quad, enhancement, rotation, original_path, scan_path, edited, detect_meta)
    SELECT ?, ?, idx, quad, enhancement, rotation, original_path, scan_path, edited, detect_meta
    FROM pages ORDER BY id LIMIT 1
  `).run('collision-batch_A', 'foreign-doc');
  collisionDb.close();
  const collisionDbBefore = databaseSnapshot(collisionData);
  const collision = backfillResult({ targetData: collisionData, documentId: 'collision-batch' });
  check('候选 page id 已属于另一 document 时在复制/DB 写前 fail-closed', collision.status !== 0
    && collision.stderr.includes('belongs to another document')
    && databaseSnapshot(collisionData) === collisionDbBefore
    && !existsSync(join(collisionData, '2026/08/collision-batch')),
  `status=${collision.status} stderr=${collision.stderr.trim()}`);

  const symlinkData = join(scratch, 'symlink-archive-data');
  const outsideArchive = join(scratch, 'outside-archive');
  await mkdir(join(symlinkData, '2026/08'), { recursive: true });
  await mkdir(outsideArchive, { recursive: true });
  await copyFile(join(data, 'openlens.db'), join(symlinkData, 'openlens.db'));
  await symlink(outsideArchive, join(symlinkData, '2026/08/symlink-archive-batch'));
  const symlinkArchiveDbBefore = databaseSnapshot(symlinkData);
  const symlinkArchive = backfillResult({ targetData: symlinkData, documentId: 'symlink-archive-batch' });
  check('symlinked archiveDir 在 staging/DB mutation 前拒绝且不写出 data root', symlinkArchive.status !== 0
    && symlinkArchive.stderr.includes('symlink path component')
    && databaseSnapshot(symlinkData) === symlinkArchiveDbBefore
    && !existsSync(join(outsideArchive, 'original_0.jpg'))
    && !existsSync(join(outsideArchive, 'scan_0.jpg')),
  `status=${symlinkArchive.status} stderr=${symlinkArchive.stderr.trim()}`);

  const legacySchemaData = join(scratch, 'legacy-schema-data');
  await createLegacySchema(legacySchemaData);
  const legacySchema = backfillResult({ targetData: legacySchemaData, documentId: 'legacy-schema-batch' });
  const migratedLegacyDb = new Database(join(legacySchemaData, 'openlens.db'), { readonly: true });
  const migratedLegacyColumns = migratedLegacyDb.prepare('PRAGMA table_info(pages)').all().map(column => column.name);
  const migratedLegacyCounts = {
    docs: migratedLegacyDb.prepare('SELECT COUNT(*) count FROM docs').get().count,
    pages: migratedLegacyDb.prepare('SELECT COUNT(*) count FROM pages').get().count,
  };
  migratedLegacyDb.close();
  check('合法旧 schema 在最终事务内迁移后完成 backfill', legacySchema.status === 0
    && migratedLegacyColumns.includes('edited') && migratedLegacyColumns.includes('detect_meta')
    && migratedLegacyCounts.docs === 1 && migratedLegacyCounts.pages === 3
    && existsSync(join(legacySchemaData, '2026/08/legacy-schema-batch/original_0.jpg')),
  `status=${legacySchema.status} columns=${migratedLegacyColumns.join(',')} stderr=${legacySchema.stderr.trim()}`);

  const legacyOwnerData = join(scratch, 'legacy-schema-owner-data');
  await createLegacySchema(legacyOwnerData, 'legacy-owner-batch_A');
  const legacyOwnerDbBefore = databaseSnapshot(legacyOwnerData);
  const legacyOwner = backfillResult({ targetData: legacyOwnerData, documentId: 'legacy-owner-batch' });
  check('旧 schema 的候选 page ownership gate 在 staging/migration 前拒绝', legacyOwner.status !== 0
    && legacyOwner.stderr.includes('belongs to another document')
    && databaseSnapshot(legacyOwnerData) === legacyOwnerDbBefore
    && !existsSync(join(legacyOwnerData, '2026/08/legacy-owner-batch')),
  `status=${legacyOwner.status} stderr=${legacyOwner.stderr.trim()}`);

  const duplicateData = join(scratch, 'duplicate-candidate-data');
  const duplicateRecords = {
    ...records,
    'A.png': { ...records['A.jpg'], labeledAt: '2026-08-17T17:15:53.196Z' },
  };
  await writeFile(join(source, 'batch-meta.json'), `${JSON.stringify(duplicateRecords, null, 2)}\n`);
  await copyFile(orientationOneFixture, join(source, 'raw/A.png'));
  const duplicate = backfillResult({ targetData: duplicateData, documentId: 'duplicate-basename-batch' });
  check('不同扩展的重复 basename 在 staging/DB mutation 前拒绝且不留 artifact', duplicate.status !== 0
    && duplicate.stderr.includes('duplicate candidate page id')
    && !existsSync(join(duplicateData, 'openlens.db'))
    && !existsSync(join(duplicateData, '2026/08/duplicate-basename-batch')),
  `status=${duplicate.status} stderr=${duplicate.stderr.trim()}`);
  await writeFile(join(source, 'batch-meta.json'), metaText);
  await rm(join(source, 'raw/A.png'));

  const userQuad = [[60, 70], [1740, 70], [1740, 1130], [60, 1130]];
  const userDetectMeta = JSON.parse(migrated.detect_meta);
  delete userDetectMeta.coordinateSpace;
  userDetectMeta.edited = true;
  auditDb = new Database(join(data, 'openlens.db'));
  auditDb.prepare('UPDATE pages SET quad=?, detect_meta=? WHERE id=?')
    .run(JSON.stringify(userQuad), JSON.stringify(userDetectMeta), orientationSixRow.id);
  auditDb.close();
  await writeFile(join(data, orientationSixRow.scan_path), 'user-edited-scan-d');

  const refused = backfillResult();
  auditDb = new Database(join(data, 'openlens.db'), { readonly: true });
  const preserved = auditDb.prepare('SELECT quad, detect_meta FROM pages WHERE id=?').get(orientationSixRow.id);
  auditDb.close();
  check('已被后续用户编辑的 archive fail-closed 且不被 backfill 覆盖', refused.status !== 0
    && refused.stderr.includes('refusing to overwrite')
    && JSON.stringify(JSON.parse(preserved.quad)) === JSON.stringify(userQuad)
    && JSON.parse(preserved.detect_meta).coordinateSpace === undefined
    && await readFile(join(data, orientationSixRow.scan_path), 'utf8') === 'user-edited-scan-d',
  `status=${refused.status} stderr=${refused.stderr.trim()}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `E2E DONE (${failures}/${checks} FAILED)` : `E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
