<template>
  <div class="remoteDetail" v-if="doc">
    <div class="detailSheet">
      <div class="grab"></div>
      <div class="detailBody">
        <button class="linkbtn back" @click="actions.go('library')">‹ 资料库</button>
        <input class="detailName" v-model="name" aria-label="文档名称" @keydown.enter="saveName" @change="saveName" />
        <div class="hint">{{ fmtDate(doc.createdAt) }} · {{ doc.pages.length }} 页 · 已归档</div>

        <div class="hero" v-if="page">
          <img :src="api(page.scan)" :alt="`第 ${s.remotePageIdx + 1} 页扫描件`" />
          <span>第 {{ s.remotePageIdx + 1 }} 页</span>
        </div>
        <button data-recrop-trigger class="recropAction" :disabled="s.loading !== null" @click="actions.openRemoteRecrop()">↝ 重切当前 Original</button>
        <div class="filmstrip" aria-label="文档页缩略图">
          <button v-for="(item, index) in doc.pages" :key="item.id" :class="{ on: index === s.remotePageIdx }" @click="s.remotePageIdx = index">
            <img :src="api(item.scan)" :alt="`第 ${index + 1} 页`" />
            <span>{{ index + 1 }}</span>
          </button>
        </div>

        <div class="tagrow">
          <button v-for="tag in tagChoices" :key="tag" class="chip" :class="{ on: doc.tags.includes(tag) }" @click="actions.toggleRemoteTag(tag)">{{ tag }}</button>
        </div>
        <div class="exportrow">
          <button @click="actions.exportRemote('image')"><b>▧</b>单页图片</button>
          <button @click="actions.exportRemote('pdf')"><b>▤</b>PDF</button>
          <button @click="actions.exportRemote('long')"><b>▥</b>长图拼接</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { state as s, actions, api } from '../store';

const defaultTags = ['板书', '讲义', '发票'];
const doc = computed(() => s.remoteDoc);
const page = computed(() => doc.value?.pages[s.remotePageIdx]);
const tagChoices = computed(() => [...new Set([...(doc.value?.tags ?? []), ...defaultTags])]);
const name = ref('');
watch(doc, value => { name.value = value?.name ?? ''; }, { immediate: true });

function fmtDate(ts: number) {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
async function saveName() {
  const value = name.value.trim();
  if (!doc.value || !value || value === doc.value.name) { name.value = doc.value?.name ?? ''; return; }
  await actions.updateRemoteDoc({ name: value });
  name.value = doc.value.name;
}
</script>

<style scoped>
.remoteDetail { min-height: 100dvh; padding-top: 70px; background: #0b0b0d; }
.detailSheet { min-height: calc(100dvh - 70px); border-radius: 26px 26px 0 0; background: #141416; border-top: 1px solid var(--line); }
.grab { width: 38px; height: 4px; margin: 8px auto 0; border-radius: 99px; background: #3a3a40; }
.detailBody { padding: 10px 16px calc(env(safe-area-inset-bottom) + 18px); }
.back { margin: 0 0 8px -4px; }
.detailName { width: 100%; border: 0; border-bottom: 1px solid transparent; outline: none; background: transparent; color: var(--tx); font: inherit; font-size: 22px; font-weight: 700; padding: 2px 0 5px; }
.detailName:focus { border-bottom-color: rgba(255,214,10,.55); }
.hero { position: relative; margin-top: 14px; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #09090a; }
.hero img { display: block; width: 100%; max-height: 47dvh; object-fit: contain; }
.hero span { position: absolute; right: 8px; bottom: 8px; padding: 4px 8px; border-radius: 999px; background: rgba(0,0,0,.68); color: #fff; font-size: 11px; }
.recropAction { width: 100%; margin-top: 8px; min-height: 42px; border: 1px solid rgba(255,214,10,.35); border-radius: 11px; background: rgba(255,214,10,.08); color: var(--acc); font-size: 13px; font-weight: 650; cursor: pointer; }
.recropAction:disabled { opacity: .45; }
.filmstrip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 1px; }
.filmstrip button { position: relative; flex: 0 0 68px; height: 86px; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #202024; padding: 0; cursor: pointer; }
.filmstrip button.on { border: 2px solid var(--acc); }
.filmstrip img { width: 100%; height: 100%; object-fit: cover; }
.filmstrip span { position: absolute; left: 4px; top: 4px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0,0,0,.7); color: #fff; font-size: 10px; line-height: 18px; }
.tagrow { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 2px; }
.exportrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
.exportrow button { min-height: 62px; border: 1px solid var(--line); border-radius: 12px; background: #222226; color: var(--tx); font-size: 12px; cursor: pointer; }
.exportrow b { display: block; margin-bottom: 4px; color: var(--acc); font-size: 19px; }
@media (min-width: 800px) {
  :global(.app:has(.remoteDetail)) { max-width: 980px; }
  .remoteDetail { padding-top: 30px; }
  .detailSheet { min-height: calc(100dvh - 30px); }
  .detailBody { padding-left: 24px; padding-right: 24px; }
  .hero img { max-height: 58dvh; }
  .filmstrip { display: grid; grid-template-columns: repeat(auto-fill, minmax(82px, 1fr)); overflow: visible; }
  .filmstrip button { width: 100%; height: 104px; }
}
</style>
