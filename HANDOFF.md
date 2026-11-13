# 데바니온 계산기 인수인계

데바니온 보드 편집, 캐릭터 조회, 옵션별 전투력 기록과 공유 수량 최적화를 한 프로젝트에서 관리합니다. 동작과 데이터 형식은 [프로젝트 안내](README.md), 패킷으로 전투력을 읽는 절차는 [실측 메모](NOTMETER_PACKET_NOTES.md)에 있습니다.

## 로컬 실행과 검증

저장소 루트에서 실행합니다. 현재 구성은 Node.js 24와 파이썬 3.9에서 검증했습니다.

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm run dev`는 로컬 Worker와 정적 파일을 8765번 포트에서 제공합니다. 공개 배포는 Cloudflare Worker `daevanion`을 사용합니다. 공식 캐릭터 API 조회를 위해 `wrangler.jsonc`의 서울 리전 배치를 유지합니다. 배포 명령과 구성은 [프로젝트 안내](README.md)를 따릅니다.

## 데이터와 코드 위치

| 작업 | 파일과 규칙 |
| --- | --- |
| 보드 원본과 템플릿 | `boards/{71,72,73,74,79}.json`, `scripts/board-template.html`. `scripts/build_boards.py`가 HTML과 데이터 모듈을 생성합니다. |
| 캐릭터 조회 | `worker/index.mjs`, `assets/character-model.js`, `assets/character-search.js`, `assets/character-session.js`. 공식 `boardList`에서 직업별 실제 보드 번호를 조회하고 `sourceBoardId`로 보관합니다. 표시 슬롯은 71~74와 79입니다. |
| 편집과 변경 순서 | `assets/planner.js`, `assets/transition.js`. 모든 활성 노드가 각 보드 루트에 연결되며 공용 수량을 공유합니다. 원본 소모량이 0 또는 709 이상이면 계산용 수량은 837입니다. 1~708이면 원본 수량을 사용합니다. |
| 전투력 기록과 최적화 | `boards/measurements.json`, `boards/power-rules.json`, `assets/optimizer.js`, `assets/optimizer-worker.js`, `scripts/optimize_board.py`. 패시브 200 CP와 액티브 100 CP 고정값은 해당 등급의 스킬 노드에 적용합니다. |
| 재계산 필수 노드 | `assets/planner.js`의 `required`가 캐릭터별 지정을 편집 상태와 함께 보관합니다. `assets/optimizer.js`의 `createProblem`이 `required`를 받아 해당 노드를 고정하고, `repair`와 `improve`가 시작 구성을 만들고 다듬습니다. 화면은 `assets/board.js`(R 키와 상세 정보 버튼), `assets/index.js`(목록과 해제), `assets/options-table.js`(옵션 단위 지정)입니다. 검증은 `tests/required-nodes.test.cjs`입니다. |
| 터미널 실측 | `scripts/measure_cp.py`, `scripts/requirements-cp.txt`. 기본 TCP 포트 13328에서 자기 캐릭터 전투력 갱신 `0x5636`을 읽고 수치와 기준값 대비 차이를 출력합니다. 저장한 pcap과 pcapng도 읽습니다. |

## 다음 작업

1. 게임 화면의 전투력을 기준값으로 넣고 터미널 실측 도구를 실행한 뒤 노드 하나를 변경합니다. 받은 값과 게임 화면을 대조합니다. TCP 재조립, LZ4 압축 묶음, 한 건 출력 후 종료는 합성 캡처로 검증했습니다. 2026-11-11에는 같은 판독 규칙의 Windows 도구로 실제 연결 4분을 판독해 `0x5636` 17회를 받았고, 길이가 맞지 않는 프레임은 0건이었습니다. 두 번째 8바이트가 달성 최고 전투력이라는 것도 이때 확인했습니다. 게임 화면 값과의 대조, 그리고 `measure_cp.py` 자체의 실제 연결 실행은 남아 있습니다. 결과는 [실측 메모](NOTMETER_PACKET_NOTES.md#실제-연결-실측-2026-11-11)에 있습니다.
2. 루미엘 미측정 옵션 8종은 2026-11-11~12에 기록을 마쳤습니다. `boards/measurements.json`의 `2026-11-11-*`·`2026-11-12-*` 기록이며, 옵션마다 열기와 닫기 두 건입니다. 노드 열기·닫기 응답 패킷과 전투력 갱신 패킷을 짝지어 측정했고 두 방향의 변화량이 같았습니다. 노드 1개당 공격력 증가 +1.5% 5,937, 방어력 증가 +1.5% 736, 추가 방어력 +50·치명타 +10 180, 철벽 +1% 111, 추가 명중 +10·추가 회피 +10 92, 생명력 증가 +1% 56, 재생 +1% 54, 막기 관통 +10·막기 +10 48 CP입니다. 측정에 사용한 노드는 아래와 같습니다.

   | 옵션 | 등급 · 소모 | 노드 1개당 CP | 측정한 노드 `[col, row]` |
   | --- | --- | ---: | --- |
   | 공격력 증가 +1.5% | 특수 · 4 | 5,937 | [15,15] |
   | 방어력 증가 +1.5% | 특수 · 4 | 736 | [1,15] |
   | 추가 방어력 +50, 치명타 +10 | 희귀 · 2 | 180 | [1,13] |
   | 철벽 +1% | 전설 · 3 | 111 | [13,14] [9,13] |
   | 추가 명중 +10, 추가 회피 +10 | 희귀 · 2 | 92 | [14,5] |
   | 생명력 증가 +1% | 희귀 · 2 | 56 | [10,10] |
   | 재생 +1% | 전설 · 3 | 54 | [3,12] |
   | 막기 관통 +10, 막기 +10 | 희귀 · 2 | 48 | [2,11] |

   노드 변경 패킷은 실제 연결에서 확인했습니다. [노드 패킷 메모](NOTMETER_PACKET_NOTES.md#데바니온-노드-패킷-2026-11-11-조사)를 참고하십시오.
3. 기록을 추가하면 보드 데이터를 다시 생성하고 JS와 파이썬 검증을 실행합니다. 최적화 결과의 합산 점수와 실제 게임 전투력은 각각 확인합니다. 이전 실측에서는 점수 기준 구성을 적용한 뒤 실제 전투력이 감소한 사례가 있습니다.

```sh
python3 -m venv .venv-opt
.venv-opt/bin/python -m pip install -r scripts/requirements.txt
.venv-opt/bin/python scripts/build_boards.py
.venv-opt/bin/python -m unittest discover -s tests -p 'test_*.py'
npm test
```

현재 다섯 보드의 최적화 저장본은 837개를 사용하며, 2026-11-13에 웹 계산 모듈 `assets/optimizer.js`(개선 탐색과 HiGHS WebAssembly, 120초)로 다시 구한 기록값 합계 165,956점과 상한 166,339점으로 저장되어 있습니다. `boards/all-power-plan.json`의 상태는 `feasible`이고 상한과의 차이는 383점입니다. 결과를 `boards/all-optimization.json`에 같은 모형 해시로 기록한 뒤 `python3 scripts/build_boards.py`로 연결·수량·점수·상한을 검증하고 보드별 파일을 다시 생성했습니다. 모형과 측정값은 바뀌지 않았습니다.

2026-11-12의 이전 저장본 162,039점(상한 166,340점)은 Windows의 Python 3.14에서 scipy 1.18.1과 HiGHS 1.15.1만으로 계산한 결과였습니다. 2026-11-13 점검에서 HiGHS만으로는 이 저장본을 30초 안에 개선하지 못했고 90초에 163,118점이 나왔습니다. 개선 탐색은 같은 저장본을 1초 안에 165,940점으로 올렸습니다. 이 탐색은 JS에만 있고 파이썬 `--solve`에는 없습니다. `--solve`는 저장된 보드별 구성을 시작 후보로 쓰므로 측정값이 바뀌어도 저장본보다 낮은 결과로 바꾸지는 않지만, 새 모형에서 좋은 결과가 필요하면 웹의 전투력 재계산이나 같은 JS 모듈로 구하십시오. `scripts/requirements.txt`에 고정한 scipy 1.13.1은 Python 3.14용 배포판이 없어 설치되지 않습니다.

2026-11-13에 macOS(Node.js 24, Python 3.9)에서 JS 테스트 77개와 파이썬 12개가 통과했습니다. Windows에서 10초 제한을 넘기던 「빈 다섯 보드 가져오기 … 837개 사용」은 HiGHS가 첫 구성을 찾기 전에 시작 구성을 만들도록 바뀌었습니다. macOS에서는 시작 구성 없이 3초 계산이 실패하던 것이 165,934점을 내는 것으로 확인했고, Windows에서는 다시 실행하지 않았습니다. `boards/optimality-proof.json`과 그 상태 파일의 124,766점 증명은 이전 네 보드와 709개 수량에 해당합니다.
