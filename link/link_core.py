"""데바니온 링크의 화면 없는 핵심부입니다.

게임 서버에서 온 프레임으로 캐릭터의 보드 상태와 스킬 레벨을 추적하고, 웹 계산기가 읽을 링크를 만듭니다.
TCP 재조립과 프레임 판독은 scripts/measure_cp.py, 데바니온 패킷 판독은 scripts/watch_daevanion.py의 것을 그대로 씁니다.
"""

import datetime
import importlib.util
import json
import os
import pathlib
import struct
import sys
import urllib.parse

from link_payload import decode, encode, fit  # noqa: F401  (다른 모듈과 테스트가 여기서 가져다 씁니다.)


def resource_root():
    """저장소 루트입니다. PyInstaller로 묶은 실행 파일에서는 풀린 자료 폴더입니다."""
    if getattr(sys, "frozen", False):
        return pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(sys.executable).resolve().parent))
    return pathlib.Path(__file__).resolve().parent.parent


# measure_cp는 라이브러리가 없으면 sys.exit로 끝나므로 가져오기 전에 확인합니다.
_missing = [name for name in ("scapy", "lz4") if importlib.util.find_spec(name) is None]
if _missing:
    raise ImportError(f"캡처 판독 라이브러리가 없습니다({', '.join(_missing)}). "
                      "python -m pip install -r link/requirements.txt 로 설치하십시오.")
if not getattr(sys, "frozen", False):
    _scripts = str(resource_root() / "scripts")
    if _scripts not in sys.path:
        sys.path.append(_scripts)

from scapy.all import IP, TCP, IPv6, Padding, PcapReader  # noqa: E402

from measure_cp import GAME_PORT, MAX_POWER, POWER_OPCODE, SEQUENCE_MASK, TcpStream  # noqa: E402
from watch_daevanion import (BOARD_INFO, BOARD_NAMES, CLOSE_RESPONSE, OPEN_NOTICE, OPEN_RESPONSE,  # noqa: E402
                             RESET_RESPONSE, ROUTE_RESPONSE, SKILL_UPDATE, STAT_UPDATE, STATS, FrameStream,
                             board_lists, node_list, route_nodes, skill_list, stat_list)


SKILL_LIST = b"\x00\x51"
LOST = b""  # Demux가 "이 연결에서 패킷을 놓쳤다"를 알릴 때 명령 자리에 넣는 값입니다.
START_INDEX = 113
NODE_COUNT = 225
SKILL_ENTRY = 17
LIST_RECORDS = {0x01: 16, 0x05: 17}  # 로그인 스킬 목록의 레코드 첫 바이트 → 레코드 길이
URL_LIMIT = 2000
MAX_CONNECTIONS = 8
DEFAULT_SITE = "https://daevanion.a2meter.workers.dev"
APP_NAME = "DaevanionLink"
CONFIG_DEFAULTS = {"site": DEFAULT_SITE, "interface": ""}


# ── 스킬 ────────────────────────────────────────────────────────────────

def load_skill_table(path=None):
    """boards/skill-ids.json을 {스킬 번호: 스킬 이름}으로 읽습니다. 이름을 보여 주는 데만 씁니다.

    이 캐릭터의 직업만 들어 있는 표입니다. 파일이 없거나 읽지 못하면 빈 표이고, 스킬 판독에는 영향이 없습니다.
    """
    path = pathlib.Path(path) if path else resource_root() / "boards" / "skill-ids.json"
    table = {}
    try:
        skills = json.loads(path.read_text(encoding="utf-8"))["skills"]
        for skill in skills:
            name = str(skill.get("name", "")).split(" - ", 1)[-1]
            for skill_id in skill["skillIds"]:
                table[int(skill_id)] = name
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}
    return table


