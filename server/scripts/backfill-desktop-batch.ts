#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  initializeSchema,
  SERVICE_SCHEMA_COLUMNS,
  SERVICE_SCHEMA_MIGRATABLE_PAGE_COLUMNS,
} from '../service.js';

const require = createRequire(import.meta.url);
const { orientedDimensions, readExifOrientationBuffer } = require('../../desktop/image-orientation.js') as {
  orientedDimensions: (width: number, height: number, orientation: number) => { width: number; height: number };
  readExifOrientationBuffer: (buffer: Buffer, source?: string) => number;
};

type Point = [number, number];
type Quad = [Point, Point, Point, Point];
type BatchRecord = {
  mode?: string;
  edited?: boolean;
  noTarget?: boolean;
  labelW?: number;
  labelH?: number;
  sourceW?: number;
  sourceH?: number;
  sourceOrientation?: number;
  orientedSourceW?: number;
  orientedSourceH?: number;
  proposal?: { quad?: Quad | null; ms?: number; mode?: string } | null;
  quad?: Quad;
  labeledAt?: string;
};

function fail(message: string): never {
  console.error(`[backfill:desktop] ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm --prefix server run backfill:desktop -- --source <batch-dir> --data <server-data-dir> [--document-id <id>] [--name <name>] --apply');
      process.exit(0);
    }
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`${arg} requires a value`);
    values[arg.slice(2)] = argv[++i];
  }
  if (!values.source) fail('--source is required');
  if (!values.data) fail('--data is required');
  const documentId = values['document-id'] || 'desktop-batch';
  if (!/^[A-Za-z0-9_-]+$/.test(documentId)) fail('--document-id may contain only letters, numbers, underscores, and hyphens');
  return {
    source: path.resolve(values.source),
    data: path.resolve(values.data),
    documentId,
    name: values.name || `Desktop batch: ${path.basename(path.resolve(values.source))}`,
    apply,
  };
}

function isQuad(value: unknown): value is Quad {
  return Array.isArray(value) && value.length === 4 && value.every(point =>
    Array.isArray(point) && point.length === 2 && point.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)));
}

function orientedSource(record: BatchRecord, originalSource: string, originalBytes: Buffer) {
  const sourceW = record.sourceW;
  const sourceH = record.sourceH;
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW! <= 0 || sourceH! <= 0) {
    fail(`${path.basename(originalSource)}: sourceW/sourceH must be positive numbers`);
  }
  let orientation: number;
  try { orientation = readExifOrientationBuffer(originalBytes, originalSource); }
  catch (error) { fail(`${path.basename(originalSource)}: cannot read EXIF orientation: ${error}`); }
  const oriented = orientedDimensions(sourceW!, sourceH!, orientation);
  if (record.sourceOrientation !== undefined && record.sourceOrientation !== orientation) {
    fail(`${path.basename(originalSource)}: sourceOrientation ${record.sourceOrientation} does not match Original ${orientation}`);
  }
  if ((record.orientedSourceW !== undefined && record.orientedSourceW !== oriented.width)
    || (record.orientedSourceH !== undefined && record.orientedSourceH !== oriented.height)) {
    fail(`${path.basename(originalSource)}: oriented source dimensions do not match Original orientation`);
  }
  return { ...oriented, orientation };
}

function scaleQuad(quad: Quad, record: BatchRecord, source: { width: number; height: number }): Quad {
  const labelW = record.labelW || record.sourceW || 1;
  const labelH = record.labelH || record.sourceH || 1;
  return quad.map(([x, y]) => [Math.round(x * source.width / labelW), Math.round(y * source.height / labelH)]) as Quad;
}

function legacyScaleQuad(quad: Quad, record: BatchRecord): Quad {
  return scaleQuad(quad, record, {
    width: record.sourceW || record.labelW || 1,
    height: record.sourceH || record.labelH || 1,
  });
}

function digestBytes(bytes: Buffer) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function digest(file: string) {
  return digestBytes(fs.readFileSync(file));
}

const options = parseArgs(process.argv.slice(2));

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function directoryRoot(root: string, label: string, create = false) {
  if (create) fs.mkdirSync(root, { recursive: true });
  let identity: fs.Stats;
  try { identity = fs.lstatSync(root); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (identity.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${root}`);
  if (!identity.isDirectory()) throw new Error(`${label} must be a directory: ${root}`);
  return fs.realpathSync(root);
}

