<template>
  <div class="cam" :class="{ 'landscape-left': landscapeRailSide === 'left' }">
    <div class="camtop">
      <button class="iconbtn" @click="back">✕</button>
      <span class="hint liveState">{{ liveLabel }}</span>
    </div>
    <div class="viewwrap">
      <video ref="videoEl" autoplay playsinline muted></video>
      <canvas ref="overlayEl" :data-highlight="overlayMode" :aria-label="liveLabel"></canvas>
      <div v-if="!camOn" class="camhint">正在请求相机权限…<br><span class="hint">需 HTTPS 或 localhost;iOS Safari 请允许相机</span></div>
    </div>
    <div class="modebar" role="group" aria-label="检测模式">
      <button
        v-for="option in DETECTOR_MODE_OPTIONS"
        :key="option.value"
        class="modechoice"
        :class="{ active: s.detectionMode === option.value }"
        :data-mode="option.value"
        :aria-pressed="s.detectionMode === option.value"
        @click="actions.setDetectionMode(option.value)"
      >{{ option.label }}</button>
    </div>
    <div class="cambar">
      <label class="ghost">相册<input type="file" accept="image/*" multiple hidden @change="album" /></label>
      <button class="ghost" :class="{ sel: sess?.batch }" @click="sess && (sess.batch = !sess.batch)">⧉<span class="hint">{{ sess?.batch ? '连拍' : '单拍' }}</span></button>
      <div class="shutterwrap">
        <button class="shutter" @click="shot" :disabled="busy"></button>
        <span v-if="sess?.pages.length" class="count">{{ sess.pages.length }}</span>
      </div>
      <button
        class="lastshot"
        aria-label="查看最近一页"
        :disabled="!sess?.pages.length"
        @click="openLastPreview"
      ><canvas ref="lastEl"></canvas></button>
      <button class="fab" :disabled="!sess?.pages.length" @click="actions.finishBatch()">✓</button>
    </div>
    <div v-if="sess?.pages.length" class="strip"><span class="hint">✓ 完成文档 · 已拍 {{ sess.pages.length }} 页</span></div>
    <div v-if="showLastPreview" class="lastPreview" role="dialog" aria-modal="true" aria-label="最近一页预览">
      <div class="lastPreviewCard">
        <img v-if="lastPreviewUrl" :src="lastPreviewUrl" alt="最近一页 Scan 预览" />
        <button class="lastPreviewClose" aria-label="关闭最近一页预览" @click="showLastPreview = false">关闭预览</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { state as s, actions } from '../store';
import { warpPage } from '../imaging';
import { detectLiveFrame } from '../detector';
import { DETECTOR_MODE_OPTIONS, type Quad } from '../types';

const videoEl = ref<HTMLVideoElement>();
const overlayEl = ref<HTMLCanvasElement>();
const lastEl = ref<HTMLCanvasElement>();
const sess = computed(() => s.session);
const camOn = ref(false);
const busy = ref(false);
const landscapeRailSide = ref<'left' | 'right'>('right');
const showLastPreview = ref(false);
const lastPreviewUrl = ref('');
const liveFps = ref(0);
const liveFound = ref(false);
const liveLabel = computed(() => {
  const prefix = [sess.value?.appendTo ? '补页中' : '', s.online ? '' : '离线'].filter(Boolean).join(' · ');
  const status = !s.cvReady
    ? '静态指引'
    : liveFound.value
      ? `实时框 ${liveFps.value.toFixed(1)} fps`
      : `实时检测${liveFps.value ? ` ${liveFps.value.toFixed(1)} fps` : ''} · 静态指引`;
  return prefix ? `${prefix} · ${status}` : status;
});
const overlayMode = computed(() => liveFound.value ? 'quad' : 'guide');
let stream: MediaStream | null = null;
let raf = 0;
let mounted = true;
let liveBusy = false;
let lastLiveStart = 0;
let liveQuad: Quad | null = null;
let liveSource = { width: 480, height: 270 };
const liveCompletions: number[] = [];
const analysis = document.createElement('canvas');

function updateLandscapeRailSide() {
  const legacyAngle = (window as Window & { orientation?: number }).orientation;
  const angle = typeof legacyAngle === 'number' ? legacyAngle : screen.orientation?.angle ?? 0;
  landscapeRailSide.value = angle === -90 || angle === 270 ? 'left' : 'right';
}

watch(() => s.detectionMode, () => {
  liveQuad = null;
  liveFound.value = false;
  liveCompletions.length = 0;
});

onMounted(async () => {
  updateLandscapeRailSide();
  window.addEventListener('orientationchange', updateLandscapeRailSide);
  screen.orientation?.addEventListener('change', updateLandscapeRailSide);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const v = videoEl.value!;
    v.srcObject = stream;
    await v.play();
    camOn.value = true;
    await drawLast();
    tick();
  } catch (e: any) {
    actions.toast('相机打开失败: ' + e.name + '(桌面无摄像头可用相册导入)');
  }
});
onUnmounted(() => {
  mounted = false;
  cancelAnimationFrame(raf);
  window.removeEventListener('orientationchange', updateLandscapeRailSide);
  screen.orientation?.removeEventListener('change', updateLandscapeRailSide);
  stream?.getTracks().forEach(t => t.stop());
});

