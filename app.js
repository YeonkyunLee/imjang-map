'use strict';
// 임장 지도 — 데이터 원본은 imjang 저장소의 노트. 앱은 읽고, 노트 단위로 커밋한다.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RATING_COLOR = { '1순위': '#d93025', '추천': '#f29900', '후보': '#1a73e8', '탈락': '#9aa0a6', '미평가': '#5f6b7a' };
const FILTERS = {
  지역: null, // 노트에서 채움
  상태: ['계획', '다녀옴', '제외'],
  유형: ['아파트', '재건축', '재개발구역', '도시형생활주택', '미확인'],
  평가: ['1순위', '추천', '후보', '탈락', '미평가'],
};

// ---------- 저장 (localStorage는 실패할 수 있음) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
const cfg = Object.assign(
  { source: onLocalhost ? 'local' : 'github', repo: 'YeonkyunLee/imjang', branch: 'main', token: '' },
  store.get('cfg', {}),
);
const cacheKey = () => `notes:${cfg.source}:${cfg.repo}:${cfg.branch}`;

// ---------- 데이터 출처 ----------
// list() → [{path, sha}] · read(entry) → text
// fetchOne(path) → {sha, text} | null · write(path, text, baseSha, message) → newSha (충돌 시 e.conflict)
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const conflict = () => Object.assign(new Error('다른 곳에서 먼저 수정됨'), { conflict: true });
function b64(s) {
  const b = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}
// fetch는 통신 실패 때만 reject → 오프라인 표시를 붙여 대기열로 보낸다
async function net(url, opts) {
  try { return await fetch(url, opts); } catch { throw Object.assign(new Error('오프라인 — 연결되면 다시 시도'), { offline: true }); }
}
const unb64 = s =>new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));

