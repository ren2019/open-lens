// 最小 PNG 解码 → cv.Mat (RGBA)。只支持 8bit RGBA/RGB 无隔行(我们自己的生成器写的图)。
const fs = require('fs'), zlib = require('zlib');
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, W, H, bitDepth, colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos+4, pos+8);
    const data = buf.slice(pos+8, pos+8+len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error('only 8bit');
      if (colorType !== 6 && colorType !== 2) throw new Error('only RGBA/RGB');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  // PNG filters 0-4 (sips 等外部工具会给 filter 1/2/3/4)
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : 3;
  const stride = W * ch;
  const out = Buffer.alloc(W * H * 4);
  let prev = Buffer.alloc(stride);
  const B = (buf, i) => buf[i] | 0;
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride+1)];
    const row = Buffer.from(raw.buffer, raw.byteOffset + y*(stride+1)+1, stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x-ch] : 0;          // left
      const b = prev[x];                            // up
      const c = x >= ch ? prev[x-ch] : 0;           // up-left
      let v = row[x];
      switch (f) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: { // Paeth
          const p = a + b - c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          cur[x] = (v + pr) & 0xff; break;
        }
        default: throw new Error('filter type ' + f + ' unsupported');
      }
    }
    for (let x = 0; x < W; x++) {
      const o = (y*W+x)*4, s = x*ch;
      out[o] = cur[s]; out[o+1] = cur[s+1]; out[o+2] = cur[s+2]; out[o+3] = ch===4 ? cur[s+3] : 255;
    }
    prev = cur;
  }
  return { W, H, data: out };
}
module.exports = { decodePng };