function pathIdentity(root: string, candidate: string, label: string) {
  if (!isContained(root, candidate)) throw new Error(`${label} escapes its root: ${candidate}`);
  let cursor = root;
  for (const component of path.relative(root, candidate).split(path.sep)) {
    cursor = path.join(cursor, component);
    let identity: fs.Stats;
    try { identity = fs.lstatSync(cursor); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (identity.isSymbolicLink()) throw new Error(`${label} has a symlink path component: ${cursor}`);
    if (cursor !== candidate && !identity.isDirectory()) {
      throw new Error(`${label} has a non-directory path component: ${cursor}`);
    }
    if (cursor === candidate) return identity;
  }
  return null;
}

function regularFile(root: string, rootReal: string, candidate: string, label: string, singleLink: boolean) {
  const identity = pathIdentity(root, candidate, label);
  if (!identity) throw new Error(`${label} is missing: ${candidate}`);
  if (!identity.isFile()) throw new Error(`${label} must be a regular file: ${candidate}`);
  if (singleLink && identity.nlink !== 1) throw new Error(`${label} has multiple hard links: ${candidate}`);
  const real = fs.realpathSync(candidate);
  if (!isContained(rootReal, real)) throw new Error(`${label} resolves outside its root: ${candidate}`);
  return identity;
}

const sourceRootReal = directoryRoot(options.source, 'source root');
if (!sourceRootReal) fail(`source root is missing: ${options.source}`);
let dataRootReal = directoryRoot(options.data, 'data root');

function ensureDataRoot() {
  dataRootReal = directoryRoot(options.data, 'data root', true);
  if (!dataRootReal) throw new Error(`data root is missing: ${options.data}`);
  return dataRootReal;
}

const TEST_PAUSE_POINTS = new Set([
  'after-original-snapshot',
  'before-artifact-staging',
  'before-final-precondition',
  'after-first-artifact-link',
  'after-artifact-install',
]);
let testPauseConsumed = false;

function pauseAtTestHook(point: string) {
  const pause = process.env.OPEN_LENS_BACKFILL_TEST_PAUSE;
  if (!pause) return;
  if (process.env.OPEN_LENS_BACKFILL_TEST_MODE !== '1' || !TEST_PAUSE_POINTS.has(pause)) {
    throw new Error('backfill test pause requires a supported hook and explicit test mode');
  }
  if (pause !== point || testPauseConsumed) return;
  const dataRoot = fs.realpathSync(options.data);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temporaryRoot, dataRoot);
  const topLevel = relative.split(path.sep)[0];
  const requestedControl = path.resolve(process.env.OPEN_LENS_BACKFILL_TEST_CONTROL || '');
  const controlParent = fs.realpathSync(path.dirname(requestedControl));
  const control = path.join(controlParent, path.basename(requestedControl));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !topLevel.startsWith('open-lens-backfill-e2e-')
    || controlParent !== dataRoot || !path.basename(control).startsWith('.backfill-')) {
    throw new Error('backfill test pause requires an isolated open-lens-backfill-e2e-* data directory');
  }
  testPauseConsumed = true;
  const ready = `${control}.ready`;
  const resume = `${control}.resume`;
  fs.writeFileSync(ready, 'ready', { flag: 'wx' });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(resume) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    if (!fs.existsSync(resume)) throw new Error('backfill test pause timed out');
  } finally {
    fs.rmSync(ready, { force: true });
    fs.rmSync(resume, { force: true });
  }
}

const metaFile = path.join(options.source, 'batch-meta.json');
regularFile(options.source, sourceRootReal, metaFile, 'batch-meta.json', false);
const metaSnapshot = fs.readFileSync(metaFile);
const expectedMetaHash = digestBytes(metaSnapshot);
let parsedMeta: Record<string, BatchRecord>;
try { parsedMeta = JSON.parse(metaSnapshot.toString('utf8')) as Record<string, BatchRecord>; }
catch (error) { fail(`cannot read JSON ${metaFile}: ${error}`); }
const records = Object.entries(parsedMeta);
if (!records.length) fail(`no records found in ${metaFile}`);

