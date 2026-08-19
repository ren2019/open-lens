// 域模型 — 术语严格对齐 CONTEXT.md
// Scan: 一页成品(透视校正+增强后) Original: 相机直出未处理
// Page: 文档组成单位,一页 = Original + Scan(quad + enhancement)
// Outfit: 交付物(单图/长图/PDF)

export type Quad = [number, number][]; // [tl, tr, br, bl]

export type DetectorMode = 'auto' | 'screen' | 'document' | 'whiteboard';

export interface DetectMeta {
  mode: DetectorMode;
  proposal: Quad | null;
  ms: number;
  edited: boolean;
  source: string;
}

export type Enhancement = 'original' | 'gray' | 'bw' | 'color';

export const ENH_LABELS: Record<Enhancement, string> = {
  original: '原图',
  gray: '灰度',
  bw: '黑白',
  color: '彩色增强',
};

export interface Page {
  id: string;
  originalBlob: Blob;     // 相机直出 JPEG,重处理输入(ADR-002)
  scanBlob?: Blob;        // 当前 quad/enhancement/rotation 对应的 Scan;待传时随队列落 OPFS
  originalW: number;
  originalH: number;
  quad: Quad;             // 基于原始分辨率的四角
  enhancement: Enhancement;
  rotation: number;       // 0/90/180/270
  edited: boolean;
  detectMeta: DetectMeta | null;
}

export type OutfitKind = 'image' | 'long' | 'pdf';

export interface Outfit {
  id: string;
  kind: OutfitKind;
  blob: Blob;
  ext: string; // jpg | png | pdf
}

export interface ArchiveState {
  status: 'idle' | 'queued' | 'uploading' | 'uploaded' | 'failed'; // failed = 重试超限,待人工
  done: number;
  total: number;
  attempts: number; // 连续失败次数(US-F2,持久化在 OPFS meta)
}

export interface Doc {
  id: string;
  name: string;
  createdAt: number;
  tags: string[];
  pages: Page[];
  outfits: Outfit[];
  archive: ArchiveState;
}

// 服务端返回的轻量文档(server 是唯一真相,ADR-002)
export interface RemoteDoc {
  id: string;
  name: string;
  createdAt: number;
  tags: string[];
  pageCount: number;
  outfits: { id: string; kind: OutfitKind }[];
}

export interface RemotePage {
  id: string;
  quad: Quad;
  enhancement: Enhancement;
  rotation: number;
  ocr: string;
  original: string;
  scan: string;
  edited: boolean;
  detectMeta: DetectMeta | null;
}

export interface RemoteDocDetail {
  id: string;
  name: string;
  createdAt: number;
  tags: string[];
  pages: RemotePage[];
  outfits: { id: string; kind: OutfitKind; file: string }[];
}
