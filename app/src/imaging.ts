// 图像处理 — sRGB canvas 透视校正(条带仿射)+ 像素增强 + 长图拼接
// warpPage 是预览/Scan/Outfit 唯一渲染入口,保证所见即所得。
import type { Enhancement, Page, Quad } from './types';
import { ENHANCEMENT_PRESETS } from './enhancement-presets';

function srgbContext(canvas: HTMLCanvasElement, willReadFrequently = false) {
  return canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently })!;
}

function srgbImageData(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  try {
    return context.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: 'srgb' });
  } catch {
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function luminance(data: Uint8ClampedArray, offset: number, weights: { red: number; green: number; blue: number }) {
  return clampByte(data[offset] * weights.red + data[offset + 1] * weights.green + data[offset + 2] * weights.blue);
}

function otsuThreshold(histogram: Uint32Array, total: number) {
  let sum = 0;
  for (let i = 0; i < histogram.length; i++) sum += i * histogram[i];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 127;
  for (let threshold = 0; threshold < histogram.length; threshold++) {
    backgroundWeight += histogram[threshold];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += threshold * histogram[threshold];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

export function applyEnhancement(canvas: HTMLCanvasElement, mode: Enhancement) {
  if (mode === 'original') return canvas;
  const context = srgbContext(canvas, true);
  const image = srgbImageData(context, canvas);
  const data = image.data;

  if (mode === 'gray') {
    const preset = ENHANCEMENT_PRESETS.gray;
    for (let i = 0; i < data.length; i += 4) {
      const value = luminance(data, i, preset.luminance);
      data[i] = value; data[i + 1] = value; data[i + 2] = value;
    }
  } else if (mode === 'bw') {
    const preset = ENHANCEMENT_PRESETS.bw;
    const values = new Uint8Array(data.length / 4);
    const histogram = new Uint32Array(256);
    for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
      const value = luminance(data, i, preset.luminance);
      values[pixel] = value;
      histogram[value]++;
    }
    const threshold = clampByte(otsuThreshold(histogram, values.length) + preset.thresholdBias);
    for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
      const value = values[pixel] >= threshold ? 255 : 0;
      data[i] = value; data[i + 1] = value; data[i + 2] = value;
    }
  } else {
    const preset = ENHANCEMENT_PRESETS.color;
    let red = 0, green = 0, blue = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i]; green += data[i + 1]; blue += data[i + 2];
    }
    const target = (red + green + blue) / (pixels * 3);
    const gain = (mean: number) => Math.max(preset.minGain, Math.min(preset.maxGain, target / Math.max(1, mean / pixels)));
    const redGain = gain(red), greenGain = gain(green), blueGain = gain(blue);
    const adjust = (value: number, channelGain: number) => clampByte((value * channelGain - 128) * preset.contrast + 128);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = adjust(data[i], redGain);
      data[i + 1] = adjust(data[i + 1], greenGain);
      data[i + 2] = adjust(data[i + 2], blueGain);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function affine(s0: number[], s1: number[], s2: number[], d0: number[], d1: number[], d2: number[]): number[] | null {
  const sx1 = s1[0] - s0[0], sy1 = s1[1] - s0[1];
  const sx2 = s2[0] - s0[0], sy2 = s2[1] - s0[1];
  const det = sx1 * sy2 - sx2 * sy1;
  if (Math.abs(det) < 1e-9) return null;
  const dx1 = d1[0] - d0[0], dy1 = d1[1] - d0[1];
  const dx2 = d2[0] - d0[0], dy2 = d2[1] - d0[1];
  const ia = (dx1 * sy2 - dx2 * sy1) / det;
  const ic = (dx2 * sx1 - dx1 * sx2) / det;
  const ib = (dy1 * sy2 - dy2 * sy1) / det;
  const id = (dy2 * sx1 - dy1 * sx2) / det;
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
  srgbContext(src).drawImage(img, 0, 0, src.width, src.height);

  const quad = p.quad;
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w0 = Math.max(1, Math.round((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2));
  const h0 = Math.max(1, Math.round((dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2));
  const rot = p.rotation % 360;
  const swap = rot === 90 || rot === 270;
  const w = swap ? Math.round(outWidth * h0 / Math.max(1, w0)) : outWidth;
  const h = swap ? Math.round(w * w0 / Math.max(1, h0)) : Math.round(w * h0 / Math.max(1, w0));

  const c = document.createElement('canvas');
  c.width = Math.max(16, w);
  c.height = Math.max(16, h);
  const x = srgbContext(c, p.enhancement !== 'original');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);

  const N = 48;
  const ler = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let k = 0; k < N; k++) {
    const t0 = k / N, t1 = (k + 1) / N;
    const left0 = ler(quad[0], quad[3], t0);
    const right0 = ler(quad[1], quad[2], t0);
    const left1 = ler(quad[0], quad[3], t1);
    const y0 = (t0 * h), y1 = (t1 * h + 1);
    const m = affine(left0, right0, left1, [0, y0], [w, y0], [0, y1]);
    if (!m) continue;
    x.save();
    x.beginPath(); x.rect(0, y0, w, y1 - y0); x.clip();
    x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    x.drawImage(src, 0, 0);
    x.restore();
  }
  applyEnhancement(c, p.enhancement);

  if (rot) {
    const r = document.createElement('canvas');
    r.width = rot % 180 === 0 ? c.width : c.height;
    r.height = rot % 180 === 0 ? c.height : c.width;
    const rx = srgbContext(r);
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
  const x = srgbContext(out);
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