const datedRecords = records.map(([rawId, record]) => {
  const createdAt = Date.parse(record.labeledAt || '');
  if (!Number.isFinite(createdAt)) fail(`${rawId}: labeledAt must be an ISO timestamp`);
  return { rawId, record, createdAt };
});
const skippedNoTarget = datedRecords.filter(({ record }) => record.noTarget);
const prepared = datedRecords.filter(({ record }) => !record.noTarget).map(({ rawId, record, createdAt }, index) => {
  if (!isQuad(record.quad)) fail(`${rawId}: quad must contain four finite points`);
  if (record.proposal !== null && (!record.proposal || (record.proposal.quad !== null && !isQuad(record.proposal.quad)))) {
    fail(`${rawId}: proposal.quad must contain four finite points or null`);
  }
  const originalSource = path.join(options.source, 'raw', rawId);
  const scanSource = path.join(options.source, 'outputs', rawId.replace(/\.[^.]+$/, '') + '-corrected.jpg');
  try {
    regularFile(options.source, sourceRootReal, originalSource, `${rawId}: source Original`, false);
    regularFile(options.source, sourceRootReal, scanSource, `${rawId}: source Scan`, false);
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  const originalBytes = fs.readFileSync(originalSource);
  const scanBytes = fs.readFileSync(scanSource);
  const oriented = orientedSource(record, originalSource, originalBytes);
  const originalHash = digestBytes(originalBytes);
  const scanHash = digestBytes(scanBytes);
  if (index === 0) pauseAtTestHook('after-original-snapshot');
  return { rawId, record, index, originalSource, scanSource, originalHash, scanHash, oriented, createdAt };
});

const createdAt = Math.min(...datedRecords.map(record => record.createdAt));
const createdDate = new Date(createdAt);
const year = String(createdDate.getFullYear());
const month = String(createdDate.getMonth() + 1).padStart(2, '0');
const relativeDir = `${year}/${month}/${options.documentId}`;
const archiveDir = path.join(options.data, relativeDir);
const expected = {
  pages: prepared.length,
  edited: prepared.filter(item => item.record.edited).length,
  modes: Object.fromEntries(Object.entries(prepared.reduce<Record<string, number>>((counts, item) => {
    const mode = item.record.mode || item.record.proposal?.mode || 'auto';
    counts[mode] = (counts[mode] || 0) + 1;
    return counts;
  }, {})).sort(([a], [b]) => a.localeCompare(b))),
  skipped: { noTarget: skippedNoTarget.length },
};

console.log(JSON.stringify({ dryRun: !options.apply, source: options.source, data: options.data, documentId: options.documentId, expected }, null, 2));
if (!options.apply) {
  console.log('[backfill:desktop] dry run only; pass --apply to copy files and update SQLite');
  process.exit(0);
}

const archiveRows = prepared.map(item => {
  const originalName = `original_${item.index}${path.extname(item.rawId).toLowerCase()}`;
  const scanName = `scan_${item.index}.jpg`;
  const mode = item.record.mode || item.record.proposal?.mode || 'auto';
  const detectMeta = {
    mode,
    proposal: item.record.proposal?.quad ? scaleQuad(item.record.proposal.quad, item.record, item.oriented) : null,
    ms: Number(item.record.proposal?.ms) || 0,
    edited: Boolean(item.record.edited),
    source: 'desktop-batch',
    coordinateSpace: 'oriented-original-v1',
  };
  const row = {
    id: `${options.documentId}_${item.rawId.replace(/\.[^.]+$/, '')}`,
    doc_id: options.documentId,
    idx: item.index,
    quad: JSON.stringify(scaleQuad(item.record.quad as Quad, item.record, item.oriented)),
    enhancement: 'original',
    rotation: 0,
    original_path: `${relativeDir}/${originalName}`,
    scan_path: `${relativeDir}/${scanName}`,
    edited: item.record.edited ? 1 : 0,
    detect_meta: JSON.stringify(detectMeta),
  };
  const legacy = {
    ...row,
    quad: JSON.stringify(legacyScaleQuad(item.record.quad as Quad, item.record)),
    detect_meta: JSON.stringify({
      mode,
      proposal: item.record.proposal?.quad ? legacyScaleQuad(item.record.proposal.quad, item.record) : null,
      ms: Number(item.record.proposal?.ms) || 0,
      edited: Boolean(item.record.edited),
      source: 'desktop-batch',
    }),
  };
  return { item, row, legacy, originalName, scanName };
});

function requireUniqueCandidates(label: string, values: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`duplicate candidate ${label}: ${value}`);
    seen.add(value);
  }
}

