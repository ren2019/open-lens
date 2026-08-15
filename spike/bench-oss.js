// OSS 移植版 detector 基准(修正配对:truth 也用同样的 [tl,tr,br,bl] 语义)
const cv = require('./opencv.js');
const OSSDetector = require('./detector.js');
const { decodePng } = require('./png2mat.js');
const fs = require('fs');
setTimeout(() => {
  const results = [];
  function loadMat(p) {
    const d = decodePng(fs.readFileSync(p));
    const mat = new cv.Mat(d.H, d.W, cv.CV_8UC4);
    mat.data.set(d.data);
    return mat;
  }
  // 与 detector.sortPoints 相同: y 排序 → 上半 x 升 / 下半 x 降 → [tl,tr,br,bl]
  function canon(q) {
    const p = q.map(x => ({x: x[0] !== undefined ? x[0] : x.x, y: x[1] !== undefined ? x[1] : x.y}));
    p.sort((a,b) => a.y - b.y);
    const top = p.slice(0,2).sort((a,b) => a.x - b.x);
    const bot = p.slice(2).sort((a,b) => b.x - a.x);
    return [top[0], top[1], bot[0], bot[1]];
  }
  function evalCase(file, truth) {
    const mat = loadMat(file);
    const r = OSSDetector.detect(cv, mat);
    let verdict = 'MISS', err = '';
    if (r.quad) {
      const t = canon(truth), q = canon(r.quad);
      let sum = 0;
      for (let i=0;i<4;i++) sum += Math.hypot(t[i].x-q[i].x, t[i].y-q[i].y);
      const e = sum/4/mat.cols;
      verdict = e < 0.03 ? 'HIT' : (e < 0.08 ? 'TWEAK' : 'MISS');
      err = (e*100).toFixed(1)+'%';
    }
    results.push(verdict);
    console.log(file.replace('photos/','').padEnd(30), verdict.padEnd(6), err.padStart(6), Math.round(r.ms)+'ms', 'iters='+r.iterations, 'squares='+r.squares);
    mat.delete();
  }

  evalCase('photos/01-ideal-whiteboard.png',      [[200,150],[1400,150],[1400,1050],[200,1050]]);
  evalCase('photos/02-perspective-whiteboard.png',[[380,70],[1530,235],[1290,1120],[235,985]]);
  evalCase('photos/03-faint-ink-lowcontrast.png', [[250,200],[1350,200],[1350,1050],[250,1050]]);
  evalCase('photos/04-cluttered-background.png',  [[180,140],[1420,140],[1420,1060],[180,1060]]);
  evalCase('photos/06-glare-patch.png',           [[200,150],[1400,150],[1400,1050],[200,1050]]);

  const ok = results.filter(v=>v!=='MISS').length;
  console.log('---');
  console.log(`OSS port: HIT+TWEAK ${ok}/${results.length}`);
  process.exit(0);
}, 3000);
