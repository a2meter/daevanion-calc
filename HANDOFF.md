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
| 터미널 실측 | `scripts/measure_cp.py`, `scripts/requirements-cp.txt`. 기본 TCP 포트 13328에서 자기 캐릭터 전투력 갱신 `0x5636`을 읽고 수치와 기준값 대비 차이를 출력합니다. 저장한 pcap과 pcapng도 읽습니다. |

## 다음 작업

1. 게임 화면의 전투력을 기준값으로 넣고 터미널 실측 도구를 실행한 뒤 노드 하나를 변경합니다. 받은 값과 게임 화면을 대조합니다. TCP 재조립, LZ4 압축 묶음, 한 건 출력 후 종료는 합성 캡처로 검증했고 실제 게임 연결에서의 대조는 남아 있습니다.
2. 루미엘 미측정 옵션 8종을 기록합니다. 같은 캐릭터와 장비 상태에서 옵션 하나씩 변경하고, 보드 번호, 좌표 `[col, row]`, 변경 방향, 전후 전투력을 남깁니다. 확인한 값은 `boards/measurements.json`에 기존 기록과 같은 형식으로 추가합니다. 미측정 옵션은 현재 합산 점수에서 제외되며 연결과 소모량 계산에는 포함됩니다.
3. 기록을 추가하면 보드 데이터를 다시 생성하고 JS와 파이썬 검증을 실행합니다. 최적화 결과의 합산 점수와 실제 게임 전투력은 각각 확인합니다. 이전 실측에서는 점수 기준 구성을 적용한 뒤 실제 전투력이 감소한 사례가 있습니다.

```sh
python3 -m venv .venv-opt
.venv-opt/bin/python -m pip install -r scripts/requirements.txt
.venv-opt/bin/python scripts/build_boards.py
.venv-opt/bin/python -m unittest discover -s tests -p 'test_*.py'
npm test
```

현재 다섯 보드의 최적화 저장본은 837개를 사용하며, 기록값 합계 137,790점과 상한 139,105점으로 저장되어 있습니다. `boards/all-power-plan.json`의 상태는 `feasible`입니다. `boards/optimality-proof.json`과 그 상태 파일의 124,766점 증명은 이전 네 보드와 709개 수량에 해당합니다.
