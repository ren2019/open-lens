// 中央 store — 手写 reactive,不引 pinia(ADR-006: 控件手写,UI 面积小)
// 旅程结构沿用原型 v2(已按上游源码验证): camera → crop(pager) → finish → pageedit/docgrid
import { reactive, inject, App as VueApp, InjectionKey } from 'vue';
import { DETECTOR_MODE_OPTIONS, type DetectMeta, type Doc, type Page, type Quad, type RemoteDoc, type RemoteDocDetail } from './types';
import { detectDocument, type DetectorMode } from './detector';
import { warpPage, stitchLongImage } from './imaging';
import { detectCapabilities, type CapabilityStatus } from './capabilities';
import { exportRemoteDoc } from './remote-export';

export type Screen =
  | 'home' | 'gate' | 'camera' | 'crop' | 'docgrid' | 'pageedit' | 'library' | 'remotedetail';

export interface RecropContext {
  docId: string;
  pageId: string;
  pageIndex: number;
  returnTo: 'pageedit' | 'remotedetail';
}

export const RECROP_HISTORY_STATE_KEY = 'openLensRecrop';

export interface CropItem {
  pageId: string;
  blob: Blob;
  w: number;
  h: number;
  quad: Quad;
  detected: boolean;
  edited: boolean;
  detectMeta: DetectMeta | null;
  undos: Quad[];
  redos: Quad[];
}

export interface State {
  screen: Screen;
  token: string;
  online: boolean;
  docs: Doc[];              // 本会话产出(等待上传/已上传)
  remoteDocs: RemoteDoc[];  // 服务端列表(历史视图)
  remoteDoc: RemoteDocDetail | null;
  remotePageIdx: number;
  detectionMode: DetectorMode; // #9 将补 UI/持久化;A1 先消费同一状态 seam
  curDocId: string | null;
  pageIdx: number;
  session: {
    appendTo: string | null;
    items: CropItem[];       // 待裁剪(裁剪 pager)
    pages: Page[];           // 已确认
    batch: boolean;
  } | null;
  cropMode: 'session' | 'recrop';
  recropCtx: RecropContext | null;
  renaming: boolean;
  loading: string | null;   // 'capturing…' / 'computing…'
  toast: string | null;
  queueBusy: boolean;
  queuePersistent: boolean; // OPFS 可用=硬持久队列;false=退回内存队列(US-H3 展示降级用)
  queueStorageReady: boolean;
  capabilities: CapabilityStatus;
  installGuideDismissed: boolean;
  cvReady: boolean;
  cvStatus: 'idle' | 'loading' | 'ready' | 'fallback';
  cvLoadProgress: number | null;
  cvCacheHit: boolean;
}

const coldStartCapabilities = detectCapabilities();
const savedDetectionMode = localStorage.getItem('ol_detection_mode');

export const state = reactive<State>({
  screen: localStorage.getItem('ol_token') ? 'home' : 'gate',
  token: localStorage.getItem('ol_token') || '',
  online: navigator.onLine,
  docs: [],
  remoteDocs: [],
  remoteDoc: null,
  remotePageIdx: 0,
  detectionMode: DETECTOR_MODE_OPTIONS.some(option => option.value === savedDetectionMode)
    ? savedDetectionMode as DetectorMode
    : 'screen',
  curDocId: null,
  pageIdx: 0,
  session: null,
  cropMode: 'session',
  recropCtx: null,
  renaming: false,
  loading: null,
  toast: null,
  queueBusy: false,
  queuePersistent: false,
  queueStorageReady: !coldStartCapabilities.opfs,
  capabilities: coldStartCapabilities,
  installGuideDismissed: false,
  cvReady: false,
  cvStatus: 'idle',
  cvLoadProgress: null,
  cvCacheHit: false,
});

