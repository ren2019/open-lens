<template>
  <div class="app">
    <component :is="screenComp" />
    <div v-if="s.loading" class="overlay"><div class="spin"></div><div>{{ s.loading }}</div></div>
    <div v-if="s.toast" class="toast">{{ s.toast }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { state as s } from './store';
import { warmupDetector } from './detector';
import GateVue from './views/Gate.vue';
import HomeVue from './views/Home.vue';
import CameraVue from './views/Camera.vue';
import CropVue from './views/Crop.vue';
import DocGridVue from './views/DocGrid.vue';
import PageEditVue from './views/PageEdit.vue';
import LibraryVue from './views/Library.vue';

const MAP: Record<string, any> = {
  gate: GateVue, home: HomeVue, camera: CameraVue, crop: CropVue,
  docgrid: DocGridVue, pageedit: PageEditVue, library: LibraryVue,
};
const screenComp = computed(() => MAP[s.screen] ?? HomeVue);

onMounted(() => {
  // cv 预热延迟 2.5s:10MB WASM 内联构建的编译会阻塞主线程,
  // 放在首屏交互之后,gate/home 先可用(检测在拍后异步进行,不阻塞旅程)
  setTimeout(() => { warmupDetector(ok => { s.cvReady = ok; }); }, 2500);
});
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
</style>
