// 中央 store — 手写 reactive,不引 pinia(ADR-006: 控件手写,UI 面积小)
// 旅程结构沿用原型 v2(已按上游源码验证): camera → crop(pager) → finish → pageedit/docgrid
import { reactive, inject, App as VueApp, InjectionKey } from 'vue';
import type { Doc, Page, Quad, RemoteDoc } from './types';
import { detectDocument } from './detector';
import { warpPage, stitchLongImage } from './imaging';

export type Screen =
  | 'home' | 'gate' | 'camera' | 'crop' | 'docgrid' | 'pageedit' | 'library';

export interface CropItem {
  pageId: string;
  blob: Blob;
  w: number;
  h: number;
  quad: Quad;
  detected: boolean;
  undos: Quad[];
  redos: Quad[];
}

export interface State {
  screen: Screen;
  token: string;
  online: boolean;
  docs: Doc[];              // 本会话产出(等待上传/已上传)
  remoteDocs: RemoteDoc[];  // 服务端列表(历史视图)
  curDocId: string | null;
  pageIdx: number;
  session: {
    appendTo: string | null;
    items: CropItem[];       // 待裁剪(裁剪 pager)
    pages: Page[];           // 已确认
    batch: boolean;
  } | null;
  cropMode: 'session' | 'recrop';
  recropCtx: { docId: string; pageIndex: number } | null;
  renaming: boolean;
  loading: string | null;   // 'capturing…' / 'computing…'
  toast: string | null;
  queueBusy: boolean;
  cvReady: boolean;
}

export const state = reactive<State>({
  screen: localStorage.getItem('ol_token') ? 'home' : 'gate',
  token: localStorage.getItem('ol_token') || '',
  online: navigator.onLine,
  docs: [],
  remoteDocs: [],
  curDocId: null,
  pageIdx: 0,
  session: null,
  cropMode: 'session',
  recropCtx: null,
  renaming: false,
  loading: null,
  toast: null,
  queueBusy: false,
  cvReady: false,
});

