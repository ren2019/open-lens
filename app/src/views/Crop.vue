<template>
  <div class="crop">
    <div class="bar" style="padding:calc(env(safe-area-inset-top) + 8px) 14px 8px">
      <b>{{ recrop ? '重切(Original)' : '裁剪' + (n > 1 ? ` ${idx + 1}/${n}` : '') }}</b>
      <span class="hint">{{ it?.detected ? '✓ 自动检测' : '⚠ 手动拉角' }}</span>
    </div>
    <div class="viewwrap">
      <canvas ref="cnv" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up"></canvas>
      <div class="warpprev" ref="prev"></div>
    </div>
    <div class="ctrl">
      <div class="row" style="margin-bottom:10px">
        <button class="btn plain" v-if="!recrop && idx > 0" @click="idx--; redraw()">‹ 上一张</button>
        <button class="btn plain" :disabled="!it?.undos.length" @click="actions.cropUndo(); redraw()">撤销</button>
        <button class="btn plain" :disabled="!it?.redos.length" @click="actions.cropRedo(); redraw()">重做</button>
        <button class="btn plain" @click="actions.cropReset(); redraw()">全图</button>
        <button class="btn plain" v-if="!recrop && idx < n - 1" @click="idx++; redraw()">下一张 ›</button>
      </div>
      <div class="row">
        <button class="btn plain" @click="cancel">✕ 放弃</button>
        <button class="btn primary" @click="ok">✓ {{ recrop ? '确认重切' : '提交' }}</button>
      </div>
      <div class="hint" style="margin-top:8px">点屏幕任意处抓取最近的角拖动</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { state as s, actions } from '../store';
import { loadImage, quadPath } from '../imaging';

// 裁剪 pager: 展示 session.items 中尚未处理的整批(自由翻页)
// 为简单起见,store.items 只追加,这里从尾部往头部翻
const cnv = ref<HTMLCanvasElement>();
const prev = ref<HTMLElement>();
const idx = ref(0);
const n = computed(() => s.session?.items.length ?? 0);
const recrop = computed(() => s.cropMode === 'recrop');
const it = computed(() => {
  if (!s.session) return null;
  if (recrop.value) return s.session.items[0];
  return s.session.items[idx.value];
});

onMounted(() => { idx.value = Math.max(0, n.value - 1); draw(); });
watch(idx, draw);

let img: HTMLImageElement | null = null;
let grabbed = -1;

async function draw() {
  const item = it.value, c = cnv.value;
  if (!item || !c) return;
  if (!img || (img as any).__key !== item.pageId) {
    img = await loadImage(item.blob, item.pageId);
    (img as any).__key = item.pageId;
  }
  const viewW = c.clientWidth || 360;
  const k = viewW / item.w;
  const viewH = Math.round(item.h * k);
  c.width = viewW * devicePixelRatio; c.height = viewH * devicePixelRatio;
  c.style.height = viewH + 'px';
  paint();
}
function paint() {
  const item = it.value, c = cnv.value;
  if (!item || !c || !img) return;
  const x = c.getContext('2d')!;
  const k = c.width / item.w;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(img, 0, 0, c.width, c.height);
  const q = item.quad.map(p => [p[0] * k, p[1] * k]);
  x.fillStyle = 'rgba(0,0,0,.35)';
  x.fillRect(0, 0, c.width, c.height);
  x.save();
  quadPath(x, q); x.clip();
  x.drawImage(img, 0, 0, c.width, c.height);
  x.restore();
  x.strokeStyle = '#0a84ff'; x.lineWidth = 3 * devicePixelRatio;
  quadPath(x, q); x.stroke();
  q.forEach((p, i) => {
    x.beginPath(); x.arc(p[0], p[1], 14 * devicePixelRatio, 0, 7);
    x.fillStyle = '#fff'; x.fill();
    x.lineWidth = 3 * devicePixelRatio; x.strokeStyle = '#0a84ff'; x.stroke();
    x.fillStyle = '#0a84ff'; x.font = `bold ${13 * devicePixelRatio}px sans-serif`;
    x.fillText(String(i + 1), p[0] - 4 * devicePixelRatio, p[1] + 5 * devicePixelRatio);
  });
  preview();
}
async function preview() {
  const item = it.value, box = prev.value;
  if (!item || !box) return;
  const c = document.createElement('canvas');
  const w = 130;
  // 简化预览: 用 css transform 近似透视(交互时不重算 warp,性能优先)
  const h = Math.round(w * 1.35);
  c.width = w; c.height = h;
  const x = c.getContext('2d')!;
  if (img) {
    const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    x.fillStyle = '#111'; x.fillRect(0, 0, w, h);
    x.drawImage(img, (w - img.naturalWidth * k) / 2, (h - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
  }
  box.innerHTML = '';
  box.appendChild(c);
}

function evPos(e: PointerEvent): [number, number] {
  const c = cnv.value!, r = c.getBoundingClientRect();
  return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height];
}
function down(e: PointerEvent) {
  const item = it.value; if (!item) return;
  const [mx, my] = evPos(e);
  const k = cnv.value!.width / item.w;
  let best = 0, bd = Infinity;
  item.quad.forEach((p, i) => {
    const d = Math.hypot(p[0] * k - mx, p[1] * k - my);
    if (d < bd) { bd = d; best = i; }
  });
  grabbed = best; // 上游语义: 不需要命中,抓最近角
  cnv.value!.setPointerCapture(e.pointerId);
  e.preventDefault();
}
function move(e: PointerEvent) {
  const item = it.value;
  if (grabbed < 0 || !item || !cnv.value) return;
  const [mx, my] = evPos(e);
  const k = cnv.value.width / item.w;
  const px = Math.max(0, Math.min(item.w, mx / k));
  const py = Math.max(0, Math.min(item.h, my / k));
  item.quad[grabbed] = [px, py] as [number, number];
  paint();
}
function up() {
  if (grabbed < 0) return;
  const item = it.value!;
  const p = item.quad[grabbed];
  actions.dragCorner(grabbed, Math.round(p[0]), Math.round(p[1]));
  grabbed = -1;
}
function redraw() { img = null; draw().then(() => paint()); }
function ok() {
  // 只提交当前张(上游是整批一个✓;这里逐张提交,拍后场景 n=1 等价)
  // 相册批量场景: 每张确认后自动跳下一张,最后一张的确认触发整批入会话
  if (!recrop.value && idx.value < n.value - 1) {
    idx.value++;
    return;
  }
  actions.confirmCrop();
}
function cancel() {
  const sess = s.session;
  if (recrop.value) { s.session = null; s.cropMode = 'session'; s.recropCtx = null; actions.go('pageedit'); return; }
  if (sess && sess.items.length > 1) {
    if (confirm(`放弃将丢掉 ${sess.items.length} 张未处理照片,确定?`)) {
      sess.items = []; actions.go('camera');
    }
  } else {
    if (sess) sess.items.pop();
    actions.go('camera');
  }
}
</script>

<style scoped>
.crop { display: flex; flex-direction: column; height: 100dvh; background: #111; color: #fff; }
.viewwrap { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px; }
canvas { max-width: 100%; border-radius: 10px; touch-action: none; }
.warpprev { display: flex; justify-content: center; }
.ctrl { padding: 10px 14px calc(env(safe-area-inset-bottom) + 14px); background: #1c1c1e; }
</style>
