// 图像处理 — sRGB canvas 连续透视校正 + 像素增强 + 长图拼接
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

function squareToQuad(quad: Quad) {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const diagonalX = topLeft[0] - topRight[0] + bottomRight[0] - bottomLeft[0];
  const diagonalY = topLeft[1] - topRight[1] + bottomRight[1] - bottomLeft[1];
  let perspectiveX = 0;
  let perspectiveY = 0;

  if (Math.abs(diagonalX) > 1e-9 || Math.abs(diagonalY) > 1e-9) {
    const rightX = topRight[0] - bottomRight[0];
    const rightY = topRight[1] - bottomRight[1];
    const bottomX = bottomLeft[0] - bottomRight[0];
    const bottomY = bottomLeft[1] - bottomRight[1];
    const determinant = rightX * bottomY - bottomX * rightY;
    if (Math.abs(determinant) < 1e-9) return null;
    perspectiveX = (diagonalX * bottomY - bottomX * diagonalY) / determinant;
    perspectiveY = (rightX * diagonalY - diagonalX * rightY) / determinant;
  }

  return [
    topRight[0] - topLeft[0] + perspectiveX * topRight[0],
    bottomLeft[0] - topLeft[0] + perspectiveY * bottomLeft[0],
    topLeft[0],
    topRight[1] - topLeft[1] + perspectiveX * topRight[1],
    bottomLeft[1] - topLeft[1] + perspectiveY * bottomLeft[1],
    topLeft[1],
    perspectiveX,
    perspectiveY,
  ];
}

function warpPerspective(source: HTMLCanvasElement, destination: HTMLCanvasElement, quad: Quad) {
  const map = squareToQuad(quad);
  if (!map) return;
  const sourceContext = srgbContext(source, true);
  const sourcePixels = srgbImageData(sourceContext, source).data;
  const destinationContext = srgbContext(destination);
  const destinationImage = destinationContext.createImageData(destination.width, destination.height);
  const destinationPixels = destinationImage.data;
  destinationPixels.fill(255);
  const destinationWidth = Math.max(1, destination.width - 1);
  const destinationHeight = Math.max(1, destination.height - 1);
  const uStep = 1 / destinationWidth;

  for (let y = 0; y < destination.height; y++) {
    const v = y / destinationHeight;
    const sourceXBase = map[1] * v + map[2];
    const sourceYBase = map[4] * v + map[5];
    const denominatorBase = map[7] * v + 1;
    for (let x = 0; x < destination.width; x++) {
      const u = x * uStep;
      const denominator = map[6] * u + denominatorBase;
      if (Math.abs(denominator) < 1e-9) continue;
      const sourceX = Math.max(0, Math.min(source.width - 1, (map[0] * u + sourceXBase) / denominator));
      const sourceY = Math.max(0, Math.min(source.height - 1, (map[3] * u + sourceYBase) / denominator));
      const left = Math.floor(sourceX);
      const top = Math.floor(sourceY);
      const right = Math.min(source.width - 1, left + 1);
      const bottom = Math.min(source.height - 1, top + 1);
      const horizontal = sourceX - left;
      const vertical = sourceY - top;
      const topLeftWeight = (1 - horizontal) * (1 - vertical);
      const topRightWeight = horizontal * (1 - vertical);
      const bottomRightWeight = horizontal * vertical;
      const bottomLeftWeight = (1 - horizontal) * vertical;
      const topLeftOffset = (top * source.width + left) * 4;
      const topRightOffset = (top * source.width + right) * 4;
      const bottomRightOffset = (bottom * source.width + right) * 4;
      const bottomLeftOffset = (bottom * source.width + left) * 4;
      const destinationOffset = (y * destination.width + x) * 4;

      for (let channel = 0; channel < 3; channel++) {
        destinationPixels[destinationOffset + channel] =
          sourcePixels[topLeftOffset + channel] * topLeftWeight
          + sourcePixels[topRightOffset + channel] * topRightWeight
          + sourcePixels[bottomRightOffset + channel] * bottomRightWeight
          + sourcePixels[bottomLeftOffset + channel] * bottomLeftWeight;
      }
    }
  }
  destinationContext.putImageData(destinationImage, 0, 0);
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
  const sourceContext = srgbContext(src, true);
  sourceContext.fillStyle = '#fff'; sourceContext.fillRect(0, 0, src.width, src.height);
  sourceContext.drawImage(img, 0, 0, src.width, src.height);

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
  warpPerspective(src, c, quad);
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
