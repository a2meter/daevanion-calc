"""데바니온 링크(link/)의 페이로드, 상태 추적, 캡처 판독을 확인합니다.

페이로드 시험은 표준 라이브러리만으로 돕니다. 나머지는 scapy와 lz4가 있어야 하며, 없으면 건너뜁니다.
"""

import base64
import contextlib
import importlib.util
import io
import os
import pathlib
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "link"))

import link_payload  # noqa: E402

# measure_cp는 라이브러리가 없으면 sys.exit로 끝나므로, 가져오기 전에 있는지부터 봅니다.
HAVE_LIBS = all(importlib.util.find_spec(name) is not None for name in ("scapy", "lz4"))
NEED_LIBS = unittest.skipUnless(HAVE_LIBS, "scapy와 lz4가 없어 건너뜁니다.")
if HAVE_LIBS:
    import daevanion_link
    import link_capture
    import link_core
    import measure_cp
    import watch_daevanion
    from scapy.all import IP, TCP, Ether, Raw, rdpcap, wrpcap


# ── 페이로드의 바이트 단위 예시 ─────────────────────────────────────────

EXAMPLE = {
    "version": 1,
    "boardsComplete": True,
    "skillsComplete": True,
    "capturedAt": 1794553175,       # 2026-11-13 06:59:35 UTC
    "power": 975724,
    "bestPower": 1019394,
    "boards": [
        {"boardId": 71, "nodeIds": [710113]},
        {"boardId": 79, "nodeIds": [790001, 790016, 790113, 790225]},
    ],
    "skills": [
        {"skillId": 17040250, "level": 20, "daevanionLevels": 0},
        {"skillId": 17750000, "level": 17, "daevanionLevels": 4},
    ],
}
EXAMPLE_BYTES = bytes.fromhex(
    "4456" "01" "03"                        # "DV", 버전 1, 플래그(보드 완료 + 스킬 완료)
    "57b5f66a" "6ce30e00" "028e0f00"        # capturedAt, power, bestPower
    "02"                                    # 보드 2개
    "47" "0000000000000000000000000000" "01" "0000000000000000000000000000"   # 71: 113번(비트 112)
    "4f" "0180" "000000000000000000000000" "01" "00000000000000000000000000" "01"  # 79: 1, 16, 113, 225번
    "02"                                    # 스킬 2개
    "7a030401" "14" "00"                    # 17040250, 레벨 20, 데바니온 0
    "f0d70e01" "11" "04"                    # 17750000, 레벨 17, 데바니온 4
)
EXAMPLE_TEXT = ("RFYBA1e19mps4w4AAo4PAAJHAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABPAYAAAAAAAAAAAAAAAAAB"
                "AAAAAAAAAAAAAAAAAAECegMEARQA8NcOAREE")


