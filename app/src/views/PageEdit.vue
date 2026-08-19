<template>
  <div class="pedit">
    <div class="bar">
      <button class="linkbtn" @click="actions.go('docgrid')">‹ 网格</button>
      <b>{{ s.pageIdx + 1 }}/{{ d?.pages.length }}</b>
      <span class="hint">{{ ENH_LABELS[p?.enhancement ?? 'original'] }}{{ p?.rotation ? ` · ${p.rotation}°` : '' }}</span>
    </div>
    <div class="viewer" v-if="p">
      <button class="linkbtn nav" :disabled="s.pageIdx === 0" @click="s.pageIdx--">‹</button>
      <div class="imgwrap"><PageThumb :page="p" :width="560" /></div>
      <button class="linkbtn nav" :disabled="s.pageIdx >= (d?.pages.length ?? 1) - 1" @click="s.pageIdx++">›</button>
    </div>
    <div class="sheetbody">
      <div class="row" style="margin-bottom:10px">
        <button v-for="(label, k) in ENH_LABELS" :key="k" class="btn" :class="{ primary: p?.enhancement === k }" @click="actions.setEnh(k as any)">{{ label }}</button>
      </div>
      <div class="row">
        <button class="btn plain" @click="actions.openRecrop(d!.id, s.pageIdx)">↝ 重切</button>
        <button class="btn plain" @click="actions.rotate()">⟳ 旋转</button>
        <button class="btn plain" style="color:#ff6b62" @click="delPage">删页</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state as s, actions, curDoc } from '../store';
import { ENH_LABELS } from '../types';
import PageThumb from '../components/PageThumb.vue';

const d = computed(() => curDoc());
const p = computed(() => d.value?.pages[s.pageIdx]);
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
.viewer { flex: 1; min-height: 0; display: flex; align-items: center; gap: 4px; padding: 0 8px; }
.nav { font-size: 30px; padding: 8px; color: #fff; }
.nav:disabled { opacity: .3; }
.imgwrap { flex: 1; text-align: center; }
.imgwrap :deep(canvas) { border: 1px solid var(--line); border-radius: 12px; }
.sheetbody { background: #141416; border-top: 1px solid var(--line); border-radius: 26px 26px 0 0; padding: 16px 16px calc(env(safe-area-inset-bottom) + 16px); }
</style>
