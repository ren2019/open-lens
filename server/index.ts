// Open-Lens server — 归档真相(ADR-002) + 单 token 鉴权(ADR-004)
// 文件落 YYYY/MM/,元数据入 SQLite;应用层只听 HTTP(HTTPS 由 Caddy 终结)
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', '.data');
const TOKEN = process.env.OL_TOKEN || 'dev-token'; // 本地验收默认;生产走环境变量

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'openlens.db'));
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

const app = Fastify({ logger: { level: 'warn' } });
app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });

// CORS(本地 dev: 5173 → 8787;生产同域经 Caddy,此头无害)
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return reply.send();
});

// token 中间件(静态文件除外)
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/files/')) return; // 裸读文件夹已由 ADR-002 批准(单用户)
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

const monthDir = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};

app.get('/api/docs', async () => {
  const docs = db.prepare('SELECT * FROM docs ORDER BY created_at DESC').all() as any[];
  return docs.map(d => ({
    id: d.id, name: d.name, createdAt: d.created_at, tags: JSON.parse(d.tags),
    pageCount: (db.prepare('SELECT COUNT(*) c FROM pages WHERE doc_id=?').get(d.id) as any).c,
    outfits: (db.prepare('SELECT id, kind FROM outfits WHERE doc_id=?').all(d.id) as any[]),
  }));
});

app.get('/api/docs/:id', async (req, rep) => {
  const { id } = req.params as any;
  const d = db.prepare('SELECT * FROM docs WHERE id=?').get(id) as any;
  if (!d) return rep.code(404).send({ error: 'not found' });
  const pages = db.prepare('SELECT id, idx, quad, enhancement, rotation, ocr, original_path, scan_path FROM pages WHERE doc_id=? ORDER BY idx').all(id) as any[];
  const outfits = db.prepare('SELECT id, kind, path FROM outfits WHERE doc_id=?').all(id) as any[];
  return {
    id: d.id, name: d.name, createdAt: d.created_at, tags: JSON.parse(d.tags),
    pages: pages.map(p => ({
      id: p.id, quad: JSON.parse(p.quad), enhancement: p.enhancement, rotation: p.rotation,
      ocr: p.ocr ?? '', // OCR 占位: 无值返回空串不报错(ADR-005)
      original: '/files/' + p.original_path, scan: '/files/' + p.scan_path,
    })),
    outfits: outfits.map(o => ({ id: o.id, kind: o.kind, file: '/files/' + o.path })),
  };
});

