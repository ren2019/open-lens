// E2E(US-D9): EXIF orientation parsing stays inside the containing JPEG/PNG payload.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { orientedDimensions, readExifOrientation } = require('../image-orientation.js');
const scratch = await mkdtemp(join(tmpdir(), 'open-lens-orientation-e2e-'));
let failures = 0;
let checks = 0;

function check(name, condition, extra = '') {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  US-D9: ${name}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
}

function tiffHeader(ifdOffset) {
  const bytes = Buffer.alloc(8);
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(ifdOffset, 4);
  return bytes;
}

function orientationIfd(orientation) {
  const bytes = Buffer.alloc(18);
  bytes.writeUInt16LE(1, 0);
  bytes.writeUInt16LE(0x0112, 2);
  bytes.writeUInt16LE(3, 4);
  bytes.writeUInt32LE(1, 6);
  bytes.writeUInt16LE(orientation, 10);
  return bytes;
}

function truncatedIfdAfterOrientation() {
  const bytes = orientationIfd(6).subarray(0, 14);
  bytes.writeUInt16LE(2, 0);
  return bytes;
}

function headerOverlapTiff() {
  const bytes = Buffer.alloc(2 + 2 + 42 * 12 + 4);
  bytes.write('II', 0, 'ascii');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(2, 4);
  const orientationEntry = 2 + 2 + 12;
  bytes.writeUInt16LE(0x0112, orientationEntry);
  bytes.writeUInt16LE(3, orientationEntry + 2);
  bytes.writeUInt32LE(1, orientationEntry + 4);
  bytes.writeUInt16LE(6, orientationEntry + 8);
  return bytes;
}

function jpegCrossSegmentOrientation() {
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiffHeader(12)]);
  const app2Payload = orientationIfd(6);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, app1Payload.length + 2]),
    app1Payload,
    Buffer.from([0xff, 0xe2, 0x00, app2Payload.length + 2]),
    app2Payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function jpegOrientation(orientation) {
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    tiffHeader(8),
    orientationIfd(orientation),
  ]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, payload, Buffer.from([0xff, 0xd9])]);
}

function jpegTruncatedIfdTable() {
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    tiffHeader(8),
    truncatedIfdAfterOrientation(),
  ]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, payload, Buffer.from([0xff, 0xd9])]);
}

function jpegHeaderOverlap() {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), headerOverlapTiff()]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, payload, Buffer.from([0xff, 0xd9])]);
}

function pngChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function pngCrossChunkOrientation() {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('eXIf', tiffHeader(20)),
    pngChunk('tEXt', orientationIfd(6)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngTruncatedIfdTable() {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('eXIf', Buffer.concat([tiffHeader(8), truncatedIfdAfterOrientation()])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngHeaderOverlap() {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('eXIf', headerOverlapTiff()),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function rejectsMalformedPayload(name, bytes, expectation = 'TIFF offset 不得跨越所属 payload') {
  const file = join(scratch, name);
  await writeFile(file, bytes);
  let error;
  try { readExifOrientation(file); }
  catch (caught) { error = caught; }
  check(`${name} 的 ${expectation}`, error instanceof Error, error?.message || 'accepted');
}

try {
  await rejectsMalformedPayload('cross-segment.jpg', jpegCrossSegmentOrientation());
  await rejectsMalformedPayload('cross-chunk.png', pngCrossChunkOrientation());
  await rejectsMalformedPayload('truncated-ifd-table.jpg', jpegTruncatedIfdTable());
  await rejectsMalformedPayload('truncated-ifd-table.png', pngTruncatedIfdTable());
  await rejectsMalformedPayload('header-overlap.jpg', jpegHeaderOverlap(), '首个 IFD 不得与 TIFF header 重叠');
  await rejectsMalformedPayload('header-overlap.png', pngHeaderOverlap(), '首个 IFD 不得与 TIFF header 重叠');
  const supported = [];
  const refused = [];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const file = join(scratch, `orientation-${orientation}.jpg`);
    await writeFile(file, jpegOrientation(orientation));
    try {
      const parsed = readExifOrientation(file);
      orientedDimensions(1200, 1800, parsed);
      supported.push(parsed);
    } catch (error) {
      if (error instanceof Error && error.message.includes('unsupported EXIF orientation')) refused.push(orientation);
    }
  }
  check('实际 EXIF metadata 仅允许已完整验证的 orientation=1/6',
    JSON.stringify(supported) === '[1,6]' && JSON.stringify(refused) === '[2,3,4,5,7,8]',
    `supported=${JSON.stringify(supported)} refused=${JSON.stringify(refused)}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(failures ? `ORIENTATION E2E DONE (${failures}/${checks} FAILED)` : `ORIENTATION E2E DONE (${checks}/${checks} PASS)`);
process.exit(failures ? 1 : 0);