export const actions = {
  setToken(t: string) {
    state.token = t;
    localStorage.setItem('ol_token', t);
    state.screen = 'home';
  },
  go(s: Screen) { state.screen = s; },
  toast(msg: string) {
    state.toast = msg;
    setTimeout(() => { if (state.toast === msg) state.toast = null; }, 2600);
  },

  async openCamera(appendTo: string | null = null) {
    if (!state.session || state.session.appendTo !== appendTo) {
      state.session = { appendTo, items: [], pages: [], batch: true };
    }
    state.screen = 'camera';
  },

  async shutter(imageBlob: Blob, w: number, h: number) {
    if (!state.session) return;
    state.loading = '检测中…';
    try {
      const r = await detectDocument(imageBlob, w, h);
      const M = 40; // 检测失败降级: 全图内缩框(US-B3)
      const quad: Quad = r.quad ?? [[M, M], [w - M, M], [w - M, h - M], [M, h - M]];
      state.session.items.push({
        pageId: 'p' + Date.now() + '_' + state.session.items.length,
        blob: imageBlob, w, h, quad, detected: !!r.quad, undos: [], redos: [],
      });
      state.cropMode = 'session';
      state.screen = 'crop';
      actions.toast(r.quad
        ? `检测成功(${r.ms.toFixed(0)}ms${r.source === 'fallback' ? ',cv 缺→占位框' : ''})`
        : '未检测到边框,请手动拉角');
    } finally { state.loading = null; }
  },

  async importAlbum(files: File[]) {
    if (!state.session) state.session = { appendTo: null, items: [], pages: [], batch: true };
    state.loading = '检测中…';
    try {
      for (const f of files) {
        const { w, h } = await imageSize(f);
        const r = await detectDocument(f, w, h);
        const M = 40;
        state.session.items.push({
          pageId: 'p' + Date.now() + '_' + state.session.items.length,
          blob: f, w, h,
          quad: r.quad ?? [[M, M], [w - M, M], [w - M, h - M], [M, h - M]],
          detected: !!r.quad, undos: [], redos: [],
        });
      }
      state.cropMode = 'session';
      state.screen = 'crop';
      actions.toast(`导入 ${files.length} 张进入裁剪`);
    } finally { state.loading = null; }
  },

  // 裁剪 pager
  cropItem(): CropItem | null {
    if (!state.session) return null;
    if (state.cropMode === 'recrop') return state.session.items[0] ?? null;
    return state.session.items[state.session.items.length - 1] ?? null;
  },
  dragCorner(idx: number, x: number, y: number) {
    const it = actions.cropItem(); if (!it) return;
    it.undos.push(it.quad.map(p => p.slice() as [number, number]));
    it.redos = [];
    it.quad[idx] = [x, y];
  },
  cropUndo() {
    const it = actions.cropItem(); if (!it || !it.undos.length) return;
    it.redos.push(it.quad); it.quad = it.undos.pop()!;
  },
  cropRedo() {
    const it = actions.cropItem(); if (!it || !it.redos.length) return;
    it.undos.push(it.quad); it.quad = it.redos.pop()!;
  },
  cropReset() {
    const it = actions.cropItem(); if (!it) return;
    const M = 40;
    it.undos.push(it.quad);
    it.quad = [[M, M], [it.w - M, M], [it.w - M, it.h - M], [M, it.h - M]];
  },

  confirmCrop() {
    if (!state.session) return;
    if (state.cropMode === 'recrop' && state.recropCtx) {
      const { docId, pageIndex } = state.recropCtx;
      const doc = state.docs.find(d => d.id === docId);
      const it = state.session.items[0];
      if (doc && it) {
        doc.pages[pageIndex].quad = it.quad.map(p => p.slice() as [number, number]);
        enqueue(doc); // 重切后重传该页
      }
      state.session = null;
      state.cropMode = 'session'; state.recropCtx = null;
      state.pageIdx = pageIndex;
      state.screen = 'pageedit';
      return;
    }
    const sess = state.session;
    for (const it of sess.items) {
      sess.pages.push({
        id: it.pageId, originalBlob: it.blob, originalW: it.w, originalH: it.h,
        quad: it.quad.map(p => p.slice() as [number, number]),
        enhancement: 'original', rotation: 0,
      });
    }
    sess.items = [];
    state.screen = 'camera';
    if (!sess.batch && !sess.appendTo) actions.finishBatch();
  },

  finishBatch() {
    const sess = state.session; if (!sess || !sess.pages.length) return;
    if (sess.appendTo) {
      const doc = state.docs.find(d => d.id === sess.appendTo)!;
      doc.pages = doc.pages.concat(sess.pages);
      enqueue(doc);
      state.curDocId = doc.id;
      state.session = null;
      state.screen = 'docgrid';
      actions.toast(`补入 ${sess.pages.length} 页`);
      return;
    }
    const doc: Doc = {
      id: 'd' + Date.now(),
      name: defaultName(new Date()),
      createdAt: Date.now(),
      tags: [], pages: sess.pages, outfits: [],
      archive: { status: 'queued', done: 0, total: 1 + sess.pages.length },
    };
    state.docs.unshift(doc);
    enqueue(doc);
    state.curDocId = doc.id;
    state.pageIdx = doc.pages.length - 1;
    state.session = null;
    state.screen = 'pageedit'; // 上游落地规则: 新档停页编辑器最后一页
  },

  openRecrop(docId: string, pageIndex: number) {
    const doc = state.docs.find(d => d.id === docId)!;
    const p = doc.pages[pageIndex];
    state.session = {
      appendTo: null,
      items: [{
        pageId: p.id, blob: p.originalBlob, w: p.originalW, h: p.originalH,
        quad: p.quad.map(q => q.slice() as [number, number]),
        detected: true, undos: [], redos: [],
      }],
      pages: [], batch: true,
    };
    state.cropMode = 'recrop';
    state.recropCtx = { docId, pageIndex };
    state.screen = 'crop';
  },

  setEnh(kind: Page['enhancement']) {
    const d = curDoc(); if (!d) return;
    d.pages[state.pageIdx].enhancement = kind;
    enqueue(d);
  },
  rotate() {
    const d = curDoc(); if (!d) return;
    const p = d.pages[state.pageIdx];
    p.rotation = (p.rotation + 90) % 360;
    enqueue(d);
  },
  deletePage() {
    const d = curDoc(); if (!d) return;
    if (d.pages.length <= 1) return; // 最后一页 → 删文档(UI 层确认)
    d.pages.splice(state.pageIdx, 1);
    state.pageIdx = Math.min(state.pageIdx, d.pages.length - 1);
    enqueue(d);
  },
  deleteDoc(id: string) {
    state.docs = state.docs.filter(d => d.id !== id);
    if (state.curDocId === id) { state.curDocId = null; state.screen = 'home'; }
    fetch(api(`/api/docs/${id}`), { method: 'DELETE', headers: auth() });
  },
  rename(name: string) {
    const d = curDoc(); if (!d) return;
    d.name = name; state.renaming = false;
    enqueue(d);
  },
  toggleTag(tag: string) {
    const d = curDoc(); if (!d) return;
    const i = d.tags.indexOf(tag);
    if (i >= 0) d.tags.splice(i, 1); else d.tags.push(tag);
    enqueue(d);
  },

  async exportOutfit(kind: 'image' | 'long' | 'pdf') {
    const d = curDoc(); if (!d) return;
    state.loading = '组装中…';
    try {
      const blob = await buildOutfit(d, kind);
      const outfit = { id: 'o' + Date.now(), kind, blob, ext: kind === 'pdf' ? 'pdf' : 'jpg' };
      d.outfits.push(outfit);
      enqueue(d);
      actions.toast(kind === 'pdf' ? 'PDF 已组装' : kind === 'long' ? '长图已拼接' : '单页图已导出');
      // 同时给用户下载一份
      downloadBlob(blob, outfitFileName(d, outfit));
    } finally { state.loading = null; }
  },

  async refreshLibrary() {
    if (!state.online) { actions.toast('离线,显示不了历史'); return; }
    try {
      const r = await fetch(api('/api/docs'), { headers: auth() });
      if (r.status === 401) { actions.toast('token 无效'); state.screen = 'gate'; return; }
      state.remoteDocs = await r.json();
    } catch { actions.toast('服务端不可达'); }
  },
};

