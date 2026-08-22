<template>
  <div class="remoteDetail" v-if="doc" :data-share-ready="s.shareReady ? 'true' : 'false'">
    <div class="detailSheet">
      <div class="grab"></div>
      <div class="detailBody">
        <button class="linkbtn back actionWithIcon" @click="actions.go('library')"><ArrowLeft class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />资料库</button>
        <div class="detailMeta">
          <input class="detailName" v-model="name" aria-label="文档名称" @keydown.enter="saveName" @change="saveName" />
          <span class="detailFacts">{{ showDate ? `${fmtDate(doc.createdAt)} · ` : '' }}{{ doc.pages.length }} 页 · 已归档</span>
        </div>

        <div class="hero" v-if="page">
          <img :src="api(page.scan)" :alt="`第 ${s.remotePageIdx + 1} 页扫描件`" />
          <span>第 {{ s.remotePageIdx + 1 }} 页</span>
        </div>
        <div class="filmstrip" aria-label="文档页缩略图">
          <button v-for="(item, index) in doc.pages" :key="item.id" :class="{ on: index === s.remotePageIdx }" :aria-label="`第 ${index + 1} 页`" :aria-current="index === s.remotePageIdx ? 'page' : undefined" @click="actions.selectRemotePage(index)">
            <img :src="api(item.scan)" :alt="`第 ${index + 1} 页`" />
            <span>{{ index + 1 }}</span>
          </button>
        </div>

        <section class="detailTools" aria-label="文档操作">
          <button data-recrop-trigger class="recropAction actionWithIcon" :disabled="s.loading !== null" @click="actions.openRemoteRecrop()"><Crop class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />重切当前 Original</button>
          <div class="tagrow" aria-label="文档标签">
            <button v-for="tag in tagChoices" :key="tag" class="chip" :class="{ on: doc.tags.includes(tag) }" :aria-pressed="doc.tags.includes(tag)" @click="actions.toggleRemoteTag(tag)">{{ tag }}</button>
          </div>
          <button class="shareButton actionWithIcon" @click="actions.shareCurrentScan()"><Share2 class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />分享当前 Scan</button>
          <div class="exportrow" aria-label="导出成品">
            <button class="actionWithIcon" @click="actions.exportRemote('image')"><Image class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />单页图片</button>
            <button v-if="!s.outfitReady" class="actionWithIcon" :disabled="s.outfitPreparing" @click="actions.exportRemote('pdf')"><FileText class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />PDF</button>
            <button v-else class="actionWithIcon" @click="actions.sharePreparedOutfit()"><Share2 class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />分享 PDF</button>
            <button class="actionWithIcon" @click="actions.exportRemote('long')"><GalleryVertical class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />长图拼接</button>
          </div>
          <div v-if="s.shareFallback" class="shareFallback" role="status">
            <span>此设备不支持直接分享 JPEG</span>
            <button class="statusAction actionWithIcon" @click="actions.saveSharedScan()"><Download class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />保存 JPEG</button>
          </div>
          <div v-if="s.outfitFallback" class="shareFallback" role="status">
            <span>此设备不支持直接分享 PDF</span>
            <button class="statusAction actionWithIcon" @click="actions.saveSharedOutfit()"><Download class="actionIcon" :size="18" :stroke-width="2" aria-hidden="true" />保存 PDF</button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowLeft, Crop, Download, FileText, GalleryVertical, Image, Share2 } from '@lucide/vue';
import { state as s, actions, api } from '../store';

const defaultTags = ['板书', '讲义', '发票'];
const doc = computed(() => s.remoteDoc);
const page = computed(() => doc.value?.pages[s.remotePageIdx]);
const tagChoices = computed(() => [...new Set([...(doc.value?.tags ?? []), ...defaultTags])]);
const name = ref('');
const showDate = computed(() => doc.value ? name.value.trim() !== fmtDate(doc.value.createdAt) : true);
watch(doc, value => { name.value = value?.name ?? ''; }, { immediate: true });
onMounted(() => { void actions.prepareCurrentScanShare(); });

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
.detailMeta { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 8px; row-gap: 2px; }
.detailName { min-width: 0; flex: 1 1 210px; border: 0; border-bottom: 1px solid transparent; outline: none; background: transparent; color: var(--tx); font: inherit; font-size: 22px; font-weight: 700; padding: 2px 0 3px; }
.detailName:focus { border-bottom-color: rgba(255,214,10,.55); }
.detailFacts { flex: 0 0 auto; color: var(--dim); font-size: 12px; }
.hero { position: relative; margin-top: 12px; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #09090a; }
.hero img { display: block; width: 100%; max-height: 50dvh; object-fit: contain; }
.hero span { position: absolute; right: 8px; bottom: 8px; padding: 4px 8px; border-radius: 999px; background: rgba(0,0,0,.68); color: #fff; font-size: 11px; }
.recropAction { width: 100%; min-height: 44px; border: 1px solid rgba(255,214,10,.35); border-radius: 11px; background: rgba(255,214,10,.08); color: var(--acc); font-size: 13px; font-weight: 650; cursor: pointer; }
.recropAction:disabled { opacity: .45; }
.filmstrip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 1px 8px; }
.filmstrip button { position: relative; flex: 0 0 68px; height: 86px; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #202024; padding: 0; cursor: pointer; }
.filmstrip button.on { border: 2px solid var(--acc); }
.filmstrip img { width: 100%; height: 100%; object-fit: cover; }
.filmstrip span { position: absolute; left: 4px; top: 4px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0,0,0,.7); color: #fff; font-size: 10px; line-height: 18px; }
.detailTools { display: grid; gap: 8px; margin-top: 2px; padding-top: 8px; border-top: 1px solid var(--line); }
.tagrow { display: flex; flex-wrap: wrap; gap: 7px; }
.tagrow .chip { min-width: 44px; min-height: 44px; }
.shareButton { width: 100%; min-height: 46px; border: 1px solid rgba(255,214,10,.35); border-radius: 11px; background: rgba(255,214,10,.08); color: var(--acc); font-size: 13px; font-weight: 650; cursor: pointer; }
.exportrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.exportrow button { min-height: 44px; border: 1px solid var(--line); border-radius: 10px; background: #222226; color: var(--tx); font-size: 12px; cursor: pointer; }
.exportrow .actionIcon { color: var(--acc); }
.exportrow button:disabled { opacity: .4; cursor: default; }
.shareFallback { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding: 10px 12px; border: 1px solid rgba(255,214,10,.35); border-radius: 10px; color: var(--tx); font-size: 12px; }
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
