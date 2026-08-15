// detector.js — port of OSS-DocumentScanner's DocumentDetector (MIT, (c) akylas / ossappscollective)
// Source: cpp/src/DocumentDetector.cpp — classical OpenCV cascade, NO ML weights.
// Faithful port of scanPoint(): threshold pass + multi-level Canny per RGB channel,
// early exit, weighted square scoring. OpenCV.js adaptation: explicit Mat lifecycle.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OSSDetector = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULTS = {
    borderSize: 10,
    cannyFactor: 2.0,
    morphologyAnchorSize: 4,
    dilateAnchorSize: 3,
    thresh: 160,
    threshMax: 256,
    medianBlurValue: 9,
    contoursApproxEpsilonFactor: 0.02,
    expectedMaxCosine: 0.4,
    expectedOptimalMaxCosine: 0.3,
    expectedAreaFactor: 0.20,
    areaScaleMinFactor: 0.04,
    minDistanceFromBorderFactor: 0.0,
    resizeThreshold: 500,
    // 便捷模式(非上游): fast=true 只跑灰度通道 + 精简 Canny 档位, 用于实时取景
    fast: false,
  };

  function angleCos(p1, p2, p0) {
    const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
    const dx2 = p2.x - p0.x, dy2 = p2.y - p0.y;
    return (dx1 * dx2 + dy1 * dy2) /
      Math.sqrt((dx1 * dx1 + dy1 * dy1) * (dx2 * dx2 + dy2 * dy2) + 1e-10);
  }

  // 上游 sortPoints: 按 y 排,前两按 x 升,后两按 x 降 → [tl, tr, br, bl]
  function sortPoints(pts) {
    pts.sort((a, b) => a.y - b.y);
    const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = pts.slice(2).sort((a, b) => b.x - a.x);
    return [top[0], top[1], bottom[0], bottom[1]];
  }

  function findSquares(cv, edges, width, height, squares, weight, o) {
    const marge = Math.floor(width * o.minDistanceFromBorderFactor) + o.borderSize;
    const contours = new cv.MatVector(), hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    // 按面积降序(上游 compareContourAreas)
    const idx = [];
    for (let i = 0; i < contours.size(); i++) idx.push(i);
    const areas = idx.map(i => {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      c.delete();
      return a;
    });
    idx.sort((a, b) => areas[b] - areas[a]);

    const maxAllowedArea = (width - 2 * o.borderSize) * (height - 2 * o.borderSize) * 0.92;
    const minArea = width * height * o.areaScaleMinFactor;

    for (const i of idx) {
      const contour = contours.get(i);
      const peri = cv.arcLength(contour, true);
      const area = areas[i];
      if (peri < 100 || area < minArea || area >= maxAllowedArea) { contour.delete(); continue; }

      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, peri * o.contoursApproxEpsilonFactor, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = [];
        for (let j = 0; j < 4; j++) {
          const p = approx.intPtr(j, 0); // NOTE: 数据布局 [4,1] int32
          pts.push({ x: p[0], y: p[1] });
        }
        const touchesBorder = pts.some(p =>
          p.x < marge || p.x >= width - marge || p.y < marge || p.y >= height - marge);
        if (!touchesBorder) {
          let maxCos = 0, meanCos = 0;
          for (let j = 2; j < 6; j++) {
            const c = Math.abs(angleCos(pts[j % 4], pts[j - 2], pts[(j - 1) % 4]));
            maxCos = Math.max(maxCos, c); meanCos += c;
          }
          if (maxCos < o.expectedMaxCosine) {
            squares.push({ quad: pts, area, maxCos, meanCos: meanCos / 4, weight });
          }
        }
      }
      approx.delete(); contour.delete();
    }
    contours.delete(); hierarchy.delete();
  }

  function bestSquare(squares) {
    if (!squares.length) return null;
    // 上游: area + weight * (1 - maxCos), 取最大
    let best = null, bestScore = -Infinity;
    for (const s of squares) {
      const score = s.area + s.weight * (1 - s.maxCos);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /**
   * detect(mat, opts?) → { quad: [{x,y}×4]|[tl,tr,br,bl] | null, ms, squares, iterations }
   * quad 坐标已映射回 mat 原始分辨率。
   */
  function detect(cv, srcMat, userOpts) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const o = Object.assign({}, DEFAULTS, userOpts || {});
    let iterations = 0;

    // --- resize: 长边 → resizeThreshold, 加黑边 borderSize ---
    const W0 = srcMat.cols, H0 = srcMat.rows;
    const aspect = Math.max(W0, H0) / o.resizeThreshold;
    const resizeScale = aspect > 1 ? aspect : 1;
    const W = Math.max(1, Math.floor(W0 / resizeScale)) + 2 * o.borderSize;
    const H = Math.max(1, Math.floor(H0 / resizeScale)) + 2 * o.borderSize;
    const img = new cv.Mat();
    cv.resize(srcMat, img, new cv.Size(W - 2 * o.borderSize, H - 2 * o.borderSize));
    const bordered = new cv.Mat();
    cv.copyMakeBorder(img, bordered, o.borderSize, o.borderSize, o.borderSize, o.borderSize,
      cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
    img.delete();

    // --- median blur ---
    const blurred = new cv.Mat();
    if (o.medianBlurValue > 0) cv.medianBlur(bordered, blurred, o.medianBlurValue);
    else bordered.copyTo(blurred);
    bordered.delete();

    // --- 通道循环: fast 模式只跑灰度; 否则 R/G/B(ch 2→0) ---
    const channels = o.fast ? [null] : [2, 1, 0];
    const squares = [];
    const work = new cv.Mat();
    const edged = new cv.Mat();
    const closeK = cv.getStructuringElement(cv.MORPH_RECT,
      new cv.Size(Math.max(1, o.morphologyAnchorSize | 0), Math.max(1, o.morphologyAnchorSize | 0)));
    const dilateK = cv.getStructuringElement(cv.MORPH_RECT,
      new cv.Size(Math.max(1, o.dilateAnchorSize | 0), Math.max(1, o.dilateAnchorSize | 0)));
    const cannyLevels = o.fast ? [60, 40] : [60, 50, 40, 30, 20, 10];
    let weight = 3000000;
    let done = false;

    try {
      for (let ci = 0; ci < channels.length && !done; ci++) {
        if (o.fast) cv.cvtColor(blurred, work, cv.COLOR_RGBA2GRAY);
        else if (cv.extractChannel) cv.extractChannel(blurred, work, channels[ci]);
        else { const ch = new cv.MatVector(); cv.split(blurred, ch); ch.get(channels[ci]).copyTo(work); ch.delete(); }

        // pass 1: threshold
        cv.threshold(work, edged, o.thresh, o.threshMax, cv.THRESH_BINARY);
        cv.morphologyEx(edged, edged, cv.MORPH_CLOSE, closeK);
        cv.dilate(edged, edged, dilateK);
        findSquares(cv, edged, W, H, squares, weight--, o);
        iterations++;
        let b = bestSquare(squares);
        if (b && b.maxCos < o.expectedOptimalMaxCosine && b.area > W * H * o.expectedAreaFactor) break;

        // pass 2+: canny 从严到松
        for (const t of cannyLevels) {
          cv.Canny(work, edged, t * o.cannyFactor, o.cannyFactor * t * 2);
          cv.dilate(edged, edged, dilateK);
          findSquares(cv, edged, W, H, squares, weight--, o);
          iterations++;
          b = bestSquare(squares);
          if (b && b.maxCos < o.expectedOptimalMaxCosine && b.area > W * H * o.expectedAreaFactor) {
            done = true; break;
          }
        }
      }
    } finally {
      work.delete(); edged.delete(); blurred.delete();
      closeK.delete(); dilateK.delete();
    }

    const best = bestSquare(squares);
    let quad = null;
    if (best) {
      quad = sortPoints(best.quad.map(p => ({
        x: (p.x - o.borderSize) * resizeScale,
        y: (p.y - o.borderSize) * resizeScale,
      })));
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return { quad, ms, squares: squares.length, iterations };
  }

  return { detect, DEFAULTS };
});