function enterRecrop(context: RecropContext, pushHistory: boolean) {
  const doc = state.docs.find(item => item.id === context.docId);
  if (!doc) return false;
  const pageIndex = doc.pages.findIndex(page => page.id === context.pageId);
  if (pageIndex < 0) return false;
  if (context.returnTo === 'remotedetail' && state.remoteDoc?.id !== context.docId) return false;
  if (context.returnTo === 'pageedit') state.curDocId = context.docId;
  const page = doc.pages[pageIndex];
  const resolvedContext = { ...context, pageIndex };
  state.session = {
    appendTo: null,
    items: [{
      pageId: page.id, blob: page.originalBlob, w: page.originalW, h: page.originalH,
      quad: page.quad.map(point => point.slice() as [number, number]),
      detected: true, undos: [], redos: [],
      edited: page.edited,
      detectMeta: page.detectMeta ? { ...page.detectMeta, proposal: cloneQuad(page.detectMeta.proposal) } : null,
    }],
    pages: [], batch: true,
  };
  state.cropMode = 'recrop';
  state.recropCtx = resolvedContext;
  state.pageIdx = pageIndex;
  if (context.returnTo === 'remotedetail') state.remotePageIdx = pageIndex;
  state.screen = 'crop';
  if (pushHistory) {
    history.pushState({
      ...(history.state ?? {}),
      [RECROP_HISTORY_STATE_KEY]: { ...resolvedContext },
    }, '');
  }
  return true;
}

