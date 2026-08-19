<template>
  <canvas ref="c"></canvas>
</template>
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { Page } from '../types';
import { warpPage } from '../imaging';
const props = defineProps<{ page: Page; width?: number }>();
const c = ref<HTMLCanvasElement>();
async function draw() {
  const el = c.value; if (!el) return;
  const src = await warpPage(props.page, props.width ?? 300);
  el.width = src.width; el.height = src.height;
  el.style.width = '100%';
  el.getContext('2d')!.drawImage(src, 0, 0);
}
onMounted(draw);
watch(() => [props.page.enhancement, props.page.rotation, props.page.quad], draw, { deep: true });
</script>
<style scoped>
canvas { width: 100%; border-radius: 6px; background: #1d1d21; display: block; }
</style>
