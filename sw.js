// 서비스워커: 앱 화면과 라이브러리는 캐시 우선 + 백그라운드 갱신, 지도 타일은 본 곳만 캐시.
// 노트 데이터(GitHub API, /local/)는 건드리지 않음 — 앱이 직접 캐시·대기열 처리.
const SHELL = 'shell-v6';
const TILES = 'tiles-v1';
const MAX_TILES = 3000;
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let tilePuts = 0;
async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map(k => c.delete(k)));
}

async function tile(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type !== 'opaque') {
    await c.put(req, res.clone());
    if (++tilePuts % 100 === 0) trimTiles();
  }
  return res;
}

async function shell(e) {
  const c = await caches.open(SHELL);
  const hit = await c.match(e.request, { ignoreSearch: true });
  const fresh = fetch(e.request).then(res => {
    if (res.ok) c.put(e.request, res.clone());
    return res;
  });
  if (hit) {
    e.waitUntil(fresh.catch(() => {}));
    return hit;
  }
  return fresh;
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'tile.openstreetmap.org') return e.respondWith(tile(e.request));
  if (url.hostname === 'cdnjs.cloudflare.com') return e.respondWith(shell(e));
  if (url.origin === location.origin && !url.pathname.includes('/local/')) return e.respondWith(shell(e));
});