requireUniqueCandidates('page id', archiveRows.map(candidate => candidate.row.id));
requireUniqueCandidates('archive relative path', archiveRows.flatMap(candidate => [
  candidate.row.original_path,
  candidate.row.scan_path,
]));
requireUniqueCandidates('archive destination', archiveRows.flatMap(candidate => [
  path.join(archiveDir, candidate.originalName),
  path.join(archiveDir, candidate.scanName),
]));

const rows = archiveRows.map(item => item.row);
const archiveArtifacts = archiveRows.flatMap(candidate => [
  {
    pageId: candidate.row.id,
    role: 'Original',
    source: candidate.item.originalSource,
    destination: path.join(archiveDir, candidate.originalName),
    expectedHash: candidate.item.originalHash,
  },
  {
    pageId: candidate.row.id,
    role: 'Scan',
    source: candidate.item.scanSource,
    destination: path.join(archiveDir, candidate.scanName),
    expectedHash: candidate.item.scanHash,
  },
]);

function archivePathIdentity(candidate: string, label: string) {
  if (!dataRootReal) return null;
  return pathIdentity(options.data, candidate, label);
}

function assertArchiveDirectoryPath() {
  const identity = archivePathIdentity(archiveDir, 'archive directory');
  if (identity && !identity.isDirectory()) throw new Error(`archive directory must be a directory: ${archiveDir}`);
}

function archiveRegularFile(candidate: string, label: string, singleLink = true) {
  const identity = archivePathIdentity(candidate, label);
  if (!identity) return null;
  if (!identity.isFile()) throw new Error(`${label} must be a regular file: ${candidate}`);
  if (singleLink && identity.nlink !== 1) throw new Error(`${label} has multiple hard links: ${candidate}`);
  const real = fs.realpathSync(candidate);
  if (!dataRootReal || !isContained(dataRootReal, real)) {
    throw new Error(`${label} resolves outside the data root: ${candidate}`);
  }
  return identity;
}

function assertInputPreconditions() {
  regularFile(options.source, sourceRootReal, metaFile, 'batch-meta.json', false);
  if (digest(metaFile) !== expectedMetaHash) {
    throw new Error('batch-meta.json changed during backfill; refusing inconsistent input');
  }
}

function assertArtifactPreconditions(requireExisting: boolean) {
  assertArchiveDirectoryPath();
  for (const artifact of archiveArtifacts) {
    regularFile(options.source, sourceRootReal, artifact.source, `${artifact.pageId}: source ${artifact.role}`, false);
    if (digest(artifact.source) !== artifact.expectedHash) {
      throw new Error(`${artifact.pageId}: source ${artifact.role} changed during backfill; refusing inconsistent input`);
    }
    const destination = archiveRegularFile(artifact.destination, `${artifact.pageId}: archived ${artifact.role}`);
    if (requireExisting && !destination) {
      throw new Error(`${artifact.pageId}: archived ${artifact.role} artifact is missing; refusing to recreate possible later edits. Use a new --document-id or reconcile it manually.`);
    }
    if (destination && digest(artifact.destination) !== artifact.expectedHash) {
      throw new Error(`${artifact.pageId}: archived ${artifact.role} artifact has diverged; refusing to overwrite possible later edits. Use a new --document-id or reconcile it manually.`);
    }
  }
}

const archivedPageFields = ['idx', 'quad', 'enhancement', 'rotation', 'original_path', 'scan_path', 'edited', 'detect_meta'] as const;
const sameArchivedPage = (actual: Record<string, unknown>, expected: Record<string, unknown>) =>
  archivedPageFields.every(field => actual[field] === expected[field]);
const databaseFile = path.join(options.data, 'openlens.db');
const expectedDoc = {
  name: options.name,
  created_at: createdAt,
  tags: JSON.stringify(['desktop-batch', 'detector-dataset']),
};

