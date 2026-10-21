// 서비스워커: 앱 화면과 라이브러리(카카오맵 SDK 포함)는 캐시 우선 + 백그라운드 갱신.
// 카카오 지도 타일은 CORS 헤더가 없어(opaque) 여기서 캐시하지 않고 브라우저 HTTP 캐시(6시간)에 맡긴다.
// 노트 데이터(GitHub API, /local/)는 건드리지 않음 — 앱이 직접 캐시·대기열 처리.
const SHELL = 'shell-v18';
const SHELL_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function shell(e) {
  const c = await caches.open(SHELL);
  const hit = await c.match(e.request, { ignoreSearch: true });
  const fresh = fetch(e.request).then(res => {
    if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
    return res;
  });
  if (hit) {
    e.waitUntil(fresh.catch(() => {}));
    return hit;
  }
  return fresh;
}

// 카카오 SDK: 로더(dapi.kakao.com/v2/maps/sdk.js)와 그것이 부르는 본체 스크립트(t1.kakaocdn.net)
const kakaoScript = url => (url.hostname === 'dapi.kakao.com' && url.pathname === '/v2/maps/sdk.js') || url.hostname === 't1.kakaocdn.net';

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'cdnjs.cloudflare.com' || kakaoScript(url)) return e.respondWith(shell(e));
  if (url.origin === location.origin && !url.pathname.includes('/local/')) return e.respondWith(shell(e));
});
