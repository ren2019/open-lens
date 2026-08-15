// 用真实照片复现:跑 OSS detector,输出检测到的 quad + 各阶段中间图
const cv = require('./opencv.js');
const OSSDetector = require('./detector.js');
const fs = require('fs');
const zlib = require('zlib');
setTimeout(() => {
  // JPEG 解码: cv 构建没有 imread。sips 转 PNG 再用 png2mat
  console.log('请先用 sips 转换。本脚本直接跑检测:');
  const { decodePng } = require('./png2mat.js');
  const d = decodePng(fs.readFileSync(process.argv[2] || 'photos/real-test-1.png'));
  const mat = new cv.Mat(d.H, d.W, cv.CV_8UC4);
  mat.data.set(d.data);
  console.log('image:', d.W, 'x', d.H);

  const r = OSSDetector.detect(cv, mat);
  console.log('detect:', r.ms.toFixed(0)+'ms', 'iters='+r.iterations, 'squares='+r.squares);
  console.log('quad:', r.quad ? JSON.stringify(r.quad.map(p=>({x:Math.round(p.x),y:Math.round(p.y)}))) : 'null');

  // 真值(目测): 屏幕约 (40,146)-(959,449)
  if (r.quad) {
    const q = r.quad;
    console.log('quad bbox: x', Math.round(Math.min(...q.map(p=>p.x))), '-', Math.round(Math.max(...q.map(p=>p.x))),
                ' y', Math.round(Math.min(...q.map(p=>p.y))), '-', Math.round(Math.max(...q.map(p=>p.y))));
  }
  process.exit(0);
}, 3000);
