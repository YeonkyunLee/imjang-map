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
  시세: ['1~5억', '5~10억', '10~15억', '15~20억', '20~25억', '25억~', '시세 없음'],
};
// 시세(억, 대표평형) → 금액대. 경계값은 위 구간에 넣음 (15억 → 15~20억)
function priceBand(v) {
  const x = parseFloat(String(v ?? '').replace(/,/g, ''));
  if (!Number.isFinite(x) || x <= 0) return '시세 없음';
  return x < 5 ? '1~5억' : x < 10 ? '5~10억' : x < 15 ? '10~15억' : x < 20 ? '15~20억' : x < 25 ? '20~25억' : '25억~';
}

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
let firstRender = true;
const filters = Object.fromEntries(Object.keys(FILTERS).map(k => [k, new Set(store.get('filters', {})[k] || [])]));
// 선택지가 바뀐 뒤 저장돼 있던 옛 값(예: '~10억')은 버린다 — 남아 있으면 아무것도 안 보임
for (const [k, s] of Object.entries(filters)) if (FILTERS[k]) for (const v of s) if (!FILTERS[k].includes(v)) s.delete(v);
const saveFilters = () => store.set('filters', Object.fromEntries(Object.entries(filters).map(([k, s]) => [k, [...s]])));
const places = () => notes.filter(n => n.isPlace);
const fieldOf = (n, k) => k === '평가' ? n.rating : k === '지역' ? n.region : k === '시세' ? priceBand(n.fm.시세) : n.fm[k];
const passes = n => Object.entries(filters).every(([k, s]) => !s.size || s.has(fieldOf(n, k)));

// ---------- 지도 (카카오맵. SDK는 index.html에서 동기 로드 — 실패하면 지도 없이 목록·상세만) ----------
// 좌표는 앱 안에서 [lat, lng] 배열, 카카오 객체로는 경계에서만 바꾼다. 카카오 레벨은 작을수록 확대(1~14).
const K = window.kakao?.maps?.Map ? kakao.maps : null;
const LL = ([lat, lng]) => new K.LatLng(lat, lng);
const llOf = p => [p.getLat(), p.getLng()];
const savedView = store.get('kview', null);
const mapEl = $('#map');
const map = K && new K.Map(mapEl, { center: LL(savedView?.c || [37.495, 126.96]), level: savedView?.l || 8 });
// 지도 위 HTML 요소 (마커·라벨·팝업). clickable: 요소를 눌러도 지도 클릭으로 번지지 않음
function overlay(ll, el, { x = 0.5, y = 0.5, z = 0, clickable = false } = {}) {
  if (typeof el === 'string') el = Object.assign(document.createElement('div'), { innerHTML: el }).firstElementChild;
  return new K.CustomOverlay({ map, position: LL(ll), content: el, xAnchor: x, yAnchor: y, zIndex: z, clickable });
}
const clear = list => { for (const o of list.splice(0)) o.setMap(null); };
// lls를 화면에 맞추되 minLevel보다 더 확대하지는 않음. pad = [위, 오른쪽, 아래, 왼쪽]
function fitTo(lls, pad = [30, 30, 30, 30], minLevel = 4) {
  if (!map || !lls.length) return;
  const b = new K.LatLngBounds();
  for (const ll of lls) b.extend(LL(ll));
  map.setBounds(b, ...pad);
  if (map.getLevel() < minLevel) map.setLevel(minLevel);
}
let markerObjs = [];
if (map) {
  if (window.innerWidth >= 900) map.addControl(new K.ZoomControl(), K.ControlPosition.LEFT); // 폰은 두 손가락 확대
  const syncLabels = () => mapEl.classList.toggle('show-labels', map.getLevel() <= 5);
  K.event.addListener(map, 'zoom_changed', syncLabels);
  K.event.addListener(map, 'idle', () => store.set('kview', { c: llOf(map.getCenter()), l: map.getLevel() }));
  syncLabels();
}

// 마커: 모양·아이콘 = 유형, 색 = 금액대(기본) 또는 평가. ✓ 다녀옴, ★ 1순위(금액대 색일 때)
const PRICE_COLOR = { '1~5억': '#2e7d32', '5~10억': '#7cb342', '10~15억': '#f9a825', '15~20억': '#fb8c00', '20~25억': '#e53935', '25억~': '#8e24aa', '시세 없음': '#78909c' };
let colorBy = store.get('colorBy', '시세'); // '시세' | '평가'
const ICON = {
  아파트: '<path d="M4 21V3h10v5h6v13H4zm2-2h2v-2H6v2zm0-4h2v-2H6v2zm0-4h2V9H6v2zm0-4h2V5H6v2zm4 12h2v-2h-2v2zm0-4h2v-2h-2v2zm0-4h2V9h-2v2zm0-4h2V5h-2v2zm6 12h2v-2h-2v2zm0-4h2v-2h-2v2zm0-4h2v-2h-2v2z"/>',
  재건축: '<path d="M2 21V5h9v16H2zm2-2h1.6v-2H4v2zm0-4h1.6v-2H4v2zm0-4h1.6V9H4v2zm3.4 8H9v-2H7.4v2zm0-4H9v-2H7.4v2zm0-4H9V9H7.4v2z"/><path d="M17.5 6.2V4l3.6 3.3-3.6 3.3V8.3a3.2 3.2 0 1 0 3.1 4l2 .5a5.3 5.3 0 1 1-5.1-6.6z"/>',
  재개발구역: '<path d="M2 2h5v2.2H4.2V7H2V2zm15 0h5v5h-2.2V4.2H17V2zM2 17h2.2v2.8H7V22H2v-5zm17.8 2.8V17H22v5h-5v-2.2h2.8zM10 2h4v2.2h-4V2zm0 17.8h4V22h-4v-2.2zM2 10h2.2v4H2v-4zm17.8 0H22v4h-2.2v-4z"/><path d="M7 17v-5.5L12 7l5 4.5V17h-3.5v-3h-3v3H7z"/>',
  도시형생활주택: '<path d="M12 3l9 8h-2.5v9h-5v-6h-3v6h-5v-9H3l9-8z"/>',
  미확인: '<path d="M11 18h2v2h-2v-2zm1-14a5 5 0 0 1 5 5c0 2.2-1.6 3.1-2.5 3.8-.8.6-1.5 1.1-1.5 2.2v.5h-2V15c0-2 1.2-2.9 2.2-3.6.9-.7 1.8-1.2 1.8-2.4a3 3 0 0 0-6 0H7a5 5 0 0 1 5-5z"/>',
};
function pinMarkup({ type, color, mini, out, visited, star, fresh }) {
  const t = ICON[type] ? type : '미확인';
  const cls = ['pin', t === '재개발구역' ? 'zone' : 'round', mini && 'mini', out && 'out'].filter(Boolean).join(' ');
  const badges = mini ? '' : (visited ? '<b class="pb ok">✓</b>' : '') + (star ? '<b class="pb star">★</b>' : '') + (fresh ? '<b class="pb new" title="새 실거래">N</b>' : '');
  return `<div class="${cls}" style="--c:${color}"><svg viewBox="0 0 24 24">${ICON[t]}</svg>${badges}</div>`;
}
const pinColor = n => (colorBy === '평가' ? RATING_COLOR[n.rating] || RATING_COLOR.미평가 : PRICE_COLOR[priceBand(n.fm.시세)]);
const pinHtml = (n, mini) => pinMarkup({
  type: n.fm.유형, color: pinColor(n), mini, out: n.fm.상태 === '제외',
  visited: n.fm.상태 === '다녀옴', star: colorBy !== '평가' && n.rating === '1순위', fresh: apts && hasNewTrade(n),
});

function drawMarkers() {
  const shown = places().filter(passes);
  const all = places();
  $('#count').textContent = `${shown.length}/${all.length}${queue.length ? ` · 대기 ${queue.length}` : ''}`;
  if (!map) return;
  clear(markerObjs);
  for (const n of shown) {
    if (!n.ll) continue;
    const el = Object.assign(document.createElement('div'), {
      className: 'pin-wrap', innerHTML: `${pinHtml(n)}<span class="lbl">${esc(n.name)}${priceTag(n)}</span>`,
    });
    el.onclick = () => nav(n.name);
    markerObjs.push(overlay(n.ll, el, { z: { '1순위': 3, '추천': 2, '후보': 1 }[n.rating] || 0, clickable: true }));
  }
  if (firstRender && !savedView) fitTo(shown.filter(n => n.ll).map(n => n.ll));
  firstRender = false;
}

// ll을 확대해서 보여주되, 상세 시트에 가리지 않는 쪽(폰: 위, PC: 왼쪽)에 둔다
function focus(ll) {
  if (!map) return;
  if (map.getLevel() > 4) map.setLevel(4);
  const sheetUp = window.innerWidth < 900;
  const proj = map.getProjection();
  const p = proj.containerPointFromCoords(LL(ll));
  map.panTo(proj.coordsFromContainerPoint(new K.Point(p.x + (sheetUp ? 0 : 220), p.y + (sheetUp ? mapEl.clientHeight * 0.25 : 0))));
}

// ---------- 패널 ----------
const panels = { filter: '#panel-filter', list: '#panel-list', settings: '#panel-settings', new: '#panel-new', install: '#panel-install', compare: '#panel-compare' };
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
// 왼쪽 패널은 왼쪽으로 밀어서 닫기 (손가락을 따라 움직이다가 80px 넘게 밀면 닫힘)
for (const sel of Object.values(panels)) {
  const el = $(sel);
  let s = null;
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    s = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, dx: 0, h: null } : null;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!s) return;
    const t = e.touches[0];
    s.dx = t.clientX - s.x;
    s.h ??= Math.abs(s.dx) > 8 || Math.abs(t.clientY - s.y) > 8 ? Math.abs(s.dx) > Math.abs(t.clientY - s.y) : null;
    if (s.h) { el.style.transition = 'none'; el.style.transform = `translateX(${Math.min(0, s.dx)}px)`; }
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (!s) return;
    const close = s.h && s.dx < -80;
    el.style.transition = el.style.transform = '';
    s = null;
    if (close) togglePanel(null);
  });
  el.addEventListener('touchcancel', () => { s = null; el.style.transition = el.style.transform = ''; });
}
function mapClick(ll) {
  if (Date.now() - longPressAt < 800) return; // 길게 누른 손을 뗄 때 오는 클릭
  if (picking) { pickAt(ll); return; }
  if (measure) { measure.pts.push(ll); drawMeasure(); return; }
  togglePanel(null);
  if (zonesOn) zonePopup(ll); else closePopup();
}
if (map) K.event.addListener(map, 'click', e => mapClick(llOf(e.latLng)));

function drawFilters() {
  const all = places();
  FILTERS.지역 = [...new Set(all.map(n => n.region))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('#filter-groups').innerHTML = Object.entries(FILTERS).map(([k, opts]) => `
    <div class="fgroup"><h4>${k === '시세' ? '시세 <span class="n">대표평형 최근 실거래, 여러 개 고르면 합쳐서</span>' : k}</h4><div class="chips">${opts.map(o => {
      const cnt = all.filter(n => fieldOf(n, k) === o).length;
      const sample = k === '평가' ? `<i class="dot" style="background:${RATING_COLOR[o]}"></i>`
        : k === '시세' ? `<i class="dot" style="background:${PRICE_COLOR[o]}"></i>`
        : k === '유형' ? pinMarkup({ type: o, color: '#5f6b7a', mini: true }) : '';
      return `<button class="chip${filters[k].has(o) ? ' on' : ''}" data-k="${esc(k)}" data-v="${esc(o)}">${sample}${esc(o)} <span class="n">${cnt}</span></button>`;
    }).join('')}</div></div>`).join('');
}
$('#filter-groups').onclick = e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const s = filters[c.dataset.k];
  s.has(c.dataset.v) ? s.delete(c.dataset.v) : s.add(c.dataset.v);
  saveFilters(); refresh();
};
function syncColorBy() {
  for (const b of $('#color-by').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === colorBy);
}
$('#color-by').onclick = e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === colorBy) return;
  colorBy = b.dataset.v; store.set('colorBy', colorBy); syncColorBy(); refresh();
};
syncColorBy();
$('#filter-reset').onclick = () => { Object.values(filters).forEach(s => s.clear()); saveFilters(); refresh(); };