// 单帧串行、10fps 上限:低端机不堆任务;cv 缺/无结果时保留静态指引框。
function tick(now = performance.now()) {
  const v = videoEl.value, c = overlayEl.value;
  if (v && c && camOn.value) {
    drawOverlay(c);
    if (s.cvReady && document.visibilityState === 'visible' && v.readyState >= 2
      && !liveBusy && now - lastLiveStart >= 100) void runLiveDetection(v);
    if (!s.cvReady) { liveQuad = null; liveFound.value = false; liveFps.value = 0; }
  }
  raf = requestAnimationFrame(tick);
}

function drawOverlay(canvas: HTMLCanvasElement) {
  const dpr = devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d')!;
  context.clearRect(0, 0, width, height);

  if (liveQuad) {
    const cssWidth = width / dpr, cssHeight = height / dpr;
    const scale = Math.max(cssWidth / liveSource.width, cssHeight / liveSource.height);
    const dx = (liveSource.width * scale - cssWidth) / 2;
    const dy = (liveSource.height * scale - cssHeight) / 2;
    const points = liveQuad.map(([x, y]) => [(x * scale - dx) * dpr, (y * scale - dy) * dpr]);
    context.strokeStyle = '#ffd60a'; context.fillStyle = '#ffd60a'; context.lineWidth = 3 * dpr;
    context.shadowColor = '#ffd60a88'; context.shadowBlur = 8 * dpr;
    context.beginPath(); context.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach(point => context.lineTo(point[0], point[1]));
    context.closePath(); context.stroke();
    context.shadowBlur = 0;
    points.forEach(point => { context.beginPath(); context.arc(point[0], point[1], 5 * dpr, 0, Math.PI * 2); context.fill(); });
    return;
  }

  const guideWidth = width * 0.82, guideHeight = height * 0.82;
  context.strokeStyle = s.cvReady ? '#ffd60a99' : '#ff9f0a88';
  context.lineWidth = 3 * dpr; context.setLineDash([12 * dpr, 10 * dpr]);
  context.strokeRect((width - guideWidth) / 2, (height - guideHeight) / 2, guideWidth, guideHeight);
  context.setLineDash([]);
}

async function runLiveDetection(video: HTMLVideoElement) {
  liveBusy = true;
  lastLiveStart = performance.now();
  try {
    const sourceWidth = video.videoWidth || 1280, sourceHeight = video.videoHeight || 720;
    analysis.width = 480;
    analysis.height = Math.max(1, Math.round(480 * sourceHeight / sourceWidth));
    analysis.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })!
      .drawImage(video, 0, 0, analysis.width, analysis.height);
    const result = await detectLiveFrame(analysis, s.detectionMode);
    if (!mounted) return;
    liveQuad = result.quad;
    liveFound.value = !!result.quad;
    liveSource = { width: analysis.width, height: analysis.height };
    const completed = performance.now();
    liveCompletions.push(completed);
    while (liveCompletions.length > 1 && liveCompletions[0] < completed - 1000) liveCompletions.shift();
    if (liveCompletions.length > 1) {
      liveFps.value = (liveCompletions.length - 1) * 1000 /
        (liveCompletions[liveCompletions.length - 1] - liveCompletions[0]);
    }
  } catch (error) {
    console.warn('live frame preparation failed, keeping guide', error);
    liveQuad = null;
    liveFound.value = false;
  } finally { liveBusy = false; }
}

async function shot() {
  const v = videoEl.value;
  if (!v || busy.value || !camOn.value) return;
  busy.value = true;
  try {
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/jpeg', 0.92));
    await actions.shutter(blob, c.width, c.height);
    drawLast();
  } catch (e) {
    actions.toast('拍摄失败');
  } finally { busy.value = false; }
}

async function drawLast() {
  const sess = s.session; const el = lastEl.value;
  if (!el || !sess || !sess.pages.length) return;
  const p = sess.pages[sess.pages.length - 1];
  const c = await warpPage(p, 108);
  el.width = 108; el.height = Math.round(c.height * 108 / c.width);
  el.getContext('2d')!.drawImage(c, 0, 0, el.width, el.height);
}

async function openLastPreview() {
  const currentSession = s.session;
  if (!currentSession?.pages.length) return;
  showLastPreview.value = true;
  lastPreviewUrl.value = '';
  const page = currentSession.pages[currentSession.pages.length - 1];
  const preview = await warpPage(page, 720);
  lastPreviewUrl.value = preview.toDataURL('image/jpeg', 0.9);
}

async function album(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  if (files.length) await actions.importAlbum(files);
  (e.target as HTMLInputElement).value = '';
}