function archiveSchemaState(db: Database.Database) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).pluck().all() as string[];
  if (tables.length === 0) return 'missing';
  const tableSet = new Set(tables);
  if (!tableSet.has('docs') || !tableSet.has('pages')) {
    throw new Error(`${options.documentId}: archive schema is incomplete; refusing to mutate it`);
  }
  const docColumns = new Set((db.prepare('PRAGMA table_info(docs)').all() as { name: string }[]).map(column => column.name));
  const pageColumns = new Set((db.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).map(column => column.name));
  const requiredPages = SERVICE_SCHEMA_COLUMNS.pages
    .filter(column => !(SERVICE_SCHEMA_MIGRATABLE_PAGE_COLUMNS as readonly string[]).includes(column));
  if (SERVICE_SCHEMA_COLUMNS.docs.some(column => !docColumns.has(column))
    || requiredPages.some(column => !pageColumns.has(column))) {
    throw new Error(`${options.documentId}: archive schema is incomplete; refusing to mutate it`);
  }
  if (tableSet.has('outfits')) {
    const outfitColumns = new Set((db.prepare('PRAGMA table_info(outfits)').all() as { name: string }[])
      .map(column => column.name));
    if (SERVICE_SCHEMA_COLUMNS.outfits.some(column => !outfitColumns.has(column))) {
      throw new Error(`${options.documentId}: archive schema is incomplete; refusing to mutate it`);
    }
  }
  return tableSet.has('outfits')
    && SERVICE_SCHEMA_MIGRATABLE_PAGE_COLUMNS.every(column => pageColumns.has(column)) ? 'ready' : 'legacy';
}

function assertPageOwnership(db: Database.Database) {
  const pageOwner = db.prepare('SELECT doc_id FROM pages WHERE id=?');
  for (const row of rows) {
    const owner = pageOwner.get(row.id) as { doc_id: string } | undefined;
    if (owner && owner.doc_id !== options.documentId) {
      throw new Error(`${row.id}: candidate page id belongs to another document (${owner.doc_id}); refusing to mutate it`);
    }
  }
}

function assertLegacyTargetAbsent(db: Database.Database) {
  assertPageOwnership(db);
  const existingDoc = db.prepare('SELECT id FROM docs WHERE id=?').get(options.documentId);
  const existingPages = (db.prepare('SELECT COUNT(*) count FROM pages WHERE doc_id=?')
    .get(options.documentId) as { count: number }).count;
  if (existingDoc || existingPages) {
    throw new Error(`${options.documentId}: legacy archive already contains this document; refusing an unverifiable migration`);
  }
}

function assertDatabasePreconditions(db: Database.Database) {
  assertPageOwnership(db);
  const existingDoc = db.prepare('SELECT name, created_at, tags FROM docs WHERE id=?')
    .get(options.documentId) as Record<string, unknown> | undefined;
  const existingPages = db.prepare(`
    SELECT id, idx, quad, enhancement, rotation, original_path, scan_path, edited, detect_meta
    FROM pages WHERE doc_id=?
  `).all(options.documentId) as Record<string, unknown>[];
  if (!existingDoc && existingPages.length) {
    throw new Error(`${options.documentId}: archived pages exist without their document; refusing to mutate inconsistent data`);
  }
  if (existingDoc && !['name', 'created_at', 'tags'].every(field => existingDoc[field] === expectedDoc[field as keyof typeof expectedDoc])) {
    throw new Error(`${options.documentId}: archived document has diverged; refusing to overwrite possible later edits. Use a new --document-id or reconcile it manually.`);
  }
  const expectedIds = rows.map(row => row.id).sort();
  const existingIds = existingPages.map(row => String(row.id)).sort();
  if (existingDoc && JSON.stringify(existingIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`${options.documentId}: archived page set has diverged; refusing to recreate or delete possible later edits. Use a new --document-id or reconcile it manually.`);
  }
  const existingById = new Map(existingPages.map(row => [row.id, row]));
  for (const candidate of archiveRows) {
    const existing = existingById.get(candidate.row.id);
    if (!existing || sameArchivedPage(existing, candidate.row) || sameArchivedPage(existing, candidate.legacy)) continue;
    throw new Error(`${candidate.row.id}: archived page has diverged; refusing to overwrite possible later edits. Use a new --document-id or reconcile it manually.`);
  }
  return Boolean(existingDoc);
}

function preflight() {
  let existingArchive = false;
  assertInputPreconditions();
  assertArchiveDirectoryPath();
  const databaseIdentity = archiveRegularFile(databaseFile, 'archive SQLite database');
  if (databaseIdentity) {
    const auditDb = new Database(databaseFile, { readonly: true });
    try {
      const schemaState = archiveSchemaState(auditDb);
      if (schemaState === 'ready') existingArchive = assertDatabasePreconditions(auditDb);
      if (schemaState === 'legacy') assertLegacyTargetAbsent(auditDb);
    } finally {
      auditDb.close();
    }
  }
  assertArtifactPreconditions(existingArchive);
  return existingArchive;
}

