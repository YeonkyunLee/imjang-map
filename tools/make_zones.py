"""서울시 의제처리구역 shp → zones.json (정비 관련 구역만, WGS84, 단순화·중복 제거)

자료: 서울 열린데이터광장 OA-20957 '서울시 의제처리구역 공간정보' (UPIS_C_UQ181, zip 안의 shp파일)
  pip install pyshp pyproj
  python tools/make_zones.py <압축 푼 폴더>/shp파일/UPIS_C_UQ181 zones.json "UQ181, 2026-09"
"""
import json
import sys

import shapefile
from pyproj import Transformer

src, out, label = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'UQ181'

# 원본 좌표계: Korean 1985 Modified Central Belt (EPSG:5174 상당)
T = Transformer.from_crs(
    '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 '
    '+ellps=bessel +units=m +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +no_defs',
    'EPSG:4326', always_xy=True)

KIND = {  # 최종코드(ATRB_SE) → 앱 분류 (레이어표_181.xlsx 기준)
    'UQ1206': '재건축', 'UQ1240': '재건축',
    'UQ1220': '재개발', 'UQ1221': '재개발', 'UQ1222': '재개발', 'UQ1231': '재개발', 'UQ1232': '재개발', 'UQ1250': '재개발',
    'UQ1211': '주거환경', 'UQ1212': '주거환경',
    'UQ1811': '소규모', 'UQ1812': '소규모', 'UQ1813': '소규모', 'UQ1814': '소규모',
    'UQ5110': '촉진지구', 'UQ5120': '촉진지구', 'UQ5130': '촉진지구', 'UQ5140': '재개발', 'UQ5150': '존치',
}
TOL = 4  # m, 더글러스-포이커


def simplify(pts, tol):
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        L = (dx * dx + dy * dy) ** .5
        best, idx = 0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / L if L else ((px - x1) ** 2 + (py - y1) ** 2) ** .5
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    r = [p for p, k in zip(pts, keep) if k]
    return r if len(r) >= 4 else pts


r = shapefile.Reader(src, encoding='cp949', encodingErrors='replace')
feats, seen = [], set()
for sr in r.iterShapeRecords():
    rec, shp = sr.record, sr.shape
    kind = KIND.get(rec['ATRB_SE'])
    if not kind or not shp.points:
        continue
    parts = list(shp.parts) + [len(shp.points)]
    rings = []
    for a, b in zip(parts, parts[1:]):
        ring = simplify(shp.points[a:b], TOL)
        rings.append([[round(x, 5), round(y, 5)] for x, y in (T.transform(*p) for p in ring)])
    name = (rec['DGM_NM'] or '').strip()
    if '�' in name:
        name = ''
    key = (name, rec['ATRB_SE'], json.dumps(rings))
    if key in seen:
        continue
    seen.add(key)
    feats.append({'type': 'Feature', 'properties': {'n': name, 'k': kind, 'c': rec['ATRB_SE']},
                  'geometry': {'type': 'Polygon', 'coordinates': rings}})

with open(out, 'w', encoding='utf-8') as f:
    json.dump({'type': 'FeatureCollection', 'source': f'서울 열린데이터광장 OA-20957 의제처리구역 ({label})', 'features': feats},
              f, ensure_ascii=False, separators=(',', ':'))
print(len(feats), 'features')
