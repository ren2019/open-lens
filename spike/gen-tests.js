// 生成 6 张合成测试照片(真实场景难点),然后跑 detectQuad 统计命中率
const cv = require('./opencv.js');
const done = () => { try { report(); } finally { process.exit(0); } };
setTimeout(() => {
  const results = [];
  function blank(W,H,c){ const m=new cv.Mat(H,W,cv.CV_8UC4); m.setTo(c); return m; }
  function rect(m,x,y,w,h,c){ m.rowRange(y,y+h).colRange(x,x+w).setTo(c); }
  function line(m,p1,p2,c,t){ cv.line(m, new cv.Point(...p1), new cv.Point(...p2), c, t); }
  function quadFill(m, q, c) {
    const pts = cv.matFromArray(4,1,cv.CV_32SC2, q.flat());
    const mv = new cv.MatVector(); mv.push_back(pts);
    cv.fillPoly(m, mv, c);
    pts.delete(); mv.delete();
  }
  const white=[255,255,255,255], wall=[105,105,115,255], ink=[45,45,65,255], red=[70,70,210,255], glare=[252,252,252,255], clutter=[140,130,120,255];
  const S = c => new cv.Scalar(...c);

  // ---- detectQuad (与页面同步的最新实现) ----
  function detectQuad(mat) {
    const t0 = Date.now();
    const img = mat.clone();
    const w = img.cols, h = img.rows;
    const scale = Math.min(1, 480 / Math.max(w, h));
    let work, inv;
    if (scale < 1) {
      const small = new cv.Mat();
      cv.resize(img, small, new cv.Size(Math.round(w*scale), Math.round(h*scale)));
      img.delete(); work = small; inv = 1/scale;
    } else { work = img; inv = 1; }
    let gray=new cv.Mat(), blur=new cv.Mat(), edges=new cv.Mat();
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0);
    cv.Canny(blur, edges, 50, 150);
    const k=cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3));
    cv.dilate(edges, edges, k, new cv.Point(-1,-1), 2);
    const cs=new cv.MatVector(), hi=new cv.Mat();
    cv.findContours(edges, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best=null, bestArea=0;
    for(let i=0;i<cs.size();i++){
      const c=cs.get(i); const area=cv.contourArea(c); if(area<bestArea){c.delete();continue;}
      const peri=cv.arcLength(c,true); const ap=new cv.Mat();
      cv.approxPolyDP(c, ap, 0.02*peri, true);
      if(ap.rows===4 && cv.isContourConvex(ap)){ bestArea=area; best=ap.clone(); }
      ap.delete(); c.delete();
    }
    let r=null;
    if(best){ r=[]; for(let i=0;i<4;i++){ const p=best.intPtr(0,i); r.push([p[0]*inv, p[1]*inv]); } best.delete(); }
    [work,gray,blur,edges,k,cs,hi].forEach(m=>{try{m.delete();}catch(e){}});
    return { quad:r, ms: Date.now()-t0 };
  }

  // 手动编码 JPEG: cv 构建没带 imwrite/imencode,自己实现最简 baseline JPEG 太重——
  // 改存 PNG: 用 canvas 不可用(node),所以直接用 cv 的 toDataURL 等价物也没有。
  // 方案: 把 RGBA 原始像素写成 .rgba + 元数据,浏览器端用 canvas 还原预览。
  // 更简单: 用 node zlib 手写 PNG 编码器(未压缩 zlib stored 块,几十行)
  const zlib = require('zlib');
  function savePng(mat, path) {
    const W = mat.cols, H = mat.rows;
    // PNG: filter 0 per row + RGBA
    const raw = Buffer.alloc((W*4+1)*H);
    for (let y=0; y<H; y++) {
      raw[y*(W*4+1)] = 0;
      const row = Buffer.from(mat.data.buffer, mat.data.byteOffset + y*W*4, W*4);
      row.copy(raw, y*(W*4+1)+1);
    }
    const idat = zlib.deflateSync(raw, {level: 9});
    function chunk(type, data) {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crcTable = []; for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0;}
      let crc = 0xffffffff; for (const b of td) crc = crcTable[(crc^b)&0xff]^(crc>>>8);
      crc = (crc^0xffffffff)>>>0;
      const cb = Buffer.alloc(4); cb.writeUInt32BE(crc);
      return Buffer.concat([len, td, cb]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4);
    ihdr[8]=8; ihdr[9]=6; // 8bit RGBA
    const png = Buffer.concat([
      Buffer.from([137,80,78,71,13,10,26,10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0))
    ]);
    require('fs').writeFileSync(path, png);
  }
  function saveJpeg(mat, path) { savePng(mat, path.replace(/\.jpg$/, '.png')); }

  function evalCase(name, mat, truth) {
    const { quad, ms } = detectQuad(mat);
    let verdict = 'MISS';
    if (quad) {
      // 与真值四角平均偏差(占图宽比例)
      const tSet = [...truth].sort((a,b)=>(a[0]+a[1])-(b[0]+b[1]));
      const qSet = [...quad].sort((a,b)=>(a[0]+a[1])-(b[0]+b[1]));
      let sum=0; for(let i=0;i<4;i++){ sum += Math.hypot(tSet[i][0]-qSet[i][0], tSet[i][1]-qSet[i][1]); }
      const avgErr = sum/4/mat.cols;
      verdict = avgErr < 0.03 ? 'HIT' : (avgErr < 0.08 ? 'TWEAK' : 'MISS');
      results.push({name, verdict, avgErrPct:(avgErr*100).toFixed(1), ms});
    } else results.push({name, verdict, ms});
    saveJpeg(mat, 'photos/'+name+'.jpg');
    console.log(name.padEnd(28), verdict.padEnd(6), quad?'err '+(results[results.length-1].avgErrPct)+'%':'', ms+'ms');
  }

  const fs = require('fs');
  fs.mkdirSync('photos', {recursive:true});

  // 1 理想白板
  let m = blank(1600,1200,S(wall));
  rect(m,200,150,1200,900,S(white));
  for(let i=0;i<6;i++) line(m,[260,240+i*120],[1080+Math.round(80*Math.sin(i*1.7)),228+i*120],S(ink),6);
  line(m,[300,980],[1330,968],S(red),8);
  evalCase('01-ideal-whiteboard', m, [[200,150],[1400,150],[1400,1050],[200,1050]]); m.delete();

  // 2 斜拍透视白板(不规则四边形)
  m = blank(1600,1200,S(wall));
  const q2=[[380,70],[1530,235],[1290,1120],[235,985]];
  quadFill(m,q2,S(white));
  for(let i=0;i<5;i++) line(m,[470+i*30,190+i*95],[1330-i*40,290+i*150],S(ink),6);
  evalCase('02-perspective-whiteboard', m, q2); m.delete();

  // 3 淡笔迹低对比度
  m = blank(1600,1200,S(wall));
  rect(m,250,200,1100,850,S([238,238,240,255])); // 微灰白板
  for(let i=0;i<5;i++) line(m,[300,300+i*140],[1180,290+i*140],S([210,210,215,255]),5); // 极淡笔迹
  evalCase('03-faint-ink-lowcontrast', m, [[250,200],[1350,200],[1350,1050],[250,1050]]); m.delete();

  // 4 杂乱背景(周围线条多)
  m = blank(1600,1200,S(wall));
  rect(m,180,140,1240,920,S(white));
  for(let i=0;i<6;i++) line(m,[240,230+i*130],[1160,220+i*130],S(ink),6);
  for(let i=0;i<14;i++) line(m,[Math.random()*1590|0,Math.random()*1190|0],[Math.random()*1590|0,Math.random()*1190|0],S(clutter),3);
  evalCase('04-cluttered-background', m, [[180,140],[1420,140],[1420,1060],[180,1060]]); m.delete();

  // 5 白板一角出框
  m = blank(1600,1200,S(wall));
  const q5=[[1180,-60],[1720,180],[1380,1080],[640,820]]; // 部分顶点在画面外
  quadFill(m,q5,S(white));
  for(let i=0;i<4;i++) line(m,[700+i*40,120+i*180],[1300-i*30,220+i*200],S(ink),6);
  evalCase('05-partially-outofframe', m, q5); m.delete();

  // 6 局部反光
  m = blank(1600,1200,S(wall));
  rect(m,200,150,1200,900,S(white));
  for(let i=0;i<6;i++) line(m,[260,240+i*120],[1080,228+i*120],S(ink),6);
  rect(m,880,300,320,260,S(glare)); // 高光块盖住部分笔迹
  evalCase('06-glare-patch', m, [[200,150],[1400,150],[1400,1050],[200,1050]]); m.delete();

  function report(){
    const hits = results.filter(r=>r.verdict==='HIT').length;
    const tweaks = results.filter(r=>r.verdict==='TWEAK').length;
    console.log('---');
    console.log(`合成测试: HIT ${hits} / TWEAK ${tweaks} / MISS ${results.length-hits-tweaks} 共${results.length}`);
    console.log(`HIT+TWEAK 占比: ${((hits+tweaks)/results.length*100)|0}% (验收线 70%)`);
  }
  done();
}, 3000);
