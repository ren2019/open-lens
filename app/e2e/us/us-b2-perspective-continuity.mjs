import { checks, openApp } from '../lib/harness.mjs';

const t = checks('US-B2');
const session = await openApp({ cv: 'real', viewport: { width: 800, height: 600 } });

try {
  const metrics = await session.page.evaluate(async () => {
    const { loadOpenCV } = await import('/src/detector.ts');
    const { warpPage } = await import('/src/imaging.ts');
    const source = document.createElement('canvas');
    source.width = 800;
    source.height = 720;
    const sourceContext = source.getContext('2d', { colorSpace: 'srgb' });
    const sourcePixels = sourceContext.createImageData(source.width, source.height);

    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const offset = (y * source.width + x) * 4;
        const phase = y % 80;
        sourcePixels.data[offset] = 20 + (phase <= 40 ? phase : 80 - phase) * 5;
        sourcePixels.data[offset + 1] = x % 32 < 2 ? 0 : Math.round(x * 255 / (source.width - 1));
        sourcePixels.data[offset + 2] = x % 40 < 2 || y % 24 < 2 ? 0 : 210;
        sourcePixels.data[offset + 3] = 255;
      }
    }
    sourceContext.putImageData(sourcePixels, 0, 0);
    const originalBlob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    const page = {
      id: 'us-b2-perspective-continuity',
      originalBlob,
      originalW: source.width,
      originalH: source.height,
      quad: [[100, 50], [700, 70], [710, 660], [100, 449]],
      enhancement: 'original',
      rotation: 0,
      edited: true,
      detectMeta: null,
    };
    const cv = await loadOpenCV();
    await warpPage(page, 64);
    let wasmSourceSize = null;
    const matFromImageData = cv?.matFromImageData;
    if (cv) cv.matFromImageData = image => {
      wasmSourceSize ??= { width: image.width, height: image.height };
      return matFromImageData(image);
    };
    const startedAt = performance.now();
    let warped;
    try {
      warped = await warpPage(page, 1400);
    } finally {
      if (cv) cv.matFromImageData = matFromImageData;
    }
    const wasmDurationMs = performance.now() - startedAt;
    const globalCv = window.cv;
    window.cv = undefined;
    const fallbackStartedAt = performance.now();
    let fallback;
    try {
      fallback = await warpPage(page, 1400);
    } finally {
      window.cv = globalCv;
    }
    const fallbackDurationMs = performance.now() - fallbackStartedAt;
    const fallbackCenterPixel = [...fallback.getContext('2d').getImageData(700, 556, 1, 1).data.slice(0, 3)];
    fallback.width = 1;
    fallback.height = 1;
    const output = warped.getContext('2d').getImageData(0, 0, warped.width, warped.height).data;
    const centerOffset = (556 * warped.width + 700) * 4;

    const columnMetrics = ratio => {
      const x = Math.round((warped.width - 1) * ratio);
      const differences = [];
      for (let y = 1; y < warped.height; y++) {
        const previous = output[((y - 1) * warped.width + x) * 4];
        const current = output[(y * warped.width + x) * 4];
        differences.push(Math.abs(current - previous));
      }
      const seamRows = new Set();
      for (let band = 1; band < 48; band++) {
        const boundary = Math.round(band * warped.height / 48);
        for (let delta = -2; delta <= 2; delta++) seamRows.add(boundary + delta);
      }
      const seam = differences.filter((_, index) => seamRows.has(index + 1));
      const regular = differences.filter((_, index) => !seamRows.has(index + 1)).sort((a, b) => a - b);
      return {
        x,
        maxSeam: Math.max(...seam),
        regularP95: regular[Math.floor((regular.length - 1) * 0.95)],
      };
    };

    const rotationSource = document.createElement('canvas');
    rotationSource.width = 80;
    rotationSource.height = 60;
    const rotationContext = rotationSource.getContext('2d');
    for (const [color, x, y] of [
      ['#f00', 0, 0], ['#0f0', 40, 0], ['#00f', 0, 30], ['#ff0', 40, 30],
    ]) {
      rotationContext.fillStyle = color;
      rotationContext.fillRect(x, y, 40, 30);
    }
    const rotationBlob = await new Promise(resolve => rotationSource.toBlob(resolve, 'image/png'));
    const rotationTopLeft = {};
    for (const rotation of [0, 90, 180, 270]) {
      const canvas = await warpPage({
        id: 'us-b2-rotation',
        originalBlob: rotationBlob,
        originalW: 80,
        originalH: 60,
        quad: [[0, 0], [79, 0], [79, 59], [0, 59]],
        enhancement: 'original',
        rotation,
        edited: false,
        detectMeta: null,
      }, 80);
      rotationTopLeft[rotation] = [...canvas.getContext('2d').getImageData(8, 8, 1, 1).data.slice(0, 3)];
    }

    const invalidQuadErrors = {};
    for (const [name, quad] of Object.entries({
      coincident: [[100, 50], [100, 50], [710, 660], [100, 449]],
      collapsed: [[100, 50], [300, 50], [500, 50], [700, 50]],
      crossed: [[100, 50], [710, 660], [700, 70], [100, 449]],
      bounds: [[-1, 50], [700, 70], [710, 660], [100, 449]],
      nonFinite: [[Number.NaN, 50], [700, 70], [710, 660], [100, 449]],
    })) {
      try {
        await warpPage({
          id: `us-b2-invalid-${name}`,
          originalBlob,
          originalW: source.width,
          originalH: source.height,
          quad,
          enhancement: 'original',
          rotation: 0,
          edited: true,
          detectMeta: null,
        }, 1400);
        invalidQuadErrors[name] = null;
      } catch (error) {
        invalidQuadErrors[name] = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      width: warped.width,
      height: warped.height,
      cvAvailable: !!cv,
      wasmSourceSize,
      wasmDurationMs: Math.round(wasmDurationMs),
      fallbackDurationMs: Math.round(fallbackDurationMs),
      centerPixel: [...output.slice(centerOffset, centerOffset + 3)],
      fallbackCenterPixel,
      rotationTopLeft,
      invalidQuadErrors,
      left: columnMetrics(0.15),
      middle: columnMetrics(0.5),
      right: columnMetrics(0.85),
    };
  });

  t.check('1400×1112 Scan 尺寸遵循四边长度规则', metrics.width === 1400 && metrics.height === 1112,
    `${metrics.width}x${metrics.height}`);
  t.check('单一透视映射命中独立参考中心像素', metrics.centerPixel.every((value, index) =>
    Math.abs(value - [146, 110, 210][index]) <= 2)
    && metrics.fallbackCenterPixel.every((value, index) => Math.abs(value - [146, 110, 210][index]) <= 2),
  `WASM=${JSON.stringify(metrics.centerPixel)} JS=${JSON.stringify(metrics.fallbackCenterPixel)}`);
  t.check('1400×1112 连续透视使用现有 WASM 路径且明显快于 JS 回退', metrics.cvAvailable
    && metrics.wasmDurationMs * 1.5 <= metrics.fallbackDurationMs,
  `WASM=${metrics.wasmDurationMs}ms JS=${metrics.fallbackDurationMs}ms`);
  t.check('WASM 只复制 quad 包围盒而非整张 Original', metrics.wasmSourceSize
    && metrics.wasmSourceSize.width * metrics.wasmSourceSize.height <= 800 * 720 * 0.7,
  `sourceMat=${metrics.wasmSourceSize?.width}x${metrics.wasmSourceSize?.height} Original=800x720`);
  const seamTolerance = 2;
  const seamFailures = ['left', 'middle', 'right'].flatMap(column => {
    const { maxSeam, regularP95 } = metrics[column];
    return maxSeam <= regularP95 + seamTolerance
      ? []
      : [`${column}: maxSeam=${maxSeam} > regularP95=${regularP95} + tolerance=${seamTolerance}`];
  });
  t.check('明显非对称透视在左中右全宽无固定间隔接缝', seamFailures.length === 0,
    seamFailures.length ? seamFailures.join('; ') : JSON.stringify({
      left: metrics.left,
      middle: metrics.middle,
      right: metrics.right,
      tolerance: seamTolerance,
    }));
  const invalidQuadFailures = Object.entries(metrics.invalidQuadErrors)
    .filter(([, message]) => !message?.startsWith('Invalid quad:'))
    .map(([name, message]) => `${name}: ${message ?? 'warpPage resolved instead of rejecting'}`);
  t.check('退化/交叉/越界/非有限 quad 在渲染前被明确拒绝', invalidQuadFailures.length === 0,
    invalidQuadFailures.length ? invalidQuadFailures.join('; ') : JSON.stringify(metrics.invalidQuadErrors));
  t.check('0/90/180/270 度旋转保持角点方向', JSON.stringify(metrics.rotationTopLeft) === JSON.stringify({
    0: [255, 0, 0],
    90: [0, 0, 255],
    180: [255, 255, 0],
    270: [0, 255, 0],
  }), JSON.stringify(metrics.rotationTopLeft));
} finally {
  await session.browser.close();
}

t.finish();
