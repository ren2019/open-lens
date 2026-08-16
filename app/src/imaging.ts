// 图像处理 — canvas 透视校正(条带仿射)+ 增强近似 + 长图拼接
// OpenCV.js 就绪后 warpPage 可换成 cv.getPerspectiveTransform 精确实现,接口不变。
import type { Page, Quad } from './types';

const ENH_CSS: Record<string, string> = {
  original: 'none',
  gray: 'grayscale(1)',
  bw: 'grayscale(1) contrast(2.4) brightness(1.1)',
  color: 'saturate(1.3) contrast(1.15) brightness(1.05)',
};

function affine(s0: number[], s1: number[], s2: number[], d0: number[], d1: number[], d2: number[]): number[] | null {
  const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (Math.abs(det) < 1e-9) return null;
  const u = [d0[0] - s0[0], d1[0] - s0[0], d2[0] - s0[0]];
  const v = [d0[1] - s0[1], d1[1] - s0[1], d2[1] - s0[1]];
  const ia = (u[1] * (s2[1] - s0[1]) - u[2] * (s1[1] - s0[1])) / det;
  const ic = (u[2] * (s1[0] - s0[0]) - u[1] * (s2[0] - s0[0])) / det;
  const ib = (v[1] * (s2[1] - s0[1]) - v[2] * (s1[1] - s0[1])) / det;
  const id = (v[2] * (s1[0] - s0[0]) - v[1] * (s2[0] - s0[0])) / det;
  return [ia, ib, ic, id, d0[0] - ia * s0[0] - ic * s0[1], d0[1] - ib * s0[0] - id * s0[1]];
}

const imgCache = new Map<string, HTMLImageElement>();
export async function loadImage(blob: Blob, key: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(key);
  if (hit) return hit;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    imgCache.set(key, img);
    return img;
  } finally { /* keep url alive for cached img */ }
}

// 透视校正: quad(原图坐标系)→ 输出画布;支持 rotation/enhancement
export async function warpPage(p: Page, outWidth = 900): Promise<HTMLCanvasElement> {
  const img = await loadImage(p.originalBlob, p.id);
  const src = document.createElement('canvas');
  src.width = p.originalW || img.naturalWidth;
  src.height = p.originalH || img.naturalHeight;
  src.getContext('2d')!.drawImage(img, 0, 0, src.width, src.height);

  const quad = p.quad;
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w0 = Math.max(1, Math.round((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2));
  const h0 = Math.max(1, Math.round((dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2));
  const rot = p.rotation % 360;
  const swap = rot === 90 || rot === 270;
  const ow = Math.min(outWidth, swap ? Math.round(outWidth * w0 / h0 * 0 + outWidth) : outWidth);
  const w = swap ? Math.round(outWidth * h0 / Math.max(1, w0)) : outWidth;
  const h = swap ? Math.round(w * w0 / Math.max(1, h0)) : Math.round(w * h0 / Math.max(1, w0));

  const c = document.createElement('canvas');
  c.width = Math.max(16, swap ? w : w);
  c.height = Math.max(16, h);
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);

  const N = 48;
  const ler = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let k = 0; k < N; k++) {
    const t0 = k / N, t1 = (k + 1) / N;
    const A0 = ler(quad[0], quad[1], t0), A1 = ler(quad[0], quad[1], t1), B0 = ler(quad[3], quad[2], t0);
    const y0 = (t0 * h), y1 = (t1 * h + 1);
    const m = affine(A0, A1, B0, [0, y0], [w, y0], [0, y1]);
    if (!m) continue;
    x.save();
    x.beginPath(); x.rect(0, y0, w, y1 - y0); x.clip();
    x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    x.filter = ENH_CSS[p.enhancement] || 'none';
    x.drawImage(src, 0, 0);
    x.restore();
  }

  if (rot) {
    const r = document.createElement('canvas');
    r.width = rot % 180 === 0 ? c.width : c.height;
    r.height = rot % 180 === 0 ? c.height : c.width;
    const rx = r.getContext('2d')!;
    rx.translate(r.width / 2, r.height / 2);
    rx.rotate(rot * Math.PI / 180);
    rx.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
  }
  return c;
}

// 长图: 等宽垂直拼接(E3,板书场景)
export async function stitchLongImage(pages: Page[], width = 900): Promise<HTMLCanvasElement> {
  const cs = await Promise.all(pages.map(p => warpPage(p, width)));
  const w = Math.min(...cs.map(c => c.width));
  const h = cs.reduce((a, c) => a + Math.round(c.height * w / c.width), 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const x = out.getContext('2d')!;
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  let y = 0;
  for (const c of cs) {
    const hh = Math.round(c.height * w / c.width);
    x.drawImage(c, 0, y, w, hh);
    y += hh;
  }
  return out;
}

export function quadPath(x: CanvasRenderingContext2D, q: Quad | number[][]) {
  x.beginPath(); x.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < 4; i++) x.lineTo(q[i][0], q[i][1]);
  x.closePath();
}