export function curDoc(): Doc | null {
  return state.docs.find(d => d.id === state.curDocId) ?? null;
}

function defaultName(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    return { w: img.naturalWidth, h: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

// ---------- 上传队列(F2: 断网照扫,恢复补传) ----------
const queue: Doc[] = [];
let draining = false;

function enqueue(doc: Doc) {
  doc.archive.status = doc.archive.status === 'uploaded' ? 'queued' : doc.archive.status;
  doc.archive.total = 1 + doc.pages.length + doc.outfits.length;
  if (!queue.includes(doc)) queue.push(doc);
  drain();
}

async function drain() {
  if (draining || !state.online) return;
  draining = true; state.queueBusy = true;
  try {
    while (queue.length && state.online) {
      const doc = queue[0];
      try {
        await uploadDoc(doc);
      } catch (e) {
        doc.archive.status = state.online ? 'failed' : 'queued';
        if (!state.online) break;
        queue.shift(); // 失败不无限重试(ADR-002: 丢=重扫)
        actions.toast(`「${doc.name}」上传失败`);
      }
    }
  } finally { draining = false; state.queueBusy = false; }
}

async function uploadDoc(doc: Doc) {
  doc.archive.status = 'uploading';
  const fd = new FormData();
  fd.set('meta', JSON.stringify({
    id: doc.id, name: doc.name, createdAt: doc.createdAt, tags: doc.tags,
    pages: doc.pages.map(p => ({ id: p.id, quad: p.quad, enhancement: p.enhancement, rotation: p.rotation })),
  }));
  doc.pages.forEach((p, i) => fd.set(`original_${i}`, p.originalBlob, `o${i}.jpg`));
  // scan 当前渲染(增强后)随 original 一起归档
  for (let i = 0; i < doc.pages.length; i++) {
    doc.archive.done++;
    const scan = await renderScanBlob(doc.pages[i]);
    fd.set(`scan_${i}`, scan, `s${i}.jpg`);
  }
  doc.outfits.forEach((o, i) => fd.set(`outfit_${i}`, o.blob, `outfit${i}.${o.ext}`));
  doc.archive.done++;

  const r = await fetch(api('/api/docs'), { method: 'POST', headers: auth(), body: fd });
  if (!r.ok) throw new Error('upload ' + r.status);
  doc.archive.status = 'uploaded';
  doc.archive.done = doc.archive.total;
  queue.shift();
}

window.addEventListener('online', () => { state.online = true; drain(); });
window.addEventListener('offline', () => { state.online = false; });

// ---------- helpers ----------
export function api(path: string) {
  const base = import.meta.env.VITE_API_BASE || '';
  return base + path;
}
function auth(): Record<string, string> {
  return state.token ? { Authorization: 'Bearer ' + state.token } : {};
}

async function renderScanBlob(p: Page): Promise<Blob> {
  const c = await warpPage(p, 1400);
  return await new Promise<Blob>(res => c.toBlob((b: Blob | null) => res(b!), 'image/jpeg', 0.85));
}

async function buildOutfit(d: Doc, kind: 'image' | 'long' | 'pdf'): Promise<Blob> {
  if (kind === 'image') return renderScanBlob(d.pages[0]);
  if (kind === 'long') {
    const c = await stitchLongImage(d.pages, 900);
    return await new Promise<Blob>(res => c.toBlob((b: Blob | null) => res(b!), 'image/jpeg', 0.88));
  }
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const p of d.pages) {
    const c = await warpPage(p, 1600);
    const blob = await new Promise<Blob>(res => c.toBlob((b: Blob | null) => res(b!), 'image/jpeg', 0.85));
    const img = await pdf.embedJpg(await blob.arrayBuffer());
    const [pw, ph] = p.rotation % 180 === 0 ? [img.width, img.height] : [img.height, img.width];
    const page = pdf.addPage([pw, ph]);
    if (p.rotation % 180 === 0) page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    else {
      page.drawImage(img, {
        x: pw / 2 - img.width / 2, y: ph / 2 - img.height / 2, width: img.width, height: img.height,
        rotate: { type: 'degrees' as any, angle: p.rotation === 90 ? 90 : 270 },
      });
    }
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

function outfitFileName(d: Doc, o: { id: string; kind: string; ext: string }) {
  return `${d.name}.${o.ext}`;
}
function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const store = { state, actions };
export const key: InjectionKey<typeof store> = Symbol('store');
export function useStore() { return inject(key)!; }
