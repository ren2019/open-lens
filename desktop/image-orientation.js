const fs = require('fs');
const SUPPORTED_ORIENTATIONS = new Set([1, 6]);

function assertSupportedOrientation(orientation) {
  if (!Number.isInteger(orientation) || !SUPPORTED_ORIENTATIONS.has(orientation)) {
    throw new Error(`unsupported EXIF orientation: ${orientation}`);
  }
  return orientation;
}

function tiffOrientation(buffer, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > buffer.length || start > end) {
    throw new Error('invalid EXIF TIFF payload bounds');
  }
  const requireRange = (offset, size, message) => {
    if (offset < start || size < 0 || offset + size > end) throw new Error(message);
  };
  requireRange(start, 8, 'truncated EXIF TIFF header');
  const byteOrder = buffer.toString('ascii', start, start + 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') throw new Error(`invalid EXIF byte order: ${byteOrder}`);
  const littleEndian = byteOrder === 'II';
  const u16 = offset => {
    requireRange(offset, 2, 'truncated EXIF TIFF value');
    return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  };
  const u32 = offset => {
    requireRange(offset, 4, 'truncated EXIF TIFF value');
    return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  };
  if (u16(start + 2) !== 42) throw new Error('invalid EXIF TIFF marker');
  const ifd = start + u32(start + 4);
  requireRange(ifd, 2, 'truncated EXIF IFD');
  const entries = u16(ifd);
  requireRange(ifd, 2 + entries * 12 + 4, 'truncated EXIF IFD table');
  for (let index = 0; index < entries; index++) {
    const entry = ifd + 2 + index * 12;
    requireRange(entry, 12, 'truncated EXIF IFD entry');
    if (u16(entry) !== 0x0112) continue;
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) throw new Error('invalid EXIF orientation field');
    return assertSupportedOrientation(u16(entry + 8));
  }
  return 1;
}

function jpegOrientation(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('invalid JPEG marker');
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) throw new Error('truncated JPEG segment');
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error('invalid JPEG segment length');
    const data = offset + 2;
    if (marker === 0xe1 && length >= 8 && buffer.toString('ascii', data, data + 6) === 'Exif\0\0') {
      return tiffOrientation(buffer, data + 6, offset + length);
    }
    offset += length;
  }
  return 1;
}

function pngOrientation(buffer) {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = offset + 8;
    if (data + length + 4 > buffer.length) throw new Error('invalid PNG chunk length');
    if (type === 'eXIf') {
      const tiffStart = buffer.toString('ascii', data, data + 6) === 'Exif\0\0' ? data + 6 : data;
      return tiffOrientation(buffer, tiffStart, data + length);
    }
    if (type === 'IEND') break;
    offset = data + length + 4;
  }
  return 1;
}

function readExifOrientationBuffer(buffer, source = 'buffer') {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return jpegOrientation(buffer);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return pngOrientation(buffer);
  }
  throw new Error(`unsupported image format: ${source}`);
}

function readExifOrientation(file) {
  return readExifOrientationBuffer(fs.readFileSync(file), file);
}

function orientedDimensions(width, height, orientation) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(`invalid stored dimensions: ${width}x${height}`);
  }
  assertSupportedOrientation(orientation);
  return orientation === 6
    ? { width: height, height: width }
    : { width, height };
}

module.exports = { orientedDimensions, readExifOrientation, readExifOrientationBuffer };
