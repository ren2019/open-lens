<template>
  <div class="pad">
    <div class="bar">
      <b>Open-Lens</b>
      <span class="hint">
        <span :class="s.online ? 'ok' : 'warn'">● {{ s.online ? '在线' : '离线' }}</span>
        · {{ cvLabel }}
      </span>
    </div>
    <div class="card">
      <div class="hint">自托管文档扫描 · 处理全部在本机完成 · 归档到自有服务器</div>
    </div>
    <button class="btn primary" @click="actions.openCamera()">📷 开始扫描</button>
    <button class="btn plain" @click="lib">🗂 历史(服务端 {{ s.remoteDocs.length }})</button>
    <div v-if="s.docs.length" class="card" style="margin-top:12px">
      <div class="hint" style="margin-bottom:6px">本会话产出</div>
      <div v-for="d in s.docs" :key="d.id" class="docline" @click="open(d.id)">
        <b>{{ d.name }}</b>
        <span class="hint"> · {{ d.pages.length }}页 · {{ arcLabel(d) }}</span>
        <button v-if="d.archive.status === 'failed'" class="retrybtn" @click.stop="actions.retryUpload(d.id)">重试</button>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { state as s, actions } from '../store';
const cvLabel = computed(() => {
  if (s.cvStatus === 'loading') return 'cv 加载中';
  if (s.cvReady) return s.cvCacheHit ? 'cv ✓ · 缓存' : 'cv ✓';
  return 'cv 缺(降级)';
});
function arcLabel(d: any) {
  if (d.archive.status === 'uploaded') return '已归档';
  if (d.archive.status === 'uploading') return `上传中 ${d.archive.done}/${d.archive.total}`;
  if (d.archive.status === 'failed') return '上传失败·待人工';
  return `排队 ${d.archive.done}/${d.archive.total}`;
}
function open(id: string) { s.curDocId = id; actions.go('docgrid'); }
async function lib() { await actions.refreshLibrary(); actions.go('library'); }
</script>
<style scoped>
.docline { padding: 7px 0; cursor: pointer; border-top: 1px solid var(--line); font-size: 14px; }
.retrybtn { margin-left: 8px; border: 1px solid var(--line); background: #2c2c30; color: var(--tx); border-radius: 6px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
</style>