class PayloadTests(unittest.TestCase):
    def test_example_is_byte_exact(self):
        self.assertEqual(len(EXAMPLE_BYTES), 16 + 1 + 2 * 30 + 1 + 2 * 6)
        self.assertEqual(link_payload.pack(EXAMPLE), EXAMPLE_BYTES)
        self.assertEqual(link_payload.encode(EXAMPLE), EXAMPLE_TEXT)
        self.assertEqual(base64.urlsafe_b64decode(EXAMPLE_TEXT), EXAMPLE_BYTES)
        self.assertEqual(link_payload.decode(EXAMPLE_TEXT), EXAMPLE)

    def test_decode_accepts_a_link(self):
        url = "https://daevanion.a2meter.workers.dev/#link=" + EXAMPLE_TEXT
        self.assertEqual(link_payload.decode(url), EXAMPLE)
        self.assertEqual(link_payload.decode(f"  {url}&x=1\n"), EXAMPLE)

    def test_every_node_bit_round_trips(self):
        for index in range(1, 226):
            data = dict(EXAMPLE, boards=[{"boardId": 72, "nodeIds": [720000 + index]}])
            raw = link_payload.pack(data)
            bitmap = raw[18:47]
            self.assertEqual(bitmap[(index - 1) // 8], 1 << ((index - 1) % 8), index)
            self.assertEqual(sum(bitmap), 1 << ((index - 1) % 8), index)
            self.assertEqual(link_payload.unpack(raw)["boards"], data["boards"])
        full = dict(EXAMPLE, boards=[{"boardId": 255, "nodeIds": [2550000 + index for index in range(1, 226)]}])
        raw = link_payload.pack(full)
        self.assertEqual(raw[18:47], b"\xff" * 28 + b"\x01")
        self.assertEqual(link_payload.unpack(raw), full)

    def test_flags_and_empty_state(self):
        empty = {"boards": [], "skills": []}
        raw = link_payload.pack(empty)
        self.assertEqual(raw, b"DV\x01\x00" + bytes(12) + b"\x00\x00")
        decoded = link_payload.unpack(raw)
        self.assertFalse(decoded["boardsComplete"] or decoded["skillsComplete"])
        self.assertEqual(link_payload.pack(dict(empty, boardsComplete=True))[3], 1)
        self.assertEqual(link_payload.pack(dict(empty, skillsComplete=True))[3], 2)
        # 쓰지 않는 플래그 비트와 비트맵의 남는 비트는 읽을 때 무시합니다.
        raw = bytearray(EXAMPLE_BYTES)
        raw[3] |= 0xF0
        raw[18 + 28] |= 0xFE
        self.assertEqual(link_payload.unpack(bytes(raw)), EXAMPLE)

    def test_out_of_range_boards_and_nodes_are_skipped(self):
        data = dict(EXAMPLE, boards=[
            {"boardId": 256, "nodeIds": [2560113]},
            {"boardId": 71, "nodeIds": [710113, 710000, 710226, 720113]},
            {"boardId": 3, "nodeIds": [30001]},
        ])
        decoded = link_payload.decode(link_payload.encode(data))
        self.assertEqual(decoded["boards"], [{"boardId": 3, "nodeIds": [30001]}, {"boardId": 71, "nodeIds": [710113]}])

    def test_boards_and_skills_are_sorted(self):
        data = dict(EXAMPLE, boards=list(reversed(EXAMPLE["boards"])), skills=list(reversed(EXAMPLE["skills"])))
        self.assertEqual(link_payload.pack(data), EXAMPLE_BYTES)

    def test_decode_rejects_malformed_data(self):
        def text(raw):
            return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

        swapped = EXAMPLE_BYTES[:17] + EXAMPLE_BYTES[47:77] + EXAMPLE_BYTES[17:47] + EXAMPLE_BYTES[77:]
        for label, bad in (
            ("빈 문자열", ""),
            ("base64url이 아님", "RFYB*A=="),
            ("길이", "RFYBA"),
            ("머리말", text(b"XX" + EXAMPLE_BYTES[2:])),
            ("버전", text(EXAMPLE_BYTES[:2] + b"\x02" + EXAMPLE_BYTES[3:])),
            ("짧음", text(EXAMPLE_BYTES[:17])),
            ("보드가 끊김", text(EXAMPLE_BYTES[:40])),
            ("스킬이 끊김", text(EXAMPLE_BYTES[:-1])),
            ("남는 바이트", text(EXAMPLE_BYTES + b"\x00")),
            ("보드 순서", text(swapped)),
            ("스킬 순서", text(EXAMPLE_BYTES[:78] + EXAMPLE_BYTES[84:] + EXAMPLE_BYTES[78:84])),
        ):
            with self.subTest(label), self.assertRaises(ValueError):
                link_payload.decode(bad)

    def test_values_must_fit_their_fields(self):
        for change in ({"power": -1}, {"capturedAt": 1 << 32},
                       {"skills": [{"skillId": 1, "level": 256, "daevanionLevels": 0}]},
                       {"skills": [{"skillId": index, "level": 1, "daevanionLevels": 0} for index in range(256)]}):
            with self.subTest(change), self.assertRaises(ValueError):
                link_payload.pack(dict(EXAMPLE, **change))

    def test_fit_drops_skills_without_daevanion_levels_first(self):
        skills = [{"skillId": 1000 + index, "level": 5, "daevanionLevels": 1 if index % 10 == 0 else 0}
                  for index in range(300)]
        data = dict(EXAMPLE, skills=skills)
        whole = len(link_payload.pack(dict(data, skills=[])))
        # 스킬 40개가 들어갈 만큼만 줍니다. 패딩 없는 base64url은 n바이트가 ceil(4n/3)글자입니다.
        limit = -(-(whole + 40 * 6) * 4 // 3)
        fitted, dropped = link_payload.fit(data, limit)
        self.assertEqual((len(fitted["skills"]), dropped), (40, 260))
        self.assertLessEqual(len(link_payload.encode(fitted)), limit)
        self.assertFalse(fitted["skillsComplete"])
        kept = [skill["skillId"] for skill in fitted["skills"]]
        boosted = [skill["skillId"] for skill in skills if skill["daevanionLevels"]]
        self.assertEqual(kept, sorted(boosted + [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1011]))
        self.assertTrue(data["skillsComplete"])
        # 넉넉하면 그대로 둡니다. 다만 255개는 넘길 수 없습니다.
        same, dropped = link_payload.fit(EXAMPLE, 2000)
        self.assertEqual((same, dropped), (EXAMPLE, 0))
        capped, dropped = link_payload.fit(data, 100000)
        self.assertEqual((len(capped["skills"]), dropped), (255, 45))
        with self.assertRaises(ValueError):
            link_payload.fit(EXAMPLE, 80)


# ── 시험용 프레임 ───────────────────────────────────────────────────────

def varint(value):
    out = bytearray()
    while True:
        out.append(value & 0x7F | (0x80 if value > 0x7F else 0))
        value >>= 7
        if not value:
            return bytes(out)


def frame(opcode, payload=b""):
    """길이 varint(본문 길이 + 6), 2바이트 명령, 본문입니다."""
    return varint(len(payload) + 6) + opcode + payload


def bundle(*frames):
    """명령 FF FF, 풀린 크기 4바이트, LZ4 블록으로 이루어진 묶음입니다."""
    inner = b"".join(frames)
    return frame(b"\xff\xff", struct.pack("<I", len(inner)) + measure_cp.lz4.compress(inner, store_size=False))


def node(board, index):
    return board * 10000 + index


def nodes(node_ids):
    return varint(len(node_ids)) + struct.pack(f"<{len(node_ids)}I", *node_ids)


def board_info(boards):
    return varint(len(boards)) + b"".join(struct.pack("<I", board) + nodes(ids) for board, ids in boards.items())


def response(node_id, result=0):
    return struct.pack("<HI", result, node_id)


def route(board, node_ids, result=0):
    return struct.pack("<HI", result, board) + nodes(node_ids)


def power(current, best):
    return struct.pack("<QQ", current, best)


def skill_update(skill, level, trained, daevanion, other=(0, 0, 0), tail=(0, 10)):
    """개수 1바이트와 17바이트 항목 하나입니다."""
    return b"\x01" + struct.pack("<IBIB", skill, 1, skill, level) + bytes((trained, daevanion) + other + tail)


def list_record(skill, level, trained, daevanion, extra=None):
    """로그인 스킬 목록의 레코드입니다. extra를 주면 표시가 0x05이고 끝에 1바이트가 붙는 17바이트 레코드입니다."""
    body = struct.pack("<IBBB", skill, level, trained, daevanion) + bytes(8)
    return (b"\x01" + body) if extra is None else (b"\x05" + body + bytes([extra]))


def skill_listing(*records):
    return bytes([len(records)]) + b"".join(records)


LOGIN_BOARDS = {71: [node(71, 113), node(71, 112), node(71, 111)], 79: [node(79, 113)]}
LOGIN_SKILLS = skill_listing(list_record(1003, 1, 1, 0), list_record(17750000, 17, 10, 4),
                             list_record(17100140, 18, 10, 4, extra=3), list_record(17040000, 20, 10, 4))


@NEED_LIBS
class SkillParsingTests(unittest.TestCase):
    def test_login_list_layout(self):
        self.assertEqual(len(LOGIN_SKILLS), 1 + 3 * 16 + 17)
        self.assertEqual(link_core.login_skills(LOGIN_SKILLS),
                         {1003: (1, 0), 17750000: (17, 4), 17100140: (18, 4), 17040000: (20, 4)})
        self.assertEqual(link_core.login_skills(b"\x00"), {})

    def test_login_list_real_records(self):
        """2026-11-13 로그인 목록에서 옮긴 레코드입니다. 17바이트 레코드는 0x05로 시작합니다."""
        records = [bytes.fromhex(text) for text in (
            "01eb0300000101000000000000000000",
            "01e0ce09011919000000000000000000",
            "01b09f04010e0a040000000000000000",
            "05e23f0501140a04000204000000000002",
            "056ced0401120a04000202000000000003",
            "0184b10501110a040001020000000000",
        )]
        self.assertEqual([len(record) for record in records], [16, 16, 16, 17, 17, 16])
        self.assertEqual(link_core.login_skills(skill_listing(*records)), {
            1003: (1, 0), 17420000: (25, 0), 17080240: (14, 4), 17121250: (20, 4), 17100140: (18, 4), 17150340: (17, 4)})

    def test_login_list_is_not_guessed(self):
        record = list_record(17750000, 17, 10, 4)
        long = list_record(17100140, 18, 10, 4, extra=3)
        for label, payload in (
            ("빈 본문", b""),
            ("레코드 수가 많음", bytes([3]) + record + long),
            ("레코드 수가 적음", bytes([1]) + record + long),
            ("모르는 표시", bytes([2]) + record + b"\x02" + record[1:]),
            ("0x01 레코드 뒤에 남는 1바이트", bytes([2]) + record + b"\x03" + record),
            ("0x05 레코드에 끝 바이트가 없음", bytes([2]) + long[:-1] + record),
            ("끊김", bytes([2]) + record + long[:-1]),
            ("남는 바이트", bytes([2]) + record + long + b"\x00"),
        ):
            with self.subTest(label):
                self.assertIsNone(link_core.login_skills(payload))

    def test_skill_update_carries_daevanion_levels(self):
        self.assertEqual(link_core.skill_updates(skill_update(17750000, 17, 10, 4, (0, 0, 3))), [(17750000, 17, 4)])
        # 2026-11-13 캡처의 항목입니다(주신의 은총 31 = 10 + 4 + 0 + 10 + 7).
        real = bytes.fromhex("01" "d0890e01" "01" "d0890e01" "1f" "0a04000a07" "000a")
        self.assertEqual(watch_daevanion.skill_list(real), [(17730000, 31)])
        self.assertEqual(link_core.skill_updates(real), [(17730000, 31, 4)])
        # 합이 레벨과 맞지 않으면 구조가 다른 것으로 보고 데바니온 레벨을 0(모름)으로 둡니다.
        self.assertEqual(link_core.skill_updates(skill_update(17750000, 17, 10, 4, (0, 0, 9))), [(17750000, 17, 0)])
        self.assertEqual(link_core.skill_updates(b"\x02" + bytes(17)), [])


@NEED_LIBS
class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = link_core.Tracker()
        self.time = 1000.0

    def send(self, opcode, payload, connection=1):
        self.time += 1
        return self.tracker.handle(self.time, connection, opcode, payload)

    def login(self, connection=1):
        self.send(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS), connection)
        self.send(link_core.SKILL_LIST, LOGIN_SKILLS, connection)
        return self.tracker.states[connection]

    def test_completion_needs_both_login_packets(self):
        self.assertIsNone(self.tracker.state)
        self.assertTrue(self.send(measure_cp.POWER_OPCODE, power(975724, 1019394)))
        state = self.tracker.state
        self.assertEqual((state.power, state.best_power), (975724, 1019394))
        self.assertFalse(state.boards_complete or state.skills_complete)
        self.assertTrue(self.send(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS)))
        self.assertTrue(state.boards_complete)
        self.assertFalse(state.complete)
        self.assertEqual(state.boards, {71: {710111, 710112, 710113}, 79: {790113}})
        self.assertTrue(self.send(link_core.SKILL_LIST, LOGIN_SKILLS))
        self.assertTrue(state.complete)
        self.assertEqual(state.skills[17750000], (17, 4))
        self.assertEqual(len(state.skills), 4)
        self.assertEqual(state.changed_at, self.time)
        # 같은 내용이 다시 오면 바뀐 것이 없습니다.
        changed_at = state.changed_at
        self.assertFalse(self.send(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS)))
        self.assertFalse(self.send(measure_cp.POWER_OPCODE, power(975724, 1019394)))
        self.assertEqual(state.changed_at, changed_at)
        self.assertEqual(state.seen_at, self.time)

    def test_open_close_route_reset(self):
        state = self.login()
        self.assertTrue(self.send(watch_daevanion.OPEN_RESPONSE, response(node(71, 110))))
        self.assertIn(710110, state.boards[71])
        self.assertFalse(self.send(watch_daevanion.OPEN_RESPONSE, response(node(71, 110))))
        # 실패한 요청은 상태를 바꾸지 않습니다.
        self.assertFalse(self.send(watch_daevanion.OPEN_RESPONSE, response(node(71, 109), result=15582)))
        self.assertNotIn(710109, state.boards[71])
        self.assertFalse(self.send(watch_daevanion.CLOSE_RESPONSE, response(node(71, 112), result=15581)))
        self.assertTrue(self.send(watch_daevanion.CLOSE_RESPONSE, response(node(71, 110))))
        self.assertEqual(state.boards[71], {710111, 710112, 710113})
        self.assertFalse(self.send(watch_daevanion.CLOSE_RESPONSE, response(node(71, 110))))

        # 경로 열기 응답에는 이미 열린 노드가 섞여 올 수 있습니다.
        self.assertTrue(self.send(watch_daevanion.ROUTE_RESPONSE, route(79, [790113, 790114, 790115, 790116])))
        self.assertEqual(state.boards[79], {790113, 790114, 790115, 790116})
        self.assertFalse(self.send(watch_daevanion.ROUTE_RESPONSE, route(79, [790114, 790115])))
        self.assertFalse(self.send(watch_daevanion.ROUTE_RESPONSE, route(79, [790117], result=15582)))
        # 실패한 경로 열기는 노드 목록이 비어 옵니다(실측: 17 00 47 00 00 00 00).
        self.assertFalse(self.send(watch_daevanion.ROUTE_RESPONSE, bytes.fromhex("17004700000000")))
        self.assertNotIn(790117, state.boards[79])

        # 초기화 뒤에는 시작 노드만 남습니다. 응답은 두 번 오고 시작 노드 알림이 따라옵니다.
        self.assertFalse(self.send(watch_daevanion.RESET_RESPONSE, struct.pack("<HI", 15590, 71)))
        self.assertTrue(self.send(watch_daevanion.RESET_RESPONSE, struct.pack("<HI", 0, 71)))
        self.assertEqual(state.boards[71], {710113})
        self.assertFalse(self.send(watch_daevanion.RESET_RESPONSE, struct.pack("<HI", 0, 71)))
        self.assertFalse(self.send(watch_daevanion.OPEN_NOTICE, nodes([710113])))
        self.assertTrue(self.send(watch_daevanion.OPEN_NOTICE, nodes([710114])))
        self.assertEqual(state.boards[71], {710113, 710114})
        self.assertEqual(state.boards[79], {790113, 790114, 790115, 790116})
        self.assertTrue(state.complete)
        self.assertEqual(self.tracker.unreadable, {})

    def test_skill_updates_merge_into_the_login_list(self):
        state = self.login()
        self.assertTrue(self.send(watch_daevanion.SKILL_UPDATE, skill_update(17750000, 18, 10, 5, (0, 0, 3))))
        self.assertEqual(state.skills[17750000], (18, 5))
        # 로그인 목록에 없던 번호도 갱신으로 오면 넣습니다.
        self.assertTrue(self.send(watch_daevanion.SKILL_UPDATE, skill_update(17040250, 20, 10, 4, (0, 1, 5))))
        self.assertEqual(state.skills[17040250], (20, 4))
        self.assertFalse(self.send(watch_daevanion.SKILL_UPDATE, skill_update(17040250, 20, 10, 4, (0, 1, 5))))
        self.assertEqual(len(state.skills), 5)
        payload = state.to_payload()
        self.assertEqual([skill["skillId"] for skill in payload["skills"]], sorted(state.skills))
        self.assertIn({"skillId": 17750000, "level": 18, "daevanionLevels": 5}, payload["skills"])

    def test_unreadable_skill_list_leaves_skills_incomplete(self):
        self.send(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS))
        state = self.tracker.state
        self.assertTrue(self.send(link_core.SKILL_LIST, LOGIN_SKILLS + b"\x00"))
        self.assertTrue(state.skills_unreadable)
        self.assertFalse(state.skills_complete)
        self.assertEqual(state.skills, {})
        self.assertEqual(self.tracker.unreadable, {link_core.SKILL_LIST: 1})
        self.assertIn("스킬 목록을 읽지 못했습니다", link_core.status_text("capturing", state))
        self.assertIn("읽지 못함", link_core.summary(state)[0])
        # 이후에 읽히는 목록이 오면 완료됩니다.
        self.assertTrue(self.send(link_core.SKILL_LIST, LOGIN_SKILLS))
        self.assertTrue(state.complete)
        self.assertFalse(state.skills_unreadable)

    def test_changes_before_login_do_not_complete_the_boards(self):
        self.send(watch_daevanion.OPEN_RESPONSE, response(node(72, 100)))
        self.send(watch_daevanion.RESET_RESPONSE, struct.pack("<HI", 0, 73))
        self.send(watch_daevanion.SKILL_UPDATE, skill_update(17750000, 17, 10, 4, (0, 0, 3)))
        state = self.tracker.state
        self.assertEqual(state.boards, {72: {720100}, 73: {730113}})
        self.assertFalse(state.boards_complete or state.skills_complete)
        self.assertIn("보드 정보를 받지 못했습니다", link_core.status_text("capturing", state))
        # 접속 정보가 오면 그 내용으로 바꿉니다.
        self.login()
        self.assertEqual(sorted(state.boards), [71, 79])
        self.assertTrue(state.complete)

    def test_each_connection_keeps_its_own_state(self):
        first = self.login(connection=1)
        self.send(watch_daevanion.OPEN_RESPONSE, response(node(71, 110)), connection=1)
        self.assertEqual(self.tracker.current, 1)
        # 모르는 프레임은 화면에 보일 연결을 바꾸지 않습니다.
        self.assertFalse(self.send(b"\x12\x34", b"", connection=2))
        self.assertEqual(self.tracker.current, 1)
        # 새 연결에서 아는 패킷이 오면 그 연결을 보여 주고, 접속 정보가 올 때까지는 완료가 아닙니다.
        self.assertTrue(self.send(measure_cp.POWER_OPCODE, power(900000, 1019394), connection=2))
        self.assertEqual(self.tracker.current, 2)
        second = self.tracker.state
        self.assertFalse(second.complete)
        self.assertEqual(second.boards, {})
        self.assertTrue(first.complete)
        self.assertEqual(first.boards[71], {710110, 710111, 710112, 710113})
        self.login(connection=2)
        self.assertEqual(second.boards[71], {710111, 710112, 710113})
        self.assertTrue(second.complete)

    def test_lost_packets_withdraw_completion(self):
        state = self.login()
        self.assertTrue(self.tracker.dispatch(self.time, 1, link_core.LOST, b""))
        self.assertTrue(state.lost)
        self.assertFalse(state.boards_complete or state.skills_complete)
        self.assertIn("패킷 일부를 놓쳐", link_core.status_text("capturing", state))
        # 다시 접속해 두 가지를 모두 받으면 믿을 수 있습니다.
        self.login()
        self.assertTrue(state.complete)
        self.assertFalse(state.lost)
        # 접속 정보를 받은 적 없는 연결은 놓쳐도 달라질 것이 없습니다.
        self.assertFalse(self.tracker.dispatch(self.time, 9, link_core.LOST, b""))

    def test_malformed_frames_are_counted_and_ignored(self):
        state = self.login()
        before = state.to_payload()
        for opcode, payload in ((watch_daevanion.OPEN_RESPONSE, b"\x00"), (watch_daevanion.BOARD_INFO, b"\x05\x01"),
                                (measure_cp.POWER_OPCODE, bytes(16)), (watch_daevanion.RESET_RESPONSE, b"\x00"),
                                (watch_daevanion.OPEN_RESPONSE, response(node(71, 226))),
                                (watch_daevanion.SKILL_UPDATE, b"\x03"), (watch_daevanion.OPEN_NOTICE, b"\x01")):
            self.assertFalse(self.send(opcode, payload), opcode.hex())
        after = state.to_payload()
        self.assertEqual(dict(after, capturedAt=0), dict(before, capturedAt=0))
        self.assertEqual(sum(self.tracker.unreadable.values()), 7)

    def test_frames_from_a_stream_including_an_lz4_bundle(self):
        data = (frame(measure_cp.POWER_OPCODE, power(970000, 1019394))
                + bundle(frame(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS)), frame(b"\x99\x99", b"x" * 300),
                         frame(link_core.SKILL_LIST, LOGIN_SKILLS))
                + frame(watch_daevanion.OPEN_RESPONSE, response(node(79, 114))))
        stream = watch_daevanion.FrameStream(aligned=True)
        found = stream.feed(data[:25]) + stream.feed(data[25:])
        self.assertEqual([command.hex() for command, _payload in found], ["5636", "26e2", "9999", "0051", "28e2"])
        for command, payload in found:
            self.send(command, payload)
        state = self.tracker.state
        self.assertTrue(state.complete)
        self.assertEqual(state.boards[79], {790113, 790114})
        self.assertEqual(state.frames, 5)


