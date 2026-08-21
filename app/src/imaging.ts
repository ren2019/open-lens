// 图像处理 — sRGB canvas 连续透视校正 + 像素增强 + 长图拼接
// warpPage 是预览/Scan/Outfit 唯一渲染入口,保证所见即所得。
import type { Enhancement, Page, Quad } from './types';
import { ENHANCEMENT_PRESETS } from './enhancement-presets';

// 单 canvas 上限：2^15-1 单边、2^24 像素（RGBA backing store 64 MiB），超限不降采样。
const MAX_OUTPUT_CANVAS_DIMENSION = 32_767;
const MAX_OUTPUT_CANVAS_PIXELS = 16_777_216;
// 3× 是高频文本透视回归保持基线锐度的最小档；再由统一 canvas 预算收紧极端输入。
const SOURCE_CROP_SUPERSAMPLE = 3;

interface OutputCanvasSize {
  width: number;
  height: number;
}

function invalidOutputCanvas(label: string, size: OutputCanvasSize, reason: string): never {
  throw new Error(`Invalid output canvas: ${label} ${size.width}x${size.height}; ${reason}`);
}

function validateOutputCanvasSize(size: OutputCanvasSize, label: string) {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
    || size.width <= 0 || size.height <= 0) {
    invalidOutputCanvas(label, size, 'dimensions must be positive safe integers');
  }
  if (size.width > MAX_OUTPUT_CANVAS_DIMENSION || size.height > MAX_OUTPUT_CANVAS_DIMENSION) {
    invalidOutputCanvas(label, size, `dimension limit ${MAX_OUTPUT_CANVAS_DIMENSION}`);
  }
  const pixels = size.width * size.height;
  if (pixels > MAX_OUTPUT_CANVAS_PIXELS) {
    invalidOutputCanvas(label, size, `${pixels} pixels exceeds pixel budget ${MAX_OUTPUT_CANVAS_PIXELS}`);
  }
  return size;
}

function createOutputCanvas(size: OutputCanvasSize, label: string, willReadFrequently = false) {
  validateOutputCanvasSize(size, label);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  if (canvas.width !== size.width || canvas.height !== size.height) {
    invalidOutputCanvas(label, size, `browser created ${canvas.width}x${canvas.height}`);
  }
  const context = srgbContext(canvas, willReadFrequently, label);
  return { canvas, context };
}

function srgbContext(canvas: HTMLCanvasElement, willReadFrequently = false, label = 'Canvas') {
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently });
  if (!context) invalidOutputCanvas(label, { width: canvas.width, height: canvas.height }, '2d context unavailable');
  return context;
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

function invalidQuad(reason: string): never {
  throw new Error(`Invalid quad: ${reason}`);
}

function validateQuad(quad: Quad, sourceWidth: number, sourceHeight: number) {
  if (!Array.isArray(quad) || quad.length !== 4) invalidQuad('expected four corners');
  for (const point of quad) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      invalidQuad('corners must contain finite coordinates');
    }
    if (point[0] < 0 || point[0] > sourceWidth || point[1] < 0 || point[1] > sourceHeight) {
      invalidQuad('corner is outside the source bounds');
    }
  }

  const signedArea = quad.reduce((sum, point, index) => {
    const next = quad[(index + 1) % quad.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) < 1e-6) invalidQuad('area must be non-zero');

  const turns = quad.map((point, index) => {
    const next = quad[(index + 1) % quad.length];
    const after = quad[(index + 2) % quad.length];
    return (next[0] - point[0]) * (after[1] - next[1])
      - (next[1] - point[1]) * (after[0] - next[0]);
  });
  if (turns.some(turn => Math.abs(turn) < 1e-9)
    || turns.some(turn => Math.sign(turn) !== Math.sign(turns[0]))) {
    invalidQuad('corners must form a strictly convex polygon');
  }
}