def login_skills(payload):
    """로그인 스킬 목록(0x0051)을 {스킬 번호: (레벨, 데바니온 레벨)}로 읽습니다. 구조가 맞지 않으면 None입니다.

    첫 바이트가 레코드 수입니다. 레코드는 표시 1바이트, 스킬 번호 4바이트, 현재 레벨, 직접 올린 레벨,
    데바니온 노드로 오른 레벨 1바이트씩, 그 뒤 8바이트로 이루어져 16바이트입니다. 표시가 0x05인 레코드는 끝에 1바이트가 더 있어
    17바이트입니다. 2026-11-13 로그인 두 번의 목록(1,412바이트)은 0x01 레코드 85개와 0x05 레코드 3개였습니다.
    표시가 이 두 값이 아니거나, 레코드 수가 맞지 않거나, 본문 끝에서 정확히 끝나지 않으면 추측하지 않고 None을 돌려줍니다.
    """
    if not payload:
        return None
    found = {}
    offset = 1
    for _ in range(payload[0]):
        size = LIST_RECORDS.get(payload[offset]) if offset < len(payload) else None
        if size is None or offset + size > len(payload):
            return None
        skill_id, level, _trained, daevanion = struct.unpack_from("<IBBB", payload, offset + 1)
        found[skill_id] = (level, daevanion)
        offset += size
    return found if offset == len(payload) else None


def skill_updates(payload):
    """스킬 레벨 갱신(0x1338)을 [(번호, 레벨, 데바니온 레벨)]로 읽습니다.

    17바이트 항목에서 레벨 뒤의 다섯 바이트는 직접 올린 레벨, 데바니온 레벨, 그 밖의 가산 셋으로 읽혔습니다.
    2026-11-13 캡처의 317건 모두 이 다섯 값의 합이 레벨과 같았고, 데바니온 레벨은 그때 열려 있던 스킬 노드 수와 같았습니다.
    합이 맞지 않는 항목은 구조가 다른 것으로 보고 데바니온 레벨을 0(모름)으로 냅니다.
    """
    found = []
    for index, (skill_id, level) in enumerate(skill_list(payload) or ()):
        parts = payload[1 + index * SKILL_ENTRY + 10:1 + index * SKILL_ENTRY + 15]
        found.append((skill_id, level, parts[1] if sum(parts) == level else 0))
    return found


# ── 상태 ────────────────────────────────────────────────────────────────

class LinkState:
    """연결 하나에서 읽은 캐릭터 상태입니다."""

    def __init__(self):
        self.boards = {}            # 보드 번호 → 열린 노드 번호 집합
        self.skills = {}            # 스킬 번호 → (레벨, 데바니온 레벨)
        self.power = 0
        self.best_power = 0
        self.boards_complete = False
        self.skills_complete = False
        self.lost = False           # 패킷을 놓쳐 완료 표시를 거둔 상태입니다.
        self.skills_unreadable = False  # 스킬 목록(0x0051)이 왔지만 구조가 맞지 않았습니다.
        self.stats = {}             # 스탯 번호 → 값. 링크에는 넣지 않습니다.
        self.frames = 0
        self.seen_at = None         # 이 연결에서 마지막으로 프레임을 읽은 시각
        self.changed_at = None      # 보드, 스킬, 전투력이 마지막으로 바뀐 시각

    @property
    def complete(self):
        return self.boards_complete and self.skills_complete

    def copy(self):
        other = LinkState()
        other.__dict__.update(self.__dict__)
        other.boards = {board: set(nodes) for board, nodes in self.boards.items()}
        other.skills = dict(self.skills)
        other.stats = dict(self.stats)
        return other

    def to_payload(self):
        """link_payload.pack이 받는 모양입니다. capturedAt은 이 상태가 유효했던 마지막 시각입니다."""
        return {
            "version": 1,
            "boardsComplete": self.boards_complete,
            "skillsComplete": self.skills_complete,
            "capturedAt": int(self.seen_at or 0),
            "power": self.power,
            "bestPower": self.best_power,
            "boards": [{"boardId": board, "nodeIds": sorted(nodes)} for board, nodes in sorted(self.boards.items())],
            "skills": [{"skillId": skill, "level": level, "daevanionLevels": daevanion}
                       for skill, (level, daevanion) in sorted(self.skills.items())],
        }


def valid_node(node_id):
    return 1 <= node_id % 10000 <= NODE_COUNT


