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
    // v2 评分(本项目改进): edgeSupport 权重比例。0 = 纯上游评分
    v2Score: true,
    // v2: 暗光通道 - 级联前加 Otsu(正/反相) 两轮
    otsuPass: true,
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

  // ---- v2 改进(本项目自有, 非上游) ----
  // 拍摄模式先验: Lens 式分模式。每模式对目标矩形有不同假设, 硬过滤 + 软排序。
  // 依据: 用户观察(微软 Lens 分模式) + 用户约束(拍投影目标不应小于画面 1/4)。
  const MODES = {
    auto: null, // 无先验(全通吃, 兼容旧行为)
    screen: {   // 拍课件/投屏/屏幕
      areaHard: [0.05, 0.92],  // 硬: 上限拒全屏框, 下限只拒极小碎片
      areaSoft: 0.25,          // 软: <25% 评分打折(用户约束"投影应≥1/4", 但俯拍小屏构图为合法例外)
      aspect: [1.1, 2.6],      // 硬: 4:3~16:9+余量; 杀 5:1 窄条(4186 顶部横幅)
      brighter: 1.05,          // 硬: 屏幕自发光, 内部亮于外围
    },
    document: { // 拍文件/发票: 白纸亮于背景, 票据可长条
      areaHard: [0.02, 0.85],
      areaSoft: 0.10,
      aspect: [0.6, 3.5],
      brighter: 1.08,
    },
    whiteboard: { // 拍白板
      areaHard: [0.15, 0.95],
      areaSoft: 0.35,
      aspect: [1.0, 4.5],
      brighter: 1.0,
    },
  };

  // 候选几何: 面积占比 + 最小外接矩形的宽高比
  function quadGeometry(quad, W, H) {
    const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    return { areaFrac: (w * h) / (W * H), aspect: Math.max(w, h) / Math.max(1, Math.min(w, h)) };
  }

  // 内外亮度比: quad 内部均值 / 外围均值(屏幕/白纸应 >1)
  function brightnessRatio(cv, quad, gray, W, H) {
    const mask = new cv.Mat.zeros(H, W, cv.CV_8UC1);
    const pts = quad.map(p => new cv.Point(Math.round(p.x), Math.round(p.y)));
    const mv = new cv.MatVector();
    const ptsMat = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap(p => [Math.round(p.x), Math.round(p.y)]));
    mv.push_back(ptsMat);
    cv.fillPoly(mask, mv, new cv.Scalar(255));
    const _in = cv.mean(gray, mask); const inMean = _in.val ? _in.val[0] : _in[0];
    const inv = new cv.Mat();
    cv.bitwise_not(mask, inv);
    const _out = cv.mean(gray, inv); const outMean = _out.val ? _out.val[0] : _out[0];
    mask.delete(); inv.delete(); mv.delete(); ptsMat.delete();
    return outMean > 1 ? inMean / outMean : 1;
  }

  // 边缘支持度: 沿候选四边形的四条边采样, 统计落在真实 Canny 边缘上的采样点比例。
  // 高支持 = 边是真实存在的边缘(文档边); 低支持 = 阈值切出来的假边形(如墙面色块边界)
  function edgeSupportRatio(cv, quad, cannyEdges, W, H) {
    const step = 3; // 每 3px 采样一次
    let on = 0, total = 0;
    const d = cannyEdges.data, cols = cannyEdges.cols;
    for (let e = 0; e < 4; e++) {
      const a = quad[e], b2 = quad[(e + 1) % 4];
      const len = Math.hypot(b2.x - a.x, b2.y - a.y);
      const n = Math.max(2, Math.round(len / step));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        let x = Math.round(a.x + (b2.x - a.x) * t);
        let y = Math.round(a.y + (b2.y - a.y) * t);
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        total++;
        // 检查 3x3 邻域(容差 1px, 抵消 dilate/轮廓的量化误差)
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++)
          for (let dx = -1; dx <= 1 && !hit; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
            if (d[yy * cols + xx] > 0) hit = 1;
          }
        if (hit) on++;
      }
    }
    return total ? on / total : 0;
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

    // v2: 全局参考边缘图(固定中档 Canny), 用于 edgeSupport 评分
    let refEdges = null;
    if (o.v2Score) {
      refEdges = new cv.Mat();
      cv.cvtColor(blurred, work, cv.COLOR_RGBA2GRAY);
      cv.Canny(work, refEdges, 40, 80);
    }

    // v2 收集器: pass 记录 {quad, cannyEdges} 供统一评分
    const candidates = [];

    try {
      // v2: Otsu 暗光通道先行(亮目标暗背景自动分离; 上游固定 thresh=160 在暗光下全黑)
      if (o.otsuPass && !o.fast) {
        cv.cvtColor(blurred, work, cv.COLOR_RGBA2GRAY);
        for (const inv of [0, 1]) {
          cv.threshold(work, edged, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU + (inv ? cv.THRESH_BINARY_INV : 0));
          cv.morphologyEx(edged, edged, cv.MORPH_CLOSE, closeK);
          cv.dilate(edged, edged, dilateK);
          const before = squares.length;
          findSquares(cv, edged, W, H, squares, weight--, o);
          iterations++;
          // 记录本轮新增候选 + 它们对应的参考边缘图
          if (o.v2Score) for (let k = before; k < squares.length; k++) candidates.push({ s: squares[k], pass: 'otsu' + (inv ? '-inv' : '') });
        }
      }
      for (let ci = 0; ci < channels.length && !done; ci++) {
        if (o.fast) cv.cvtColor(blurred, work, cv.COLOR_RGBA2GRAY);
        else if (cv.extractChannel) cv.extractChannel(blurred, work, channels[ci]);
        else { const ch = new cv.MatVector(); cv.split(blurred, ch); ch.get(channels[ci]).copyTo(work); ch.delete(); }

        // pass 1: threshold
        cv.threshold(work, edged, o.thresh, o.threshMax, cv.THRESH_BINARY);
        cv.morphologyEx(edged, edged, cv.MORPH_CLOSE, closeK);
        cv.dilate(edged, edged, dilateK);
        const before = squares.length;
        findSquares(cv, edged, W, H, squares, weight--, o);
        iterations++;
        if (o.v2Score) for (let k = before; k < squares.length; k++) candidates.push({ s: squares[k], pass: 'thresh' });
        let b = bestSquare(squares);
        if (!o.v2Score && b && b.maxCos < o.expectedOptimalMaxCosine && b.area > W * H * o.expectedAreaFactor) break;

        // pass 2+: canny 从严到松
        for (const t of cannyLevels) {
          cv.Canny(work, edged, t * o.cannyFactor, o.cannyFactor * t * 2);
          cv.dilate(edged, edged, dilateK);
          const b2 = squares.length;
          findSquares(cv, edged, W, H, squares, weight--, o);
          iterations++;
          if (o.v2Score) for (let k = b2; k < squares.length; k++) candidates.push({ s: squares[k], pass: 'canny' + t });
          if (!o.v2Score) {
            b = bestSquare(squares);
            if (b && b.maxCos < o.expectedOptimalMaxCosine && b.area > W * H * o.expectedAreaFactor) { done = true; break; }
          }
        }
      }
    } finally {
      work.delete(); edged.delete();
      closeK.delete(); dilateK.delete();
    }
    // refEdges 保留到评分后删除(见函数尾)

    // v2 统一评分: 收完所有候选后, 模式先验过滤 + 多信号重排
    const mode = o.mode ? MODES[o.mode] : null; // 'auto'/undefined = 无先验
    let grayStats = null;
    if (mode && mode.brighter > 1) {
      grayStats = new cv.Mat();
      cv.cvtColor(blurred, grayStats, cv.COLOR_RGBA2GRAY);
    }
    let best;
    if (o.v2Score && candidates.length) {
      let bestScore = -Infinity;
      best = null;
      for (const c of candidates) {
        const s = c.s;
        const areaFrac = s.area / (W * H);
        // 模式先验: 硬过滤(几何) + 亮度比
        let areaPenalty = 1;
        if (mode) {
          const g = quadGeometry(s.quad, W, H);
          if (g.areaFrac < mode.areaHard[0] || g.areaFrac > mode.areaHard[1]) continue;
          if (g.aspect < mode.aspect[0] || g.aspect > mode.aspect[1]) continue;
          if (grayStats && mode.brighter > 1) {
            const br = brightnessRatio(cv, s.quad, grayStats, W, H);
            if (br < mode.brighter) continue; // 内部不比外围亮 → 不是屏幕/白纸
          }
          // 软面积: 低于模式期望占比的候选打折(而非拒绝)
          if (g.areaFrac < mode.areaSoft) areaPenalty = 0.3 + 0.7 * (g.areaFrac / mode.areaSoft);
        }
        const support = edgeSupportRatio(cv, s.quad, refEdges, W, H);
        // 评分: 支持度主信号 × 角度质量 × 面积弱偏好 × 模式软面积
        const score = areaPenalty * support * support * (1 - s.maxCos) * (0.5 + 0.5 * Math.sqrt(areaFrac * 10));
        s.v2 = { support, score };
        if (score > bestScore) { bestScore = score; best = s; }
      }
      // 先验是硬约束,不做"全灭回退"——模式是用户显式选择的意图,违背先验的框没有意义。
      // 全被过滤 = 返回 null, UI 引导用户手框(拍后审阅模式本来就有拖角点兜底)。
      // (试过回退逻辑: 4186 顶部窄条被过滤后又回退捞回,先验形同虚设,故删除)
    } else best = bestSquare(squares);
    if (refEdges) refEdges.delete();
    if (grayStats) grayStats.delete();
    blurred.delete();
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
