const definitions = [
  ['US-G3', 'us/us-g3-auth.mjs'],
  ['US-A2', 'us/us-a2-shutter.mjs'],
  ['US-A3', 'us/us-a3-multipage.mjs'],
  ['US-A4', 'us/us-a4-album.mjs'],
  ['US-B1', 'us/us-b1-crop.mjs'],
  ['US-B2', 'us/us-b2-perspective-continuity.mjs'],
  ['US-B5', 'us/us-b5-recrop-context.mjs'],
  ['B1-B2-CV', 'us/us-b1-b2-real-detection.mjs', ['US-B1-B2-CV']],
  ['D9-DETECTOR-MODE', 'us/us-detector-mode.mjs', ['US-DETECTOR-MODE']],
  ['US-C1', 'us/us-c1-enhancement.mjs'],
  ['US-D3', 'us/us-d3-tags.mjs'],
  ['US-D1', 'us/us-d1-page-order.mjs'],
  ['US-D2', 'us/us-d2-rename.mjs'],
  ['US-E1', 'us/us-e1-image-export.mjs'],
  ['E2-E3-OUTFITS', 'us/us-e2-e3-outfits.mjs', ['US-E2-E3']],
  ['US-F1', 'us/us-f1-archive.mjs'],
  ['US-F3', 'us/us-f3-page-editor-status.mjs'],
  ['US-D4', 'us/us-d4-library.mjs'],
  ['US-D8', 'us/us-d8-desktop-recrop.mjs'],
];

export const defaultSuites = definitions.map(([id, file]) => ({ id, file }));

const suitesBySelector = new Map();
for (const [id, file, aliases = []] of definitions) {
  const suite = { id, file };
  for (const selector of [id, ...aliases]) suitesBySelector.set(selector, suite);
}

export const availableSelectors = [...suitesBySelector.keys()];

export function resolveSuites(values) {
  const selected = [];
  const unknown = [];
  const seen = new Set();

  for (const value of values) {
    const selector = value.toUpperCase();
    const suite = suitesBySelector.get(selector);
    if (!suite) {
      unknown.push(selector);
      continue;
    }
    if (seen.has(suite.id)) continue;
    seen.add(suite.id);
    selected.push(suite);
  }

  return { selected, unknown };
}
