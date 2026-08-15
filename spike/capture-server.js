// capture-server.js — 静态文件 + POST /capture 接收手机端调试上传
// 替代 http-server: 同目录静态服务(HTTPS/mkcert) + 保存冻结帧和检测结果到 captures/
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CAP = path.join(ROOT, 'captures');
fs.mkdirSync(CAP, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };

https.createServer({
  key: fs.readFileSync(path.join(ROOT, 'key.pem')),
  cert: fs.readFileSync(path.join(ROOT, 'cert.pem')),
}, (req, res) => {
  if (req.method === 'POST' && req.url === '/capture') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { image, quad, ms, label } = JSON.parse(body);
        const id = new Date().toISOString().replace(/[:.]/g, '-');
        const meta = { time: new Date().toISOString(), label, quad, ms };
        // image 是 dataURL
        const m = /^data:image\/(\w+);base64,(.*)$/.exec(image || '');
        if (m) {
          fs.writeFileSync(path.join(CAP, id + '.' + m[1]), Buffer.from(m[2], 'base64'));
          fs.writeFileSync(path.join(CAP, id + '.json'), JSON.stringify(meta, null, 2));
        } else {
          fs.writeFileSync(path.join(CAP, id + '.json'), JSON.stringify(meta, null, 2));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        console.log('[capture]', id, 'quad:', quad ? 'yes' : 'null', Math.round(ms) + 'ms');
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, err: e.message }));
      }
    });
    return;
  }
  // 静态
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8765, () => console.log('capture-server on :8765 (https)'));
