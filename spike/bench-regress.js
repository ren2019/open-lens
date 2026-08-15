// 回归: 9 张真图, JS v2 detector, 对照 truth.json 的 expect
const cv = require('./opencv.js');
const OSSDetector = require('./detector.js');
const { decodePng } = require('./png2mat.js');
const fs = require('fs');
const truth = JSON.parse(fs.readFileSync('photos/regress/truth.json')).cases;
const mode = process.argv[2] || 'v2'; // v2 | upstream
setTimeout(() => {
  function loadMat(p) {
    const d = decodePng(fs.readFileSync(p));
    const mat = new cv.Mat(d.H, d.W, cv.CV_8UC4);
    mat.data.set(d.data);
    return mat;
  }
  function canon(q) {
    const p = q.map(x => ({x: x[0] !== undefined ? x[0] : x.x, y: x[1] !== undefined ? x[1] : x.y}));
    p.sort((a,b) => a.y - b.y);
    const top = p.slice(0,2).sort((a,b) => a.x - b.x);
    const bot = p.slice(2).sort((a,b) => b.x - a.x);
    return [top[0], top[1], bot[0], bot[1]];
  }
  let pass = 0, total = 0, unknown = 0;
  for (const [name, c] of Object.entries(truth)) {
    const mat = loadMat(c.file);
    const r = OSSDetector.detect(cv, mat, mode === 'upstream' ? { v2Score: false, otsuPass: false } : {});
    mat.delete();
    total++;
    let verdict;
    if (c.expect === 'UNKNOWN') { verdict = 'UNKNOWN'; unknown++; }
    else if (c.expect === 'HIT') verdict = r.quad ? 'HIT' : 'MISS';
    else if (c.expect === 'MISS') {
      if (!c.quad) { verdict = r.quad ? 'IMPROVED?' : 'MISS'; }
      else verdict = r.quad ? 'CHECK' : 'MISS';
    }
    if (verdict === 'HIT' || (verdict === 'IMPROVED?')) pass++;
    console.log(name.padEnd(12), (verdict||'?').padEnd(9), 'expect=' + c.expect.padEnd(7), r.quad ? 'quad命中' : 'null', Math.round(r.ms) + 'ms', 'iters=' + r.iterations, 'cands=' + r.squares);
  }
  console.log('---');
  console.log(`${mode}: ${pass}/${total - unknown} 达标(UNKNOWN ${unknown} 张未计)`);
  process.exit(0);
}, 3000);