type FileIdentity = { dev: number; ino: number; size: number; nlink: number; hash: string };
type DirectoryIdentity = { dev: number; ino: number };
type StagedArtifact = (typeof archiveArtifacts)[number] & {
  temporary: string | null;
  temporaryIdentity: FileIdentity | null;
  directoryIdentity: DirectoryIdentity;
};

function archiveDirectoryIdentity(): DirectoryIdentity {
  const identity = archivePathIdentity(archiveDir, 'archive directory');
  if (!identity?.isDirectory()) throw new Error(`archive directory must be a directory: ${archiveDir}`);
  return { dev: identity.dev, ino: identity.ino };
}

function captureTemporaryIdentity(artifact: StagedArtifact) {
  const directory = archiveDirectoryIdentity();
  if (directory.dev !== artifact.directoryIdentity.dev || directory.ino !== artifact.directoryIdentity.ino) {
    throw new Error(`archive directory identity changed while staging: ${archiveDir}`);
  }
  const identity = archiveRegularFile(artifact.temporary!, `${artifact.pageId}: staged ${artifact.role}`);
  if (!identity) return null;
  return {
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
    nlink: identity.nlink,
    hash: digest(artifact.temporary!),
  };
}

function assertStagedDirectoryIdentity(artifact: StagedArtifact) {
  const directory = archiveDirectoryIdentity();
  if (directory.dev !== artifact.directoryIdentity.dev || directory.ino !== artifact.directoryIdentity.ino) {
    throw new Error(`archive directory identity changed while staging: ${archiveDir}`);
  }
}

function assertStagedArtifactIdentity(artifact: StagedArtifact) {
  if (!artifact.temporary || !artifact.temporaryIdentity) {
    throw new Error(`${artifact.pageId}: staged ${artifact.role} identity is unavailable`);
  }
  assertStagedDirectoryIdentity(artifact);
  const identity = archiveRegularFile(artifact.temporary, `${artifact.pageId}: staged ${artifact.role}`);
  if (!identity || identity.dev !== artifact.temporaryIdentity.dev || identity.ino !== artifact.temporaryIdentity.ino
    || identity.size !== artifact.temporaryIdentity.size || identity.nlink !== artifact.temporaryIdentity.nlink
    || digest(artifact.temporary) !== artifact.temporaryIdentity.hash) {
    throw new Error(`${artifact.pageId}: staged ${artifact.role} identity changed during backfill`);
  }
  return identity;
}

function removeOwnedStage(artifact: StagedArtifact) {
  assertStagedArtifactIdentity(artifact);
  fs.rmSync(artifact.temporary!);
  artifact.temporary = null;
}

function unlinkInstalledStage(artifact: StagedArtifact) {
  if (!artifact.temporary || !artifact.temporaryIdentity) {
    throw new Error(`${artifact.pageId}: staged ${artifact.role} identity is unavailable`);
  }
  assertStagedDirectoryIdentity(artifact);
  const stageIdentity = archiveRegularFile(artifact.temporary, `${artifact.pageId}: linked stage ${artifact.role}`, false);
  const destinationIdentity = archiveRegularFile(artifact.destination, `${artifact.pageId}: linked ${artifact.role}`, false);
  const expected = artifact.temporaryIdentity;
  if (!stageIdentity || !destinationIdentity
    || stageIdentity.dev !== expected.dev || stageIdentity.ino !== expected.ino
    || destinationIdentity.dev !== expected.dev || destinationIdentity.ino !== expected.ino
    || stageIdentity.size !== expected.size || destinationIdentity.size !== expected.size
    || stageIdentity.nlink !== 2 || destinationIdentity.nlink !== 2
    || digest(artifact.temporary) !== expected.hash) {
    throw new Error(`${artifact.pageId}: linked ${artifact.role} identity changed during backfill`);
  }
  fs.rmSync(artifact.temporary);
  artifact.temporary = null;
  const finalIdentity = archiveRegularFile(artifact.destination, `${artifact.pageId}: archived ${artifact.role}`);
  if (!finalIdentity || finalIdentity.dev !== expected.dev || finalIdentity.ino !== expected.ino
    || finalIdentity.size !== expected.size || digest(artifact.destination) !== expected.hash) {
    throw new Error(`${artifact.pageId}: installed ${artifact.role} identity changed during backfill`);
  }
  return finalIdentity;
}

