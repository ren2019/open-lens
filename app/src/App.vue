<template>
  <div class="app">
    <component :is="screenComp" />
    <div v-if="!hardBlocked" class="queueIndicator" :class="[`on-${s.screen}`, { warn: queueCount > 0 || queueDegraded, err: failedCount > 0 }]" role="status" aria-live="polite">
      待上传 {{ queueCount }} 个文档{{ s.queueBusy ? ' · 上传中' : failedCount ? ` · ${failedCount} 个待重试` : '' }}<span v-if="queueDegraded" class="queueDegraded"> · 仅会话，关闭会丢失</span>
    </div>
    <aside v-if="showInstallGuide" class="installGuide" aria-label="安装到主屏幕提示">
      <button class="installClose" aria-label="关闭安装提示" @click="s.installGuideDismissed = true">×</button>
      <b>添加到主屏幕，守住离线队列</b>
      <p>普通浏览器标签页的本地数据可能在 7 天无交互后被清理。请用分享或安装菜单选择“添加到主屏幕”；只有主屏 PWA 承诺持久保存待传文档。</p>
    </aside>
    <div
      v-if="s.cvStatus === 'loading'"
      class="cvLoadIndicator"
      role="progressbar"
      aria-label="OpenCV 本地能力加载进度"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="s.cvLoadProgress ?? undefined"
    >
      <span>OpenCV 本地能力</span>
      <b>{{ s.cvLoadProgress === null ? '加载中…' : `${s.cvLoadProgress}%` }}</b>
      <i><span :class="{ indeterminate: s.cvLoadProgress === null }" :style="s.cvLoadProgress === null ? undefined : { width: `${s.cvLoadProgress}%` }"></span></i>
    </div>
    <div v-if="s.loading" class="overlay"><div class="spin"></div><div>{{ s.loading }}</div></div>
    <div v-if="s.toast" class="toast">{{ s.toast }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted } from 'vue';
import {
  actions, clearPageEditFocusIntent, consumeRecropPageEditHistoryReturn, DOC_WORKSPACE_HISTORY_STATE_KEY,
  PAGE_EDIT_HISTORY_STATE_KEY, prepareRecropPageEditReturn, RECROP_HISTORY_STATE_KEY, state as s,
  type PageEditContext, type RecropContext,
} from './store';
import { hasHardCapabilityFailure } from './capabilities';
import { warmupDetector } from './detector';
import CapabilityGateVue from './views/CapabilityGate.vue';
import GateVue from './views/Gate.vue';
import HomeVue from './views/Home.vue';
import CameraVue from './views/Camera.vue';
import CropVue from './views/Crop.vue';
import DocGridVue from './views/DocGrid.vue';
import PageEditVue from './views/PageEdit.vue';
import LibraryVue from './views/Library.vue';
import RemoteDetailVue from './views/RemoteDetail.vue';

const MAP: Record<string, any> = {
  gate: GateVue, home: HomeVue, camera: CameraVue, crop: CropVue,
  docgrid: DocGridVue, pageedit: PageEditVue, library: LibraryVue,
  remotedetail: RemoteDetailVue,
};
const hardBlocked = computed(() => hasHardCapabilityFailure(s.capabilities));
const screenComp = computed(() => hardBlocked.value ? CapabilityGateVue : (MAP[s.screen] ?? HomeVue));
const queueCount = computed(() => s.docs.filter(d => d.archive.status !== 'uploaded').length);
const failedCount = computed(() => s.docs.filter(d => d.archive.status === 'failed').length);
const queueDegraded = computed(() => s.queueStorageReady && !s.queuePersistent);
const showInstallGuide = computed(() => !hardBlocked.value
  && (s.screen === 'gate' || s.screen === 'home')
  && !s.capabilities.installed
  && !s.installGuideDismissed);

function recropContextFromHistory(historyState: unknown): RecropContext | null {
  if (!historyState || typeof historyState !== 'object') return null;
  const value = (historyState as Record<string, unknown>)[RECROP_HISTORY_STATE_KEY];
  if (!value || typeof value !== 'object') return null;
  const context = value as Record<string, unknown>;
  if (typeof context.docId !== 'string'
    || typeof context.pageId !== 'string'
    || !Number.isInteger(context.pageIndex) || (context.pageIndex as number) < 0
    || (context.returnTo !== 'pageedit' && context.returnTo !== 'remotedetail')) return null;
  return context as unknown as RecropContext;
}

function pageEditContextFromHistory(historyState: unknown): PageEditContext | null {
  if (!historyState || typeof historyState !== 'object') return null;
  const value = (historyState as Record<string, unknown>)[PAGE_EDIT_HISTORY_STATE_KEY];
  if (!value || typeof value !== 'object') return null;
  const context = value as Record<string, unknown>;
  if (typeof context.docId !== 'string' || typeof context.pageId !== 'string') return null;
  return context as unknown as PageEditContext;
}

