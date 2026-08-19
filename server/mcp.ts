import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { OpenLensService } from './service.js';

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

const parseDate = (value: string | undefined, endOfDay = false) => {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = Date.parse(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid date: ${value}`);
  return dateOnly && endOfDay ? timestamp + 86_400_000 - 1 : timestamp;
};

export const createOpenLensMcpServer = (service: OpenLensService) => {
  const server = new McpServer({ name: 'open-lens', version: '0.1.0' });

  server.registerTool('list_documents', {
    description: 'List Open Lens documents, optionally filtering by exact tag, date range, or name/OCR text.',
    inputSchema: z.object({
      tag: z.string().optional(),
      date_from: z.string().optional().describe('Inclusive ISO timestamp or YYYY-MM-DD.'),
      date_to: z.string().optional().describe('Inclusive ISO timestamp or YYYY-MM-DD.'),
      query: z.string().optional().describe('Case-insensitive name, tag, or OCR substring.'),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ tag, date_from, date_to, query }) => textResult({
    documents: service.listDocuments({
      tag,
      dateFrom: parseDate(date_from),
      dateTo: parseDate(date_to, true),
      query,
    }),
  }));

  server.registerTool('get_document', {
    description: 'Get document metadata, ordered pages, file links, and OCR text. Missing OCR is returned as an empty string.',
    inputSchema: z.object({ document_id: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ document_id }) => textResult({ document: service.getDocument(document_id) }));

  server.registerTool('get_file', {
    description: 'Read an Original, Scan, or Outfit file from the authoritative Open Lens archive.',
    inputSchema: z.object({
      document_id: z.string().min(1),
      kind: z.enum(['original', 'scan', 'outfit']),
      page_id: z.string().optional(),
      page_index: z.number().int().min(0).optional(),
      outfit_id: z.string().optional(),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ document_id, kind, page_id, page_index, outfit_id }) => {
    const file = service.getFile(document_id, {
      kind,
      pageId: page_id,
      pageIndex: page_index,
      outfitId: outfit_id,
    });
    const metadata = {
      documentId: document_id,
      id: file.id,
      kind,
      path: file.relativePath,
      mimeType: file.mimeType,
      size: file.bytes.byteLength,
    };
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(metadata) },
        {
          type: 'resource' as const,
          resource: {
            uri: `open-lens://documents/${encodeURIComponent(document_id)}/${kind}/${encodeURIComponent(file.id)}`,
            mimeType: file.mimeType,
            blob: file.bytes.toString('base64'),
          },
        },
      ],
      structuredContent: metadata,
    };
  });

  server.registerTool('rename_document', {
    description: 'Rename an Open Lens document.',
    inputSchema: z.object({ document_id: z.string().min(1), name: z.string().min(1) }),
    annotations: { idempotentHint: true },
  }, async ({ document_id, name }) => textResult(service.updateDocument(document_id, { name })));

  server.registerTool('set_tags', {
    description: 'Replace all tags on an Open Lens document.',
    inputSchema: z.object({ document_id: z.string().min(1), tags: z.array(z.string()) }),
    annotations: { idempotentHint: true },
  }, async ({ document_id, tags }) => textResult(service.updateDocument(document_id, { tags })));

  server.registerTool('reorder_pages', {
    description: 'Replace the page order. page_ids must contain every current page id exactly once.',
    inputSchema: z.object({ document_id: z.string().min(1), page_ids: z.array(z.string()) }),
    annotations: { idempotentHint: true },
  }, async ({ document_id, page_ids }) => textResult(service.updateDocument(document_id, { pageOrder: page_ids })));

  server.registerTool('list_tags', {
    description: 'List all distinct tags in the Open Lens archive.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => textResult({ tags: service.listTags() }));

  return server;
};
