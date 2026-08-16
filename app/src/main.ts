import { createApp } from 'vue';
import App from './App.vue';
import { store, key } from './store';

createApp(App).provide(key, store).mount('#app');
