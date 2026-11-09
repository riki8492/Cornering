// オフラインでも起動できるよう、アプリ本体をキャッシュする
// （道路データ＝Overpass API・標高タイルへの通信はキャッシュしない）
const CACHE = 'cornering-v5';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/physics.js',
  'js/geo.js',
  'js/roadmap.js',
  'js/elevation.js',
  'js/sensors.js',
  'js/sim.js',
  'js/presets.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // ネットワーク優先（更新をすぐ反映）、つながらなければキャッシュ
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