# ── 캡처 파일 ───────────────────────────────────────────────────────────

SERVER, CLIENT = "10.0.0.1", "10.0.0.2"


def session_stream():
    """접속, 노드 변경, 스킬 갱신이 이어지는 서버 스트림입니다."""
    return b"".join((
        frame(measure_cp.POWER_OPCODE, power(970000, 1019394)),
        bundle(frame(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS)), frame(link_core.SKILL_LIST, LOGIN_SKILLS)),
        frame(b"\x4a\x36", b"\x01\x01" + struct.pack("<Hi", 19, 1100) + bytes(8)),
        frame(watch_daevanion.OPEN_RESPONSE, response(node(79, 114))),
        frame(watch_daevanion.ROUTE_RESPONSE, route(79, [790114, 790115, 790116])),
        frame(watch_daevanion.CLOSE_RESPONSE, response(node(71, 111))),
        frame(watch_daevanion.SKILL_UPDATE, skill_update(17750000, 18, 10, 5, (0, 0, 3))),
        frame(b"\x77\x77", b"y" * 700),
        frame(watch_daevanion.RESET_RESPONSE, struct.pack("<HI", 0, 71)),
        frame(watch_daevanion.OPEN_NOTICE, nodes([710113])),
        frame(measure_cp.POWER_OPCODE, power(972345, 1019394)),
    ))


