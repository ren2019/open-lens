// 检测 seam — OpenCV 可插拔(Stop 目标约束: cv 暂缺时不阻塞产品可用)
// cv 就绪 → spike 移植的 OSS DocumentDetector(v2: 边缘支持度评分 + Otsu 暗场)
// cv 缺 → 返回 null,上层走 US-B3 降级(全图框 + 手动拉角),产品仍然完整可用
import type { DetectorMode, Quad } from './types';

export type { DetectorMode } from './types';

export interface DetectResult {
  quad: Quad | null;
  proposal: Quad | null;
  mode: DetectorMode;
  ms: number;
  source: 'opencv' | 'fallback';
}

export interface OpenCVLoadProgress {
  loadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  cacheHit: boolean;
}

const OPENCV_URL = '/opencv.js';
const OPENCV_CACHE = 'open-lens-opencv-0.1.0';
let cvPromise: Promise<any> | null = null;
let detectorPromise: Promise<any> | null = null;

// Emscripten Module 自带初始化期 `.then`。把它直接 resolve/return 给原生 Promise 会被当作
// thenable 反复吸收，真实 OpenCV 在浏览器里表现为主线程永久卡住；Mat 就绪后该 hook 已无用途。
function settledOpenCV(cv: any) {
  if (typeof cv?.then === 'function') {
    try { delete cv.then; }
    catch { cv.then = undefined; }
  }
  return cv;
}

async function fetchOpenCV(onProgress?: (progress: OpenCVLoadProgress) => void) {
  let response: Response | undefined;
  let cacheHit = false;
  let cacheWrite: Promise<void> | undefined;

  if (import.meta.env.PROD && 'caches' in window) {
    try {
      const cache = await caches.open(OPENCV_CACHE);
      response = await cache.match(OPENCV_URL);
      cacheHit = !!response;
      if (!response) {
        response = await fetch(OPENCV_URL);
        if (response.ok) {
          cacheWrite = cache.put(OPENCV_URL, response.clone()).catch(error => {
            console.warn('OpenCV cache write failed', error);
          });
        }
      }
    } catch (error) {
      console.warn('OpenCV cache unavailable, loading from network', error);
    }
  }
  response ??= await fetch(OPENCV_URL);
  if (!response.ok) throw new Error(`OpenCV load failed: ${response.status}`);

  const parsedTotal = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null;
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await cacheWrite;
    onProgress?.({ loadedBytes: bytes.byteLength, totalBytes, percent: 100, cacheHit });
    return { blob: new Blob([bytes], { type: 'text/javascript' }), cacheHit };
  }

  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  onProgress?.({ loadedBytes, totalBytes, percent: totalBytes ? 0 : null, cacheHit });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress?.({
      loadedBytes,
      totalBytes,
      percent: totalBytes ? Math.min(100, Math.round(loadedBytes / totalBytes * 100)) : null,
      cacheHit,
    });
  }
  await cacheWrite;
  return { blob: new Blob(chunks, { type: 'text/javascript' }), cacheHit };
}

export function loadOpenCV(onProgress?: (progress: OpenCVLoadProgress) => void): Promise<any> {
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    if ((window as any).cv && (window as any).cv.Mat) {
      onProgress?.({ loadedBytes: 0, totalBytes: null, percent: 100, cacheHit: true });
      return settledOpenCV((window as any).cv);
    }
    let objectUrl: string;
    try {
      const loaded = await fetchOpenCV(onProgress);
      objectUrl = URL.createObjectURL(loaded.blob);
    } catch (error) {
      console.warn('OpenCV unavailable, detector will use fallback', error);
      return null;
    }
    return await new Promise(resolve => {
      const s = document.createElement('script');
      // spike 自托管的 10MB 全量构建;正式版换裁剪构建(ADR-006)
      s.src = objectUrl;
      s.async = true;
      s.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const poll = window.setInterval(() => {
          const cv = (window as any).cv;
          if (cv && cv.Mat) {
            clearTimeout(timeout);
            clearInterval(poll);
            resolve(settledOpenCV(cv));
          }
        }, 60);
        const timeout = window.setTimeout(() => {
          clearInterval(poll);
          resolve(null);
        }, 30000);
      };
      s.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      }; // 缺了不阻塞: 降级
      document.head.appendChild(s);
    });
  })();
  return cvPromise;
}

// 供 store 标记 UI 状态
export async function warmupDetector(
  onReady?: (ok: boolean) => void,
  onProgress?: (progress: OpenCVLoadProgress) => void,
) {
  const cv = await loadOpenCV(onProgress);
  onReady?.(!!cv);
  return !!cv;
}

async function loadDetectorModule() {
  if ((window as any).OSSDetector) return (window as any).OSSDetector;
  if (!detectorPromise) detectorPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/detector-oss.js';
    script.onload = () => resolve((window as any).OSSDetector);
    script.onerror = () => reject(new Error('detector-oss load fail'));
    document.head.appendChild(script);
  });
  return await detectorPromise;
}

function resultQuad(result: any): Quad | null {
  return result.quad?.map((point: any) => [Math.round(point.x), Math.round(point.y)] as [number, number]) ?? null;
}

export async function detectDocument(
  blob: Blob,
  w: number,
  h: number,
  mode: DetectorMode = 'screen',
): Promise<DetectResult> {
  const t0 = performance.now();
  const cv = await loadOpenCV();
  if (!cv) return { quad: null, proposal: null, mode, ms: performance.now() - t0, source: 'fallback' };
  let src: any = null;
  try {
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    src = cv.matFromImageData(c.getContext('2d')!.getImageData(0, 0, w, h));
    // UMD 资产(public/ 原样拷贝),只能经 <script> 注入,不能被 vite import
    const detector = await loadDetectorModule();
    const r = detector.detect(cv, src, { fast: false, mode });
    const quad = resultQuad(r);
    return { quad, proposal: quad, mode, ms: performance.now() - t0, source: 'opencv' };
  } catch (e) {
    console.warn('detect failed, fallback', e);
    return { quad: null, proposal: null, mode, ms: performance.now() - t0, source: 'fallback' };
  } finally {
    src?.delete?.();
  }
}

export async function detectLiveFrame(canvas: HTMLCanvasElement, mode: DetectorMode): Promise<DetectResult> {
  const t0 = performance.now();
  const cv = await loadOpenCV();
  if (!cv) return { quad: null, proposal: null, mode, ms: performance.now() - t0, source: 'fallback' };
  let src: any = null;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    src = cv.matFromImageData(context.getImageData(0, 0, canvas.width, canvas.height));
    const detector = await loadDetectorModule();
    const result = detector.detect(cv, src, { fast: true, mode });
    const quad = resultQuad(result);
    return { quad, proposal: quad, mode, ms: performance.now() - t0, source: 'opencv' };
  } catch (error) {
    console.warn('live detect failed, fallback', error);
    return { quad: null, proposal: null, mode, ms: performance.now() - t0, source: 'fallback' };
  } finally {
    src?.delete?.();
  }
}
