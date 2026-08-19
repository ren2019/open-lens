<template>
  <div class="pad">
    <div class="bar">
      <button class="linkbtn" @click="actions.go('home')">‹ 主页</button>
      <b>历史(服务端)</b>
      <button class="linkbtn" @click="actions.refreshLibrary()">↻</button>
    </div>
    <input class="textField" v-model="q" placeholder="搜索名称/标签" style="margin-bottom:10px" />
    <div v-if="!list.length" class="card hint">库为空(或服务端不可达)</div>
    <div v-for="doc in list" :key="doc.id" class="card" style="cursor:pointer" @click="view(doc)">
      <b>{{ doc.name }}</b>
      <div class="hint" style="margin-top:3px">
        {{ fmtDate(doc.createdAt) }} · {{ doc.pageCount }} 页 · {{ doc.outfits.length }} Outfit
      </div>
      <div v-if="doc.tags.length" class="row" style="margin-top:6px">
        <span v-for="t in doc.tags" :key="t" class="chip">{{ t }}</span>
      </div>
    </div>
    <button class="btn primary" style="margin-top:8px" @click="actions.openCamera()">📷 新扫描</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { state as s, actions } from '../store';
const q = ref('');
const list = computed(() =>
  s.remoteDocs.filter(d =>
    !q.value || d.name.includes(q.value) || d.tags.some(t => t.includes(q.value))
  )
);
function fmtDate(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function view(doc: any) { actions.openRemoteDoc(doc.id); }
</script>