function drawList() {
  const q = $('#search').value.trim().toLowerCase();
  const hit = n => !q || n.name.toLowerCase().includes(q) || String(n.fm.주소 || '').toLowerCase().includes(q);
  const shown = places().filter(n => passes(n) && hit(n));
  const regions = [...new Set(shown.map(n => n.region))].sort((a, b) => a.localeCompare(b, 'ko'));
  const order = { '1순위': 0, '추천': 1, '후보': 2, '미평가': 3, '탈락': 4 };
  const price = n => parseFloat(n.fm.시세) || null;
  const byName_ = (a, b) => a.name.localeCompare(b.name, 'ko');
  const cmp = {
    평가: (a, b) => (order[a.rating] - order[b.rating]) || byName_(a, b),
    저가: (a, b) => ((price(a) ?? 1e9) - (price(b) ?? 1e9)) || byName_(a, b), // 시세 없는 곳은 뒤로
    고가: (a, b) => ((price(b) ?? -1) - (price(a) ?? -1)) || byName_(a, b),
    이름: byName_,
  }[listSort] || byName_;
  const inToday = todayList.filter(nm => byName.get(nm));
  $('#list-body').innerHTML = (inToday.length ? `<div class="today card"><div class="today-top"><b>🚩 오늘 동선 ${inToday.length}곳</b>
      <button class="btn sm primary" data-today="go">동선 보기</button><button class="btn sm" data-today="clear">비우기</button></div>
      <div class="today-list">${inToday.map((nm, k) => `<a href="#" data-note="${esc(nm)}">${k + 1}. ${esc(nm)}</a>`).join('')}</div></div>` : '')
  + regions.map(r => {
    const items = shown.filter(n => n.region === r).sort(cmp);
    const mocs = notes.filter(n => n.isMoc && n.region === r);
    return `<div class="region"><h3>${esc(r)} <span class="n">${items.length}</span>
      ${routes[r]?.length ? `<button class="btn sm" data-route="${esc(r)}">동선 ${routes[r].length}곳</button>` : ''}</h3>
      ${mocs.length ? `<div class="mocs">${mocs.map(m => `<a href="#" data-note="${esc(m.name)}">${esc(m.name)}</a>`).join('')}</div>` : ''}
      ${items.map(n => `<button class="item" data-note="${esc(n.name)}"><span class="item-ic">${pinHtml(n)}</span>
        <span class="name">${esc(n.name)}<span class="sub">${esc([n.fm.유형, n.fm.상태, n.rating !== '미평가' && n.rating].filter(Boolean).join(' · '))}</span>
          ${queue.some(o => o.path === n.path) ? '<span class="tag">대기</span>' : ''}${n.ll ? '' : '<span class="tag warn">좌표 없음</span>'}${apts && hasNewTrade(n) ? '<span class="tag new">새 거래</span>' : ''}</span>
        <span class="item-price"${n.fm.시세 ? ` style="--c:${PRICE_COLOR[priceBand(n.fm.시세)]}"` : ''}>${n.fm.시세 ? `${esc(n.fm.시세)}<small>억</small>` : '<small>—</small>'}</span></button>`).join('')}</div>`;
  }).join('') || '<p class="hint">조건에 맞는 장소가 없습니다.</p>';
}
$('#search').oninput = drawList;
let listSort = store.get('listSort', '평가');
$('#sort').value = listSort;
$('#sort').onchange = () => { listSort = $('#sort').value; store.set('listSort', listSort); drawList(); };
$('#list-body').onclick = e => {
  const td = e.target.closest('[data-today]');
  if (td) { td.dataset.today === 'go' ? startToday() : (todayList = [], syncToday(), drawList(), drawRoute()); return; }
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
const routeObjs = [];

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

// ---------- 오늘 동선: 상세에서 담은 곳 (이 폰에만 저장). 보기 누르면 내 위치에서 가까운 순으로 ----------
const TODAY = '오늘';
let todayList = store.get('today', []);
function syncToday() {
  if (notes.length) todayList = todayList.filter(nm => byName.get(nm)?.isPlace);
  store.set('today', todayList);
  routes[TODAY] = [...todayList];
}
function toggleToday(n) {
  const had = todayList.includes(n.name);
  todayList = had ? todayList.filter(x => x !== n.name) : [...todayList, n.name];
  syncToday(); drawList(); drawRoute();
  setStatus(had ? '오늘 동선에서 뺐습니다' : `오늘 동선에 담았습니다 (${todayList.length}곳)`);
}
async function startToday() {
  if (!todayList.length) return;
  let cur = null;
  try { setStatus('내 위치 찾는 중…'); cur = await myPosition(); setStatus(null); } catch { setStatus('위치를 몰라 담은 순서대로 보여줍니다'); }
  const left = todayList.map(nm => byName.get(nm)).filter(n => n?.ll), out = [];
  if (!cur && left.length) cur = left[0].ll;
  while (left.length) { // 가장 가까운 곳부터 차례로
    left.sort((a, b) => distKm(cur, a.ll) - distKm(cur, b.ll));
    const n = left.shift(); out.push(n.name); cur = n.ll;
  }
  todayList = [...out, ...todayList.filter(nm => !out.includes(nm))];
  syncToday();
  startRoute(TODAY);
}

function startRoute(region) {
  activeRoute = { region, stops: routes[region], i: -1 };
  if (window.innerWidth < 900) togglePanel(null);
  drawRoute();
  const lls = activeRoute.stops.map(s => byName.get(s)?.ll).filter(Boolean);
  fitTo(lls, [60, 60, 60, 60]);
}

function drawRoute() {
  if (map) clear(routeObjs);
  if (activeRoute) activeRoute.stops = routes[activeRoute.region] || [];
  if (!activeRoute?.stops.length) { activeRoute = null; $('#routebar').hidden = true; return; }
  const { stops, i, region } = activeRoute;
  if (map) {
    const pts = stops.map(s => byName.get(s)?.ll).filter(Boolean);
    routeObjs.push(new K.Polyline({ map, path: pts.map(LL), strokeColor: '#111827', strokeWeight: 3, strokeOpacity: 0.7, strokeStyle: 'shortdash' }));
    stops.forEach((s, k) => {
      const ll = byName.get(s)?.ll;
      if (ll) routeObjs.push(overlay(ll, `<div class="stop-num${k === i ? ' cur' : ''}">${k + 1}</div>`, { x: -0.33, y: 1.33, z: 5 }));
    });
  }
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
// 2천여 개를 한꺼번에 그리면 폰이 버벅여서, 레벨 ZONE_LEVEL 이하로 확대했을 때 화면 안의 구역만 그린다
const ZONE_LEVEL = 7;
const zoneShown = new Set();
const zonePath = f => f.geometry.coordinates.map(ring => ring.map(([x, y]) => new K.LatLng(y, x)));
// 진행 단계(s, 정비사업 정보몽땅): 진행 중 / 완료(준공·이전고시·해산·청산) / 기록 없음(오래전 완료됐거나 사업 전).
// 촉진지구·존치는 지구 경계라 단계 없이 항상 표시. 완료·기록 없음은 기본 숨김, 켜면 흐린 회색.
const ZONE_DONE = /준공|이전고시|해산|청산/;
const zoneState = f => (f.properties.k === '촉진지구' || f.properties.k === '존치' ? 'district'
  : !f.properties.s ? 'none' : ZONE_DONE.test(f.properties.s) ? 'done' : 'active');
let zonesAll = store.get('zonesAll', false);
const zoneVisible = f => zonesAll || zoneState(f) === 'active' || zoneState(f) === 'district';
function zonePoly(f) {
  if (f.poly) return f.poly;
  const big = f.properties.k === '촉진지구';
  const dim = zoneState(f) === 'done' || zoneState(f) === 'none';
  f.poly = new K.Polygon(dim ? {
    path: zonePath(f), strokeColor: '#80868b', strokeWeight: 1, strokeOpacity: 0.7, strokeStyle: 'shortdash', fillColor: '#80868b', fillOpacity: 0.05,
  } : {
    path: zonePath(f), strokeColor: ZONE_COLOR[f.properties.k], strokeWeight: big ? 2 : 1.5, strokeOpacity: 0.9,
    strokeStyle: big ? 'dash' : 'solid', fillColor: ZONE_COLOR[f.properties.k], fillOpacity: big ? 0.03 : 0.14,
  });
  K.event.addListener(f.poly, 'click', e => mapClick(llOf(e.latLng)));
  return f.poly;
}
let zoneHintShown = false;
function drawZones() {
  if (!map || !zones) return;
  const want = new Set();
  if (zonesOn && map.getLevel() <= ZONE_LEVEL) {
    const b = map.getBounds(), sw = b.getSouthWest(), ne = b.getNorthEast();
    for (const f of zones) {
      const [x0, y0, x1, y1] = f.bb;
      if (zoneVisible(f) && x1 >= sw.getLng() && x0 <= ne.getLng() && y1 >= sw.getLat() && y0 <= ne.getLat()) want.add(f);
    }
  } else if (zonesOn && !zoneHintShown) {
    zoneHintShown = true;
    setStatus('구역 경계는 지도를 더 확대하면 보입니다');
  }
  for (const f of zoneShown) if (!want.has(f)) { f.poly.setMap(null); zoneShown.delete(f); }
  for (const f of want) if (!zoneShown.has(f)) { zonePoly(f).setMap(map); zoneShown.add(f); }
}
if (map) K.event.addListener(map, 'idle', drawZones);

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
    setStatus(null);
    return zones;
  })().catch(e => { zonesLoading = null; setStatus(e.message, true); throw e; });
  return zonesLoading;
}

// 짝홀 규칙 — 구멍과 여러 조각을 함께 처리
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
const zoneStage = f => ({ active: f.properties.s, done: `${f.properties.s} (완료)`, none: '진행 기록 없음', district: '' }[zoneState(f)]);
const zoneLabel = f => [f.properties.n || '(이름 없음)', ZONE_CODE[f.properties.c] || f.properties.k, zoneStage(f)].filter(Boolean).join(' · ');

let popup = null;
function closePopup() { popup?.setMap(null); popup = null; }
function zonePopup(ll) {
  closePopup();
  const hit = zonesAt(ll).filter(zoneVisible);
  if (!hit.length) return;
  popup = overlay(ll, `<div class="zpop">${hit.map(f => `<div class="zp"><i style="background:${ZONE_COLOR[f.properties.k]}"></i>${esc(zoneLabel(f))}</div>`).join('')}</div>`,
    { y: 1, z: 10, clickable: true });
}

async function setZones(on) {
  zonesOn = on;
  store.set('zonesOn', on);
  $('#btn-zones').classList.toggle('on', on);
  syncLegend();
  if (on) {
    try { await loadZones(); } catch { return; }
  } else closePopup();
  drawZones();
  if (!on) return;
  const n = currentNote();
  if (n && !$('#sheet').hidden) showNote(n.name, false);
}
$('#btn-zones').onclick = () => setZones(!zonesOn);

// ---------- 아래쪽 범례 (구역·용도 레이어를 켰을 때) ----------
// 카카오 지적편집도 화면에서 뽑은 색. 1·2·3종 같은 세부는 지도 위 글자로 나옴
const DISTRICT_LEGEND = [['#f2ef92', '주거 (지도에 1·2·3종 표시)'], ['#f6a6ae', '상업'], ['#b7c4f0', '공업·준공업'], ['#acdb81', '녹지']];
const ZONE_LEGEND = [['#d93025', '재정비촉진지구', true], ['#e8710a', '재개발'], ['#9334e6', '재건축'], ['#0e9aa7', '가로주택·소규모'],
  ['#1e8e3e', '주거환경'], ['#80868b', '존치']];
function syncLegend() {
  const row = (title, items) => `<div class="lg-row"><b>${title}</b>${items.map(([c, t, dash]) =>
    `<span><i style="${dash ? `border:2px dashed ${c}` : `background:${c}`}"></i>${t}</span>`).join('')}</div>`;
  const all = `<button class="lg-btn${zonesAll ? ' on' : ''}" id="zones-all">${zonesAll ? '✓ ' : ''}완료·기록 없는 구역도 보기</button>`;
  const html = (zonesOn ? row('구역', zonesAll ? [...ZONE_LEGEND, ['#80868b', '완료·기록 없음(회색 점선)', true]] : ZONE_LEGEND).replace(/<\/div>$/, `${all}</div>`) : '')
    + (districtOn ? row('용도', DISTRICT_LEGEND) : '');
  $('#legendbar').innerHTML = html;
  $('#legendbar').hidden = !html;
  placeAdd();
}
// ＋ 버튼은 아래쪽 범례·설치 안내 위에
function placeAdd() {
  const lg = $('#legendbar'), ib = $('#installbar');
  const base = ib.hidden ? 20 : 80;
  const b = lg.hidden ? base : base - 8 + lg.offsetHeight + 10;
  $('#btn-add').style.bottom = `calc(${b}px + env(safe-area-inset-bottom))`;
  $('#maptools').style.bottom = `calc(${b + 56}px + env(safe-area-inset-bottom))`;
  $('#comparechip').style.bottom = `calc(${b + 4}px + env(safe-area-inset-bottom))`;
}
window.addEventListener('resize', () => placeAdd());
$('#legendbar').onclick = e => {
  if (e.target.id !== 'zones-all') return;
  zonesAll = !zonesAll;
  store.set('zonesAll', zonesAll);
  closePopup();
  syncLegend();
  drawZones();
};

