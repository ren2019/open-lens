#!/usr/bin/env node
// Desktop batch labeling and perspective-correction tool.
// Usage: node desktop/server.js [--data <directory>] [--port <port>]
// Data: raw originals, label PNG+GT, outputs, batch-meta.json and manifest.json.
// 与 spike/label-server.js 的关系: 交互代码复制自它; 本工具面向批量流程, 不动精选 eval 集。
const http = require('http');
const { spawnSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;

function fail(message) {
  console.error(`[desktop] ${message}`);
  process.exit(1);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) fail(`${name} requires a value`);
  return process.argv[index + 1];
}

const BATCH = path.resolve(option('--data', process.env.OPEN_LENS_DESKTOP_DATA || path.join(ROOT, 'data')));
const PORT = Number(option('--port', process.env.PORT || '8791'));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`invalid --port: ${PORT}`);
const RAW = path.join(BATCH, 'raw');
const LABEL = path.join(BATCH, 'label');
const OUT = path.join(BATCH, 'outputs');
const META = path.join(BATCH, 'batch-meta.json');
const MANIFEST = path.join(BATCH, 'manifest.json');
const GT_FILE = path.join(LABEL, 'ground-truth.json');
const SAVE_TRANSACTION = path.join(BATCH, '.desktop-save-transaction.json');
const BATCH_OWNER_LOCK = path.join(BATCH, '.desktop-owner.lock');
const requestedTestFailpoint = process.env.OPEN_LENS_DESKTOP_TEST_FAILPOINT || '';

for (const d of [RAW, LABEL, OUT]) fs.mkdirSync(d, { recursive: true });

const TEST_FAILPOINTS = new Set([
  'before-gt-rename',
  'before-output-rename',
  'crash-after-commit',
  'crash-after-meta-rename',
  'crash-after-meta-stage',
  'crash-before-output-rename',
  'pause-before-gt-rename',
]);

function isStrictChild(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function armTestFailpoint() {
  if (!requestedTestFailpoint) return '';
  if (process.env.OPEN_LENS_DESKTOP_TEST_MODE !== '1') {
    console.warn('[test-failpoint:ignored] OPEN_LENS_DESKTOP_TEST_MODE is not enabled');
    return '';
  }
  if (!TEST_FAILPOINTS.has(requestedTestFailpoint)) fail(`unknown test failpoint: ${requestedTestFailpoint}`);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const batchRoot = fs.realpathSync(BATCH);
  if (!isStrictChild(temporaryRoot, batchRoot) || !path.basename(batchRoot).startsWith('open-lens-desktop-')) {
    fail('test failpoints require an isolated open-lens-desktop-* directory under the system temp directory');
  }
  return requestedTestFailpoint;
}

const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_IDENTITY_MAX_LENGTH = 200;
let batchOwner;
let ownsBatch = false;

function readBatchOwner(file, label) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const error = new Error(`${label}读取失败: ${e.message}`);
    error.code = e.code;
    throw error;
  }
  const keys = owner && typeof owner === 'object' && !Array.isArray(owner) ? Object.keys(owner) : [];
  if (keys.length !== 4 || !['version', 'pid', 'identity', 'token'].every(key => keys.includes(key))
      || owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid < 1
      || typeof owner.identity !== 'string' || !owner.identity || owner.identity.length > OWNER_IDENTITY_MAX_LENGTH
      || typeof owner.token !== 'string' || !OWNER_TOKEN_PATTERN.test(owner.token)) {
    throw new Error(`${label}格式无效`);
  }
  return owner;
}

