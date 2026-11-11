# 아이온2 전투력 패킷 실측 메모

`NotMeter.exe`에 포함된 `NotMeter.dll` 1.0.328.0을 정적으로 분석한 결과입니다. 아래 값은 해당 빌드의 구현에서 확인했습니다. 실측 시 실제 연결 포트와 게임 화면의 전투력으로 대조합니다.

| 항목 | 확인한 값 |
| --- | --- |
| 기본 게임 서버 포트 | TCP `13328` (`0x3410`) |
| 자기 캐릭터 전투력 갱신 | `CharCombatPowerUpdate_NT`, `0x5636` (`22070`), 바이트 `56 36` |
| 전투력 값 | 명령 번호 바로 뒤 8바이트를 리틀 엔디언 부호 없는 정수로 읽습니다. |

## 캡처와 판독

1. 본인 아이온2 연결에서 `tcp port 13328`로 시작합니다. NotMeter는 `GetExtendedTcpTable`에서 아이온2 프로세스의 로컬 포트를 조회해 필터에도 사용합니다. 프로세스 포트 전용 모드에서는 해당 로컬 포트만 사용하므로, 실제 서버 포트가 다르면 그 연결의 포트를 확인합니다.
2. 서버에서 클라이언트로 들어오는 TCP 스트림을 재조립한 뒤 게임 프레임을 읽습니다. 코드의 길이 검증식은 `프레임 길이 = 길이 varint의 값 + varint 바이트 수 - 4`입니다. varint 바로 다음 바이트가 `F0`~`FE`이면 한 바이트 건너뛴 위치에서 명령 번호를 읽습니다. `FF FF` 압축 묶음은 LZ4로 푼 뒤 내부 프레임을 읽습니다.
3. `56 36` 뒤의 본문은 16바이트입니다. 첫 8바이트가 전투력이고, 두 번째 8바이트도 리틀 엔디언 정수입니다. 파서는 첫 값이 500만 이하이고 두 번째 값이 1~500만일 때 첫 값을 검사해 양수인 전투력을 채택합니다. 두 번째 값의 의미는 확인하지 못했습니다.
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

## 바이너리 근거

- 입력 `NotMeter.exe` SHA-256 `8fe4f32e159833bb46ceb8995503e63a7fd90a48dfb199537308c9fc3ac3587c`
- 추출한 `NotMeter.dll` SHA-256 `772e0af720a5aee3921c758088fc039e2952c5c8b1de101da049e2366dbf1647`, 모듈 MVID `d6d27ef7-158f-4740-9738-cde871bfa4bb`
- REA 어셈블리 식별 근거 `ev_0298e117d016808c93727c16970d6439115efa4ef0d75f4ec965b6908166691e`. 메서드 명령어는 추출한 어셈블리에서 `dnfile`과 `dncil`로 확인했습니다.
- `NpcapCaptureOptions..ctor` (`0x0600790A`)는 `ServerPort`에 `13328`을 넣습니다. `NpcapPacketCaptureService.BuildCaptureFilter` (`0x06007983`)는 `GetCurrentLocalPorts` 결과를 `NpcapCaptureOptions.BuildBpfFilter` (`0x060078FC`)로 전달합니다.
- `ClientPacketCatalog.CharCombatPowerUpdate_NT`의 상수는 `22070`입니다. `GamePacketProcessor.ProcessPacketCore` (`0x06005649`)는 바이트 두 개를 상위·하위 순서로 합친 뒤 `22070`을 `ProcessOwnCombatPowerPacket` (`0x060056A2`)로 보냅니다.
- `OwnCombatPowerPacketParser.TryParse` (`0x06005A96`)는 `56 36`과 본문 길이를 검사하고 `ReadUInt64LittleEndian`으로 전투력을 읽습니다. 갱신 처리기는 캐릭터와 연결이 확인되면 값을 적용하고 `OwnCombatPowerUpdated` 이벤트를 보냅니다.
- 단일 파일 번들 추출 형식은 .NET 런타임 구현을 기준으로 확인했습니다. [번들 헤더](https://github.com/dotnet/runtime/blob/main/src/installer/managed/Microsoft.NET.HostModel/Bundle/Manifest.cs), [파일 항목](https://github.com/dotnet/runtime/blob/main/src/installer/managed/Microsoft.NET.HostModel/Bundle/FileEntry.cs)
