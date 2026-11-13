#!/usr/bin/env python3
"""아이온2 연결에서 데바니온 노드 변경과 전투력 변화를 계속 읽습니다."""

import argparse
import collections
import datetime
import ipaddress
import json
import pathlib
import re
import signal
import struct
import subprocess
import sys

from measure_cp import (COMPRESSED_OPCODE, GAME_PORT, MAX_POWER, MAX_UNCOMPRESSED, POWER_OPCODE,
                        Scapy_Exception, capture_command, captured, frame_header, lz4)


BOARD_INFO = b"\x26\xe2"
OPEN_RESPONSE = b"\x28\xe2"
OPEN_NOTICE = b"\x29\xe2"
CLOSE_RESPONSE = b"\x2b\xe2"
RESET_RESPONSE = b"\x2d\xe2"
POINTS = b"\x2e\xe2"
ITEM_POINTS = b"\x2f\xe2"
ROUTE_RESPONSE = b"\x03\xe5"
DAEVANION_GROUPS = (0xE2, 0xE3)

BOARD_NAMES = {71: "네자칸", 72: "지켈", 73: "바이젤", 74: "트리니엘", 79: "루미엘"}
GRADES = {"Common": ("일반", 1), "Rare": ("희귀", 2), "Legend": ("전설", 3), "Unique": ("특수", 4)}
POINT_NAMES = {1: "데바니온", 2: "아리엘", 3: "아스펠", 4: "마르쿠탄", 5: "유스티엘"}
RESULTS = {15580: "열린 인접 노드 없음", 15581: "인접 노드를 먼저 환불해야 함", 15582: "포인트 부족"}

ALIGN_FRAMES = 3
ALIGN_LIMIT = 4 * 1024
ALIGN_KEEP = 8 * 1024
PLAIN_LIMIT = 256 * 1024
GROUP_GAP = 1.0
SILENCE = 15
STATS = {"frames": 0, "bundles": 0, "resyncs": 0}


def frames_in(data, opcode, end, depth=0):
    """프레임 하나를 (명령, 본문)으로 냅니다. LZ4 묶음은 풀어서 안쪽 프레임을 냅니다."""
    command = bytes(data[opcode:opcode + 2])
    payload = bytes(data[opcode + 2:end])
    if command != COMPRESSED_OPCODE:
        return [(command, payload)]
    if depth >= 3 or len(payload) < 5:
        return []
    size = struct.unpack_from("<I", payload)[0]
    if not 0 < size <= MAX_UNCOMPRESSED:
        return []
    try:
        decoded = lz4.decompress(payload[4:], uncompressed_size=size)
    except (lz4.LZ4BlockError, OverflowError, ValueError):
        return []
    STATS["bundles"] += 1
    found = []
    offset = 0
    skipped = 0
    while offset < len(decoded) and skipped < 16:
        try:
            header = frame_header(decoded, offset)
        except ValueError:
            header = None
        if header is None or header[0] > len(decoded):
            offset += 1
            skipped += 1
            continue
        found.extend(frames_in(decoded, header[1], header[0], depth + 1))
        offset = header[0]
        skipped = 0
    return found


class FrameStream:
    """재조립한 스트림의 모든 프레임을 (명령, 본문)으로 냅니다."""

    def __init__(self, aligned=False):
        self.aligned = aligned
        self.buffer = bytearray()

    def chain(self, offset):
        """offset부터 작은 프레임이 연달아 맞으면 True, 데이터가 모자라면 None입니다."""
        for _ in range(ALIGN_FRAMES):
            try:
                header = frame_header(self.buffer, offset)
            except ValueError:
                return False
            if header is None:
                return None
            end = header[0]
            if end - offset > ALIGN_LIMIT:
                return False
            if end > len(self.buffer):
                return None
            offset = end
        return True

    def feed(self, chunk):
        self.buffer.extend(chunk)
        found = []
        offset = 0
        while offset < len(self.buffer):
            if not self.aligned:
                # 연결 중간에서 시작했거나 어긋난 경우입니다. 맞는 위치가 나올 때까지 최근 데이터만 남깁니다.
                start = next((index for index in range(offset, len(self.buffer)) if self.chain(index)), None)
                if start is None:
                    offset = max(offset, len(self.buffer) - ALIGN_KEEP)
                    break
                offset = start
                self.aligned = True
            try:
                header = frame_header(self.buffer, offset)
                if header is not None and header[0] - offset > PLAIN_LIMIT:
                    if header[1] + 2 > len(self.buffer):
                        break
                    if self.buffer[header[1]:header[1] + 2] != COMPRESSED_OPCODE:
                        raise ValueError("압축되지 않은 프레임이 너무 깁니다.")
            except ValueError:
                self.aligned = False
                STATS["resyncs"] += 1
                offset += 1
                continue
            if header is None or header[0] > len(self.buffer):
                break
            end, opcode = header
            STATS["frames"] += 1
            found.extend(frames_in(self.buffer, opcode, end))
            offset = end
        del self.buffer[:offset]
        return found


