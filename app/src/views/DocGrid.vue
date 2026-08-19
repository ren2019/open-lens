<template>
  <div class="pad">
    <div class="bar">
      <template v-if="d">
        <input v-if="s.renaming" class="textField" style="flex:1" v-model="name" @keydown.enter="actions.rename(name)" />
        <b v-else style="cursor:pointer" @click="s.renaming = true; name = d.name">{{ d.name }} <span class="hint">✎</span></b>
        <span class="hint">
          <span :class="d.archive.status === 'uploaded' ? 'ok' : 'warn'">{{ arcLabel }}</span>
        </span>
      </template>
    </div>
    <div class="card" v-if="d">
      <div class="row" style="margin-bottom:6px">
        <button v-for="t in TAGS" :key="t" class="chip" :class="{ on: d.tags.includes(t) }" @click="actions.toggleTag(t)">{{ t }}</button>
      </div>
      <div class="hint">标签两端可打 · 点标题改名</div>
    </div>
    <div class="grid" v-if="d">
      <div v-for="(p, i) in d.pages" :key="p.id" class="cell" @click="openPage(i)">
        <PageThumb :page="p" />
        <div class="cellrow">
          <button @click.stop="mv(i, -1)" :disabled="i === 0">‹</button>
          <span>第{{ i + 1 }}页</span>
          <button @click.stop="mv(i, 1)" :disabled="i === d.pages.length - 1">›</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:10px" v-if="d">
      <div class="hint" style="margin-bottom:8px">Outfit 导出(同时归档+下载)</div>
      <div class="row">
        <button class="btn plain" @click="actions.exportOutfit('image')">单页图</button>
        <button class="btn plain" @click="actions.exportOutfit('long')">长图</button>
        <button class="btn plain" @click="actions.exportOutfit('pdf')">PDF</button>
      </div>
      <div v-if="d.outfits.length" class="hint" style="margin-top:8px">已产 {{ d.outfits.length }} 个 Outfit</div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn plain" @click="actions.openCamera(d!.id)">📷 补页</button>
      <button class="btn plain" @click="actions.go('home')">← 主页</button>
    </div>
    <button class="btn danger" style="margin-top:10px" v-if="d" @click="del">删除文档(无回收站)</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { state as s, actions, curDoc } from '../store';
import PageThumb from '../components/PageThumb.vue';

const TAGS = ['板书', '讲义', '发票'];
const d = computed(() => curDoc());
const name = ref('');
const arcLabel = computed(() => {
  const a = d.value?.archive; if (!a) return '';
  if (a.status === 'uploaded') return '✓ 已归档';
  if (a.status === 'uploading') return `⟳ ${a.done}/${a.total}`;
  if (a.status === 'failed') return '✕ 失败·待人工';
  return `⏸ ${a.done}/${a.total}`;
});
function openPage(i: number) { s.pageIdx = i; actions.go('pageedit'); }
function mv(i: number, dir: number) {
  actions.movePage(i, dir);
}
function del() {
  if (d.value && confirm(`删除「${d.value.name}」?文件+元数据一并删,无回收站`)) {
    actions.deleteDoc(d.value.id);
  }
}
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cell { background: #1d1d21; border: 1px solid var(--line); border-radius: 12px; padding: 6px; text-align: center; cursor: pointer; }
.cellrow { font-size: 11px; margin-top: 4px; display: flex; justify-content: center; align-items: center; gap: 6px; }
.cellrow button { border: 1px solid var(--line); background: #2c2c30; color: var(--tx); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
</style>