def tcp_packets(stream, cuts, client_port=50123, sequence=7000, start=1794553000.0, order=None, syn=True):
    """스트림을 cuts 위치에서 잘라 서버→클라이언트 패킷으로 만듭니다. order로 보내는 순서를 바꿉니다."""
    base = Ether(src="02:00:00:00:00:01", dst="02:00:00:00:00:02") / IP(src=SERVER, dst=CLIENT)
    packets = []
    if syn:
        packets.append(base / TCP(sport=13328, dport=client_port, seq=sequence, flags="SA"))
    bounds = [0] + list(cuts) + [len(stream)]
    segments = [base / TCP(sport=13328, dport=client_port, seq=sequence + 1 + low, flags="PA") / Raw(stream[low:high])
                for low, high in zip(bounds, bounds[1:])]
    packets += [segments[index] for index in (order or range(len(segments)))]
    for index, packet in enumerate(packets):
        packet.time = start + index * 0.25
    return packets


@NEED_LIBS
class CaptureFileTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.stream = session_stream()
        # 프레임 중간에서 자르고, 한 조각은 순서를 바꾸고, 한 조각은 다시 보냅니다.
        self.packets = tcp_packets(self.stream, [10, 40, 200, 420, 900], order=[0, 1, 3, 2, 2, 4, 5])
        self.path = str(self.folder / "session.pcap")
        wrpcap(self.path, self.packets)

    def expect_final(self, state):
        self.assertTrue(state.complete)
        self.assertEqual(state.boards, {71: {710113}, 79: {790113, 790114, 790115, 790116}})
        self.assertEqual(state.skills, {1003: (1, 0), 17040000: (20, 4), 17100140: (18, 4), 17750000: (18, 5)})
        self.assertEqual((state.power, state.best_power), (972345, 1019394))
        self.assertEqual(state.stats, {19: 1100})
        self.assertEqual(state.frames, 12)

    def test_offline_read(self):
        tracker = link_core.read_capture(self.path)
        self.assertEqual(list(tracker.states), [1])
        self.assertEqual(tracker.unreadable, {})
        state = tracker.state
        self.expect_final(state)
        self.assertFalse(state.lost)
        self.assertEqual(state.seen_at, self.packets[-1].time)
        self.assertEqual(state.changed_at, self.packets[-1].time)
        decoded = link_core.decode(link_core.link_url(link_core.DEFAULT_SITE, state))
        self.assertEqual(decoded, state.to_payload())
        self.assertEqual(decoded["capturedAt"], int(self.packets[-1].time))
        self.assertEqual(decoded["boards"], [{"boardId": 71, "nodeIds": [710113]},
                                             {"boardId": 79, "nodeIds": [790113, 790114, 790115, 790116]}])

    def test_frames_match_the_existing_parser(self):
        args = types.SimpleNamespace(port=13328, client_port=None, server=None)
        expected = [(time, command, payload)
                    for time, (command, payload) in measure_cp.captured(self.path, args, watch_daevanion.FrameStream)]
        demux = link_core.Demux()
        found = [event for packet in rdpcap(self.path) for event in demux.feed(packet)]
        self.assertEqual([(time, command, payload) for time, _connection, command, payload in found], expected)
        self.assertEqual({connection for _time, connection, _command, _payload in found}, {1})
        self.assertEqual(len(expected), 12)

    def test_second_connection_replaces_the_first(self):
        again = b"".join((frame(watch_daevanion.BOARD_INFO, board_info({72: [720113]})),
                          frame(measure_cp.POWER_OPCODE, power(900001, 1019394))))
        later = tcp_packets(again, [20], client_port=50999, sequence=91000, start=1794556000.0)
        wrpcap(self.path, self.packets + later)
        tracker = link_core.read_capture(self.path)
        self.assertEqual(list(tracker.states), [1, 2])
        self.expect_final(tracker.states[1])
        state = tracker.state
        self.assertIs(state, tracker.states[2])
        self.assertEqual(state.boards, {72: {720113}})
        self.assertTrue(state.boards_complete)
        self.assertFalse(state.skills_complete)
        self.assertEqual(state.skills, {})

    def test_missing_segment_withdraws_completion(self):
        # 가운데 조각이 통째로 빠지면 뒤 조각은 기다리다 버려지고, 큰 공백 뒤에는 완료 표시를 거둡니다.
        packets = tcp_packets(self.stream, [10, 40, 200, 420, 900])
        far = packets[-1].copy()
        far[TCP].seq += measure_cp.MAX_FRAME + 100
        far.time = packets[-1].time + 1
        wrpcap(self.path, packets[:5] + [far])
        state = link_core.read_capture(self.path).state
        self.assertTrue(state.lost)
        self.assertFalse(state.boards_complete or state.skills_complete)

    def test_mid_connection_capture_is_incomplete(self):
        tail = b"".join(frame(watch_daevanion.OPEN_RESPONSE, response(node(72, index))) for index in range(1, 9))
        wrpcap(self.path, tcp_packets(tail, [30], syn=False))
        state = link_core.read_capture(self.path).state
        self.assertEqual(state.boards, {72: {720000 + index for index in range(1, 9)}})
        self.assertFalse(state.boards_complete)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = daevanion_link.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_cli_read_prints_summary_and_link(self):
        code, out, err = self.run_cli("--read", self.path)
        self.assertEqual((code, err), (0, ""))
        self.assertIn("루미엘 (79): 열린 노드 4개", out)
        self.assertIn("네자칸 (71): 열린 노드 1개", out)
        self.assertIn("전투력: 972,345 · 최고 1,019,394", out)
        self.assertIn("스킬: 4개", out)
        link = out.strip().splitlines()[-1]
        self.assertTrue(link.startswith("링크: https://daevanion.a2meter.workers.dev/#link=RFYBA"), link)
        state = link_core.read_capture(self.path).state
        self.assertEqual(link_payload.decode(link), state.to_payload())

        code, out, _err = self.run_cli("--read", self.path, "--print-link", "--site", "http://localhost:8787")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "http://localhost:8787/#link=" + link_payload.encode(state))

        code, out, _err = self.run_cli("--decode", link)
        self.assertEqual(code, 0)
        self.assertIn('"boardsComplete": true', out)

    def test_cli_read_fails_when_incomplete(self):
        partial = str(self.folder / "partial.pcap")
        wrpcap(partial, tcp_packets(frame(watch_daevanion.BOARD_INFO, board_info(LOGIN_BOARDS)), []))
        code, out, err = self.run_cli("--read", partial)
        self.assertEqual(code, 1)
        self.assertIn("스킬 목록: 받지 못함", out)
        self.assertIn("스킬 목록을 기다리고 있습니다", err)
        self.assertFalse(link_payload.decode(out.strip().splitlines()[-1])["skillsComplete"])

        empty = str(self.folder / "empty.pcap")
        wrpcap(empty, [Ether(src="02:00:00:00:00:02", dst="02:00:00:00:00:01") / IP(src=CLIENT, dst=SERVER)
                       / TCP(sport=50123, dport=13328, flags="S")])
        code, out, err = self.run_cli("--read", empty)
        self.assertEqual(code, 1)
        self.assertIn("프레임이 없습니다", out)

        code, _out, err = self.run_cli("--read", str(self.folder / "missing.pcap"))
        self.assertEqual(code, 1)
        self.assertIn("캡처를 읽지 못했습니다", err)

        code, out, err = self.run_cli("--read", self.path, "--site", "ftp://example.com")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("http 또는 https", err)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            daevanion_link.main(["--print-link"])

    # ── 실시간 캡처 경로 ──

    def collect(self, source, timeout=20):
        events = queue.Queue()
        worker = link_capture.CaptureWorker(source, events, interval=0)
        worker.start()
        worker.join(timeout)
        self.assertFalse(worker.is_alive())
        found = []
        while not events.empty():
            found.append(events.get())
        return worker, found

    def test_worker_reads_tcpdump_output(self):
        source = link_capture.TcpdumpSource("en0")
        self.assertEqual(source.command, measure_cp.capture_command(
            types.SimpleNamespace(port=13328, server=None, client_port=None, interface="en0")))
        # tcpdump 대신 같은 pcap을 표준 출력으로 내보내는 프로세스를 씁니다.
        source.command = [sys.executable, "-c",
                          "import sys; sys.stderr.write('listening on en0\\n'); sys.stderr.flush(); "
                          "sys.stdout.buffer.write(open(sys.argv[1], 'rb').read())", self.path]
        worker, events = self.collect(source)
        self.expect_final(worker.tracker.state)
        statuses = [event[1] for event in events if event[0] == "status"]
        self.assertEqual(statuses[0], "starting")
        self.assertIn("capturing", statuses)
        self.assertEqual(statuses[-1], "ended")  # 중지하지 않았는데 끝났습니다.
        states = [event[1] for event in events if event[0] == "state"]
        self.expect_final(states[-1])
        self.assertIsNot(states[-1], worker.tracker.state)

    def test_permission_failure_is_reported(self):
        source = link_capture.TcpdumpSource("en0")
        source.command = [sys.executable, "-c",
                          "import sys; sys.stderr.write(\"tcpdump: en0: You don't have permission to capture on that "
                          "device\\n((cannot open BPF device) /dev/bpf0: Permission denied)\\n\"); sys.exit(1)"]
        _worker, events = self.collect(source)
        self.assertEqual(events[-1][:2], ("status", "permission"))
        self.assertIn("관리자 권한으로 캡처", link_core.status_text("permission", None, platform="darwin"))

        source = link_capture.TcpdumpSource("en0")
        source.command = [str(self.folder / "no-such-tcpdump")]
        _worker, events = self.collect(source)
        self.assertEqual(events[-1][:2], ("status", "no-tcpdump"))

    def test_stop_ends_a_running_capture(self):
        source = link_capture.TcpdumpSource("en0")
        source.command = [sys.executable, "-c", "import time; time.sleep(60)"]
        events = queue.Queue()
        worker = link_capture.CaptureWorker(source, events)
        worker.start()
        deadline = time.monotonic() + 10
        while source.process is None and time.monotonic() < deadline:
            time.sleep(0.05)
        worker.stop()
        worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertIsNotNone(source.process.poll())
        found = []
        while not events.empty():
            found.append(events.get())
        self.assertEqual(found[-1][:2], ("status", "stopped"))

    def test_sniff_source_delivers_packets(self):
        # Windows에서 쓰는 scapy 캡처 경로를 저장한 파일로 돌려 봅니다. 실제 어댑터는 열지 않습니다.
        source = link_capture.SniffSource(None, offline=self.path, filter=None)
        self.assertEqual(link_capture.SniffSource("x").options["filter"], "tcp src port 13328")
        worker, events = self.collect(source)
        self.expect_final(worker.tracker.state)
        statuses = [event[1] for event in events if event[0] == "status"]
        self.assertEqual((statuses[0], statuses[-1]), ("starting", "ended"))
        self.assertIn("capturing", statuses)

    def test_missing_npcap_is_reported(self):
        self.assertFalse(link_capture.npcap_missing() and sys.platform != "win32")
        source = link_capture.SniffSource("Ethernet")
        with mock.patch.object(link_capture, "npcap_missing", return_value=True):
            _worker, events = self.collect(source)
        self.assertEqual([event[1] for event in events if event[0] == "status"], ["starting", "npcap"])
        self.assertIsNone(source.sniffer)
        self.assertIn("Npcap이 설치되어 있지 않아", link_core.status_text("npcap"))
        # 저장한 파일을 읽을 때는 Npcap이 없어도 됩니다.
        source = link_capture.SniffSource(None, offline=self.path, filter=None)
        with mock.patch.object(link_capture, "npcap_missing", return_value=True):
            worker, _events = self.collect(source)
        self.expect_final(worker.tracker.state)

    def test_follow_file_waits_for_the_writer(self):
        raw = pathlib.Path(self.path).read_bytes()
        growing = self.folder / "growing.pcap"
        growing.write_bytes(raw[:30])
        done = threading.Event()

        def write():
            with open(growing, "ab") as output:
                for low in range(30, len(raw), 97):
                    output.write(raw[low:low + 97])
                    output.flush()
                    time.sleep(0.01)
            done.set()

        writer = threading.Thread(target=write)
        writer.start()
        source = link_capture.FollowFile(growing, lambda: not done.is_set(), poll=0.01)
        packets = []
        self.assertTrue(link_capture.read_packets(source, packets.append))
        source.close()
        writer.join()
        self.assertEqual([bytes(packet) for packet in packets], [bytes(packet) for packet in rdpcap(self.path)])
        # 아무것도 쓰이지 않은 채 끝난 파일은 읽을 것이 없습니다.
        empty = self.folder / "nothing.pcap"
        empty.write_bytes(b"")
        source = link_capture.FollowFile(empty, lambda: False)
        self.assertFalse(link_capture.read_packets(source, packets.append))
        source.close()

    @unittest.skipUnless(os.name == "posix", "셸 감시 줄은 macOS와 Linux에서만 씁니다.")
    def test_privileged_shell_stops_by_itself(self):
        run_file = self.folder / "running"
        child_pid = self.folder / "child.pid"
        command = [sys.executable, "-c",
                   "import os, sys, time; open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(60)", str(child_pid)]

        def launch(pid):
            run_file.write_text("")
            shell = link_capture.privileged_shell(command, str(self.folder / "errors with space.log"), str(run_file), pid)
            process = subprocess.Popen(["/bin/sh", "-c", shell])
            deadline = time.monotonic() + 10
            while not (child_pid.exists() and child_pid.read_text()) and time.monotonic() < deadline:
                time.sleep(0.05)
            return process, int(child_pid.read_text())

        def gone(pid):
            try:
                os.kill(pid, 0)
            except OSError:
                return True
            return False

        # 실행 표시 파일을 지우면 끝납니다.
        process, child = launch(os.getpid())
        time.sleep(1.2)
        self.assertIsNone(process.poll())
        self.assertFalse(gone(child))
        run_file.unlink()
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertTrue(gone(child))

        # 프로그램의 pid가 없어져도 끝납니다.
        child_pid.unlink()
        owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        process, child = launch(owner.pid)
        owner.kill()
        owner.wait()
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertTrue(gone(child))
        self.assertTrue(run_file.exists())

    @unittest.skipUnless(os.name == "posix", "관리자 권한 캡처는 macOS에서만 씁니다.")
    def test_privileged_source_follows_the_temp_file(self):
        # 관리자 권한 요청과 tcpdump를 대역으로 바꿔, 임시 파일을 따라 읽고 중지하면 정리되는지 봅니다.
        source = link_capture.PrivilegedSource("en0", launcher=lambda shell: ["/bin/sh", "-c", shell])
        self.assertEqual(source.capture_command("/x/capture.pcap")[1:],
                         ["-n", "-p", "-U", "-s", "0", "-i", "en0", "-w", "/x/capture.pcap", "tcp src port 13328"])
        child_pid = self.folder / "child.pid"
        source.capture_command = lambda output: [
            sys.executable, "-c",
            "import os, shutil, sys, time; open(sys.argv[3], 'w').write(str(os.getpid())); "
            "shutil.copyfile(sys.argv[1], sys.argv[2]); time.sleep(60)", self.path, output, str(child_pid)]
        events = queue.Queue()
        worker = link_capture.CaptureWorker(source, events, interval=0)
        worker.start()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = worker.tracker.state
            if state is not None and state.frames == 12:
                break
            time.sleep(0.05)
        self.expect_final(worker.tracker.state)
        folder = source.folder
        self.assertTrue(os.path.exists(os.path.join(folder, "capture.pcap")))
        worker.stop()
        worker.join(15)
        self.assertFalse(worker.is_alive())
        self.assertFalse(os.path.exists(folder))
        with self.assertRaises(OSError):
            os.kill(int(child_pid.read_text()), 0)
        statuses = []
        while not events.empty():
            event = events.get()
            if event[0] == "status":
                statuses.append(event[1])
        self.assertEqual(statuses, ["starting", "awaiting-admin", "capturing", "stopped"])

    @unittest.skipUnless(os.name == "posix", "관리자 권한 캡처는 macOS에서만 씁니다.")
    def test_cancelled_admin_prompt_is_reported(self):
        cancel = "import sys; sys.stderr.write('execution error: User canceled. (-128)\\n'); sys.exit(1)"
        source = link_capture.PrivilegedSource("en0", launcher=lambda shell: [sys.executable, "-c", cancel])
        _worker, events = self.collect(source)
        self.assertEqual(events[-1][:2], ("status", "cancelled"))
        self.assertIsNone(source.folder)


