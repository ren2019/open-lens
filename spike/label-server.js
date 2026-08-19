// label-server.js — 本机网页标注工具: 逐张显示 eval 图片, 拖四角标 ground truth, 存 JSON
// 用法: node label-server.js  →  Mac 浏览器打开 http://localhost:8790
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const EVAL_DIR = path.join(ROOT, 'eval');
const GT_FILE = path.join(EVAL_DIR, 'ground-truth.json');

// eval 集: 统一软链/复制到这里, 文件名即 case id
if (!fs.existsSync(EVAL_DIR)) fs.mkdirSync(EVAL_DIR, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Open-Lens 标注</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1c1c1e;color:#fff;padding:16px}
#bar{display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
button{background:#2c2c2e;color:#fff;border:1px solid #48484a;border-radius:8px;padding:8px 16px;font-size:14px}
button.active{background:#0a84ff}button.warning{background:#7a6400;border-color:#ffd60a}button:disabled{opacity:.4}
#wrap{position:relative;display:inline-block;max-width:100%}
#img{max-width:100%;display:block;border-radius:6px}
#ov{position:absolute;left:0;top:0}
#tip{font-size:12px;color:#98989d;margin-top:8px;line-height:1.6}
select{background:#2c2c2e;color:#fff;border:1px solid #48484a;border-radius:8px;padding:8px}
</style></head><body>
<div id="bar">
  <b id="pos">-</b>
  <button id="prev">◀</button><button id="next">▶</button>
  <select id="mode"><option value="screen">拍屏/课件</option><option value="document">文件/发票</option><option value="whiteboard">白板</option><option value="businesscard">名片(待补 GT)</option><option value="auto">其他/自动</option></select>
  <button id="noTarget">无有效目标</button>
  <button id="expectFallback">期望降级</button>
  <button id="save" class="active" style="padding:8px 28px">保存标注</button>
  <span id="saved" style="color:#30d158"></span>
</div>
<div id="wrap"><img id="img"><canvas id="ov"></canvas></div>
<div id="tip">拖动四个角点对准<b>目标矩形的四角</b> → 选模式 → 保存。角点顺序无需关心(会自动排序)。<br>「无有效目标」= 图里没有目标；「期望降级」= 有目标和 GT，但目标被裁过半/边框物理不可见，检测器应失败并交给手动框。两者不可同时选。businesscard 当前只登记 schema，占位到真实名片 GT 到齐后再评测。</div>
<script>
const $ = id => document.getElementById(id);
let list = [], idx = 0, quad = null, img = $('img'), ov = $('ov'), ctx = ov.getContext('2d');
let gt = {};

async function boot() {
  list = await fetch('/api/list').then(r => r.json());
  gt = await fetch('/api/gt').then(r => r.json());
  if (!list.length) { document.body.innerHTML = '<p>eval/ 目录为空</p>'; return; }
  show(0);
}
function show(i) {
  idx = (i + list.length) % list.length;
  const id = list[idx];
  img.src = '/images/' + id;
  img.onload = () => {
    ov.width = img.clientWidth; ov.height = img.clientHeight;
    ov.style.width = img.clientWidth + 'px'; ov.style.height = img.clientHeight + 'px';
    const g = gt[id];
    if (g && g.quad) quad = g.quad.map(p => ({x: p[0] * img.clientWidth / img.naturalWidth, y: p[1] * img.clientHeight / img.naturalHeight}));
    else if (g && g.noTarget) { quad = null; $('noTarget').classList.add('active'); }
    else { quad = [{x:img.clientWidth*.25,y:img.clientHeight*.25},{x:img.clientWidth*.75,y:img.clientHeight*.25},{x:img.clientWidth*.75,y:img.clientHeight*.75},{x:img.clientWidth*.25,y:img.clientHeight*.75}]; $('noTarget').classList.remove('active'); }
    $('noTarget').classList.toggle('active', Boolean(g && g.noTarget));
    $('expectFallback').classList.toggle('warning', Boolean(g && g.expectFallback));
    if (g && g.mode) $('mode').value = g.mode;
    $('pos').textContent = (idx+1) + '/' + list.length + ' ' + id;
    draw();
  };
}
function draw() {
  ctx.clearRect(0,0,ov.width,ov.height);
  if (!quad) return;
  ctx.strokeStyle = '#30d158'; ctx.lineWidth = 3;
  ctx.beginPath(); quad.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.stroke();
  quad.forEach(p => { ctx.fillStyle='#30d158'; ctx.beginPath(); ctx.arc(p.x,p.y,10,0,7); ctx.fill(); });
}
let drag = -1;
function pt(ev) { const r = ov.getBoundingClientRect(); return {x: ev.clientX-r.left, y: ev.clientY-r.top}; }
ov.addEventListener('mousedown', ev => { if (!quad) return; const p = pt(ev); drag = quad.findIndex(q => Math.hypot(q.x-p.x,q.y-p.y)<26); });
ov.addEventListener('mousemove', ev => { if (drag<0) return; const p = pt(ev); quad[drag] = p; draw(); });
ov.addEventListener('mouseup', () => drag = -1);
ov.addEventListener('touchstart', ev => { if (!quad) return; const p = pt(ev); drag = quad.findIndex(q => Math.hypot(q.x-p.x,q.y-p.y)<30); if (drag>=0) ev.preventDefault(); }, {passive:false});
ov.addEventListener('touchmove', ev => { if (drag<0) return; ev.preventDefault(); const t = ev.touches[0]; const r = ov.getBoundingClientRect(); quad[drag] = {x:t.clientX-r.left, y:t.clientY-r.top}; draw(); }, {passive:false});
ov.addEventListener('touchend', () => drag = -1);
$('noTarget').onclick = () => {
  const active = !$('noTarget').classList.contains('active');
  $('noTarget').classList.toggle('active', active); $('expectFallback').classList.remove('warning');
  if (active) quad = null; else quad = [{x:img.clientWidth*.25,y:img.clientHeight*.25},{x:img.clientWidth*.75,y:img.clientHeight*.25},{x:img.clientWidth*.75,y:img.clientHeight*.75},{x:img.clientWidth*.25,y:img.clientHeight*.75}];
  draw();
};
$('expectFallback').onclick = () => {
  if (!quad) return;
  $('expectFallback').classList.toggle('warning'); $('noTarget').classList.remove('active');
};
$('prev').onclick = () => show(idx-1);
$('next').onclick = () => show(idx+1);
$('save').onclick = async () => {
  const id = list[idx];
  const rec = { mode: $('mode').value };
  if (quad) {
    rec.quad = quad.map(p => [Math.round(p.x * img.naturalWidth / img.clientWidth), Math.round(p.y * img.naturalHeight / img.clientHeight)]);
    if ($('expectFallback').classList.contains('warning')) rec.expectFallback = true;
  }
  else rec.noTarget = true;
  const r = await fetch('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id, rec})}).then(x=>x.json());
  $('saved').textContent = '已保存 ✓ ' + new Date().toTimeString().slice(0,5);
  setTimeout(()=>$('saved').textContent='', 1500);
};
boot();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' ) { res.writeHead(200, {'Content-Type':'text/html','Cache-Control':'no-store'}); res.end(PAGE); return; }
  if (u === '/api/list') {
    const files = fs.readdirSync(EVAL_DIR).filter(f => /\.(png|jpe?g)$/i.test(f) && !fs.statSync(path.join(EVAL_DIR,f)).isDirectory()).sort();
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(files)); return;
  }
  if (u === '/api/gt') {
    let gt = {};
    try { gt = JSON.parse(fs.readFileSync(GT_FILE)); } catch(e) {}
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(gt)); return;
  }
  if (u === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, rec } = JSON.parse(body);
        rec.labeledAt = new Date().toISOString();
        let gt = {};
        try { gt = JSON.parse(fs.readFileSync(GT_FILE)); } catch(e) {}
        gt[id] = rec;
        fs.writeFileSync(GT_FILE, JSON.stringify(gt, null, 2));
        res.writeHead(200); res.end('{"ok":true}');
        console.log('[gt]', id, rec.mode, rec.quad ? 'quad' : 'noTarget');
      } catch (e) { res.writeHead(400); res.end('{"ok":false}'); }
    });
    return;
  }
  if (u.startsWith('/images/')) {
    const f = path.join(EVAL_DIR, path.basename(u));
    if (fs.existsSync(f)) {
      res.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
      fs.createReadStream(f).pipe(res);
      return;
    }
  }
  res.writeHead(404); res.end('nf');
});
server.listen(8790, () => console.log('label tool → http://localhost:8790'));
