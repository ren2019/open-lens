import { checks, openApp } from '../lib/harness.mjs';

const t = checks('US-B2');
const session = await openApp({ viewport: { width: 800, height: 600 } });

try {
  const metrics = await session.page.evaluate(async () => {
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
    const startedAt = performance.now();
    const warped = await warpPage({
      id: 'us-b2-perspective-continuity',
      originalBlob,
      originalW: source.width,
      originalH: source.height,
      quad: [[100, 50], [700, 70], [710, 660], [100, 449]],
      enhancement: 'original',
      rotation: 0,
      edited: true,
      detectMeta: null,
    }, 1400);
    const durationMs = performance.now() - startedAt;
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

    return {
      width: warped.width,
      height: warped.height,
      durationMs: Math.round(durationMs),
      centerPixel: [...output.slice(centerOffset, centerOffset + 3)],
      rotationTopLeft,
      left: columnMetrics(0.15),
      middle: columnMetrics(0.5),
      right: columnMetrics(0.85),
    };
  });

  t.check('1400×1112 Scan 尺寸遵循四边长度规则', metrics.width === 1400 && metrics.height === 1112,
    `${metrics.width}x${metrics.height}`);
  t.check('单一透视映射命中独立参考中心像素', metrics.centerPixel.every((value, index) =>
    Math.abs(value - [146, 110, 210][index]) <= 2), JSON.stringify(metrics.centerPixel));
  const continuous = metrics.right.maxSeam <= metrics.right.regularP95 + 2
    && metrics.right.maxSeam <= metrics.left.maxSeam + 2;
  t.check('明显非对称透视在左中右全宽无固定间隔接缝', continuous, JSON.stringify(metrics));
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
