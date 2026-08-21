<template>
  <div class="pedit">
    <div class="bar">
      <button class="linkbtn completeButton" aria-label="完成编辑并返回文档" @click="complete">完成</button>
      <div class="pageContext">
        <h1 ref="pageTitle" class="pageTitle" tabindex="-1">{{ d?.name }}</h1>
        <b class="pageNumber">第 {{ s.pageIdx + 1 }} / {{ d?.pages.length }} 页</b>
      </div>
      <span class="barSpacer" aria-hidden="true"></span>
    </div>
    <div class="viewer" v-if="p">
      <button class="linkbtn nav" :disabled="s.pageIdx === 0" @click="s.pageIdx--">‹</button>
      <div class="imgwrap"><PageThumb :page="p" :width="560" /></div>
      <button class="linkbtn nav" :disabled="s.pageIdx >= (d?.pages.length ?? 1) - 1" @click="s.pageIdx++">›</button>
    </div>
    <div class="sheetbody">
      <section class="saveStatus" :class="saveTone" role="status" aria-live="polite" aria-atomic="true">
        <div><strong>{{ localSaveLabel }}</strong><span> · {{ archiveLabel }}</span></div>
        <p class="hint">{{ ENH_LABELS[p?.enhancement ?? 'original'] }}{{ p?.rotation ? ` · ${p.rotation}°` : '' }}</p>
        <div v-if="showLocalRetry || d?.archive.status === 'failed'" class="statusActions">
          <button v-if="showLocalRetry" class="statusAction" @click="actions.retryLocalSave(d!.id)">重试本机保存</button>
          <button v-if="d?.archive.status === 'failed'" class="statusAction" @click="actions.retryUpload(d.id)">重试上传</button>
        </div>
      </section>
      <div class="row" style="margin-bottom:10px">
        <button v-for="(label, k) in ENH_LABELS" :key="k" class="btn" :class="{ primary: p?.enhancement === k }" @click="actions.setEnh(k as any)">{{ label }}</button>
      </div>
      <div class="row">
        <button data-recrop-trigger class="btn plain" @click="actions.openRecrop(d!.id, s.pageIdx)">↝ 重切</button>
        <button class="btn plain" @click="actions.rotate()">⟳ 旋转</button>
        <button class="btn plain" style="color:#ff6b62" @click="delPage">删页</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { state as s, actions, curDoc, RECROP_HISTORY_STATE_KEY } from '../store';
import { ENH_LABELS } from '../types';
import PageThumb from '../components/PageThumb.vue';

const d = computed(() => curDoc());
const p = computed(() => d.value?.pages[s.pageIdx]);
const pageTitle = ref<HTMLElement>();
const localSaveLabel = computed(() => {
  const localSave = d.value?.localSave;
  if (d.value?.archive.status === 'uploaded') return '已自动保存';
  if (!localSave || localSave.status === 'saving') return '正在保存到本机';
  if (localSave.status === 'failed') return '本机持久化失败，本次会话仍保留';
  return localSave.storage === 'device' ? '已自动保存到本机' : '已在本次会话保存';
});
const archiveLabel = computed(() => {
  const archive = d.value?.archive;
  if (!archive || archive.status === 'idle' || archive.status === 'queued') return '待上传';
  if (archive.status === 'uploading') return `正在归档 ${archive.done}/${archive.total}`;
  if (archive.status === 'failed') return '上传失败';
  return '已归档';
});
const showLocalRetry = computed(() => d.value?.localSave.status === 'failed'
  && d.value.archive.status !== 'uploaded'
  && s.capabilities.opfs);
const saveTone = computed(() => ({
  saving: d.value?.localSave.status === 'saving',
  error: d.value?.archive.status !== 'uploaded'
    && (d.value?.localSave.status === 'failed' || d.value?.archive.status === 'failed'),
  saved: d.value?.archive.status === 'uploaded',
}));

onMounted(() => {
  if (!history.state?.[RECROP_HISTORY_STATE_KEY]) {
    nextTick(() => pageTitle.value?.focus({ preventScroll: true }));
  }
});

function complete() {
  const pageId = p.value?.id;
  actions.completePageEdit();
  nextTick(() => {
    if (!pageId) return;
    const target = [...document.querySelectorAll<HTMLElement>('[data-page-id]')]
      .find(element => element.dataset.pageId === pageId);
    target?.focus({ preventScroll: true });
  });
}
function delPage() {
  const doc = d.value!;
  if (doc.pages.length <= 1) {
    if (confirm('这是最后一页,删除将移除整个文档,确定?')) actions.deleteDoc(doc.id);
  } else if (confirm(`删除第 ${s.pageIdx + 1} 页?`)) {
    actions.deletePage();
  }
}
</script>

<style scoped>
.pedit { display: flex; flex-direction: column; min-height: 100dvh; background: #0b0b0d; }
.pedit .bar { padding: calc(env(safe-area-inset-top) + 6px) 16px 10px; }
.completeButton, .barSpacer { width: 54px; }
.completeButton { text-align: left; font-weight: 700; }
.barSpacer { display: block; }
.pageContext { min-width: 0; text-align: center; }
.pageTitle { max-width: 220px; overflow: hidden; color: var(--tx); font-size: 13px; font-weight: 600; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.pageTitle:focus { outline: none; }
.pageNumber { display: block; margin-top: 1px; font-size: 12px !important; color: var(--dim); font-weight: 500; }
.viewer { flex: 1; min-height: 0; display: flex; align-items: center; gap: 4px; padding: 0 8px; }
.nav { font-size: 30px; padding: 8px; color: #fff; }
.nav:disabled { opacity: .3; }
.imgwrap { flex: 1; text-align: center; }
.imgwrap :deep(canvas) { border: 1px solid var(--line); border-radius: 12px; }
.sheetbody { background: #141416; border-top: 1px solid var(--line); border-radius: 26px 26px 0 0; padding: 16px 16px calc(env(safe-area-inset-bottom) + 16px); }
.saveStatus { position: relative; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: #1d1d21; color: var(--tx); font-size: 13px; line-height: 1.5; }
.saveStatus.saving { color: #ff9f0a; }
.saveStatus.saved { color: #30d158; }
.saveStatus.error { border-color: rgba(255,69,58,.4); color: #ff6b62; }
.statusActions { display: flex; gap: 14px; margin-top: 7px; }
.statusAction { border: 0; background: transparent; color: var(--acc); font: inherit; font-weight: 700; cursor: pointer; }
.pedit button:focus-visible { outline: 2px solid var(--acc); outline-offset: 3px; }
</style>