function cleanupStages(staged: StagedArtifact[]) {
  const expectedDirectory = staged.find(artifact => artifact.temporary)?.directoryIdentity;
  if (!expectedDirectory) return;
  let directory: DirectoryIdentity;
  try { directory = archiveDirectoryIdentity(); }
  catch (cleanupError) {
    console.error(`[backfill:desktop] cannot safely clean staged artifacts: ${cleanupError}`);
    return;
  }
  if (directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino) {
    console.error(`[backfill:desktop] cannot safely clean staged artifacts: archive directory identity changed`);
    return;
  }
  for (const artifact of staged) {
    if (!artifact.temporary || !artifact.temporaryIdentity) continue;
    try {
      removeOwnedStage(artifact);
    } catch (cleanupError) {
      console.error(`[backfill:desktop] cannot safely clean staged artifact ${artifact.temporary}: ${cleanupError}`);
    }
  }
}

function stageMissingArtifacts() {
  const staged: StagedArtifact[] = [];
  const directoryIdentity = archiveDirectoryIdentity();
  try {
    for (const artifact of archiveArtifacts) {
      if (archiveRegularFile(artifact.destination, `${artifact.pageId}: archived ${artifact.role}`)) {
        staged.push({ ...artifact, temporary: null, temporaryIdentity: null, directoryIdentity });
        continue;
      }
      const temporary = path.join(archiveDir,
        `.${path.basename(artifact.destination)}.backfill-${process.pid}-${crypto.randomUUID()}.tmp`);
      const candidate: StagedArtifact = {
        ...artifact,
        temporary,
        temporaryIdentity: null,
        directoryIdentity,
      };
      staged.push(candidate);
      fs.copyFileSync(artifact.source, temporary, fs.constants.COPYFILE_EXCL);
      candidate.temporaryIdentity = captureTemporaryIdentity(candidate);
      if (candidate.temporaryIdentity?.hash !== artifact.expectedHash) {
        throw new Error(`${artifact.pageId}: staged ${artifact.role} hash mismatch`);
      }
    }
    return staged;
  } catch (error) {
    for (const artifact of staged) {
      if (!artifact.temporary || artifact.temporaryIdentity) continue;
      try { artifact.temporaryIdentity = captureTemporaryIdentity(artifact); }
      catch { /* Identity drift is handled by fail-closed cleanup below. */ }
    }
    cleanupStages(staged);
    throw error;
  }
}