class Tracker:
    """프레임을 받아 연결별 상태를 갱신합니다. 패킷이 오는 순서에 기대지 않고 프레임 하나씩 반영합니다."""

    def __init__(self):
        self.states = {}        # 연결 번호 → LinkState
        self.current = None     # 화면에 보일 연결. 아는 패킷이 마지막으로 온 연결입니다.
        self.recognized = False
        self.unreadable = {}    # 명령 → 구조가 맞지 않아 버린 횟수
        self.handlers = {
            POWER_OPCODE: self.on_power,
            BOARD_INFO: self.on_boards,
            OPEN_RESPONSE: self.on_open,
            CLOSE_RESPONSE: self.on_close,
            OPEN_NOTICE: self.on_notice,
            ROUTE_RESPONSE: self.on_route,
            RESET_RESPONSE: self.on_reset,
            SKILL_UPDATE: self.on_skill_update,
            SKILL_LIST: self.on_skill_list,
            STAT_UPDATE: self.on_stats,
        }

    @property
    def state(self):
        return self.states.get(self.current)

    def connection(self, connection):
        state = self.states.get(connection)
        if state is None:
            while len(self.states) >= MAX_CONNECTIONS:
                oldest = next(key for key in self.states if key != self.current)
                del self.states[oldest]
            state = self.states[connection] = LinkState()
        return state

    def dispatch(self, time, connection, command, payload):
        """Demux가 낸 항목 하나를 반영합니다. 화면에 보일 상태가 바뀌면 True입니다."""
        if command == LOST:
            return self.mark_lost(connection)
        return self.handle(time, connection, command, payload)

    def handle(self, time, connection, command, payload):
        state = self.connection(connection)
        state.frames += 1
        state.seen_at = time
        handler = self.handlers.get(command)
        if handler is None:
            if self.current is None:
                self.current = connection
            return False
        switched = self.current != connection or not self.recognized
        self.current = connection
        self.recognized = True
        changed = handler(state, payload)
        if changed is None:
            self.unreadable[command] = self.unreadable.get(command, 0) + 1
        elif changed:
            state.changed_at = time
        return bool(changed) or switched

    def mark_lost(self, connection):
        """패킷을 놓친 연결은 그 사이의 변경을 알 수 없으므로 완료 표시를 거둡니다."""
        state = self.states.get(connection)
        if state is None or not (state.boards_complete or state.skills_complete):
            return False
        state.boards_complete = state.skills_complete = False
        state.lost = True
        return connection == self.current

    # 처리기는 상태가 바뀌면 True, 그대로면 False, 구조가 맞지 않으면 None을 돌려줍니다.

    def on_power(self, state, payload):
        if len(payload) != 16:
            return None
        power, best = struct.unpack("<QQ", payload)
        if not (0 < power <= MAX_POWER and 0 < best <= MAX_POWER):
            return None
        changed = (power, best) != (state.power, state.best_power)
        state.power, state.best_power = power, best
        return changed

    def on_boards(self, state, payload):
        boards = board_lists(payload)
        if boards is None:
            return None
        boards = {board: {node for node in nodes if valid_node(node)} for board, nodes in boards.items()}
        changed = boards != state.boards or not state.boards_complete
        state.boards = boards
        state.boards_complete = True
        state.lost = state.lost and not state.skills_complete
        return changed

    def on_open(self, state, payload):
        return self.on_node(state, payload, True)

    def on_close(self, state, payload):
        return self.on_node(state, payload, False)

    def on_node(self, state, payload, opened):
        if len(payload) != 6:
            return None
        result, node_id = struct.unpack("<HI", payload)
        if result:
            return False
        if not valid_node(node_id):
            return None
        nodes = state.boards.setdefault(node_id // 10000, set())
        if (node_id in nodes) == opened:
            return False
        if opened:
            nodes.add(node_id)
        else:
            nodes.discard(node_id)
        return True

    def open_nodes(self, state, node_ids):
        changed = False
        for node_id in node_ids:
            if not valid_node(node_id):
                continue
            nodes = state.boards.setdefault(node_id // 10000, set())
            if node_id not in nodes:
                nodes.add(node_id)
                changed = True
        return changed

    def on_notice(self, state, payload):
        nodes = node_list(payload)
        return None if nodes is None else self.open_nodes(state, nodes)

    def on_route(self, state, payload):
        route = route_nodes(payload)
        if route is None:
            # 실패한 경로 열기는 노드 목록이 비어 있어 읽히지 않습니다. 바뀌는 것이 없습니다.
            return False
        result, _board, nodes = route
        return False if result else self.open_nodes(state, nodes)

    def on_reset(self, state, payload):
        if len(payload) not in (3, 4, 6):
            return None
        if struct.unpack_from("<H", payload)[0]:
            return False
        board = int.from_bytes(payload[2:], "little")
        only = {board * 10000 + START_INDEX}
        if state.boards.get(board) == only:
            return False
        state.boards[board] = only
        return True

    def on_skill_update(self, state, payload):
        # 번호마다 마지막으로 받은 값을 둡니다. 스킬의 변형 번호(예: 17080020)는 그 변형이 쓰이는 레벨 구간에서만
        # 갱신이 오므로, 구간을 벗어난 뒤에는 예전 값이 남습니다. 스킬의 현재 레벨은 기본 번호(…0000)의 값입니다.
        updates = skill_updates(payload)
        if not updates:
            return None
        changed = False
        for skill_id, level, daevanion in updates:
            if state.skills.get(skill_id) != (level, daevanion):
                state.skills[skill_id] = (level, daevanion)
                changed = True
        return changed

    def on_skill_list(self, state, payload):
        found = login_skills(payload)
        if found is None:
            # 구조가 다르면 일부만 읽어 넣지 않습니다. 스킬은 완료되지 않은 채로 두고 창에 알립니다.
            self.unreadable[SKILL_LIST] = self.unreadable.get(SKILL_LIST, 0) + 1
            changed = not state.skills_unreadable
            state.skills_unreadable = True
            return changed
        changed = (not state.skills_complete or state.skills_unreadable
                   or any(state.skills.get(skill) != value for skill, value in found.items()))
        state.skills.update(found)
        state.skills_complete = True
        state.skills_unreadable = False
        state.lost = state.lost and not state.boards_complete
        return changed

    def on_stats(self, state, payload):
        stats = stat_list(payload)
        if stats is None:
            return None
        state.stats.update(stats)
        return False


# ── 캡처 판독 ───────────────────────────────────────────────────────────

class Demux:
    """measure_cp.captured와 같은 방식으로 서버 스트림을 재조립하되, 패킷을 하나씩 받고 프레임에 연결 번호를 붙입니다.

    feed는 (시각, 연결 번호, 명령, 본문) 목록을 냅니다. 이어지지 않는 구간이 생기거나 프레임 정렬이 어긋나면
    그 패킷의 프레임 뒤에 명령이 LOST인 항목을 하나 붙입니다.
    """

    def __init__(self, port=GAME_PORT):
        self.port = port
        self.streams = {}
        self.serial = 0

    def feed(self, packet):
        tcp = packet.getlayer(TCP)
        if tcp is None or tcp.sport != self.port:
            return []
        network = tcp.underlayer
        while network is not None and not isinstance(network, (IP, IPv6)):
            network = network.underlayer
        if network is None:
            return []
        flow = (network.src, tcp.sport, network.dst, tcp.dport)
        syn = bool(tcp.flags.S)
        entry = self.streams.get(flow)
        payload = bytes(tcp.payload)
        padding = tcp.payload.getlayer(Padding)
        if padding is not None:
            payload = payload[:len(payload) - len(padding)]
        if entry is None and not (syn or payload):
            return []
        if entry is None or (syn and entry[0].syn != tcp.seq):
            if len(self.streams) >= 32 and flow not in self.streams:
                self.streams.pop(next(iter(self.streams)))
            self.serial += 1
            entry = self.streams[flow] = (TcpStream(tcp.seq, syn, FrameStream), self.serial)
        stream, connection = entry
        found = []
        if payload:
            time = float(packet.time)
            framer, resyncs = stream.frames, STATS["resyncs"]
            sequence = (tcp.seq + syn) & SEQUENCE_MASK
            found = [(time, connection, command, body) for command, body in stream.feed(sequence, payload)]
            if stream.frames is not framer or STATS["resyncs"] != resyncs:
                found.append((time, connection, LOST, b""))
        if tcp.flags.F or tcp.flags.R:
            self.streams.pop(flow, None)
        return found


def read_capture(source, tracker=None, port=GAME_PORT):
    """저장한 pcap 또는 pcapng(경로나 파일 객체)를 끝까지 읽어 Tracker를 돌려줍니다."""
    tracker = Tracker() if tracker is None else tracker
    demux = Demux(port)
    with PcapReader(source) as capture:
        for packet in capture:
            for event in demux.feed(packet):
                tracker.dispatch(*event)
    return tracker


# ── 링크와 표시 ─────────────────────────────────────────────────────────

def site_base(site):
    """사이트 주소를 '#link=' 바로 앞까지의 주소로 다듬습니다. http(s) 주소가 아니면 ValueError입니다."""
    text = (site or "").strip()
    if not text:
        raise ValueError("사이트 주소를 입력하십시오.")
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urllib.parse.urlsplit(text)
        usable = parts.scheme in ("http", "https") and bool(parts.hostname) and parts.port != 0
    except ValueError:  # 포트 자리에 숫자가 아닌 것이 있습니다.
        usable = False
    if not usable or "@" in parts.netloc or any(character.isspace() for character in text):
        raise ValueError("사이트 주소는 http 또는 https 주소여야 합니다.")
    path = parts.path
    # 파일 이름으로 끝나는 주소(index.html)에는 /를 붙이지 않습니다.
    if not path.endswith("/") and "." not in path.rsplit("/", 1)[-1]:
        path += "/"
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def link_parts(site, state):
    """(<사이트>/#link=<데이터> 주소, 길이 때문에 덜어 낸 스킬 수)를 돌려줍니다.

    주소 전체를 2,000자 미만으로 맞춥니다. 넘치면 link_payload.fit의 순서로 스킬을 덜어 내고
    페이로드의 스킬 완료 비트를 끕니다. 스킬을 모두 빼도 넘치면 ValueError입니다.
    """
    base = site_base(site) + "#link="
    try:
        data, dropped = fit(state, URL_LIMIT - 1 - len(base))
    except ValueError as error:
        raise ValueError(f"링크가 {URL_LIMIT:,}자를 넘습니다. 사이트 주소를 확인하십시오.") from error
    return base + encode(data), dropped


def link_url(site, state):
    """<사이트>/#link=<데이터> 주소를 만듭니다."""
    return link_parts(site, state)[0]


def board_name(board):
    return BOARD_NAMES.get(board, f"보드 {board}")


def clock(time):
    return "없음" if time is None else datetime.datetime.fromtimestamp(time).strftime("%Y-%m-%d %H:%M:%S")


def waiting_reason(state):
    """링크를 만들 수 없는 이유입니다. 만들 수 있으면 빈 문자열입니다."""
    if state is None or not state.frames:
        return "게임 서버에서 온 패킷이 없습니다."
    if state.lost:
        return "패킷 일부를 놓쳐 읽은 상태를 믿을 수 없습니다. 이 프로그램을 켜 둔 채로 게임에 다시 접속하십시오."
    if not state.boards_complete:
        return "접속할 때 오는 보드 정보를 받지 못했습니다. 이 프로그램을 켜 둔 채로 게임에 다시 접속하십시오."
    if state.skills_unreadable and not state.skills_complete:
        return ("보드 상태는 읽었지만 스킬 목록을 읽지 못했습니다. 목록의 구조가 이 프로그램이 아는 것과 달라 "
                "스킬 레벨을 가져오지 않았습니다.")
    if not state.skills_complete:
        return "보드 상태는 읽었습니다. 접속 직후에 오는 스킬 목록을 기다리고 있습니다."
    return ""


STATUS_TEXT = {
    "idle": "캡처를 시작하지 않았습니다. 인터페이스를 확인하고 캡처 시작을 누르십시오.",
    "starting": "캡처를 시작하고 있습니다.",
    "awaiting-admin": "관리자 권한 승인을 기다리고 있습니다. macOS가 띄운 창에서 승인하십시오. 이 프로그램은 암호를 받지 않습니다.",
    "npcap": "Npcap이 설치되어 있지 않아 캡처할 수 없습니다. npcap.com에서 Npcap을 직접 설치한 뒤 이 프로그램을 다시 실행하십시오.",
    "no-tcpdump": "tcpdump를 찾지 못했습니다. tcpdump를 설치한 뒤 다시 시도하십시오.",
    "cancelled": "관리자 권한 요청이 취소되었습니다. 캡처를 시작하지 않았습니다.",
}
PERMISSION_TEXT = {
    "darwin": "이 계정에는 캡처 권한이 없습니다. 관리자 권한으로 캡처를 누르면 macOS가 암호를 묻고 tcpdump만 관리자 권한으로 실행합니다.",
    "win32": "네트워크 어댑터를 열 권한이 없습니다. 이 프로그램을 관리자 권한으로 다시 실행하십시오.",
}
PERMISSION_OTHER = "이 계정에는 캡처 권한이 없습니다. 관리자 권한으로 실행하거나 tcpdump에 캡처 권한을 준 뒤 다시 시도하십시오."


def status_text(phase, state=None, detail="", platform=None):
    """창의 상태 줄에 보일 문장입니다. phase는 캡처 쪽 상태 이름입니다."""
    detail = " ".join(str(detail).split())
    if phase == "permission":
        return PERMISSION_TEXT.get(platform or sys.platform, PERMISSION_OTHER)
    if phase in STATUS_TEXT and (phase != "idle" or state is None):
        return STATUS_TEXT[phase]
    reason = waiting_reason(state)
    if phase == "capturing":
        if state is None or not state.frames:
            return "캡처 중입니다. 게임 서버에서 오는 패킷을 기다리고 있습니다. 게임을 실행해 캐릭터로 접속하십시오."
        if reason:
            return "캡처 중입니다. " + reason
        return "캡처 중입니다. 보드와 스킬을 모두 읽었습니다. 웹에서 재계산을 누를 수 있습니다."
    if phase in ("error", "ended"):
        text = "캡처가 예상과 다르게 끝났습니다." if phase == "ended" else "캡처 중 오류가 발생했습니다."
        return f"{text} ({detail})" if detail else text
    # 중지한 뒤에도 마지막으로 읽은 상태는 남겨 둡니다.
    if state is not None and state.complete:
        return "캡처를 중지했습니다. 마지막으로 읽은 상태로 링크를 만들 수 있습니다."
    return "캡처를 중지했습니다."


def summary(state, skill_names=None):
    """--read가 출력하는 요약 줄입니다. 스킬은 데바니온 레벨이 있거나 이름을 아는 것만 한 줄씩 적습니다."""
    skill_names = skill_names or {}
    if state is None:
        return ["게임 서버에서 온 프레임이 없습니다."]
    skills = "읽음" if state.skills_complete else "읽지 못함" if state.skills_unreadable else "받지 못함"
    lines = [
        f"보드 정보: {'읽음' if state.boards_complete else '받지 못함'} · 스킬 목록: {skills}",
        f"전투력: {state.power:,} · 최고 {state.best_power:,}" if state.power else "전투력: 받지 못함",
    ]
    for board, nodes in sorted(state.boards.items()):
        lines.append(f"{board_name(board)} ({board}): 열린 노드 {len(nodes)}개")
    boosted = sum(1 for _level, daevanion in state.skills.values() if daevanion)
    lines.append(f"스킬: {len(state.skills)}개 (데바니온 노드로 오른 스킬 {boosted}개)")
    for skill, (level, daevanion) in sorted(state.skills.items()):
        if daevanion or skill in skill_names:
            lines.append(f"  {skill} {skill_names.get(skill, '이름 모름')}: 레벨 {level} (데바니온 {daevanion})")
    lines.append(f"스탯: {len(state.stats)}종 · 프레임 {state.frames:,}개")
    lines.append(f"마지막 변경: {clock(state.changed_at)} · 마지막 프레임: {clock(state.seen_at)}")
    return lines


# ── 설정 ────────────────────────────────────────────────────────────────

def config_path():
    """사용자 설정 폴더의 config.json 경로입니다. DAEVANION_LINK_CONFIG로 바꿀 수 있습니다."""
    override = os.environ.get("DAEVANION_LINK_CONFIG")
    if override:
        return pathlib.Path(override)
    home = pathlib.Path.home()
    if sys.platform == "win32":
        base = pathlib.Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = home / "Library" / "Application Support"
    else:
        base = pathlib.Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    return base / APP_NAME / "config.json"


def load_config(path=None):
    config = dict(CONFIG_DEFAULTS)
    try:
        saved = json.loads(pathlib.Path(path or config_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return config
    if isinstance(saved, dict):
        config.update({key: value for key, value in saved.items() if key in config and isinstance(value, str)})
    return config


def save_config(config, path=None):
    path = pathlib.Path(path or config_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps({key: config.get(key, default) for key, default in CONFIG_DEFAULTS.items()},
                                    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