@NEED_LIBS
class LinkAndSettingsTests(unittest.TestCase):
    def test_site_address(self):
        for site, expected in (
            ("https://daevanion.a2meter.workers.dev", "https://daevanion.a2meter.workers.dev/"),
            (" https://daevanion.a2meter.workers.dev/ ", "https://daevanion.a2meter.workers.dev/"),
            ("daevanion.a2meter.workers.dev", "https://daevanion.a2meter.workers.dev/"),
            ("http://localhost:8787/#link=old", "http://localhost:8787/"),
            ("http://localhost:8787/index.html", "http://localhost:8787/index.html"),
            ("https://example.com/daevanion", "https://example.com/daevanion/"),
        ):
            self.assertEqual(link_core.site_base(site), expected)
        self.assertEqual(link_core.link_url(link_core.DEFAULT_SITE, EXAMPLE),
                         "https://daevanion.a2meter.workers.dev/#link=" + EXAMPLE_TEXT)
        for site in ("", "   ", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://",
                     "https://user@example.com", "https://exa mple.com", "example.com:0"):
            with self.subTest(site), self.assertRaises(ValueError):
                link_core.site_base(site)

    def test_link_stays_under_the_length_limit(self):
        state = link_core.LinkState()
        state.boards_complete = state.skills_complete = True
        state.boards = {board: {board * 10000 + index for index in range(1, 226)} for board in range(71, 80)}
        state.skills = {17000000 + index: (10, 4 if index < 30 else 0) for index in range(94)}
        url, dropped = link_core.link_parts(link_core.DEFAULT_SITE, state)
        self.assertEqual(dropped, 0)
        self.assertEqual(len(url), 1180)
        self.assertEqual(len(link_core.decode(url)["skills"]), 94)

        state.skills = {17000000 + index: (10, 4 if index < 30 else 0) for index in range(250)}
        url, dropped = link_core.link_parts(link_core.DEFAULT_SITE, state)
        self.assertLess(len(url), 2000)
        self.assertGreaterEqual(len(url), 2000 - 8)
        decoded = link_core.decode(url)
        self.assertEqual(dropped, 250 - len(decoded["skills"]))
        self.assertGreater(dropped, 0)
        self.assertFalse(decoded["skillsComplete"])
        self.assertTrue(decoded["boardsComplete"])
        self.assertEqual(len(decoded["boards"]), 9)
        kept = {skill["skillId"] for skill in decoded["skills"]}
        self.assertTrue({17000000 + index for index in range(30)} <= kept)
        self.assertEqual(max(kept), 17000000 + len(kept) - 1)
        with self.assertRaises(ValueError):
            link_core.link_parts("https://example.com/" + "a" * 1700, state)

    def test_status_text(self):
        text = link_core.status_text
        self.assertIn("캡처 시작을 누르십시오", text("idle"))
        self.assertIn("게임 서버에서 오는 패킷을 기다리고", text("capturing"))
        self.assertIn("암호를 받지 않습니다", text("awaiting-admin"))
        self.assertIn("관리자 권한으로 다시 실행", text("permission", platform="win32"))
        self.assertIn("tcpdump에 캡처 권한", text("permission", platform="linux"))
        self.assertIn("(tcpdump: no such device)", text("ended", detail="tcpdump:   no such\ndevice"))
        state = link_core.LinkState()
        state.frames = 3
        self.assertIn("보드 정보를 받지 못했습니다", text("capturing", state))
        state.boards_complete = True
        self.assertIn("스킬 목록을 기다리고", text("capturing", state))
        state.skills_complete = True
        self.assertIn("웹에서 재계산을 누를 수 있습니다", text("capturing", state))
        self.assertIn("마지막으로 읽은 상태로 링크를 만들 수 있습니다", text("stopped", state))
        self.assertEqual(text("stopped"), "캡처를 중지했습니다.")

    def test_config_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "nested" / "config.json"
            with mock.patch.dict(os.environ, {"DAEVANION_LINK_CONFIG": str(path)}):
                self.assertEqual(link_core.config_path(), path)
                self.assertEqual(link_core.load_config(), {"site": link_core.DEFAULT_SITE, "interface": ""})
                link_core.save_config({"site": "http://localhost:8787", "interface": "en0", "other": 1})
                self.assertEqual(link_core.load_config(), {"site": "http://localhost:8787", "interface": "en0"})
                path.write_text("{broken", encoding="utf-8")
                self.assertEqual(link_core.load_config()["site"], link_core.DEFAULT_SITE)
                path.write_text('{"site": 5, "interface": "en1"}', encoding="utf-8")
                self.assertEqual(link_core.load_config(), {"site": link_core.DEFAULT_SITE, "interface": "en1"})

    def test_skill_names_are_optional(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "skill-ids.json"
            self.assertEqual(link_core.load_skill_table(path), {})
            path.write_text('{"skills": [{"name": "스킬 레벨 상승 - 불사의 장막", "skillIds": [17750000]}]}', encoding="utf-8")
            self.assertEqual(link_core.load_skill_table(path), {17750000: "불사의 장막"})
            path.write_text("[]", encoding="utf-8")
            self.assertEqual(link_core.load_skill_table(path), {})

    def test_default_interface_follows_the_default_route(self):
        def iface(name, ip=None, flags="UP", valid=True):
            return types.SimpleNamespace(name=name, network_name=name, ip=ip, flags=flags, is_valid=lambda: valid)

        found = link_capture.list_interfaces([iface("lo0", "127.0.0.1", "UP+LOOPBACK"), iface("gif0", valid=False),
                                              iface("anpi0"), iface("en0", "192.168.0.5"), iface("utun4", "10.8.0.2")])
        self.assertEqual([interface.name for interface in found], ["en0", "utun4", "anpi0"])
        self.assertEqual(found[0].label, "en0 · 192.168.0.5")
        routes = [(0, 0xC0000000, "0.0.0.0", "utun4", "10.8.0.2", 1), (0, 0, "192.168.0.1", "en0", "192.168.0.5", 5),
                  (0, 0, "0.0.0.0", "utun9", "0.0.0.0", 1), (0x7F000000, 0xFF000000, "0.0.0.0", "lo0", "127.0.0.1", 1)]
        self.assertEqual(link_capture.default_interface(found, routes), "en0")
        self.assertEqual(link_capture.default_interface(found, []), "en0")
        self.assertEqual(link_capture.default_interface(found[1:], routes), "utun4")
        self.assertIsNone(link_capture.default_interface([], routes))

    def test_admin_request_quoting(self):
        shell = link_capture.privileged_shell(["tcpdump", "-w", "/tmp/a b/c.pcap", "tcp src port 13328"],
                                              "/tmp/a b/log", "/tmp/a b/running", 4321)
        self.assertIn("-w '/tmp/a b/c.pcap' 'tcp src port 13328' >/dev/null 2>'/tmp/a b/log' &", shell)
        self.assertIn("kill -0 4321 ", shell)
        self.assertIn("[ -e '/tmp/a b/running' ]", shell)
        script = link_capture.applescript('echo "a\\b"', prompt="확인")
        self.assertEqual(script, 'do shell script "echo \\"a\\\\b\\"" with prompt "확인" with administrator privileges')


# ── 창 ──────────────────────────────────────────────────────────────────
# 화면이 없는 곳에서도 돌도록 tkinter 자리에 대역을 넣고 link_gui의 동작만 확인합니다. 실제 창이 그려지는지는 보지 않습니다.

class FakeWidget:
    def __init__(self, master=None, **options):
        self.options = dict(options)
        self.mapped = False
        self.bindings = {}
        self.index = -1

    def grid(self, **_options):
        self.mapped = True

    def grid_remove(self):
        self.mapped = False

    def columnconfigure(self, *_args, **_options):
        pass

    def bind(self, sequence, handler):
        self.bindings[sequence] = handler

    def current(self, index=None):
        if index is None:
            return self.index
        self.index = index

    def invoke(self):
        return self.options["command"]() if self["state"] != "disabled" else None

    def __setitem__(self, key, value):
        self.options[key] = value

    def __getitem__(self, key):
        return self.options.get(key, "")


class FakeVariable:
    def __init__(self, value=""):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class FakeTk(FakeWidget):
    def __init__(self):
        super().__init__()
        self.pending = []
        self.serial = 0
        self.clipboard = []
        self.destroyed = False
        self.withdrawn = False
        self.closer = None
        self.commands = {}
        self.window_title = ""

    def title(self, text):
        self.window_title = text

    def resizable(self, *_args):
        pass

    def protocol(self, _name, handler):
        self.closer = handler

    def createcommand(self, name, handler):
        self.commands[name] = handler

    def after(self, delay, callback):
        self.serial += 1
        self.pending.append((delay, self.serial, callback))
        return self.serial

    def after_cancel(self, identifier):
        self.pending = [item for item in self.pending if item[1] != identifier]

    def step(self):
        """기다리는 것 가운데 가장 이른 것을 하나 부릅니다."""
        self.pending.sort()
        delay, _serial, callback = self.pending.pop(0)
        self.pending = [(later - delay, serial, other) for later, serial, other in self.pending]
        callback()

    def mainloop(self):
        while self.pending and not self.destroyed:
            self.step()

    def withdraw(self):
        self.withdrawn = True

    def destroy(self):
        self.destroyed = True

    def clipboard_clear(self):
        self.clipboard.clear()

    def clipboard_append(self, text):
        self.clipboard.append(text)


def fake_tkinter():
    module = types.ModuleType("tkinter")
    module.Tk, module.StringVar, module.TclError, module.TkVersion = FakeTk, FakeVariable, RuntimeError, 8.6
    module.ttk = types.ModuleType("tkinter.ttk")
    for name in ("Frame", "Label", "Button", "Combobox", "Entry", "Separator"):
        setattr(module.ttk, name, FakeWidget)
    return module


@NEED_LIBS
class WindowTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.config = pathlib.Path(folder.name) / "config.json"
        fake = fake_tkinter()
        patches = [mock.patch.dict(sys.modules, {"tkinter": fake, "tkinter.ttk": fake.ttk}),
                   mock.patch.dict(os.environ, {"DAEVANION_LINK_CONFIG": str(self.config)})]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        sys.modules.pop("link_gui", None)
        self.addCleanup(sys.modules.pop, "link_gui", None)
        import link_gui
        self.gui = link_gui
        interfaces = [link_capture.Interface("en0", "en0 · 192.168.0.5"), link_capture.Interface("utun4", "utun4")]
        for name, value in (("list_interfaces", lambda: interfaces), ("default_interface", lambda found: "en0")):
            patch = mock.patch.object(link_capture, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.opened = []
        self.root = FakeTk()
        self.window = link_gui.LinkWindow(self.root, opener=lambda url: self.opened.append(url) or True)

    def state(self, skills_complete=True):
        state = link_core.LinkState()
        state.boards = {71: {710113}, 72: {720001, 720113}, 75: {750113}, 79: {790113}}
        state.skills = {1003: (1, 0), 17750000: (17, 4)}
        state.power, state.best_power, state.frames = 975724, 1019394, 10
        state.seen_at = state.changed_at = 1794553175.0
        state.boards_complete, state.skills_complete = True, skills_complete
        return state

    def buttons(self):
        return [str(getattr(self.window, name)["state"]) for name in ("start_button", "stop_button", "open_button", "copy_button")]

    def wait(self, done, seconds=15):
        deadline = time.monotonic() + seconds
        while not done() and time.monotonic() < deadline:
            self.window.poll()
            time.sleep(0.02)
        self.window.poll()
        self.assertTrue(done())

    def test_initial_window(self):
        self.assertEqual(self.root.window_title, "데바니온 링크")
        self.assertIn("캡처 시작을 누르십시오", self.window.status["text"])
        self.assertEqual(self.window.interface["values"], ["en0 · 192.168.0.5", "utun4"])
        self.assertEqual(self.window.selected_interface(), "en0")
        self.assertEqual(self.window.site.get(), link_core.DEFAULT_SITE)
        self.assertEqual(self.buttons(), ["normal", "disabled", "disabled", "disabled"])
        self.assertFalse(self.window.admin_button.mapped)
        self.assertEqual([self.window.values[key]["text"] for key in ("power", "best", "boards", "skills", "changed")],
                         ["없음"] * 5)
        self.assertEqual(len(self.root.pending), 1)
        if sys.platform == "darwin":
            self.assertEqual(self.root.commands, {"tk::mac::Quit": self.window.close})
        self.root.closer()
        self.assertTrue(self.root.destroyed and self.root.withdrawn)
        self.assertEqual(self.root.pending, [])
        self.assertFalse(self.config.exists())  # 바꾼 것이 없으면 설정 파일을 만들지 않습니다.

    def test_state_enables_the_link_buttons(self):
        self.window.events.put(("state", self.state(skills_complete=False)))
        self.window.poll()
        self.assertEqual(self.buttons()[2:], ["disabled", "disabled"])
        self.assertIn("스킬 목록을 기다리고 있습니다", self.window.values["skills"]["text"])
        self.window.open_button.invoke()
        self.window.open_web()
        self.assertEqual(self.opened, [])

        state = self.state()
        self.window.events.put(("state", state))
        self.window.poll()
        self.assertEqual(self.buttons()[2:], ["normal", "normal"])
        self.assertEqual(self.window.values["power"]["text"], "975,724")
        self.assertEqual(self.window.values["best"]["text"], "1,019,394")
        self.assertEqual(self.window.values["boards"]["text"], "네자칸 1개 · 지켈 2개 · 보드 75 1개\n루미엘 1개")
        self.assertEqual(self.window.values["skills"]["text"], "2개 (데바니온 노드로 오른 스킬 1개)")
        self.assertEqual(self.window.values["changed"]["text"], link_core.clock(1794553175.0))
        self.assertIn("마지막으로 읽은 상태로 링크를 만들 수 있습니다", self.window.status["text"])

        expected = link_core.link_url(link_core.DEFAULT_SITE, state)
        self.window.copy_button.invoke()
        self.assertEqual(self.root.clipboard, [expected])
        self.assertEqual(self.window.notice["text"], "링크를 복사했습니다.")
        self.window.open_button.invoke()
        self.assertEqual(self.opened, [expected])
        self.assertIn("웹 계산기를 열었습니다", self.window.notice["text"])

        self.window.site.set("ftp://example.com")
        self.window.remember()
        self.window.open_button.invoke()
        self.assertEqual(len(self.opened), 1)
        self.assertIn("http 또는 https", self.window.notice["text"])
        self.assertFalse(self.config.exists())  # 쓸 수 없는 주소는 설정에 남기지 않습니다.
        self.window.site.set("http://localhost:8787")
        self.window.opener = mock.Mock(side_effect=OSError("no browser"))
        self.window.open_button.invoke()
        self.assertIn("브라우저를 열지 못했습니다", self.window.notice["text"])
        self.assertEqual(link_core.load_config()["site"], "http://localhost:8787")

    def test_interface_choice_is_remembered(self):
        self.window.interface.current(1)
        self.window.interface.bindings["<<ComboboxSelected>>"](None)
        self.assertEqual(link_core.load_config(), {"site": link_core.DEFAULT_SITE, "interface": "utun4"})
        self.root.closer()
        again = self.gui.LinkWindow(FakeTk())
        self.assertEqual(again.selected_interface(), "utun4")
        # 명령줄로 받은 값은 창에서 바꾸지 않는 한 설정 파일에 남기지 않습니다.
        root = FakeTk()
        once = self.gui.LinkWindow(root, site="http://localhost:8787", interface="en0")
        self.assertEqual((once.selected_interface(), once.site.get()), ("en0", "http://localhost:8787"))
        root.closer()
        self.assertEqual(link_core.load_config(), {"site": link_core.DEFAULT_SITE, "interface": "utun4"})
        # 주소 칸을 비우면 기본 주소를 씁니다.
        once.site.set("  ")
        self.assertEqual(once.site_address(), link_core.DEFAULT_SITE)

    def test_permission_failure_offers_the_admin_button_on_macos(self):
        made = []

        def source(name, port, privileged=False):
            made.append((name, port, privileged))
            source = link_capture.TcpdumpSource(name, port)
            source.command = [sys.executable, "-c", "import sys; sys.stderr.write('en0: Permission denied\\n'); sys.exit(1)"]
            return source

        with mock.patch.object(link_capture, "live_source", source), mock.patch.object(self.gui.sys, "platform", "darwin"):
            self.window.start_button.invoke()
            self.assertEqual(self.buttons()[:2], ["disabled", "normal"])
            self.assertEqual(self.window.interface["state"], "disabled")
            self.wait(lambda: not self.window.running() and self.window.phase == "permission")
            self.assertEqual(made, [("en0", 13328, False)])
            self.assertTrue(self.window.admin_button.mapped)
            self.assertEqual(self.buttons()[:2], ["normal", "disabled"])
            self.assertEqual(self.window.interface["state"], "readonly")
            self.assertIn("관리자 권한으로 캡처를 누르면", self.window.status["text"])
            self.window.admin_button.invoke()
            self.wait(lambda: not self.window.running() and self.window.phase == "permission")
            self.assertEqual(made[-1], ("en0", 13328, True))
        with mock.patch.object(self.gui.sys, "platform", "linux"):
            self.window.render()
            self.assertFalse(self.window.admin_button.mapped)

    def test_capture_updates_the_window_and_stops(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = str(pathlib.Path(folder.name) / "session.pcap")
        wrpcap(path, tcp_packets(session_stream(), [10, 40, 200, 420, 900]))

        def source(name, port, privileged=False):
            source = link_capture.TcpdumpSource(name, port)
            source.command = [sys.executable, "-c",
                              "import sys, time; sys.stderr.write('listening on en0\\n'); sys.stderr.flush(); "
                              "sys.stdout.buffer.write(open(sys.argv[1], 'rb').read()); sys.stdout.flush(); time.sleep(60)",
                              path]
            return source

        with mock.patch.object(link_capture, "live_source", source):
            self.window.start()
            self.wait(lambda: self.window.state is not None and self.window.state.complete)
            self.assertEqual(self.window.phase, "capturing")
            self.assertIn("웹에서 재계산을 누를 수 있습니다", self.window.status["text"])
            self.assertEqual(self.buttons(), ["disabled", "normal", "normal", "normal"])
            self.assertEqual(self.window.values["boards"]["text"], "네자칸 1개 · 루미엘 4개")
            process = self.window.worker.source.process
            self.window.stop_button.invoke()
            self.wait(lambda: not self.window.running() and self.window.phase == "stopped")
            self.assertIsNotNone(process.poll())
            self.assertEqual(self.buttons(), ["normal", "disabled", "normal", "normal"])
            self.assertIn("마지막으로 읽은 상태로", self.window.status["text"])
            # 캡처 중에 창을 닫으면 캡처도 끝냅니다.
            self.window.start()
            self.wait(lambda: self.window.state is not None and self.window.state.complete)
            worker = self.window.worker
            self.root.closer()
            self.assertFalse(worker.is_alive())
            self.assertIsNotNone(worker.source.process.poll())
            self.assertTrue(self.root.destroyed)

    def test_run_opens_and_closes(self):
        with mock.patch.object(self.gui, "tk_usable", return_value=True):
            self.assertEqual(self.gui.run(close_after=0.3), 0)
        err = io.StringIO()
        with mock.patch.object(self.gui, "tk_usable", return_value=False), contextlib.redirect_stderr(err):
            self.assertEqual(self.gui.run(close_after=0.3), 1)
        self.assertIn("창을 띄울 수 없습니다", err.getvalue())

    def test_old_macos_tk_is_probed_in_another_process(self):
        gui = self.gui
        with mock.patch.object(gui.subprocess, "run") as run:
            with mock.patch.object(gui.sys, "platform", "win32"):
                self.assertTrue(gui.tk_usable())
            with mock.patch.object(gui.sys, "platform", "darwin"):
                self.assertTrue(gui.tk_usable())  # Tk 8.6 이상은 확인하지 않습니다.
                run.assert_not_called()
                with mock.patch.object(gui.tk, "TkVersion", 8.5):
                    run.return_value = types.SimpleNamespace(returncode=-6)
                    self.assertFalse(gui.tk_usable())
                    run.return_value = types.SimpleNamespace(returncode=0)
                    self.assertTrue(gui.tk_usable())
                    self.assertEqual(run.call_args[0][0][:2], [sys.executable, "-c"])


if __name__ == "__main__":
    unittest.main()
