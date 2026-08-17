// prepare-photos.js — photos-batch ingest: heic→jpeg、raw→label PNG(长边1000)、manifest
// 幂等,可反复跑。用法: node prepare-photos.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BATCH = path.join(ROOT, 'photos-batch');
const RAW = path.join(BATCH, 'raw');
const LABEL = path.join(BATCH, 'label');
const MANIFEST = path.join(BATCH, 'manifest.json');

for (const d of [RAW, LABEL, path.join(BATCH, 'outputs')]) fs.mkdirSync(d, { recursive: true });

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

// sips -Z 缩放的是长边; 转出 PNG 前先把方向烘焙正向(sips 默认按 EXIF 摆正)
function dims(f) {
  const out = sh('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f]);
  const w = +(/pixelWidth: (\d+)/.exec(out)[1]);
  const h = +(/pixelHeight: (\d+)/.exec(out)[1]);
  return { w, h };
}

const raws = fs.readdirSync(RAW).filter(f => /\.(heic|jpe?g|png)$/i.test(f));
let heicConverted = 0, pngMade = 0;

// ① heic → 同名 jpg(显式 --out; heic 原地保留, 工具侧只认 jpg)
for (const f of raws) {
  if (!/\.heic$/i.test(f)) continue;
  const base = f.replace(/\.[^.]+$/, '');
  const jpg = path.join(RAW, base + '.jpg');
  if (!fs.existsSync(jpg)) {
    sh('sips', ['-s', 'format', 'jpeg', path.join(RAW, f), '--out', jpg]);
    heicConverted++;
    console.log('[heic→jpg]', f, '→', base + '.jpg');
  }
}

const jpgs = fs.readdirSync(RAW).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
for (const f of jpgs) {
  const base = f.replace(/\.[^.]+$/, '');
  const png = path.join(LABEL, base + '.png');
  // ② 缺失的 label PNG
  if (!fs.existsSync(png)) {
    sh('sips', ['-Z', '1000', '-s', 'format', 'png', path.join(RAW, f), '--out', png]);
    pngMade++;
  }
  // ③ manifest
  const m = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const { w, h } = dims(path.join(RAW, f));
  m[f] = { w, h, bytes: fs.statSync(path.join(RAW, f)).size };
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

console.log(`\nraw: ${jpgs.length} 张 jpg (转换 heic ${heicConverted}), 新建 label PNG ${pngMade}, manifest 已更新`);
console.log('下一步: node spike/batch-server.js → http://localhost:8791');