export const actions = {
  setToken(t: string) {
    state.token = t;
    localStorage.setItem('ol_token', t);
    state.screen = 'home';
  },
  setDetectionMode(mode: DetectorMode) {
    state.detectionMode = mode;
    localStorage.setItem('ol_detection_mode', mode);
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
      const r = await detectDocument(imageBlob, w, h, state.detectionMode);
      const M = 40; // 检测失败降级: 全图内缩框(US-B3)
      const quad: Quad = r.quad ?? [[M, M], [w - M, M], [w - M, h - M], [M, h - M]];
      state.session.items.push({
        pageId: 'p' + Date.now() + '_' + state.session.items.length,
        blob: imageBlob, w, h, quad, detected: !!r.quad, undos: [], redos: [],
        edited: false,
        detectMeta: { mode: r.mode, proposal: cloneQuad(r.proposal), ms: r.ms, edited: false, source: 'mobile-camera' },
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
        const r = await detectDocument(f, w, h, state.detectionMode);
        const M = 40;
        state.session.items.push({
          pageId: 'p' + Date.now() + '_' + state.session.items.length,
          blob: f, w, h,
          quad: r.quad ?? [[M, M], [w - M, M], [w - M, h - M], [M, h - M]],
          detected: !!r.quad, undos: [], redos: [],
          edited: false,
          detectMeta: { mode: r.mode, proposal: cloneQuad(r.proposal), ms: r.ms, edited: false, source: 'mobile-album' },
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
    it.edited = true;
  },
  cropUndo() {
    const it = actions.cropItem(); if (!it || !it.undos.length) return;
    it.redos.push(it.quad); it.quad = it.undos.pop()!;
    it.edited = true;
  },
  cropRedo() {
    const it = actions.cropItem(); if (!it || !it.redos.length) return;
    it.undos.push(it.quad); it.quad = it.redos.pop()!;
    it.edited = true;
  },
  cropReset() {
    const it = actions.cropItem(); if (!it) return;
    const M = 40;
    it.undos.push(it.quad);
    it.quad = [[M, M], [it.w - M, M], [it.w - M, it.h - M], [M, it.h - M]];
    it.edited = true;
  },

  confirmCrop() {
    if (!state.session) return;
    if (state.cropMode === 'recrop' && state.recropCtx) {
      const { docId, pageIndex, returnTo } = state.recropCtx;
      const doc = state.docs.find(d => d.id === docId);
      const it = state.session.items[0];
      const changed = !!doc && !!it && !sameQuad(doc.pages[pageIndex].quad, it.quad);
      if (doc && it && changed) {
        doc.pages[pageIndex].quad = it.quad.map(p => p.slice() as [number, number]);
        doc.pages[pageIndex].scanBlob = undefined;
        doc.pages[pageIndex].edited = true;
        if (doc.pages[pageIndex].detectMeta) doc.pages[pageIndex].detectMeta!.edited = true;
        enqueue(doc); // 重切后重传该页
        if (returnTo === 'remotedetail' && state.remoteDoc?.id === docId) {
          const remotePage = state.remoteDoc.pages[pageIndex];
          remotePage.quad = cloneQuad(it.quad)!;
          remotePage.edited = true;
          if (remotePage.detectMeta) remotePage.detectMeta.edited = true;
          void refreshRemotePageAfterUpload(doc, pageIndex);
        }
      }
      state.session = null;
      state.cropMode = 'session'; state.recropCtx = null;
      state.pageIdx = pageIndex;
      state.screen = returnTo;
      if (returnTo === 'remotedetail' && changed) actions.toast('重切已加入归档队列');
      return;
    }
    const sess = state.session;
    for (const it of sess.items) {
      sess.pages.push({
        id: it.pageId, originalBlob: it.blob, originalW: it.w, originalH: it.h,
        quad: it.quad.map(p => p.slice() as [number, number]),
        enhancement: 'original', rotation: 0,
        edited: it.edited,
        detectMeta: it.detectMeta ? { ...it.detectMeta, proposal: cloneQuad(it.detectMeta.proposal), edited: it.edited } : null,
      });
    }
    sess.items = [];
    state.screen = 'camera';
    if (!sess.batch && !sess.appendTo) actions.finishBatch();
  },

  cancelRecrop() {
    if (state.cropMode !== 'recrop' || !state.recropCtx) return;
    const { pageIndex, returnTo } = state.recropCtx;
    state.session = null;
    state.cropMode = 'session';
    state.recropCtx = null;
    state.pageIdx = pageIndex;
    state.screen = returnTo;
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
      archive: { status: 'queued', done: 0, total: 1 + sess.pages.length, attempts: 0 },
    };
    state.docs.unshift(doc);
    enqueue(doc);
    state.curDocId = doc.id;
    state.pageIdx = doc.pages.length - 1;
    state.session = null;
    state.screen = 'pageedit'; // 上游落地规则: 新档停页编辑器最后一页
  },

  openRecrop(docId: string, pageIndex: number, returnTo: 'pageedit' | 'remotedetail' = 'pageedit') {
    const pageId = state.docs.find(doc => doc.id === docId)?.pages[pageIndex]?.id;
    if (!pageId) return false;
    return enterRecrop({ docId, pageId, pageIndex, returnTo }, true);
  },

  restoreRecrop(context: RecropContext) {
    return enterRecrop(context, false);
  },

  async openRemoteRecrop(pageIndex = state.remotePageIdx) {
    const remote = state.remoteDoc;
    if (!remote) return;
    const existing = state.docs.find(doc => doc.id === remote.id);
    if (existing && existing.archive.status !== 'uploaded') {
      actions.toast('上一轮重切仍在归档');
      return;
    }
    state.loading = '读取 Original…';
    try {
      const pages = await Promise.all(remote.pages.map(async remotePage => {
        const [originalResponse, scanResponse] = await Promise.all([
          fetch(api(remotePage.original), { headers: auth() }),
          fetch(api(remotePage.scan), { headers: auth() }),
        ]);
        if (!originalResponse.ok || !scanResponse.ok) throw new Error('archive page file unavailable');
        const originalBlob = await originalResponse.blob();
        const scanBlob = await scanResponse.blob();
        const { w, h } = await imageSize(originalBlob);
        const prefix = `${remote.id}_`;
        return {
          id: remotePage.id.startsWith(prefix) ? remotePage.id.slice(prefix.length) : remotePage.id,
          originalBlob,
          scanBlob,
          originalW: w,
          originalH: h,
          quad: cloneQuad(remotePage.quad)!,
          enhancement: isEnhancement(remotePage.enhancement) ? remotePage.enhancement : 'original',
          rotation: remotePage.rotation,
          edited: remotePage.edited,
          detectMeta: remotePage.detectMeta
            ? { ...remotePage.detectMeta, proposal: cloneQuad(remotePage.detectMeta.proposal) }
            : null,
        } satisfies Page;
      }));
      const local: Doc = {
        id: remote.id,
        name: remote.name,
        createdAt: remote.createdAt,
        tags: [...remote.tags],
        pages,
        outfits: [],
        archive: { status: 'uploaded', done: 0, total: 1 + pages.length, attempts: 0 },
      };
      if (existing) Object.assign(existing, local);
      else state.docs.unshift(local);
      state.curDocId = remote.id;
      actions.openRecrop(remote.id, pageIndex, 'remotedetail');
    } catch (error) {
      console.warn('remote recrop preparation failed', error);
      actions.toast('Original 读取失败');
    } finally {
      state.loading = null;
    }
  },

  setEnh(kind: Page['enhancement']) {
    const d = curDoc(); if (!d) return;
    d.pages[state.pageIdx].enhancement = kind;
    d.pages[state.pageIdx].scanBlob = undefined;
    enqueue(d);
  },
  rotate() {
    const d = curDoc(); if (!d) return;
    const p = d.pages[state.pageIdx];
    p.rotation = (p.rotation + 90) % 360;
    p.scanBlob = undefined;
    enqueue(d);
  },
  movePage(index: number, direction: number) {
    const d = curDoc(); if (!d) return;
    const target = index + direction;
    if (target < 0 || target >= d.pages.length) return;
    const [page] = d.pages.splice(index, 1);
    d.pages.splice(target, 0, page);
    enqueue(d);
    actions.toast(`第${index + 1}页移到第${target + 1}页`);
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
    activeUploads.get(id)?.abort();
    clearRetryTimer(id);
    for (let i = queue.length - 1; i >= 0; i--)
      if (queue[i].id === id) queue.splice(i, 1);
    removePersisted(id).catch(e => console.warn('opfs delete failed', e));
    if (state.curDocId === id) { state.curDocId = null; state.screen = 'home'; }
    fetch(api(`/api/docs/${id}`), { method: 'DELETE', headers: auth() });
  },
  // 失败(待人工)条目的手动重试入口(US-F3)
  retryUpload(id: string) {
    const doc = state.docs.find(d => d.id === id);
    if (!doc) return;
    enqueue(doc);
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

  async openRemoteDoc(id: string) {
    state.loading = '读取详情…';
    try {
      const response = await fetch(api(`/api/docs/${id}`), { headers: auth() });
      if (response.status === 401) { actions.toast('token 无效'); state.screen = 'gate'; return; }
      if (!response.ok) throw new Error(`detail returned ${response.status}`);
      state.remoteDoc = await response.json();
      state.remotePageIdx = 0;
      state.screen = 'remotedetail';
    } catch (error) {
      console.warn('remote detail failed', error);
      actions.toast('文档详情读取失败');
    } finally { state.loading = null; }
  },

  async updateRemoteDoc(patch: { name?: string; tags?: string[] }) {
    const doc = state.remoteDoc; if (!doc) return;
    try {
      const response = await fetch(api(`/api/docs/${doc.id}`), {
        method: 'PATCH', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`metadata returned ${response.status}`);
      const updated = await response.json();
      doc.name = updated.name;
      doc.tags = updated.tags;
      const summary = state.remoteDocs.find(item => item.id === doc.id);
      if (summary) { summary.name = updated.name; summary.tags = [...updated.tags]; }
    } catch (error) {
      console.warn('remote metadata failed', error);
      actions.toast('详情更新失败');
    }
  },

  async toggleRemoteTag(tag: string) {
    const doc = state.remoteDoc; if (!doc) return;
    const tags = doc.tags.includes(tag) ? doc.tags.filter(item => item !== tag) : [...doc.tags, tag];
    await actions.updateRemoteDoc({ tags });
  },

  async exportRemote(kind: 'image' | 'long' | 'pdf') {
    const doc = state.remoteDoc; if (!doc) return;
    state.loading = '准备成品…';
    try {
      await exportRemoteDoc(doc, kind, state.remotePageIdx, api);
      actions.toast(kind === 'pdf' ? 'PDF 已就绪' : kind === 'long' ? '长图已就绪' : '单页图已就绪');
    } catch (error) {
      console.warn('remote export failed', error);
      actions.toast('成品准备失败');
    } finally { state.loading = null; }
  },
};

export function curDoc(): Doc | null {
  return state.docs.find(d => d.id === state.curDocId) ?? null;
}

function defaultName(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cloneQuad(quad: Quad | null): Quad | null {
  return quad?.map(point => point.slice() as [number, number]) ?? null;
}

function sameQuad(left: Quad, right: Quad) {
  return left.length === right.length
    && left.every((point, index) => point[0] === right[index][0] && point[1] === right[index][1]);
}

function isEnhancement(value: string): value is Page['enhancement'] {
  return value === 'original' || value === 'gray' || value === 'bw' || value === 'color';
}

async function refreshRemotePageAfterUpload(doc: Doc, pageIndex: number) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && doc.archive.status !== 'uploaded' && doc.archive.status !== 'failed') {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (doc.archive.status !== 'uploaded' || state.remoteDoc?.id !== doc.id) return;
  const remotePage = state.remoteDoc.pages[pageIndex];
  remotePage.scan = `${remotePage.scan.split('?')[0]}?v=${Date.now()}`;
  actions.toast('重切已归档');
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

// ---------- 上传队列(US-F2: OPFS 硬持久 + 重开续传 + 失败不丢弃) ----------
// 布局: OPFS `ol-queue/<docId>/meta.json` 指向一个完整 payload 目录;
// payload 内含 Original + Scan + Outfit。先写完整 payload、最后换 meta,避免半写条目被恢复。
const MAX_ATTEMPTS = 5;
interface QueuePageSnapshot {
  id: string;
  originalW: number;
  originalH: number;
  quad: Quad;
  enhancement: Page['enhancement'];
  rotation: number;
  edited: boolean;
  detectMeta: DetectMeta | null;
  originalBlob: Blob;
  scanBlob: Blob;
}
interface QueueSnapshot {
  revision: number;
  payloadDir: string;
  id: string;
  name: string;
  createdAt: number;
  tags: string[];
  attempts: number;
  pages: QueuePageSnapshot[];
  outfits: Doc['outfits'];
}

const queue: Doc[] = [];
let draining = false;

const opfsOk = state.capabilities.opfs;
let opfsRoot: FileSystemDirectoryHandle | null = null;
let queueReady: Promise<void> = Promise.resolve();
const revisions = new Map<string, number>();
const snapshots = new Map<string, QueueSnapshot>();
const storageChains = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const deletedDocs = new Set<string>();
const activeUploads = new Map<string, AbortController>();

function enqueue(doc: Doc) {
  // 用户编辑(重切/增强/改名等)触发: 新 revision 先落盘,再允许上传。
  const queuedDoc = state.docs.find(candidate => candidate.id === doc.id) || doc;
  deletedDocs.delete(queuedDoc.id);
  clearRetryTimer(queuedDoc.id);
  queuedDoc.archive.status = 'queued';
  queuedDoc.archive.attempts = 0;
  queuedDoc.archive.total = 1 + queuedDoc.pages.length + queuedDoc.outfits.length;
  if (!queue.includes(queuedDoc)) queue.push(queuedDoc);
  const revision = (revisions.get(queuedDoc.id) || 0) + 1;
  revisions.set(queuedDoc.id, revision);
  stageDoc(queuedDoc, revision);
}

async function drain() {
  if (draining || !state.online) return;
  draining = true; state.queueBusy = true;
  try {
    while (queue.length && state.online) {
      const doc = queue[0];
      if (deletedDocs.has(doc.id)) { removeQueuedDoc(doc); continue; }
      const revision = revisions.get(doc.id);
      const snapshot = snapshots.get(doc.id);
      // 最新 revision 还没完成持久化时绝不上传旧快照。
      if (revision === undefined || !snapshot || snapshot.revision !== revision) break;
      const controller = new AbortController();
      activeUploads.set(doc.id, controller);
      try {
        doc.archive.status = 'uploading';
        doc.archive.done = 0;
        await uploadDoc(doc, snapshot, controller.signal);
        if (deletedDocs.has(doc.id)) { removeQueuedDoc(doc); continue; }
        if (revisions.get(doc.id) !== revision) {
          doc.archive.status = 'queued';
          continue; // 上传期间又有编辑,保留新 revision 继续传。
        }
        doc.archive.status = 'uploaded';
        doc.archive.done = doc.archive.total;
        doc.archive.attempts = 0;
        removeQueuedDoc(doc);
        await clearPersistedIfCurrent(doc.id, revision);
      } catch (e) {
        if (deletedDocs.has(doc.id)) { removeQueuedDoc(doc); continue; }
        if (revisions.get(doc.id) !== revision) {
          doc.archive.status = 'queued';
          continue;
        }
        if (!state.online) { doc.archive.status = 'queued'; break; }
        // 在线但失败(网络错/5xx): 不丢弃,指数退避重试;超限转人工
        doc.archive.attempts++;
        snapshot.attempts = doc.archive.attempts;
        await persistArchiveState(snapshot);
        if (revisions.get(doc.id) !== revision) {
          doc.archive.status = 'queued';
          continue;
        }
        if (doc.archive.attempts >= MAX_ATTEMPTS) {
          doc.archive.status = 'failed';
          removeQueuedDoc(doc);
          actions.toast(`「${doc.name}」上传失败 ${MAX_ATTEMPTS} 次,待人工重试`);
          continue;
        }
        doc.archive.status = 'queued';
        actions.toast(`「${doc.name}」上传失败,稍后重试(${doc.archive.attempts}/${MAX_ATTEMPTS})`);
        retryTimers.set(doc.id, setTimeout(() => {
          retryTimers.delete(doc.id);
          drain();
        }, backoff(doc.archive.attempts)));
        break;
      } finally {
        if (activeUploads.get(doc.id) === controller) activeUploads.delete(doc.id);
      }
    }
  } finally { draining = false; state.queueBusy = false; }
}

function backoff(attempts: number) {
  return Math.min(4000 * 2 ** (attempts - 1), 60_000);
}

async function uploadDoc(doc: Doc, snapshot: QueueSnapshot, signal: AbortSignal) {
  const fd = new FormData();
  fd.set('meta', JSON.stringify({
    id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt, tags: snapshot.tags,
    pages: snapshot.pages.map(p => ({
      id: p.id, quad: p.quad, enhancement: p.enhancement, rotation: p.rotation,
      edited: p.edited, detectMeta: p.detectMeta,
    })),
    outfits: snapshot.outfits.map(o => ({ id: o.id, kind: o.kind, ext: o.ext })),
  }));
  for (let i = 0; i < snapshot.pages.length; i++) {
    const p = snapshot.pages[i];
    fd.set(`original_${i}`, p.originalBlob, `o${i}.jpg`);
    fd.set(`scan_${i}`, p.scanBlob, `s${i}.jpg`);
    doc.archive.done++;
  }
  snapshot.outfits.forEach((o, i) => fd.set(`outfit_${i}`, o.blob, `outfit${i}.${o.ext}`));
  doc.archive.done++;

  const r = await fetch(api('/api/docs'), { method: 'POST', headers: auth(), body: fd, signal });
  if (!r.ok) throw new Error('upload ' + r.status);
}

// ---------- OPFS 读写(无第三方依赖;不可用时整体退回内存队列) ----------
async function opfsQueueDir(): Promise<FileSystemDirectoryHandle> {
  if (!opfsRoot) opfsRoot = await navigator.storage.getDirectory();
  return opfsRoot.getDirectoryHandle('ol-queue', { create: true });
}

async function opfsWrite(dir: FileSystemDirectoryHandle, name: string, data: string | Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function buildSnapshot(doc: Doc, revision: number, previous?: QueueSnapshot): Promise<QueueSnapshot> {
  const pages: QueuePageSnapshot[] = [];
  for (const p of doc.pages) {
    const scanBlob = p.scanBlob || await renderScanBlob(p);
    p.scanBlob = scanBlob;
    pages.push({
      id: p.id, originalW: p.originalW, originalH: p.originalH,
      quad: p.quad.map(q => q.slice() as [number, number]),
      enhancement: p.enhancement, rotation: p.rotation,
      edited: p.edited,
      detectMeta: p.detectMeta ? { ...p.detectMeta, proposal: cloneQuad(p.detectMeta.proposal) } : null,
      originalBlob: p.originalBlob, scanBlob,
    });
  }
  const outfits = doc.outfits.map(o => ({ ...o }));
  const payloadUnchanged = !!previous
    && previous.pages.length === pages.length
    && previous.outfits.length === outfits.length
    && pages.every((p, i) => previous.pages[i].id === p.id
      && previous.pages[i].originalBlob === p.originalBlob
      && previous.pages[i].scanBlob === p.scanBlob)
    && outfits.every((o, i) => previous.outfits[i].id === o.id
      && previous.outfits[i].blob === o.blob
      && previous.outfits[i].ext === o.ext);
  return {
    revision,
    payloadDir: payloadUnchanged ? previous!.payloadDir : `r-${Date.now()}-${revision}`,
    id: doc.id, name: doc.name, createdAt: doc.createdAt, tags: [...doc.tags],
    attempts: doc.archive.attempts,
    pages,
    outfits,
  };
}

function snapshotMeta(snapshot: QueueSnapshot) {
  return {
    version: 1,
    revision: snapshot.revision,
    payloadDir: snapshot.payloadDir,
    id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt,
    tags: snapshot.tags, attempts: snapshot.attempts,
    pages: snapshot.pages.map((p, i) => ({
      id: p.id, originalW: p.originalW, originalH: p.originalH,
      quad: p.quad, enhancement: p.enhancement, rotation: p.rotation,
      edited: p.edited, detectMeta: p.detectMeta,
      originalFile: `original_${i}.jpg`, scanFile: `scan_${i}.jpg`,
    })),
    outfits: snapshot.outfits.map((o, i) => ({
      id: o.id, kind: o.kind, ext: o.ext, file: `outfit_${i}.${o.ext}`,
    })),
  };
}

async function writeSnapshotMeta(snapshot: QueueSnapshot) {
  const ddir = await (await opfsQueueDir()).getDirectoryHandle(snapshot.id, { create: true });
  await opfsWrite(ddir, 'meta.json', JSON.stringify(snapshotMeta(snapshot)));
}

async function persistSnapshot(snapshot: QueueSnapshot) {
  const ddir = await (await opfsQueueDir()).getDirectoryHandle(snapshot.id, { create: true });
  const payload = await ddir.getDirectoryHandle(snapshot.payloadDir, { create: true });
  for (let i = 0; i < snapshot.pages.length; i++) {
    await opfsWrite(payload, `original_${i}.jpg`, snapshot.pages[i].originalBlob);
    await opfsWrite(payload, `scan_${i}.jpg`, snapshot.pages[i].scanBlob);
  }
  for (let i = 0; i < snapshot.outfits.length; i++)
    await opfsWrite(payload, `outfit_${i}.${snapshot.outfits[i].ext}`, snapshot.outfits[i].blob);
  await writeSnapshotMeta(snapshot); // commit point:完整 payload 写完后才切 manifest

  for await (const [name, handle] of (ddir as any).entries()) {
    if (name !== 'meta.json' && name !== snapshot.payloadDir)
      await ddir.removeEntry(name, { recursive: handle.kind === 'directory' });
  }
}

function stageDoc(doc: Doc, revision: number) {
  const previous = storageChains.get(doc.id) || queueReady;
  const task = previous.catch(() => {}).then(async () => {
    if (deletedDocs.has(doc.id) || revisions.get(doc.id) !== revision) return;
    const previousSnapshot = snapshots.get(doc.id);
    const snapshot = await buildSnapshot(doc, revision, previousSnapshot);
    if (deletedDocs.has(doc.id) || revisions.get(doc.id) !== revision) return;
    if (state.queuePersistent) {
      try {
        if (previousSnapshot?.payloadDir === snapshot.payloadDir) await writeSnapshotMeta(snapshot);
        else await persistSnapshot(snapshot);
      }
      catch (e) { degradePersistence('opfs persist failed', e); }
    }
    if (deletedDocs.has(doc.id) || revisions.get(doc.id) !== revision) return;
    snapshots.set(doc.id, snapshot);
    drain();
  });
  storageChains.set(doc.id, task);
  task.catch(e => {
    console.error('queue staging failed', e);
    if (revisions.get(doc.id) !== revision || deletedDocs.has(doc.id)) return;
    doc.archive.attempts = MAX_ATTEMPTS;
    doc.archive.status = 'failed';
    removeQueuedDoc(doc);
    actions.toast(`「${doc.name}」生成待传数据失败,待人工重试`);
  });
}

async function withStorageLock(docId: string, fn: () => Promise<void>) {
  const previous = storageChains.get(docId) || Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  storageChains.set(docId, task);
  await task;
}

async function persistArchiveState(snapshot: QueueSnapshot) {
  if (!state.queuePersistent) return;
  try {
    await withStorageLock(snapshot.id, async () => {
      if (snapshots.get(snapshot.id) === snapshot) await writeSnapshotMeta(snapshot);
    });
  } catch (e) { degradePersistence('opfs archive state failed', e); }
}

async function clearPersistedIfCurrent(docId: string, revision: number) {
  await withStorageLock(docId, async () => {
    if (revisions.get(docId) !== revision || deletedDocs.has(docId)) return;
    if (opfsRoot) {
      try { await (await opfsQueueDir()).removeEntry(docId, { recursive: true }); }
      catch (e: any) { if (e?.name !== 'NotFoundError') throw e; }
    }
  });
  if (revisions.get(docId) === revision && !deletedDocs.has(docId)) {
    revisions.delete(docId);
    snapshots.delete(docId);
    storageChains.delete(docId);
  }
}

function removeQueuedDoc(doc: Doc) {
  const i = queue.indexOf(doc);
  if (i >= 0) queue.splice(i, 1);
  clearRetryTimer(doc.id);
}

function clearRetryTimer(docId: string) {
  const timer = retryTimers.get(docId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(docId);
}

function degradePersistence(message: string, error: unknown) {
  console.warn(message, error);
  if (state.queuePersistent) actions.toast('本机持久队列不可用,本次仅保留在内存');
  state.queuePersistent = false;
  state.queueStorageReady = true;
}

async function removePersisted(docId: string) {
  deletedDocs.add(docId);
  revisions.set(docId, (revisions.get(docId) || 0) + 1); // 使正在生成的快照失效
  await withStorageLock(docId, async () => {
    if (!opfsRoot) return;
    try { await (await opfsQueueDir()).removeEntry(docId, { recursive: true }); }
    catch (e: any) { if (e?.name !== 'NotFoundError') throw e; }
  });
  snapshots.delete(docId);
  revisions.delete(docId);
  storageChains.delete(docId);
}

// 启动恢复:从 OPFS 重建队列(重开续传);失败条目按持久化 attempts 恢复为待人工。
async function restoreQueue() {
  const qdir = await opfsQueueDir();
  const ids: string[] = [];
  for await (const name of (qdir as any).keys()) ids.push(name);
  for (const id of ids.sort()) {
    try {
      const ddir = await qdir.getDirectoryHandle(id);
      const meta = JSON.parse(await (await (await ddir.getFileHandle('meta.json')).getFile()).text());
      const payload = meta.payloadDir ? await ddir.getDirectoryHandle(meta.payloadDir) : ddir;
      const pages: Page[] = [];
      for (let i = 0; i < meta.pages.length; i++) {
        const p = meta.pages[i];
        const originalBlob = await (await payload.getFileHandle(p.originalFile || `original_${i}.jpg`)).getFile();
        let scanBlob: Blob | undefined;
        try { scanBlob = await (await payload.getFileHandle(p.scanFile || `scan_${i}.jpg`)).getFile(); }
        catch { /* 兼容未完成的早期 F2 草稿:随后从 Original 重建并升级条目 */ }
        pages.push({
          id: p.id, originalW: p.originalW, originalH: p.originalH,
          quad: p.quad, enhancement: p.enhancement, rotation: p.rotation,
          edited: Boolean(p.edited), detectMeta: p.detectMeta ?? null,
          originalBlob, scanBlob,
        });
      }
      const outfits: Doc['outfits'] = [];
      for (let i = 0; i < (meta.outfits || []).length; i++) {
        const o = meta.outfits[i];
        const blob = await (await payload.getFileHandle(o.file || `outfit_${i}.${o.ext}`)).getFile();
        outfits.push({ id: o.id, kind: o.kind, ext: o.ext, blob });
      }
      const attempts = meta.attempts || 0;
      const doc: Doc = {
        id: meta.id, name: meta.name, createdAt: meta.createdAt, tags: meta.tags || [],
        pages, outfits,
        archive: {
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
          done: 0, total: 1 + pages.length + outfits.length, attempts,
        },
      };
      if (state.docs.some(d => d.id === doc.id)) continue;
      const revision = meta.revision || 1;
      let snapshot: QueueSnapshot;
      if (!meta.payloadDir || pages.some(p => !p.scanBlob)) {
        snapshot = await buildSnapshot(doc, revision);
        if (state.queuePersistent) await persistSnapshot(snapshot);
      } else {
        snapshot = {
          revision, payloadDir: meta.payloadDir,
          id: doc.id, name: doc.name, createdAt: doc.createdAt, tags: [...doc.tags], attempts,
          pages: pages.map(p => ({ ...p, scanBlob: p.scanBlob! })),
          outfits: outfits.map(o => ({ ...o })),
        };
      }
      state.docs.push(doc);
      const restoredDoc = state.docs.find(candidate => candidate.id === doc.id)!;
      revisions.set(doc.id, revision);
      snapshots.set(doc.id, snapshot);
      if (restoredDoc.archive.status !== 'failed' && !queue.includes(restoredDoc)) queue.push(restoredDoc);
    } catch (e) { console.warn('opfs restore entry failed', id, e); }
  }
}

async function initializeQueue() {
  if (!opfsOk) { state.queueStorageReady = true; return; }
  try {
    opfsRoot = await navigator.storage.getDirectory();
    state.queuePersistent = true;
    try { await navigator.storage.persist?.(); } catch { /* 尽力请求,结果不强求 */ }
    await restoreQueue();
  } catch (e) {
    degradePersistence('opfs unavailable,退回内存队列', e);
  } finally {
    state.queueStorageReady = true;
  }
  await drain();
}

queueReady = initializeQueue();

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