def read_varint(data, offset):
    value = 0
    for index in range(5):
        if offset + index >= len(data):
            raise ValueError("varint가 끊겼습니다.")
        byte = data[offset + index]
        value |= (byte & 0x7F) << (index * 7)
        if byte < 0x80:
            return value, offset + index + 1
    raise ValueError("varint가 너무 깁니다.")


def node_list(payload):
    """개수 varint와 노드 번호 4바이트 배열을 읽습니다."""
    try:
        count, offset = read_varint(payload, 0)
    except ValueError:
        return None
    if not count or len(payload) - offset != count * 4:
        return None
    return list(struct.unpack_from(f"<{count}I", payload, offset))


def board_lists(payload):
    """보드별 열린 노드 목록을 읽습니다. 보드 번호의 폭은 확인되지 않아 맞아떨어지는 폭을 찾습니다."""
    for width in (4, 2, 1, 0):
        try:
            count, offset = read_varint(payload, 0)
            boards = {}
            for _ in range(count):
                if width:
                    if offset + width > len(payload):
                        raise ValueError("보드 번호가 끊겼습니다.")
                    board = int.from_bytes(payload[offset:offset + width], "little")
                    offset += width
                else:
                    board, offset = read_varint(payload, offset)
                size, offset = read_varint(payload, offset)
                nodes = struct.unpack_from(f"<{size}I", payload, offset)
                offset += size * 4
                if any(node // 10000 != board for node in nodes):
                    raise ValueError("보드 번호와 노드 번호가 맞지 않습니다.")
                boards[board] = nodes
        except (ValueError, struct.error):
            continue
        if boards and offset == len(payload):
            return boards
    return None


def route_nodes(payload):
    """결과 2바이트, 보드 번호 4바이트, 노드 번호 배열을 읽습니다. 경로 열기 응답의 구조입니다."""
    if len(payload) < 11:
        return None
    result, board = struct.unpack_from("<HI", payload)
    nodes = node_list(payload[6:])
    if nodes is None or any(node // 10000 != board for node in nodes):
        return None
    return result, board, nodes


def point_list(payload):
    """개수 varint와 {종류 1바이트, 값 2바이트} 배열을 읽습니다."""
    try:
        count, offset = read_varint(payload, 0)
    except ValueError:
        return None
    if len(payload) - offset != count * 3:
        return None
    return [struct.unpack_from("<BH", payload, offset + index * 3) for index in range(count)]


def load_nodes(directory):
    nodes = {}
    for path in sorted(pathlib.Path(directory).glob("[0-9]*.json")):
        if not path.stem.isdigit():
            continue
        for node in json.loads(path.read_text(encoding="utf-8")).get("nodeList", []):
            # 종류가 None인 항목은 격자의 빈 칸입니다.
            if node.get("type") != "None":
                nodes[node["nodeId"]] = node
    return nodes


def option_key(node):
    """scripts/build_boards.py와 같은 옵션 키입니다."""
    effects = [effect["desc"] for effect in node.get("effectList", []) if effect.get("desc")]
    return json.dumps([node["grade"], node["type"], node["name"], effects], ensure_ascii=False, separators=(",", ":"))


class Records:
    """측정 기록에 있는 옵션별 값과 비교하고, 기록에 없던 값을 추가합니다."""

    def __init__(self, path, nodes, write=False):
        self.path = pathlib.Path(path)
        self.write = write
        self.records = json.loads(self.path.read_text(encoding="utf-8"))
        self.values = {}
        self.slugs = {}
        for record in self.records:
            key = json.dumps([record["grade"], record["type"], record["name"], record["effects"]],
                             ensure_ascii=False, separators=(",", ":"))
            delta = record["before"] - record["after"] if record["operation"] == "deactivate" else record["after"] - record["before"]
            delta -= record.get("excludedPower", 0)
            count = record["nodeCount"]
            self.note(key, delta // count if delta % count == 0 else delta / count)
            self.slugs[key] = re.sub(r"(-inferred)?-\d+$", "", re.sub(r"^\d{4}-\d{2}-\d{2}-", "", record["id"]))
        rules = self.path.with_name("power-rules.json")
        for rule in json.loads(rules.read_text(encoding="utf-8")) if rules.exists() else []:
            # 스킬 노드는 등급별 고정값이 측정 기록보다 뒤에 적용됩니다.
            for node in nodes.values():
                if node["type"] == "SkillLevel" and node["grade"] == rule["grade"]:
                    self.note(option_key(node), rule["power"])

    def note(self, key, value):
        """옵션의 값을 기록 순서대로 남깁니다. 마지막 값이 계산에 쓰이는 최신 기록값입니다."""
        values = self.values.setdefault(key, [])
        if value in values:
            values.remove(value)
        values.append(value)

    def judge(self, time, entry, before, after, nodes):
        """요약 줄 뒤에 붙일 비교 결과입니다."""
        _text, action, target = entry
        change = after - before
        if action == "route":
            latest = [self.values.get(option_key(nodes[node]), [None])[-1] for node in target if node in nodes]
            if len(latest) != len(target) or None in latest:
                return " · 기록값이 없는 노드 포함"
            total = sum(latest)
            return f" · 최신 기록값 합계 {total:,}" + (" 일치" if total == change else f", 차이 {change - total:+,}")
        node = nodes.get(target)
        if action not in ("열기", "닫기") or node is None:
            return ""
        key = option_key(node)
        observed = change if action == "열기" else -change
        known = self.values.get(key)
        if not known:
            return " · 기록값 없음"
        if observed == known[-1]:
            return f" · 기록값 {observed:,} 일치"
        if observed in known:
            return f" · 이전 기록 {observed:,} 일치 (최신 {known[-1]:,})"
        earlier = ", ".join(f"{value:,}" for value in known)
        verdict = f" · 새 값 {observed:,} (기존 기록 {earlier})"
        if not self.write:
            return verdict
        day = datetime.date.fromtimestamp(time).isoformat()
        prefix = f"{day}-{self.slugs.get(key, 'node-' + str(node['nodeId']))}-"
        used = [int(record["id"][len(prefix):]) for record in self.records
                if record["id"].startswith(prefix) and record["id"][len(prefix):].isdigit()]
        record = {
            "id": f"{prefix}{max(used, default=0) + 1:02d}", "recordedOn": day, "boardId": node["boardId"],
            "grade": node["grade"], "type": node["type"], "name": node["name"],
            "effects": [effect["desc"] for effect in node.get("effectList", []) if effect.get("desc")],
            "operation": "activate" if action == "열기" else "deactivate", "nodeCount": 1,
            "before": before, "after": after, "coordinates": [node["col"], node["row"]],
            "note": f"패킷 실측입니다. 노드 {action} 응답과 짝지은 전투력 갱신(0x5636)을 기록했습니다. 이전 기록값은 {earlier}였습니다.",
        }
        self.append(record)
        self.note(key, observed)
        return verdict + f" · 기록함 {record['id']}"

    def append(self, record):
        fields = ",\n".join(f"    {json.dumps(name)}: {json.dumps(value, ensure_ascii=False)}" for name, value in record.items())
        raw = self.path.read_text(encoding="utf-8")
        body = raw.rstrip()
        if not body.endswith("]"):
            raise ValueError("측정 기록 파일의 형식이 예상과 다릅니다.")
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(body[:-1].rstrip() + ",\n  {\n" + fields + "\n  }\n]\n", encoding="utf-8")
        temporary.replace(self.path)
        self.records.append(record)


def hexdump(payload, limit=64):
    text = payload[:limit].hex()
    return text + ("…" if len(payload) > limit else "")


class Watcher:
    def __init__(self, nodes, before=None, out=print, records=None):
        self.nodes = nodes
        self.out = out
        self.records = records
        self.power = before
        self.points = {POINTS: {}, ITEM_POINTS: {}}
        self.started = False
        self.group = None
        self.recent = collections.deque(maxlen=16)

    def say(self, time, mark, text):
        clock = datetime.datetime.fromtimestamp(time).strftime("%H:%M:%S")
        self.out(f"{clock} {mark} {text}", flush=True)

    def describe(self, node_id, detail=False):
        node = self.nodes.get(node_id)
        board, index = divmod(node_id, 10000)
        if node is None:
            if not 1 <= index <= 225:
                return f"노드 #{node_id}"
            row, col = divmod(index - 1, 15)
            return f"보드 {board} [{col + 1},{row + 1}] #{node_id}"
        grade = GRADES.get(node.get("grade"))
        kind = f"{grade[0]}·{grade[1]}" if grade else "시작" if node.get("type") == "Start" else node.get("type", "?")
        text = f"{BOARD_NAMES.get(board, f'보드 {board}')} [{node['col']},{node['row']}] {node.get('name', '')} ({kind})"
        if detail:
            effects = ", ".join(effect.get("desc", "") for effect in node.get("effectList", []))
            text += f" {effects} #{node_id}"
        return text

    # 노드 변경 한 번에 따라오는 포인트 갱신, 응답, 전투력 갱신을 한 묶음으로 정리합니다.
    def collect(self, time, kind, value):
        group = self.group
        if group is not None:
            # 변경 한 번은 포인트 갱신으로 시작합니다. 응답과 전투력 갱신은 클라이언트에 따라 순서가 다르므로
            # 다음 포인트 갱신이 오거나, 응답까지 받은 묶음에 전투력 갱신이 또 오면 묶음을 닫습니다.
            if (kind == "points" and (group["powers"] or group["nodes"])) or (
                    kind == "powers" and group["powers"] and group["nodes"]):
                self.flush(time)
                group = None
        if group is None:
            group = self.group = {"nodes": [], "points": [], "powers": []}
        group[kind].append(value)
        group["time"] = time
        if kind != "powers":
            # 변경 직전에 온 미확인 프레임도 함께 보여 줍니다.
            for at, text in self.recent:
                if time - at <= GROUP_GAP:
                    self.say(at, "??", text)
            self.recent.clear()

    def changing(self):
        """포인트 갱신이나 노드 응답이 든 묶음이 열려 있는지 봅니다."""
        return self.group is not None and bool(self.group["nodes"] or self.group["points"])

    def flush(self, time=None):
        group, self.group = self.group, None
        if group is None:
            return
        time = group["time"] if time is None else time
        powers = group["powers"]
        before, after, best = (powers[0][0], powers[-1][1], powers[-1][2]) if powers else (None, None, None)
        if before is not None:
            change = f"{before:,} → {after:,} ({after - before:+,})"
        elif after is not None:
            change = f"전투력 {after:,} (이전 값 모름)"
        else:
            change = "전투력 갱신 없음"
        # 이전 값을 모르는 첫 포인트 갱신은 None으로 들어 있습니다.
        points = ", ".join(text for text in group["points"] if text)
        if group["nodes"]:
            entries = list(dict.fromkeys(group["nodes"]))
            verdict = ""
            if self.records is not None and before is not None and len(entries) == 1:
                verdict = self.records.judge(group["time"], entries[0], before, after, self.nodes)
            self.say(time, "=>", f"{' + '.join(entry[0] for entry in entries)}: {change}{verdict}")
        elif points:
            self.say(time, "=>", f"노드 응답 없는 포인트 변경({points}): {change}")
        elif after is None:
            return
        elif before is None:
            self.say(time, "=>", f"현재 전투력 {after:,} · 최고 {best:,}")
        elif after != before and group["points"]:
            self.say(time, "=>", f"노드 응답 없는 포인트 갱신(이전 값 모름): {change}")
        elif after != before:
            self.say(time, "=>", f"전투력만 변경: {change}")

    def tick(self, time):
        if self.group is not None and time - self.group["time"] > GROUP_GAP:
            self.flush()

    def handle(self, time, command, payload):
        if not self.started:
            self.started = True
            self.say(time, "##", "프레임 판독을 시작했습니다. 게임에서 노드를 변경하십시오.")
        self.tick(time)
        if command == POWER_OPCODE:
            self.on_power(time, payload)
        elif command in (OPEN_RESPONSE, CLOSE_RESPONSE):
            self.on_node(time, command, payload)
        elif command in (POINTS, ITEM_POINTS):
            self.on_points(time, command, payload)
        elif command == BOARD_INFO:
            self.on_boards(time, payload)
        elif command == OPEN_NOTICE:
            self.on_notice(time, payload)
        elif command == RESET_RESPONSE:
            self.on_reset(time, payload)
        elif command == ROUTE_RESPONSE:
            self.on_route(time, command, payload)
        elif command[1] in DAEVANION_GROUPS:
            # 이 범위에는 데바니온 밖의 패킷도 많아, 노드 변경 전후의 것만 보여 줍니다.
            text = f"미확인 0x{command.hex().upper()} ({len(payload)}바이트) {hexdump(payload)}"
            if self.changing():
                self.say(time, "??", text)
            else:
                self.recent.append((time, text))
        elif self.changing() and len(payload) <= 4096:
            if route_nodes(payload):
                self.on_route(time, command, payload)
            else:
                self.on_other(time, command, payload)

    def on_power(self, time, payload):
        if len(payload) != 16:
            return self.say(time, "??", f"전투력 갱신의 길이가 다릅니다 ({len(payload)}바이트) {hexdump(payload)}")
        power, best = struct.unpack("<QQ", payload)
        if not (0 < power <= MAX_POWER and 0 < best <= MAX_POWER):
            return self.say(time, "??", f"전투력 갱신의 값이 범위를 벗어났습니다 {hexdump(payload)}")
        previous, self.power = self.power, power
        change = "" if previous is None else f" ({power - previous:+,})"
        self.say(time, "  ", f"전투력 {power:,}{change} · 최고 {best:,}")
        self.collect(time, "powers", (previous, power, best))

    def on_node(self, time, command, payload):
        action = "열기" if command == OPEN_RESPONSE else "닫기"
        if len(payload) != 6:
            return self.say(time, "??", f"{action} 응답의 길이가 다릅니다 ({len(payload)}바이트) {hexdump(payload)}")
        result, node_id = struct.unpack("<HI", payload)
        if result:
            # 실패한 요청은 포인트와 전투력이 바뀌지 않으므로 묶지 않습니다.
            reason = RESULTS.get(result, "실패")
            self.say(time, "=>", f"{action} 실패({reason} {result}) {self.describe(node_id, detail=True)}")
        else:
            self.say(time, "  ", f"{action} 응답 성공 · {self.describe(node_id, detail=True)}")
            self.collect(time, "nodes", (f"{action} {self.describe(node_id)}", action, node_id))

    def on_points(self, time, command, payload):
        label = "포인트" if command == POINTS else "아이템 포인트"
        points = point_list(payload)
        if points is None:
            return self.say(time, "??", f"{label} 갱신을 읽지 못했습니다 ({len(payload)}바이트) {hexdump(payload)}")
        known = self.points[command]
        shown = []
        changed = []
        first = False
        for kind, value in points:
            name = POINT_NAMES.get(kind, f"종류 {kind}")
            previous = known.get(kind)
            known[kind] = value
            shown.append(f"{name} {value:,}" + ("" if previous is None else f" ({value - previous:+,})"))
            if previous is None:
                first = True
            elif value != previous:
                changed.append(f"{label} {name} {value - previous:+,}")
        self.say(time, "  ", f"{label} 갱신 · {', '.join(shown)}")
        # 이전 값을 모르는 첫 갱신도 묶음에 남겨, 응답 없이 포인트만 바뀐 변경을 놓치지 않습니다.
        for text in changed or ([None] if first else []):
            self.collect(time, "points", text)

    def on_boards(self, time, payload):
        boards = board_lists(payload)
        if boards is None:
            return self.say(time, "??", f"보드 정보를 읽지 못했습니다 ({len(payload)}바이트) {hexdump(payload)}")
        counts = ", ".join(f"{BOARD_NAMES.get(board, f'보드 {board}')} {len(nodes)}개" for board, nodes in boards.items())
        self.say(time, "=>", f"보드 정보(로그인): {counts}, 합계 {sum(map(len, boards.values()))}개")

    def on_notice(self, time, payload):
        nodes = node_list(payload)
        if nodes is None:
            return self.say(time, "??", f"열림 알림을 읽지 못했습니다 ({len(payload)}바이트) {hexdump(payload)}")
        self.say(time, "  ", f"열림 알림 {len(nodes)}개 · {'; '.join(self.describe(node, detail=True) for node in nodes)}")
        for node in nodes:
            self.collect(time, "nodes", (f"열림 {self.describe(node)}", None, None))

    def on_route(self, time, command, payload):
        label = "경로 열기" if command == ROUTE_RESPONSE else f"노드 목록 0x{command.hex().upper()}"
        route = route_nodes(payload)
        if route is None:
            return self.say(time, "??", f"{label} 응답을 읽지 못했습니다 ({len(payload)}바이트) {hexdump(payload)}")
        result, board, nodes = route
        name = BOARD_NAMES.get(board, f"보드 {board}")
        if result:
            return self.say(time, "=>", f"{label} 실패({RESULTS.get(result, '실패')} {result}) {name}")
        cost = sum(GRADES.get(self.nodes.get(node, {}).get("grade"), ("", 0))[1] for node in nodes)
        cells = " · ".join(self.cell(node) for node in nodes)
        self.say(time, "  ", f"{label} 응답 성공 · {name} {len(nodes)}개")
        self.collect(time, "nodes", (f"{label} {name} {len(nodes)}개(소모 {cost}) {cells}", "route", tuple(nodes)))

    def cell(self, node_id):
        node = self.nodes.get(node_id)
        if node is None:
            return f"#{node_id}"
        grade = GRADES.get(node.get("grade"))
        return f"[{node['col']},{node['row']}] {node.get('name', '')}" + (f"({grade[0]})" if grade else "")

    def on_reset(self, time, payload):
        if len(payload) not in (3, 4, 6):
            return self.say(time, "??", f"보드 초기화 응답의 길이가 다릅니다 ({len(payload)}바이트) {hexdump(payload)}")
        result = struct.unpack_from("<H", payload)[0]
        board = int.from_bytes(payload[2:], "little")
        name = BOARD_NAMES.get(board, f"보드 {board}")
        self.say(time, "  ", f"보드 초기화 응답 {'성공' if not result else f'실패({result})'} · {name}")
        self.collect(time, "nodes", (f"초기화{'' if not result else f' 실패({result})'} {name}", None, None))

    def on_other(self, time, command, payload):
        """변경 직후의 다른 프레임에 알려진 노드 번호가 들어 있으면 후보로 표시합니다."""
        found = []
        for offset in range(len(payload) - 3):
            node_id = int.from_bytes(payload[offset:offset + 4], "little")
            if node_id in self.nodes and node_id not in found:
                found.append(node_id)
        if found:
            names = "; ".join(self.describe(node) for node in found[:8])
            self.say(time, "??", f"노드 번호가 든 프레임 0x{command.hex().upper()} ({len(payload)}바이트) {names} · {hexdump(payload)}")


class Tee:
    """읽은 캡처를 파일에도 남깁니다."""

    def __init__(self, source, path):
        self.source = source
        self.name = str(path)
        self.copy = open(path, "wb")

    def read(self, size=-1):
        data = self.source.read(size)
        self.copy.write(data)
        self.copy.flush()
        return data

    def close(self):
        self.copy.close()
        self.source.close()


def watch(source, args, watcher):
    for time, (command, payload) in captured(source, args, FrameStream):
        watcher.handle(time, command, payload)
    watcher.flush()


def watch_live(args, watcher):
    command = capture_command(args)
    if args.sudo:
        command.insert(0, "sudo")

    def silent(_signal, _frame):
        if not watcher.started:
            print(f"## 아직 받은 프레임이 없습니다. 게임 연결, 인터페이스({args.interface}), 포트({args.port})를 확인하십시오.", flush=True)

    print(f"## 캡처를 시작합니다: {' '.join(command)}", flush=True)
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    source = Tee(process.stdout, args.save) if args.save else process.stdout
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, silent)
        signal.alarm(SILENCE)
    try:
        watch(source, args, watcher)
    finally:
        watcher.flush()
        source.close()
        if process.poll() is None:
            try:
                process.terminate()
            except PermissionError:
                # sudo로 띄운 캡처는 터미널의 Ctrl-C나 끊긴 출력으로 끝납니다.
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
    if process.returncode == 1 and not watcher.started:
        raise ValueError(f"tcpdump가 캡처를 시작하지 못했습니다(종료 코드 {process.returncode}). 캡처 권한이 없으면 --sudo를 붙이십시오.")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--interface", help="캡처할 네트워크 인터페이스. Ctrl-C로 끝낼 때까지 계속 읽습니다.")
    source.add_argument("--read", metavar="PCAP", help="저장한 pcap 또는 pcapng를 읽습니다. -는 표준 입력입니다.")
    parser.add_argument("--sudo", action="store_true", help="tcpdump만 sudo로 실행합니다.")
    parser.add_argument("--save", metavar="PCAP", help="받은 캡처를 파일에도 저장합니다.")
    parser.add_argument("--port", type=int, default=GAME_PORT, help="서버 TCP 포트. 기본값 13328")
    parser.add_argument("--client-port", type=int, help="로컬 TCP 포트로 연결을 좁힙니다.")
    parser.add_argument("--server", type=ipaddress.ip_address, help="서버 IP로 연결을 좁힙니다.")
    parser.add_argument("--before", type=int, help="시작할 때의 전투력. 첫 변화의 차이를 표시합니다.")
    parser.add_argument("--boards", default=pathlib.Path(__file__).resolve().parent.parent / "boards",
                        help="노드 이름을 읽을 보드 원본 폴더")
    parser.add_argument("--measurements", metavar="JSON", help="비교할 측정 기록. 기본값은 보드 폴더의 measurements.json")
    parser.add_argument("--record", action="store_true",
                        help="노드 하나의 변화량이 그 옵션의 기록에 없던 값이면 측정 기록에 추가합니다.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or (args.client_port is not None and not 1 <= args.client_port <= 65535):
        parser.error("포트는 1~65535 범위로 지정하십시오.")
    if args.before is not None and not 0 < args.before <= MAX_POWER:
        parser.error("전투력은 1~5000000 범위로 입력하십시오.")
    if (args.sudo or args.save) and not args.interface:
        parser.error("--sudo와 --save는 --interface와 함께 사용하십시오.")
    args.server = str(args.server) if args.server else None
    return args


def main():
    args = parse_args()
    nodes = load_nodes(args.boards)
    measurements = pathlib.Path(args.measurements or pathlib.Path(args.boards) / "measurements.json")
    if args.record and not measurements.exists():
        print(f"측정 기록 파일이 없습니다: {measurements}", file=sys.stderr)
        return 1
    records = Records(measurements, nodes, write=args.record) if measurements.exists() else None
    watcher = Watcher(nodes, args.before, records=records)
    code = 0
    try:
        if args.interface:
            watch_live(args, watcher)
        else:
            watch(sys.stdin.buffer if args.read == "-" else args.read, args, watcher)
    except (OSError, ValueError, Scapy_Exception) as error:
        print(error, file=sys.stderr)
        code = 1
    except KeyboardInterrupt:
        code = 130
    watcher.flush()
    print(f"## 종료: 프레임 {STATS['frames']:,}개, 압축 묶음 {STATS['bundles']:,}개, 재정렬 {STATS['resyncs']:,}건", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
