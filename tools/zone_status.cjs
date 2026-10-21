// 정비사업 정보몽땅 사업장 목록(진행단계·대표지번) → 지오코딩 → zones.json 각 구역에 단계(s)·사업장명(p) 붙이기
//
//   node tools/zone_status.cjs            (Edge 필요, 카카오 JS 키는 index.html 기본값 사용)
//
// 카카오 JS 키는 등록 도메인에서만 동작하므로, 헤드리스 Edge로 배포 사이트(github.io)를 열고 그 안에서 지오코딩한다.
// 사업장 대표지번이 구역 안에 있으면 그 구역의 단계로 본다. 여러 개면 구역 이름과 번호가 맞는 것, 다음으로 진행 중인 것.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIST = 'https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do?cpage=1&pageSize=3000';
const SITE = 'https://yeonkyunlee.github.io/imjang-map/manifest.webmanifest';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const unesc = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
function parseList(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const td = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(x => unesc(x.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (td.length >= 6 && /^\d+$/.test(td[0])) rows.push({ gu: td[1], kind: td[2], name: td[3], jibun: td[4], stage: td[5] });
  }
  return rows;
}

function inZone(f, lat, lng) {
  let inside = false;
  for (const ring of f.geometry.coordinates) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
const DONE = /준공|이전고시|해산|청산/;
const num = s => (String(s).replace(/\s/g, '').match(/[가-힣]+(\d+(?:-\d+)?)/) || [])[1];

(async () => {
  const key = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/var key = '([0-9a-f]{32})'/)[1];
  const rows = parseList(await (await fetch(LIST)).text());
  console.log('사업장', rows.length);

  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9346',
    `--user-data-dir=${path.join(require('os').tmpdir(), 'zone-status-' + Date.now())}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:9346/json')).json()).find(t => t.type === 'page'); } catch {} }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0; const pending = new Map();
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    await send('Page.enable');
    await send('Page.navigate', { url: SITE });
    await sleep(2500);
    const ok = await ev(`new Promise(ok => { const s = document.createElement('script');
      s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&libraries=services&autoload=false';
      s.onload = () => kakao.maps.load(() => ok('ok')); s.onerror = () => ok('SDK 실패'); document.documentElement.append(s); })`);
    if (ok !== 'ok') throw new Error(ok);
    const pts = await ev(`(async () => {
      const svc = kakao.maps.services, geo = new svc.Geocoder();
      const rows = ${JSON.stringify(rows.map(r => `서울 ${r.gu} ${r.jibun}`))};
      const out = [];
      const one = q => new Promise(r => geo.addressSearch(q, (res, st) => r(st === svc.Status.OK ? [+res[0].y, +res[0].x] : null)));
      // 대표지번이 본번만이고 실제로는 부번 필지만 있으면(예: 808 → 808-1) 못 찾으므로 -1, -2도 시도
      for (const q of rows) out.push(await one(q) || (/-/.test(q) ? null : (await one(q + '-1')) || (await one(q + '-2'))));
      return out;
    })()`);
    rows.forEach((r, i) => (r.ll = pts[i]));
  } finally { ws?.close(); edge.kill(); }
  console.log('지오코딩 성공', rows.filter(r => r.ll).length);
  if (process.env.ZS_DUMP) fs.writeFileSync(process.env.ZS_DUMP, JSON.stringify(rows));

  const zf = path.join(ROOT, 'zones.json');
  const z = JSON.parse(fs.readFileSync(zf, 'utf8'));
  let tagged = 0, byName = 0;
  // 구역 종류와 사업 구분이 맞는 것만 (재개발 구역 안의 가로주택 사업이 구역 단계를 정하지 않게)
  const compat = (k, kind) => k === '재건축' ? /재건축/.test(kind) && !/소규모/.test(kind)
    : k === '재개발' ? /재개발/.test(kind) && !/소규모/.test(kind) : k === '소규모' ? /가로|소규모/.test(kind) : true;
  const nameKey = s => (String(s).replace(/\(.*?\)/g, '').replace(/\s|제(?=\d)/g, '').match(/([가-힣]+?)(\d+(?:-\d+)?)/) || []).slice(1).join('');
  for (const f of z.features) {
    delete f.properties.s; delete f.properties.p;
    if (f.properties.k === '촉진지구' || f.properties.k === '존치') continue; // 지구 전체는 단계가 하나가 아님
    const hits = rows.filter(r => r.ll && compat(f.properties.k, r.kind) && inZone(f, r.ll[0], r.ll[1]));
    if (!hits.length) continue;
    const zn = num(f.properties.n);
    const pick = hits.find(r => zn && num(r.name) === zn && !DONE.test(r.stage)) || hits.find(r => zn && num(r.name) === zn)
      || hits.find(r => !DONE.test(r.stage)) || hits[0];
    f.properties.s = pick.stage || '단계 미상';
    f.properties.p = pick.name;
    tagged++;
  }
  // 위치로 못 붙인 구역: 같은 이름(동+번호) 사업장으로.
  //  - 위치가 있는 사업장: 대표지번이 경계 밖에 살짝 걸친 경우 — 1.2km 안이고 같은 이름 구역 중 가장 가까울 때만
  //  - 위치가 없는 사업장(주로 이전고시 후 옛 지번이 없어진 완료 사업): 같은 이름에 완료·진행이 섞이지 않을 때만
  const cen = f => { const r = f.geometry.coordinates[0]; return [r.reduce((s, p) => s + p[1], 0) / r.length, r.reduce((s, p) => s + p[0], 0) / r.length]; };
  const km = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 88.2);
  const named = z.features.filter(f => f.properties.k !== '촉진지구' && f.properties.k !== '존치' && nameKey(f.properties.n));
  for (const f of named) {
    if (f.properties.s) continue;
    const k = nameKey(f.properties.n);
    const same = rows.filter(r => nameKey(r.name) === k && compat(f.properties.k, r.kind));
    const near = same.filter(r => r.ll && km(r.ll, cen(f)) < 1.2 &&
      named.filter(g => nameKey(g.properties.n) === k).every(g => km(r.ll, cen(f)) <= km(r.ll, cen(g))));
    const lost = same.filter(r => !r.ll);
    const pick = near.find(r => !DONE.test(r.stage)) || near[0]
      || (lost.length && new Set(same.map(r => DONE.test(r.stage))).size === 1 ? lost[0] : null);
    if (!pick) continue;
    f.properties.s = pick.stage || '단계 미상';
    f.properties.p = pick.name;
    byName++;
  }
  z.status = `정비사업 정보몽땅 ${new Date().toLocaleDateString('sv-SE')}`;
  fs.writeFileSync(zf, JSON.stringify(z));
  console.log('단계 붙은 구역: 위치', tagged, '+ 이름', byName, '/ 완료', z.features.filter(f => DONE.test(f.properties.s || '')).length);
})().catch(e => { console.error(e); process.exit(1); });
