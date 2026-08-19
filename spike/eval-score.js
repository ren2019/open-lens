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
    return { label: detectedQuad ? '误检' : '✓null', include: false, good: false, fallback: false, falsePositive: Boolean(detectedQuad) };
  }
  if (groundTruth.expectFallback) {
    const falsePositive = Boolean(detectedQuad);
    return {
      label: falsePositive ? '误检' : '✓降级',
      include: true,
      score: falsePositive ? 0 : 1,
      good: !falsePositive,
      fallback: true,
      falsePositive,
    };
  }
  if (detectedQuad) {
    const score = iou(groundTruth.quad, detectedQuad);
    return { label: score.toFixed(2), include: true, score, good: score >= 0.7, fallback: false, falsePositive: false };
  }
  return { label: 'null', include: false, good: false, fallback: false, falsePositive: false };
}

module.exports = { isQuad, scoreCase, validateGroundTruth };
