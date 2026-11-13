#!/usr/bin/env python3
"""데바니온 링크: 아이온2 패킷에서 데바니온 보드 상태와 스킬 레벨을 읽어 웹 계산기로 넘깁니다.

인자 없이 실행하면 창을 띄웁니다. --read는 저장한 캡처를 읽어 요약과 링크를 출력합니다.
"""

import argparse
import json
import os
import pathlib
import sys

HERE = str(pathlib.Path(__file__).resolve().parent)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import link_payload  # noqa: E402

DEFAULT_PORT = 13328
EXAMPLE = {"boardsComplete": True, "skillsComplete": True, "capturedAt": 1, "power": 2, "bestPower": 3,
           "boards": [{"boardId": 71, "nodeIds": [710113]}],
           "skills": [{"skillId": 17750000, "level": 17, "daevanionLevels": 4}]}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--read", metavar="PCAP",
                        help="저장한 pcap 또는 pcapng를 읽어 요약과 링크를 출력합니다. 창을 띄우지 않습니다. "
                             "보드 정보나 스킬 목록이 없으면 종료 코드가 1입니다.")
    parser.add_argument("--print-link", action="store_true", help="--read와 함께 쓰면 요약 없이 링크만 출력합니다.")
    parser.add_argument("--decode", metavar="LINK", help="링크나 데이터 문자열을 풀어 JSON으로 출력합니다.")
    parser.add_argument("--site", help="웹 계산기 주소. 창에서는 설정에 저장된 주소가 기본값입니다.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="게임 서버 TCP 포트. 기본값 13328")
    parser.add_argument("--interface", help="창에서 처음 고를 네트워크 인터페이스")
    parser.add_argument("--start", action="store_true", help="창을 열면서 바로 캡처를 시작합니다.")
    parser.add_argument("--close-after", type=float, metavar="SECONDS", help=argparse.SUPPRESS)
    parser.add_argument("--self-check", nargs="?", const="-", metavar="FILE", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("포트는 1~65535 범위로 지정하십시오.")
    if args.print_link and not args.read:
        parser.error("--print-link는 --read와 함께 사용하십시오.")
    return args


def decode_link(text):
    try:
        data = link_payload.decode(text)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def read_capture(core, args):
    from scapy.all import Scapy_Exception

    site = args.site or core.DEFAULT_SITE
    try:
        core.site_base(site)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    try:
        state = core.read_capture(args.read, port=args.port).state
    except (OSError, ValueError, Scapy_Exception) as error:
        print(f"캡처를 읽지 못했습니다: {error}", file=sys.stderr)
        return 1
    if not args.print_link:
        print("\n".join(core.summary(state, core.load_skill_table())))
    if state is None:
        print(core.waiting_reason(state), file=sys.stderr)
        return 1
    try:
        url, dropped = core.link_parts(site, state)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    print(url if args.print_link else f"링크: {url}")
    if dropped:
        print(f"링크를 2,000자 아래로 줄이려고 스킬 {dropped}개를 뺐습니다.", file=sys.stderr)
    if not state.complete:
        print(f"완료되지 않은 상태의 링크입니다. {core.waiting_reason(state)}", file=sys.stderr)
        return 1
    return 0


def self_check(target):
    """묶은 실행 파일에 필요한 모듈과 자료가 다 들어 있는지 창 없이 확인합니다."""
    lines = []

    def check(name, action):
        try:
            lines.append(f"ok {name}: {action()}")
        except BaseException as error:  # 가져오기 실패가 SystemExit로 오는 경우도 적습니다.
            lines.append(f"FAIL {name}: {type(error).__name__}: {error}")

    check("payload", lambda: link_payload.decode(link_payload.encode(EXAMPLE))["skills"][0]["level"])
    check("core", lambda: __import__("link_core").login_skills(b"\x01" + bytes.fromhex("01eb0300000101000000000000000000")))
    check("lz4", lambda: __import__("measure_cp").lz4.decompress(__import__("measure_cp").lz4.compress(b"daevanion")))
    check("capture", lambda: __import__("link_capture").capture_filter())
    check("window", lambda: __import__("link_gui").TITLE)
    check("skill names", lambda: len(__import__("link_core").load_skill_table()))
    text = "\n".join(lines) + "\n"
    if target == "-":
        print(text, end="")
    else:
        pathlib.Path(target).write_text(text, encoding="utf-8")
    return 1 if any(line.startswith("FAIL") for line in lines) else 0


def main(argv=None):
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if stream is None:
            # 창 전용으로 묶은 실행 파일에는 표준 출력이 없습니다.
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
        elif hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    args = parse_args(argv)
    if args.decode:
        return decode_link(args.decode)
    if args.self_check is not None:
        return self_check(args.self_check)
    try:
        import link_core as core
    except ImportError as error:
        print(error, file=sys.stderr)
        return 1
    if args.read:
        return read_capture(core, args)
    import link_gui

    return link_gui.run(port=args.port, site=args.site, interface=args.interface, autostart=args.start,
                        close_after=args.close_after)


if __name__ == "__main__":
    sys.exit(main())
