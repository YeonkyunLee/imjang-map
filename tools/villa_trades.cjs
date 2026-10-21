// 정비구역이 있는 동의 빌라(연립·다세대)·단독/다가구 실거래 → villas.json
//
//   node tools/villa_trades.cjs        (Edge 또는 BROWSER=크롬 경로. GitHub Actions가 매일 실행)
//
// 자료: 서울부동산정보광장(land.seoul.go.kr) 실거래 조회 — 키 불필요.
//  - 빌라: 기간 조회(해제 여부 포함) + 분기 조회(대지권면적)를 필지번호(PNU)·전용면적으로 합침. 해제된 거래는 뺌
//  - 단독/다가구: 지번이 공개되지 않아 동 단위로만 (도로명·토지면적·금액)
//  - 좌표: 카카오 지오코더(배포 사이트에서 JS 키) — tools/pnucache.json에 쌓아 새 필지만 조회
// 대상 동: 진행 중인 정비구역(zones.json, 단계 있음·완료 아님) 중심점이 속한 법정동 ∩ TARGET_SGG
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://land.seoul.go.kr/land';
const SITE = 'https://yeonkyunlee.github.io/imjang-map/manifest.webmanifest';
const BROWSER = process.env.BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CACHE = path.join(__dirname, 'pnucache.json');
const OUT = path.join(ROOT, 'villas.json');
const MONTHS = 24;
// 관심 자치구 (임장 지역이 있는 곳)
const TARGET_SGG = { 11620: '관악구', 11590: '동작구', 11560: '영등포구', 11530: '구로구', 11215: '광진구', 11260: '중랑구', 11650: '서초구', 11545: '금천구' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(url, body, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries - 1) throw new Error(`${url} 실패: ${e.message}`);
      await sleep(1500 * (i + 1));
    }
  }
}

