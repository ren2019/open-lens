import type { RemoteDocDetail } from './types';
import { downloadFile } from './file-share';

type RemoteExportKind = 'image' | 'long' | 'pdf';

function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Open-Lens';
}

async function fetchBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`remote file returned ${response.status}`);
  return await response.blob();
}

async function remoteScans(doc: RemoteDocDetail, fileUrl: (path: string) => string) {
  return await Promise.all(doc.pages.map(page => fetchBlob(fileUrl(page.scan))));
}

async function blobImage(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  return { image: bitmap, width: bitmap.width, height: bitmap.height };
}

async function buildLongImage(blobs: Blob[]) {
  const images = await Promise.all(blobs.map(blobImage));
  const width = Math.min(1600, ...images.map(image => image.width));
  const heights = images.map(image => Math.round(image.height * width / image.width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = heights.reduce((sum, height) => sum + height, 0);
  const context = canvas.getContext('2d', { colorSpace: 'srgb' })!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  images.forEach((image, index) => {
    context.drawImage(image.image, 0, y, width, heights[index]);
    image.image.close();
    y += heights[index];
  });
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('long image encode failed')),
    'image/jpeg', 0.9,
  ));
}

async function buildPdf(blobs: Blob[]) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const blob of blobs) {
    const image = await pdf.embedJpg(await blob.arrayBuffer());
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

export async function prepareRemoteExport(
  doc: RemoteDocDetail,
  kind: RemoteExportKind,
  pageIndex: number,
  fileUrl: (path: string) => string,
): Promise<{ blob: Blob; name: string }> {
  const name = safeName(doc.name);
  if (kind === 'image') {
    const page = doc.pages[pageIndex];
    if (!page) throw new Error('remote page missing');
    return { blob: await fetchBlob(fileUrl(page.scan)), name: `${name}-${pageIndex + 1}.jpg` };
  }

  const ready = doc.outfits.find(outfit => outfit.kind === kind);
  if (ready) return { blob: await fetchBlob(fileUrl(ready.file)), name: `${name}.${kind === 'pdf' ? 'pdf' : 'jpg'}` };

  const scans = await remoteScans(doc, fileUrl);
  const blob = kind === 'pdf' ? await buildPdf(scans) : await buildLongImage(scans);
  return { blob, name: `${name}.${kind === 'pdf' ? 'pdf' : 'jpg'}` };
}

export async function exportRemoteDoc(
  doc: RemoteDocDetail,
  kind: RemoteExportKind,
  pageIndex: number,
  fileUrl: (path: string) => string,
) {
  const { blob, name } = await prepareRemoteExport(doc, kind, pageIndex, fileUrl);
  downloadFile(blob, name);
}