function docWorkspaceContextFromHistory(historyState: unknown): PageEditContext | null {
  if (!historyState || typeof historyState !== 'object') return null;
  const value = (historyState as Record<string, unknown>)[DOC_WORKSPACE_HISTORY_STATE_KEY];
  if (!value || typeof value !== 'object') return null;
  const context = value as Record<string, unknown>;
  if (typeof context.docId !== 'string' || typeof context.pageId !== 'string') return null;
  return context as unknown as PageEditContext;
}

function removeRecropHistoryState(historyState: unknown) {
  if (!historyState || typeof historyState !== 'object') return;
  const nextState = { ...(historyState as Record<string, unknown>) };
  delete nextState[RECROP_HISTORY_STATE_KEY];
  history.replaceState(nextState, '');
}

function removePageEditHistoryState(historyState: unknown) {
  if (!historyState || typeof historyState !== 'object') return;
  const nextState = { ...(historyState as Record<string, unknown>) };
  delete nextState[PAGE_EDIT_HISTORY_STATE_KEY];
  history.replaceState(nextState, '');
}

function restorePageFocus(pageId: string | undefined) {
  if (!pageId) return;
  nextTick(() => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-page-id]')]
      .find(element => element.dataset.pageId === pageId);
    target?.focus({ preventScroll: true });
  });
}

function onHistoryNavigation(event: PopStateEvent) {
  const context = recropContextFromHistory(event.state);
  if (context) {
    if (actions.restoreRecrop(context) && s.recropCtx) {
      history.replaceState({ ...event.state, [RECROP_HISTORY_STATE_KEY]: { ...s.recropCtx } }, '');
      return;
    }
    clearPageEditFocusIntent();
    removeRecropHistoryState(event.state);
    return;
  }
  if (s.cropMode === 'recrop') {
    prepareRecropPageEditReturn(true);
    actions.cancelRecrop();
  }
  const recropPageEditReturn = consumeRecropPageEditHistoryReturn();
  if (recropPageEditReturn) {
    if (actions.restorePageEditor(recropPageEditReturn)) {
      const nextState = { ...(event.state as Record<string, unknown>) };
      delete nextState[DOC_WORKSPACE_HISTORY_STATE_KEY];
      delete nextState[RECROP_HISTORY_STATE_KEY];
      history.replaceState({ ...nextState, [PAGE_EDIT_HISTORY_STATE_KEY]: recropPageEditReturn }, '');
      return;
    }
    clearPageEditFocusIntent();
  }
  const workspaceContext = docWorkspaceContextFromHistory(event.state);
  if (s.screen === 'pageedit' && workspaceContext && actions.restorePageEditor(workspaceContext)) {
    const nextState = { ...(event.state as Record<string, unknown>) };
    delete nextState[DOC_WORKSPACE_HISTORY_STATE_KEY];
    history.replaceState({ ...nextState, [PAGE_EDIT_HISTORY_STATE_KEY]: workspaceContext }, '');
    return;
  }
  const pageEditContext = pageEditContextFromHistory(event.state);
  if (pageEditContext) {
    if (actions.restorePageEditor(pageEditContext)) return;
    removePageEditHistoryState(event.state);
    return;
  }
  if (s.screen === 'pageedit') {
    const pageId = s.docs.find(doc => doc.id === s.curDocId)?.pages[s.pageIdx]?.id;
    actions.completePageEdit(false);
    restorePageFocus(pageId);
  }
}

onMounted(() => {
  window.addEventListener('popstate', onHistoryNavigation);
  if (hardBlocked.value) return;
  // cv 预热延迟 2.5s:10MB WASM 内联构建的编译会阻塞主线程,
  // 放在首屏交互之后,gate/home 先可用(检测在拍后异步进行,不阻塞旅程)
  setTimeout(() => {
    s.cvStatus = 'loading';
    s.cvLoadProgress = 0;
    warmupDetector(
      ok => {
        s.cvReady = ok;
        s.cvStatus = ok ? 'ready' : 'fallback';
      },
      progress => {
        s.cvLoadProgress = progress.percent;
        s.cvCacheHit = progress.cacheHit;
      },
    );
  }, 2500);
});
onBeforeUnmount(() => window.removeEventListener('popstate', onHistoryNavigation));
</script>