function sameOwner(left, right) {
  return left.pid === right.pid && left.identity === right.identity && left.token === right.token;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

function processStartIdentity(pid) {
  if (!processIsAlive(pid)) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (!/^\d+$/.test(fields[19] || '')) throw new Error('start tick 缺失');
      return `linux:${fields[19]}`;
    } catch (e) {
      if (!processIsAlive(pid)) return null;
      throw new Error(`无法读取进程 ${pid} 的启动身份: ${e.message}`);
    }
  }

  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/ps';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`]
    : ['-o', 'lstart=', '-p', String(pid)];
  const environment = process.platform === 'win32'
    ? process.env
    : { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  const result = spawnSync(command, args, {
    encoding: 'utf8', env: environment, windowsHide: true, timeout: 2000,
  });
  const output = result.stdout?.trim();
  if (result.status === 0 && output) return `${process.platform}:${output}`;
  if (!processIsAlive(pid)) return null;
  throw new Error(`无法读取进程 ${pid} 的启动身份: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
}

function ownerIsCurrent(owner) {
  return processStartIdentity(owner.pid) === owner.identity;
}

function writeOwner(file, owner) {
  fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
}

function removeOwnedLock(file, owner) {
  try {
    if (sameOwner(readBatchOwner(file, '批次所有权锁'), owner)) fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[desktop:owner-release]', e.message);
  }
}

function claimStaleBatchOwner(staleOwner) {
  const claim = path.join(BATCH, `.desktop-owner.lock.reclaim-${staleOwner.token}`);
  let claimed = false;
  for (let attempt = 0; attempt < 20 && !claimed; attempt++) {
    try {
      writeOwner(claim, batchOwner);
      claimed = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let currentClaim;
      try {
        currentClaim = readBatchOwner(claim, '批次所有权接管锁');
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        fail(readError.message);
      }
      const claimIsFresh = ownerIsCurrent(currentClaim);
      if (!claimIsFresh) removeOwnedLock(claim, currentClaim);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (!claimed) fail(`批次所有权接管超时: ${BATCH}`);

  try {
    let currentOwner;
    try { currentOwner = readBatchOwner(BATCH_OWNER_LOCK, '批次所有权锁'); }
    catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (sameOwner(currentOwner, staleOwner) && !ownerIsCurrent(currentOwner)) {
      fs.unlinkSync(BATCH_OWNER_LOCK);
    }
  } finally {
    removeOwnedLock(claim, batchOwner);
  }
}

function acquireBatchOwnership() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeOwner(BATCH_OWNER_LOCK, batchOwner);
      ownsBatch = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') fail(`无法获取批次所有权: ${e.message}`);
    }

    let currentOwner;
    try { currentOwner = readBatchOwner(BATCH_OWNER_LOCK, '批次所有权锁'); }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      fail(`${e.message}; 请确认没有 desktop 进程使用该批次后移除 ${BATCH_OWNER_LOCK}`);
    }
    let currentOwnerIsActive;
    try { currentOwnerIsActive = ownerIsCurrent(currentOwner); }
    catch (e) { fail(`无法验证批次所有权: ${e.message}`); }
    if (currentOwnerIsActive) {
      fail(`批次已被 desktop 进程占用 (pid ${currentOwner.pid}): ${BATCH}`);
    }
    const staleReason = processIsAlive(currentOwner.pid) ? 'PID 已复用' : '进程已退出';
    console.warn(`[desktop] 接管 stale owner (pid ${currentOwner.pid}, ${staleReason}): ${BATCH}`);
    try { claimStaleBatchOwner(currentOwner); }
    catch (e) { fail(`无法接管批次所有权: ${e.message}`); }
  }
  fail(`无法获取批次所有权: ${BATCH}`);
}

function releaseBatchOwnership() {
  if (!ownsBatch) return;
  ownsBatch = false;
  removeOwnedLock(BATCH_OWNER_LOCK, batchOwner);
}

process.once('exit', releaseBatchOwnership);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
let currentIdentity;
try { currentIdentity = processStartIdentity(process.pid); }
catch (e) { fail(e.message); }
if (!currentIdentity) fail('无法读取当前 desktop 进程的启动身份');
batchOwner = { version: 1, pid: process.pid, identity: currentIdentity, token: randomUUID() };
acquireBatchOwnership();

let testFailpoint = armTestFailpoint();

const OPENCV_PACKAGE = '@techstark/opencv-js@4.12.0-release.1';
const OPENCV_SHA256 = 'bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103';

// Desktop uses the lockfile-pinned OpenCV build; detector-oss remains the checked app asset.
function pickAsset(name) {
  if (name === 'opencv.js') {
    let opencv;
    try { opencv = require.resolve('@techstark/opencv-js/dist/opencv.js', { paths: [path.join(ROOT, '..')] }); }
    catch { fail(`missing ${OPENCV_PACKAGE}; run npm ci at the repository root`); }
    const hash = createHash('sha256').update(fs.readFileSync(opencv)).digest('hex');
    if (hash !== OPENCV_SHA256) fail(`${OPENCV_PACKAGE} opencv.js hash mismatch: ${hash}`);
    console.log('[asset]', name, `← ${OPENCV_PACKAGE}`, OPENCV_SHA256);
    return opencv;
  }
  const appPub = path.join(ROOT, '..', 'app', 'public', name);
  if (fs.existsSync(appPub)) { console.log('[asset]', name, '← app/public'); return appPub; }
  fail(`missing product asset app/public/${name}; run the app asset setup before starting desktop`);
}
const ASSETS = { 'opencv.js': pickAsset('opencv.js'), 'detector-oss.js': pickAsset('detector-oss.js') };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const META_TEMP_PATTERN = new RegExp(`^\\.batch-meta\\.json\\.[1-9]\\d*-${UUID_SOURCE}\\.tmp$`);
const GT_TEMP_PATTERN = new RegExp(`^\\.ground-truth\\.json\\.[1-9]\\d*-${UUID_SOURCE}\\.tmp$`);
const TRANSACTION_TEMP_PATTERN = new RegExp(`^\\.desktop-save-transaction\\.json\\.[1-9]\\d*-${UUID_SOURCE}\\.tmp$`);
const OUTPUT_NAME_SOURCE = '[^/\\x00]*-corrected\\.jpg';
const OUTPUT_TARGET_PATTERN = new RegExp(`^${OUTPUT_NAME_SOURCE}$`);
const OUTPUT_TEMP_PATTERN = new RegExp(`^\\.${OUTPUT_NAME_SOURCE}\\.[1-9]\\d*-${UUID_SOURCE}\\.tmp$`);
const OUTPUT_BACKUP_PATTERN = new RegExp(`^\\.${OUTPUT_NAME_SOURCE}\\.${UUID_SOURCE}\\.save-backup$`);

function readJsonState(f) {
  let contents;
  try { contents = fs.readFileSync(f, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { value: {}, contents: null };
    throw new Error(`${path.basename(f)} 读取失败: ${e.message}`);
  }
  try { return { value: JSON.parse(contents), contents }; }
  catch (e) { throw new Error(`${path.basename(f)} JSON 解析失败: ${e.message}`); }
}

const readJson = f => readJsonState(f).value;

function removeFile(f) {
  try { fs.unlinkSync(f); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function cleanupFile(f) {
  try { removeFile(f); }
  catch (e) { console.error('[save:cleanup]', e); }
}

function stageFile(f, contents) {
  const temporary = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    return temporary;
  } catch (e) {
    cleanupFile(temporary);
    throw new Error(`${path.basename(f)} 写入失败: ${e.message}`);
  }
}

function replaceFile(f, contents, failpoint) {
  const temporary = stageFile(f, contents);
  try {
    if (failpoint && testFailpoint === `crash-${failpoint}`) process.exit(86);
    if (testFailpoint === failpoint) {
      testFailpoint = '';
      throw new Error(`injected test failure: ${failpoint}`);
    }
    fs.renameSync(temporary, f);
  } catch (e) {
    cleanupFile(temporary);
    throw new Error(`${path.basename(f)} 替换失败: ${e.message}`);
  }
}

const writeJson = (f, o) => replaceFile(f, JSON.stringify(o, null, 2));

function restoreFile(f, contents) {
  if (contents === null) removeFile(f);
  else replaceFile(f, contents);
}

function journalError(message) {
  throw new Error(`保存事务日志无效: ${message}`);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}

function ownedPath(directory, name, field) {
  if (typeof name !== 'string' || path.basename(name) !== name) journalError(`${field} 命名无效`);
  const root = fs.realpathSync(directory);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) journalError(`${field} 越过批次目录边界`);
  return resolved;
}

function ownedJournalPath(directory, name, pattern, field) {
  if (typeof name !== 'string' || !pattern.test(name)) journalError(`${field} 命名无效`);
  return ownedPath(directory, name, field);
}

function validatePreviousJson(contents, field) {
  if (contents === null) return;
  let value;
  try { value = JSON.parse(contents); }
  catch (e) { journalError(`${field} JSON 解析失败: ${e.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) journalError(`${field} 必须是 JSON object`);
}

function validateSaveTransaction(transaction) {
  if (!hasExactKeys(transaction, ['version', 'id', 'previous', 'temporary', 'output'])) journalError('schema 不完整');
  if (transaction.version !== 1) journalError('版本无效');
  if (typeof transaction.id !== 'string' || !UUID_PATTERN.test(transaction.id)) journalError('id 无效');
  if (!hasExactKeys(transaction.previous, ['meta', 'gt'])
      || ![transaction.previous.meta, transaction.previous.gt].every(value => value === null || typeof value === 'string')) {
    journalError('previous 无效');
  }
  validatePreviousJson(transaction.previous.meta, 'previous.meta');
  validatePreviousJson(transaction.previous.gt, 'previous.gt');
  if (!hasExactKeys(transaction.temporary, ['meta', 'gt'])) journalError('temporary 无效');

  const temporary = {
    meta: ownedJournalPath(BATCH, transaction.temporary.meta, META_TEMP_PATTERN, 'temporary.meta'),
    gt: ownedJournalPath(LABEL, transaction.temporary.gt, GT_TEMP_PATTERN, 'temporary.gt'),
  };
  let output = null;
  if (transaction.output !== null) {
    if (!hasExactKeys(transaction.output, ['target', 'backup'])) journalError('output 无效');
    const target = ownedJournalPath(OUT, transaction.output.target, OUTPUT_TARGET_PATTERN, 'output.target');
    const backup = ownedJournalPath(OUT, transaction.output.backup, OUTPUT_BACKUP_PATTERN, 'output.backup');
    const expectedPrefix = `.${transaction.output.target}.`;
    const backupId = transaction.output.backup.slice(expectedPrefix.length, -'.save-backup'.length);
    if (!transaction.output.backup.startsWith(expectedPrefix) || !UUID_PATTERN.test(backupId)) journalError('output.backup 与 target 不匹配');
    output = { target, backup };
  }
  return { transaction, temporary, output };
}

function recoverSaveTransaction() {
  if (!fs.existsSync(SAVE_TRANSACTION)) return false;
  const validated = validateSaveTransaction(readJson(SAVE_TRANSACTION));
  const { transaction } = validated;
  restoreFile(META, transaction.previous.meta);
  restoreFile(GT_FILE, transaction.previous.gt);
  if (validated.output && fs.existsSync(validated.output.backup)) {
    fs.renameSync(validated.output.backup, validated.output.target);
  }
  removeFile(validated.temporary.meta);
  removeFile(validated.temporary.gt);
  removeFile(SAVE_TRANSACTION);
  console.log('[save:recovered]', transaction.id);
  return true;
}

function cleanupOrphanSaveArtifacts() {
  const ownedArtifacts = [
    [BATCH, [META_TEMP_PATTERN, TRANSACTION_TEMP_PATTERN]],
    [LABEL, [GT_TEMP_PATTERN]],
    [OUT, [OUTPUT_TEMP_PATTERN, OUTPUT_BACKUP_PATTERN]],
  ];
  for (const [directory, patterns] of ownedArtifacts) {
    for (const name of fs.readdirSync(directory)) {
      if (!patterns.some(pattern => pattern.test(name))) continue;
      const artifact = ownedPath(directory, name, `orphan ${name}`);
      try {
        removeFile(artifact);
        console.log('[save:orphan-cleanup]', artifact);
      } catch (e) {
        console.error('[save:orphan-cleanup-error]', e);
      }
    }
  }
}

function recoverAndCleanupSaveArtifacts() {
  const recovered = recoverSaveTransaction();
  cleanupOrphanSaveArtifacts();
  return recovered;
}

function commitLabelSave(metaState, gtState, meta, gt, staleOutput) {
  const metaTemporary = stageFile(META, JSON.stringify(meta, null, 2));
  if (testFailpoint === 'crash-after-meta-stage') process.exit(86);
  let gtTemporary;
  try { gtTemporary = stageFile(GT_FILE, JSON.stringify(gt, null, 2)); }
  catch (e) { cleanupFile(metaTemporary); throw e; }

  const outputBackup = staleOutput && fs.existsSync(staleOutput)
    ? path.join(OUT, `.${path.basename(staleOutput)}.${randomUUID()}.save-backup`)
    : null;
  const transaction = {
    version: 1,
    id: randomUUID(),
    previous: { meta: metaState.contents, gt: gtState.contents },
    temporary: { meta: path.basename(metaTemporary), gt: path.basename(gtTemporary) },
    output: outputBackup ? { target: path.basename(staleOutput), backup: path.basename(outputBackup) } : null,
  };

  try {
    writeJson(SAVE_TRANSACTION, transaction);
    if (outputBackup) fs.renameSync(staleOutput, outputBackup);
    fs.renameSync(metaTemporary, META);
    if (testFailpoint === 'pause-before-gt-rename') {
      testFailpoint = '';
      console.log('[test-failpoint:pause] before-gt-rename');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
    if (testFailpoint === 'crash-after-meta-rename') process.exit(86);
    if (testFailpoint === 'before-gt-rename') {
      testFailpoint = '';
      throw new Error('injected test failure: before-gt-rename');
    }
    fs.renameSync(gtTemporary, GT_FILE);
    fs.unlinkSync(SAVE_TRANSACTION);
    if (testFailpoint === 'crash-after-commit') process.exit(86);
  } catch (e) {
    try {
      if (!recoverSaveTransaction()) {
        removeFile(metaTemporary);
        removeFile(gtTemporary);
      }
    }
    catch (recoveryError) {
      console.error('[save:recovery-error]', recoveryError);
      throw new Error(`${e.message}; 自动恢复失败: ${recoveryError.message}`);
    }
    throw e;
  }

  if (outputBackup) {
    cleanupFile(outputBackup);
    if (!fs.existsSync(outputBackup)) console.log('[rm]', staleOutput);
  }
}
function snapshotGt(reason) {
  if (!fs.existsSync(GT_FILE)) return null;
  const directory = path.join(LABEL, '.gt-snapshots');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(directory, `ground-truth.pre-${reason}-${stamp}.json`);
  fs.copyFileSync(GT_FILE, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

function labelSemantics(record) {
  if (record?.noTarget) return 'noTarget';
  return record?.quad ? JSON.stringify(record.quad) : null;
}

function saveHandler({ id, rec, gtId, gtRec }) {
  recoverSaveTransaction();
  const savesLabel = Object.hasOwn(rec, 'quad') || Object.hasOwn(rec, 'noTarget');
  const metaState = readJsonState(META);
  const gtState = savesLabel ? readJsonState(GT_FILE) : null;
  const meta = metaState.value;
  const gt = gtState?.value;
  const previous = meta[id];
  const next = Object.assign({}, previous, rec);
  if (rec.noTarget) { delete next.quad; delete next.expectFallback; }
  else if (rec.quad) { delete next.noTarget; if (!rec.expectFallback) delete next.expectFallback; }
  const labelChanged = savesLabel && labelSemantics(previous) !== labelSemantics(next);
  if (savesLabel && (labelChanged || !next.labeledAt)) next.labeledAt = new Date().toISOString();
  meta[id] = next;
  if (savesLabel) {
    if (Boolean(gt[gtId]?.expectFallback) !== Boolean(gtRec.expectFallback)) snapshotGt('expect-fallback');
    gtRec.labeledAt = next.labeledAt;
    gt[gtId] = gtRec;
  }
  if (!savesLabel) {
    writeJson(META, meta);
    console.log('[save]', id, 'render-accounting');
    return { labeledAt: next.labeledAt };
  }
  const stale = rec.noTarget ? path.join(OUT, id.replace(/\.[^.]+$/, '') + '-corrected.jpg') : null;
  commitLabelSave(metaState, gtState, meta, gt, stale);
  console.log('[save]', id, rec.mode, rec.noTarget ? 'noTarget' : rec.quad ? 'quad' : '?', rec.edited ? 'edited' : 'as-proposed');
  return { labeledAt: next.labeledAt };
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const q = new URL(req.url, 'http://x').searchParams;
  const sendFile = (f, extra) => {
    if (f && fs.existsSync(f)) {
      res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }, extra));
      fs.createReadStream(f).pipe(res);
      return true;
    }
    return false;
  };

  if (u === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(PAGE); return; }
  if (u === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, data: BATCH, files: fs.readdirSync(LABEL).filter(f => /\.png$/i.test(f)).length }));
    return;
  }

  if (u === '/api/list') {
    // 文件列表 = label PNG ∩ 有 GT 与否都行; raw 里可能还有未转的 heic, 以 label PNG 为准
    try {
      recoverSaveTransaction();
      const files = fs.readdirSync(LABEL).filter(f => /\.png$/i.test(f)).sort();
      const outputs = fs.readdirSync(OUT).filter(f => /-corrected\.jpg$/i.test(f)).sort();
      const body = JSON.stringify({ ok: true, files, outputs, meta: readJson(META), gt: readJson(GT_FILE), manifest: readJson(MANIFEST) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      console.error('[list:error]', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `批次读取失败: ${e.message}` }));
    }
    return;
  }

  if (u.startsWith('/label/')) { if (sendFile(path.join(LABEL, path.basename(u)))) return; }
  if (u.startsWith('/raw/')) { if (sendFile(path.join(RAW, path.basename(u)))) return; }
  if (u.startsWith('/outputs/')) { if (sendFile(path.join(OUT, path.basename(u)))) return; }
  if (u === '/opencv.js' || u === '/detector-oss.js') { if (sendFile(ASSETS[u.slice(1)])) return; }

  if (u === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `保存请求格式错误: ${e.message}` }));
        return;
      }
      try {
        const saved = saveHandler(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...saved }));
      } catch (e) {
        console.error('[save:error]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `保存失败: ${e.message}` }));
      }
    });
    return;
  }

  if (u === '/api/output' && req.method === 'POST') {
    const name = path.basename(q.get('name') || '');
    if (!name) { res.writeHead(400); res.end('{"ok":false}'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const f = path.join(OUT, name.replace(/\.[^.]+$/, '') + '-corrected.jpg');
      const contents = Buffer.concat(chunks);
      try {
        replaceFile(f, contents, 'before-output-rename');
        console.log('[out]', f, contents.length, 'bytes');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        console.error('[out:error]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `成品写入失败: ${e.message}` }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('nf');
});

try { recoverAndCleanupSaveArtifacts(); }
catch (e) { console.error('[save:startup-recovery-error]', e); }

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Open-Lens 批量标注</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;padding:16px}
#bar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
button{background:#2c2c2e;color:#fff;border:1px solid #48484a;border-radius:8px;padding:8px 16px;font-size:14px}
button.active{background:#0a84ff}button.warning{background:#7a6400;border-color:#ffd60a}button:disabled{opacity:.4}
#wrap{position:relative;display:inline-block;max-width:100%}
#img{max-width:100%;display:block;border-radius:6px}
#ov{position:absolute;left:0;top:0}
#tip{font:12px/1.6 -apple-system,sans-serif;color:#98989d;margin-top:8px}
select{background:#2c2c2e;color:#fff;border:1px solid #48484a;border-radius:8px;padding:8px}
#wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;padding-bottom:100px}
.wallCard{position:relative;min-width:0;padding:0;overflow:hidden;text-align:left;background:#2c2c2e;border:2px solid transparent;border-radius:8px}
.wallCard img,.wallPlaceholder{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:#111}
.wallPlaceholder{display:grid;place-items:center;color:#6f6f75;font-size:12px;letter-spacing:.08em}
.wallMeta{display:flex;justify-content:space-between;gap:8px;padding:8px 9px;font-size:12px}.wallName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wallState{flex:none;color:#98989d}.wallCard.rendered .wallState{color:#30d158}.wallCard.noTarget .wallState{color:#ff6961}.wallCard.warning{border-color:#ffd60a}.wallCard.warning .wallState{color:#ffd60a}
#dots{position:fixed;left:12px;right:12px;bottom:12px;display:flex;flex-wrap:wrap;gap:4px;max-height:80px;overflow:auto;z-index:9}
.dot{width:14px;height:14px;border-radius:3px;background:#48484a;cursor:pointer}
.dot.edited{background:#ff9f0a}.dot.saved{background:#30d158}.dot.noTarget{background:#ff453a}.dot.fallback{background:#bf5af2}.dot.ar-warn{background:#ffd60a}.dot.cur{outline:2px solid #fff}
#st{position:fixed;top:10px;right:14px;font-size:12px;color:#98989d;z-index:9;text-align:right}
</style></head><body>
<div id="bar">
  <b id="pos">-</b>
  <button id="prev">◀</button><button id="next">▶</button>
  <button id="undo" disabled>撤销</button><button id="redo" disabled>重做</button>
  <select id="mode"><option value="screen">拍屏/课件</option><option value="document">文件/发票</option><option value="whiteboard">白板</option><option value="businesscard">名片(占位)</option><option value="auto">其他/自动</option></select>
  <button id="noTarget">无有效目标</button>
  <button id="expectFallback">期望降级</button>
  <button id="save" class="active" style="padding:8px 28px">保存标注</button>
  <button id="renderAll" style="padding:8px 20px">渲染全部已标</button>
  <button id="showWall" style="padding:8px 20px">成品墙</button>
</div>
<main id="editor"><div id="wrap"><img id="img"><canvas id="ov"></canvas></div>
<div id="tip">检测提案 = <span style="color:#64d2ff">蓝色幽灵框</span>, 绿色把手拖到正确四角 → 选模式 → 保存(自动渲染成品)。「渲染全部」补渲染跨会话漏掉的。<br>「无有效目标」= 图里没有目标；「期望降级」= 有目标和 GT，但被裁过半/边框物理不可见，检测器应失败并交给手动框。两者不可同时选。businesscard 档当前仅占位，待真实名片 GT 补齐后评测。</div></main>
<main id="wall" hidden></main>
<div id="dots"></div><div id="st"></div>
<script>
const $ = id => document.getElementById(id);
let list = [], idx = 0, quad = null, proposal = null, img = $('img'), ov = $('ov'), ctx = ov.getContext('2d');
let meta = {}, gt = {}, manifest = {}, detections = new Map(); // id → {quad, ms} 提案缓存(未持久化, 保存时写入)
let cvReady = false, cvApi = null, cvLoadError = null, saveTimer = null, outputs = new Set(), returnToWall = false;
let undoStack = [], redoStack = [], dragOrigin = null;
const detectorMode = () => ['screen','document','whiteboard','businesscard','auto'].includes($('mode').value) ? $('mode').value : 'auto';
const detectionKey = (id, mode = detectorMode()) => id + '::' + mode;
const detectionOf = (id, mode = detectorMode()) => detections.get(detectionKey(id, mode));

async function waitForCv() {
  const deadline = Date.now() + 30000;
  while (!cvApi && !cvLoadError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 60));
  if (!cvApi) throw cvLoadError || new Error('OpenCV initialization timed out');
  return cvApi;
}

function rawOf(pngId) { // label PNG 名 → raw jpg 名(manifest 键)
  const base = pngId.replace(/\\.png$/i, '');
  const hit = Object.keys(manifest).find(k => k.replace(/\\.[^.]+$/, '') === base);
  return hit || base + '.jpg';
}
function rawExt(pngId) { const r = rawOf(pngId); return r.slice(r.lastIndexOf('.')); }

async function boot() {
  let d;
  try { d = await requestJson('/api/list'); }
  catch (e) {
    document.body.innerHTML = '<p id="loadError" style="color:#ff6961"></p>';
    $('loadError').textContent = e.message;
    console.error(e);
    return;
  }
  list = d.files; meta = d.meta || {}; gt = d.gt || {}; manifest = d.manifest || {}; outputs = new Set(d.outputs || []);
  if (!list.length) { document.body.innerHTML = '<p>desktop data/label 为空 — 先跑 node desktop/ingest.js</p>'; return; }
  buildDots();
  buildWall();
  show(applyHash());
  // cv 加载(模式照抄 app/src/detector.ts): opencv.js → 轮询 cv.Mat → detector-oss.js
  try {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/opencv.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    await new Promise(res => { const t = setInterval(() => { if (window.cv && window.cv.Mat) { cvApi = window.cv; clearInterval(t); res(); } }, 60); });
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/detector-oss.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    cvReady = true;
    if (!$('st').textContent) $('st').textContent = 'cv 就绪';
    // 当前张已显示 → 现在补提案
    if (!detectionOf(list[idx])) { detectCur(); }
  } catch (e) { cvLoadError = e; if (!$('st').textContent) $('st').textContent = 'cv 加载失败: ' + e + ' (可继续手标, 无提案)'; }
}

async function detectOne(pngId, mode = detectorMode()) {
  const key = detectionKey(pngId, mode);
  if (detections.has(key)) return detections.get(key);
  if (!cvReady) return null;
  const bmp = await fetch('/label/' + pngId).then(r => r.blob()).then(b => createImageBitmap(b));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); bmp.close && bmp.close();
  const src = cvApi.matFromImageData(x.getImageData(0, 0, c.width, c.height));
  const t0 = performance.now();
  let r = null;
  try { r = OSSDetector.detect(cvApi, src, mode === 'auto' ? {} : { mode }); } catch (e) { console.warn(e); }
  src.delete();
  const rec = { quad: r && r.quad ? r.quad.map(p => [Math.round(p.x), Math.round(p.y)]) : null, mode, ms: Math.round(performance.now() - t0), at: new Date().toISOString() };
  detections.set(key, rec);
  return rec;
}

function detectCur() {
  const id = list[idx], mode = detectorMode();
  detectOne(id, mode).then(() => { if (list[idx] === id && detectorMode() === mode) seedIfEmpty(); });
}

// 检测完成回调: 已有标注不覆盖; 否则用提案预放四角(提案 null → 居中默认框)
function seedIfEmpty() {
  const id = list[idx];
  const d = detectionOf(id);
  proposal = d && d.quad ? d.quad : null;
  if ($('noTarget').classList.contains('active')) { quad = null; draw(); return; }
  if (gt[id] && (gt[id].quad || gt[id].noTarget)) { draw(); return; }
  if (quad) { draw(); return; }
  quad = d ? (d.quad ? d.quad.map(toDisplay) : defQuad()) : null;
  draw();
}
const scaleDisplayQuad = (value, sx, sy) => value && value.map(point => ({x: point.x * sx, y: point.y * sy}));
function syncOverlaySize() {
  const rect = img.getBoundingClientRect();
  const width = Math.round(rect.width), height = Math.round(rect.height);
  if (!width || !height || (ov.width === width && ov.height === height)) return;
  const sx = ov.width ? width / ov.width : 1, sy = ov.height ? height / ov.height : 1;
  quad = scaleDisplayQuad(quad, sx, sy);
  dragOrigin = scaleDisplayQuad(dragOrigin, sx, sy);
  undoStack = undoStack.map(value => scaleDisplayQuad(value, sx, sy));
  redoStack = redoStack.map(value => scaleDisplayQuad(value, sx, sy));
  ov.width = width; ov.height = height;
  ov.style.width = width + 'px'; ov.style.height = height + 'px';
  draw();
}
const toDisplay = p => ({x: p[0] * ov.width / img.naturalWidth, y: p[1] * ov.height / img.naturalHeight});
function defQuad() { return [{x:ov.width*.25,y:ov.height*.25},{x:ov.width*.75,y:ov.height*.25},{x:ov.width*.75,y:ov.height*.75},{x:ov.width*.25,y:ov.height*.75}]; }

// 复审模式: URL #review=IMG_4083,IMG_4087 — 只显示指定图(逗号分隔, 可不带扩展名), 顺序排列
// 另支持 #pos=N 直接跳到第 N 张。boot 后 hash 清掉, 恢复全量模式。
function applyHash() {
  const h = location.hash;
  const m = /#review=([^&]+)/.exec(h);
  if (m) {
    const want = decodeURIComponent(m[1]).split(',').map(s => s.replace(/\\.(png|jpe?g)$/i, ''));
    const filtered = list.filter(f => want.some(w => f.replace(/\\.png$/i, '') === w));
    // 按 want 顺序排
    const sorted = want.map(w => filtered.find(f => f.replace(/\\.png$/i, '') === w)).filter(Boolean);
    if (sorted.length) { list = sorted; history.replaceState(null, '', '/'); $('tip').innerHTML = '<b style="color:#ff9f0a">复审模式</b>: 本次仅含指定的 ' + sorted.length + ' 张, 改完 ⌘S  保存后刷新页面即恢复全部。'; }
    return 0;
  }
  const p = /#pos=(\d+)/.exec(h);
  if (p) { history.replaceState(null, '', '/'); return +p[1] - 1; }
  return 0;
}

function show(i) {
  idx = (i + list.length) % list.length;
  const id = list[idx], g = gt[id];
  if (g && g.mode) $('mode').value = ['screen','document','whiteboard','businesscard','auto'].includes(g.mode) ? g.mode : 'auto';
  quad = null; proposal = null; undoStack = []; redoStack = []; syncHistoryButtons();
  img.src = '/label/' + id;
  img.onload = () => {
    const rect = img.getBoundingClientRect();
    ov.width = Math.round(rect.width); ov.height = Math.round(rect.height);
    ov.style.width = ov.width + 'px'; ov.style.height = ov.height + 'px';
    const d = detectionOf(id);
    if (d && d.quad) proposal = d.quad;
    if (g && g.noTarget) { quad = null; $('noTarget').classList.add('active'); }
    else if (g && g.quad) quad = g.quad.map(toDisplay);
    else if (d) quad = d.quad ? d.quad.map(toDisplay) : defQuad(); // 提案 null → 居中框
    else quad = null; // 提案未到: 检测完成后 seedIfEmpty 预放
    if (!g || !g.noTarget) $('noTarget').classList.remove('active');
    $('expectFallback').classList.toggle('warning', Boolean(g && g.expectFallback));
    $('pos').textContent = (idx+1) + '/' + list.length + ' ' + id + (g && !g.noTarget && arWarn(g.quad) ? '  ⚠ 比例异常 ar=' + quadAr(g.quad).toFixed(2) : '');
    markCurDot(); draw();
    if (cvReady && !d) detectCur(); // 翻到本张且当前模式未检测 → 触发
    else if (d) seedIfEmpty();
  };
}

function draw() {
  ctx.clearRect(0,0,ov.width,ov.height);
  ov.dataset.proposal = proposal ? JSON.stringify(proposal) : '';
  ov.dataset.quad = quad ? JSON.stringify(quad.map(p => [Math.round(p.x), Math.round(p.y)])) : '';
  ov.dataset.cvReady = String(cvReady);
  if (proposal) { // 蓝幽灵框(自然坐标 → 显示坐标)
    const q = proposal.map(toDisplay);
    ctx.strokeStyle = 'rgba(100,210,255,.55)'; ctx.lineWidth = 2; ctx.setLineDash([8,6]);
    ctx.beginPath(); q.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!quad) return;
  ctx.strokeStyle = '#30d158'; ctx.lineWidth = 3;
  ctx.beginPath(); quad.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.stroke();
  quad.forEach(p => { ctx.fillStyle='#30d158'; ctx.beginPath(); ctx.arc(p.x,p.y,10,0,7); ctx.fill(); });
}

const cloneQuad = value => value ? value.map(point => ({x: point.x, y: point.y})) : null;
function sameQuad(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function syncHistoryButtons() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }
function remember(previous) {
  if (sameQuad(previous, quad)) return;
  undoStack.push(cloneQuad(previous)); redoStack = []; syncHistoryButtons();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneQuad(quad)); quad = undoStack.pop(); syncHistoryButtons(); draw();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneQuad(quad)); quad = redoStack.pop(); syncHistoryButtons(); draw();
}

let drag = -1;
function pt(ev) { const r = ov.getBoundingClientRect(); return {x: ev.clientX-r.left, y: ev.clientY-r.top}; }
ov.addEventListener('mousedown', ev => { if (!quad) return; const p = pt(ev); drag = quad.findIndex(q => Math.hypot(q.x-p.x,q.y-p.y)<26); if (drag>=0) { dragOrigin = cloneQuad(quad); ev.preventDefault(); } });
ov.addEventListener('mousemove', ev => { if (drag<0) return; const p = pt(ev); quad[drag] = p; draw(); });
ov.addEventListener('mouseup', () => { if (drag >= 0) remember(dragOrigin); drag = -1; dragOrigin = null; });
ov.addEventListener('touchstart', ev => { if (!quad) return; const p = pt(ev.touches[0]); drag = quad.findIndex(q => Math.hypot(q.x-p.x,q.y-p.y)<30); if (drag>=0) { dragOrigin = cloneQuad(quad); ev.preventDefault(); } }, {passive:false});
ov.addEventListener('touchmove', ev => { if (drag<0) return; ev.preventDefault(); const t = ev.touches[0]; const r = ov.getBoundingClientRect(); quad[drag] = {x:t.clientX-r.left, y:t.clientY-r.top}; draw(); }, {passive:false});
ov.addEventListener('touchend', () => { if (drag >= 0) remember(dragOrigin); drag = -1; dragOrigin = null; });

$('noTarget').onclick = () => {
  const active = !$('noTarget').classList.contains('active');
  $('noTarget').classList.toggle('active', active); $('expectFallback').classList.remove('warning');
  if (active) quad = null; else quad = defQuad();
  draw();
};
$('expectFallback').onclick = () => {
  if (!quad) return;
  $('expectFallback').classList.toggle('warning'); $('noTarget').classList.remove('active');
};
$('undo').onclick = undo;
$('redo').onclick = redo;
$('mode').onchange = () => {
  proposal = null;
  if (!gt[list[idx]]) quad = null;
  draw();
  if (cvReady) detectCur();
};
$('prev').onclick = () => show(idx-1);
$('next').onclick = () => show(idx+1);
document.addEventListener('keydown', e => {
  if (e.key==='ArrowLeft') show(idx-1);
  if (e.key==='ArrowRight') show(idx+1);
  if (e.key.toLowerCase()==='z' && (e.metaKey||e.ctrlKey)) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (e.key==='s' && (e.metaKey||e.ctrlKey)) { e.preventDefault(); $('save').click(); }
});

// edited = 任一角距提案 >2px(显示坐标像素)或提案为 null
function editedVsProposal() {
  const d = detectionOf(list[idx]);
  if (!quad) return false;
  if (!d) return false; // 无提案记录(未检测) — 只记保存
  if (!d.quad) return true; // 提案 null, 手动放了框
  if (!proposal) return false;
  const pp = proposal.map(toDisplay);
  return quad.some((p, i) => Math.hypot(p.x - pp[i].x, p.y - pp[i].y) > 2);
}

function toNatural(q) { return q.map(p => [Math.round(p.x * img.naturalWidth / ov.width), Math.round(p.y * img.naturalHeight / ov.height)]); }

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!response.ok || body?.ok !== true) throw new Error(body?.error || 'HTTP ' + response.status + ': ' + (text || '无错误内容'));
  return body;
}

async function save() {
  const id = list[idx], rawId = rawOf(id), d = detectionOf(id);
  const m = manifest[rawId] || {};
  const edited = editedVsProposal();
  const rec = { mode: $('mode').value, edited,
    labelW: img.naturalWidth, labelH: img.naturalHeight, sourceW: m.w, sourceH: m.h,
    sourceOrientation: m.orientation, orientedSourceW: m.orientedW, orientedSourceH: m.orientedH,
    proposal: d ? { quad: d.quad, ms: d.ms, mode: d.mode, at: d.at } : null };
  let gtRec;
  if (quad) {
    rec.quad = toNatural(quad);
    rec.expectFallback = $('expectFallback').classList.contains('warning');
    gtRec = { mode: rec.mode, quad: rec.quad, ...(rec.expectFallback ? { expectFallback: true } : {}) };
  }
  else { rec.noTarget = true; gtRec = { mode: rec.mode, noTarget: true }; }
  $('st').textContent = '保存中 ' + id;
  try {
    const saved = await requestJson('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: rawId, rec, gtId: id, gtRec})});
    gt[id] = Object.assign({}, gtRec, {labeledAt: saved.labeledAt});
    meta[rawId] = Object.assign({}, meta[rawId], rec, {labeledAt: saved.labeledAt});
    if (rec.noTarget) { delete meta[rawId].quad; delete meta[rawId].expectFallback; }
    else { delete meta[rawId].noTarget; if (!rec.expectFallback) delete meta[rawId].expectFallback; }
    if (rec.noTarget) outputs.delete(outputOf(rawId));
    buildDots();
    buildWall();
    const warn = rec.quad && arWarn(rec.quad);
    const warning = warn ? '  ⚠ 比例异常 ar=' + quadAr(rec.quad).toFixed(2) + '(幻灯片通常≈' + SLIDE_AR + ', 没拍全可忽略)' : '';
    if (rec.quad) {
      $('st').textContent = '标注已接收，准备生成成品 ' + id + warning;
      setTimeout(() => { void renderFull(rawId).then(() => buildDots()); }, 0); // 保存即异步渲染,不阻塞点击响应
    } else {
      flash(id + ' 已存');
      if (returnToWall) { returnToWall = false; showWall(); }
    }
  } catch (e) {
    $('st').textContent = '保存失败 ' + id + ': ' + e.message;
    console.error(e);
  }
}

// —— 全分辨率渲染(cv.warpPerspective, 仅校正无增强) ——
async function renderFull(rawId) {
  const rec = meta[rawId];
  if (!rec || !rec.quad || rec.noTarget) return true;
  const st = $('st');
  try {
    if (!cvApi) st.textContent = '等待 OpenCV…';
    const cv = cvApi || await waitForCv();
    st.textContent = '渲染中 ' + rawId;
    const blob = await fetch('/raw/' + rawId).then(r => r.blob());
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const bw = bmp.width, bh = bmp.height;
    const c = document.createElement('canvas'); c.width = bw; c.height = bh;
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); bmp.close && bmp.close();
    const src = cv.matFromImageData(x.getImageData(0, 0, c.width, c.height));

    // quad: label 坐标 → raw 坐标; 缩放不均匀(>1%)按轴 + 警告
    const kx = bw / rec.labelW, ky = bh / rec.labelH;
    if (Math.abs(kx - ky) > 0.01 * Math.max(kx, ky)) console.warn('[scale] 非均匀', rawId, kx.toFixed(3), ky.toFixed(3));
    const q = rec.quad.map(p => [p[0] * kx, p[1] * ky]);
    // 角点排序 tl/tr/br/bl(x+y 技巧, spike/index.html warpToRect)
    const sorted = q.slice().sort((a, b) => (a[0]+a[1]) - (b[0]+b[1]));
    const tl = sorted[0], br = sorted[3];
    // 剩余两点: x-y 大者 = tr, 小者 = bl
    const mid = [sorted[1], sorted[2]];
    const tr = mid[0][0] - mid[0][1] > mid[1][0] - mid[1][1] ? mid[0] : mid[1];
    const bl = mid[0] === tr ? mid[1] : mid[0];
    const sq = [tl, tr, br, bl];
    // 输出尺寸: 边长平均(app/src/imaging.ts warpPage)
    const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
    const w0 = Math.max(16, Math.round((dist(sq[0], sq[1]) + dist(sq[3], sq[2])) / 2));
    const h0 = Math.max(16, Math.round((dist(sq[0], sq[3]) + dist(sq[1], sq[2])) / 2));

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...sq));
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, w0-1,0, w0-1,h0-1, 0,h0-1]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(w0, h0));
    const out = document.createElement('canvas'); out.width = w0; out.height = h0;
    out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(dst.data), w0, h0), 0, 0);
    src.delete(); dst.delete(); srcTri.delete(); dstTri.delete(); M.delete();

    const jb = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.92));
    await requestJson('/api/output?name=' + encodeURIComponent(rawId), {method:'POST', body: jb});
    const renderedAt = new Date().toISOString();
    await requestJson('/api/save', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({id: rawId, rec: {renderedAt}, gtId: list.find(f => rawOf(f)===rawId), gtRec: gt[list.find(f => rawOf(f)===rawId)]})});
    meta[rawId].renderedAt = renderedAt;
    outputs.add(outputOf(rawId));
    buildWall();
    st.textContent = '✓ ' + rawId;
    if (returnToWall && rawOf(list[idx]) === rawId) { returnToWall = false; showWall(); }
    return true;
  } catch (e) { st.textContent = '渲染失败 ' + rawId + ': ' + e; console.error(e); return false; }
}

