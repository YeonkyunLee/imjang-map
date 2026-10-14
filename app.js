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
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));

const sources = {
  local: {
    async list() {
      const r = await fetch('local/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`로컬 목록 실패 (${r.status}) — dev.py로 띄웠는지 확인`);
      return r.json();
    },
    async read(e) {
      const r = await fetch('local/' + encPath(e.path), { cache: 'no-store' });
      if (!r.ok) throw new Error(`${e.path} 읽기 실패 (${r.status})`);
      return r.text();
    },
    async fetchOne(path) {
      const r = await fetch('local/' + encPath(path), { cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${path} 읽기 실패 (${r.status})`);
      return { sha: r.headers.get('X-Sha'), text: await r.text() };
    },
    async write(path, text, sha) {
      const r = await fetch('local/' + encPath(path), { method: 'PUT', headers: { 'X-Base-Sha': sha || '' }, body: text });
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
    contentsUrl: path => `https://api.github.com/repos/${cfg.repo}/contents/${encPath(path)}`,
    async fetchOne(path) {
      const r = await fetch(`${this.contentsUrl(path)}?ref=${encodeURIComponent(cfg.branch)}`, { headers: this.headers(), cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${path} 읽기 실패 (${r.status})`);
      const j = await r.json();
      return { sha: j.sha, text: unb64(j.content) };
    },
    async write(path, text, sha, message) {
      const r = await fetch(this.contentsUrl(path), {
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

function addMemo(text, memo) {
  const eol = eolOf(text);
  const entry = `- ${today()} ${nowHM()} ${memo.trim().split(/\r?\n/).join(eol + '  ')}`;
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

// 현재 버전에 fn을 적용해 커밋. 충돌이면 최신본을 받아 한 번 더 적용.
async function editNote(path, fn, message) {
  const src = sources[cfg.source];
  let cur = raw[path];
  for (let attempt = 0; ; attempt++) {
    const text = fn(cur.text);
    if (text === cur.text) return;
    try {
      raw[path] = { sha: await src.write(path, text, cur.sha, message), text };
      break;
    } catch (e) {
      if (!e.conflict || attempt) throw e;
      cur = await src.fetchOne(path);
      if (!cur) throw new Error('노트가 저장소에서 삭제됨');
    }
  }
  afterWrite();
}

async function createNote(path, text, message) {
  const src = sources[cfg.source];
  if (raw[path] || await src.fetchOne(path)) throw new Error('같은 이름의 노트가 이미 있음');
  raw[path] = { sha: await src.write(path, text, null, message), text };
  afterWrite();
}

function afterWrite() {
  store.set(cacheKey(), raw);
  render(raw, `${new Date().toLocaleString()} 저장`, false);
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

async function save(n, fn, message, okMsg) {
  const box = $('#sheet-body .edit');
  box?.classList.add('busy');
  setStatus('저장 중…');
  try {
    await editNote(n.path, fn, `앱: ${n.name} ${message}`);
    setStatus(okMsg || '저장됨');
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
    if (await save(n, t => addMemo(t, memo), '메모', '메모 저장됨')) showNote(n.name, false);
  }
  const segBtn = e.target.closest('.seg button');
  if (segBtn) {
    const k = segBtn.parentElement.dataset.field;
    const v = segBtn.dataset.v === '없음' ? '' : segBtn.dataset.v;
    if ((n.fm[k] || '') === v) return;
    const fields = { [k]: v };
    if (k === '상태' && v === '다녀옴' && !n.fm.방문일) fields.방문일 = today();
    await save(n, t => setFields(t, fields), `${k} ${v || '비움'}`);
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
  if (await save(n, t => setFields(t, { location: fmtLL(ll) }), '위치', '위치 저장됨')) showNote(n.name);
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
    await createNote(`${region}/${name}.md`, text, `앱: ${name} 추가`);
    togglePanel(null);
    setStatus('추가됨');
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

function render(data, info, doRoute = true) {
  raw = data;
  notes = Object.entries(raw).map(([p, v]) => parseNote(p, v.text));
  byName.clear();
  for (const n of notes) byName.set(n.name, n);
  refresh();
  const ps = places();
  const errs = notes.filter(n => n.error);
  $('#load-info').innerHTML = `${esc(info)}<br>노트 ${notes.length} · 장소 ${ps.length} · 좌표 없음 ${ps.filter(n => !n.ll).length}`
    + (errs.length ? `<br>frontmatter 오류: ${errs.map(n => esc(n.path)).join(', ')}` : '');
  if (doRoute) route();
  else if (currentNote() && !$('#sheet').hidden) showNote(currentNote().name, false);
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
    render(next, `${new Date().toLocaleString()} 갱신 (${todo.length}개 새로 받음)${saved ? '' : ' · 캐시 저장 실패'}`, !Object.keys(cached).length);
    setStatus(todo.length ? `${todo.length}개 노트 갱신` : '최신 상태');
  } catch (err) {
    setStatus(err.message + (Object.keys(cached).length ? ' — 캐시 표시 중' : ''), true);
    if (!cfg.token && cfg.source === 'github') togglePanel('settings', true);
  }
}

fillSettings();
load();
