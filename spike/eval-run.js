// eval-run.js — 在标注好的 ground-truth 上评估当前 detector(各模式 + auto)
// 用法: node eval-run.js [datasetDir] [--summary] [--mode screen] [--review-candidates]
// 注: iPhone 照片(sips 烘焙)带 Display P3 profile, 浏览器解码时自动转 sRGB;
//     png2mat 不做色彩转换 → 两条路径像素不同 → 检测结果不同(2026-08-18 实测 IMG_4083)。
//     这里解码后做 P3→sRGB, 与手机端/标注工具的浏览器管线对齐。
const cv = require('./opencv.js');
const D = require('./detector.js');
const { decodePng } = require('./png2mat.js');
const { isReviewCandidate, scoreCase, validateGroundTruth } = require('./eval-score.js');
const fs = require('fs');
const path = require('path');

const toLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = v => { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
const P3_TO_SRGB = [
  1.2249401762809462, -0.22494017628094603, 0,
  -0.04205695470968856, 1.0420569547096885, 0,
  -0.019637554590334595, -0.07863604549363978, 1.0982735999842801,
];
function p3ToSrgbData(data) {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const lr = toLin(data[i]), lg = toLin(data[i+1]), lb = toLin(data[i+2]);
    out[i] = toSrgb(P3_TO_SRGB[0]*lr + P3_TO_SRGB[1]*lg + P3_TO_SRGB[2]*lb);
    out[i+1] = toSrgb(P3_TO_SRGB[3]*lr + P3_TO_SRGB[4]*lg + P3_TO_SRGB[5]*lb);
    out[i+2] = toSrgb(P3_TO_SRGB[6]*lr + P3_TO_SRGB[7]*lg + P3_TO_SRGB[8]*lb);
    out[i+3] = 255;
  }
  return out;
}

const cliArgs = process.argv.slice(2);
const modeIndex = cliArgs.indexOf('--mode');
const requestedMode = modeIndex >= 0 ? cliArgs[modeIndex + 1] : null;
const supportedModes = ['auto', 'screen', 'document', 'whiteboard'];
if (requestedMode && !supportedModes.includes(requestedMode)) throw new Error(`--mode must be one of: ${supportedModes.join(', ')}`);
const positional = cliArgs.filter((arg, index) => !arg.startsWith('--') && !(modeIndex >= 0 && index === modeIndex + 1));
const DS = path.resolve(__dirname, positional[0] || 'eval');
const REVIEW_CANDIDATES = cliArgs.includes('--review-candidates');
const SUMMARY_ONLY = cliArgs.includes('--summary') || REVIEW_CANDIDATES;
setTimeout(() => {
  const gt = JSON.parse(fs.readFileSync(path.join(DS, 'ground-truth.json')));
  const modes = requestedMode ? [requestedMode] : REVIEW_CANDIDATES ? ['screen'] : supportedModes;
  const reviewCandidates = [];
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
  if (!SUMMARY_ONLY) console.log('case'.padEnd(22), 'gt模式'.padEnd(10), modes.map(m => m.padEnd(7)).join(''));
  const agg = {}; modes.forEach(m => agg[m] = { sum: 0, n: 0, good: 0, fallbackTotal: 0, fallbackOk: 0, falsePositives: [] });
  for (const [file, g] of Object.entries(gt)) {
    if (!fs.existsSync(path.join(DS, file))) continue;
    validateGroundTruth(file, g);
    const d = decodePng(fs.readFileSync(path.join(DS, file)));
    const m = new cv.Mat(d.H, d.W, cv.CV_8UC4); m.data.set(p3ToSrgbData(d.data));
    const row = [];
    for (const mode of modes) {
      const r = D.detect(cv, m, mode === 'auto' ? {} : { mode });
      const detectedQuad = r.quad ? r.quad.map(p => [p.x, p.y]) : null;
      const scored = scoreCase(g, detectedQuad, polyIoU);
      if (REVIEW_CANDIDATES && isReviewCandidate(g, scored)) {
        reviewCandidates.push({ file, result: scored.include ? scored.score.toFixed(2) : scored.label });
      }
      if (scored.include) {
        agg[mode].sum += scored.score; agg[mode].n++;
        if (scored.good) agg[mode].good++;
      }
      if (scored.fallback) {
        agg[mode].fallbackTotal++;
        if (scored.good) agg[mode].fallbackOk++;
        if (scored.falsePositive) agg[mode].falsePositives.push(file);
      }
      row.push(scored.label.padEnd(7));
    }
    if (!SUMMARY_ONLY) console.log(file.padEnd(22), (g.mode||'?').padEnd(10), row.join(''));
    m.delete();
  }
  console.log('---');
  for (const mode of modes) {
    const a = agg[mode];
    if (a.n) console.log(mode.padEnd(10), 'mIoU=' + (a.sum/a.n).toFixed(3), 'IoU≥0.7: ' + a.good + '/' + a.n,
      a.fallbackTotal ? `expectFallback=${a.fallbackOk}/${a.fallbackTotal} 误检=${a.falsePositives.join(',') || '-'}` : '');
  }
  if (REVIEW_CANDIDATES) {
    const ids = reviewCandidates.map(candidate => candidate.file.replace(/\.(png|jpe?g)$/i, ''));
    console.log(`reviewCandidates(${modes[0]} null or IoU<0.70)=${reviewCandidates.length}`);
    console.log(reviewCandidates.map(candidate => `${candidate.file}:${candidate.result}`).join(' '));
    console.log(`reviewUrl=http://127.0.0.1:8791/#review=${encodeURIComponent(ids.join(','))}`);
    console.log('reviewCandidates are a queue only; do not infer expectFallback without visual confirmation.');
  }
  process.exit(0);
}, 3000);