$('renderAll').onclick = async () => {
  // 顺序渲染: 有 quad、非 noTarget、renderedAt < labeledAt(或无 renderedAt)
  const todo = Object.keys(meta).filter(k => meta[k].quad && !meta[k].noTarget && (!meta[k].renderedAt || meta[k].renderedAt < meta[k].labeledAt));
  $('st').textContent = '批量渲染 ' + todo.length + ' 张';
  for (const k of todo) {
    if (!await renderFull(k)) { buildDots(); return; }
  }
  $('st').textContent = '批量渲染完成 ' + todo.length + ' 张';
  buildDots();
};

// —— 底部状态点: 灰=未标 橙=edited 绿=已标 红=noTarget ——

// —— 比例校验(经验教训 2026-08-18): 投影幻灯片成品 ar 应 ≈1.96(σ 0.02, 218 张实测) ——
// GT quad 的边长平均 ar 偏离 >0.25 即标黄 — 标注时即时提示, 不用等人翻 outputs 才发现。
// 注意: 这是启发式(没拍全/方屏会误报), 黄点 = "值得再看一眼", 不是 "错"。
const SLIDE_AR = 1.96, SLIDE_AR_TOL = 0.25;
function quadAr(q) { // q: [[x,y]×4] 任意角序
  const d = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
  const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
  const cx = (Math.max(...xs)+Math.min(...xs))/2, cy = (Math.max(...ys)+Math.min(...ys))/2;
  const byDist = q.slice().sort((a,b) => Math.hypot(a[0]-cx,a[1]-cy) - Math.hypot(b[0]-cx,b[1]-cy));
  // 角排序 tl/tr/br/bl 后边长平均(imaging.ts 规则的简化: 直接按质心角度排序)
  const byAng = q.slice().sort((a,b) => Math.atan2(a[1]-cy,a[0]-cx) - Math.atan2(b[1]-cy,b[0]-cx));
  const w0 = (d(byAng[0],byAng[1]) + d(byAng[3],byAng[2])) / 2;
  const h0 = (d(byAng[0],byAng[3]) + d(byAng[1],byAng[2])) / 2;
  return w0 / Math.max(1, h0);
}
function arWarn(q) { return q && Math.abs(quadAr(q) - SLIDE_AR) > SLIDE_AR_TOL; }