let existingArchive = false;
try { existingArchive = preflight(); }
catch (error) { fail(error instanceof Error ? error.message : String(error)); }
try {
  ensureDataRoot();
  assertArchiveDirectoryPath();
  fs.mkdirSync(archiveDir, { recursive: true });
  assertArchiveDirectoryPath();
  pauseAtTestHook('before-artifact-staging');
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
let staged: ReturnType<typeof stageMissingArtifacts>;
try { staged = stageMissingArtifacts(); }
catch (error) { fail(error instanceof Error ? error.message : String(error)); }
try { pauseAtTestHook('before-final-precondition'); }
catch (error) {
  cleanupStages(staged);
  fail(error instanceof Error ? error.message : String(error));
}

let openedDb: Database.Database | undefined;
try {
  assertArchiveDirectoryPath();
  archiveRegularFile(databaseFile, 'archive SQLite database');
  openedDb = new Database(databaseFile);
  archiveRegularFile(databaseFile, 'archive SQLite database');
} catch (error) {
  openedDb?.close();
  cleanupStages(staged);
  fail(error instanceof Error ? error.message : String(error));
}
const db = openedDb;
if (!db) fail('archive SQLite database did not open');
db.pragma('foreign_keys = ON');
const installed: string[] = [];
let copied = 0;
try {
  db.exec('BEGIN IMMEDIATE');
  const schemaState = archiveSchemaState(db);
  let finalExistingArchive = false;
  if (schemaState === 'ready') finalExistingArchive = assertDatabasePreconditions(db);
  if (schemaState === 'legacy') assertLegacyTargetAbsent(db);
  if (finalExistingArchive !== existingArchive) {
    throw new Error(`${options.documentId}: archive existence changed after preflight; refusing concurrent overwrite`);
  }
  assertInputPreconditions();
  assertArtifactPreconditions(finalExistingArchive);
  if (schemaState === 'missing' || schemaState === 'legacy') {
    initializeSchema(db);
    if (archiveSchemaState(db) !== 'ready') throw new Error('archive schema migration did not reach service-ready state');
  }
  if (schemaState === 'legacy') finalExistingArchive = assertDatabasePreconditions(db);

  for (const artifact of staged) {
    if (!artifact.temporary) continue;
    try {
      assertStagedArtifactIdentity(artifact);
      fs.linkSync(artifact.temporary, artifact.destination);
      installed.push(artifact.destination);
      pauseAtTestHook('after-first-artifact-link');
      unlinkInstalledStage(artifact);
      copied++;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = archiveRegularFile(artifact.destination, `${artifact.pageId}: archived ${artifact.role}`);
      if (!existing || digest(artifact.destination) !== artifact.expectedHash) {
        throw new Error(`${artifact.pageId}: archived ${artifact.role} artifact has diverged; refusing to overwrite possible later edits. Use a new --document-id or reconcile it manually.`);
      }
      removeOwnedStage(artifact);
    }
  }
  pauseAtTestHook('after-artifact-install');
  assertInputPreconditions();
  assertArtifactPreconditions(true);

  const upsertDoc = db.prepare(`
    INSERT INTO docs (id, name, created_at, tags) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, created_at=excluded.created_at, tags=excluded.tags
  `);
  const upsertPage = db.prepare(`
    INSERT INTO pages (id, doc_id, idx, quad, enhancement, rotation, original_path, scan_path, edited, detect_meta)
    VALUES (@id, @doc_id, @idx, @quad, @enhancement, @rotation, @original_path, @scan_path, @edited, @detect_meta)
    ON CONFLICT(id) DO UPDATE SET idx=excluded.idx, quad=excluded.quad, enhancement=excluded.enhancement,
      rotation=excluded.rotation, original_path=excluded.original_path, scan_path=excluded.scan_path,
      edited=excluded.edited, detect_meta=excluded.detect_meta
  `);
  upsertDoc.run(options.documentId, options.name, createdAt, JSON.stringify(['desktop-batch', 'detector-dataset']));
  for (const row of rows) upsertPage.run(row);
  const currentIds = new Set(rows.map(row => row.id));
  const oldRows = db.prepare('SELECT id FROM pages WHERE doc_id=?').all(options.documentId) as { id: string }[];
  const deletePage = db.prepare('DELETE FROM pages WHERE id=?');
  for (const row of oldRows) if (!currentIds.has(row.id)) deletePage.run(row.id);
  assertInputPreconditions();
  assertArtifactPreconditions(true);
  db.exec('COMMIT');
} catch (error) {
  if (db.inTransaction) db.exec('ROLLBACK');
  cleanupStages(staged);
  if (installed.length) {
    console.error(`[backfill:desktop] installed artifact paths left untouched after failure; rerun or manual reconciliation required: ${installed.join(', ')}`);
  }
  db.close();
  fail(error instanceof Error ? error.message : String(error));
}
cleanupStages(staged);

const actual = {
  pages: (db.prepare('SELECT COUNT(*) count FROM pages WHERE doc_id=?').get(options.documentId) as { count: number }).count,
  edited: (db.prepare('SELECT COUNT(*) count FROM pages WHERE doc_id=? AND edited=1').get(options.documentId) as { count: number }).count,
  modes: Object.fromEntries((db.prepare(`
    SELECT json_extract(detect_meta, '$.mode') mode, COUNT(*) count
    FROM pages WHERE doc_id=? GROUP BY json_extract(detect_meta, '$.mode') ORDER BY mode
  `).all(options.documentId) as { mode: string; count: number }[]).map(row => [row.mode, row.count])),
  sources: (db.prepare(`SELECT COUNT(*) count FROM pages WHERE doc_id=? AND json_extract(detect_meta, '$.source')='desktop-batch'`).get(options.documentId) as { count: number }).count,
};
db.close();

if (actual.pages !== expected.pages || actual.edited !== expected.edited
  || actual.sources !== expected.pages || JSON.stringify(actual.modes) !== JSON.stringify(expected.modes)) {
  fail(`post-write reconciliation failed: ${JSON.stringify({ expected, actual })}`);
}
console.log(JSON.stringify({ ok: true, copiedFiles: copied, expected, actual }, null, 2));
