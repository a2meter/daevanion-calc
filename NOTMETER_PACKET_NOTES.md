# 아이온2 전투력 패킷 실측 메모

`NotMeter.exe`에 포함된 `NotMeter.dll` 1.0.328.0을 정적으로 분석한 결과입니다. 아래 값은 해당 빌드의 구현에서 확인했습니다. 실측 시 실제 연결 포트와 게임 화면의 전투력으로 대조합니다.

| 항목 | 확인한 값 |
| --- | --- |
| 기본 게임 서버 포트 | TCP `13328` (`0x3410`) |
| 자기 캐릭터 전투력 갱신 | `CharCombatPowerUpdate_NT`, `0x5636` (`22070`), 바이트 `56 36` |
| 전투력 값 | 명령 번호 바로 뒤 8바이트를 리틀 엔디언 부호 없는 정수로 읽습니다. |
| 두 번째 값 | 다음 8바이트는 달성 최고 전투력입니다. 2026-11-11 실제 연결에서 확인했습니다(아래). |

## 캡처와 판독

1. 본인 아이온2 연결에서 `tcp port 13328`로 시작합니다. NotMeter는 `GetExtendedTcpTable`에서 아이온2 프로세스의 로컬 포트를 조회해 필터에도 사용합니다. 프로세스 포트 전용 모드에서는 해당 로컬 포트만 사용하므로, 실제 서버 포트가 다르면 그 연결의 포트를 확인합니다.
2. 서버에서 클라이언트로 들어오는 TCP 스트림을 재조립한 뒤 게임 프레임을 읽습니다. 코드의 길이 검증식은 `프레임 길이 = 길이 varint의 값 + varint 바이트 수 - 4`입니다. varint 바로 다음 바이트가 `F0`~`FE`이면 한 바이트 건너뛴 위치에서 명령 번호를 읽습니다. `FF FF` 압축 묶음은 LZ4로 푼 뒤 내부 프레임을 읽습니다.
3. `56 36` 뒤의 본문은 16바이트입니다. 첫 8바이트가 전투력이고, 두 번째 8바이트도 리틀 엔디언 정수입니다. 파서는 첫 값이 500만 이하이고 두 번째 값이 1~500만일 때 첫 값을 검사해 양수인 전투력을 채택합니다. 두 번째 값은 달성 최고 전투력입니다([실제 연결 실측](#실제-연결-실측-2026-11-11)).
4. 루미엘 노드 하나를 변경할 때마다 직전·직후의 게임 화면 전투력과 수신한 전투력 값을 대조합니다. 캐릭터, 보드, 노드 좌표, 변경 방향, 변경 전후 값과 시각을 기록합니다. NotMeter의 해당 갱신 처리 결과 이름은 `own-combat-power-updated`입니다.

## 수치 실측 도구

작업 폴더에서 아래 명령으로 준비합니다. 이 작업 폴더에는 `.venv-cp`에 설치해 두었습니다.

```sh
python3 -m venv .venv-cp
.venv-cp/bin/python -m pip install -r scripts/requirements-cp.txt
```

맥에서 `tcpdump -D`로 게임 트래픽이 지나는 인터페이스를 확인합니다. 아래 명령을 실행한 뒤 게임에서 노드 하나를 변경하면, 전투력 패킷 한 건을 받아 수치를 출력하고 종료합니다. `--before`에는 변경 직전의 전투력을 넣습니다. 캡처 권한이 있는 환경에서는 `sudo`를 생략할 수 있습니다.

```sh
sudo .venv-cp/bin/python scripts/measure_cp.py --interface en0 --before 990034
```

`989595 (-439)`가 출력되면 변경 후 값은 `989595`, 변경 전후 차이는 `-439`입니다. `--before`를 생략하면 받은 수치만 출력합니다. 기본 대기 시간은 30초이며 `--timeout`으로 조정할 수 있습니다. 게임 연결의 서버 포트가 다르면 `--port`를 지정합니다. 같은 포트의 연결이 여러 개이면 `--server`나 `--client-port`로 좁힙니다.

저장한 pcap 또는 pcapng는 캡처 권한 없이 읽을 수 있습니다. 해당 캡처의 전투력 값을 순서대로 한 줄씩 출력합니다.

```sh
.venv-cp/bin/python scripts/measure_cp.py --read capture.pcapng --before 990034
```

캡처 파일 판독과 압축 해제는 Scapy와 python-lz4를 사용합니다. [Scapy 캡처 파일 판독](https://scapy.readthedocs.io/en/latest/api/scapy.utils.html#scapy.utils.PcapReader), [python-lz4 블록 판독](https://python-lz4.readthedocs.io/en/stable/lz4.block.html)

## 실제 연결 실측 (2026-11-11)

Windows 11과 Npcap에서 아이온2 게임 연결 하나(서버 포트 `13328`)의 서버→클라이언트 방향만 캡처해 4분 동안 판독했습니다. 같은 PC의 namter 작업 폴더에 있는 Windows용 `cp-watch.ps1`(`namter/tools/`)을 사용했습니다. 프레임은 위 [캡처와 판독](#캡처와-판독) 2단계의 규칙(길이 varint, 마커 바이트, LZ4 묶음)으로 읽고, `56 36` 본문은 앞 16바이트를 8바이트 정수 두 개로 읽습니다. 3단계의 NotMeter 채택 조건은 적용하지 않습니다.

| 항목 | 결과 |
| --- | --- |
| 수신 패킷 · 게임 프레임 | 8,477개 · 11,302개 |
| LZ4 압축 묶음 | 61개 |
| 길이가 맞지 않는 프레임 · 재정렬 | 0건 · 1건 (캡처 시작 시 한 번 정렬) |
| 캡처 누락 (pcap drop) | 0건 |
| `0x5636` 수신 | 17회 |

두 번째 8바이트는 **달성 최고 전투력**입니다. 17회 동안 첫 값(현재 전투력)은 968,431에서 975,759까지 오르내렸고 감소(−54, −105)도 있었습니다. 두 번째 값은 994,614로 17회 모두 같았습니다. 현재 전투력이 최고치보다 낮은 동안 최고치는 바뀌지 않으므로 이 해석과 일치합니다. 같은 날 23:35 루미엘 측정 중 현재 전투력이 994,614를 넘자 두 번째 값도 1,000,050으로 같이 올라갔습니다.

남은 대조: 수신한 값과 게임 화면 전투력을 나란히 기록한 대조는 아직 없습니다. 이 저장소의 `measure_cp.py`를 실제 연결에서 실행한 기록도 없습니다. 위 결과는 같은 패킷 형식과 프레임 규칙이 실제 연결에서 맞는다는 근거입니다.

## 데바니온 노드 패킷 (2026-11-11 조사)

노드를 바꿀 때 어느 노드가 바뀌었는지도 패킷으로 알 수 있습니다. 전투력 갱신 `0x5636`과 함께 읽으면 보드 번호, 좌표, 변경 방향, 전후 전투력을 손으로 적지 않고 기록할 수 있습니다. 아래 값은 클라이언트 1.0.46(2026-08-29 추출)의 usmap 패킷 정의와 실측 opcode 집계에서 얻었습니다. **클라이언트가 2026-11-11에 패치되었으므로 실제 연결에서 다시 확인해야 합니다.**

| opcode | 패킷 | 필드 | 근거 |
| --- | --- | --- | --- |
| `0x26E2` | `DaevanionBoardInfo_NT` | 보드별 `{_board_id, _node_ids[]}` 배열. 로그인할 때 보드 전체 | 관측 3회 (LZ4 묶음 안) |
| `0x28E2` | `DaevanionOpenNode_RS` | `_result`, `_node_id` | 실측 확인 (2026-11-11) |
| `0x29E2` | `DaevanionOpenNode_NT` | `_node_ids[]` | 추정 (높음) |
| `0x2BE2` | `DaevanionCloseNode_RS` | `_result`, `_node_id` | 실측 확인 (2026-11-11) |
| `0x2DE2` | `DaevanionResetBoard_RS` | `_result`, `_board_id` | 추정 (높음) |
| `0x2EE2` | `DaevanionPointUpdate_NT` | `{_point_type(1바이트), _point}` 배열. 포인트 종류별 사용량 | 실측 확인 (2026-11-11) |
| `0x2FE2` | `UpdateItemDaevanionPoint_NT` | 같은 구조. 아이템 보너스 포인트 | 실측 확인 (2026-11-11) |
| `0x55E3` | `DaevanionOpenAllNode_RS` | `_result`, `_board_id`, `_node_ids[]` | 추정 (중간) |
| `0x57E3` | `DaevanionOpenRouteNode_RS` | `_result`, `_board_id`, `_node_ids[]` | 추정 (중간) |

- 2026-11-11 루미엘 측정에서 열기·닫기 응답은 결과 코드 u16과 노드 번호 u32(6바이트)로, 포인트 갱신은 개수 varint와 `{종류 1바이트, 값 u16}`으로 읽혔습니다. 서버는 포인트 갱신, 열기·닫기 응답, 전투력 갱신 순서로 보냅니다.
- 경로를 여러 칸 한 번에 열면 포인트 갱신과 전투력 갱신만 잡혔고, 응답 패킷은 `0xE2`·`0xE3` 범위에서 보이지 않았습니다. `0x55E3`·`0x57E3` 추정은 맞지 않는 것으로 보이며 실제 번호는 아직 모릅니다.
- "높음"은 관측된 `0x26E2`와 `0x2EE2` 사이에 정의 순서 그대로 끼어 있다는 뜻입니다. `0x29E2`·`0x2DE2`는 아직 관측하지 못했습니다. 열기 전체·경로 열기는 namter의 opcode 표에 `0xEAE2`·`0xECE2`로 적혀 있지만, 실측 집계의 `0xE3` 범위로 다시 세면 위 값이 됩니다.
- 노드 번호는 `보드 × 10000 + (row − 1) × 15 + col`이며 공식 API의 `nodeId`와 같습니다. 예: 루미엘 (13, 2) 방어력 = `790028`.
- `_result`는 `kSuccess = 0`이 성공입니다. 데바니온 실패 코드는 15575~15591입니다. 예: 15582 포인트 부족, 15580 열린 인접 노드 없음, 15581 인접 노드를 먼저 환불해야 함. 1.0.46 기준 값이므로 패치 후 밀렸을 수 있습니다.
- 포인트 종류: 1 데바니온 포인트, 2 아리엘, 3 아스펠, 4 마르쿠탄, 5 유스티엘.
- 필드 폭: `0x26E2`의 실측 길이 4,077바이트를 노드 번호 varint로 계산하면 한 직업의 최대 노드 수(보드 8개 × 153 = 1,224개)를 넘습니다. 그래서 노드 번호는 고정 4바이트로 판단했고, 2026-11-11 실측의 열기·닫기 응답에서도 4바이트였습니다. 결과 코드는 2바이트로 확인했고, 보드 번호의 폭은 아직 확인하지 못했습니다.
- 다른 캐릭터의 보드는 캐릭터 살펴보기 응답(`ViewChar_RS`) 안에 `{_board_id, _open_count}`로만 오며 노드 번호가 없습니다. 위 패킷은 자기 캐릭터 전용입니다.
- 1.0.46 게임 데이터에서 해석한 보드 71~74의 노드 612개는 이 저장소의 공식 API 원본과 등급, 종류, 좌표, 이름이 모두 일치했습니다. 효과 문구는 시작 노드 4개를 뺀 608개를 비교해 모두 일치했습니다. 루미엘(79)은 1.0.46 데이터에 없는 새 보드입니다.
- 확인 방법: namter 작업 폴더의 `daevanion-watch.ps1 -Discover -Raw`를 실행한 뒤 노드 하나를 열고 닫습니다. 위 opcode가 맞으면 노드 이름과 좌표가 출력되고, 어긋나면 `0xE2`·`0xE3` 범위에서 실제 번호가 보입니다.

## 바이너리 근거

- 입력 `NotMeter.exe` SHA-256 `8fe4f32e159833bb46ceb8995503e63a7fd90a48dfb199537308c9fc3ac3587c`
- 추출한 `NotMeter.dll` SHA-256 `772e0af720a5aee3921c758088fc039e2952c5c8b1de101da049e2366dbf1647`, 모듈 MVID `d6d27ef7-158f-4740-9738-cde871bfa4bb`
- REA 어셈블리 식별 근거 `ev_0298e117d016808c93727c16970d6439115efa4ef0d75f4ec965b6908166691e`. 메서드 명령어는 추출한 어셈블리에서 `dnfile`과 `dncil`로 확인했습니다.
- `NpcapCaptureOptions..ctor` (`0x0600790A`)는 `ServerPort`에 `13328`을 넣습니다. `NpcapPacketCaptureService.BuildCaptureFilter` (`0x06007983`)는 `GetCurrentLocalPorts` 결과를 `NpcapCaptureOptions.BuildBpfFilter` (`0x060078FC`)로 전달합니다.
- `ClientPacketCatalog.CharCombatPowerUpdate_NT`의 상수는 `22070`입니다. `GamePacketProcessor.ProcessPacketCore` (`0x06005649`)는 바이트 두 개를 상위·하위 순서로 합친 뒤 `22070`을 `ProcessOwnCombatPowerPacket` (`0x060056A2`)로 보냅니다.
- `OwnCombatPowerPacketParser.TryParse` (`0x06005A96`)는 `56 36`과 본문 길이를 검사하고 `ReadUInt64LittleEndian`으로 전투력을 읽습니다. 갱신 처리기는 캐릭터와 연결이 확인되면 값을 적용하고 `OwnCombatPowerUpdated` 이벤트를 보냅니다.
- 단일 파일 번들 추출 형식은 .NET 런타임 구현을 기준으로 확인했습니다. [번들 헤더](https://github.com/dotnet/runtime/blob/main/src/installer/managed/Microsoft.NET.HostModel/Bundle/Manifest.cs), [파일 항목](https://github.com/dotnet/runtime/blob/main/src/installer/managed/Microsoft.NET.HostModel/Bundle/FileEntry.cs)
