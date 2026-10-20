"""좌표 없는 장소 노트에 카카오 로컬 API로 location을 채운다 (PC 일회성).

1) 주소가 있으면 주소 검색 (괄호·'일대/일원' 제거, 지번·도로명까지 맞은 결과만)
2) 없거나 못 찾으면 이름으로 장소 검색 — 이름이 맞고 지역 중심에서 MAX_KM 안일 때만 채택

REST 키는 환경변수 KAKAO_REST_KEY (커밋 금지).
  python tools/fill_coords.py            # 미리보기
  python tools/fill_coords.py --apply    # 노트에 기록
"""
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

NOTES = Path.home() / 'Documents' / 'Ian_obsidian' / '임장'
MAX_KM = 5
FM = re.compile(r'^---\r?\n(.*?)\r?\n---', re.S)


def kakao(kind, **q):
    url = f'https://dapi.kakao.com/v2/local/search/{kind}.json?' + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={'Authorization': f"KakaoAK {os.environ['KAKAO_REST_KEY']}"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)['documents']


def km(a, b):
    return math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 88.2)


norm = lambda s: re.sub(r'\s|제(?=\d)', '', str(s)).lower()


def load(notes):
    out = []
    for p in sorted(notes.rglob('*.md')):
        if '.git' in p.parts:
            continue
        with open(p, encoding='utf-8', newline='') as f:  # 줄바꿈(CRLF/LF) 그대로
            text = f.read()
        m = FM.match(text)
        fm = (yaml.safe_load(m.group(1)) or {}) if m else {}
        if not isinstance(fm, dict) or not fm.get('유형'):
            continue
        loc = fm.get('location')
        ll = loc if isinstance(loc, list) and len(loc) == 2 else None
        out.append({'path': p, 'text': text, 'name': p.stem, 'region': p.parent.name, 'fm': fm, 'll': ll})
    return out


def find(n, center):
    addr = re.sub(r'\(.*?\)', '', str(n['fm'].get('주소') or ''))
    addr = re.sub(r'\s*(일대|일원)\s*$', '', addr).strip()
    if addr:
        # 동 이름만 맞은 결과(REGION·ROAD)는 동 중심점이라 버림 — 지번·도로명 주소까지 맞아야 채택
        docs = [d for d in kakao('address', query=addr) if d['address_type'] in ('REGION_ADDR', 'ROAD_ADDR')]
        if docs:
            d = docs[0]
            return [float(d['y']), float(d['x'])], '주소', d['address_name']
    q = {'query': n['name']}
    if center:
        q.update(x=center[1], y=center[0], radius=20000)
    for d in kakao('keyword', **q)[:5]:
        ll = [float(d['y']), float(d['x'])]
        if norm(n['name']) in norm(d['place_name']) and (not center or km(ll, center) <= MAX_KM):
            return ll, '장소', f"{d['place_name']} · {d.get('road_address_name') or d['address_name']}"
    return None, '-', '못 찾음'


def write(n, ll):
    eol = '\r\n' if '\r\n' in n['text'] else '\n'
    line = f'location: [{ll[0]:.5f}, {ll[1]:.5f}]'
    m = FM.match(n['text'])
    head = m.group(1)
    head = re.sub(r'^location:.*$', line, head, count=1, flags=re.M) if re.search(r'^location:', head, re.M) else head + eol + line
    n['path'].write_text(n['text'][:m.start(1)] + head + n['text'][m.end(1):], encoding='utf-8', newline='')


def main():
    apply = '--apply' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--apply']
    notes = Path(args[0]) if args else NOTES
    places = load(notes)
    found = 0
    for n in (p for p in places if not p['ll']):
        lls = [p['ll'] for p in places if p['region'] == n['region'] and p['ll']]
        center = [sum(l[0] for l in lls) / len(lls), sum(l[1] for l in lls) / len(lls)] if lls else None
        ll, src, label = find(n, center)
        dist = f'{km(ll, center):.1f}km' if ll and center else ''
        print(f"{n['region']}/{n['name']} | {src} | {label} | {dist}")
        if ll:
            found += 1
            if apply:
                write(n, ll)
    print(f"\n좌표 없음 {sum(not p['ll'] for p in places)}곳 중 {found}곳 찾음" + (' — 기록함' if apply else ' (미리보기, --apply로 기록)'))


if __name__ == '__main__':
    main()
