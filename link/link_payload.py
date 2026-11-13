"""데바니온 링크 페이로드(버전 1)를 만들고 읽습니다. 표준 라이브러리만 사용합니다.

형식은 link/README.md의 "페이로드 형식"에 적혀 있습니다. 웹 쪽 가져오기는 이 모듈의 decode와 같은 결과를 내야 합니다.
"""

import base64
import binascii
import struct


MAGIC = b"DV"
VERSION = 1
FLAG_BOARDS = 0x01
FLAG_SKILLS = 0x02
NODE_COUNT = 225
BITMAP_BYTES = 29
HEADER = struct.Struct("<2sBBIII")
SKILL = struct.Struct("<IBB")
MAX_BOARD = 255
MAX_ENTRIES = 255
LINK_MARK = "#link="


def _u32(value, name):
    value = int(value or 0)
    if not 0 <= value <= 0xFFFFFFFF:
        raise ValueError(f"{name} 값이 4바이트 범위를 벗어났습니다: {value}")
    return value


def _u8(value, name):
    value = int(value or 0)
    if not 0 <= value <= 0xFF:
        raise ValueError(f"{name} 값이 1바이트 범위를 벗어났습니다: {value}")
    return value


def pack(state):
    """상태를 페이로드 바이트열로 만듭니다.

    state는 to_payload()가 있는 객체이거나 decode()가 돌려주는 모양의 dict입니다.
    255를 넘는 보드 번호, 보드 번호와 맞지 않는 노드 번호, 1~225를 벗어난 노드 순번은 넣지 않습니다.
    보드나 스킬이 255개를 넘으면 ValueError입니다.
    """
    data = state.to_payload() if hasattr(state, "to_payload") else state
    flags = (FLAG_BOARDS if data.get("boardsComplete") else 0) | (FLAG_SKILLS if data.get("skillsComplete") else 0)
    out = bytearray(HEADER.pack(MAGIC, VERSION, flags, _u32(data.get("capturedAt"), "capturedAt"),
                                _u32(data.get("power"), "power"), _u32(data.get("bestPower"), "bestPower")))

    boards = {}
    for board in data.get("boards", ()):
        board_id = int(board["boardId"])
        if not 0 <= board_id <= MAX_BOARD:
            continue
        bitmap = boards.setdefault(board_id, bytearray(BITMAP_BYTES))
        for node_id in board.get("nodeIds", ()):
            owner, index = divmod(int(node_id), 10000)
            if owner != board_id or not 1 <= index <= NODE_COUNT:
                continue
            bitmap[(index - 1) >> 3] |= 1 << ((index - 1) & 7)
    board_ids = sorted(boards)
    if len(board_ids) > MAX_ENTRIES:
        raise ValueError(f"보드가 {MAX_ENTRIES}개를 넘습니다.")
    out.append(len(board_ids))
    for board_id in board_ids:
        out.append(board_id)
        out += boards[board_id]

    skills = {}
    for skill in data.get("skills", ()):
        skills[_u32(skill["skillId"], "skillId")] = (_u8(skill.get("level"), "level"),
                                                     _u8(skill.get("daevanionLevels"), "daevanionLevels"))
    skill_ids = sorted(skills)
    if len(skill_ids) > MAX_ENTRIES:
        raise ValueError(f"스킬이 {MAX_ENTRIES}개를 넘습니다. fit()으로 덜어 낸 뒤 만드십시오.")
    out.append(len(skill_ids))
    for skill_id in skill_ids:
        out += SKILL.pack(skill_id, *skills[skill_id])
    return bytes(out)


def encode(state):
    """상태를 URL에 넣을 문자열(패딩 없는 base64url)로 만듭니다."""
    return base64.urlsafe_b64encode(pack(state)).rstrip(b"=").decode("ascii")


