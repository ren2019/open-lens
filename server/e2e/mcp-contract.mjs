import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const token = 'mcp-contract-token';
const auth = { Authorization: `Bearer ${token}` };
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-lens-mcp-'));
let child;
let client;
let checks = 0;

const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

const waitForServer = async url => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/docs`, { headers: auth });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for isolated server');
};

const jsonResult = result => {
  check(result.isError !== true, 'MCP tool call must succeed');
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find(block => block.type === 'text')?.text;
  return JSON.parse(text);
};

try {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  child = spawn(path.join(serverDir, 'node_modules/.bin/tsx'), ['index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(tempRoot, 'data'), OL_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  await waitForServer(base);

  const missingAuth = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const wrongAuth = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}',
  });
  check(missingAuth.status === 401, 'MCP must reject a missing token');
  check(wrongAuth.status === 401, 'MCP must reject a wrong token');

  const createdAt = Date.parse('2026-08-20T08:00:00.000Z');
  const documentId = 'mcp-contract-doc';
  const original0 = Buffer.from('original-page-zero');
  const original1 = Buffer.from('original-page-one');
  const scan0 = Buffer.from('scan-page-zero');
  const scan1 = Buffer.from('scan-page-one');
  const outfit = Buffer.from('%PDF-open-lens-contract');
  const form = new FormData();
  form.append('meta', JSON.stringify({
    id: documentId,
    name: 'Physics Board',
    createdAt,
    tags: ['classroom', 'physics'],
    pages: [
      { id: 'p0', quad: [[0, 0], [1, 0], [1, 1], [0, 1]], enhancement: 'original' },
      { id: 'p1', quad: [[0, 0], [1, 0], [1, 1], [0, 1]], enhancement: 'document' },
    ],
    outfits: [{ id: 'pdf', kind: 'pdf', ext: 'pdf' }],
  }));
  form.append('original_0', new Blob([original0], { type: 'image/jpeg' }), 'original-0.jpg');
  form.append('scan_0', new Blob([scan0], { type: 'image/jpeg' }), 'scan-0.jpg');
  form.append('original_1', new Blob([original1], { type: 'image/jpeg' }), 'original-1.jpg');
  form.append('scan_1', new Blob([scan1], { type: 'image/jpeg' }), 'scan-1.jpg');
  form.append('outfit_0', new Blob([outfit], { type: 'application/pdf' }), 'outfit.pdf');
  const seeded = await fetch(`${base}/api/docs`, { method: 'POST', headers: auth, body: form });
  check(seeded.status === 200, `REST seed must succeed, got ${seeded.status}`);

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: auth },
  });
  client = new Client({ name: 'open-lens-contract', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map(tool => tool.name).sort();
  check(toolNames.join(',') === [
    'get_document', 'get_file', 'list_documents', 'list_tags',
    'rename_document', 'reorder_pages', 'set_tags',
  ].sort().join(','), 'MCP must advertise the complete I1-I3 tool surface');

  const listed = jsonResult(await client.callTool({
    name: 'list_documents',
    arguments: { tag: 'classroom', date_from: '2026-08-20', date_to: '2026-08-20', query: 'physics' },
  }));
  check(listed.documents.length === 1 && listed.documents[0].id === documentId, 'I1 combined filters must find the document');
  const excluded = jsonResult(await client.callTool({
    name: 'list_documents', arguments: { date_from: '2026-08-21' },
  }));
  check(excluded.documents.length === 0, 'I1 date filter must exclude out-of-range documents');

  const detailResult = jsonResult(await client.callTool({
    name: 'get_document', arguments: { document_id: documentId },
  }));
  const originalOrder = detailResult.document.pages.map(page => page.id);
  check(detailResult.document.pages.every(page => page.ocr === ''), 'I1 null OCR must be returned as an empty string');
  check(originalOrder.length === 2, 'I2 detail must include ordered pages');

  const originalResult = await client.callTool({
    name: 'get_file', arguments: { document_id: documentId, kind: 'original', page_index: 0 },
  });
  const originalResource = originalResult.content.find(block => block.type === 'resource');
  check(originalResource?.resource?.blob !== undefined, 'I2 Original must be returned as an embedded resource');
  check(Buffer.from(originalResource.resource.blob, 'base64').equals(original0), 'I2 Original bytes must round-trip exactly');

  const outfitResult = await client.callTool({
    name: 'get_file', arguments: { document_id: documentId, kind: 'outfit' },
  });
  const outfitResource = outfitResult.content.find(block => block.type === 'resource');
  check(outfitResource?.resource?.mimeType === 'application/pdf', 'I2 Outfit must preserve its MIME type');
  check(Buffer.from(outfitResource.resource.blob, 'base64').equals(outfit), 'I2 Outfit bytes must round-trip exactly');

  jsonResult(await client.callTool({
    name: 'rename_document', arguments: { document_id: documentId, name: 'Physics Week 1' },
  }));
  jsonResult(await client.callTool({
    name: 'set_tags', arguments: { document_id: documentId, tags: ['reviewed', 'physics', 'reviewed'] },
  }));
  jsonResult(await client.callTool({
    name: 'reorder_pages', arguments: { document_id: documentId, page_ids: [...originalOrder].reverse() },
  }));

  const restDetailResponse = await fetch(`${base}/api/docs/${documentId}`, { headers: auth });
  const restDetail = await restDetailResponse.json();
  check(restDetailResponse.ok, 'REST detail must remain readable after MCP writes');
  check(restDetail.name === 'Physics Week 1', 'MCP rename must be visible through the phone REST service');
  check(restDetail.tags.join(',') === 'reviewed,physics', 'MCP tags must be normalized and visible through REST');
  check(restDetail.pages.map(page => page.id).join(',') === [...originalOrder].reverse().join(','), 'MCP page order must be visible through REST');

  const tags = jsonResult(await client.callTool({ name: 'list_tags', arguments: {} }));
  check(tags.tags.join(',') === 'physics,reviewed', 'list_tags must reflect MCP organization writes');

  const invalidOrder = await client.callTool({
    name: 'reorder_pages', arguments: { document_id: documentId, page_ids: [originalOrder[0]] },
  });
  check(invalidOrder.isError === true, 'I3 must reject a partial page permutation');

  console.log(`[mcp-contract] PASS ${checks} checks; tools=${toolNames.length}; REST/MCP shared-state verified`);
} catch (error) {
  console.error('[mcp-contract] FAIL', error);
  throw error;
} finally {
  if (client) await client.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