function warpPerspectiveOpenCV(
  cv: any,
  source: HTMLCanvasElement,
  destination: HTMLCanvasElement,
  quad: Quad,
) {
  let sourceMat: any = null;
  let destinationMat: any = null;
  let sourceCorners: any = null;
  let destinationCorners: any = null;
  let transform: any = null;
  try {
    const sourceContext = srgbContext(source, true);
    sourceMat = cv.matFromImageData(srgbImageData(sourceContext, source));
    destinationMat = new cv.Mat();
    sourceCorners = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
    destinationCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      destination.width - 1, 0,
      destination.width - 1, destination.height - 1,
      0, destination.height - 1,
    ]);
    transform = cv.getPerspectiveTransform(sourceCorners, destinationCorners);
    cv.warpPerspective(
      sourceMat,
      destinationMat,
      transform,
      new cv.Size(destination.width, destination.height),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
    );
    cv.imshow(destination, destinationMat);
  } finally {
    transform?.delete?.();
    destinationCorners?.delete?.();
    sourceCorners?.delete?.();
    destinationMat?.delete?.();
    sourceMat?.delete?.();
  }
}

function warpPerspective(source: HTMLCanvasElement, destination: HTMLCanvasElement, quad: Quad) {
  const map = squareToQuad(quad);
  if (!map) invalidQuad('projective determinant is zero');
  if (!map.every(Number.isFinite)) invalidQuad('projective map must be finite');
  const denominators = [1, 1 + map[6], 1 + map[7], 1 + map[6] + map[7]];
  if (denominators.some(value => !Number.isFinite(value) || value <= 1e-9)) {
    invalidQuad('projective denominator crosses zero');
  }
  // 检测器预热完成后复用同一 OpenCV WASM；未就绪时保留连续的 JS 回退，渲染不触发 10MB 加载。
  const cv = (window as any).cv;
  if (cv?.Mat && cv.matFromImageData && cv.getPerspectiveTransform && cv.warpPerspective && cv.imshow) {
    warpPerspectiveOpenCV(cv, source, destination, quad);
    return;
  }
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

function warpedSize(quad: Quad, rotation: number, outWidth: number, label = 'Page Scan') {
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const width = Math.max(1, Math.round((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2));
  const height = Math.max(1, Math.round((dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2));
  const swap = rotation === 90 || rotation === 270;
  const outputWidth = swap ? Math.round(outWidth * height / width) : outWidth;
  const outputHeight = swap
    ? Math.round(outputWidth * width / height)
    : Math.round(outputWidth * height / width);
  return validateOutputCanvasSize({
    width: Math.max(16, outputWidth),
    height: Math.max(16, outputHeight),
  }, label);
}

function rotatedOutputSize(size: OutputCanvasSize, rotation: number, label: string) {
  return validateOutputCanvasSize(rotation % 180 === 0
    ? size
    : { width: size.height, height: size.width }, label);
}

function sourceCropSize(bbox: OutputCanvasSize, destination: OutputCanvasSize) {
  let width = Math.min(bbox.width, Math.ceil(destination.width * SOURCE_CROP_SUPERSAMPLE));
  let height = Math.min(bbox.height, Math.ceil(destination.height * SOURCE_CROP_SUPERSAMPLE));
  const fit = Math.min(
    1,
    MAX_OUTPUT_CANVAS_DIMENSION / width,
    MAX_OUTPUT_CANVAS_DIMENSION / height,
    Math.sqrt(MAX_OUTPUT_CANVAS_PIXELS / (width * height)),
  );
  if (fit < 1) {
    width = Math.max(1, Math.floor(width * fit));
    height = Math.max(1, Math.floor(height * fit));
  }
  return validateOutputCanvasSize({ width, height }, 'Page source crop');
}

// 透视校正: quad(原图坐标系)→ 输出画布;支持 rotation/enhancement
export async function warpPage(p: Page, outWidth = 900): Promise<HTMLCanvasElement> {
  const img = await loadImage(p.originalBlob, p.id);
  const sourceWidth = p.originalW || img.naturalWidth;
  const sourceHeight = p.originalH || img.naturalHeight;
  const quad = p.quad;
  validateQuad(quad, sourceWidth, sourceHeight);
  const rot = p.rotation % 360;
  const size = warpedSize(quad, rot, outWidth);
  const left = Math.max(0, Math.floor(Math.min(...quad.map(point => point[0]))));
  const top = Math.max(0, Math.floor(Math.min(...quad.map(point => point[1]))));
  const right = Math.min(sourceWidth, Math.ceil(Math.max(...quad.map(point => point[0]))) + 1);
  const bottom = Math.min(sourceHeight, Math.ceil(Math.max(...quad.map(point => point[1]))) + 1);
  const bboxWidth = Math.max(1, right - left);
  const bboxHeight = Math.max(1, bottom - top);
  const sourceSize = sourceCropSize({ width: bboxWidth, height: bboxHeight }, size);
  const sourceScaleX = sourceSize.width / bboxWidth;
  const sourceScaleY = sourceSize.height / bboxHeight;
  const croppedQuad = quad.map(point => [
    (point[0] - left) * sourceScaleX,
    (point[1] - top) * sourceScaleY,
  ] as [number, number]);
  const { canvas: src, context: sourceContext } = createOutputCanvas(sourceSize, 'Page source crop', true);
  sourceContext.fillStyle = '#fff'; sourceContext.fillRect(0, 0, src.width, src.height);
  sourceContext.drawImage(
    img,
    -left * sourceScaleX,
    -top * sourceScaleY,
    sourceWidth * sourceScaleX,
    sourceHeight * sourceScaleY,
  );

  const { canvas: c, context: x } = createOutputCanvas(size, 'Page Scan', p.enhancement !== 'original');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  warpPerspective(src, c, croppedQuad);
  applyEnhancement(c, p.enhancement);

  if (rot) {
    const rotatedSize = rotatedOutputSize(size, rot, 'Rotated Page Scan');
    const { canvas: r, context: rx } = createOutputCanvas(rotatedSize, 'Rotated Page Scan');
    rx.translate(r.width / 2, r.height / 2);
    rx.rotate(rot * Math.PI / 180);
    rx.drawImage(c, -c.width / 2, -c.height / 2);
    return r;
  }
  return c;
}

// 长图: 等宽垂直拼接(E3,板书场景)
export async function stitchLongImage(pages: Page[], width = 900): Promise<HTMLCanvasElement> {
  if (!pages.length) invalidOutputCanvas('Long Image Outfit', { width: 0, height: 0 }, 'at least one Page is required');
  const sizes = pages.map((page, index) => {
    validateQuad(page.quad, page.originalW, page.originalH);
    const rotation = page.rotation % 360;
    const perspectiveSize = warpedSize(page.quad, rotation, width, `Long Image Page ${index + 1}`);
    return rotatedOutputSize(perspectiveSize, rotation, `Long Image Page ${index + 1}`);
  });
  const w = Math.min(...sizes.map(size => size.width));
  const h = sizes.reduce((total, size) => total + Math.round(size.height * w / size.width), 0);
  const outputSize = validateOutputCanvasSize({ width: w, height: h }, 'Long Image Outfit');
  const { canvas: out, context: x } = createOutputCanvas(outputSize, 'Long Image Outfit');
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  let y = 0;
  // 最终长图 + 当前页同时驻留；不保留所有中间页 canvas。
  for (const page of pages) {
    const c = await warpPage(page, width);
    const hh = Math.round(c.height * w / c.width);
    x.drawImage(c, 0, y, w, hh);
    y += hh;
    c.width = 1;
    c.height = 1;
  }
  return out;
}

export function quadPath(x: CanvasRenderingContext2D, q: Quad | number[][]) {
  x.beginPath(); x.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < 4; i++) x.lineTo(q[i][0], q[i][1]);
  x.closePath();
}
