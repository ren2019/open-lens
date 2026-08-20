#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../service.js';

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

function readJson<T>(file: string): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) { fail(`cannot read JSON ${file}: ${error}`); }
}

function isQuad(value: unknown): value is Quad {
  return Array.isArray(value) && value.length === 4 && value.every(point =>
    Array.isArray(point) && point.length === 2 && point.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)));
}

function scaleQuad(quad: Quad, record: BatchRecord): Quad {
  const labelW = record.labelW || record.sourceW || 1;
  const labelH = record.labelH || record.sourceH || 1;
  const sourceW = record.sourceW || labelW;
  const sourceH = record.sourceH || labelH;
  return quad.map(([x, y]) => [Math.round(x * sourceW / labelW), Math.round(y * sourceH / labelH)]) as Quad;
}

function digest(file: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyIfChanged(source: string, destination: string) {
  if (fs.existsSync(destination)) {
    const sourceStat = fs.statSync(source);
    const destinationStat = fs.statSync(destination);
    if (sourceStat.size === destinationStat.size && digest(source) === digest(destination)) return false;
  }
  fs.copyFileSync(source, destination);
  return true;
}

const options = parseArgs(process.argv.slice(2));
const metaFile = path.join(options.source, 'batch-meta.json');
const records = Object.entries(readJson<Record<string, BatchRecord>>(metaFile));
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
  if (!fs.existsSync(originalSource)) fail(`${rawId}: original file missing: ${originalSource}`);
  if (!fs.existsSync(scanSource)) fail(`${rawId}: corrected file missing: ${scanSource}`);
  return { rawId, record, index, originalSource, scanSource, createdAt };
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

fs.mkdirSync(archiveDir, { recursive: true });
let copied = 0;
const rows = prepared.map(item => {
  const originalName = `original_${item.index}${path.extname(item.rawId).toLowerCase()}`;
  const scanName = `scan_${item.index}.jpg`;
  if (copyIfChanged(item.originalSource, path.join(archiveDir, originalName))) copied++;
  if (copyIfChanged(item.scanSource, path.join(archiveDir, scanName))) copied++;
  const mode = item.record.mode || item.record.proposal?.mode || 'auto';
  return {
    id: `${options.documentId}_${item.rawId.replace(/\.[^.]+$/, '')}`,
    doc_id: options.documentId,
    idx: item.index,
    quad: JSON.stringify(scaleQuad(item.record.quad as Quad, item.record)),
    enhancement: 'original',
    rotation: 0,
    original_path: `${relativeDir}/${originalName}`,
    scan_path: `${relativeDir}/${scanName}`,
    edited: item.record.edited ? 1 : 0,
    detect_meta: JSON.stringify({
      mode,
      proposal: item.record.proposal?.quad ? scaleQuad(item.record.proposal.quad, item.record) : null,
      ms: Number(item.record.proposal?.ms) || 0,
      edited: Boolean(item.record.edited),
      source: 'desktop-batch',
    }),
  };
});

fs.mkdirSync(options.data, { recursive: true });
const db = new Database(path.join(options.data, 'openlens.db'));
initializeSchema(db);
db.pragma('foreign_keys = ON');
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
const write = db.transaction(() => {
  upsertDoc.run(options.documentId, options.name, createdAt, JSON.stringify(['desktop-batch', 'detector-dataset']));
  for (const row of rows) upsertPage.run(row);
  const currentIds = new Set(rows.map(row => row.id));
  const oldRows = db.prepare('SELECT id FROM pages WHERE doc_id=?').all(options.documentId) as { id: string }[];
  const deletePage = db.prepare('DELETE FROM pages WHERE id=?');
  for (const row of oldRows) if (!currentIds.has(row.id)) deletePage.run(row.id);
});
write();

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
