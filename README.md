# imjang-map

임장 노트(private 저장소 `YeonkyunLee/imjang`)를 폰에서 지도로 보는 정적 앱. 이 저장소에는 코드만 있고 데이터는 없다.

- 지도: Leaflet + OpenStreetMap (카카오 키 발급 후 카카오맵으로 교체 예정)
- 데이터: GitHub API로 노트 목록·본문을 읽어 frontmatter 파싱. `유형`이 있는 노트가 장소, `moc` 태그 노트는 지역 노트
- 토큰: fine-grained, imjang 저장소 Contents 권한. 앱 설정(⚙)에 입력하면 그 브라우저에만 저장
- 캐시: 받은 노트를 blob sha 기준으로 브라우저에 저장, 바뀐 노트만 다시 받음. 통신이 안 되면 캐시로 표시

## 로컬 실행

```
python dev.py            # http://localhost:8000
```

localhost에서는 GitHub 대신 `dev.py`가 노출하는 로컬 노트 폴더(기본 `~/Documents/Ian_obsidian/임장`)를 읽는다.

## 마커

| 색 | 평가 | 모양 | 유형 |
|---|---|---|---|
| 빨강 | 1순위 | 원 | 아파트 등 |
| 주황 | 추천 | 사각 | 재건축 |
| 파랑 | 후보 | 다이아몬드 | 재개발구역 |
| 회색 | 탈락 · 미평가 | ✓ 표시 | 다녀옴 |

`제외` 상태는 흐리게 표시. 줌 15 이상에서 이름 라벨이 보인다.

계획 전체: imjang 저장소의 `지도앱 구성 계획.md`
