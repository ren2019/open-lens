import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export type DocumentFilters = {
  tag?: string;
  dateFrom?: number;
  dateTo?: number;
  query?: string;
};

export type DocumentPatch = {
  name?: string;
  tags?: string[];
  pageOrder?: string[];
};

type DocRow = {
  id: string;
  name: string;
  created_at: number;
  tags: string;
};

type PageRow = {
  id: string;
  idx: number;
  quad: string;
  enhancement: string;
  rotation: number;
  ocr: string | null;
  original_path: string;
  scan_path: string;
};

type OutfitRow = {
  id: string;
  kind: string;
  path: string;
};

const parseTags = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
  } catch {
    return [];
  }
};

const normalizeTags = (tags: unknown[]): string[] => [
  ...new Set(tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean)),
];

export const initializeSchema = (db: Database.Database) => {
  db.pragma('journal_mode = WAL');
  db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  quad TEXT NOT NULL,
  enhancement TEXT NOT NULL DEFAULT 'original',
  rotation INTEGER NOT NULL DEFAULT 0,
  ocr TEXT,
  original_path TEXT NOT NULL,
  scan_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outfits (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL
);
`);
};

export class OpenLensService {
  constructor(
    private readonly db: Database.Database,
    private readonly dataDir: string,
  ) {}

  listDocuments(filters: DocumentFilters = {}) {
    const docs = this.db.prepare('SELECT * FROM docs ORDER BY created_at DESC').all() as DocRow[];
    const tag = filters.tag?.trim();
    const query = filters.query?.trim().toLocaleLowerCase();

    return docs.flatMap(doc => {
      const tags = parseTags(doc.tags);
      if (tag && !tags.includes(tag)) return [];
      if (filters.dateFrom !== undefined && doc.created_at < filters.dateFrom) return [];
      if (filters.dateTo !== undefined && doc.created_at > filters.dateTo) return [];
      if (query) {
        const ocrRows = this.db.prepare('SELECT ocr FROM pages WHERE doc_id=?').all(doc.id) as { ocr: string | null }[];
        const haystack = [doc.name, ...tags, ...ocrRows.map(row => row.ocr ?? '')].join('\n').toLocaleLowerCase();
        if (!haystack.includes(query)) return [];
      }

      return [{
        id: doc.id,
        name: doc.name,
        createdAt: doc.created_at,
        tags,
        pageCount: (this.db.prepare('SELECT COUNT(*) c FROM pages WHERE doc_id=?').get(doc.id) as { c: number }).c,
        outfits: this.db.prepare('SELECT id, kind FROM outfits WHERE doc_id=? ORDER BY id').all(doc.id) as Pick<OutfitRow, 'id' | 'kind'>[],
      }];
    });
  }

  getDocument(id: string) {
    const doc = this.db.prepare('SELECT * FROM docs WHERE id=?').get(id) as DocRow | undefined;
    if (!doc) throw new NotFoundError(`document ${id} not found`);
    const pages = this.db.prepare(`
      SELECT id, idx, quad, enhancement, rotation, ocr, original_path, scan_path
      FROM pages WHERE doc_id=? ORDER BY idx
    `).all(id) as PageRow[];
    const outfits = this.db.prepare('SELECT id, kind, path FROM outfits WHERE doc_id=? ORDER BY id').all(id) as OutfitRow[];

    return {
      id: doc.id,
      name: doc.name,
      createdAt: doc.created_at,
      tags: parseTags(doc.tags),
      pages: pages.map(page => ({
        id: page.id,
        index: page.idx,
        quad: JSON.parse(page.quad),
        enhancement: page.enhancement,
        rotation: page.rotation,
        ocr: page.ocr ?? '',
        original: `/files/${page.original_path}`,
        scan: `/files/${page.scan_path}`,
      })),
      outfits: outfits.map(outfit => ({
        id: outfit.id,
        kind: outfit.kind,
        file: `/files/${outfit.path}`,
      })),
    };
  }

  updateDocument(id: string, patch: DocumentPatch) {
    const current = this.db.prepare('SELECT name, tags FROM docs WHERE id=?').get(id) as Pick<DocRow, 'name' | 'tags'> | undefined;
    if (!current) throw new NotFoundError(`document ${id} not found`);

    const name = patch.name === undefined ? current.name : patch.name.trim();
    if (!name) throw new ValidationError('name must not be empty');
    const tags = patch.tags === undefined ? parseTags(current.tags) : normalizeTags(patch.tags);

    const apply = this.db.transaction(() => {
      if (patch.pageOrder !== undefined) {
        const currentPages = this.db.prepare('SELECT id FROM pages WHERE doc_id=? ORDER BY idx').all(id) as { id: string }[];
        const expected = currentPages.map(page => page.id).sort();
        const requested = [...patch.pageOrder].sort();
        if (requested.length !== expected.length || requested.some((pageId, index) => pageId !== expected[index])) {
          throw new ValidationError('pageOrder must contain every current page id exactly once');
        }
        const setIndex = this.db.prepare('UPDATE pages SET idx=? WHERE doc_id=? AND id=?');
        patch.pageOrder.forEach((pageId, index) => setIndex.run(index, id, pageId));
      }
      this.db.prepare('UPDATE docs SET name=?, tags=? WHERE id=?').run(name, JSON.stringify(tags), id);
    });
    apply();

    return { ok: true, id, name, tags, pageOrder: this.getDocument(id).pages.map(page => page.id) };
  }

  listTags() {
    const rows = this.db.prepare('SELECT tags FROM docs').all() as { tags: string }[];
    return [...new Set(rows.flatMap(row => parseTags(row.tags)))].sort((a, b) => a.localeCompare(b));
  }

  getFile(documentId: string, options: {
    kind: 'original' | 'scan' | 'outfit';
    pageId?: string;
    pageIndex?: number;
    outfitId?: string;
  }) {
    if (!this.db.prepare('SELECT 1 FROM docs WHERE id=?').get(documentId)) {
      throw new NotFoundError(`document ${documentId} not found`);
    }

    let relativePath: string | undefined;
    let id: string | undefined;
    if (options.kind === 'outfit') {
      const row = options.outfitId
        ? this.db.prepare('SELECT id, path FROM outfits WHERE doc_id=? AND id=?').get(documentId, options.outfitId) as Pick<OutfitRow, 'id' | 'path'> | undefined
        : this.db.prepare('SELECT id, path FROM outfits WHERE doc_id=? ORDER BY id LIMIT 1').get(documentId) as Pick<OutfitRow, 'id' | 'path'> | undefined;
      relativePath = row?.path;
      id = row?.id;
    } else {
      const column = options.kind === 'original' ? 'original_path' : 'scan_path';
      const row = options.pageId
        ? this.db.prepare(`SELECT id, ${column} path FROM pages WHERE doc_id=? AND id=?`).get(documentId, options.pageId) as { id: string; path: string } | undefined
        : this.db.prepare(`SELECT id, ${column} path FROM pages WHERE doc_id=? ORDER BY idx LIMIT 1 OFFSET ?`).get(documentId, options.pageIndex ?? 0) as { id: string; path: string } | undefined;
      relativePath = row?.path;
      id = row?.id;
    }

    if (!relativePath || !id) throw new NotFoundError(`${options.kind} file not found for document ${documentId}`);
    const root = path.resolve(this.dataDir);
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new ValidationError('stored file path escapes the data directory');
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new NotFoundError(`stored file ${relativePath} not found`);
    }

    return {
      id,
      relativePath,
      absolutePath,
      mimeType: mimeType(absolutePath),
      bytes: fs.readFileSync(absolutePath),
    };
  }
}

export const mimeType = (filePath: string) => {
  if (filePath.toLowerCase().endsWith('.pdf')) return 'application/pdf';
  if (filePath.toLowerCase().endsWith('.png')) return 'image/png';
  return 'image/jpeg';
};