function outputOf(rawId) { return rawId.replace(/\.[^.]+$/, '') + '-corrected.jpg'; }
function showEditor(i) {
  $('wall').hidden = true; $('editor').hidden = false; $('dots').hidden = false;
  $('showWall').textContent = '成品墙'; $('showWall').classList.remove('active');
  if (Number.isInteger(i)) show(i);
}
function showWall() {
  buildWall(); $('editor').hidden = true; $('wall').hidden = false; $('dots').hidden = true;
  $('showWall').textContent = '返回标注'; $('showWall').classList.add('active');
}
function buildWall() {
  const wall = $('wall'); wall.innerHTML = '';
  list.forEach((id, i) => {
    const rawId = rawOf(id), output = outputOf(rawId), g = gt[id];
    const rendered = outputs.has(output), warning = rendered && g && !g.noTarget && arWarn(g.quad);
    const card = document.createElement('button');
    card.className = 'wallCard ' + (g && g.noTarget ? 'noTarget' : rendered ? 'rendered' + (warning ? ' warning' : '') : 'pending');
    card.dataset.id = id;
    const ar = g && g.quad ? quadAr(g.quad).toFixed(2) : '';
    card.title = id + (warning ? ' — 比例可疑 ar=' + ar : g && g.noTarget ? ' — 无目标' : rendered ? ' — 已渲染' : ' — 未渲染');
    if (rendered) {
      const image = document.createElement('img'); image.alt = id; image.loading = 'lazy';
      image.src = '/outputs/' + encodeURIComponent(output) + '?v=' + encodeURIComponent((meta[rawId] && meta[rawId].renderedAt) || '1');
      card.appendChild(image);
    } else {
      const placeholder = document.createElement('span'); placeholder.className = 'wallPlaceholder';
      placeholder.textContent = g && g.noTarget ? 'NO TARGET' : 'PENDING'; card.appendChild(placeholder);
    }
    const row = document.createElement('span'); row.className = 'wallMeta';
    const name = document.createElement('span'); name.className = 'wallName'; name.textContent = id.replace(/\.png$/i, '');
    const state = document.createElement('span'); state.className = 'wallState'; state.textContent = warning ? '待复核 ' + ar : g && g.noTarget ? '无目标' : rendered ? '已渲染' : '未渲染';
    row.append(name, state); card.appendChild(row);
    card.onclick = () => { returnToWall = true; showEditor(i); };
    wall.appendChild(card);
  });
}
$('showWall').onclick = () => $('wall').hidden ? showWall() : showEditor();

