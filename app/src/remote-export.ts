import type { RemoteDocDetail } from './types';

type RemoteExportKind = 'image' | 'long' | 'pdf';

function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Open-Lens';
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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

export async function exportRemoteDoc(
  doc: RemoteDocDetail,
  kind: RemoteExportKind,
  pageIndex: number,
  fileUrl: (path: string) => string,
) {
  const name = safeName(doc.name);
  if (kind === 'image') {
    const page = doc.pages[pageIndex];
    if (!page) throw new Error('remote page missing');
    downloadBlob(await fetchBlob(fileUrl(page.scan)), `${name}-${pageIndex + 1}.jpg`);
    return;
  }

  const ready = doc.outfits.find(outfit => outfit.kind === kind);
  if (ready) {
    downloadBlob(await fetchBlob(fileUrl(ready.file)), `${name}.${kind === 'pdf' ? 'pdf' : 'jpg'}`);
    return;
  }

  const scans = await remoteScans(doc, fileUrl);
  const blob = kind === 'pdf' ? await buildPdf(scans) : await buildLongImage(scans);
  downloadBlob(blob, `${name}.${kind === 'pdf' ? 'pdf' : 'jpg'}`);
}
