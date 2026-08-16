/// <reference types="vite/client" />

declare module '*DetectModule.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
