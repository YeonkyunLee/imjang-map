'use strict';
// 임장 지도 — 1단계: 조회 전용. 데이터 원본은 imjang 저장소의 노트 frontmatter.

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

// ---------- 데이터 출처: list() → [{path, sha}], read(entry) → text ----------
const sources = {
  local: {
    async list() {
      const r = await fetch('local/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`로컬 목록 실패 (${r.status}) — dev.py로 띄웠는지 확인`);
      return r.json();
    },
    async read(e) {
      const r = await fetch('local/' + e.path.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
      if (!r.ok) throw new Error(`${e.path} 읽기 실패 (${r.status})`);
      return r.text();
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
      const r = await fetch(url, { headers: this.headers(), cache: 'no-store' });
      if (!r.ok) throw new Error(`GitHub 목록 실패 (${r.status}${r.status === 401 ? ' 토큰 확인' : r.status === 404 ? ' 저장소·브랜치·권한 확인' : ''})`);
      const j = await r.json();
      return j.tree.filter(t => t.type === 'blob' && t.path.endsWith('.md')).map(t => ({ path: t.path, sha: t.sha }));
    },
    async read(e) {
      const r = await fetch(`https://api.github.com/repos/${cfg.repo}/git/blobs/${e.sha}`, { headers: this.headers(true) });
      if (!r.ok) throw new Error(`${e.path} 읽기 실패 (${r.status})`);
      return r.text();
    },
  },
};

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
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap',
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
  $('#count').textContent = `${shown.length}/${all.length}`;
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
const panels = { filter: '#panel-filter', list: '#panel-list', settings: '#panel-settings' };
function togglePanel(name, force) {
  for (const [k, sel] of Object.entries(panels)) {
    const open = k === name ? (force ?? $(sel).hidden) : false;
    $(sel).hidden = !open;
    $(`#btn-${k}`).classList.toggle('on', open);
  }
}
$('#btn-filter').onclick = () => togglePanel('filter');
$('#btn-list').onclick = () => togglePanel('list');
$('#btn-settings').onclick = () => togglePanel('settings');
map.on('click', () => togglePanel(null));

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
    return `<div class="region"><h3>${esc(r)} <span class="n">${items.length}</span></h3>
      ${mocs.length ? `<div class="mocs">${mocs.map(m => `<a href="#" data-note="${esc(m.name)}">${esc(m.name)}</a>`).join('')}</div>` : ''}
      ${items.map(n => `<button class="item" data-note="${esc(n.name)}">${pinHtml(n, true)}
        <span class="name">${esc(n.name)}<br><span class="sub">${esc([n.fm.유형, n.fm.상태, n.fm.시세 && `${n.fm.시세}억`].filter(Boolean).join(' · '))}</span></span>
        ${n.ll ? '' : '<span class="tag warn">좌표 없음</span>'}</button>`).join('')}</div>`;
  }).join('') || '<p class="hint">조건에 맞는 장소가 없습니다.</p>';
}
$('#search').oninput = drawList;
$('#list-body').onclick = e => {
  const el = e.target.closest('[data-note]'); if (!el) return;
  e.preventDefault();
  if (window.innerWidth < 900) togglePanel(null);
  nav(el.dataset.note);
};

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

function showNote(name) {
  const n = byName.get(name);
  if (!n) { if (notes.length) setStatus(`노트 없음: ${name}`, true); return; }
  const f = n.fm;
  const facts = [f.준공 && `${f.준공}년`, f.세대 && `${Number(f.세대).toLocaleString()}세대`, f.시세 && `${f.시세평형 || ''} ${f.시세}억`.trim()].filter(Boolean);
  const badges = n.isPlace ? [f.유형, f.상태, n.rating].filter(Boolean) : ['노트'];
  const q = encodeURIComponent(n.name);
  const acts = [
    n.ll && `<button class="btn" data-act="focus">지도에서 보기</button>`,
    n.ll && `<a class="btn" target="_blank" rel="noopener" href="https://map.kakao.com/link/to/${q},${n.ll[0]},${n.ll[1]}">길찾기</a>`,
    n.isPlace && `<a class="btn" target="_blank" rel="noopener" href="https://map.kakao.com/link/search/${encodeURIComponent(f.주소 ? String(f.주소).replace(/\s*\(.*\)$/, '') : n.name)}">카카오맵 검색</a>`,
    n.isPlace && `<a class="btn" target="_blank" rel="noopener" href="https://m.land.naver.com/search/result/${q}">네이버부동산</a>`,
  ].filter(Boolean);
  $('#sheet-body').innerHTML = `
    <h2>${esc(n.name)}</h2>
    <div class="badges">${badges.map(b => `<span class="tag">${esc(b)}</span>`).join('')}
      <span class="tag">${esc(n.region)}</span>${n.isPlace && !n.ll ? '<span class="tag warn">좌표 없음</span>' : ''}
      ${n.error ? `<span class="tag warn">frontmatter 오류</span>` : ''}</div>
    ${facts.length ? `<div class="facts">${esc(facts.join(' · '))}</div>` : ''}
    ${f.주소 ? `<div class="addr">${esc(f.주소)}</div>` : ''}
    ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
    <div class="md">${renderMd(n.body, n.name)}</div>`;
  $('#sheet-body').scrollTop = 0;
  $('#sheet-body').querySelectorAll('.md a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  $('#sheet').hidden = false;
  if (n.ll) focus(n.ll);
}
$('#sheet-body').onclick = e => {
  const a = e.target.closest('a.wl');
  if (a) { e.preventDefault(); if (!a.classList.contains('missing')) nav(a.dataset.note); return; }
  if (e.target.closest('[data-act="focus"]')) {
    const n = byName.get(decodeURIComponent(location.hash.slice(6)));
    if (n?.ll) focus(n.ll);
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

function render(raw, info) {
  notes = Object.entries(raw).map(([p, v]) => parseNote(p, v.text));
  byName.clear();
  for (const n of notes) byName.set(n.name, n);
  refresh();
  const ps = places();
  const errs = notes.filter(n => n.error);
  $('#load-info').innerHTML = `${esc(info)}<br>노트 ${notes.length} · 장소 ${ps.length} · 좌표 없음 ${ps.filter(n => !n.ll).length}`
    + (errs.length ? `<br>frontmatter 오류: ${errs.map(n => esc(n.path)).join(', ')}` : '');
  route();
}

async function load() {
  const key = cacheKey();
  const cached = store.get(key, {});
  if (Object.keys(cached).length) render(cached, '캐시에서 표시 중');
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
    const saved = store.set(key, next);
    render(next, `${new Date().toLocaleString()} 갱신 (${todo.length}개 새로 받음)${saved ? '' : ' · 캐시 저장 실패'}`);
    setStatus(todo.length ? `${todo.length}개 노트 갱신` : '최신 상태');
  } catch (err) {
    setStatus(err.message + (Object.keys(cached).length ? ' — 캐시 표시 중' : ''), true);
    if (!cfg.token && cfg.source === 'github') togglePanel('settings', true);
  }
}

fillSettings();
load();
