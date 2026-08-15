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
  // filter 0 only (our generator)——但 zlib 可能给 filter!=0? 我们写的是全 0
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : 3;
  const stride = W * ch;
  const out = Buffer.alloc(W * H * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride+1)];
    if (f !== 0) throw new Error('filter type ' + f + ' unsupported');
    const row = raw.slice(y*(stride+1)+1, y*(stride+1)+1+stride);
    for (let x = 0; x < W; x++) {
      const o = (y*W+x)*4, s = x*ch;
      out[o] = row[s]; out[o+1] = row[s+1]; out[o+2] = row[s+2]; out[o+3] = ch===4 ? row[s+3] : 255;
    }
    prev = row;
  }
  return { W, H, data: out };
}
module.exports = { decodePng };
