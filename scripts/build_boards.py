#!/usr/bin/env python3
"""공식 API 저장본으로 서버 없이 열 수 있는 보드 HTML을 생성합니다."""

import argparse
import html
import json
import math
from pathlib import Path
import subprocess
from urllib.parse import urlencode
from optimize_board import build_all_power_plan, shared_model

ROOT = Path(__file__).resolve().parent.parent
BOARDS = [(71, "네자칸", "Nezkhan.html"), (72, "지켈", "Zikel.html"),
          (73, "바이젤", "Vaizel.html"), (74, "트리니엘", "Triniel.html"), (79, "루미엘", "Lumiel.html")]
CHARACTER_ID = "AVjAApO77vZ9AnoMquwqdsIrxzd1bHPmsLfhjT_VnvM="
SERVER_ID = 1003
NODE_COSTS = {"Common": 1, "Rare": 2, "Legend": 3, "Unique": 4}
PLAN_BOARDS = {71: "nezkhan", 72: "zikel", 73: "vaizel", 74: "triniel", 79: "lumiel"}


def validate(data, board_id):
    nodes = data["nodeList"]
    assert len(nodes) == 225, f"보드 {board_id}: 225개 좌표가 필요합니다."
    assert len({(n["row"], n["col"]) for n in nodes}) == 225, "중복된 좌표입니다."
    assert len({n["nodeId"] for n in nodes}) == 225, "중복된 노드입니다."
    assert sum(n["type"] == "Start" for n in nodes) == 1, "시작 노드가 필요합니다."
    for node in nodes:
        assert node["boardId"] == board_id, "보드 번호가 일치하지 않습니다."
        assert 1 <= node["row"] <= 15 and 1 <= node["col"] <= 15, "좌표 범위를 벗어났습니다."
        assert node["type"] in {"None", "Stat", "SkillLevel", "Start"}, "알 수 없는 노드 유형입니다."
        assert node["grade"] in {"None", "Common", "Rare", "Legend", "Unique"}, "알 수 없는 등급입니다."
        assert node["type"] in {"None", "Start"} or node["grade"] != "None", "노드 등급이 없습니다."
        assert type(node["open"]) is int and node["open"] in {0, 1}, "개방 상태가 올바르지 않습니다."
        assert isinstance(node["name"], str), "노드 이름이 필요합니다."
        assert all(isinstance(effect["desc"], str) for effect in node["effectList"]), "노드 효과가 올바르지 않습니다."
    for key in ("openStatEffectList", "openSkillEffectList"):
        assert isinstance(data[key], list), f"{key} 목록이 필요합니다."
        assert all(isinstance(effect["desc"], str) for effect in data[key]), "보드 효과가 올바르지 않습니다."


def refresh():
    # 모든 응답을 검증한 뒤 저장합니다. 쿠키나 인증 정보는 사용하지 않습니다.
    responses = {}
    for board_id, _, _ in BOARDS:
        query = urlencode({"lang": "ko", "characterId": CHARACTER_ID,
                           "serverId": SERVER_ID, "boardId": board_id})
        result = subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location",
                                 "--retry", "2", "--max-time", "30", "-H", "Accept: application/json",
                                 f"https://aion2.plaync.com/api/character/daevanion/detail?{query}"],
                                check=True, capture_output=True)
        validate(json.loads(result.stdout), board_id)
        responses[board_id] = result.stdout
    for board_id, response in responses.items():
        path = ROOT / "boards" / f"{board_id}.json"
        temporary = path.with_suffix(".json.tmp")
        temporary.write_bytes(response)
        temporary.replace(path)


