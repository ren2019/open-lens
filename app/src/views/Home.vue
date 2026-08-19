<template>
  <div class="pad">
    <div class="bar">
      <b>Open-Lens</b>
      <span class="hint">
        <span :class="s.online ? 'ok' : 'warn'">● {{ s.online ? '在线' : '离线' }}</span>
        · {{ s.cvReady ? 'cv ✓' : 'cv 缺(降级)' }}
      </span>
    </div>
    <div class="card">
      <div class="hint">自托管文档扫描 · 处理全部在本机完成 · 归档到自有服务器</div>
      <div v-if="queueCount" class="hint warn" style="margin-top:6px">
        待上传 {{ queueCount }} 个文档{{ s.queueBusy ? '(上传中…)' : '' }}
      </div>
    </div>
    <button class="btn primary" @click="actions.openCamera()">📷 开始扫描</button>
    <button class="btn plain" @click="lib">🗂 历史(服务端 {{ s.remoteDocs.length }})</button>
    <div v-if="s.docs.length" class="card" style="margin-top:12px">
      <div class="hint" style="margin-bottom:6px">本会话产出</div>
      <div v-for="d in s.docs" :key="d.id" class="docline" @click="open(d.id)">
        <b>{{ d.name }}</b>
        <span class="hint"> · {{ d.pages.length }}页 · {{ arcLabel(d) }}</span>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { state as s, actions } from '../store';
const queueCount = computed(() => s.docs.filter(d => d.archive.status !== 'uploaded').length);
function arcLabel(d: any) {
  if (d.archive.status === 'uploaded') return '已归档';
  if (d.archive.status === 'uploading') return `上传中 ${d.archive.done}/${d.archive.total}`;
  return `排队 ${d.archive.done}/${d.archive.total}`;
}
function open(id: string) { s.curDocId = id; actions.go('docgrid'); }
async function lib() { await actions.refreshLibrary(); actions.go('library'); }
</script>
<style scoped>
.docline { padding: 7px 0; cursor: pointer; border-top: 1px solid var(--line); font-size: 14px; }
</style>