<style>
/* 变体 A「暗场相机」全局主题:深底 #0b0b0d + 强调黄 #ffd60a + 毛玻璃小控件 */
:root {
  --acc: #ffd60a; --tx: #f2f2f7; --dim: #9a9aa2;
  --glass: rgba(24,24,28,.72); --line: rgba(255,255,255,.12); --sheet: #141416;
}
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body, #app { height: 100%; }
body {
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  background: #0b0b0d; color: var(--tx);
  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);
}
.app { max-width: 640px; margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; }
.pad { padding: 14px 16px; flex: 1; }
.bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 2px 12px; gap: 6px; }
.bar b { font-size: 17px; }
.btn { display: block; width: 100%; border: none; border-radius: 999px; padding: 13px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 10px; background: #232328; color: var(--tx); }
.btn.primary { background: var(--acc); color: #000; font-weight: 700; }
.btn.plain { background: #232328; color: var(--tx); border: 1px solid var(--line); }
.btn.danger { background: rgba(255,69,58,.14); color: #ff6b62; border: 1px solid rgba(255,69,58,.4); }
.btn:disabled { opacity: .4; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.row .btn { flex: 1; min-width: 96px; margin-bottom: 0; font-size: 14px; padding: 11px; }
.card { background: var(--sheet); border: 1px solid var(--line); border-radius: 16px; padding: 12px; margin-bottom: 10px; }
.hint { font-size: 12px; color: var(--dim); line-height: 1.5; }
.chip { background: #232328; color: #cfcfd6; border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.chip.on { background: rgba(255,214,10,.16); color: var(--acc); border-color: rgba(255,214,10,.4); }
.ok { color: #30d158; } .warn { color: #ff9f0a; } .err { color: #ff453a; }
.linkbtn { background: none; border: none; color: var(--acc); font-size: 14px; cursor: pointer; padding: 4px; }
input.textField { width: 100%; border: 1px solid var(--line); background: #1d1d21; color: #fff; border-radius: 12px; padding: 12px 14px; font-size: 15px; outline: none; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 90; display: flex; align-items: center; justify-content: center; color: #fff; flex-direction: column; gap: 12px; font-size: 15px; }
.spin { width: 34px; height: 34px; border: 3px solid #ffffff55; border-top-color: #fff; border-radius: 50%; animation: rot .8s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }
.toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); background: rgba(24,24,28,.92); border: 1px solid var(--line); color: #fff; border-radius: 999px; padding: 10px 18px; font-size: 14px; z-index: 95; max-width: 86%; }
.queueIndicator { position: fixed; right: 10px; bottom: calc(env(safe-area-inset-bottom) + 10px); z-index: 80; pointer-events: none; padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; background: rgba(24,24,28,.88); color: var(--dim); font-size: 11px; line-height: 1; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.queueIndicator.on-camera, .queueIndicator.on-crop, .queueIndicator.on-pageedit { top: calc(env(safe-area-inset-top) + 58px); bottom: auto; }
@media (orientation: landscape) and (max-height: 500px) {
  .queueIndicator.on-camera {
    top: calc(env(safe-area-inset-top) + 18px);
    right: auto;
    left: 50%;
    transform: translateX(-50%);
  }
}
.queueDegraded { color: #ff9f0a; }
.installGuide { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom) + 42px); z-index: 86; width: min(600px, calc(100% - 24px)); transform: translateX(-50%); padding: 14px 42px 14px 16px; border: 1px solid rgba(255,214,10,.35); border-radius: 16px; background: rgba(24,24,28,.96); color: var(--tx); box-shadow: 0 12px 36px rgba(0,0,0,.35); }
.installGuide b { display: block; margin-bottom: 5px; color: var(--acc); font-size: 14px; }
.installGuide p { color: var(--dim); font-size: 12px; line-height: 1.5; }
.installClose { position: absolute; top: 7px; right: 9px; width: 30px; height: 30px; border: 0; background: transparent; color: var(--dim); font-size: 22px; cursor: pointer; }
.cvLoadIndicator { position: fixed; top: calc(env(safe-area-inset-top) + 10px); left: 50%; z-index: 88; width: min(360px, calc(100% - 24px)); transform: translateX(-50%); display: grid; grid-template-columns: 1fr auto; gap: 5px 12px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(24,24,28,.96); color: var(--dim); font-size: 11px; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.cvLoadIndicator b { color: var(--tx); font-weight: 600; }
.cvLoadIndicator > i { grid-column: 1 / -1; height: 3px; overflow: hidden; border-radius: 99px; background: #34343a; }
.cvLoadIndicator > i > span { display: block; height: 100%; border-radius: inherit; background: var(--acc); transition: width .12s linear; }
.cvLoadIndicator > i > span.indeterminate { width: 38%; animation: cvSlide 1s ease-in-out infinite; }
@keyframes cvSlide { from { transform: translateX(-110%); } to { transform: translateX(300%); } }
</style>
