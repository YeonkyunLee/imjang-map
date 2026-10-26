// 관심 자치구 아파트 실거래(최근 36개월) → apts.json
//
//   node tools/apt_trades.cjs        (Edge 또는 BROWSER=크롬 경로. GitHub Actions가 매일 실행)
//
// 자료: 서울부동산정보광장 아파트 실거래(기간 조회, 해제 거래 제외). 단지 좌표는 단지 필지번호(PNU)를 카카오 지오코더로
// (tools/pnucache.json 공유 캐시). 네이버 단지 코드도 같이 저장해 앱에서 네이버 매물로 바로 연결.
// 출력: { updated, months, c: { pnu: [이름, 준공, lat, lng, 네이버코드] }, t: [[pnu 번호(c 순서), YYMMDD, 전용×10, 금액(만원), 층], ...] }
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://land.seoul.go.kr/land';
const SITE = 'https://yeonkyunlee.github.io/imjang-map/manifest.webmanifest';
const BROWSER = process.env.BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CACHE = path.join(__dirname, 'pnucache.json');
const OUT = path.join(ROOT, 'apts.json');
const MONTHS = 36;
const SGG = { 11620: '관악구', 11590: '동작구', 11560: '영등포구', 11530: '구로구', 11215: '광진구', 11260: '중랑구', 11545: '금천구',
  11350: '노원구', 11320: '도봉구', 11305: '강북구', 11380: '은평구', 11230: '동대문구', 11650: '서초구' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(url, body, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries - 1) throw new Error(`${url} 실패: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
}
const unesc = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const cellVals = td => td.replace(/^<td[^>]*>|<\/td>$/g, '').split(/<br\s*\/?>/i).map(x => unesc(x.replace(/<[^>]+>/g, '')).trim());
const num = s => parseFloat(String(s).replace(/,/g, '')) || null;

async function withKakao(fn) {
  const key = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/var key = '([0-9a-f]{32})'/)[1];
  const port = 9300 + Math.floor(Math.random() * 500);
  const edge = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'apt-' + Date.now())}`, 'about:blank'], { stdio: 'ignore' });
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
  cache.pnu ||= {};
  const end = new Date(), start = new Date(end.getFullYear(), end.getMonth() - MONTHS, 1);
  const d8 = d => d.toLocaleDateString('sv-SE').replace(/-/g, '');
  const cx = {}; // pnu → [이름, 준공, 네이버코드, 동이름]
  const trades = [];
  let failed = 0;
  for (const [sgg, gu] of Object.entries(SGG)) {
    const dongs = (await post(`${BASE}/common/getBjdongList.do`, `sggCd=${sgg}`)).result || [];
    for (const d of dongs) {
      let html;
      try {
        const j = await post(`${BASE}/rtms/getRtmsPriceList.do`,
          `sggCd=${sgg}&rightGbnGrp=RTMS&bjdong10Cd=${d.bjdongCd}&selectGubun=2&rnCd=&startDate=${d8(start)}&endDate=${d8(end)}&bldgNm=&bldgGbn=AP`);
        html = j.result?.[0]?.HTML || '';
      } catch (e) { failed++; console.log('  실패', gu, d.bjdongNm, e.message); continue; }
      // 한 줄 = 거래 1건. 단지·전용면적 칸은 그 단지(평형)의 첫 줄에만 있고 다음 줄들은 비어 있음 → 앞 값을 이어 씀
      let n = 0, pnu = null, area = null;
      for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
        const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cellVals);
        if (cells.length < 9) continue;
        const p = (tr.match(/landCd='(\d{19})'/) || [])[1];
        if (p) {
          pnu = p;
          if (!cx[pnu]) {
            const head = cells[0].join(' ');
            cx[pnu] = [cells[0][0], +(head.match(/\[(\d{4})\]/) || [])[1] || null, +(tr.match(/naverGrCode='(\d+)'/) || [])[1] || null, `${gu} ${d.bjdongNm}`];
          }
        }
        if (num(cells[2][0])) area = num(cells[2][0]);
        const dt = cells[3][0];
        if (!pnu || !area || !/^\d{2}\.\d{2}\.\d{2}$/.test(dt) || /○/.test(cells[8].join(''))) continue;
        trades.push([pnu, +dt.replace(/\./g, ''), Math.round(area * 10), num(cells[4][0]), parseInt(cells[5][0]) || null]);
        n++;
      }
      console.log(`  ${gu} ${d.bjdongNm}: ${n}`);
      await sleep(250);
    }
  }
  if (trades.length < 5000) throw new Error(`거래가 비정상적으로 적음(${trades.length}) — 사이트 점검일 수 있어 중단`);

  // 단지 좌표 (캐시에 없는 것만): 단지 대표 필지 → 주소 검색
  const need = Object.keys(cx).filter(p => !(p in cache.pnu));
  console.log('단지', Object.keys(cx).length, '좌표 필요', need.length);
  if (need.length) await withKakao(async ev => {
    const qs = need.map(p => `서울 ${cx[p][3]} ${p[10] === '2' ? '산' : ''}${+p.slice(11, 15)}${+p.slice(15, 19) ? '-' + +p.slice(15, 19) : ''}`);
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

  const keys = Object.keys(cx).filter(p => cache.pnu[p]);
  const idx = Object.fromEntries(keys.map((p, i) => [p, i]));
  const out = {
    updated: new Date().toLocaleDateString('sv-SE'), months: MONTHS, source: '서울부동산정보광장 아파트 실거래',
    c: keys.map(p => [p, cx[p][0], cx[p][1], ...cache.pnu[p], cx[p][2]]),
    t: trades.filter(t => t[0] in idx).map(([p, ...r]) => [idx[p], ...r]).sort((a, b) => b[1] - a[1]),
  };
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (prev && JSON.stringify([prev.c, prev.t]) === JSON.stringify([out.c, out.t])) { console.log('변경 없음'); return; }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`단지 ${out.c.length} · 거래 ${out.t.length}${failed ? ` · 실패 동 ${failed}` : ''} → apts.json`);
})().catch(e => { console.error(e); process.exit(1); });
