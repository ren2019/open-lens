// 检测 seam — OpenCV 可插拔(Stop 目标约束: cv 暂缺时不阻塞产品可用)
// cv 就绪 → spike 移植的 OSS DocumentDetector(v2: 边缘支持度评分 + Otsu 暗场)
// cv 缺 → 返回 null,上层走 US-B3 降级(全图框 + 手动拉角),产品仍然完整可用
import type { Quad } from './types';

export interface DetectResult {
  quad: Quad | null;
  ms: number;
  source: 'opencv' | 'fallback';
}

let cvPromise: Promise<any> | null = null;

export function loadOpenCV(): Promise<any> {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve) => {
    if ((window as any).cv && (window as any).cv.Mat) return resolve((window as any).cv);
    const s = document.createElement('script');
    // spike 自托管的 10MB 全量构建;正式版换裁剪构建(ADR-006)
    s.src = '/opencv.js';
    s.async = true;
    s.onload = () => {
      const t = setInterval(() => {
        const cv = (window as any).cv;
        if (cv && cv.Mat) { clearInterval(t); resolve(cv); }
      }, 60);
    };
    s.onerror = () => resolve(null); // 缺了不阻塞: 降级
    document.head.appendChild(s);
  });
  return cvPromise;
}

// 供 store 标记 UI 状态
export async function warmupDetector(onReady?: (ok: boolean) => void) {
  const cv = await loadOpenCV();
  onReady?.(!!cv);
  return !!cv;
}

export async function detectDocument(blob: Blob, w: number, h: number): Promise<DetectResult> {
  const t0 = performance.now();
  const cv = await loadOpenCV();
  if (!cv) return { quad: null, ms: performance.now() - t0, source: 'fallback' };
  try {
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const src = cv.matFromImageData(c.getContext('2d')!.getImageData(0, 0, w, h));
    // UMD 资产(public/ 原样拷贝),只能经 <script> 注入,不能被 vite import
    if (!(window as any).OSSDetector) {
      await new Promise<void>((res, rej) => {
        const s = document.createElement('script');
        s.src = '/detector-oss.js';
        s.onload = () => res();
        s.onerror = () => rej(new Error('detector-oss load fail'));
        document.head.appendChild(s);
      });
    }
    const mod: any = (window as any).OSSDetector;
    const detect = mod.detect;
    const r = detect(cv, src, { fast: false });
    src.delete();

    if (!r.quad) return { quad: null, ms: performance.now() - t0, source: 'opencv' };
    const quad: Quad = r.quad.map((p: any) => [Math.round(p.x), Math.round(p.y)] as [number, number]);
    return { quad, ms: performance.now() - t0, source: 'opencv' };
  } catch (e) {
    console.warn('detect failed, fallback', e);
    return { quad: null, ms: performance.now() - t0, source: 'fallback' };
  }
}
