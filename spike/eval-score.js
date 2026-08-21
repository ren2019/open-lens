function isQuad(value) {
  return Array.isArray(value) && value.length === 4 && value.every(point =>
    Array.isArray(point) && point.length === 2 && point.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)));
}

function validateGroundTruth(id, groundTruth) {
  if (!groundTruth || typeof groundTruth !== 'object' || Array.isArray(groundTruth)) throw new Error(`${id}: GT must be an object`);
  if (groundTruth.noTarget && groundTruth.expectFallback) throw new Error(`${id}: noTarget and expectFallback are mutually exclusive`);
  if (groundTruth.noTarget) return;
  if (!isQuad(groundTruth.quad)) throw new Error(`${id}: target GT requires a four-point quad`);
}

function scoreCase(groundTruth, detectedQuad, iou) {
  if (groundTruth.noTarget) {
    return { label: detectedQuad ? '误检' : '✓null', fallback: false, falsePositive: Boolean(detectedQuad) };
  }
  if (groundTruth.expectFallback) {
    const falsePositive = Boolean(detectedQuad);
    return {
      label: falsePositive ? '误检' : '✓降级',
      fallbackOk: !falsePositive,
      fallback: true,
      falsePositive,
    };
  }
  if (detectedQuad) {
    const measuredIou = iou(groundTruth.quad, detectedQuad);
    return { label: measuredIou.toFixed(2), iou: measuredIou, iouPass: measuredIou >= 0.7, fallback: false, falsePositive: false };
  }
  return { label: 'null', fallback: false, falsePositive: false };
}

function isReviewCandidate(groundTruth, scored, threshold = 0.7) {
  return !groundTruth.noTarget && !groundTruth.expectFallback
    && (typeof scored.iou !== 'number' || scored.iou < threshold);
}

module.exports = { isQuad, isReviewCandidate, scoreCase, validateGroundTruth };
