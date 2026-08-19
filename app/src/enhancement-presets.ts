import type { Enhancement } from './types';

// US-C1 单端共享预设。所有像素先进入 sRGB canvas；调整数值时只改这里。
export const ENHANCEMENT_PRESETS = {
  original: { pipeline: 'identity' },
  gray: {
    pipeline: 'grayscale',
    luminance: { red: 0.2126, green: 0.7152, blue: 0.0722 },
  },
  bw: {
    pipeline: 'binary',
    luminance: { red: 0.2126, green: 0.7152, blue: 0.0722 },
    threshold: 'otsu',
    thresholdBias: 10,
  },
  color: {
    pipeline: 'color',
    whiteBalance: 'gray-world',
    minGain: 0.8,
    maxGain: 1.25,
    contrast: 1.12,
  },
} as const satisfies Record<Enhancement, unknown>;