// <tr> → 칸들, 칸 안의 <br>로 나뉜 값들
const unesc = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const cellVals = td => td.replace(/^<td[^>]*>|<\/td>$/g, '').split(/<br\s*\/?>/i).map(x => unesc(x.replace(/<[^>]+>/g, '')).trim());
function rows(html) {
  return (html.match(/<tr[\s\S]*?<\/tr>/g) || []).map(tr => ({
    pnu: (tr.match(/landCd='(\d{19})'/) || [])[1] || null,
    cells: (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cellVals),
  }));
}
const ymd = s => (/^\d{2}\.\d{2}\.\d{2}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(3, 5)}-${s.slice(6, 8)}` : null);
const num = s => parseFloat(String(s).replace(/,/g, '')) || null;

function quarters(from, to) {
  const out = [];
  let y = from.getFullYear(), q = Math.floor(from.getMonth() / 3);
  while (y < to.getFullYear() || (y === to.getFullYear() && q <= Math.floor(to.getMonth() / 3))) {
    const m0 = q * 3 + 1;
    out.push([`${y}${String(m0).padStart(2, '0')}01`, `${y}${String(m0 + 2).padStart(2, '0')}31`]);
    if (++q > 3) { q = 0; y++; }
  }
  return out;
}

async function withKakao(fn) {
  const key = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/var key = '([0-9a-f]{32})'/)[1];
  const port = 9300 + Math.floor(Math.random() * 500);
  const edge = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'villa-' + Date.now())}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 120 && !target; i++) {
      await sleep(250);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url === 'about:blank'); } catch {}
    }
    if (!target) throw new Error('브라우저를 못 띄움');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => (ws.onopen = r));
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
    return await fn(ev);
  } finally { ws?.close(); edge.kill(); }
}

(async () => {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  cache.pnu ||= {}; cache.zone ||= {};
  const DONE = /준공|이전고시|해산|청산/;
  const z = JSON.parse(fs.readFileSync(path.join(ROOT, 'zones.json'), 'utf8'));
  const active = z.features.filter(f => f.properties.s && !DONE.test(f.properties.s) && f.properties.k !== '촉진지구' && f.properties.k !== '존치');
  const cen = f => { const r = f.geometry.coordinates[0]; return [r.reduce((s, p) => s + p[1], 0) / r.length, r.reduce((s, p) => s + p[0], 0) / r.length]; };
  const zkey = f => cen(f).map(v => v.toFixed(5)).join(',');

  // 1) 동 이름표
  const dongName = {};
  for (const sgg of Object.keys(TARGET_SGG)) {
    const j = await post(`${BASE}/common/getBjdongList.do`, `sggCd=${sgg}`);
    for (const d of j.result || []) dongName[`${sgg}${d.bjdongCd}`] = `${TARGET_SGG[sgg]} ${d.bjdongNm}`;
  }

  const end = new Date(), start = new Date(end.getFullYear(), end.getMonth() - MONTHS, 1);
  const d8 = d => d.toLocaleDateString('sv-SE').replace(/-/g, '');
  const trades = [], houses = {};
  const needZone = active.filter(f => !(zkey(f) in cache.zone));

  await withKakao(async ev => {
    // 2) 진행 중 구역 중심점 → 법정동 코드 (캐시)
    if (needZone.length) {
      const codes = await ev(`(async () => {
        const svc = kakao.maps.services, geo = new svc.Geocoder(), out = [];
        for (const [lat, lng] of ${JSON.stringify(needZone.map(cen))})
          out.push(await new Promise(r => geo.coord2RegionCode(lng, lat, (x, st) => r(st === svc.Status.OK ? (x.find(v => v.region_type === 'B') || {}).code || null : null))));
        return out;
      })()`);
      needZone.forEach((f, i) => (cache.zone[zkey(f)] = codes[i]));
    }
    const dongs = [...new Set(active.map(f => cache.zone[zkey(f)]).filter(c => c && dongName[c]))].sort();
    console.log('대상 동', dongs.length, dongs.map(c => dongName[c]).join(', '));

    // 3) 동마다 실거래
    for (const code of dongs) {
      const sgg = code.slice(0, 5), bj = code.slice(5);
      const q = `sggCd=${sgg}&bjdong10Cd=${bj}&rnCd=&bldgNm=&bldgMuseList=02002|02003`;
      // 대지권면적: 분기 조회에서 (필지, 전용) → 대지권
      const landOf = {};
      for (const [s, e] of quarters(start, end)) {
        const j = await post(`${BASE}/rtms/getRtmsCBPriceList.do`, `${q}&selectGubun=1&startDate=${s}&endDate=${e}`);
        for (const r of rows(j.result?.[0]?.HTML || '')) if (r.pnu && r.cells[2]) landOf[`${r.pnu}|${num(r.cells[2][0])}`] = num(r.cells[3]?.[0]);
        await sleep(150);
      }
      const j = await post(`${BASE}/rtms/getRtmsCBPriceList.do`, `${q}&selectGubun=2&startDate=${d8(start)}&endDate=${d8(end)}`);
      let n = 0;
      for (const r of rows(j.result?.[0]?.HTML || '')) {
        const c = r.cells;
        if (!r.pnu || c.length < 9) continue;
        const head = c[0].join(' ');
        const name = head.startsWith('(') ? '' : c[0][0].replace(/\s*\([^)]*\)\s*$/, '').trim(); // '중앙하이츠빌(106-64)' → 이름만
        const year = +(head.match(/\[(\d{4})\]/) || [])[1] || null;
        const area = num(c[2][0]);
        c[3].forEach((dt, k) => {
          if (!ymd(dt) || /○/.test(c[8][k] || '')) return; // 해제된 거래 제외
          trades.push([r.pnu, name, year, area, landOf[`${r.pnu}|${area}`] ?? null, ymd(dt), num(c[4][k]), num(c[5][k])]);
          n++;
        });
      }
      // 단독/다가구 (동 단위)
      const h = await post(`${BASE}/rtms/getRtmsSHPriceList.do`, `sggCd=${sgg}&bjdong10Cd=${bj}&rnCd=&selectGubun=2&startDate=${d8(start)}&endDate=${d8(end)}`);
      const ht = [];
      for (const r of rows(h.result?.[0]?.HTML || '')) {
        const c = r.cells;
        if (c.length < 11) continue;
        c[4].forEach((dt, k) => {
          if (!ymd(dt) || /○/.test(c[8][k] || '')) return;
          ht.push([ymd(dt), num(c[5][k]), num(c[3][0]), num(c[2][0]), +(c[10][k] || c[10][0]) || null, c[1][0], c[0][0]]);
        });
      }
      houses[code] = { n: dongName[code], t: ht };
      console.log(`  ${dongName[code]}: 빌라 ${n} · 단독/다가구 ${ht.length}`);
      await sleep(200);
    }

    // 4) 필지 좌표 (캐시에 없는 것만)
    const need = [...new Set(trades.map(t => t[0]).filter(p => !(p in cache.pnu)))];
    console.log('좌표 필요 필지', need.length);
    const qs = need.map(p => {
      const nm = dongName[p.slice(0, 10)] || '';
      const main = +p.slice(11, 15), sub = +p.slice(15, 19);
      return `서울 ${nm} ${p[10] === '2' ? '산' : ''}${main}${sub ? '-' + sub : ''}`;
    });
    for (let i = 0; i < qs.length; i += 300) {
      const part = await ev(`(async () => {
        const svc = kakao.maps.services, geo = new svc.Geocoder(), out = [];
        for (const q of ${JSON.stringify(qs.slice(i, i + 300))})
          out.push(await new Promise(r => geo.addressSearch(q, (x, st) => r(st === svc.Status.OK ? [+(+x[0].y).toFixed(6), +(+x[0].x).toFixed(6)] : 0))));
        return out;
      })()`);
      part.forEach((ll, k) => (cache.pnu[need[i + k]] = ll));
    }
  });

  fs.writeFileSync(CACHE, JSON.stringify(cache));
  // 좌표를 붙여 저장: [pnu, lat, lng, 건물명, 준공, 전용㎡, 대지권㎡, 계약일, 금액(만원), 층]
  const out = trades.filter(t => cache.pnu[t[0]]).map(([p, ...rest]) => [p, ...cache.pnu[p], ...rest])
    .sort((a, b) => (a[7] < b[7] ? 1 : -1));
  const data = { updated: new Date().toLocaleDateString('sv-SE'), source: '서울부동산정보광장 실거래(연립·다세대, 단독·다가구)', months: MONTHS, trades: out, houses };
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (prev && JSON.stringify([prev.trades, prev.houses]) === JSON.stringify([data.trades, data.houses])) { console.log('변경 없음'); return; }
  fs.writeFileSync(OUT, JSON.stringify(data));
  console.log(`빌라 ${out.length}건 (좌표 없음 ${trades.length - out.length}) · 단독/다가구 ${Object.values(houses).reduce((s, h) => s + h.t.length, 0)}건 → villas.json`);
})().catch(e => { console.error(e); process.exit(1); });