def load():
    """보드 저장본을 읽고 옵션, 옵션별 기록값, 스킬 레벨별 값을 검증해 돌려줍니다."""
    loaded = []
    for board_id, name, filename in BOARDS:
        data = json.loads((ROOT / "boards" / f"{board_id}.json").read_text(encoding="utf-8"))
        validate(data, board_id)
        loaded.append((board_id, name, filename, data))
    options = {}
    for board_id, _, _, data in loaded:
        for node in data["nodeList"]:
            if node["type"] in {"None", "Start"}:
                continue
            effects = [effect["desc"] for effect in node["effectList"] if effect["desc"]]
            key = json.dumps([node["grade"], node["type"], node["name"], effects],
                             ensure_ascii=False, separators=(",", ":"))
            if key not in options:
                options[key] = {"key": key, "grade": node["grade"], "type": node["type"],
                                "name": node["name"], "effects": effects,
                                "counts": {str(board[0]): 0 for board in BOARDS}}
            options[key]["counts"][str(board_id)] += 1
    measurements = []
    measurement_ids = set()
    for record in json.loads((ROOT / "boards" / "measurements.json").read_text(encoding="utf-8")):
        key = json.dumps([record["grade"], record["type"], record["name"], record["effects"]],
                         ensure_ascii=False, separators=(",", ":"))
        assert key in options, "측정 대상 옵션을 찾을 수 없습니다."
        assert isinstance(record["id"], str) and record["id"] and record["id"] not in measurement_ids, "측정 기록 번호가 올바르지 않습니다."
        assert record["operation"] in {"activate", "deactivate"}, "측정 동작이 올바르지 않습니다."
        assert type(record["nodeCount"]) is int and record["nodeCount"] > 0, "측정 노드 수가 올바르지 않습니다."
        assert all(type(record[field]) is int and 0 <= record[field] <= 2**53 - 1 for field in ("before", "after")), "전투력 수치가 올바르지 않습니다."
        delta = record["before"] - record["after"] if record["operation"] == "deactivate" else record["after"] - record["before"]
        excluded = record.get("excludedPower", 0)
        assert type(excluded) is int and 0 <= excluded <= delta, "분리할 전투력 변화량이 올바르지 않습니다."
        assert not excluded or record.get("basis") == "inferred", "복합 측정은 추정값으로 구분해야 합니다."
        if excluded:
            if record.get("adjustments"):
                adjustment_power = 0
                for adjustment in record["adjustments"]:
                    reference = next((item for item in measurements if item["id"] == adjustment["observationId"]), None)
                    assert reference and adjustment["operation"] in {"activate", "deactivate"}, "전투력 보정 근거가 올바르지 않습니다."
                    assert type(adjustment["nodeCount"]) is int and adjustment["nodeCount"] > 0, "보정할 노드 수가 올바르지 않습니다."
                    direction = 1 if adjustment["operation"] == record["operation"] else -1
                    adjustment_power += direction * reference["power"] * adjustment["nodeCount"]
                assert adjustment_power == excluded, "다른 노드의 순변화와 차감 전투력이 일치하지 않습니다."
            else:
                reference = next((item for item in measurements if item["id"] == record.get("excludedObservationId")), None)
                assert reference and reference["power"] == excluded, "차감 근거가 되는 측정 기록과 전투력이 일치하지 않습니다."
        delta -= excluded
        assert delta >= 0, "전투력 변화 방향을 확인하십시오."
        measurement_ids.add(record["id"])
        count = record["nodeCount"]
        measurements.append({**record, "key": key, "power": delta // count if delta % count == 0 else delta / count})
    for rule in json.loads((ROOT / "boards" / "power-rules.json").read_text(encoding="utf-8")):
        assert rule["grade"] in {"Rare", "Legend"} and rule["basis"] == "fixed", "스킬 고정값의 등급이 올바르지 않습니다."
        assert type(rule["power"]) is int and rule["power"] >= 0, "스킬 고정 전투력이 올바르지 않습니다."
        for key, option in options.items():
            if option["grade"] != rule["grade"] or option["type"] != "SkillLevel":
                continue
            record_id = f"{rule['id']}:{key}"
            assert record_id not in measurement_ids, "고정 기록 번호가 중복되었습니다."
            measurement_ids.add(record_id)
            measurements.append({**rule, "id": record_id, "key": key})
    # 레벨별 값이 있는 스킬은 등급별 고정값 대신 열린 노드 수에 따른 값을 씁니다.
    recorded = json.loads((ROOT / "boards" / "skill-values.json").read_text(encoding="utf-8"))
    levels = skill_levels(recorded["levels"])
    skill_values = []
    for skill in recorded["skills"]:
        key = skill_key(skill)
        assert key in options, "레벨별 값을 적용할 스킬 옵션을 찾을 수 없습니다."
        assert all(item["key"] != key for item in skill_values), "스킬의 레벨별 값이 중복되었습니다."
        assert type(skill["baseLevel"]) is int and skill["baseLevel"] >= 0, "스킬의 기준 레벨이 올바르지 않습니다."
        assert isinstance(skill["values"], list) and len(skill["values"]) == sum(options[key]["counts"].values()), "레벨별 값의 개수가 스킬 노드 수와 다릅니다."
        assert all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in skill["values"]), "스킬의 레벨별 전투력이 올바르지 않습니다."
        # 링크로 가져온 상태는 등급별 레벨표로 값을 만들므로, 기본 캐릭터의 기록도 그 표와 같아야 합니다.
        assert skill["values"] == [level_power(levels, skill["grade"], skill["baseLevel"] + step)
                                   for step in range(1, len(skill["values"]) + 1)], "스킬의 레벨별 값이 등급별 레벨표와 다릅니다."
        skill_values.append({**skill, "key": key})
    return loaded, options, measurements, skill_values


def skill_key(skill):
    return json.dumps([skill["grade"], "SkillLevel", skill["name"], skill["effects"]],
                      ensure_ascii=False, separators=(",", ":"))


def skill_levels(table):
    """등급별 레벨 전투력표를 검증합니다. 구간은 [시작 레벨, 끝 레벨, 전투력, 관측 여부]이고 1레벨부터 빈틈없이 이어집니다."""
    levels = {}
    for grade in ("Legend", "Rare"):
        following = 1
        assert isinstance(table[grade], list) and table[grade], "등급별 레벨표가 비어 있습니다."
        for item in table[grade]:
            assert isinstance(item, list) and len(item) == 4, "레벨 구간의 형식이 올바르지 않습니다."
            first, last, power, observed = item
            assert type(first) is int and type(last) is int and first == following and last >= first, "레벨 구간이 이어지지 않습니다."
            assert type(power) in (int, float) and math.isfinite(power) and power >= 0, "레벨 구간의 전투력이 올바르지 않습니다."
            assert type(observed) is bool, "레벨 구간의 관측 여부가 올바르지 않습니다."
            following = last + 1
        levels[grade] = table[grade]
    return levels


def level_power(levels, grade, level):
    """그 등급의 스킬이 level에 도달할 때 오르는 전투력입니다. 표에 없는 레벨은 None입니다."""
    for first, last, power, _ in levels[grade]:
        if first <= level <= last:
            return power
    return None


def load_skill_tables(options):
    """링크로 가져온 스킬 레벨을 값으로 바꾸는 데 쓰는 등급별 레벨표와 스킬 번호표를 돌려줍니다."""
    levels = skill_levels(json.loads((ROOT / "boards" / "skill-values.json").read_text(encoding="utf-8"))["levels"])
    ids, owners = [], {}
    for skill in json.loads((ROOT / "boards" / "skill-ids.json").read_text(encoding="utf-8"))["skills"]:
        key = skill_key(skill)
        assert key in options and skill["grade"] in levels, "패킷 번호를 이을 스킬 옵션을 찾을 수 없습니다."
        assert all(item["key"] != key for item in ids), "스킬의 패킷 번호가 중복되었습니다."
        numbers = skill["skillIds"]
        assert isinstance(numbers, list) and numbers and len(set(numbers)) == len(numbers), "스킬의 패킷 번호가 올바르지 않습니다."
        for number in numbers:
            assert type(number) is int and 0 < number <= 0xFFFFFFFF, "스킬의 패킷 번호가 올바르지 않습니다."
            assert owners.setdefault(number, key) == key, "한 패킷 번호가 두 스킬에 걸쳐 있습니다."
        ids.append({"key": key, "skillIds": sorted(numbers)})
    return {"levels": levels, "ids": ids}


def describe_model():
    """scripts/solve_plan.cjs가 같은 입력으로 계산하도록 모형 해시와 전투력값을 출력합니다."""
    loaded, _, measurements, skill_values = load()
    skills = {item["key"]: item["values"] for item in skill_values}
    model = shared_model([data for _, _, _, data in loaded], measurements, skills)
    print(json.dumps({"modelHash": model.hash, "budget": model.budget, "boards": [board_id for board_id, _, _, _ in loaded],
                      "values": {record["key"]: record["power"] for record in measurements}, "skills": skills}))


def build(solve=False):
    template = (ROOT / "scripts" / "board-template.html").read_text(encoding="utf-8")
    resources = (ROOT / "scripts" / "resource-template.html").read_text(encoding="utf-8")
    manifest = []
    loaded, options, measurements, skill_values = load()
    all_plan = build_all_power_plan([data for _, _, _, data in loaded], measurements, recompute=solve,
                                    skills={item["key"]: item["values"] for item in skill_values})
    power_plans = all_plan["boards"]
    for board_id, name, _, data in loaded:
        slug = PLAN_BOARDS[board_id]
        power_plans[board_id].update({"name": name, "file": f"boards/{slug}-power-plan.json"})
    for board_id, name, filename, data in loaded:
        countable = [node for node in data["nodeList"] if node["type"] not in {"None", "Start"}]
        opened = [node for node in countable if node["open"] == 1]
        spent = sum(NODE_COSTS[node["grade"]] for node in opened)
        # Escape markup delimiters even inside application/json script elements.
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
        output = template
        for key, value in {"name": html.escape(name), "id": board_id, "open": len(opened), "spent": spent,
                           "total": len(countable), "resources": resources, "data": payload}.items():
            output = output.replace("{{" + key + "}}", str(value))
        (ROOT / filename).write_text(output, encoding="utf-8")
        source = f"https://aion2.plaync.com/ko-kr/characters/{SERVER_ID}/{CHARACTER_ID}?tab=daevanion&boardId={board_id}"
        manifest.append({"id": board_id, "name": name, "file": filename,
                         "open": len(opened), "total": len(countable), "source": source,
                         "nodes": [{key: node[key] for key in ("nodeId", "row", "col", "type", "grade", "open", "name", "effectList")}
                                   for node in data["nodeList"] if node["type"] != "None"]})
        print(f"{filename}: {len(opened)}/{len(countable)}")
    (ROOT / "boards" / "manifest.js").write_text(
        "// scripts/build_boards.py에서 생성합니다.\nwindow.DAEVANION_BOARDS = "
        + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    (ROOT / "boards" / "options.js").write_text(
        "// scripts/build_boards.py에서 생성합니다.\nwindow.DAEVANION_OPTIONS = "
        + json.dumps(list(options.values()), ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    (ROOT / "boards" / "measurements.js").write_text(
        "// scripts/build_boards.py에서 생성합니다.\nwindow.DAEVANION_MEASUREMENTS = "
        + json.dumps(measurements, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    (ROOT / "boards" / "skill-values.js").write_text(
        "// scripts/build_boards.py에서 생성합니다.\nwindow.DAEVANION_SKILL_VALUES = "
        + json.dumps(skill_values, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    (ROOT / "boards" / "skill-tables.js").write_text(
        "// scripts/build_boards.py에서 생성합니다.\nwindow.DAEVANION_SKILL_TABLES = "
        + json.dumps(load_skill_tables(options), ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
    for board_id, power_plan in power_plans.items():
        (ROOT / power_plan["file"]).write_text(json.dumps(power_plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{power_plan['name']} 전투력 구성: {len(power_plan['nodeIds'])}개 노드, 소모 {power_plan['cost']}개, 확인된 전투력 합계 {power_plan['power']}")
    (ROOT / "boards" / "all-power-plan.json").write_text(json.dumps(all_plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (ROOT / "boards" / "power-plan.js").write_text(
        "// scripts/build_boards.py에서 생성합니다.\nwindow.DAEVANION_ALL_POWER_PLAN = "
        + json.dumps(all_plan, ensure_ascii=False, indent=2)
        + ";\nwindow.DAEVANION_POWER_PLANS = window.DAEVANION_ALL_POWER_PLAN.boards;\nwindow.DAEVANION_POWER_PLAN = window.DAEVANION_POWER_PLANS[71];\n", encoding="utf-8")
    print(f"옵션 {len(options)}종, 노드 {sum(sum(option['counts'].values()) for option in options.values())}개")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="공식 API에서 기본 보드와 루미엘을 다시 받습니다.")
    parser.add_argument("--solve", action="store_true", help="루트 연결과 예산 전량 사용 조건으로 최고 전투력 구성을 다시 계산합니다.")
    parser.add_argument("--model", action="store_true", help="파일을 쓰지 않고 현재 입력의 모형 해시와 전투력값을 JSON으로 출력합니다.")
    args = parser.parse_args()
    if args.refresh:
        refresh()
    if args.model:
        describe_model()
    else:
        build(solve=args.solve)
