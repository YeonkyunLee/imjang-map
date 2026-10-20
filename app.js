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
const CFG_KEYS = ['source', 'repo', 'branch', 'token', 'kakao', 'who'];
const cfg = Object.assign(
  { source: onLocalhost ? 'local' : 'github', repo: 'YeonkyunLee/imjang', branch: 'main', token: '', kakao: '', who: '' },
  store.get('cfg', {}),
);
const appTag = () => (cfg.who ? `앱(${cfg.who})` : '앱');
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
    async writeBin(path, data) {
      const r = await net('local/' + encPath(path), { method: 'PUT', headers: { 'X-Base-Sha': '' }, body: Uint8Array.from(atob(data), c => c.charCodeAt(0)) });
      if (r.status === 409) throw new Error(`${path}: 같은 이름의 파일이 이미 있음`);
      if (!r.ok) throw new Error(`사진 저장 실패 (${r.status})`);
    },
    async readBin(path) {
      const r = await net('local/' + encPath(path));
      if (!r.ok) throw new Error(`${path} (${r.status})`);
      return r.blob();
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
    async writeBin(path, data, message) {
      const r = await net(this.contentsUrl(path), {
        method: 'PUT', headers: this.headers(), body: JSON.stringify({ message, content: data, branch: cfg.branch }),
      });
      if (r.status === 409 || r.status === 422) throw new Error(`${path}: 같은 이름의 파일이 이미 있음`);
      if (!r.ok) throw new Error(`사진 저장 실패 (${r.status})`);
    },
    async readBin(path) {
      const r = await net(`${this.contentsUrl(path)}?ref=${encodeURIComponent(cfg.branch)}`, { headers: this.headers(true) });
      if (!r.ok) throw new Error(`${path} (${r.status})`);
      return r.blob();
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

// 작업: {kind:'edit', path, change, message} | {kind:'create', path, text, message} | {kind:'upload', path, data(base64), message}
const queueKey = () => `queue:${cacheKey()}`;
let queue = [];
let failed = store.get('failed', []);
const saveQueue = () => store.set(queueKey(), queue);

// 충돌이면 최신본을 받아 한 번 더 적용
async function commitOp(op) {
  const src = sources[cfg.source];
  if (op.kind === 'upload') return src.writeBin(op.path, op.data, op.message);
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
  if (!saveQueue()) {
    queue.pop();
    saveQueue();
    throw new Error('오프라인 보관 공간이 부족합니다 — 연결된 뒤 다시 시도하세요');
  }
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
        failed.push({ ...queue[0], data: undefined, error: e.message, at: new Date().toLocaleString() });
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
const panels = { filter: '#panel-filter', list: '#panel-list', settings: '#panel-settings', new: '#panel-new', install: '#panel-install' };
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

// ---------- 정비구역 경계 (서울 열린데이터광장 '의제처리구역' 중 정비 관련, zones.json) ----------
const ZONE_COLOR = { 재개발: '#e8710a', 재건축: '#9334e6', 촉진지구: '#d93025', 소규모: '#0e9aa7', 주거환경: '#1e8e3e', 존치: '#80868b' };
const ZONE_CODE = {
  UQ1206: '주택재건축', UQ1240: '재건축', UQ1220: '재개발', UQ1221: '주택정비형 재개발', UQ1222: '도시정비형 재개발',
  UQ1231: '주택정비형 재개발지구', UQ1232: '도시정비형 재개발지구', UQ1211: '주거환경개선', UQ1212: '주거환경관리', UQ1250: '결합정비',
  UQ1811: '자율주택정비', UQ1812: '가로주택정비', UQ1813: '소규모재건축', UQ1814: '소규모재개발',
  UQ5110: '주거지형 재정비촉진지구', UQ5120: '중심지형 재정비촉진지구', UQ5130: '고밀복합형 재정비촉진지구', UQ5140: '존치정비구역', UQ5150: '존치관리구역',
};
let zones = null; // GeoJSON features (+ bb)
let zonesLoading = null;
let zonesOn = store.get('zonesOn', false);
const zoneLayer = L.geoJSON(null, {
  renderer: L.canvas({ padding: 0.3 }),
  bubblingMouseEvents: false,
  attribution: '정비구역: 서울 열린데이터광장',
  style: f => {
    const big = f.properties.k === '촉진지구';
    return { color: ZONE_COLOR[f.properties.k], weight: big ? 2 : 1.5, fillOpacity: big ? 0.03 : 0.14, dashArray: big ? '6 4' : null };
  },
  onEachFeature: (f, l) => {
    l.on('click', e => (picking ? pickAt([e.latlng.lat, e.latlng.lng]) : zonePopup(e.latlng)));
    l.on('contextmenu', e => openNew(e.latlng));
  },
});

function loadZones() {
  zonesLoading ||= (async () => {
    setStatus('정비구역 불러오는 중…');
    const r = await fetch('zones.json');
    if (!r.ok) throw new Error(`정비구역 자료 실패 (${r.status})`);
    const j = await r.json();
    for (const f of j.features) {
      let [x0, y0, x1, y1] = [180, 90, -180, -90];
      for (const ring of f.geometry.coordinates) for (const [x, y] of ring) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      f.bb = [x0, y0, x1, y1];
    }
    zones = j.features;
    zoneLayer.addData(j);
    setStatus(null);
    return zones;
  })().catch(e => { zonesLoading = null; setStatus(e.message, true); throw e; });
  return zonesLoading;
}

// 짝홀 규칙 — 구멍과 여러 조각을 함께 처리 (Leaflet 채우기 규칙과 같음)
function inZone(f, [lat, lng]) {
  const [x0, y0, x1, y1] = f.bb;
  if (lng < x0 || lng > x1 || lat < y0 || lat > y1) return false;
  let inside = false;
  for (const ring of f.geometry.coordinates) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
const zonesAt = ll => (zones || []).filter(f => inZone(f, ll));
const zoneLabel = f => `${f.properties.n || '(이름 없음)'} · ${ZONE_CODE[f.properties.c] || f.properties.k}`;

function zonePopup(latlng) {
  const hit = zonesAt([latlng.lat, latlng.lng]);
  if (!hit.length) return;
  L.popup({ maxWidth: 260 }).setLatLng(latlng)
    .setContent(hit.map(f => `<div class="zp"><i style="background:${ZONE_COLOR[f.properties.k]}"></i>${esc(zoneLabel(f))}</div>`).join(''))
    .openOn(map);
}

async function setZones(on) {
  zonesOn = on;
  store.set('zonesOn', on);
  $('#btn-zones').classList.toggle('on', on);
  if (!on) { map.removeLayer(zoneLayer); return; }
  try { await loadZones(); } catch { return; }
  if (zonesOn) zoneLayer.addTo(map);
  const n = currentNote();
  if (n && !$('#sheet').hidden) showNote(n.name, false);
}
$('#btn-zones').onclick = () => setZones(!zonesOn);

// ---------- 좌표 후보 (구역 이름 일치 · 카카오 주소/키워드 검색) ----------
const normName = s => String(s).replace(/\s|제(?=\d)/g, '');
const centroid = f => {
  const ring = f.geometry.coordinates[0];
  const s = ring.reduce((a, [x, y]) => [a[0] + y, a[1] + x], [0, 0]);
  return [s[0] / ring.length, s[1] / ring.length];
};
const distKm = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 88.2);

function regionCenter(region) {
  const lls = places().filter(p => p.region === region && p.ll).map(p => p.ll);
  return lls.length ? [lls.reduce((s, l) => s + l[0], 0) / lls.length, lls.reduce((s, l) => s + l[1], 0) / lls.length] : null;
}

function zoneCandidates(n) {
  const k = normName(n.name).replace(/구역$/, '');
  if (!/\d$/.test(k)) return [];
  const re = new RegExp('^' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\d-])');
  return zones.filter(f => re.test(normName(f.properties.n)))
    .map(f => ({ ll: centroid(f), label: zoneLabel(f), src: '정비구역 경계', zone: f }));
}

let kakaoReady = null;
function loadKakao() {
  kakaoReady ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(cfg.kakao)}&libraries=services&autoload=false`;
    s.onload = () => window.kakao?.maps ? kakao.maps.load(ok) : fail(new Error('카카오 SDK 로드 실패'));
    s.onerror = () => fail(new Error('카카오 SDK 로드 실패 — 키·도메인 등록·카카오맵 사용 설정 확인'));
    document.head.append(s);
  }).catch(e => { kakaoReady = null; throw e; });
  return kakaoReady;
}

async function kakaoCandidates(n) {
  await loadKakao();
  const svc = kakao.maps.services;
  const call = (fn, ...a) => new Promise(r => fn(...a, (res, st) => r(st === svc.Status.OK ? res : [])));
  const out = [];
  const addr = String(n.fm.주소 || '').replace(/\(.*?\)/g, '').replace(/\s*(일대|일원)\s*$/, '').trim();
  if (addr) {
    for (const a of await call((q, cb) => new svc.Geocoder().addressSearch(q, cb), addr)) {
      out.push({ ll: [+a.y, +a.x], label: a.address_name, src: '카카오 주소' });
    }
  }
  for (const p of (await call((q, cb) => new svc.Places().keywordSearch(q, cb), n.name)).slice(0, 5)) {
    out.push({ ll: [+p.y, +p.x], label: `${p.place_name} · ${p.road_address_name || p.address_name}`, src: '카카오 장소' });
  }
  return out;
}

let cands = [];
const candLayer = L.layerGroup().addTo(map);

async function findCandidates(n) {
  const box = $('#sheet-body .cands');
  box.innerHTML = '<p class="hint">찾는 중…</p>';
  const errs = [];
  let list = [];
  try { await loadZones(); list = zoneCandidates(n); } catch (e) { errs.push(e.message); }
  if (cfg.kakao) {
    try { list = list.concat(await kakaoCandidates(n)); } catch (e) { errs.push(e.message); }
  }
  const c = regionCenter(n.region);
  if (c) for (const x of list) x.km = distKm(x.ll, c);
  cands = list.sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  if (currentNote() !== n) return;
  box.innerHTML = (cands.length ? cands.map((x, i) => `<div class="cand">
      <span>${esc(x.label)}<br><span class="sub">${esc(x.src)}${x.km != null ? ` · 지역 중심에서 ${x.km.toFixed(1)}km` : ''}</span></span>
      <button class="btn sm" data-act="cand-show" data-i="${i}">보기</button>
      <button class="btn sm primary" data-act="cand-use" data-i="${i}">저장</button></div>`).join('')
    : `<p class="hint">후보 없음${cfg.kakao ? '' : ' — 설정에 카카오 키를 넣으면 주소로도 찾습니다'}. "위치 지정"으로 직접 찍어 주세요.</p>`)
    + errs.map(m => `<p class="hint err">${esc(m)}</p>`).join('');
}

function showCandidate(x) {
  candLayer.clearLayers();
  L.marker(x.ll, { icon: L.divIcon({ className: 'cand-pin', iconSize: [18, 18] }), interactive: false, zIndexOffset: 900 }).addTo(candLayer);
  if (!x.zone) { focus(x.ll); return; }
  const g = L.geoJSON(x.zone, { interactive: false, style: { color: '#111827', weight: 3, fillOpacity: 0.1 } }).addTo(candLayer);
  const sheetUp = window.innerWidth < 900;
  map.flyToBounds(g.getBounds(), {
    paddingTopLeft: [30, 70], paddingBottomRight: [sheetUp ? 30 : 470, sheetUp ? map.getSize().y * 0.55 : 30], maxZoom: 17, duration: 0.6,
  });
}

// ---------- 상세 시트 ----------
function nav(name) {
  history.pushState({ note: name, d: (history.state?.d || 0) + 1 }, '', '#note=' + encodeURIComponent(name));
  route();
}
function route() {
  const m = location.hash.match(/^#note=(.+)$/);
  candLayer.clearLayers();
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
const IMG_EMBED = /!\[\[([^\]|]+\.(?:jpe?g|png|webp|gif))(?:\\?\|[^\]]*)?\]\]/gi;
function renderMd(body, selfName) {
  const text = body.replace(new RegExp(`^\\s*# ${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`), '')
    .replace(IMG_EMBED, (_, p) => `<img class="att" data-att="${esc(p.trim())}" alt="사진">`)
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
      <div class="col"><button class="btn primary" data-act="memo">저장</button>
        <label class="btn" title="사진 첨부 (메모를 적으면 설명으로 함께 저장)">📷<input type="file" accept="image/*" multiple hidden id="photo-input"></label></div></div>
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
  const inZones = n.ll ? zonesAt(n.ll) : [];
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
    ${inZones.length ? `<div class="zones-in">${inZones.map(z => `<div class="zp"><i style="background:${ZONE_COLOR[z.properties.k]}"></i>${esc(zoneLabel(z))}</div>`).join('')}</div>` : ''}
    ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
    ${n.isPlace && !n.ll ? `<div class="cands"><button class="btn" data-act="cands">위치 후보 찾기</button></div>` : ''}
    ${n.isPlace ? editHtml(n) : ''}
    <div class="md">${renderMd(n.body, n.name)}</div>`;
  if (doFocus) $('#sheet-body').scrollTop = 0;
  $('#sheet-body').querySelectorAll('.md a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  $('#sheet').hidden = false;
  loadAtts();
  if (n.ll && doFocus) focus(n.ll);
}

// ---------- 사진 ----------
const attUrls = new Map(); // path → object URL / data URL
async function loadAtts() {
  for (const img of $('#sheet-body').querySelectorAll('img.att:not([src])')) {
    const p = img.dataset.att;
    const pending = queue.find(o => o.kind === 'upload' && o.path === p);
    try {
      if (pending) img.src = 'data:image/jpeg;base64,' + pending.data;
      else {
        if (!attUrls.has(p)) attUrls.set(p, URL.createObjectURL(await sources[cfg.source].readBin(p)));
        img.src = attUrls.get(p);
      }
    } catch (e) {
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'tag warn', textContent: `사진 못 불러옴: ${p.split('/').pop()}` }));
    }
  }
}

async function shrink(file, max = 1600, q = 0.8) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', q).split(',')[1];
}

async function addPhotos(n, files) {
  const ta = $('#sheet-body .memo textarea');
  const box = $('#sheet-body .edit');
  box?.classList.add('busy');
  const d = new Date();
  const stamp = d.toLocaleString('sv-SE').replace(/\D/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const base = n.name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
  const paths = [];
  let queued = false;
  try {
    for (const [i, f] of [...files].entries()) {
      setStatus(`사진 ${i + 1}/${files.length} 줄이는 중…`);
      const path = `첨부/${base}-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.jpg`;
      const r = await submit({ kind: 'upload', path, data: await shrink(f), message: `${appTag()}: ${n.name} 사진` });
      queued ||= r === 'queued';
      paths.push(path);
    }
    const memo = [ta?.value.trim(), ...paths.map(p => `![[${p}]]`)].filter(Boolean).join(' ');
    const ok = await save(n, { type: 'memo', memo, stamp: `${today()} ${nowHM()}` }, '사진', queued ? QUEUED_MSG : `사진 ${paths.length}장 저장됨`);
    if (ok) showNote(n.name, false);
  } catch (e) {
    setStatus(`사진 저장 실패: ${e.message}`, true);
  } finally {
    box?.classList.remove('busy');
  }
}
$('#sheet-body').addEventListener('change', e => {
  if (e.target.id !== 'photo-input' || !e.target.files.length) return;
  const n = currentNote();
  if (n) addPhotos(n, e.target.files);
});

const currentNote = () => byName.get(decodeURIComponent(location.hash.match(/^#note=(.+)$/)?.[1] || ''));

const QUEUED_MSG = '오프라인 — 연결되면 자동 저장';

async function save(n, change, message, okMsg) {
  const box = $('#sheet-body .edit');
  box?.classList.add('busy');
  setStatus('저장 중…');
  try {
    const r = await submit({ kind: 'edit', path: n.path, change, message: `${appTag()}: ${n.name} ${message}` });
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
  if (e.target.matches('img.att')) { e.target.classList.toggle('big'); return; }
  const a = e.target.closest('a.wl');
  if (a) { e.preventDefault(); if (!a.classList.contains('missing')) nav(a.dataset.note); return; }
  const n = currentNote();
  if (!n) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'focus' && n.ll) focus(n.ll);
  if (act === 'pick') startPick(n);
  if (act === 'cands') findCandidates(n);
  if (act === 'cand-show') showCandidate(cands[e.target.dataset.i]);
  if (act === 'cand-use') {
    const x = cands[e.target.dataset.i];
    candLayer.clearLayers();
    if (await save(n, { type: 'fields', fields: { location: fmtLL(x.ll) } }, '위치', '위치 저장됨')) showNote(n.name);
  }
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
map.on('contextmenu', e => openNew(e.latlng));
function openNew(latlng) {
  if (picking) return;
  newLL = [latlng.lat, latlng.lng];
  const f = $('#new-form');
  f.reset();
  const cur = currentNote();
  f.elements.region.value = cur?.region || [...filters.지역][0] || '';
  $('#region-list').innerHTML = FILTERS.지역.map(r => `<option value="${esc(r)}">`).join('');
  $('#new-ll').textContent = `좌표 ${fmtLL(newLL)}`;
  togglePanel('new', true);
  f.elements.name.focus();
}
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
    const r = await submit({ kind: 'create', path: `${region}/${name}.md`, text, message: `${appTag()}: ${name} 추가` });
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
function fillSettings() { for (const k of CFG_KEYS) form.elements[k].value = cfg[k]; }
form.onsubmit = e => {
  e.preventDefault();
  for (const k of CFG_KEYS) cfg[k] = form.elements[k].value.trim();
  cfg.repo ||= 'YeonkyunLee/imjang'; cfg.branch ||= 'main';
  store.set('cfg', cfg);
  firstRender = true;
  togglePanel(null);
  load();
};
// 이름·권한·기간이 채워진 토큰 생성 화면 (저장소 선택은 URL로 못 채움)
$('#token-new').href = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'imjang-map', description: '임장 지도 앱: imjang 저장소 노트 읽기·쓰기',
  target_name: cfg.repo.split('/')[0] || 'YeonkyunLee', expires_in: '366', contents: 'write',
});
$('#token-paste').onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!/^(github_pat_|ghp_)\w+$/.test(t)) { setStatus('클립보드에 토큰이 없습니다 — 복사 후 다시', true); return; }
    form.elements.token.value = t;
    setStatus('붙여넣음 — "저장하고 다시 불러오기"를 누르세요');
  } catch {
    setStatus('붙여넣기 권한이 없어요 — 토큰 칸을 길게 눌러 붙여넣으세요', true);
  }
};
// 다른 사람과 같이 쓰기: 내 계정으로 그 사람용 토큰을 만들고, QR(앱 주소#t=토큰&who=이름)로 넘긴다.
// #뒤는 서버로 가지 않음. 받은 쪽은 시작할 때 읽어 저장하고 주소에서 지운다.
const shareName = () => $('#share-name').value.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 25);
function syncShareLink() {
  $('#share-new').href = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
    name: `imjang-map-${shareName() || '공유'}`, description: `임장 지도 앱 공유: ${shareName() || '다른 사람'}`,
    target_name: cfg.repo.split('/')[0] || 'YeonkyunLee', expires_in: '366', contents: 'write',
  });
}
$('#share-name').oninput = syncShareLink;
$('#share-name').onkeydown = e => e.key === 'Enter' && e.preventDefault();
syncShareLink();

let qrLib = null;
const loadQr = () => (qrLib ||= new Promise((ok, fail) => {
  const s = Object.assign(document.createElement('script'), { src: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js' });
  s.onload = () => ok(window.qrcode);
  s.onerror = () => { qrLib = null; fail(new Error('QR 라이브러리를 못 불러옴 — 연결 확인')); };
  document.head.append(s);
}));

$('#share-qr').onclick = async () => {
  const input = $('#share-token');
  if (!input.value.trim()) {
    try { input.value = (await navigator.clipboard.readText()).trim(); } catch {}
  }
  const t = input.value.trim();
  if (!/^(github_pat_|ghp_)\w+$/.test(t)) { setStatus('그 사람용 토큰을 복사한 뒤 다시 누르세요 (또는 아래 칸에 붙여넣기)', true); return; }
  if (t === cfg.token) { setStatus('내 토큰이 아니라 ①에서 새로 만든 토큰이어야 합니다', true); return; }
  try {
    const qrcode = await loadQr();
    const url = `${location.origin}${location.pathname}#t=${encodeURIComponent(t)}${shareName() ? `&who=${encodeURIComponent(shareName())}` : ''}`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('#share-out').innerHTML = `<div class="qr">${qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true })}</div>
      <p class="hint">${esc(shareName() || '그 사람')}의 폰 카메라로 찍게 하세요.</p>
      <button type="button" class="btn" id="share-close">다 됐으면 QR 지우기</button>`;
  } catch (e) { setStatus(e.message, true); }
};
$('#share-out').onclick = e => {
  if (e.target.id !== 'share-close') return;
  $('#share-out').innerHTML = ''; $('#share-token').value = ''; $('#share-name').value = ''; syncShareLink();
};

function importFromHash() {
  const m = location.hash.match(/^#t=([^&]+)(?:&who=([^&]*))?$/);
  if (!m) return false;
  cfg.source = 'github';
  cfg.token = decodeURIComponent(m[1]);
  if (m[2]) cfg.who = decodeURIComponent(m[2]);
  store.set('cfg', cfg);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

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
  const desc = op => op.kind === 'create' ? '새 노트' : op.kind === 'upload' ? '사진 (원본은 폰 갤러리에 있음)' : op.change.type === 'memo' ? `메모: ${op.change.memo}` : JSON.stringify(op.change.fields);
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

// ---------- 홈 화면 설치 ----------
// Chrome·삼성 인터넷·Edge는 beforeinstallprompt로 설치 창을 직접 띄우고, 안 되는 브라우저(아이폰 등)는 방법을 보여준다.
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvt = null;
const setBar = hidden => { $('#installbar').hidden = hidden; document.body.classList.toggle('has-installbar', !hidden); };
function syncInstall() {
  const done = standalone();
  $('#install-btn').hidden = done;
  setBar(done || store.get('installLater', 0) > Date.now());
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; syncInstall(); });
window.addEventListener('appinstalled', () => {
  installEvt = null;
  setBar(true);
  setStatus('설치됨 — 이제 홈 화면 아이콘으로 여세요');
});

function installHelp() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    return /CriOS|FxiOS|EdgiOS/.test(ua)
      ? '<p>아이폰은 <b>Safari</b>에서만 설치됩니다. 이 주소를 Safari로 열어 주세요.</p>'
      : '<ol><li>화면 아래 <b>공유 버튼</b>(네모에서 위로 화살표)</li><li>목록을 내려 <b>홈 화면에 추가</b></li><li>오른쪽 위 <b>추가</b></li></ol>';
  }
  if (/SamsungBrowser/.test(ua)) return '<ol><li>오른쪽 아래 <b>≡</b> 메뉴</li><li><b>현재 페이지 추가</b> → <b>홈 화면</b></li></ol>';
  if (/KAKAOTALK|NAVER|Instagram|FBAN|Line\//.test(ua)) return '<p>앱 안의 브라우저에서는 설치가 안 됩니다. 오른쪽 위 메뉴에서 <b>다른 브라우저로 열기</b>(Chrome)를 누른 뒤 다시 설치하세요.</p>';
  return '<ol><li>오른쪽 위 <b>⋮</b> 메뉴</li><li><b>홈 화면에 추가</b> 또는 <b>앱 설치</b></li><li><b>설치</b></li></ol>';
}

async function install() {
  if (installEvt) {
    const evt = installEvt;
    installEvt = null; // 한 번만 쓸 수 있음
    try {
      await evt.prompt();
      if ((await evt.userChoice).outcome === 'accepted') setBar(true);
      return;
    } catch { /* 설치 창을 못 띄우면 방법 안내로 */ }
  }
  $('#install-help').innerHTML = installHelp()
    + '<p class="hint">설치 후에는 홈 화면의 "임장" 아이콘으로 여세요. 토큰은 지금 이 브라우저에 저장돼 있어서, 같은 브라우저로 설치해야 다시 넣지 않아도 됩니다.</p>';
  togglePanel('install', true);
}
$('#install-go').onclick = install;
$('#install-btn').onclick = install;
$('#install-close').onclick = () => togglePanel(null);
$('#install-later').onclick = () => { store.set('installLater', Date.now() + 7 * 864e5); setBar(true); };
syncInstall();

// 홈 화면 설치·오프라인. localhost에서는 개발 중 캐시 혼동을 피해 ?sw 를 붙였을 때만.
if ('serviceWorker' in navigator && (!onLocalhost || location.search.includes('sw'))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const imported = importFromHash();
fillSettings();
load().then(() => imported && setStatus(`토큰 저장됨${cfg.who ? ` (${cfg.who})` : ''} — 메뉴에서 "홈 화면에 추가"를 해 두세요`));
if (zonesOn) setZones(true);
