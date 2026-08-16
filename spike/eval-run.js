// eval-run.js — 在标注好的 ground-truth 上评估当前 detector(各模式 + auto)
// 用法: node eval-run.js
const cv = require('./opencv.js');
const D = require('./detector.js');
const { decodePng } = require('./png2mat.js');
const fs = require('fs');
setTimeout(() => {
  const gt = JSON.parse(fs.readFileSync('eval/ground-truth.json'));
  const modes = ['auto', 'screen', 'document', 'whiteboard'];
  // IoU(交并比): 标注 quad 与检测 quad 的多边形 IoU
  function polyIoU(a, b) {
    // 用栅格化近似(500x500 够判档)
    const S = 400;
    const norm = q => q.map(p => [p[0] / W * S, p[1] / H * S]);
    const W = Math.max(...a.concat(b).map(p => p[0])) + 1, H = Math.max(...a.concat(b).map(p => p[1])) + 1;
    const raster = q => {
      const g = new Uint8Array(S * S);
      const pts = norm(q);
      // 扫描线填充
      for (let y = 0; y < S; y++) {
        const xs = [];
        for (let i = 0; i < 4; i++) {
          const [x1,y1] = pts[i], [x2,y2] = pts[(i+1)%4];
          if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
        }
        xs.sort((p,q2)=>p-q2);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(S-1, Math.floor(xs[k+1])); x++) g[y*S+x] = 1;
      }
      return g;
    };
    const ga = raster(a), gb = raster(b);
    let inter = 0, union = 0;
    for (let i = 0; i < S*S; i++) { if (ga[i] & gb[i]) inter++; if (ga[i] | gb[i]) union++; }
    return union ? inter / union : 0;
  }
  console.log('case'.padEnd(22), 'gt模式'.padEnd(10), modes.map(m => m.padEnd(7)).join(''));
  const agg = {}; modes.forEach(m => agg[m] = { sum: 0, n: 0, good: 0 });
  for (const [file, g] of Object.entries(gt)) {
    if (!fs.existsSync('eval/' + file)) continue;
    const d = decodePng(fs.readFileSync('eval/' + file));
    const m = new cv.Mat(d.H, d.W, cv.CV_8UC4); m.data.set(d.data);
    const row = [];
    for (const mode of modes) {
      const r = D.detect(cv, m, mode === 'auto' ? {} : { mode });
      let iou = '-';
      if (g.noTarget) iou = r.quad ? '误检' : '✓null';
      else if (r.quad && g.quad) {
        const v = polyIoU(g.quad, r.quad.map(p => [p.x, p.y]));
        iou = v.toFixed(2);
        agg[mode].sum += v; agg[mode].n++;
        if (v >= 0.7) agg[mode].good++;
      } else iou = 'null';
      row.push(iou.padEnd(7));
    }
    console.log(file.padEnd(22), (g.mode||'?').padEnd(10), row.join(''));
    m.delete();
  }
  console.log('---');
  for (const mode of modes) {
    const a = agg[mode];
    if (a.n) console.log(mode.padEnd(10), 'mIoU=' + (a.sum/a.n).toFixed(3), 'IoU≥0.7: ' + a.good + '/' + a.n);
  }
  process.exit(0);
}, 3000);
