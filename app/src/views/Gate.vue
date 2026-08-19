<template>
  <div class="pad">
    <div class="bar"><b>Open-Lens</b></div>
    <div class="card">
      <div style="font-size:34px;margin:8px 0;color:var(--acc)">◎</div>
      <div class="hint" style="margin-bottom:12px">输入服务端 token(单 token 鉴权,存本机)<br>本地验收默认 <code>dev-token</code></div>
      <input class="textField" v-model="t" placeholder="token" @keydown.enter="go" />
    </div>
    <button class="btn primary" @click="go">进入</button>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { actions } from '../store';
const t = ref('');
async function go() {
  if (!t.value.trim()) return;
  actions.setToken(t.value.trim());
  await actions.refreshLibrary();
}
</script>