// 归档上传: meta + original_N + scan_N + outfit_N
app.post('/api/docs', async (req, rep) => {
  const parts = req.parts();
  let meta: any = null;
  const files: { field: string; buf: Buffer; name: string }[] = [];
  for await (const part of parts) {
    if (part.type === 'file') {
      files.push({ field: part.fieldname, buf: await part.toBuffer(), name: part.filename });
    } else if (part.fieldname === 'meta') {
      meta = JSON.parse(String(part.value));
    }
  }
  if (!meta || !meta.id) return rep.code(400).send({ error: 'meta missing' });

  const dir = monthDir(meta.createdAt || Date.now());
  const abs = path.join(DATA_DIR, dir, meta.id);
  fs.mkdirSync(abs, { recursive: true });

  const save = (name: string, buf: Buffer) => {
    fs.writeFileSync(path.join(abs, name), buf);
    return `${dir}/${meta.id}/${name}`;
  };

  const upsertDoc = db.prepare(`
    INSERT INTO docs (id, name, created_at, tags) VALUES (@id, @name, @created_at, @tags)
    ON CONFLICT(id) DO UPDATE SET name=@name, tags=@tags
  `);
  const upsertPage = db.prepare(`
    INSERT INTO pages (id, doc_id, idx, quad, enhancement, rotation, original_path, scan_path)
    VALUES (@id, @doc_id, @idx, @quad, @enhancement, @rotation, @original_path, @scan_path)
    ON CONFLICT(id) DO UPDATE SET
      idx=@idx, quad=@quad, enhancement=@enhancement, rotation=@rotation,
      original_path=@original_path, scan_path=@scan_path
  `);

  db.transaction(() => {
    upsertDoc.run({ id: meta.id, name: meta.name, created_at: meta.createdAt || Date.now(), tags: JSON.stringify(meta.tags || []) });
    (meta.pages || []).forEach((p: any, i: number) => {
      const original = files.find(f => f.field === `original_${i}`);
      const scan = files.find(f => f.field === `scan_${i}`);
      const originalPath = original ? save(`original_${i}.jpg`, original.buf) : 'missing';
      const scanPath = scan ? save(`scan_${i}.jpg`, scan.buf) : 'missing';
      upsertPage.run({
        id: `${meta.id}_${p.id}`, doc_id: meta.id, idx: i,
        quad: JSON.stringify(p.quad), enhancement: p.enhancement || 'original',
        rotation: p.rotation || 0, original_path: originalPath, scan_path: scanPath,
      });
    });
    // 客户端可能在响应丢失后整条重传:沿用稳定 Outfit id/path,重复请求只覆盖不增生。
    const outfitFiles = files.filter(f => f.field.startsWith('outfit_'))
      .sort((a, b) => Number(a.field.slice(7)) - Number(b.field.slice(7)));
    const outfitMeta = meta.outfits?.length ? meta.outfits : outfitFiles.map((f, i) => ({
      id: `legacy_${i}`,
      kind: f.name.endsWith('.pdf') ? 'pdf' : 'image',
      ext: f.name.endsWith('.pdf') ? 'pdf' : 'jpg',
    }));
    outfitMeta.forEach((o: any, i: number) => {
      const f = files.find(file => file.field === `outfit_${i}`);
      if (!f) return;
      const ext = o.ext === 'pdf' || f.name.endsWith('.pdf') ? 'pdf' : 'jpg';
      const outfitId = `${meta.id}_${o.id}`;
      const p = save(`outfit_${i}.${ext}`, f.buf);
      db.prepare('INSERT OR REPLACE INTO outfits (id, doc_id, kind, path) VALUES (?, ?, ?, ?)')
        .run(outfitId, meta.id, o.kind || (ext === 'pdf' ? 'pdf' : 'image'), p);
    });
  })();

  return { ok: true, id: meta.id, path: dir + '/' + meta.id };
});

app.delete('/api/docs/:id', async (req, rep) => {
  const { id } = req.params as any;
  db.prepare('DELETE FROM docs WHERE id=?').run(id);
  const dir = path.join(DATA_DIR, monthDir(Date.now()));
  // 文件可能跨月;直接按 id 扫两年窗口(单用户量小)
  for (let y = new Date().getFullYear() - 1; y <= new Date().getFullYear() + 1; y++) {
    for (let m = 1; m <= 12; m++) {
      const p = path.join(DATA_DIR, String(y), String(m).padStart(2, '0'), id);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  return { ok: true };
});

// 裸文件(ADR-002: 任何 agent 工具不经 server 也可读)
app.get('/files/*', async (req, rep) => {
  const rel = (req.params as any)['*'];
  const abs = path.resolve(DATA_DIR, rel);
  if (!abs.startsWith(path.resolve(DATA_DIR))) return rep.code(403).send({ error: 'forbidden' });
  if (!fs.existsSync(abs)) return rep.code(404).send({ error: 'not found' });
  return rep.sendFile ? rep.sendFile(abs) : rep.type(mime(abs)).send(fs.createReadStream(abs));
});
function mime(p: string) {
  if (p.endsWith('.pdf')) return 'application/pdf';
  if (p.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`[open-lens] http://0.0.0.0:${PORT}  data=${DATA_DIR}  token=${TOKEN === 'dev-token' ? 'dev-token(默认)' : '***'}`);
});
