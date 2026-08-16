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

onMounted(() => { warmupDetector(ok => { s.cvReady = ok; }); });
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body, #app { height: 100%; }
body {
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  background: #f2f2f7; color: #1c1c1e;
  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);
}
.app { max-width: 640px; margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; }
.pad { padding: 14px 16px; flex: 1; }
.bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 2px 12px; gap: 6px; }
.bar b { font-size: 17px; }
.btn { display: block; width: 100%; border: none; border-radius: 12px; padding: 13px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 10px; }
.btn.primary { background: #0a84ff; color: #fff; }
.btn.plain { background: #e5e5ea; color: #1c1c1e; }
.btn.danger { background: #ff453a; color: #fff; }
.btn:disabled { opacity: .4; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.row .btn { flex: 1; min-width: 96px; margin-bottom: 0; font-size: 14px; padding: 11px; }
.card { background: #fff; border-radius: 12px; padding: 12px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.hint { font-size: 12px; color: #8a8a8e; line-height: 1.5; }
.chip { background: #0a84ff1a; color: #0a84ff; border-radius: 20px; padding: 3px 10px; font-size: 12px; border: none; cursor: pointer; }
.chip.on { background: #0a84ff; color: #fff; }
.ok { color: #30d158; } .warn { color: #ff9f0a; } .err { color: #ff453a; }
.linkbtn { background: none; border: none; color: #0a84ff; font-size: 14px; cursor: pointer; padding: 4px; }
input.textField { width: 100%; border: none; background: #e5e5ea; border-radius: 10px; padding: 12px; font-size: 15px; outline: none; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 90; display: flex; align-items: center; justify-content: center; color: #fff; flex-direction: column; gap: 12px; font-size: 15px; }
.spin { width: 34px; height: 34px; border: 3px solid #ffffff55; border-top-color: #fff; border-radius: 50%; animation: rot .8s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }
.toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); background: #1c1c1ee6; color: #fff; border-radius: 10px; padding: 10px 16px; font-size: 14px; z-index: 95; max-width: 86%; }
</style>