def fit(state, max_chars):
    """encode()의 결과가 max_chars 글자 이하가 되도록 스킬을 덜어 낸 dict와 덜어 낸 스킬 수를 돌려줍니다.

    데바니온 레벨이 0인 스킬을 번호가 큰 것부터 빼고, 그래도 넘치면 나머지를 번호가 큰 것부터 뺍니다.
    하나라도 빼면 skillsComplete를 False로 둡니다. 스킬을 모두 빼도 넘치면 ValueError입니다.
    """
    data = dict(state.to_payload() if hasattr(state, "to_payload") else state)
    skills = {int(skill["skillId"]): skill for skill in data.get("skills", ())}
    fixed = len(pack(dict(data, skills=[])))
    # 패딩 없는 base64url은 n바이트가 ceil(4n/3)글자입니다.
    room = min(MAX_ENTRIES, (max_chars * 3 // 4 - fixed) // SKILL.size)
    if room < 0:
        raise ValueError("스킬을 모두 빼도 링크가 너무 깁니다.")
    kept = sorted(skills, key=lambda skill_id: (not int(skills[skill_id].get("daevanionLevels") or 0), skill_id))[:room]
    data["skills"] = [skills[skill_id] for skill_id in sorted(kept)]
    dropped = len(skills) - len(kept)
    if dropped:
        data["skillsComplete"] = False
    return data, dropped


def unpack(raw):
    """페이로드 바이트열을 dict로 읽습니다. 형식이 맞지 않으면 ValueError를 냅니다."""
    if len(raw) < HEADER.size + 2:
        raise ValueError("페이로드가 너무 짧습니다.")
    magic, version, flags, captured_at, power, best_power = HEADER.unpack_from(raw)
    if magic != MAGIC:
        raise ValueError("데바니온 링크 페이로드가 아닙니다.")
    if version != VERSION:
        raise ValueError(f"지원하지 않는 페이로드 버전입니다: {version}")
    offset = HEADER.size

    boards = []
    count = raw[offset]
    offset += 1
    previous = -1
    for _ in range(count):
        if offset + 1 + BITMAP_BYTES > len(raw):
            raise ValueError("보드 목록이 끊겼습니다.")
        board_id = raw[offset]
        if board_id <= previous:
            raise ValueError("보드 번호가 오름차순이 아닙니다.")
        previous = board_id
        bitmap = raw[offset + 1:offset + 1 + BITMAP_BYTES]
        offset += 1 + BITMAP_BYTES
        # 225번째 비트 뒤의 남는 비트는 읽지 않습니다.
        boards.append({"boardId": board_id,
                       "nodeIds": [board_id * 10000 + bit + 1 for bit in range(NODE_COUNT)
                                   if bitmap[bit >> 3] >> (bit & 7) & 1]})

    if offset >= len(raw):
        raise ValueError("스킬 목록이 없습니다.")
    skills = []
    count = raw[offset]
    offset += 1
    if len(raw) - offset != count * SKILL.size:
        raise ValueError("스킬 목록의 길이가 맞지 않습니다.")
    previous = -1
    for index in range(count):
        skill_id, level, daevanion = SKILL.unpack_from(raw, offset + index * SKILL.size)
        if skill_id <= previous:
            raise ValueError("스킬 번호가 오름차순이 아닙니다.")
        previous = skill_id
        skills.append({"skillId": skill_id, "level": level, "daevanionLevels": daevanion})

    return {
        "version": version,
        "boardsComplete": bool(flags & FLAG_BOARDS),
        "skillsComplete": bool(flags & FLAG_SKILLS),
        "capturedAt": captured_at,
        "power": power,
        "bestPower": best_power,
        "boards": boards,
        "skills": skills,
    }


def decode(text):
    """encode()의 문자열이나 #link=가 든 주소를 dict로 읽습니다. 형식이 맞지 않으면 ValueError를 냅니다."""
    text = text.strip()
    if LINK_MARK in text:
        text = text.split(LINK_MARK, 1)[1].split("&", 1)[0]
    if not text or len(text) % 4 == 1:
        raise ValueError("데이터 문자열의 길이가 맞지 않습니다.")
    try:
        raw = base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("데이터 문자열이 base64url이 아닙니다.") from error
    return unpack(raw)