function buildDots() {
  const box = $('dots'); box.innerHTML = '';
  list.forEach((id, i) => {
    const g = gt[id];
    const warn = g && !g.noTarget && arWarn(g.quad);
    const el = document.createElement('div');
    el.className = 'dot' + (g ? (g.noTarget ? ' noTarget' : g.expectFallback ? ' fallback' : warn ? ' ar-warn' : meta[rawOf(id)] && meta[rawOf(id)].edited ? ' edited' : ' saved') : '') + (i === idx ? ' cur' : '');
    el.title = id + (g ? ' — ' + g.mode + (g.expectFallback ? ' 期望降级' : warn ? ' ⚠ 比例异常 ar=' + quadAr(g.quad).toFixed(2) : '') : '');
    el.onclick = () => show(i);
    box.appendChild(el);
  });
}
function markCurDot() { buildDots(); }
function flash(t) { $('st').textContent = t; setTimeout(() => { if ($('st').textContent === t) $('st').textContent = ''; }, 1200); }

$('save').onclick = save;
new ResizeObserver(syncOverlaySize).observe(img);
boot();
</script></body></html>`;

server.listen(PORT, '127.0.0.1', () => console.log(`desktop tool → http://127.0.0.1:${PORT}  (data ${BATCH}, raw ${fs.readdirSync(RAW).length} 张, label ${fs.readdirSync(LABEL).filter(f => f.endsWith('.png')).length} 张)`));