// ---------- 용도지역 (카카오 지적편집도 오버레이) ----------
let districtOn = store.get('districtOn', false);
function setDistrict(on) {
  districtOn = on;
  store.set('districtOn', on);
  $('#btn-district').classList.toggle('on', on);
  syncLegend();
  if (!map) return;
  if (on) map.addOverlayMapTypeId(K.MapTypeId.USE_DISTRICT);
  else map.removeOverlayMapTypeId(K.MapTypeId.USE_DISTRICT);
}
$('#btn-district').onclick = () => setDistrict(!districtOn);

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

async function kakaoCandidates(n) {
  if (!K?.services) throw new Error('카카오 지도를 못 불러와서 주소 검색 불가 — 연결·키 확인');
  const svc = K.services;
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
const candObjs = [];
const clearCand = () => map && clear(candObjs);

async function findCandidates(n) {
  const box = $('#sheet-body .cands');
  box.innerHTML = '<p class="hint">찾는 중…</p>';
  const errs = [];
  let list = [];
  try { await loadZones(); list = zoneCandidates(n); } catch (e) { errs.push(e.message); }
  try { list = list.concat(await kakaoCandidates(n)); } catch (e) { errs.push(e.message); }
  const c = regionCenter(n.region);
  if (c) for (const x of list) x.km = distKm(x.ll, c);
  cands = list.sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  if (currentNote() !== n) return;
  box.innerHTML = (cands.length ? cands.map((x, i) => `<div class="cand">
      <span>${esc(x.label)}<br><span class="sub">${esc(x.src)}${x.km != null ? ` · 지역 중심에서 ${x.km.toFixed(1)}km` : ''}</span></span>
      <button class="btn sm" data-act="cand-show" data-i="${i}">보기</button>
      <button class="btn sm primary" data-act="cand-use" data-i="${i}">저장</button></div>`).join('')
    : '<p class="hint">후보 없음. "위치 지정"으로 직접 찍어 주세요.</p>')
    + errs.map(m => `<p class="hint err">${esc(m)}</p>`).join('');
}

function showCandidate(x) {
  if (!map) return;
  clearCand();
  candObjs.push(overlay(x.ll, '<div class="cand-pin"></div>', { z: 9 }));
  if (!x.zone) { focus(x.ll); return; }
  candObjs.push(new K.Polygon({ map, path: zonePath(x.zone), strokeColor: '#111827', strokeWeight: 3, fillColor: '#111827', fillOpacity: 0.1 }));
  const sheetUp = window.innerWidth < 900;
  fitTo(x.zone.geometry.coordinates.flat().map(([lng, lat]) => [lat, lng]),
    [70, sheetUp ? 30 : 470, sheetUp ? mapEl.clientHeight * 0.55 : 30, 30], 3);
}

// ---------- 상세 시트 ----------
function nav(name) {
  history.pushState({ note: name, d: (history.state?.d || 0) + 1 }, '', '#note=' + encodeURIComponent(name));
  route();
}
function route() {
  const m = location.hash.match(/^#note=(.+)$/);
  clearCand();
  clear(nearObjs);
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

const STATUS_COLOR = { 계획: '#2563eb', 다녀옴: '#188038', 제외: '#80868b' };
function editHtml(n) {
  const seg = (k, opts, cur, colors) => `<div class="seg" data-field="${k}"><span class="k">${k}</span><div class="opts">${opts.map(o => {
    const on = o === cur || (o === '없음' && !cur);
    return `<button data-v="${esc(o)}" class="${on ? 'on' : ''}"${on && colors?.[o] ? ` style="--on:${colors[o]}"` : ''}>${esc(o)}</button>`;
  }).join('')}</div></div>`;
  return `<div class="edit card">
    ${seg('상태', FILTERS.상태, n.fm.상태, STATUS_COLOR)}
    ${seg('평가', ['1순위', '추천', '후보', '탈락', '없음'], n.fm.평가, RATING_COLOR)}
    <div class="memo"><textarea rows="2" placeholder="현장 메모 — 시각과 함께 임장 메모에 추가"></textarea>
      <div class="col"><button class="btn primary" data-act="memo">저장</button>
        <label class="btn" title="사진 첨부 (메모를 적으면 설명으로 함께 저장)">📷<input type="file" accept="image/*" multiple hidden id="photo-input"></label></div></div>
  </div>`;
}

// 정비사업 단계 → 7단계 막대
const STAGE_STEPS = ['구역지정', '추진위', '조합설립', '사업시행', '관리처분', '착공', '준공'];
function stageStep(s) {
  const rules = [[/준공|이전고시|해산|청산/, 6], [/착공|철거|이주|분양/, 5], [/관리처분/, 4], [/사업시행|사업계획승인/, 3],
    [/조합설립|창립|조합규약|조합원 모집/, 2], [/추진위/, 1], [/정비구역|정비계획|안전진단|도시계획|건축심의/, 0]];
  return rules.find(([re]) => re.test(s || ''))?.[1] ?? -1;
}
function stageHtml(z) {
  const i = stageStep(z.properties.s);
  return `<div class="stage card"><div class="stage-top"><span class="k">사업 단계</span><b>${esc(z.properties.s)}</b></div>
    ${i >= 0 ? `<div class="steps">${STAGE_STEPS.map((t, k) => `<div class="st${k < i ? ' done' : k === i ? ' cur' : ''}"><i></i><span>${t}</span></div>`).join('')}</div>` : ''}
    <div class="sub">${esc(z.properties.p || z.properties.n)}</div></div>`;
}

// ---------- 구역 안 빌라 실거래 (villas.json: 서울부동산정보광장, 매일 자동 갱신) ----------
// trades: [pnu, lat, lng, 건물명, 준공, 전용㎡, 대지권㎡, 계약일, 금액(만원), 층]
let villas = null, villasLoading = null;
function loadVillas() {
  villasLoading ||= fetch('villas.json').then(r => (r.ok ? r.json() : Promise.reject(new Error(`빌라 실거래 자료 실패 (${r.status})`))))
    .then(j => (villas = j)).catch(e => { villasLoading = null; throw e; });
  return villasLoading;
}
const PY = 3.3058;
const won = v => (v >= 10000 ? `${(v / 10000).toFixed(v >= 100000 ? 1 : 2).replace(/\.?0+$/, '')}억` : `${Math.round(v).toLocaleString()}만`);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const jibunOf = p => `${p[10] === '2' ? '산' : ''}${+p.slice(11, 15)}${+p.slice(15, 19) ? '-' + +p.slice(15, 19) : ''}`;
let villaRows = [];
async function fillVillas(n) {
  const box = $('#sheet-body .villa');
  if (!box) return;
  try { await Promise.all([loadVillas(), loadZones()]); } catch (e) { box.innerHTML = `<p class="hint err">${esc(e.message)}</p>`; return; }
  if (currentNote() !== n) return;
  const zs = zonesAt(n.ll).filter(z => z.properties.k !== '촉진지구' && z.properties.k !== '존치');
  const zone = zs.find(z => zoneState(z) === 'active') || zs[0];
  const R = 0.3;
  const rows = villas.trades.filter(t => (zone ? inZone(zone, [t[1], t[2]]) : distKm(n.ll, [t[1], t[2]]) <= R));
  villaAll = rows;
  // 지난번에 열었을 때보다 늦은 거래는 NEW (처음 열면 표시 없음)
  const vseen = store.get('vseen', {});
  villaSeen = vseen[n.path] || '9999';
  const top = rows.reduce((a, t) => (t[7] > a ? t[7] : a), '');
  if (top && vseen[n.path] !== top) { vseen[n.path] = top; store.set('vseen', vseen); }
  const yearAgo = new Date(Date.now() - 365 * 864e5).toLocaleDateString('sv-SE');
  const recent = rows.filter(t => t[7] >= yearAgo);
  const base = recent.length >= 5 ? recent : rows;
  const scope = zone ? `${esc(zone.properties.n || '구역')} 경계 안` : `반경 ${R * 1000}m (구역 경계 자료 없음)`;
  const dongCode = (rows[0]?.[0] || '').slice(0, 10);
  const hs = villas.houses[dongCode];
  const hRecent = hs ? hs.t.filter(h => h[2]) : [];
  box.innerHTML = `<div class="villa-top"><span class="k">빌라 실거래</span><b>${rows.length}건</b><span class="sub">${scope} · 최근 ${villas.months}개월</span></div>
    ${rows.length ? `<div class="stats">
      <div class="stat"><span class="k">거래가 중위${base === recent ? ' (1년)' : ''}</span><b>${won(median(base.map(t => t[8])))}</b></div>
      <div class="stat"><span class="k">대지 평당</span><b>${won(median(base.filter(t => t[6]).map(t => t[8] / (t[6] / PY))))}</b></div>
      <div class="stat"><span class="k">전용 평당</span><b>${won(median(base.map(t => t[8] / (t[5] / PY))))}</b></div></div>
    <div class="vtools">${Object.keys(VBANDS).map(b => `<button class="vchip" data-act="villa-band" data-v="${b}">${b} <span>${rows.filter(t => t[8] >= VBANDS[b][0] && t[8] < VBANDS[b][1]).length}</span></button>`).join('')}
      <button class="vchip sort" data-act="villa-sort"></button></div>
    <div class="vlist"></div>
    <button class="btn sm" data-act="villa-more" hidden></button>`
    : '<p class="hint">이 범위에 최근 빌라 거래가 없습니다. 단독·다가구 위주 구역일 수 있어요.</p>'}
    ${hRecent.length ? `<div class="houses"><span class="k">같은 동 단독·다가구 ${hRecent.length}건 (지번 비공개, ${esc(hs.n)})</span>
      토지 평당 중위 <b>${won(median(hRecent.map(h => h[1] / (h[2] / PY))))}</b> · 최근: ${hRecent.slice(0, 3).map(h => `${h[0].slice(2).replace(/-/g, '.')} ${won(h[1])}(토지 ${Math.round(h[2])}㎡)`).join(', ')}</div>` : ''}
    <div class="sub">출처: 서울부동산정보광장 · ${esc(villas.updated)} 갱신 · 해제 거래 제외. 대지 평당 = 거래가 ÷ 대지권(평). 신축⚠(2018~)은 권리산정기준일 이후면 입주권이 안 나올 수 있으니 구역별 기준일 확인</div>`;
  if (rows.length) renderVillaList();
}
// 금액대 칩·정렬(최신순 / 대지 평당 낮은순 — 같은 돈으로 땅을 더 사는 순)
const VBANDS = { 전체: [0, 1e9], '1~5억': [10000, 50000], '5~8억': [50000, 80000], '8억~': [80000, 1e9] };
let villaSeen = '9999';
let villaAll = [], villaBand = store.get('villaBand', '전체'), villaSort = store.get('villaSort', '최신');
function renderVillaList(limit = 8) {
  const [lo, hi] = VBANDS[villaBand] || VBANDS.전체;
  let rows = villaAll.filter(t => t[8] >= lo && t[8] < hi);
  if (villaSort === '대지평') rows = [...rows].sort((a, b) => (a[6] ? a[8] / a[6] : 1e12) - (b[6] ? b[8] / b[6] : 1e12));
  villaRows = rows;
  $('#sheet-body .vlist').innerHTML = rows.slice(0, limit).map((t, i) => villaRow(t, i)).join('') || '<p class="hint">이 금액대 거래가 없습니다</p>';
  const more = $('#sheet-body [data-act="villa-more"]');
  more.hidden = rows.length <= limit;
  more.textContent = `${rows.length - limit}건 더 보기`;
  $('#sheet-body').querySelectorAll('.vchip[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === villaBand));
  $('#sheet-body .vchip.sort').textContent = villaSort === '대지평' ? '↕ 대지평 낮은순' : '↕ 최신순';
}
function villaRow(t, i) {
  const [p, , , rawName, year, area, land, date, price, floor] = t;
  const name = String(rawName || '').replace(/\s*\([^)]*\)\s*$/, '');
  return `<button class="vrow" data-act="villa-show" data-i="${i}"><span class="d">${date.slice(2).replace(/-/g, '.')}${date > villaSeen ? '<i class="nb">NEW</i>' : ''}</span>
    <span class="t"><b>${esc(name || jibunOf(p))}</b>${name ? ` <small class="jb">${jibunOf(p)}</small>` : ''}<small>${year >= 2018 ? '<i class="newb" title="권리산정기준일 이후 신축·지분쪼개기면 입주권 대신 현금청산될 수 있음">신축⚠</i> ' : ''}${year || '—'}년 · 전용 ${area}㎡${land ? ` · 대지 ${land}㎡` : ''} · ${floor}층</small></span>
    <span class="v">${won(price)}${land ? `<small>대지평 ${won(price / (land / PY))}</small>` : ''}</span></button>`;
}

// ---------- 아파트 실거래 (apts.json: 서울부동산정보광장, 매일 자동 갱신) ----------
// c: [pnu, 이름, 준공, lat, lng, 네이버코드] · t: [단지번호, YYMMDD, 전용×10, 금액(만원), 층] (최신순)
// r: [단지번호, YYMMDD, 전용×10, 전세 보증금(만원)] (최근 12개월 신규 계약, 최신순)
let apts = null, aptsLoading = null, aptTrades = null, aptRents = null;
function loadApts() {
  aptsLoading ||= fetch('apts.json').then(r => (r.ok ? r.json() : Promise.reject(new Error(`아파트 실거래 자료 실패 (${r.status})`))))
    .then(j => {
      apts = j; aptTrades = j.c.map(() => []); aptRents = j.c.map(() => []);
      for (const t of j.t) aptTrades[t[0]].push(t);
      for (const t of j.r || []) aptRents[t[0]].push(t);
      return j;
    })
    .catch(e => { aptsLoading = null; throw e; });
  return aptsLoading;
}
const ymdAgo = d => +new Date(Date.now() - d * 864e5).toLocaleDateString('sv-SE').slice(2).replace(/-/g, '');
// 한 평형의 매매·전세 요약. 전세가율 = 최근 6개월 전세 중위 ÷ 최근 6개월 매매 중위(없으면 최근 거래가)
function aptStats(i, area) {
  const rows = aptTrades[i].filter(t => areaOf(t) === area);
  const rents = aptRents[i].filter(t => areaOf(t) === area);
  const last = rows[0];
  const recent = median(rows.filter(t => t[1] >= ymdAgo(90)).map(t => t[3]));
  const before = median(rows.filter(t => t[1] >= ymdAgo(455) && t[1] < ymdAgo(365)).map(t => t[3]));
  const sale = median(rows.filter(t => t[1] >= ymdAgo(180)).map(t => t[3])) ?? last?.[3] ?? null;
  const r6 = rents.filter(t => t[1] >= ymdAgo(180));
  const jeonse = median((r6.length >= 2 ? r6 : rents).map(t => t[3]));
  return {
    rows, rents, last, sale, jeonse,
    chg: recent && before ? (recent / before - 1) * 100 : null,
    ratio: sale && jeonse ? jeonse / sale * 100 : null,
    gap: sale && jeonse ? sale - jeonse : null,
  };
}

// 새 거래 배지: 장소마다 마지막으로 본 최신 거래일을 기억. 처음 받을 때는 지금 것을 기준으로 삼아 전부 '새 거래'가 되지 않게
let seen = store.get('seen', {});
const latestTradeOf = n => { const m = matchComplex(n); return m ? aptTrades[m.i][0][1] : 0; };
const hasNewTrade = n => n.path in seen && latestTradeOf(n) > seen[n.path];
function baselineSeen() {
  let changed = false;
  for (const n of places()) {
    const d = latestTradeOf(n);
    if (d && !(n.path in seen)) { seen[n.path] = d; changed = true; }
  }
  if (changed) store.set('seen', seen);
}
const normApt = s => String(s || '').replace(/\(.*?\)|아파트|단지|\s|·/g, '').replace(/제(?=\d)/g, '');
function commonLen(a, b) { // 가장 긴 공통 부분 문자열 길이
  let best = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0; while (a[i + k] && a[i + k] === b[j + k]) k++;
    if (k > best) best = k;
  }
  return best;
}
const matchCache = new Map();
function matchComplex(n) {
  if (!apts || !n.ll) return null;
  const key = `${n.name}|${n.ll}`;
  if (matchCache.has(key)) return matchCache.get(key);
  const nm = normApt(n.name);
  let best = null;
  apts.c.forEach((c, i) => {
    const d = distKm(n.ll, [c[3], c[4]]);
    if (d > 0.35) return;
    const cn = normApt(c[1]);
    const sim = commonLen(nm, cn) / Math.max(2, Math.min(nm.length, cn.length));
    const score = sim * 2 - d * 3;
    if (!best || score > best.score) best = { i, c, d, sim, score };
  });
  const m = best && (best.sim >= 0.5 || best.d < 0.08) && aptTrades[best.i].length ? best : null;
  matchCache.set(key, m);
  return m;
}
const areaOf = t => Math.round(t[2] / 10); // ㎡ 정수
const ymdOf = v => { const s = String(v).padStart(6, '0'); return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`; };
// 노트의 시세평형(예: 59㎡, 18평)에 가장 가까운 평형, 없으면 거래가 가장 많은 평형
function pickArea(n, trades) {
  const cnt = {};
  for (const t of trades) cnt[areaOf(t)] = (cnt[areaOf(t)] || 0) + 1;
  const areas = Object.keys(cnt).map(Number);
  const w = String(n.fm.시세평형 || '');
  const sq = parseFloat(w.match(/(\d+(?:\.\d+)?)\s*㎡/)?.[1]) || (parseFloat(w.match(/(\d+)\s*평/)?.[1]) * PY * 0.76) || null; // 공급평 → 전용 대략
  const top = areas.sort((a, b) => cnt[b] - cnt[a]);
  return { cnt, areas: top, pick: sq ? [...areas].sort((a, b) => Math.abs(a - sq) - Math.abs(b - sq))[0] : top[0] };
}
// 지도 라벨에 최근 실거래가 (아파트·재건축만, apts.json을 받은 뒤)
function priceTag(n) {
  if (!apts || !n.isPlace || !/아파트|재건축|도시형|미확인/.test(n.fm.유형 || '')) return '';
  const t = latestFor(n);
  return t ? ` <b class="lp">${won(t[3])}</b>` : '';
}
function latestFor(n) {
  const m = matchComplex(n);
  if (!m) return null;
  const tr = aptTrades[m.i];
  const { pick } = pickArea(n, tr);
  return tr.find(t => areaOf(t) === pick) || tr[0];
}

let aptSel = null;
async function fillApt(n) {
  const box = $('#sheet-body .apt');
  if (!box) return;
  try { await loadApts(); } catch (e) { box.innerHTML = `<p class="hint err">${esc(e.message)}</p>`; return; }
  if (currentNote() !== n) return;
  const m = matchComplex(n);
  if (!m) { box.innerHTML = '<p class="hint">이 근처에서 이름이 맞는 아파트 실거래를 못 찾았습니다 (수집 범위: 관악·동작·영등포·구로·광진·중랑·금천·노원·도봉·강북·은평·동대문·서초)</p>'; return; }
  const tr = aptTrades[m.i];
  const pa = pickArea(n, tr);
  // 이번에 열기 전까지 본 최신 거래일 — 그 뒤 거래는 NEW 표시. 열었으니 기준을 최신으로 올리고 지도 배지를 지움
  const seenBefore = seen[n.path] ?? tr[0][1];
  aptSel = { n, m, tr, area: pa.pick, areas: pa.areas.slice(0, 5), cnt: pa.cnt, seenBefore };
  if (n.isPlace && seen[n.path] !== tr[0][1]) {
    const wasNew = hasNewTrade(n);
    seen[n.path] = tr[0][1]; store.set('seen', seen);
    if (wasNew) { drawMarkers(); drawList(); }
  }
  renderApt();
}
function renderApt() {
  const { n, m, tr, area, areas, cnt, seenBefore } = aptSel;
  const box = $('#sheet-body .apt');
  if (!box) return;
  const c = m.c;
  const { rows, rents, last, chg, jeonse, ratio, gap } = aptStats(m.i, area);
  const y1 = rows.filter(t => t[1] >= ymdAgo(365)).map(t => t[3]);
  const naver = c[5] ? `https://new.land.naver.com/complexes/${c[5]}` : `https://m.land.naver.com/search/result/${encodeURIComponent(c[1])}`;
  box.innerHTML = `<div class="villa-top"><span class="k">아파트 실거래</span><b>${esc(c[1])}</b><span class="sub">${c[2] ? `${c[2]}년 준공 · ` : ''}${m.sim < 0.5 ? `이름이 달라 가장 가까운 단지(${Math.round(m.d * 1000)}m)로 연결 · ` : ''}최근 ${apts.months}개월 ${tr.length}건</span></div>
    <div class="vtools">${areas.map(a => `<button class="vchip${a === area ? ' on' : ''}" data-act="apt-area" data-v="${a}">${a}㎡ <span>${cnt[a]}</span></button>`).join('')}</div>
    <div class="stats">
      <div class="stat"><span class="k">최근 거래</span><b>${last ? won(last[3]) : '—'}</b></div>
      <div class="stat"><span class="k">1년 최고 / 최저</span><b>${y1.length ? `${won(Math.max(...y1))} / ${won(Math.min(...y1))}` : '—'}</b></div>
      <div class="stat"><span class="k">1년 전 대비</span><b class="${chg == null ? '' : chg >= 0 ? 'up' : 'down'}">${chg == null ? '—' : `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`}</b></div></div>
    <div class="stats jeonse">
      <div class="stat"><span class="k">전세 중위 (${rents.length}건)</span><b>${jeonse ? won(jeonse) : '—'}</b></div>
      <div class="stat"><span class="k">전세가율</span><b class="${ratio >= 70 ? 'up' : ''}">${ratio ? `${ratio.toFixed(0)}%` : '—'}</b></div>
      <div class="stat"><span class="k">갭 (매매−전세)</span><b>${gap != null ? won(gap) : '—'}</b></div></div>
    ${aptChart(rows, rents)}
    <div class="vlist">${rows.slice(0, 6).map(t => `<div class="vrow"><span class="d">${ymdOf(t[1]).slice(2).replace(/-/g, '.')}${t[1] > seenBefore ? '<i class="nb">NEW</i>' : ''}</span>
      <span class="t">${(t[2] / 10).toFixed(2)}㎡ · ${t[4] ?? '—'}층</span><span class="v">${won(t[3])}</span></div>`).join('')}
      ${rents.slice(0, 3).map(t => `<div class="vrow rent"><span class="d">${ymdOf(t[1]).slice(2).replace(/-/g, '.')}</span>
      <span class="t">전세 · ${(t[2] / 10).toFixed(2)}㎡</span><span class="v">${won(t[3])}</span></div>`).join('')}</div>
    <div class="row"><a class="btn sm" href="${naver}" target="_blank" rel="noopener">네이버 매물 보기</a>
      ${last && n.isPlace ? `<button class="btn sm" data-act="apt-save">노트 시세를 ${won(last[3])}(${area}㎡)로 갱신</button>` : ''}</div>
    <div class="sub">출처: 서울부동산정보광장 · ${esc(apts.updated)} 갱신 · 해제 거래 제외 · 전세는 최근 12개월 신규 계약(갱신 제외), 전세가율은 최근 6개월 중위끼리</div>`;
}
// 거래 점 + 월별 중위선 + 전세 점 (SVG)
function aptChart(rows, rents = []) {
  if (rows.length < 2) return '';
  const W = 320, H = 130, P = { l: 34, r: 6, t: 8, b: 18 };
  const pt = t => ({ x: new Date(ymdOf(t[1])).getTime(), y: t[3] / 10000 });
  const pts = rows.map(pt), rpts = rents.map(pt);
  const x0 = Date.now() - apts.months * 30.4 * 864e5, x1 = Date.now();
  const ys = [...pts, ...rpts].map(p => p.y);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 0.5) { y0 -= 0.25; y1 += 0.25; }
  const pad = (y1 - y0) * 0.1; y0 -= pad; y1 += pad;
  const X = x => P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r);
  const Y = y => P.t + (1 - (y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const months = {};
  for (const p of pts) { const k = new Date(p.x).toISOString().slice(0, 7); (months[k] ||= []).push(p.y); }
  const line = Object.keys(months).sort().map(k => [X(new Date(k + '-15').getTime()), Y(median(months[k]))]);
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  const years = []; for (let y = new Date(x0).getFullYear() + 1; y <= new Date(x1).getFullYear(); y++) years.push(y);
  return `<svg class="achart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="실거래가 추이">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${P.l - 4}" y="${Y(t) + 3}" class="ax" text-anchor="end">${t.toFixed(1)}</text>`).join('')}
    ${years.map(y => `<text x="${X(new Date(`${y}-01-01`).getTime())}" y="${H - 4}" class="ax" text-anchor="middle">${String(y).slice(2)}년</text>`).join('')}
    ${rpts.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2" class="rdot"/>`).join('')}
    ${pts.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.2" class="dot"/>`).join('')}
    ${line.length > 1 ? `<polyline points="${line.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" class="med"/>` : ''}
  </svg><div class="sub">파란 점: 매매 · 주황 선: 매매 월별 중위${rpts.length ? ' · 초록 점: 전세' : ''} (억)</div>`;
}

// ---------- 로드뷰 (카카오) ----------
function openRoadview(n) {
  const box = $('#roadview');
  const client = new K.RoadviewClient();
  setStatus('로드뷰 찾는 중…');
  client.getNearestPanoId(LL(n.ll), 120, panoId => {
    if (!panoId) { setStatus('근처(120m)에 로드뷰가 없습니다', true); return; }
    setStatus(null);
    box.hidden = false;
    $('#roadview-title').textContent = `${n.name} 로드뷰`;
    const rv = new K.Roadview($('#roadview-view'));
    rv.setPanoId(panoId, LL(n.ll));
  });
}
$('#roadview-close').onclick = () => { $('#roadview').hidden = true; $('#roadview-view').innerHTML = ''; };

// ---------- 주변 시설 (카카오 장소 검색: 역·학교·학원·어린이집·병원·마트·편의점) ----------
const fmtDist = m => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);
const walkMin = m => Math.max(1, Math.round(m * 1.3 / 67)); // 직선거리 × 1.3, 분속 67m
const nearCache = new Map();
function nearbyOf(n) {
  const svc = window.kakao?.maps?.services;
  if (!svc || !n.ll) return Promise.resolve(null);
  const key = String(n.ll);
  if (nearCache.has(key)) return nearCache.get(key);
  const ps = new svc.Places();
  const opt = radius => ({ location: LL(n.ll), radius, sort: svc.SortBy.DISTANCE });
  const cat = (code, radius) => new Promise(r => ps.categorySearch(code,
    (res, st, pg) => r(st === svc.Status.OK ? { list: res, total: pg.totalCount } : { list: [], total: 0 }), opt(radius)));
  const school = (q, re) => new Promise(r => ps.keywordSearch(q,
    (res, st) => r(st === svc.Status.OK ? res.find(p => re.test(p.place_name)) : null), { ...opt(2000), category_group_code: 'SC4' }));
  const p = Promise.all([cat('SW8', 1500), school('초등학교', /초등학교$/), school('중학교', /중학교$/), school('고등학교', /고등학교$/),
    cat('AC5', 500), cat('PS3', 500), cat('HP8', 500), cat('MT1', 2000), cat('CS2', 300)])
    .then(([sw, e, m, h, ac, kid, hp, mt, cs]) => ({ sw: sw.list.slice(0, 3), e, m, h, mt: mt.list[0], ac: ac.total, kid: kid.total, hp: hp.total, cs: cs.total }));
  p.catch(() => nearCache.delete(key));
  nearCache.set(key, p);
  return p;
}
async function fillNearby(n) {
  const box = $('#sheet-body .near');
  if (!box) return;
  const r = await nearbyOf(n).catch(() => null);
  if (currentNote() !== n) return;
  if (!r) { box.remove(); return; }
  const row = (p, label) => (p ? `<div class="nr"><span class="k">${label}</span><b>${esc(p.place_name)}</b><span class="d">${fmtDist(+p.distance)} · 도보 ${walkMin(+p.distance)}분</span></div>` : '');
  const st = r.sw[0];
  const cnt = x => (x >= 45 ? '45+' : x); // 카카오 검색은 45건까지만 셈
  box.innerHTML = `<div class="villa-top"><span class="k">주변</span><b>${st ? `${esc(st.place_name)} 도보 ${walkMin(+st.distance)}분` : '1.5km 안에 지하철역 없음'}</b></div>
    <div class="nlist">${r.sw.map(p => row(p, '🚇 역')).join('')}${row(r.e, '🏫 초등')}${row(r.m, '🏫 중학')}${row(r.h, '🏫 고교')}${row(r.mt, '🛒 마트')}</div>
    <div class="ncounts"><span>📚 학원 <b>${cnt(r.ac)}</b></span><span>🧸 어린이집 <b>${cnt(r.kid)}</b></span><span>🏥 병원 <b>${cnt(r.hp)}</b></span><span>🏪 편의점 <b>${cnt(r.cs)}</b> <small>(300m)</small></span></div>
    <div class="row"><button class="btn sm" data-act="near-map">지도에 표시</button></div>
    <div class="sub">카카오 장소 검색 · 학원·어린이집·병원은 500m 안 개수 · 거리는 직선, 도보 시간은 직선×1.3으로 어림</div>`;
}
const nearObjs = [];
async function showNearOnMap(n) {
  if (!map) return;
  clear(nearObjs);
  const r = await nearbyOf(n);
  if (!r) return;
  const items = [...r.sw.map(p => ['🚇', p]), ['🏫', r.e], ['🏫', r.m], ['🏫', r.h], ['🛒', r.mt]].filter(x => x[1]);
  for (const [ic, p] of items) nearObjs.push(overlay([+p.y, +p.x], `<div class="near-pin">${ic}<span>${esc(p.place_name)}</span></div>`, { z: 5 }));
  const sheetUp = window.innerWidth < 900;
  fitTo([n.ll, ...items.map(([, p]) => [+p.y, +p.x])], [70, sheetUp ? 30 : 470, sheetUp ? mapEl.clientHeight * 0.55 : 30, 30], 3);
}

// ---------- 거리 재기 · 지형도 (지도 오른쪽 아래 버튼) ----------
let measure = null; // { pts: [[lat,lng]], objs: [] }
function setMeasure(on) {
  if (measure) clear(measure.objs);
  measure = on ? { pts: [], objs: [] } : null;
  $('#mt-measure').classList.toggle('on', on);
  $('#measurebar').hidden = !on;
  document.body.classList.toggle('measuring', on);
  if (on) { togglePanel(null); drawMeasure(); }
}
function drawMeasure() {
  clear(measure.objs);
  const { pts, objs } = measure;
  let total = 0;
  if (pts.length > 1) {
    const line = new K.Polyline({ map, path: pts.map(LL), strokeColor: '#d93025', strokeWeight: 4, strokeOpacity: 0.9 });
    total = line.getLength();
    objs.push(line);
  }
  pts.forEach((ll, i) => objs.push(overlay(ll, `<div class="m-dot${i === pts.length - 1 ? ' last' : ''}"></div>`, { z: 6 })));
  if (pts.length > 1) objs.push(overlay(pts[pts.length - 1], `<div class="m-lbl">${fmtDist(total)}</div>`, { y: 1.6, z: 7 }));
  $('#measure-text').innerHTML = pts.length < 2 ? '지도를 눌러 지점을 찍으세요'
    : `<b>${fmtDist(total)}</b> · 도보 약 ${Math.max(1, Math.round(total / 67))}분 · 자전거 ${Math.max(1, Math.round(total / 250))}분`;
  $('#measure-undo').disabled = !pts.length;
}
$('#mt-measure').onclick = () => setMeasure(!measure);
$('#measure-close').onclick = () => setMeasure(false);
$('#measure-undo').onclick = () => { measure.pts.pop(); drawMeasure(); };

let terrainOn = store.get('terrainOn', false);
function setTerrain(on) {
  terrainOn = on;
  store.set('terrainOn', on);
  $('#mt-terrain').classList.toggle('on', on);
  if (!map) return;
  if (on) map.addOverlayMapTypeId(K.MapTypeId.TERRAIN);
  else map.removeOverlayMapTypeId(K.MapTypeId.TERRAIN);
}
$('#mt-terrain').onclick = () => { setTerrain(!terrainOn); setStatus(terrainOn ? '지형도 켬 — 언덕·경사가 음영으로 보여요' : '지형도 끔'); };
if (!map) $('#maptools').hidden = true;

// ---------- 단지 비교 (최대 4곳, 이 폰에 저장) ----------
let compareList = store.get('compare', []);
const COMPARE_MAX = 4;
function syncCompare() {
  compareList = compareList.filter(nm => !notes.length || byName.get(nm));
  store.set('compare', compareList);
  $('#comparechip').hidden = !compareList.length;
  $('#comparechip').textContent = `⚖️ 비교 ${compareList.length}`;
  placeAdd();
}
function toggleCompare(n) {
  if (compareList.includes(n.name)) compareList = compareList.filter(x => x !== n.name);
  else if (compareList.length >= COMPARE_MAX) { setStatus(`비교는 ${COMPARE_MAX}곳까지 — 왼쪽 아래 ⚖️에서 하나 빼고 담으세요`, true); return; }
  else { compareList.push(n.name); setStatus(`비교에 담음 (${compareList.length}곳) — 왼쪽 아래 ⚖️ 비교`); }
  syncCompare();
}
async function drawCompare() {
  const list = compareList.map(nm => byName.get(nm)).filter(Boolean);
  const body = $('#compare-body');
  if (!list.length) { body.innerHTML = '<p class="hint">장소 상세의 ⚖️ 비교 담기로 추가하세요 (최대 4곳)</p>'; return; }
  try { await loadApts(); } catch {}
  const cols = list.map(n => {
    const zs = n.ll ? zonesAt(n.ll) : [];
    const z = zs.find(x => x.properties.s && zoneState(x) === 'active') || zs.find(x => x.properties.s);
    const m = apts && matchComplex(n);
    const area = m && pickArea(n, aptTrades[m.i]).pick;
    return { n, z, m, area, s: m ? aptStats(m.i, area) : null };
  });
  // 줄마다 [제목, 값 HTML, 비교용 숫자, 유리한 쪽(low/high) — 초록 강조]
  const rows = [
    ['유형 · 지역', c => esc([c.n.fm.유형, c.n.region].filter(Boolean).join(' · '))],
    ['상태 · 평가', c => esc([c.n.fm.상태, c.n.rating].filter(Boolean).join(' · '))],
    ['노트 시세', c => (c.n.fm.시세 ? `${esc(c.n.fm.시세)}억${c.n.fm.시세평형 ? ` <small>${esc(c.n.fm.시세평형)}</small>` : ''}` : '—'), c => parseFloat(c.n.fm.시세), 'low'],
    ['최근 실거래', c => (c.s?.last ? `${won(c.s.last[3])} <small>${c.area}㎡ · ${ymdOf(c.s.last[1]).slice(2).replace(/-/g, '.')}</small>` : '—'), c => c.s?.last?.[3], 'low'],
    ['1년 전 대비', c => (c.s?.chg != null ? `<span class="${c.s.chg >= 0 ? 'up' : 'down'}">${c.s.chg >= 0 ? '▲' : '▼'} ${Math.abs(c.s.chg).toFixed(1)}%</span>` : '—')],
    ['전세 중위', c => (c.s?.jeonse ? won(c.s.jeonse) : '—')],
    ['전세가율', c => (c.s?.ratio ? `${c.s.ratio.toFixed(0)}%` : '—'), c => c.s?.ratio, 'high'],
    ['갭', c => (c.s?.gap != null ? won(c.s.gap) : '—'), c => c.s?.gap, 'low'],
    ['준공', c => esc(c.n.fm.준공 || c.m?.c[2] || '—'), c => +(c.n.fm.준공 || c.m?.c[2]) || null, 'low'],
    ['세대', c => (c.n.fm.세대 ? Number(c.n.fm.세대).toLocaleString() : '—'), c => +c.n.fm.세대 || null, 'high'],
    ['정비 단계', c => (c.z ? esc(zoneStage(c.z)) : '—')],
    ['가까운 역', c => `<span data-near="${esc(c.n.name)}" data-k="sw">…</span>`],
    ['초등학교', c => `<span data-near="${esc(c.n.name)}" data-k="e">…</span>`],
  ];
  const best = (num, dir) => {
    if (!num) return null;
    const v = cols.map(num).map(x => (Number.isFinite(x) ? x : null));
    const ok = v.filter(x => x != null);
    if (ok.length < 2) return null;
    const target = dir === 'low' ? Math.min(...ok) : Math.max(...ok);
    return v.map(x => x === target);
  };
  body.innerHTML = `<div class="cmp-wrap"><table class="cmp"><thead><tr><th></th>${cols.map(c => `<th><a href="#" data-note="${esc(c.n.name)}">${esc(c.n.name)}</a>
      <button class="cmp-x" data-cmp-del="${esc(c.n.name)}" title="빼기">✕</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([k, fn, num, dir]) => { const b = best(num, dir); return `<tr><th>${k}</th>${cols.map((c, i) => `<td${b?.[i] ? ' class="best"' : ''}>${fn(c)}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
    <p class="hint">초록 칸: 그 줄에서 유리한 쪽(시세·갭·준공은 낮을수록, 전세가율·세대는 높을수록). 실거래는 노트의 시세평형에 가장 가까운 평형 기준.</p>
    <div class="row"><button class="btn sm" data-cmp-clear>모두 비우기</button></div>`;
  for (const c of cols) nearbyOf(c.n).then(r => {
    const put = (k, html) => { const el = body.querySelector(`[data-near="${CSS.escape(c.n.name)}"][data-k="${k}"]`); if (el) el.innerHTML = html; };
    put('sw', r?.sw[0] ? `${esc(r.sw[0].place_name)} <small>도보 ${walkMin(+r.sw[0].distance)}분</small>` : '—');
    put('e', r?.e ? `${esc(r.e.place_name)} <small>${fmtDist(+r.e.distance)}</small>` : '—');
  }).catch(() => {});
}
$('#comparechip').onclick = () => { togglePanel('compare'); if (!$('#panel-compare').hidden) drawCompare(); };
$('#compare-body').onclick = e => {
  const del = e.target.closest('[data-cmp-del]');
  if (del) { compareList = compareList.filter(x => x !== del.dataset.cmpDel); syncCompare(); drawCompare(); return; }
  if (e.target.closest('[data-cmp-clear]')) { compareList = []; syncCompare(); togglePanel(null); return; }
  const a = e.target.closest('[data-note]');
  if (a) { e.preventDefault(); if (window.innerWidth < 900) togglePanel(null); nav(a.dataset.note); }
};

// ---------- 재개발·재건축 수익 계산기 ----------
// 권리가액 = 감정가 × 비례율, 프리미엄 = 매입가 − 권리가액, 분담금 = 조합원 분양가 − 권리가액(음수면 환급)
// 총 투자 = 매입가 + 분담금 + 기타 비용, 예상 차익 = 입주 시점 시세 − 총 투자. 입력은 장소별로 이 폰에 저장
const CALC_FIELDS = [
  ['buy', '매입가', '억', '빌라·아파트 사는 값'],
  ['appr', '예상 감정가', '억', '종전자산 평가액. 모르면 공시가격 × 1.3~1.5로 대략'],
  ['ratio', '비례율', '%', '조합 추정치. 모르면 100'],
  ['sale', '조합원 분양가', '억', '받을 평형(예: 84㎡)의 조합원 분양가'],
  ['etc', '기타 비용', '억', '취득세·중개·이주 기간 이자 등'],
  ['jeonse', '전세 보증금', '억', '전세 끼고 사면(토허 아닌 곳만) 초기 투자에서 뺌'],
  ['future', '입주 시 예상 시세', '억', '인근 신축 같은 평형 시세'],
];
function calcDefaults(n) {
  const body = n.body;
  const pick = re => { const m = body.match(re); return m ? parseFloat(m[1]) : ''; };
  return {
    ratio: pick(/비례율[^\d\n]{0,12}(\d{2,3}(?:\.\d+)?)\s*%/) || 100,
    sale: pick(/(?:조합원|권리자)\s*분양가[^\d\n]{0,20}(\d{1,2}(?:\.\d+)?)\s*억/),
  };
}
function toggleCalc(n) {
  const old = $('#sheet-body .calc');
  if (old) { old.remove(); return; }
  const saved = store.get(`calc:${n.path}`, null);
  const v = { ...calcDefaults(n), ...(saved || {}) };
  const html = `<div class="calc card"><div class="calc-top"><b>🧮 수익 계산</b><span class="sub">단위: 억 (비례율 %). 노트에서 비례율·조합원 분양가를 찾으면 미리 채움</span></div>
    <div class="calc-grid">${CALC_FIELDS.map(([k, label, unit, hint]) => `<label title="${esc(hint)}">${label}<span class="u">${unit}</span>
      <input name="${k}" inputmode="decimal" value="${esc(v[k] ?? '')}" placeholder="${esc(hint)}"></label>`).join('')}</div>
    <div class="calc-out"></div>
    <div class="row"><button class="btn sm" data-act="calc-memo">결과를 임장 메모로 저장</button></div></div>`;
  ($('#sheet-body .tiles') || $('#sheet-body .hero')).insertAdjacentHTML('afterend', html);
  const box = $('#sheet-body .calc');
  box.addEventListener('input', () => renderCalc(n));
  renderCalc(n);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function calcValues() {
  const box = $('#sheet-body .calc');
  const v = {};
  for (const [k] of CALC_FIELDS) { const x = parseFloat(box.querySelector(`[name=${k}]`).value); v[k] = Number.isFinite(x) ? x : null; }
  return v;
}
function calcResult(v) {
  if (v.buy == null) return null;
  const right = v.appr != null ? v.appr * (v.ratio ?? 100) / 100 : null;
  const premium = right != null ? v.buy - right : null;
  const share = right != null && v.sale != null ? v.sale - right : null;
  const total = v.buy + (share ?? 0) + (v.etc ?? 0);
  const cash = v.buy - (v.jeonse ?? 0) + (v.etc ?? 0);
  const gain = v.future != null && share != null ? v.future - total : null;
  return { right, premium, share, total, cash, gain, rate: gain != null ? gain / total * 100 : null };
}
const eok = x => (x == null ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(2).replace(/\.?0+$/, '')}억`);
function renderCalc(n) {
  const v = calcValues();
  store.set(`calc:${n.path}`, v);
  const r = calcResult(v);
  const line = (k, val, cls = '', note = '') => `<div class="cl ${cls}"><span>${k}</span><b>${val}</b>${note ? `<small>${note}</small>` : ''}</div>`;
  $('#sheet-body .calc-out').innerHTML = !r ? '<p class="hint">매입가부터 넣어 주세요</p>' : [
    line('권리가액', eok(r.right), '', '감정가 × 비례율'),
    line('프리미엄', eok(r.premium), r.premium > 0 ? 'warn' : '', '매입가 − 권리가액'),
    line('분담금', r.share == null ? '—' : r.share < 0 ? `${eok(-r.share)} 환급` : eok(r.share), '', '조합원 분양가 − 권리가액'),
    line('총 투자', eok(r.total), 'big', '매입가 + 분담금 + 기타'),
    line('초기 현금', eok(r.cash), '', v.jeonse ? '매입가 − 전세 + 기타' : '매입가 + 기타'),
    line('예상 차익', r.gain == null ? '—' : `${eok(r.gain)} (${r.rate.toFixed(0)}%)`, r.gain == null ? '' : r.gain >= 0 ? 'good' : 'bad', '입주 시 시세 − 총 투자'),
  ].join('') + '<p class="hint">추정치 계산일 뿐 — 실제 감정가·비례율·분양가는 관리처분 때 확정. 이주비 대출·재초환·양도세는 빠져 있음</p>';
}
async function saveCalcMemo(n) {
  const v = calcValues(), r = calcResult(v);
  if (!r) { setStatus('매입가부터 넣어 주세요', true); return; }
  const memo = `🧮 수익 계산: 매입 ${eok(v.buy)} · 감정 ${eok(v.appr)} · 비례율 ${v.ratio ?? 100}% · 조합원분양가 ${eok(v.sale)} → 권리가액 ${eok(r.right)}, 프리미엄 ${eok(r.premium)}, 분담금 ${eok(r.share)}, 총 투자 ${eok(r.total)}${r.gain != null ? `, 입주 시세 ${eok(v.future)} 기준 차익 ${eok(r.gain)}` : ''}`;
  if (await save(n, { type: 'memo', memo, stamp: `${today()} ${nowHM()}` }, '수익 계산', '임장 메모에 저장됨')) showNote(n.name, false);
}

// 노트 본문을 ## 단위 카드로. '출처'·'참고'는 접어 둠
function sectionize(md) {
  const kids = [...md.childNodes];
  md.textContent = '';
  let box = Object.assign(document.createElement('div'), { className: 'sec intro' });
  md.append(box);
  for (const el of kids) {
    if (el.nodeName === 'H2') {
      const title = el.textContent.trim();
      box = Object.assign(document.createElement('details'), { className: `sec${/임장 메모/.test(title) ? ' memo-sec' : ''}`, open: !/출처|참고|링크/.test(title) });
      box.append(Object.assign(document.createElement('summary'), { textContent: title }));
      md.append(box);
    } else box.append(el);
  }
  for (const s of md.querySelectorAll('.sec')) if (!s.textContent.replace(s.querySelector('summary')?.textContent || '', '').trim() && !s.querySelector('img')) s.remove();
}

function showNote(name, doFocus = true) {
  const n = byName.get(name);
  if (!n) { if (notes.length) setStatus(`노트 없음: ${name}`, true); return; }
  const f = n.fm;
  const day = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v) : '');
  const q = encodeURIComponent(n.name);
  const inZones = n.ll ? zonesAt(n.ll) : [];
  const stageZone = inZones.find(z => z.properties.s && zoneState(z) === 'active') || inZones.find(z => z.properties.s);
  // 본문 첫 줄 '# 이름 (별칭)'은 제목으로 올리고 본문에서는 뺀다
  let body = n.body, alias = '';
  const h1 = body.match(/^\s*#\s+(.+?)\s*\r?\n/);
  if (h1 && h1[1].startsWith(n.name)) { alias = h1[1].slice(n.name.length).trim().replace(/^\((.*)\)$/, '$1'); body = body.slice(h1[0].length); }
  const tile = (ic, label, attrs) => `<${attrs.href ? 'a' : 'button'} class="tile" ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}><span class="ic">${ic}</span><span>${label}</span></${attrs.href ? 'a' : 'button'}>`;
  const ext = href => ({ href, target: '_blank', rel: 'noopener' });
  const acts = [
    n.ll && tile('🚶', '도보 길찾기', { 'data-act': 'walk' }),
    n.ll && tile('🚇', '대중교통·차', ext(`https://map.kakao.com/link/to/${q},${n.ll[0]},${n.ll[1]}`)),
    n.ll && tile('🎯', '지도에서', { 'data-act': 'focus' }),
    n.ll && K && tile('🛣️', '로드뷰', { 'data-act': 'roadview' }),
    n.isPlace && /재개발|재건축/.test(f.유형 || '') && tile('🧮', '수익 계산', { 'data-act': 'calc' }),
    n.isPlace && tile('⚖️', compareList.includes(n.name) ? '비교에서 빼기' : '비교 담기', { 'data-act': 'compare' }),
    n.isPlace && tile('🗺️', '카카오맵', ext(`https://map.kakao.com/link/search/${encodeURIComponent(f.주소 ? String(f.주소).replace(/\s*\(.*\)$/, '') : n.name)}`)),
    n.isPlace && tile('🏠', '네이버부동산', ext(`https://m.land.naver.com/search/result/${q}`)),
    n.isPlace && (f.주소 || n.ll) && tile('📜', '토지이음', { ...ext(EUM_HOME), 'data-act': 'eum' }),
    n.isPlace && tile('📌', n.ll ? '위치 수정' : '위치 지정', { 'data-act': 'pick' }),
    n.isPlace && tile(todayList.includes(n.name) ? '✅' : '🚩', todayList.includes(n.name) ? '동선에서 빼기' : '오늘 동선', { 'data-act': 'today' }),
  ].filter(Boolean);
  const band = priceBand(f.시세);
  const stat = (k, v) => `<div class="stat"><span class="k">${k}</span><b>${v ? esc(v) : '—'}</b></div>`;
  $('#sheet-body').innerHTML = `
    <div class="hero">
      ${n.isPlace ? `<div class="hero-icon">${pinMarkup({ type: f.유형, color: pinColor(n) })}</div>` : ''}
      <div class="hero-text">
        <h2>${esc(n.name)}</h2>
        <div class="hero-sub">${esc([alias, n.isPlace ? f.유형 : '노트', n.region].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
    ${n.isPlace ? `<div class="pills">
      ${f.상태 ? `<span class="pill" style="--c:${STATUS_COLOR[f.상태] || '#80868b'}">${f.상태 === '다녀옴' ? '✓ ' : ''}${esc(f.상태)}</span>` : ''}
      <span class="pill" style="--c:${RATING_COLOR[n.rating] || RATING_COLOR.미평가}">${n.rating === '1순위' ? '★ ' : ''}${esc(n.rating)}</span>
      ${!n.ll ? '<span class="pill warn">좌표 없음</span>' : ''}${queue.some(o => o.path === n.path) ? '<span class="pill warn">저장 대기</span>' : ''}
      ${n.error ? '<span class="pill warn">frontmatter 오류</span>' : ''}</div>` : ''}
    ${n.isPlace ? `<div class="price card">
      <button class="edit-info" data-act="edit-info" title="시세·세대·준공·주소·유형 수정">✏️ 수정</button>
      <div class="price-main">${f.시세 ? `<b>${esc(f.시세)}</b><span class="unit">억</span>${f.시세평형 ? `<span class="py">${esc(f.시세평형)}</span>` : ''}` : '<span class="none">시세 정보 없음</span>'}
        <span class="band" style="--c:${PRICE_COLOR[band]}">${band}</span></div>
      <div class="stats">${stat('세대', f.세대 && `${Number(f.세대).toLocaleString()}세대`)}${stat('준공', f.준공 && `${f.준공}년`)}${stat(f.방문일 ? '방문' : '조사', day(f.방문일) || day(f.조사일))}</div>
    </div>` : ''}
    ${stageZone ? stageHtml(stageZone) : ''}
    ${n.isPlace && n.ll && (f.유형 === '재개발구역' || stageZone) ? '<div class="villa card"><p class="hint">빌라 실거래 불러오는 중…</p></div>' : ''}
    ${n.isPlace && n.ll && /아파트|재건축|도시형|미확인/.test(f.유형 || '') ? '<div class="apt card"><p class="hint">아파트 실거래 불러오는 중…</p></div>' : ''}
    ${n.isPlace && n.ll && K ? '<div class="near card"><p class="hint">주변 시설 찾는 중…</p></div>' : ''}
    ${f.주소 ? `<div class="addr card"><span class="ic">📍</span><span class="t">${esc(f.주소)}</span><button class="copy" data-act="copy-addr" title="주소 복사">복사</button></div>` : ''}
    ${inZones.length ? `<div class="zones-in">${inZones.map(z => `<div class="zp"><i style="background:${ZONE_COLOR[z.properties.k]}"></i>${esc(zoneLabel(z))}</div>`).join('')}</div>` : ''}
    ${acts.length ? `<div class="tiles">${acts.join('')}</div>` : ''}
    ${n.isPlace && !n.ll ? `<div class="cands"><button class="btn" data-act="cands">위치 후보 찾기</button></div>` : ''}
    ${n.isPlace ? editHtml(n) : ''}
    <div class="md">${renderMd(body, n.name)}</div>`;
  sectionize($('#sheet-body .md'));
  if (doFocus) $('#sheet-body').scrollTop = 0;
  $('#sheet-body').querySelectorAll('.md a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  $('#sheet').hidden = false;
  loadAtts();
  fillVillas(n);
  fillApt(n);
  fillNearby(n);
  if (n.isPlace) pnuOf(n).then(pnu => {
    const a = $('#sheet-body [data-act="eum"]');
    if (a && pnu && currentNote() === n) { a.href = EUM_LAND(pnu); a.title = `토지이용계획 (PNU ${pnu})`; }
  });
  if (n.ll && doFocus) focus(n.ll);
}

// ---------- 토지이음: 노트 주소(없으면 좌표)의 지번 → PNU 19자리 → 그 필지의 토지이용계획 화면 ----------
// PNU = 법정동코드 10 + 산(1 일반, 2 산) + 본번 4 + 부번 4. 못 만들면 토지이음 첫 화면.
const EUM_HOME = 'https://www.eum.go.kr/web/am/amMain.jsp';
const EUM_LAND = pnu => `https://www.eum.go.kr/web/ar/lu/luLandDet.jsp?isNoScr=script&mode=search&pnu=${pnu}`;
const makePnu = (bcode, mountain, main, sub) => (/^\d{10}$/.test(bcode || '') && +main > 0
  ? `${bcode}${mountain === 'Y' ? 2 : 1}${String(+main).padStart(4, '0')}${String(+sub || 0).padStart(4, '0')}` : null);
const pnuCache = new Map();
async function pnuOf(n) {
  const key = `${n.path}|${n.fm.주소 || ''}|${n.ll || ''}`;
  if (pnuCache.has(key)) return pnuCache.get(key);
  const svc = window.kakao?.maps?.services;
  if (!svc) return null;
  const geo = new svc.Geocoder();
  const call = (fn, ...args) => new Promise(r => fn.call(geo, ...args, (res, st) => r(st === svc.Status.OK ? res : [])));
  let pnu = null;
  // 주소: 괄호 안 지번·'일대' 같은 꼬리를 떼고 검색. "(자양동 516)"처럼 괄호에 지번만 있으면 그것도 시도
  const raw = String(n.fm.주소 || '');
  const tries = [raw.replace(/\(.*?\)/g, '').replace(/\s*(일대|일원)\s*$/, '').trim()];
  const inParen = raw.match(/\(([^)]*\d[^)]*)\)/)?.[1];
  if (inParen) tries.push(`${raw.split(/\s+/)[0]} ${inParen.replace(/\s*(일대|일원).*$/, '')}`);
  for (const q of tries.filter(Boolean)) {
    const j = (await call(geo.addressSearch, q))[0]?.address;
    if (j && (pnu = makePnu(j.b_code, j.mountain_yn, j.main_address_no, j.sub_address_no))) break;
  }
  if (!pnu && n.ll) {
    const j = (await call(geo.coord2Address, n.ll[1], n.ll[0]))[0]?.address;
    const b = (await call(geo.coord2RegionCode, n.ll[1], n.ll[0])).find(r => r.region_type === 'B');
    if (j && b) pnu = makePnu(b.code, j.mountain_yn, j.main_address_no, j.sub_address_no);
  }
  pnuCache.set(key, pnu);
  return pnu;
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
// 정보 수정 저장: 바뀐 칸만 frontmatter에 반영. 시세를 바꾸면 조사일도 오늘로
$('#sheet-body').addEventListener('submit', async e => {
  if (!e.target.matches('.info-form')) return;
  e.preventDefault();
  const n = currentNote();
  if (!n) return;
  const el = e.target.elements, fields = {};
  const old = k => (n.fm[k] instanceof Date ? n.fm[k].toISOString().slice(0, 10) : String(n.fm[k] ?? ''));
  for (const k of ['시세', '시세평형', '세대', '준공', '주소', '유형']) {
    let val = el[k].value.trim();
    if (k === '시세') val = val.replace(/억|,|\s/g, '');
    if (k === '세대') val = val.replace(/[^\d]/g, '');
    if (val === old(k)) continue;
    if (k === '시세' && val && !Number.isFinite(+val)) { setStatus('시세는 숫자(억)로 적어 주세요', true); return; }
    fields[k] = /[:#[\]{}]|^[\s'"]/.test(val) ? JSON.stringify(val) : val; // YAML이 깨지지 않게
  }
  if (!Object.keys(fields).length) { showNote(n.name, false); return; }
  if ('시세' in fields) fields.조사일 = today();
  if (await save(n, { type: 'fields', fields }, `정보 수정 (${Object.keys(fields).filter(k => k !== '조사일').join('·')})`, '저장됨')) showNote(n.name, false);
});

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
  if (act === 'walk') walkTo(n);
  if (act === 'roadview') openRoadview(n);
  if (act === 'near-map') showNearOnMap(n);
  if (act === 'compare') { toggleCompare(n); showNote(n.name, false); }
  if (act === 'apt-area') { aptSel.area = +e.target.closest('[data-v]').dataset.v; renderApt(); }
  if (act === 'apt-save') {
    const last = aptSel.tr.find(t => areaOf(t) === aptSel.area);
    const fields = { 시세: +(last[3] / 10000).toFixed(2), 시세평형: `${aptSel.area}㎡`, 조사일: today() };
    if (await save(n, { type: 'fields', fields }, `시세 갱신 (실거래 ${ymdOf(last[1])})`, '시세 갱신됨')) showNote(n.name, false);
  }
  if (act === 'calc') toggleCalc(n);
  if (act === 'calc-memo') saveCalcMemo(n);
  if (act === 'today') { toggleToday(n); showNote(n.name, false); }
  if (act === 'villa-more') renderVillaList(Infinity);
  if (act === 'villa-band') { villaBand = e.target.closest('[data-v]').dataset.v; store.set('villaBand', villaBand); renderVillaList(); }
  if (act === 'villa-sort') { villaSort = villaSort === '대지평' ? '최신' : '대지평'; store.set('villaSort', villaSort); renderVillaList(); }
  if (act === 'villa-show') {
    const t = villaRows[e.target.closest('[data-i]').dataset.i];
    showCandidate({ ll: [t[1], t[2]] });
  }
  if (act === 'edit-cancel') showNote(n.name, false);
  if (act === 'edit-info') {
    const f = n.fm, v = x => esc(x instanceof Date ? x.toISOString().slice(0, 10) : x ?? '');
    $('#sheet-body .price').innerHTML = `<form class="info-form">
      <div class="grid2">
        <label>시세 (억)<input name="시세" inputmode="decimal" value="${v(f.시세)}" placeholder="예: 12.5"></label>
        <label>평형<input name="시세평형" value="${v(f.시세평형)}" placeholder="84㎡"></label>
        <label>세대<input name="세대" inputmode="numeric" value="${v(f.세대)}"></label>
        <label>준공<input name="준공" inputmode="numeric" value="${v(f.준공)}" placeholder="연도"></label>
      </div>
      <label>주소<input name="주소" value="${v(f.주소)}"></label>
      <label>유형<select name="유형">${FILTERS.유형.map(t => `<option${t === f.유형 ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="row"><button type="submit" class="btn primary">저장</button><button type="button" class="btn" data-act="edit-cancel">취소</button></div>
    </form>`;
    $('#sheet-body .info-form input').focus();
  }
  if (act === 'copy-addr') {
    try { await navigator.clipboard.writeText(String(n.fm.주소)); setStatus('주소 복사됨'); } catch { setStatus('복사 실패 — 주소를 길게 눌러 복사하세요', true); }
  }
  if (act === 'cands') findCandidates(n);
  if (act === 'cand-show') showCandidate(cands[e.target.dataset.i]);
  if (act === 'cand-use') {
    const x = cands[e.target.dataset.i];
    clearCand();
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
    const k = segBtn.closest('.seg').dataset.field;
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
  if (n.isNew) { setNewLL(ll); togglePanel('new', true); return; } // 새 장소 추가 중 "지도에서 찍기"
  if (await save(n, { type: 'fields', fields: { location: fmtLL(ll) } }, '위치', '위치 저장됨')) showNote(n.name);
}
$('#pick-cancel').onclick = () => { const p = picking; endPick(); if (p?.isNew) togglePanel('new', true); };
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
// 카카오맵은 길게 누르기 이벤트가 없어서 직접 잰다. PC는 우클릭(contextmenu).
let longPressAt = 0;
function longPress(clientX, clientY) {
  if (measure || Date.now() - longPressAt < 1000) return;
  longPressAt = Date.now();
  const r = mapEl.getBoundingClientRect();
  openNew(llOf(map.getProjection().coordsFromContainerPoint(new K.Point(clientX - r.left, clientY - r.top))));
}
if (map) {
  let lp = null;
  const cancel = () => { clearTimeout(lp?.timer); lp = null; };
  mapEl.addEventListener('touchstart', e => {
    cancel();
    if (e.touches.length !== 1 || e.target.closest('.pin-wrap, .zpop')) return;
    const { clientX: x, clientY: y } = e.touches[0];
    lp = { x, y, timer: setTimeout(() => { lp = null; longPress(x, y); }, 600) };
  }, { passive: true });
  mapEl.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (lp && (e.touches.length !== 1 || Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 10)) cancel();
  }, { passive: true });
  mapEl.addEventListener('touchend', cancel);
  mapEl.addEventListener('touchcancel', cancel);
  mapEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!e.target.closest('.pin-wrap, .zpop')) longPress(e.clientX, e.clientY);
  });
}
// 새 장소: ＋ 버튼(검색·지도에서 찍기·현재 위치) 또는 지도 길게 누르기
function openNew(ll = null) {
  if (picking) return;
  const f = $('#new-form');
  f.reset();
  newLL = null;
  $('#new-q').value = '';
  $('#new-results').innerHTML = '';
  const cur = currentNote();
  f.elements.region.value = cur?.region || [...filters.지역][0] || '';
  $('#region-list').innerHTML = FILTERS.지역.map(r => `<option value="${esc(r)}">`).join('');
  togglePanel('new', true);
  if (ll) setNewLL(ll); else { syncNewLL(); $('#new-q').focus(); }
}
let newObjs = [];
function syncNewLL() {
  $('#new-ll').textContent = newLL ? `위치 ${fmtLL(newLL)}` : '위치 미지정 — 검색에서 고르거나 "지도에서 찍기"·"현재 위치" (비워 두고 나중에 지정해도 됨)';
  clear(newObjs);
  if (newLL && map) newObjs.push(overlay(newLL, '<div class="cand-pin"></div>', { z: 15 }));
}
// 위치가 정해지면: 미리보기 핀, 가장 가까운 기존 지역(3km 안), 주소가 비어 있으면 그 자리 주소
async function setNewLL(ll, { addr } = {}) {
  newLL = ll;
  syncNewLL();
  if (map) { if (map.getLevel() > 4) map.setLevel(4); focusNew(ll); }
  const f = $('#new-form').elements;
  const near = FILTERS.지역.map(r => [r, regionCenter(r)]).filter(([, c]) => c).map(([r, c]) => [r, distKm(ll, c)]).sort((a, b) => a[1] - b[1])[0];
  if (near && near[1] < 3) f.region.value = near[0];
  if (addr) f.addr.value = addr;
  else if (!f.addr.value && window.kakao?.maps?.services) {
    const svc = kakao.maps.services;
    new svc.Geocoder().coord2Address(ll[1], ll[0], (res, st) => {
      if (st !== svc.Status.OK || f.addr.value || newLL !== ll) return;
      const a = res[0];
      f.addr.value = a.road_address ? `${a.road_address.address_name.replace(/^서울(특별시)?\s*/, '')} (${a.address.address_name.split(' ').slice(-2).join(' ')})`
        : a.address.address_name.replace(/^서울(특별시)?\s*/, '');
    });
  }
}
// 패널(왼쪽)·위쪽 바에 가리지 않게 살짝 비켜서 보여줌
function focusNew(ll) {
  const wide = window.innerWidth >= 900;
  const proj = map.getProjection(), p = proj.containerPointFromCoords(LL(ll));
  map.panTo(proj.coordsFromContainerPoint(new K.Point(p.x - (wide ? 190 : 0), p.y - (wide ? 0 : -mapEl.clientHeight * 0.18))));
}

// 검색: 카카오 장소(키워드) + 주소. 결과를 고르면 이름·주소·유형·위치를 채운다
let newHits = [];
async function searchNew() {
  const q = $('#new-q').value.trim();
  const box = $('#new-results');
  if (!q) return;
  const svc = window.kakao?.maps?.services;
  if (!svc) { box.innerHTML = '<p class="hint err">지도(카카오)가 없어 검색할 수 없습니다 — 직접 입력하세요</p>'; return; }
  box.innerHTML = '<p class="hint">찾는 중…</p>';
  const call = (fn, self, ...a) => new Promise(r => fn.call(self, ...a, (res, st) => r(st === svc.Status.OK ? res : [])));
  const places = new svc.Places(), geo = new svc.Geocoder();
  const [kw, ad] = await Promise.all([call(places.keywordSearch, places, q), call(geo.addressSearch, geo, q)]);
  const short = s => String(s || '').replace(/^서울(특별시)?\s*/, '');
  newHits = [
    ...ad.slice(0, 3).map(a => ({ name: '', addr: short(a.road_address?.address_name ? `${a.road_address.address_name} (${a.address?.address_name.split(' ').slice(-2).join(' ')})` : a.address_name),
      ll: [+a.y, +a.x], cat: '주소', label: short(a.address_name) })),
    ...kw.slice(0, 10).map(p => ({ name: p.place_name, addr: short(p.road_address_name ? `${p.road_address_name} (${p.address_name.split(' ').slice(-2).join(' ')})` : p.address_name),
      ll: [+p.y, +p.x], cat: p.category_name.split(' > ').slice(-1)[0] || '', label: p.place_name, catFull: p.category_name })),
  ];
  box.innerHTML = newHits.length ? newHits.map((h, i) => `<button type="button" class="hit" data-i="${i}"><b>${esc(h.label)}</b>
      <span class="sub">${esc(h.cat)} · ${esc(h.addr)}</span>${byName.has(h.name) ? '<span class="tag">이미 있음</span>' : ''}</button>`).join('')
    : '<p class="hint">결과 없음 — 이름을 직접 쓰고 "지도에서 찍기"로 위치를 정하세요</p>';
}
const guessType = h => /재건축/.test(h.name) ? '재건축' : /구역|재개발|뉴타운|촉진/.test(h.name) ? '재개발구역'
  : /도시형/.test(h.name + h.catFull) ? '도시형생활주택' : /아파트/.test(h.catFull || '') ? '아파트' : null;
$('#new-search').onclick = searchNew;
$('#new-q').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); searchNew(); } };
$('#new-results').onclick = e => {
  const b = e.target.closest('.hit'); if (!b) return;
  const h = newHits[b.dataset.i], f = $('#new-form').elements;
  if (h.name) f.name.value = h.name.replace(/아파트$/, '').trim() || h.name;
  const t = guessType(h); if (t) f.type.value = t;
  f.addr.value = '';
  setNewLL(h.ll, { addr: h.addr });
  $('#new-results').querySelectorAll('.hit').forEach(x => x.classList.toggle('on', x === b));
};
$('#new-mappick').onclick = () => {
  togglePanel(null);
  picking = { isNew: true };
  $('#pick-text').textContent = '새 장소: 지도에서 위치를 누르세요';
  $('#pickbar').hidden = false;
  document.body.classList.add('picking');
};
$('#new-here').onclick = async () => {
  try { setStatus('위치 찾는 중…'); const ll = await myPosition(); setStatus(null); $('#new-form').elements.addr.value = ''; setNewLL(ll); }
  catch (e) { setStatus(e.message, true); }
};
$('#btn-add').onclick = () => openNew();
$('#new-cancel').onclick = () => { clear(newObjs); togglePanel(null); };
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
    clear(newObjs);
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
$('#btn-locate').onclick = () => {
  if (!map) return;
  setStatus('위치 찾는 중…');
  navigator.geolocation.getCurrentPosition(p => {
    setStatus(null);
    const ll = [p.coords.latitude, p.coords.longitude];
    meMarker ??= overlay(ll, '<div class="me"></div>', { z: 20 });
    meMarker.setPosition(LL(ll));
    if (map.getLevel() > 4) map.setLevel(4);
    map.panTo(LL(ll));
  }, err => setStatus(`위치 실패: ${err.message}`, true), { enableHighAccuracy: true, timeout: 15000 });
};

// ---------- 도보 길찾기 (내 위치 → 장소, OSM 도보 경로 routing.openstreetmap.de · 키 없음) ----------
let walkObjs = [];
function clearWalk() { clear(walkObjs); $('#walkbar').hidden = true; }
$('#walk-close').onclick = clearWalk;

function myPosition() {
  return new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(
    p => ok([p.coords.latitude, p.coords.longitude]),
    e => fail(new Error(`위치 실패: ${e.message}`)), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }));
}

async function walkTo(n) {
  if (!map) { setStatus('지도가 없어 경로를 그릴 수 없습니다', true); return; }
  try {
    setStatus('내 위치 찾는 중…');
    const from = await myPosition();
    meMarker ??= overlay(from, '<div class="me"></div>', { z: 20 });
    meMarker.setPosition(LL(from));
    setStatus('경로 찾는 중…');
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from[1]},${from[0]};${n.ll[1]},${n.ll[0]}?overview=full&geometries=geojson`;
    const r = await net(url);
    const j = r.ok ? await r.json() : null;
    if (j?.code !== 'Ok' || !j.routes?.length) throw new Error('도보 경로를 못 찾았습니다');
    const rt = j.routes[0];
    const path = rt.geometry.coordinates.map(([x, y]) => [y, x]);
    clear(walkObjs);
    walkObjs.push(new K.Polyline({ map, path: path.map(LL), strokeColor: '#1a73e8', strokeWeight: 6, strokeOpacity: 0.85 }));
    const min = Math.round(rt.distance / 1000 / 4.2 * 60); // 보행 시속 약 4.2km
    const dist = rt.distance < 1000 ? `${Math.round(rt.distance)}m` : `${(rt.distance / 1000).toFixed(1)}km`;
    $('#walk-text').textContent = `${n.name}까지 도보 ${dist} · 약 ${min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간 ${min % 60}분`}`;
    $('#walkbar').hidden = false;
    setStatus(null);
    const sheetOpen = !$('#sheet').hidden, wide = window.innerWidth >= 900;
    fitTo([from, n.ll, ...path], [110, 40, sheetOpen && !wide ? mapEl.clientHeight * 0.55 : 40, sheetOpen && wide ? 470 : 40], 3);
  } catch (e) {
    setStatus(e.offline ? '오프라인 — 도보 길찾기는 연결이 필요합니다' : e.message, true);
  }
}

// ---------- 설정 ----------
const form = $('#settings-form');
function fillSettings() { for (const k of CFG_KEYS) form.elements[k].value = cfg[k]; }
form.onsubmit = e => {
  e.preventDefault();
  const oldKakao = cfg.kakao;
  for (const k of CFG_KEYS) cfg[k] = form.elements[k].value.trim();
  cfg.repo ||= 'YeonkyunLee/imjang'; cfg.branch ||= 'main';
  store.set('cfg', cfg);
  if (cfg.kakao !== oldKakao) { location.reload(); return; } // 지도 SDK는 시작할 때 그 키로 불러옴
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
// 시작 화면(index.html #splash): 노트를 처음 그렸을 때(또는 불러오기가 끝나거나 실패했을 때) 사라짐. 너무 깜빡이지 않게 최소 1초
function hideSplash() {
  const s = $('#splash');
  if (!s || s.classList.contains('out')) return;
  setTimeout(() => { s.classList.add('out'); setTimeout(() => s.remove(), 500); }, Math.max(0, 1000 - (Date.now() - (window.__splashAt || 0))));
}

function render(info, doRoute = true) {
  hideSplash();
  if (info) loadInfo = info;
  notes = Object.entries(displayData()).map(([p, v]) => parseNote(p, v.text));
  byName.clear();
  for (const n of notes) byName.set(n.name, n);
  routes = parseRoutes();
  syncToday();
  syncCompare();
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
  } finally {
    hideSplash();
    // 지도 라벨에 최근 실거래가를 붙이려고 조용히 받아 둠 (서비스워커가 캐시)
    setTimeout(() => loadApts().then(() => { matchCache.clear(); baselineSeen(); drawMarkers(); drawList(); }).catch(() => {}), 1500);
  }
}

// ---------- 홈 화면 설치 ----------
// Chrome·삼성 인터넷·Edge는 beforeinstallprompt로 설치 창을 직접 띄우고, 안 되는 브라우저(아이폰 등)는 방법을 보여준다.
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvt = null;
const setBar = hidden => { $('#installbar').hidden = hidden; document.body.classList.toggle('has-installbar', !hidden); placeAdd(); };
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
load().then(() => {
  if (imported) setStatus(`토큰 저장됨${cfg.who ? ` (${cfg.who})` : ''} — 메뉴에서 "홈 화면에 추가"를 해 두세요`);
  else if (!map) setStatus('카카오 지도를 못 불러옴 (연결·카카오 키 확인) — 목록(☰)과 상세는 사용 가능', true);
});
if (zonesOn) setZones(true);
if (districtOn) setDistrict(true);
if (terrainOn) setTerrain(true);
syncCompare();