const sources = {
  local: {
    async list() {
      const r = await net('local/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`로컬 목록 실패 (${r.status}) — dev.py로 띄웠는지 확인`);
      return r.json();
    },
    async read(e) {
      const r = await net('local/' + encPath(e.path), { cache: 'no-store' });
      if (!r.ok) throw new Error(`${e.path} 읽기 실패 (${r.status})`);
      return r.text();
    },
    async fetchOne(path) {
      const r = await net('local/' + encPath(path), { cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${path} 읽기 실패 (${r.status})`);
      return { sha: r.headers.get('X-Sha'), text: await r.text() };
    },
    async write(path, text, sha) {
      const r = await net('local/' + encPath(path), { method: 'PUT', headers: { 'X-Base-Sha': sha || '' }, body: text });
      if (r.status === 409) throw conflict();
      if (!r.ok) throw new Error(`저장 실패 (${r.status})`);
      return (await r.json()).sha;
    },
  },
  github: {
    headers(raw) {
      return {
        Authorization: `Bearer ${cfg.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
    },
    async list() {
      if (!cfg.token) throw new Error('설정(⚙)에서 GitHub 토큰을 입력하세요');
      const url = `https://api.github.com/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`;
      const r = await net(url, { headers: this.headers(), cache: 'no-store' });
      if (!r.ok) throw new Error(`GitHub 목록 실패 (${r.status}${r.status === 401 ? ' 토큰 확인' : r.status === 404 ? ' 저장소·브랜치·권한 확인' : ''})`);
      const j = await r.json();
      return j.tree.filter(t => t.type === 'blob' && t.path.endsWith('.md')).map(t => ({ path: t.path, sha: t.sha }));
    },
    async read(e) {
      const r = await net(`https://api.github.com/repos/${cfg.repo}/git/blobs/${e.sha}`, { headers: this.headers(true) });
      if (!r.ok) throw new Error(`${e.path} 읽기 실패 (${r.status})`);
      return r.text();
    },
    contentsUrl: path => `https://api.github.com/repos/${cfg.repo}/contents/${encPath(path)}`,
    async fetchOne(path) {
      const r = await net(`${this.contentsUrl(path)}?ref=${encodeURIComponent(cfg.branch)}`, { headers: this.headers(), cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${path} 읽기 실패 (${r.status})`);
      const j = await r.json();
      return { sha: j.sha, text: unb64(j.content) };
    },
    async write(path, text, sha, message) {
      const r = await net(this.contentsUrl(path), {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ message, content: b64(text), branch: cfg.branch, ...(sha ? { sha } : {}) }),
      });
      if (r.status === 409 || r.status === 422) throw conflict();
      if (!r.ok) throw new Error(`저장 실패 (${r.status}${r.status === 403 || r.status === 404 ? ' — 토큰에 Contents 쓰기 권한 확인' : ''})`);
      return (await r.json()).content.sha;
    },
  },
};

// ---------- 노트 수정 (텍스트 → 텍스트 변환) ----------
const today = () => new Date().toLocaleDateString('sv-SE');
const nowHM = () => new Date().toTimeString().slice(0, 5);
const eolOf = t => (t.includes('\r\n') ? '\r\n' : '\n');

function setFields(text, fields) {
  const eol = eolOf(text);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const lines = m ? m[1].split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(fields)) {
    const line = v === '' || v == null ? `${k}:` : `${k}: ${v}`;
    const i = lines.findIndex(l => l.startsWith(k + ':'));
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  const fm = `---${eol}${lines.join(eol)}${eol}---`;
  return m ? fm + text.slice(m[0].length) : fm + eol + text;
}

function addMemo(text, memo, stamp = `${today()} ${nowHM()}`) {
  const eol = eolOf(text);
  const entry = `- ${stamp} ${memo.trim().split(/\r?\n/).join(eol + '  ')}`;
  const lines = text.split(/\r?\n/);
  const s = lines.findIndex(l => /^##\s+임장 메모\s*$/.test(l));
  if (s < 0) return `${text.replace(/\s*$/, '')}${eol}${eol}## 임장 메모${eol}${entry}${eol}`;
  let e = lines.findIndex((l, i) => i > s && /^#{1,2}\s/.test(l));
  if (e < 0) e = lines.length;
  for (let i = e - 1; i > s; i--) if (/^-\s*\(현장 느낌 추가\)\s*$/.test(lines[i])) { lines.splice(i, 1); e--; }
  let at = e;
  while (at - 1 > s && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, entry);
  return lines.join(eol);
}

const fmtLL = ll => `[${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}]`;

function newNoteText({ name, region, type, addr, ll, memo }) {
  return [
    '---', `tags: [임장, ${region}]`, `지역: ${region}`, `유형: ${type}`, '상태: 계획', '평가:',
    `주소: ${addr}`.trimEnd(), ll ? `location: ${fmtLL(ll)}` : 'location:',
    '준공:', '세대:', '시세:', '시세평형:', `조사일: ${today()}`, '방문일:', '---', '',
    `# ${name}`, '', '## 임장 메모', `- ${today()} ${nowHM()} ${memo?.trim() || '앱에서 등록'}`, '',
  ].join('\n');
}

// 변경은 직렬화 가능한 형태 — 오프라인 대기열에 두었다가 나중에 그때의 최신본에 다시 적용한다.
//   {type:'fields', fields} · {type:'memo', memo, stamp}
const applyChange = (text, c) => (c.type === 'fields' ? setFields(text, c.fields) : addMemo(text, c.memo, c.stamp));

// 작업: {kind:'edit', path, change, message} | {kind:'create', path, text, message}
const queueKey = () => `queue:${cacheKey()}`;
let queue = [];
let failed = store.get('failed', []);
const saveQueue = () => store.set(queueKey(), queue);

// 충돌이면 최신본을 받아 한 번 더 적용
async function commitOp(op) {
  const src = sources[cfg.source];
  if (op.kind === 'create') {
    if (await src.fetchOne(op.path)) throw new Error(`${op.path}: 같은 이름의 노트가 이미 있음`);
    raw[op.path] = { sha: await src.write(op.path, op.text, null, op.message), text: op.text };
    return;
  }
  let cur = raw[op.path];
  for (let attempt = 0; ; attempt++) {
    if (!cur) throw new Error(`${op.path}: 저장소에 노트가 없음`);
    const text = applyChange(cur.text, op.change);
    if (text === cur.text) return;
    try {
      raw[op.path] = { sha: await src.write(op.path, text, cur.sha, op.message), text };
      return;
    } catch (e) {
      if (!e.conflict || attempt) throw e;
      cur = await src.fetchOne(op.path);
    }
  }
}

// 바로 커밋, 오프라인이면(또는 앞선 대기 작업이 있으면) 대기열로. → 'saved' | 'queued'
async function submit(op) {
  if (!queue.length) {
    try {
      await commitOp(op);
      afterWrite();
      return 'saved';
    } catch (e) {
      if (!e.offline) throw e;
    }
  }
  queue.push(op);
  saveQueue();
  afterWrite();
  return 'queued';
}

let flushing = false;
async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  let sent = 0;
  try {
    while (queue.length) {
      try {
        await commitOp(queue[0]);
        sent++;
      } catch (e) {
        if (e.offline) break;
        failed.push({ ...queue[0], error: e.message, at: new Date().toLocaleString() });
        store.set('failed', failed);
        setStatus(`대기 중이던 저장 실패: ${e.message} — 설정(⚙)에서 내용 확인`, true);
      }
      queue.shift();
      saveQueue();
    }
  } finally {
    flushing = false;
  }
  if (sent) {
    afterWrite();
    if (!queue.length) setStatus(`대기 중이던 ${sent}건 저장됨`);
  }
}
window.addEventListener('online', flush);
setInterval(() => queue.length && flush(), 60000);

// 화면에 보이는 데이터 = 저장소 상태 + 아직 못 보낸 작업
function displayData() {
  if (!queue.length) return raw;
  const d = { ...raw };
  for (const op of queue) {
    if (op.kind === 'create') d[op.path] = { sha: null, text: op.text };
    else if (d[op.path]) d[op.path] = { ...d[op.path], text: applyChange(d[op.path].text, op.change) };
  }
  return d;
}

function afterWrite() {
  store.set(cacheKey(), raw);
  render(`${new Date().toLocaleString()} 저장`, false);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ---------- 노트 파싱 ----------
function parseNote(path, text) {
  const parts = path.split('/');
  const name = parts.pop().replace(/\.md$/, '');
  const folder = parts.join('/');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let fm = {}, error = null;
  if (m) {
    try { fm = jsyaml.load(m[1]) || {}; } catch (e) { error = e.message.split('\n')[0]; }
  }
  const body = m ? text.slice(m[0].length) : text;
  const tags = [].concat(fm.tags || []).map(String);
  const loc = Array.isArray(fm.location) && fm.location.length === 2 ? fm.location.map(Number) : null;
  const ll = loc && loc.every(Number.isFinite) ? loc : null;
  return {
    path, name, body, fm, error, tags, ll,
    region: fm.지역 || folder || '(루트)',
    isPlace: !!fm.유형,
    isMoc: tags.includes('moc'),
    rating: fm.평가 || '미평가',
  };
}

// ---------- 상태 ----------
let raw = {}; // path → {sha, text}
let notes = [];
const byName = new Map();
let markers = new Map(); // name → marker
let firstRender = true;
const filters = Object.fromEntries(Object.keys(FILTERS).map(k => [k, new Set(store.get('filters', {})[k] || [])]));
const saveFilters = () => store.set('filters', Object.fromEntries(Object.entries(filters).map(([k, s]) => [k, [...s]])));
const places = () => notes.filter(n => n.isPlace);
const fieldOf = (n, k) => k === '평가' ? n.rating : k === '지역' ? n.region : n.fm[k];
const passes = n => Object.entries(filters).every(([k, s]) => !s.size || s.has(fieldOf(n, k)));

// ---------- 지도 ----------
const savedView = store.get('view', null);
const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView(savedView?.c || [37.495, 126.96], savedView?.z || 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
// crossOrigin: 서비스워커가 타일을 (opaque가 아닌) 일반 응답으로 캐시하도록
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap', crossOrigin: true,
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const syncLabels = () => map.getContainer().classList.toggle('show-labels', map.getZoom() >= 15);
map.on('zoomend', syncLabels);
map.on('moveend', () => store.set('view', { c: map.getCenter(), z: map.getZoom() }));
syncLabels();

function pinHtml(n, mini) {
  const shape = n.fm.유형 === '재건축' ? 'sq' : n.fm.유형 === '재개발구역' ? 'dia' : 'circ';
  const cls = ['pin', shape, mini && 'mini', n.fm.상태 === '제외' && 'out'].filter(Boolean).join(' ');
  const mark = !mini && n.fm.상태 === '다녀옴' ? '<span>✓</span>' : '';
  return `<div class="${cls}" style="--c:${RATING_COLOR[n.rating] || RATING_COLOR.미평가}">${mark}</div>`;
}

function drawMarkers() {
  layer.clearLayers();
  markers = new Map();
  const shown = places().filter(passes);
  for (const n of shown) {
    if (!n.ll) continue;
    const mk = L.marker(n.ll, {
      icon: L.divIcon({ className: 'pin-wrap', html: pinHtml(n), iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: { '1순위': 300, '추천': 200, '후보': 100 }[n.rating] || 0,
    });
    mk.bindTooltip(esc(n.name), { permanent: true, direction: 'right', offset: [10, 0], className: 'lbl' });
    mk.on('click', () => nav(n.name));
    mk.addTo(layer);
    markers.set(n.name, mk);
  }
  const all = places();
  $('#count').textContent = `${shown.length}/${all.length}${queue.length ? ` · 대기 ${queue.length}` : ''}`;
  if (firstRender && !savedView && markers.size) {
    map.fitBounds(L.latLngBounds([...markers.values()].map(m => m.getLatLng())), { padding: [30, 30] });
  }
  firstRender = false;
}

function focus(ll) {
  const z = Math.max(map.getZoom(), 16);
  const sheetUp = window.innerWidth < 900;
  const pt = map.project(ll, z).add([sheetUp ? 0 : 220, sheetUp ? map.getSize().y * 0.25 : 0]);
  map.flyTo(map.unproject(pt, z), z, { duration: 0.6 });
}

// ---------- 패널 ----------
const panels = { filter: '#panel-filter', list: '#panel-list', settings: '#panel-settings', new: '#panel-new' };
function togglePanel(name, force) {
  for (const [k, sel] of Object.entries(panels)) {
    const open = k === name ? (force ?? $(sel).hidden) : false;
    $(sel).hidden = !open;
    $(`#btn-${k}`)?.classList.toggle('on', open);
  }
}
$('#btn-filter').onclick = () => togglePanel('filter');
$('#btn-list').onclick = () => togglePanel('list');
$('#btn-settings').onclick = () => togglePanel('settings');
map.on('click', e => (picking ? pickAt([e.latlng.lat, e.latlng.lng]) : togglePanel(null)));

function drawFilters() {
  const all = places();
  FILTERS.지역 = [...new Set(all.map(n => n.region))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('#filter-groups').innerHTML = Object.entries(FILTERS).map(([k, opts]) => `
    <div class="fgroup"><h4>${k}</h4><div class="chips">${opts.map(o => {
      const cnt = all.filter(n => fieldOf(n, k) === o).length;
      const sample = k === '평가' ? pinHtml({ fm: {}, rating: o }, true)
        : k === '유형' ? pinHtml({ fm: { 유형: o }, rating: '미평가' }, true) : '';
      return `<button class="chip${filters[k].has(o) ? ' on' : ''}" data-k="${esc(k)}" data-v="${esc(o)}">${sample}${esc(o)} <span class="n">${cnt}</span></button>`;
    }).join('')}</div></div>`).join('');
}
$('#filter-groups').onclick = e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const s = filters[c.dataset.k];
  s.has(c.dataset.v) ? s.delete(c.dataset.v) : s.add(c.dataset.v);
  saveFilters(); refresh();
};
$('#filter-reset').onclick = () => { Object.values(filters).forEach(s => s.clear()); saveFilters(); refresh(); };

function drawList() {
  const q = $('#search').value.trim().toLowerCase();
  const hit = n => !q || n.name.toLowerCase().includes(q) || String(n.fm.주소 || '').toLowerCase().includes(q);
  const shown = places().filter(n => passes(n) && hit(n));
  const regions = [...new Set(shown.map(n => n.region))].sort((a, b) => a.localeCompare(b, 'ko'));
  const order = { '1순위': 0, '추천': 1, '후보': 2, '미평가': 3, '탈락': 4 };
  $('#list-body').innerHTML = regions.map(r => {
    const items = shown.filter(n => n.region === r).sort((a, b) => (order[a.rating] - order[b.rating]) || a.name.localeCompare(b.name, 'ko'));
    const mocs = notes.filter(n => n.isMoc && n.region === r);
    return `<div class="region"><h3>${esc(r)} <span class="n">${items.length}</span>
      ${routes[r]?.length ? `<button class="btn sm" data-route="${esc(r)}">동선 ${routes[r].length}곳</button>` : ''}</h3>
      ${mocs.length ? `<div class="mocs">${mocs.map(m => `<a href="#" data-note="${esc(m.name)}">${esc(m.name)}</a>`).join('')}</div>` : ''}
      ${items.map(n => `<button class="item" data-note="${esc(n.name)}">${pinHtml(n, true)}
        <span class="name">${esc(n.name)}<br><span class="sub">${esc([n.fm.유형, n.fm.상태, n.fm.시세 && `${n.fm.시세}억`].filter(Boolean).join(' · '))}</span></span>
        ${queue.some(o => o.path === n.path) ? '<span class="tag">대기</span>' : ''}
        ${n.ll ? '' : '<span class="tag warn">좌표 없음</span>'}</button>`).join('')}</div>`;
  }).join('') || '<p class="hint">조건에 맞는 장소가 없습니다.</p>';
}
$('#search').oninput = drawList;
$('#list-body').onclick = e => {
  const rt = e.target.closest('[data-route]');
  if (rt) { startRoute(rt.dataset.route); return; }
  const el = e.target.closest('[data-note]'); if (!el) return;
  e.preventDefault();
  if (window.innerWidth < 900) togglePanel(null);
  nav(el.dataset.note);
};

// ---------- 추천 동선 ('임장 계획' 노트의 지역별 '추천 동선' 줄과 그 아래 들여쓴 줄의 [[링크]] 순서) ----------
let routes = {};
let activeRoute = null; // {region, stops, i}
const routeLayer = L.layerGroup().addTo(map);

function parseRoutes() {
  const plan = byName.get('임장 계획');
  const out = {};
  if (!plan) return out;
  const lines = plan.body.split(/\r?\n/);
  let region = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(.+?)(?:\s+후속)?\s*$/);
    if (h) { region = h[1]; continue; }
    if (/^#{1,2}\s/.test(lines[i])) region = null;
    if (!region || !/추천 동선/.test(lines[i])) continue;
    const block = [lines[i]];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i]);
    const stops = (out[region] ||= []);
    for (const m of block.join('\n').matchAll(WIKILINK)) {
      const t = m[1].trim();
      if (byName.get(t)?.isPlace && !stops.includes(t)) stops.push(t);
    }
  }
  return out;
}

function startRoute(region) {
  activeRoute = { region, stops: routes[region], i: -1 };
  if (window.innerWidth < 900) togglePanel(null);
  drawRoute();
  const lls = activeRoute.stops.map(s => byName.get(s)?.ll).filter(Boolean);
  if (lls.length) map.flyToBounds(lls, { padding: [60, 60], maxZoom: 16, duration: 0.6 });
}

function drawRoute() {
  routeLayer.clearLayers();
  if (activeRoute) activeRoute.stops = routes[activeRoute.region] || [];
  if (!activeRoute?.stops.length) { activeRoute = null; $('#routebar').hidden = true; return; }
  const { stops, i, region } = activeRoute;
  const pts = stops.map(s => byName.get(s)?.ll).filter(Boolean);
  L.polyline(pts, { color: '#111827', weight: 3, opacity: 0.7, dashArray: '6 6', interactive: false }).addTo(routeLayer);
  stops.forEach((s, k) => {
    const ll = byName.get(s)?.ll;
    if (ll) L.marker(ll, { icon: L.divIcon({ className: `stop-num${k === i ? ' cur' : ''}`, html: String(k + 1), iconSize: [18, 18], iconAnchor: [-6, 24] }), interactive: false, zIndexOffset: 500 }).addTo(routeLayer);
  });
  const noLL = stops.filter(s => !byName.get(s)?.ll).length;
  $('#route-text').textContent = i < 0
    ? `${region} 동선 ${stops.length}곳${noLL ? ` (좌표 없음 ${noLL})` : ''}`
    : `${i + 1}/${stops.length} ${stops[i]}`;
  $('#route-prev').disabled = i <= 0;
  $('#route-next').disabled = i >= stops.length - 1;
  $('#routebar').hidden = false;
}

function stepRoute(d) {
  const r = activeRoute;
  r.i = Math.max(0, Math.min(r.stops.length - 1, r.i + d));
  drawRoute();
  nav(r.stops[r.i]);
}
$('#route-prev').onclick = () => stepRoute(-1);
$('#route-next').onclick = () => stepRoute(1);
$('#route-close').onclick = () => { activeRoute = null; drawRoute(); };

// ---------- 상세 시트 ----------
function nav(name) {
  history.pushState({ note: name, d: (history.state?.d || 0) + 1 }, '', '#note=' + encodeURIComponent(name));
  route();
}
function route() {
  const m = location.hash.match(/^#note=(.+)$/);
  if (m) showNote(decodeURIComponent(m[1])); else $('#sheet').hidden = true;
}
window.addEventListener('popstate', route);
$('#sheet-close').onclick = () => {
  const d = history.state?.d || 0;
  if (d) history.go(-d);
  else { history.replaceState(null, '', location.pathname + location.search); route(); }
};
$('#sheet-expand').onclick = () => $('#sheet').classList.toggle('full');

const WIKILINK = /\[\[([^\]|#\\]+)(?:#[^\]|\\]*)?(?:\\?\|([^\]]+))?\]\]/g;
function renderMd(body, selfName) {
  const text = body.replace(new RegExp(`^\\s*# ${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`), '')
    .replace(WIKILINK, (_, t, a) => {
      const target = t.trim();
      return `<a class="wl${byName.has(target) ? '' : ' missing'}" href="#note=${encodeURIComponent(target)}" data-note="${esc(target)}">${esc((a || t).trim())}</a>`;
    });
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), { ADD_ATTR: ['data-note', 'target'] });
}

function editHtml(n) {
  const seg = (k, opts, cur) => `<div class="seg" data-field="${k}"><span class="k">${k}</span>${opts.map(o =>
    `<button data-v="${esc(o)}" class="${o === cur || (o === '없음' && !cur) ? 'on' : ''}">${esc(o)}</button>`).join('')}</div>`;
  return `<div class="edit">
    ${seg('상태', FILTERS.상태, n.fm.상태)}
    ${seg('평가', ['1순위', '추천', '후보', '탈락', '없음'], n.fm.평가)}
    <div class="memo"><textarea rows="2" placeholder="현장 메모 (시각과 함께 임장 메모에 추가)"></textarea>
      <button class="btn primary" data-act="memo">저장</button></div>
  </div>`;
}

function showNote(name, doFocus = true) {
  const n = byName.get(name);
  if (!n) { if (notes.length) setStatus(`노트 없음: ${name}`, true); return; }
  const f = n.fm;
  const facts = [f.준공 && `${f.준공}년`, f.세대 && `${Number(f.세대).toLocaleString()}세대`, f.시세 && `${f.시세평형 || ''} ${f.시세}억`.trim(),
    f.방문일 && `방문 ${f.방문일 instanceof Date ? f.방문일.toISOString().slice(0, 10) : f.방문일}`].filter(Boolean);
  const badges = n.isPlace ? [f.유형, f.상태, n.rating].filter(Boolean) : ['노트'];
  const q = encodeURIComponent(n.name);
  const acts = [
    n.ll && `<button class="btn" data-act="focus">지도에서 보기</button>`,
    n.ll && `<a class="btn" target="_blank" rel="noopener" href="https://map.kakao.com/link/to/${q},${n.ll[0]},${n.ll[1]}">길찾기</a>`,
    n.isPlace && `<a class="btn" target="_blank" rel="noopener" href="https://map.kakao.com/link/search/${encodeURIComponent(f.주소 ? String(f.주소).replace(/\s*\(.*\)$/, '') : n.name)}">카카오맵 검색</a>`,
    n.isPlace && `<a class="btn" target="_blank" rel="noopener" href="https://m.land.naver.com/search/result/${q}">네이버부동산</a>`,
    n.isPlace && `<button class="btn" data-act="pick">${n.ll ? '위치 수정' : '위치 지정'}</button>`,
  ].filter(Boolean);
  $('#sheet-body').innerHTML = `
    <h2>${esc(n.name)}</h2>
    <div class="badges">${badges.map(b => `<span class="tag">${esc(b)}</span>`).join('')}
      <span class="tag">${esc(n.region)}</span>${n.isPlace && !n.ll ? '<span class="tag warn">좌표 없음</span>' : ''}
      ${n.error ? `<span class="tag warn">frontmatter 오류</span>` : ''}</div>
    ${facts.length ? `<div class="facts">${esc(facts.join(' · '))}</div>` : ''}
    ${f.주소 ? `<div class="addr">${esc(f.주소)}</div>` : ''}
    ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
    ${n.isPlace ? editHtml(n) : ''}
    <div class="md">${renderMd(n.body, n.name)}</div>`;
  if (doFocus) $('#sheet-body').scrollTop = 0;
  $('#sheet-body').querySelectorAll('.md a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  $('#sheet').hidden = false;
  if (n.ll && doFocus) focus(n.ll);
}

const currentNote = () => byName.get(decodeURIComponent(location.hash.match(/^#note=(.+)$/)?.[1] || ''));

const QUEUED_MSG = '오프라인 — 연결되면 자동 저장';

async function save(n, change, message, okMsg) {
  const box = $('#sheet-body .edit');
  box?.classList.add('busy');
  setStatus('저장 중…');
  try {
    const r = await submit({ kind: 'edit', path: n.path, change, message: `앱: ${n.name} ${message}` });
    setStatus(r === 'queued' ? QUEUED_MSG : okMsg || '저장됨');
    return true;
  } catch (err) {
    setStatus(err.message, true);
    return false;
  } finally {
    box?.classList.remove('busy');
  }
}

$('#sheet-body').onclick = async e => {
  const a = e.target.closest('a.wl');
  if (a) { e.preventDefault(); if (!a.classList.contains('missing')) nav(a.dataset.note); return; }
  const n = currentNote();
  if (!n) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'focus' && n.ll) focus(n.ll);
  if (act === 'pick') startPick(n);
  if (act === 'memo') {
    const ta = $('#sheet-body .memo textarea');
    if (!ta.value.trim()) return;
    const memo = ta.value;
    if (await save(n, { type: 'memo', memo, stamp: `${today()} ${nowHM()}` }, '메모', '메모 저장됨')) showNote(n.name, false);
  }
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const k = segBtn.parentElement.dataset.field;
    const v = segBtn.dataset.v === '없음' ? '' : segBtn.dataset.v;
    if ((n.fm[k] || '') === v) return;
    const fields = { [k]: v };
    if (k === '상태' && v === '다녀옴' && !n.fm.방문일) fields.방문일 = today();
    await save(n, { type: 'fields', fields }, `${k} ${v || '비움'}`);
  }
};

// ---------- 위치 지정 ----------
let picking = null;
function startPick(n) {
  picking = n;
  $('#sheet').hidden = true;
  $('#pick-text').textContent = `${n.name}: 지도에서 위치를 누르세요`;
  $('#pickbar').hidden = false;
  document.body.classList.add('picking');
}
function endPick() {
  picking = null;
  $('#pickbar').hidden = true;
  document.body.classList.remove('picking');
  route();
}
async function pickAt(ll) {
  const n = picking;
  endPick();
  if (await save(n, { type: 'fields', fields: { location: fmtLL(ll) } }, '위치', '위치 저장됨')) showNote(n.name);
}
$('#pick-cancel').onclick = endPick;
$('#pick-gps').onclick = () => {
  setStatus('위치 찾는 중…');
  navigator.geolocation.getCurrentPosition(
    p => pickAt([p.coords.latitude, p.coords.longitude]),
    err => setStatus(`위치 실패: ${err.message}`, true),
    { enableHighAccuracy: true, timeout: 15000 },
  );
};

// ---------- 새 장소 (지도 길게 누르기) ----------
let newLL = null;
map.on('contextmenu', e => {
  if (picking) return;
  newLL = [e.latlng.lat, e.latlng.lng];
  const f = $('#new-form');
  f.reset();
  const cur = currentNote();
  f.elements.region.value = cur?.region || [...filters.지역][0] || '';
  $('#region-list').innerHTML = FILTERS.지역.map(r => `<option value="${esc(r)}">`).join('');
  $('#new-ll').textContent = `좌표 ${fmtLL(newLL)}`;
  togglePanel('new', true);
  f.elements.name.focus();
});
$('#new-cancel').onclick = () => togglePanel(null);
$('#new-form').onsubmit = async e => {
  e.preventDefault();
  const el = e.target.elements;
  const clean = s => s.trim().replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = clean(el.name.value), region = clean(el.region.value);
  if (!name || !region) return;
  if (byName.has(name)) { setStatus('같은 이름의 노트가 이미 있음', true); return; }
  const btn = e.submitter; btn && (btn.disabled = true);
  setStatus('저장 중…');
  try {
    const text = newNoteText({ name, region, type: el.type.value, addr: el.addr.value.trim(), ll: newLL, memo: el.memo.value });
    const r = await submit({ kind: 'create', path: `${region}/${name}.md`, text, message: `앱: ${name} 추가` });
    togglePanel(null);
    setStatus(r === 'queued' ? QUEUED_MSG : '추가됨');
    nav(name);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn && (btn.disabled = false);
  }
};

// ---------- 내 위치 ----------
let meMarker = null;
$('#btn-locate').onclick = () => { setStatus('위치 찾는 중…'); map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true }); };
map.on('locationfound', e => {
  setStatus(null);
  meMarker ??= L.marker(e.latlng, { icon: L.divIcon({ className: 'me', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
  meMarker.setLatLng(e.latlng);
});
map.on('locationerror', e => setStatus(`위치 실패: ${e.message}`, true));

// ---------- 설정 ----------
const form = $('#settings-form');
function fillSettings() { for (const k of ['source', 'repo', 'branch', 'token']) form.elements[k].value = cfg[k]; }
form.onsubmit = e => {
  e.preventDefault();
  for (const k of ['source', 'repo', 'branch', 'token']) cfg[k] = form.elements[k].value.trim();
  cfg.repo ||= 'YeonkyunLee/imjang'; cfg.branch ||= 'main';
  store.set('cfg', cfg);
  firstRender = true;
  togglePanel(null);
  load();
};
$('#cache-clear').onclick = () => {
  Object.keys(localStorage).filter(k => k.startsWith('notes:')).forEach(store.del);
  setStatus('캐시를 지웠습니다');
};

let statusTimer;
function setStatus(msg, isError) {
  clearTimeout(statusTimer);
  const el = $('#status');
  el.hidden = !msg; el.textContent = msg || ''; el.classList.toggle('error', !!isError);
  if (msg && !isError && !msg.endsWith('…') && !/\d+\/\d+$/.test(msg)) statusTimer = setTimeout(() => (el.hidden = true), 2500);
}

// ---------- 불러오기 ----------
function refresh() { drawFilters(); drawMarkers(); drawList(); }

let loadInfo = '';
function render(info, doRoute = true) {
  if (info) loadInfo = info;
  notes = Object.entries(displayData()).map(([p, v]) => parseNote(p, v.text));
  byName.clear();
  for (const n of notes) byName.set(n.name, n);
  routes = parseRoutes();
  refresh();
  drawRoute();
  drawInfo();
  if (doRoute) route();
  else if (currentNote() && !$('#sheet').hidden) showNote(currentNote().name, false);
}

function drawInfo() {
  const ps = places();
  const errs = notes.filter(n => n.error);
  const desc = op => op.kind === 'create' ? '새 노트' : op.change.type === 'memo' ? `메모: ${op.change.memo}` : JSON.stringify(op.change.fields);
  $('#load-info').innerHTML = `${esc(loadInfo)}<br>노트 ${notes.length} · 장소 ${ps.length} · 좌표 없음 ${ps.filter(n => !n.ll).length}`
    + (queue.length ? `<br><b>저장 대기 ${queue.length}건</b> — 연결되면 자동 전송 <button type="button" class="btn sm" id="flush-now">지금 보내기</button>` : '')
    + (errs.length ? `<br>frontmatter 오류: ${errs.map(n => esc(n.path)).join(', ')}` : '')
    + (failed.length ? `<div class="failed"><b>저장 실패 ${failed.length}건</b> (내용을 복사해 직접 옮기세요)
        <ul>${failed.map(f => `<li>${esc(f.at)} · ${esc(f.path)}<br>${esc(desc(f))}<br><span class="sub">${esc(f.error)}</span></li>`).join('')}</ul>
        <button type="button" class="btn sm" id="failed-clear">실패 목록 지우기</button></div>` : '');
}
$('#load-info').onclick = e => {
  if (e.target.id === 'flush-now') flush();
  if (e.target.id === 'failed-clear') { failed = []; store.set('failed', failed); drawInfo(); }
};

async function load() {
  const key = cacheKey();
  const cached = store.get(key, {});
  queue = store.get(queueKey(), []);
  raw = cached;
  if (Object.keys(cached).length) render('캐시에서 표시 중');
  setStatus('불러오는 중…');
  try {
    const src = sources[cfg.source];
    const entries = await src.list();
    const next = {};
    const todo = [];
    for (const e of entries) (cached[e.path]?.sha === e.sha ? (next[e.path] = cached[e.path]) : todo.push(e));
    let done = 0;
    await pool(todo, 8, async e => {
      next[e.path] = { sha: e.sha, text: await src.read(e) };
      setStatus(`불러오는 중… ${++done}/${todo.length}`);
    });
    raw = next;
    const saved = store.set(key, raw);
    render(`${new Date().toLocaleString()} 갱신 (${todo.length}개 새로 받음)${saved ? '' : ' · 캐시 저장 실패'}`, !Object.keys(cached).length);
    setStatus(todo.length ? `${todo.length}개 노트 갱신` : '최신 상태');
    flush();
  } catch (err) {
    setStatus(err.message + (Object.keys(cached).length ? ' — 캐시 표시 중' : ''), true);
    if (!cfg.token && cfg.source === 'github') togglePanel('settings', true);
  }
}

// 홈 화면 설치·오프라인. localhost에서는 개발 중 캐시 혼동을 피해 ?sw 를 붙였을 때만.
if ('serviceWorker' in navigator && (!onLocalhost || location.search.includes('sw'))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

fillSettings();
load();
