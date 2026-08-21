<template>
  <div class="crop">
    <div class="bar" style="padding:calc(env(safe-area-inset-top) + 8px) 14px 8px">
      <button v-if="recrop" class="linkbtn recropBack" @click="leaveRecrop(false)">‹ 返回{{ returnTarget }}</button>
      <b v-else>{{ '裁剪' + (n > 1 ? ` ${idx + 1}/${n}` : '') }}</b>
      <span class="hint">{{ it?.detected ? '✓ 自动检测' : '⚠ 手动拉角' }}</span>
    </div>
    <div class="viewwrap">
      <div v-if="recrop" class="taskContext">
        <h1 ref="taskTitle" tabindex="-1">重新选择本页的扫描范围</h1>
        <p class="sourceContext">{{ sourceContext }}</p>
        <p class="hint">拖动 Original 上的四角调整选区。Original 保持不变。</p>
      </div>
      <div v-if="recrop" class="imageLabel">
        <h2 id="original-selection-label">Original 与当前选区</h2>
        <p class="hint">黄色边框内是将用于重新生成 Scan 的范围。</p>
      </div>
      <canvas
        ref="cnv"
        :aria-label="recrop ? 'Original 与当前选区' : undefined"
        :role="recrop ? 'img' : undefined"
        :data-quad="it ? JSON.stringify(it.quad) : ''"
        :data-detected="it?.detected ? 'true' : 'false'"
        :data-source-width="it?.w"
        :data-source-height="it?.h"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
      ></canvas>
      <div v-if="recrop" class="imageLabel previewLabel">
        <h2 id="scan-preview-label">Scan 预览</h2>
        <p class="hint">确认后将按当前选区重新生成 Scan。</p>
      </div>
      <div class="warpprev" ref="prev" :aria-labelledby="recrop ? 'scan-preview-label' : undefined" :role="recrop ? 'img' : undefined"></div>
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
        <button class="btn plain" @click="cancel">{{ recrop ? `放弃修改并返回${returnTarget}` : '✕ 放弃' }}</button>
        <button class="btn primary" @click="ok">{{ recrop ? `应用选区并返回${returnTarget}` : '✓ 提交' }}</button>
      </div>
      <div class="hint" style="margin-top:8px">点屏幕任意处抓取最近的角拖动</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { state as s, actions, RECROP_HISTORY_STATE_KEY } from '../store';
import { loadImage, quadPath } from '../imaging';

// 裁剪 pager: 展示 session.items 中尚未处理的整批(自由翻页)
// 为简单起见,store.items 只追加,这里从尾部往头部翻
const cnv = ref<HTMLCanvasElement>();
const prev = ref<HTMLElement>();
const taskTitle = ref<HTMLElement>();
const idx = ref(0);
const n = computed(() => s.session?.items.length ?? 0);
const recrop = computed(() => s.cropMode === 'recrop');
const recropDoc = computed(() => {
  const context = s.recropCtx;
  return context ? s.docs.find(doc => doc.id === context.docId) : null;
});
const returnTarget = computed(() => s.recropCtx?.returnTo === 'remotedetail' ? '归档详情' : '页编辑器');
const sourceContext = computed(() => {
  const pageIndex = s.recropCtx?.pageIndex ?? 0;
  return `${recropDoc.value?.name ?? '当前文档'} · 第 ${pageIndex + 1} 页，共 ${recropDoc.value?.pages.length ?? 1} 页`;
});
const it = computed(() => {
  if (!s.session) return null;
  if (recrop.value) return s.session.items[0];
  return s.session.items[idx.value];
});

onMounted(() => {
  idx.value = Math.max(0, n.value - 1);
  draw();
  if (recrop.value) nextTick(() => taskTitle.value?.focus({ preventScroll: true }));
});
watch(idx, draw);

let img: HTMLImageElement | null = null;
let grabbed = -1;
let grabbedStart: [number, number] | null = null;

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
  x.strokeStyle = '#ffd60a'; x.lineWidth = 3 * devicePixelRatio;
  quadPath(x, q); x.stroke();
  q.forEach((p, i) => {
    x.beginPath(); x.arc(p[0], p[1], 14 * devicePixelRatio, 0, 7);
    x.fillStyle = '#fff'; x.fill();
    x.lineWidth = 3 * devicePixelRatio; x.strokeStyle = '#ffd60a'; x.stroke();
    x.fillStyle = '#141416'; x.font = `bold ${13 * devicePixelRatio}px sans-serif`;
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
  grabbedStart = item.quad[grabbed].slice() as [number, number];
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
  const p = item.quad[grabbed].slice() as [number, number];
  // pointermove 负责即时预览；提交前先还原起点，让 store 的 undo 栈记录“改前” quad。
  if (grabbedStart) item.quad[grabbed] = grabbedStart;
  actions.dragCorner(grabbed, Math.round(p[0]), Math.round(p[1]));
  grabbed = -1;
  grabbedStart = null;
  paint(); // 对齐 store 中已取整的提交值，保证重做与松手后的视觉产物一致。
}
function redraw() { img = null; draw().then(() => paint()); }
function restoreRecropTriggerFocus() {
  nextTick(() => document.querySelector<HTMLElement>('[data-recrop-trigger]')?.focus());
}
function leaveRecrop(apply: boolean) {
  const context = s.recropCtx;
  const historyContext = history.state?.[RECROP_HISTORY_STATE_KEY];
  const returnThroughHistory = !!context
    && historyContext?.docId === context.docId
    && historyContext?.pageIndex === context.pageIndex
    && historyContext?.returnTo === context.returnTo;
  if (apply) actions.confirmCrop();
  else actions.cancelRecrop();
  restoreRecropTriggerFocus();
  if (returnThroughHistory) history.back();
}
function ok() {
  // 只提交当前张(上游是整批一个✓;这里逐张提交,拍后场景 n=1 等价)
  // 相册批量场景: 每张确认后自动跳下一张,最后一张的确认触发整批入会话
  if (!recrop.value && idx.value < n.value - 1) {
    idx.value++;
    return;
  }
  if (recrop.value) leaveRecrop(true);
  else actions.confirmCrop();
}
function cancel() {
  const sess = s.session;
  if (recrop.value) { leaveRecrop(false); return; }
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
.crop { display: flex; flex-direction: column; height: 100dvh; background: #0b0b0d; color: #fff; }
.viewwrap { flex: 1; overflow-y: auto; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px; }
canvas { max-width: 100%; border-radius: 10px; touch-action: none; }
.taskContext, .imageLabel { width: 100%; }
.taskContext h1 { margin-bottom: 4px; font-size: 18px; line-height: 1.3; }
.sourceContext { margin-bottom: 2px; color: var(--tx); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.imageLabel h2 { margin-bottom: 2px; font-size: 13px; line-height: 1.4; }
.previewLabel { margin-top: 2px; }
.recropBack { text-align: left; }
.crop button:focus-visible { outline: 2px solid var(--acc); outline-offset: 3px; }
.warpprev { display: flex; justify-content: center; }
.warpprev canvas { border: 1px solid var(--line); }
.ctrl { padding: 14px 14px calc(env(safe-area-inset-bottom) + 14px); background: #141416; border-top: 1px solid var(--line); border-radius: 26px 26px 0 0; }
</style>
