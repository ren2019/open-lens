#!/usr/bin/env python3
"""生成 outputs-wall-v3 原型资产:assets/{photo,render,thumb} + data.js
数据源:spike/photos-batch(batch-meta.json + label/*.png + outputs/*-corrected.jpg)
assets/ 已 gitignore,勿提交。"""
import json, math, os, statistics, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
BATCH = os.path.join(ROOT, '../../spike/photos-batch')
A = os.path.join(ROOT, 'assets')
for d in ('photo', 'render', 'thumb', 'thumb-render'):
    os.makedirs(os.path.join(A, d), exist_ok=True)

meta = json.load(open(os.path.join(BATCH, 'batch-meta.json')))

def dist(a, b): return math.hypot(a[0]-b[0], a[1]-b[1])
def ar_of(q):
    w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2
    h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2
    return w / h
def dev_of(a, b): return max(dist(a[i], b[i]) for i in range(4))

items = []
for name, m in sorted(meta.items()):
    base = name.rsplit('.', 1)[0]  # batch-meta 里有 IMG_4096.PNG 这种大写扩展名
    quad, prop = m.get('quad'), m['proposal']['quad']
    ar = ar_of(quad) if quad else None
    dev = dev_of(quad, prop) if (quad and m['edited']) else 0.0
    render = os.path.join(BATCH, 'outputs', base + '-corrected.jpg')
    items.append({
        'name': base, 'mode': m['mode'], 'ms': m['proposal']['ms'],
        'proposal': prop, 'quad': quad, 'edited': bool(m['edited']),
        'devPx': round(dev, 1), 'ar': round(ar, 4) if ar else None,
        'labeledAt': m.get('labeledAt'), 'renderedAt': m.get('renderedAt'),
        'hasRender': os.path.exists(render),
    })

ars = sorted(it['ar'] for it in items if it['ar'])
med = statistics.median(ars)
# ar 可疑带:中位数 ±0.04(实测分布后人工定的带宽)
LO, HI = med - 0.04, med + 0.04
for it in items:
    if it['ar'] is None: it['status'] = 'notarget'
    elif it['ar'] < LO or it['ar'] > HI: it['status'] = 'suspect'
    elif it['edited']: it['status'] = 'edited'
    else: it['status'] = 'ok'
print(f"items={len(items)} ar median={med:.4f} band=[{LO:.3f},{HI:.3f}]")
from collections import Counter
print('status:', Counter(it['status'] for it in items))
print('hasRender False:', [it['name'] for it in items if not it['hasRender']])

with open(os.path.join(ROOT, 'data.js'), 'w') as f:
    f.write('// 由 gen-assets.py 从 spike/photos-batch 生成,勿手改\n')
    f.write(f'// ar 可疑带 [{LO:.3f}, {HI:.3f}](中位数 {med:.4f} ±0.04)\n')
    f.write('window.ITEMS = ' + json.dumps(items, ensure_ascii=False) + ';\n')

def sips(src, dst, maxdim):
    subprocess.run(['sips', '-Z', str(maxdim), '-s', 'format', 'jpeg',
                    '-s', 'formatOptions', '82', src, '--out', dst],
                   check=True, capture_output=True)

todo = []
for it in items:
    b = it['name']
    photo = os.path.join(BATCH, 'label', b + '.png')
    render = os.path.join(BATCH, 'outputs', b + '-corrected.jpg')
    todo += [(photo, f'{A}/photo/{b}.jpg', 1000), (photo, f'{A}/thumb/{b}.jpg', 200)]
    if it['hasRender']:
        todo += [(render, f'{A}/render/{b}.jpg', 1400), (render, f'{A}/thumb-render/{b}.jpg', 200)]
for i, (s, d, z) in enumerate(todo):
    if not os.path.exists(d):
        sips(s, d, z)
    if (i+1) % 100 == 0: print(f'{i+1}/{len(todo)}', flush=True)
print('done', len(todo))
