import { createApp } from 'vue';
import App from './App.vue';
import { store, key } from './store';

createApp(App).provide(key, store).mount('#app');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(error => {
    console.warn('Service worker registration failed; offline app shell is unavailable', error);
  });
}
