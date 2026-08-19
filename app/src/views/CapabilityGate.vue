<template>
  <main class="capabilityGate pad">
    <div class="bar"><b>Open-Lens 环境自检</b></div>
    <section class="card blocker">
      <div class="mark">!</div>
      <h1>当前环境无法安全扫描</h1>
      <p class="hint">请先解决下面的问题。能力达标后重新打开应用即可，不需要输入 token。</p>
    </section>
    <section v-for="problem in problems" :key="problem.key" class="card problem">
      <b>{{ problem.title }}</b>
      <p class="hint">{{ problem.detail }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state as s } from '../store';

const problems = computed(() => {
  const result: { key: string; title: string; detail: string }[] = [];
  if (!s.capabilities.secureContext) result.push({
    key: 'secure', title: '需要安全连接（HTTPS）',
    detail: '请改用配置了有效证书的 HTTPS 地址访问；本地开发可使用 localhost。',
  });
  if (!s.capabilities.camera) result.push({
    key: 'camera', title: '浏览器不提供相机接口',
    detail: '请升级 iOS 或浏览器，或改用支持 getUserMedia 的设备。',
  });
  if (!s.capabilities.wasm) result.push({
    key: 'wasm', title: '浏览器不支持 WebAssembly',
    detail: '请升级 iOS 或浏览器后再打开；图像检测与校正依赖这项能力。',
  });
  return result;
});
</script>

<style scoped>
.capabilityGate { display: flex; flex-direction: column; justify-content: center; min-height: 100dvh; }
.blocker { border-color: rgba(255,69,58,.42); }
.mark { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 12px; border-radius: 50%; background: rgba(255,69,58,.14); color: #ff6b62; font-size: 25px; font-weight: 800; }
h1 { margin-bottom: 8px; font-size: 21px; }
.problem b { display: block; margin-bottom: 5px; color: #ffb3ad; font-size: 14px; }
</style>
