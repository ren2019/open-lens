// Open-Lens server — 归档真相(ADR-002) + 单 token 鉴权(ADR-004)
// 文件落 YYYY/MM/,元数据入 SQLite;应用层只听 HTTP(HTTPS 由 Caddy 终结)
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createOpenLensMcpServer } from './mcp.js';
import { initializeSchema, mimeType, NotFoundError, OpenLensService, ValidationError } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', '.data');
const TOKEN = process.env.OL_TOKEN || 'dev-token'; // 本地验收默认;生产走环境变量

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'openlens.db'));
initializeSchema(db);
const service = new OpenLensService(db, DATA_DIR);

const app = Fastify({ logger: { level: 'warn' } });
app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });
app.setErrorHandler((error, _req, reply) => {
  if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof ValidationError) return reply.code(400).send({ error: error.message });
  return reply.send(error);
});

// CORS(本地 dev: 5173 → 8787;生产同域经 Caddy,此头无害)
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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

app.get('/api/docs', async req => {
  const query = req.query as { tag?: string; dateFrom?: string; dateTo?: string; query?: string };
  return service.listDocuments({
    tag: query.tag,
    dateFrom: query.dateFrom === undefined ? undefined : Number(query.dateFrom),
    dateTo: query.dateTo === undefined ? undefined : Number(query.dateTo),
    query: query.query,
  });
});

app.get('/api/docs/:id', async (req, rep) => {
  const { id } = req.params as any;
  return service.getDocument(id);
});

app.patch('/api/docs/:id', async (req, rep) => {
  const { id } = req.params as any;
  const body = (req.body || {}) as any;
  return service.updateDocument(id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    tags: Array.isArray(body.tags) ? body.tags : undefined,
    pageOrder: Array.isArray(body.pageOrder) ? body.pageOrder : undefined,
  });
});

// Stateless Streamable HTTP MCP;鉴权由上面的 G3 Bearer hook 统一处理。
app.post('/mcp', async (req, reply) => {
  const mcpServer = createOpenLensMcpServer(service);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  reply.raw.on('close', () => {
    void transport.close();
    void mcpServer.close();
  });
  reply.hijack();
  await transport.handleRequest(req.raw, reply.raw, req.body);
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
    // 客户端 payload 是文档当前页集合；移除已删页，避免 upsert-only 留下幽灵页。
    const currentPageIds = new Set((meta.pages || []).map((p: any) => `${meta.id}_${p.id}`));
    const archivedPages = db.prepare('SELECT id FROM pages WHERE doc_id=?').all(meta.id) as { id: string }[];
    const deletePage = db.prepare('DELETE FROM pages WHERE id=?');
    archivedPages.forEach(page => { if (!currentPageIds.has(page.id)) deletePage.run(page.id); });
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
  const root = path.resolve(DATA_DIR);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return rep.code(403).send({ error: 'forbidden' });
  if (!fs.existsSync(abs)) return rep.code(404).send({ error: 'not found' });
  return rep.type(mimeType(abs)).send(fs.createReadStream(abs));
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`[open-lens] http://0.0.0.0:${PORT}  data=${DATA_DIR}  token=${TOKEN === 'dev-token' ? 'dev-token(默认)' : '***'}`);
});
