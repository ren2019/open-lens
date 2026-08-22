import { checks, openApp } from '../lib/harness.mjs';

const t = checks('US-B2');
const session = await openApp({ cv: 'real', viewport: { width: 800, height: 600 } });
const pageErrors = [];
session.page.on('pageerror', error => pageErrors.push(error.message));

try {
  const metrics = await session.page.evaluate(async () => {
    const { loadOpenCV } = await import('/src/detector.ts');
    const { stitchLongImage, warpPage } = await import('/src/imaging.ts');
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

    const guardCanvasAllocations = async run => {
      const canvasPrototype = HTMLCanvasElement.prototype;
      const widthDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'width');
      const heightDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'height');
      const createElement = document.createElement;
      const allocationAttempts = [];
      const canvasAllocations = [];
      let canvasCreations = 0;
      const guardedDescriptor = (dimension, descriptor) => ({
        ...descriptor,
        set(value) {
          const width = dimension === 'width' ? Number(value) : widthDescriptor.get.call(this);
          const height = dimension === 'height' ? Number(value) : heightDescriptor.get.call(this);
          if (width > 32_767 || height > 32_767 || width * height > 16_777_216) {
            allocationAttempts.push({ width, height });
            throw new Error(`test blocked giant canvas allocation: ${width}x${height}`);
          }
          descriptor.set.call(this, value);
          canvasAllocations.push({
            width: widthDescriptor.get.call(this),
            height: heightDescriptor.get.call(this),
          });
        },
      });
      Object.defineProperty(canvasPrototype, 'width', guardedDescriptor('width', widthDescriptor));
      Object.defineProperty(canvasPrototype, 'height', guardedDescriptor('height', heightDescriptor));
      document.createElement = (name, options) => {
        if (String(name).toLowerCase() === 'canvas') canvasCreations++;
        return createElement.call(document, name, options);
      };
      let error = null;
      let value = null;
      try {
        value = await run();
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        document.createElement = createElement;
        Object.defineProperty(canvasPrototype, 'width', widthDescriptor);
        Object.defineProperty(canvasPrototype, 'height', heightDescriptor);
      }
      const largestAllocation = canvasAllocations.reduce((largest, allocation) =>
        allocation.width * allocation.height > largest.width * largest.height ? allocation : largest,
      { width: 0, height: 0 });
      return { error, allocationAttempts, canvasCreations, largestAllocation, value };
    };

    const largeSource = document.createElement('canvas');
    largeSource.width = 200;
    largeSource.height = 10;
    const largeSourceContext = largeSource.getContext('2d');
    const largeSourcePixels = largeSourceContext.createImageData(largeSource.width, largeSource.height);
    for (let y = 0; y < largeSource.height; y++) {
      for (let x = 0; x < largeSource.width; x++) {
        const offset = (y * largeSource.width + x) * 4;
        largeSourcePixels.data[offset] = Math.round(x * 255 / (largeSource.width - 1));
        largeSourcePixels.data[offset + 1] = Math.round(y * 255 / (largeSource.height - 1));
        largeSourcePixels.data[offset + 2] = 210;
        largeSourcePixels.data[offset + 3] = 255;
      }
    }
    largeSourceContext.putImageData(largeSourcePixels, 0, 0);
    const largeSourceBlob = await new Promise(resolve => largeSource.toBlob(resolve, 'image/png'));
    const largePage = {
      ...page,
      id: 'us-b2-large-source-bbox',
      originalBlob: largeSourceBlob,
      originalW: 20_000,
      originalH: 1_000,
      quad: [[0, 0], [19_999, 0], [19_999, 999], [0, 999]],
    };
    const largeSourceBBox = await guardCanvasAllocations(async () => {
      let largeWasmSourceSize = null;
      const largeMatFromImageData = cv?.matFromImageData;
      if (cv) cv.matFromImageData = image => {
        largeWasmSourceSize ??= { width: image.width, height: image.height };
        return largeMatFromImageData(image);
      };
      let wasmCanvas;
      try {
        wasmCanvas = await warpPage(largePage, 900);
      } finally {
        if (cv) cv.matFromImageData = largeMatFromImageData;
      }
      const savedCv = window.cv;
      window.cv = undefined;
      let jsCanvas;
      try {
        jsCanvas = await warpPage(largePage, 900);
      } finally {
        window.cv = savedCv;
      }
      const wasmPixels = wasmCanvas.getContext('2d').getImageData(0, 0, wasmCanvas.width, wasmCanvas.height).data;
      const jsPixels = jsCanvas.getContext('2d').getImageData(0, 0, jsCanvas.width, jsCanvas.height).data;
      const centerRow = Math.floor(wasmCanvas.height / 2);
      const samples = [0, 0.5, 1].map(ratio => {
        const x = Math.round((wasmCanvas.width - 1) * ratio);
        const offset = (centerRow * wasmCanvas.width + x) * 4;
        return {
          ratio,
          wasm: [...wasmPixels.slice(offset, offset + 3)],
          js: [...jsPixels.slice(offset, offset + 3)],
        };
      });
      let maxHorizontalJump = 0;
      for (let x = 1; x < wasmCanvas.width; x++) {
        const previous = wasmPixels[(centerRow * wasmCanvas.width + x - 1) * 4];
        const current = wasmPixels[(centerRow * wasmCanvas.width + x) * 4];
        maxHorizontalJump = Math.max(maxHorizontalJump, Math.abs(current - previous));
      }
      return {
        width: wasmCanvas.width,
        height: wasmCanvas.height,
        largeWasmSourceSize,
        samples,
        maxHorizontalJump,
      };
    });

    const qualitySource = document.createElement('canvas');
    qualitySource.width = 1600;
    qualitySource.height = 1200;
    const qualitySourceContext = qualitySource.getContext('2d');
    qualitySourceContext.fillStyle = '#fff';
    qualitySourceContext.fillRect(0, 0, qualitySource.width, qualitySource.height);
    qualitySourceContext.fillStyle = '#000';
    for (let y = 18; y < qualitySource.height - 18; y += 10)
      qualitySourceContext.fillRect(18, y, qualitySource.width - 36, 2);
    for (let x = 22; x < qualitySource.width - 22; x += 14)
      qualitySourceContext.fillRect(x, 18, 2, qualitySource.height - 36);
    const qualityBlob = await new Promise(resolve => qualitySource.toBlob(resolve, 'image/png'));
    const qualityCv = window.cv;
    window.cv = undefined;
    let qualityCanvas;
    try {
      qualityCanvas = await warpPage({
        ...page,
        id: 'us-b2-high-frequency-quality',
        originalBlob: qualityBlob,
        originalW: qualitySource.width,
        originalH: qualitySource.height,
        quad: [[50, 40], [1550, 90], [1500, 1160], [80, 1120]],
      }, 600);
    } finally {
      window.cv = qualityCv;
    }
    const qualityPixels = qualityCanvas.getContext('2d')
      .getImageData(0, 0, qualityCanvas.width, qualityCanvas.height).data;
    const qualityLuma = new Float64Array(qualityCanvas.width * qualityCanvas.height);
    let qualityPixelHash = 2166136261;
    for (let pixel = 0, offset = 0; offset < qualityPixels.length; pixel++, offset += 4) {
      qualityLuma[pixel] = qualityPixels[offset] * 0.2126
        + qualityPixels[offset + 1] * 0.7152 + qualityPixels[offset + 2] * 0.0722;
      for (let channel = 0; channel < 3; channel++) {
        qualityPixelHash ^= qualityPixels[offset + channel];
        qualityPixelHash = Math.imul(qualityPixelHash, 16777619);
      }
    }
    let horizontalEdgeTotal = 0;
    let horizontalEdgeCount = 0;
    let verticalEdgeTotal = 0;
    let verticalEdgeCount = 0;
    let laplacianTotal = 0;
    let laplacianCount = 0;
    const qualityRowDifferences = [];
    for (let y = 0; y < qualityCanvas.height; y++) {
      let rowDifference = 0;
      for (let x = 0; x < qualityCanvas.width; x++) {
        const index = y * qualityCanvas.width + x;
        if (x > 0) {
          horizontalEdgeTotal += Math.abs(qualityLuma[index] - qualityLuma[index - 1]);
          horizontalEdgeCount++;
        }
        if (y > 0) {
          const difference = Math.abs(qualityLuma[index] - qualityLuma[index - qualityCanvas.width]);
          verticalEdgeTotal += difference;
          verticalEdgeCount++;
          rowDifference += difference;
        }
        if (x > 0 && x < qualityCanvas.width - 1 && y > 0 && y < qualityCanvas.height - 1) {
          laplacianTotal += Math.abs(4 * qualityLuma[index] - qualityLuma[index - 1] - qualityLuma[index + 1]
            - qualityLuma[index - qualityCanvas.width] - qualityLuma[index + qualityCanvas.width]);
          laplacianCount++;
        }
      }
      if (y > 0) qualityRowDifferences.push(rowDifference / qualityCanvas.width);
    }
    const qualitySeamRows = new Set();
    for (let band = 1; band < 48; band++) {
      const boundary = Math.round(band * qualityCanvas.height / 48);
      for (let delta = -2; delta <= 2; delta++) qualitySeamRows.add(boundary + delta);
    }
    const qualitySeam = qualityRowDifferences.filter((_, index) => qualitySeamRows.has(index + 1));
    const qualityRegular = qualityRowDifferences
      .filter((_, index) => !qualitySeamRows.has(index + 1)).sort((a, b) => a - b);
    const highFrequencyQuality = {
      width: qualityCanvas.width,
      height: qualityCanvas.height,
      pixelHash: qualityPixelHash >>> 0,
      horizontalEdgeEnergy: horizontalEdgeTotal / horizontalEdgeCount,
      verticalEdgeEnergy: verticalEdgeTotal / verticalEdgeCount,
      laplacianEnergy: laplacianTotal / laplacianCount,
      maxSeam: Math.max(...qualitySeam),
      regularP95: qualityRegular[Math.floor((qualityRegular.length - 1) * 0.95)],
    };

    const canvasPrototype = HTMLCanvasElement.prototype;
    const getContext = canvasPrototype.getContext;
    let nullContextError = null;
    canvasPrototype.getContext = () => null;
    try {
      await warpPage({ ...page, id: 'us-b2-null-source-context' }, 64);
    } catch (error) {
      nullContextError = error instanceof Error ? error.message : String(error);
    } finally {
      canvasPrototype.getContext = getContext;
    }

    const tallSource = document.createElement('canvas');
    tallSource.width = 4;
    tallSource.height = 2560;
    tallSource.getContext('2d').fillRect(0, 0, tallSource.width, tallSource.height);
    const tallBlob = await new Promise(resolve => tallSource.toBlob(resolve, 'image/png'));
    const nearDegenerateOutput = await guardCanvasAllocations(() => warpPage({
      ...page,
      id: 'us-b2-near-degenerate-output',
      originalBlob: tallBlob,
      originalW: 4,
      originalH: 2560,
      quad: [[1, 0], [2, 0], [2, 2560], [1, 2560]],
    }, 1400));

    const invalidLongPage = await guardCanvasAllocations(() => stitchLongImage([
      { ...page, id: 'us-e3-preflight-valid' },
      {
        ...page,
        id: 'us-e3-preflight-crossed',
        quad: [[100, 50], [710, 660], [700, 70], [100, 449]],
      },
    ], 900));

    const squarePage = {
      ...page,
      quad: [[100, 50], [700, 50], [700, 650], [100, 650]],
    };
    const oversizedLongOutput = await guardCanvasAllocations(() => stitchLongImage(
      Array.from({ length: 21 }, (_, index) => ({ ...squarePage, id: `us-e3-oversized-${index}` })),
      900,
    ));

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
      highFrequencyQuality,
      canvasBudgets: {
        largeSourceBBox,
        nullContextError,
        nearDegenerateOutput,
        invalidLongPage,
        oversizedLongOutput,
      },
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
  t.check('lockfile OpenCV asset 加载期间无 pageerror', pageErrors.length === 0,
    pageErrors.length ? pageErrors.join('; ') : 'none');
  t.check('WASM 只复制 quad 包围盒而非整张 Original', metrics.wasmSourceSize
    && metrics.wasmSourceSize.width * metrics.wasmSourceSize.height <= 800 * 720 * 0.7,
  `sourceMat=${metrics.wasmSourceSize?.width}x${metrics.wasmSourceSize?.height} Original=800x720`);
  const largeSource = metrics.canvasBudgets.largeSourceBBox;
  const largeSourceSamplesValid = largeSource.value?.samples.every(({ ratio, wasm, js }) => {
    const expectedRed = Math.round(ratio * 255);
    return Math.abs(wasm[0] - expectedRed) <= 2
      && wasm.every((value, index) => Math.abs(value - js[index]) <= 2);
  });
  t.check('大 Original bbox 在透视前按质量保真上限降采样且保持连续输出', largeSource.error === null
    && largeSource.allocationAttempts.length === 0
    && largeSource.value?.width === 900 && largeSource.value?.height === 45
    && largeSource.value?.largeWasmSourceSize?.width === 2700
    && largeSource.value?.largeWasmSourceSize?.height === 135
    && largeSource.largestAllocation.width * largeSource.largestAllocation.height <= 16_777_216
    && largeSource.value?.maxHorizontalJump <= 2
    && largeSourceSamplesValid,
  JSON.stringify(largeSource));
  const quality = metrics.highFrequencyQuality;
  t.check('高频非对称透视保持连续 warp 的像素与锐度基线', quality.width === 600 && quality.height === 442
    && quality.pixelHash === 2893324608
    && Math.abs(quality.horizontalEdgeEnergy - 58.350195272664095) < 0.001
    && Math.abs(quality.verticalEdgeEnergy - 84.72072184429328) < 0.001
    && Math.abs(quality.laplacianEnergy - 262.14201505016723) < 0.001
    && Math.abs(quality.maxSeam - 93.97666666666667) < 0.001
    && Math.abs(quality.regularP95 - 91.395) < 0.001,
  JSON.stringify(quality));
  t.check('source crop 的 2d context 缺失时返回可诊断错误',
    metrics.canvasBudgets.nullContextError
      === 'Invalid output canvas: Page source crop 192x153; 2d context unavailable',
  metrics.canvasBudgets.nullContextError ?? 'warpPage resolved instead of rejecting');
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
  t.check('近退化高宽比 Page 在巨型 Scan 分配前被拒绝',
    metrics.canvasBudgets.nearDegenerateOutput.error?.startsWith('Invalid output canvas:')
      && metrics.canvasBudgets.nearDegenerateOutput.error.includes('1400x3584000')
      && metrics.canvasBudgets.nearDegenerateOutput.error.includes('32767')
      && metrics.canvasBudgets.nearDegenerateOutput.allocationAttempts.length === 0,
    JSON.stringify(metrics.canvasBudgets.nearDegenerateOutput));
  t.check('长图在任一非法 Page 存在时不预分配输出 canvas',
    metrics.canvasBudgets.invalidLongPage.error?.startsWith('Invalid quad:')
      && metrics.canvasBudgets.invalidLongPage.canvasCreations === 0,
    JSON.stringify(metrics.canvasBudgets.invalidLongPage), 'US-E3');
  t.check('超像素预算多页长图在巨型 canvas 分配前被拒绝',
    metrics.canvasBudgets.oversizedLongOutput.error?.startsWith('Invalid output canvas:')
      && metrics.canvasBudgets.oversizedLongOutput.error.includes('900x18900')
      && metrics.canvasBudgets.oversizedLongOutput.error.includes('17010000')
      && metrics.canvasBudgets.oversizedLongOutput.error.includes('16777216')
      && metrics.canvasBudgets.oversizedLongOutput.allocationAttempts.length === 0,
    JSON.stringify(metrics.canvasBudgets.oversizedLongOutput), 'US-E3');
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