function back() {
  const sess = s.session;
  if (sess && sess.pages.length) {
    if (confirm(`会话还有 ${sess.pages.length} 页未成档,退出将丢弃,确定?`)) {
      s.session = null; actions.go('home');
    }
  } else { s.session = null; actions.go('home'); }
}
</script>

<style scoped>
.cam { display: flex; flex-direction: column; height: 100dvh; background: #0b0b0d; color: #fff; }
.camtop { display: flex; justify-content: space-between; align-items: center; padding: calc(env(safe-area-inset-top) + 10px) 18px 8px; font-size: 15px; }
.camtop .hint { align-self: center; }
.iconbtn { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 17px; background: var(--glass); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border: 1px solid var(--line); color: #fff; cursor: pointer; }
.viewwrap { flex: 1; position: relative; overflow: hidden; }
video { width: 100%; height: 100%; object-fit: cover; }
.viewwrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.modebar { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px; padding: 6px 14px 2px; background: #0b0b0d; }
.modechoice { position: relative; min-height: 36px; border: 0; background: transparent; color: #777780; font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif; cursor: pointer; border-radius: 8px; }
.modechoice::after { content: ""; position: absolute; left: 30%; right: 30%; bottom: 1px; height: 2px; border-radius: 2px; background: transparent; }
.modechoice.active { color: var(--acc); }
.modechoice.active::after { background: var(--acc); }
.modechoice:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
.camhint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 14px; color: #9a9aa2; flex-direction: column; gap: 8px; }
.cambar { display: flex; align-items: center; justify-content: space-around; padding: 12px 12px calc(env(safe-area-inset-bottom) + 12px); }
.ghost { background: var(--glass); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border: 1px solid var(--line); border-radius: 12px; padding: 7px 10px; color: #fff; font-size: 13px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 52px; }
.ghost.sel { color: var(--acc); border-color: rgba(255,214,10,.4); }
.shutterwrap { position: relative; width: 84px; height: 84px; }
.shutter { width: 76px; height: 76px; border-radius: 50%; border: 5px solid #fff; background: transparent; position: absolute; left: 4px; top: 4px; cursor: pointer; }
.shutter::after { content: ""; position: absolute; inset: 6px; border-radius: 50%; background: #fff; }
.shutter:disabled { opacity: .5; }
.count { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; pointer-events: none; color: #000; }
.lastshot { width: 54px; height: 54px; overflow: hidden; padding: 0; border-radius: 10px; border: 2px solid rgba(255,255,255,.7); background: #1d1d21; cursor: pointer; }
.lastshot canvas { display: block; width: 100%; height: 100%; }
.lastshot:disabled { opacity: .55; cursor: default; }
.fab { width: 54px; height: 54px; border-radius: 50%; background: var(--acc); color: #000; border: none; font-size: 24px; font-weight: 700; cursor: pointer; }
.fab:disabled { background: #3a3a40; color: #777; }
.strip { text-align: center; padding-bottom: 6px; }
.lastPreview { position: fixed; inset: 0; z-index: 89; display: flex; align-items: center; justify-content: center; padding: calc(env(safe-area-inset-top) + 16px) calc(env(safe-area-inset-right) + 16px) calc(env(safe-area-inset-bottom) + 16px) calc(env(safe-area-inset-left) + 16px); background: rgba(0,0,0,.78); }
.lastPreviewCard { display: flex; max-width: min(88vw, 520px); max-height: 88vh; flex-direction: column; align-items: center; gap: 12px; }
.lastPreviewCard img { width: min(70vw, 520px); min-height: 0; max-width: 100%; max-height: calc(88vh - 56px); border: 1px solid var(--line); border-radius: 12px; object-fit: contain; }
.lastPreviewClose { min-height: 44px; padding: 0 18px; border: 1px solid var(--line); border-radius: 999px; background: var(--glass); color: #fff; font: 600 14px/1 -apple-system, BlinkMacSystemFont, sans-serif; cursor: pointer; }

@media (orientation: landscape) and (max-height: 500px) {
  .cam {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px 112px;
    grid-template-rows: auto minmax(0, 1fr) auto;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .camtop { grid-column: 1; grid-row: 1; padding: 10px 18px 8px; }
  .viewwrap { grid-column: 1; grid-row: 2; }
  .modebar {
    grid-column: 2;
    grid-row: 1 / -1;
    grid-template-columns: 1fr;
    grid-template-rows: repeat(5, minmax(0, 1fr));
    padding: 12px 4px;
  }
  .cambar {
    grid-column: 3;
    grid-row: 1 / -1;
    flex-direction: column;
    padding: 12px;
  }
  .strip { grid-column: 1; grid-row: 3; }
  .cam.landscape-left { grid-template-columns: 112px 44px minmax(0, 1fr); }
  .cam.landscape-left .camtop,
  .cam.landscape-left .viewwrap,
  .cam.landscape-left .strip { grid-column: 3; }
  .cam.landscape-left .cambar { grid-column: 1; }
}
</style>
