const SHELL_CACHE = 'open-lens-shell-0.1.0';
const OPENCV_CACHE = 'open-lens-opencv-0.1.0';
const SHELL_URLS = [
  '/manifest.webmanifest',
  '/detector-oss.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

async function cacheAppShell() {
  const cache = await caches.open(SHELL_CACHE);
  const indexResponse = await fetch(new Request('/', { cache: 'reload' }));
  if (!indexResponse.ok) throw new Error(`app shell returned ${indexResponse.status}`);
  const html = await indexResponse.clone().text();
  await cache.put('/', indexResponse);

  const urls = new Set(SHELL_URLS);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && url.pathname !== '/opencv.js') urls.add(url.pathname);
  }
  await Promise.all([...urls].map(async url => {
    const response = await fetch(new Request(url, { cache: 'reload' }));
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    await cache.put(url, response);
  }));
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(cacheAppShell());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, OPENCV_CACHE]);
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('open-lens-') && !keep.has(name))
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/', response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match('/')) || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // OpenCV 由页面加载器读流、显示进度并写入同版本 Cache Storage。
  if (url.pathname === '/opencv.js') return;
  event.respondWith(request.mode === 'navigate' ? navigation(request) : cacheFirst(request));
});
