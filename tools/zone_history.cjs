// 진행 중인 정비구역의 추진경과(단계별 날짜) → zone_history.json
//
//   node tools/zone_history.cjs        (zone_status.cjs 다음에. GitHub Actions가 매일 실행)
//
// 자료: 정비사업 정보몽땅 사업장 페이지(zones.json의 u) → 추진경과. 단계마다 첫 인가·승인·고시 날짜와 마지막 변경 날짜.
// 하루에 다 받지 않고 새 사업장 + 요일 몫(사업장 코드로 7등분)만 다시 받아 일주일에 한 번씩 돈다.
// 출력: { updated, z: { u: [[단계, 첫 날짜, 마지막 변경 날짜 또는 null], ...] } }
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'zone_history.json');
const BASE = 'https://cleanup.seoul.go.kr';
const DONE = /준공|이전고시|해산|청산/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.text();
    } catch (e) {
      if (i >= 2) throw new Error(`${url} 실패: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
}

// 추진경과 화면: 단계별 접는 칸(foldings-in-wrap) 안에 <h3 class="tit">날짜</h3> [행위] 목록
function parse(html) {
  const h = [];
  for (const sec of html.split('foldings-in-wrap').slice(1)) {
    const step = txt((sec.match(/<span>([\s\S]*?)<\/span>/) || [])[1] || '');
    const ds = [];
    for (const li of sec.match(/<h3 class="tit">[\s\S]*?<\/li>/g) || []) {
      const d = txt(li.match(/<h3 class="tit">([\s\S]*?)<\/h3>/)[1]).replace(/\s/g, '');
      const act = (txt(li).match(/\[([^\]]+)\]/) || [])[1] || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && /인가|승인|고시|지정|선정|신고|결정/.test(act) && !/신청/.test(act)) ds.push(d);
    }
    if (!step || !ds.length) continue;
    ds.sort();
    h.push([step, ds[0], ds[ds.length - 1] !== ds[0] ? ds[ds.length - 1] : null]);
  }
  return h.sort((a, b) => a[1].localeCompare(b[1]));
}

(async () => {
  const z = JSON.parse(fs.readFileSync(path.join(ROOT, 'zones.json'), 'utf8'));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { z: {} };
  const want = [...new Set(z.features.filter(f => f.properties.u && f.properties.s && !DONE.test(f.properties.s)).map(f => f.properties.u))];
  const day = Math.floor(Date.now() / 864e5);
  const slot = u => [...u].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 7, 0);
  const out = { z: {} };
  for (const u of want) if (prev.z[u]) out.z[u] = prev.z[u];
  const todo = want.filter(u => !out.z[u] || slot(u) === day % 7);
  console.log('진행 중 사업장', want.length, '받을 것', todo.length);
  let failed = 0;
  for (const u of todo) {
    try {
      const main = await get(`${BASE}/cafe/mainIndx.do?cafeUrl=${encodeURIComponent(u)}`);
      const m = main.match(/cleanup-prtnelapse\/vscr\.do\?cafeId=([^&"]+)&(?:amp;)?bsnsPk=([^&"]+)/);
      if (!m) { out.z[u] = []; continue; }
      out.z[u] = parse(await get(`${BASE}/cafe/mainIndx/cleanup-prtnelapse/vscr.do?cafeId=${m[1]}&bsnsPk=${m[2]}`));
    } catch (e) { failed++; console.log('  실패', u, e.message); }
    await sleep(300);
  }
  if (failed > todo.length / 2 && failed > 10) throw new Error(`실패가 너무 많음(${failed}/${todo.length}) — 사이트 점검일 수 있어 중단`);
  const key = o => JSON.stringify(Object.entries(o.z).sort());
  if (key(prev) === key(out)) { console.log('변경 없음'); return; }
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toLocaleDateString('sv-SE'), z: out.z }));
  console.log(`사업장 ${Object.keys(out.z).length} · 이력 있는 곳 ${Object.values(out.z).filter(h => h.length).length}${failed ? ` · 실패 ${failed}` : ''} → zone_history.json`);
})().catch(e => { console.error(e); process.exit(1); });
