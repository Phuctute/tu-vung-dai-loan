const CACHE_VERSION = 'v3.9.2';
const CACHE_NAME = `phuc-vql-${CACHE_VERSION}`;

const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './assets/style.css?v=388',
  './assets/app.js?v=392',
  './logo.jpg',
  './apple-touch-icon-v6.png',
  './app-icon-192-v6.png',
  './app-icon-512-v6.png'
];

// Install - cache resources
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate - delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName.startsWith('phuc-vql-') && cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch - network first, cache fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Force network for HTML (never cache stale HTML)
  if(url.pathname === '/' || url.pathname.endsWith('.html')){
    event.respondWith(
      fetch(event.request, {cache: 'no-store'})
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Network first for all other resources
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Only cache successful responses
        if (response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, responseToCache));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
