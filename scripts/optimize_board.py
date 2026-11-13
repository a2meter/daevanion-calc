"""루트 연결과 예산 전량 사용을 제약으로 전투력 합계를 정확히 최대화합니다."""

from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
from types import SimpleNamespace

COSTS = {"Common": 1, "Rare": 2, "Legend": 3, "Unique": 4, "None": 0}
POWER_TOLERANCE = 1e-7
GAP_TOLERANCE = 1e-9


class InfeasiblePlanError(RuntimeError):
    pass


def planning_budget(source_total):
    return 837 if source_total == 0 or source_total >= 709 else source_total


def certified_optimal(power, bound, gap):
    return (all(isinstance(value, (int, float)) and math.isfinite(value) for value in (power, bound, gap))
            and 0 <= gap <= GAP_TOLERANCE
            and math.isclose(power, bound, rel_tol=0, abs_tol=POWER_TOLERANCE))


def option_key(node):
    return json.dumps([node["grade"], node["type"], node["name"],
                       [effect["desc"] for effect in node["effectList"] if effect["desc"]]],
                      ensure_ascii=False, separators=(",", ":"))


def optimize_connected(nodes, adjacent, root, power, budget, forced_roots=(), capacity_by_node=None, initial_nodes=None, seconds=None, allow_feasible=False, sequences=()):
    try:
        import numpy as np
        import scipy
        from scipy.optimize import Bounds, LinearConstraint, milp
        from scipy.sparse import coo_matrix
    except ImportError as error:
        raise RuntimeError("최적화 재계산에는 scripts/requirements.txt의 라이브러리가 필요합니다. 설치 후 --solve로 실행하십시오.") from error

    ids = sorted(nodes)
    index = {node_id: i for i, node_id in enumerate(ids)}
    edges = [(i, j) for i in ids for j in adjacent[i]]
    # sequences의 각 항목은 (노드 번호 목록, 값 목록)입니다. 그 노드들은 power가 0이어야 하며,
    # 선택한 개수만큼 값 목록의 앞에서부터 더합니다.
    steps = len(ids) + len(edges)
    size, capacity = steps + sum(len(values) for _, values in sequences), len(ids) - 1

    def total(selected):
        chosen = set(selected)
        return math.fsum([power[i] for i in chosen] + [value for members, values in sequences
                                                       for value in values[:sum(i in chosen for i in members)]])

    ceiling = math.fsum([max(0, value) for value in power.values()] + [value for _, values in sequences for value in values])
    objective = np.zeros(size)
    lower, upper = np.zeros(size), np.full(size, capacity, dtype=float)
    integrality = np.zeros(size, dtype=int)
    for node_id, i in index.items():
        objective[i] = -power[node_id]
        upper[i] = 1
        integrality[i] = 1
    excluded_roots = {root, *forced_roots}
    for forced in excluded_roots:
        lower[index[forced]] = 1
    rows, cols, values, lows, highs = [], [], [], [], []

    def constraint(coefficients, low, high):
        row = len(lows)
        for col, value in coefficients.items():
            if value == 0:
                continue
            rows.append(row)
            cols.append(col)
            values.append(value)
        lows.append(low)
        highs.append(high)

    # Exactly exhaust this board's allocation; no unused currency is permitted.
    constraint({index[i]: COSTS[nodes[i]["grade"]] for i in ids if i not in excluded_roots}, budget, budget)
    # Strengthen the relaxation with necessary local and separator connectivity.
    # These cuts do not remove any root-connected selection.
    for i in ids:
        if i in excluded_roots:
            continue
        coefficients = {index[j]: -1 for j in adjacent[i]}
        coefficients[index[i]] = 1
        constraint(coefficients, -np.inf, 0)
    for separator in ids:
        if separator in excluded_roots:
            continue
        reached, queue = {root}, [root]
        for i in queue:
            for other in adjacent[i]:
                if other != separator and other not in reached:
                    reached.add(other)
                    queue.append(other)
        for other in set(ids) - reached - {separator}:
            constraint({index[other]: 1, index[separator]: -1}, -np.inf, 0)
    balance = {i: {} for i in ids}
    for edge_index, (start, end) in enumerate(edges, len(ids)):
        # Each active nonroot node consumes one flow unit supplied by the root.
        edge_capacity = min((capacity_by_node or {}).get(start, capacity), (capacity_by_node or {}).get(end, capacity))
        upper[edge_index] = edge_capacity
        constraint({edge_index: 1, index[start]: -edge_capacity}, -np.inf, 0)
        constraint({edge_index: 1, index[end]: -edge_capacity}, -np.inf, 0)
        balance[start][edge_index] = -1
        balance[end][edge_index] = 1
    for node_id in ids:
        coefficients = balance[node_id]
        if node_id == root:
            coefficients.update({index[i]: 1 for i in ids if i != root})
        else:
            coefficients[index[node_id]] = -1
        constraint(coefficients, 0, 0)
    # 레벨별 값은 노드가 아니라 단계 변수에 둡니다. j번째 단계는 그 스킬의 노드가 j개 이상
    # 선택될 때만 켜지고 j번째 값을 받습니다.
    first = steps
    for members, level_values in sequences:
        columns = list(range(first, first + len(level_values)))
        first += len(level_values)
        for column, value in zip(columns, level_values):
            objective[column], upper[column], integrality[column] = -value, 1, 1
        constraint({**{index[i]: 1 for i in members}, **{column: -1 for column in columns}}, 0, 0)
        for earlier, later in zip(columns, columns[1:]):
            constraint({later: 1, earlier: -1}, -np.inf, 0)
    matrix = coo_matrix((values, (rows, cols)), shape=(len(lows), size)).tocsc()
    try:
        import highspy
    except ImportError:
        highspy = None
    if highspy is None:
        result = milp(objective, integrality=integrality, bounds=Bounds(lower, upper),
                      constraints=LinearConstraint(matrix, lows, highs),
                      options={"mip_rel_gap": 0, "disp": bool(os.environ.get("DAEVANION_SOLVER_LOG")),
                               **({"time_limit": seconds} if seconds is not None else {})})
        solver_name = f"SciPy {scipy.__version__} / HiGHS"
    else:
        solver = highspy.Highs()
        solver.setOptionValue("output_flag", bool(os.environ.get("DAEVANION_SOLVER_LOG")))
        solver.setOptionValue("mip_rel_gap", 0.0)
        solver.setOptionValue("mip_abs_gap", 0.0)
        if seconds is not None:
            solver.setOptionValue("time_limit", float(seconds))
        solver.addVars(size, lower, upper)
        solver.changeColsCost(size, np.arange(size, dtype=np.int32), objective)
        csr = matrix.tocsr()
        solver.addRows(len(lows), np.array(lows), np.array(highs), csr.nnz,
                       csr.indptr.astype(np.int32), csr.indices.astype(np.int32), csr.data)
        integer_columns = np.flatnonzero(integrality).astype(np.int32)
        solver.changeColsIntegrality(len(integer_columns), integer_columns, np.ones(len(integer_columns), dtype=np.uint8))
        # A partial start supplies the known connected source layout. Flow values
        # are completed by the solver; this does not constrain the search.
        warm = np.array([1 if i in excluded_roots else (int(i in initial_nodes) if initial_nodes is not None else nodes[i].get("open", 0)) for i in ids], dtype=float)
        chosen = {i for i, value in zip(ids, warm) if value}
        warm_steps = [float(step < sum(i in chosen for i in members))
                      for members, level_values in sequences for step in range(len(level_values))]
        solver.setSolution(len(ids) + len(warm_steps), np.concatenate([np.arange(len(ids)), np.arange(steps, size)]).astype(np.int32),
                           np.concatenate([warm, warm_steps]))
        solver.run()
        status = solver.getModelStatus()
        info = solver.getInfo()
        primal = solver.getSolution()
        if not primal.value_valid or info.primal_solution_status != int(highspy.kSolutionStatusFeasible):
            if allow_feasible and initial_nodes is not None:
                selected = sorted(i for i in initial_nodes if i not in excluded_roots)
                score = total(selected)
                bound = ceiling
                gap = (bound - score) / max(1, abs(score))
                return {"nodeIds": selected, "power": score, "upperBound": bound, "gap": gap,
                        "status": "optimal" if certified_optimal(score, bound, gap) else "feasible",
                        "solver": f"HiGHS {solver.version()} / validated starting layout"}
            if status == highspy.HighsModelStatus.kInfeasible:
                raise InfeasiblePlanError("해당 수량을 정확히 사용하는 연결 구성이 없습니다.")
            raise RuntimeError("최적화 계산에서 유효한 정수 구성을 받지 못했습니다.")
        result = SimpleNamespace(status=0 if status == highspy.HighsModelStatus.kOptimal else 2 if status == highspy.HighsModelStatus.kInfeasible else -1,
                                 x=primal.col_value, fun=info.objective_function_value,
                                 mip_dual_bound=info.mip_dual_bound, mip_gap=info.mip_gap, message=str(status))
        solver_name = f"HiGHS {solver.version()}"
    if result.status == 2:
        raise InfeasiblePlanError("해당 수량을 정확히 사용하는 연결 구성이 없습니다.")
    if (result.status != 0 and not allow_feasible) or result.x is None:
        raise RuntimeError(f"최적해를 증명하지 못했습니다: {result.message}")
    if not allow_feasible and not certified_optimal(-float(result.fun), -float(result.mip_dual_bound), float(result.mip_gap)):
        raise RuntimeError("전투력 합계와 최적화 상한이 허용 오차 안에서 일치하지 않습니다.")
    selected = sorted(i for i in ids if i not in excluded_roots and result.x[index[i]] > .5)
    score = total(selected)
    bound = -float(result.mip_dual_bound)
    if not math.isfinite(bound):
        bound = ceiling
    bound = max(score, bound)
    if all(float(value).is_integer() for value in [*power.values(), *(value for _, values in sequences for value in values)]):
        bound = max(score, math.floor(bound + POWER_TOLERANCE))
    gap = (bound - score) / max(1, abs(score))
    optimal = certified_optimal(score, bound, gap)
    return {"nodeIds": selected, "power": score, "upperBound": bound, "gap": gap,
            "status": "optimal" if optimal else "feasible", "solver": solver_name}


def build_power_plan(data, observations, *, recompute=False, cache_path=None):
    nodes = {n["nodeId"]: n for n in data["nodeList"] if n["type"] != "None"}
    positions = {(n["col"], n["row"]): i for i, n in nodes.items()}
    root = positions[(8, 8)]
    if cache_path is None:
        board_id = nodes[root]["boardId"]
        slug = {71: "nezkhan", 72: "zikel"}.get(board_id, f"board-{board_id}")
        cache_path = Path(__file__).resolve().parent.parent / "boards" / f"{slug}-optimization.json"
    adjacent = {i: [positions[p] for p in ((n["col"] - 1, n["row"]), (n["col"] + 1, n["row"]),
                                         (n["col"], n["row"] - 1), (n["col"], n["row"] + 1)) if p in positions]
                for i, n in nodes.items()}
    latest = {record["key"]: record for record in observations}
    power = {i: latest.get(option_key(n), {}).get("power", 0) for i, n in nodes.items()}
    budget = sum(COSTS[n["grade"]] for n in nodes.values() if n["open"] == 1 and n["type"] != "Start")
    model = {"version": 1, "root": root, "budget": budget,
             "nodes": [[i, n["col"], n["row"], COSTS[n["grade"]], power[i]] for i, n in sorted(nodes.items())]}
    model_hash = hashlib.sha256(json.dumps(model, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def validate(solution):
        if solution.get("modelHash") != model_hash or solution.get("status") != "optimal":
            return False
        ids = solution.get("nodeIds")
        if not isinstance(ids, list) or len(set(ids)) != len(ids) or any(i == root or i not in nodes for i in ids):
            return False
        active = set(ids)
        reached, queue = {root}, [root]
        for i in queue:
            for other in adjacent[i]:
                if other in active and other not in reached:
                    reached.add(other)
                    queue.append(other)
        total = math.fsum(power[i] for i in active)
        return (reached == active | {root}
                and sum(COSTS[nodes[i]["grade"]] for i in active) == budget
                and certified_optimal(total, solution.get("upperBound"), solution.get("gap"))
                and isinstance(solution.get("power"), (int, float))
                and math.isfinite(solution["power"])
                and math.isclose(total, solution["power"], rel_tol=0, abs_tol=POWER_TOLERANCE))

    solution = None
    if not recompute and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and validate(cached):
                solution = cached
        except (ValueError, TypeError):
            pass
    if solution is None:
        solution = {**optimize_connected(nodes, adjacent, root, power, budget), "modelHash": model_hash}
        if not validate(solution):
            raise RuntimeError("최적화 결과의 연결, 예산 또는 전투력 검증에 실패했습니다.")
        temporary = cache_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(solution, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(cache_path)

    return summarize_plan(data, observations, solution["nodeIds"], budget, solution)


def ordered_sum(values, ids):
    """노드 번호가 작은 순서로 더합니다. assets/optimizer.js의 score()와 같은 순서입니다."""
    total = 0
    for i in sorted(ids):
        total += values[i]
    return total


def summarize_plan(data, observations, node_ids, budget, solution, *, worth=None, source_worth=None, all_worth=None, levels=()):
    nodes = {n["nodeId"]: n for n in data["nodeList"] if n["type"] != "None"}
    positions = {(n["col"], n["row"]): i for i, n in nodes.items()}
    root = positions[(8, 8)]
    adjacent = {i: [positions[p] for p in ((n["col"] - 1, n["row"]), (n["col"] + 1, n["row"]),
                                         (n["col"], n["row"] - 1), (n["col"], n["row"] + 1)) if p in positions]
                for i, n in nodes.items()}
    latest = {record["key"]: record for record in observations}
    power = {i: latest.get(option_key(n), {}).get("power", 0) for i, n in nodes.items()}
    active = set(node_ids)
    candidates = [i for i, n in nodes.items() if n["type"] != "Start"]
    opened = [i for i in candidates if nodes[i]["open"] == 1]
    # 레벨별 값이 있는 스킬(levels)은 호출자가 score_selection()으로 노드마다 배정한 값을 받습니다.
    worth = {i: power[i] for i in active} if worth is None else worth
    source_worth = {i: power[i] for i in opened} if source_worth is None else source_worth
    all_worth = power if all_worth is None else all_worth
    counts = Counter(option_key(nodes[i]) for i in active)
    credited = Counter()
    for i in nodes:
        if i in active and option_key(nodes[i]) in levels:
            credited[option_key(nodes[i])] += worth[i]
    groups = []
    for key, count in counts.items():
        grade, kind, name, effects = json.loads(key)
        record = latest.get(key)
        if key in levels:
            # 이 보드의 노드에 배정된 값의 노드 1개당 평균입니다.
            group_power, basis = credited[key] / count, "level"
        else:
            group_power, basis = (record["power"], record.get("basis", "measured")) if record else (None, "unknown")
        groups.append({"key": key, "name": name, "grade": grade, "effects": effects, "count": count,
                       "cost": count * COSTS[grade], "power": group_power, "basis": basis})
    groups.sort(key=lambda g: (g["power"] is None, -(g["power"] or 0), g["key"]))
    queue, seen, activation_order = [root], {root}, []
    for i in queue:
        for other in sorted(adjacent[i]):
            if other in active and other not in seen:
                seen.add(other)
                queue.append(other)
                n = nodes[other]
                activation_order.append({"nodeId": other, "col": n["col"], "row": n["row"],
                                         "name": n["name"], "grade": n["grade"]})
    stats = {}
    for i, n in nodes.items():
        if n["type"] != "Stat":
            continue
        effects = [effect["desc"] for effect in n["effectList"] if effect["desc"]]
        for effect in effects:
            match = re.fullmatch(r"(.*?)\s+([+-][\d.,]+)(%?)", effect)
            if not match:
                continue
            name, value, unit = match.groups()
            row = stats.setdefault((name, unit), {"name": name, "unit": unit,
                                   "source": 0, "target": 0, "sourcePower": 0, "targetPower": 0,
                                   "powerKnown": True})
            if n["open"] == 1:
                row["source"] += float(value.replace(",", ""))
                row["sourcePower"] += power[i]
            if i in active:
                row["target"] += float(value.replace(",", ""))
                row["targetPower"] += power[i]
            if (n["open"] == 1 or i in active) and (len(effects) != 1 or option_key(n) not in latest):
                row["powerKnown"] = False
    order = ["추가 공격력", "추가 방어력", "치명타", "치명타 저항", "생명력", "정신력", "전투 속도", "재시전 시간 감소"]
    comparison = []
    for row in sorted(stats.values(), key=lambda row: (order.index(row["name"]) if row["name"] in order else len(order), row["name"])):
        comparison.append({"name": row["name"], "unit": row["unit"],
                           "source": row["source"], "target": row["target"],
                           "difference": row["target"] - row["source"],
                           "powerDifference": row["targetPower"] - row["sourcePower"] if row["powerKnown"] else None})
    original_skills = {i for i, n in nodes.items() if n["type"] == "SkillLevel" and n["open"] == 1}
    selected_skills = {i for i in active if nodes[i]["type"] == "SkillLevel"}
    return {"boardId": nodes[root]["boardId"], "budget": budget, "cost": budget,
            "power": ordered_sum(worth, active), "powerUpperBound": solution["upperBound"],
            "allNodesPower": ordered_sum(all_worth, candidates),
            "sourcePower": ordered_sum(source_worth, opened),
            "valuedNodeCount": sum(worth[i] > 0 for i in active),
            "valuedCandidateCount": sum(all_worth[i] > 0 for i in candidates),
            "connectorCount": sum(option_key(nodes[i]) not in latest and option_key(nodes[i]) not in levels for i in active),
            "nodeIds": sorted(active), "groups": groups, "activationOrder": activation_order,
            "statComparison": comparison, "skillsUnchanged": original_skills == selected_skills,
            "optimality": {k: solution[k] for k in ("status", "gap", "solver", "modelHash")},
            "note": "옵션별 기록값과 스킬 레벨별 값을 합산하여 루트 연결과 수량 조건을 지키는 전투력 우선 구성입니다. 최고값 확정 여부는 최적성 상태를 확인하십시오. 실제 캐릭터 전투력은 옵션 간 영향에 따라 달라질 수 있습니다."}


def shared_model(boards, observations, skills=None):
    """보드들을 공용 수량 문제 하나로 묶고 입력 해시를 계산합니다.

    skills는 옵션 키별 레벨 값 목록입니다. 목록이 있는 스킬은 선택한 노드 수만큼 앞에서부터
    값을 더하고, 없는 옵션은 observations의 마지막 기록값을 노드마다 더합니다.
    """
    skills = skills or {}
    latest = {record["key"]: record for record in observations}
    nodes, adjacent, roots, board_ids = {}, {}, [], []
    budget = 0
    for data in boards:
        board_nodes = {n["nodeId"]: n for n in data["nodeList"] if n["type"] != "None"}
        if nodes.keys() & board_nodes.keys():
            raise ValueError("보드 사이에 중복된 노드 번호가 있습니다.")
        positions = {(n["col"], n["row"]): i for i, n in board_nodes.items()}
        root = positions[(8, 8)]
        roots.append(root)
        board_ids.append(board_nodes[root]["boardId"])
        nodes.update(board_nodes)
        for i, n in board_nodes.items():
            adjacent[i] = [positions[p] for p in ((n["col"] - 1, n["row"]), (n["col"] + 1, n["row"]),
                                                (n["col"], n["row"] - 1), (n["col"], n["row"] + 1)) if p in positions]
            levelled = n["type"] == "SkillLevel" and option_key(n) in skills
            if i != root and option_key(n) not in latest and not levelled and n["boardId"] != 79:
                raise ValueError("전체 최적화에는 모든 노드의 전투력 값이 필요합니다.")
            if i != root and n["open"] == 1:
                budget += COSTS[n["grade"]]
    levels, level_of = {}, {}
    for i, n in sorted(nodes.items()):
        key = option_key(n)
        if i not in roots and n["type"] == "SkillLevel" and key in skills:
            levels.setdefault(key, {"values": skills[key], "nodes": []})["nodes"].append(i)
            level_of[i] = key
    for level in levels.values():
        values = level["values"]
        if (not isinstance(values, list) or len(values) < len(level["nodes"])
                or any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in values)):
            raise ValueError("스킬 레벨별 전투력값이 올바르지 않습니다.")
        level["values"] = values[:len(level["nodes"])]
    power = {i: None if i in level_of else latest.get(option_key(n), {}).get("power", 0) for i, n in nodes.items()}
    budget = planning_budget(budget)
    model = {"version": 1, "roots": sorted(roots), "budget": budget,
             "nodes": [[i, n["boardId"], n["col"], n["row"], COSTS[n["grade"]], power[i]] for i, n in sorted(nodes.items())]}
    # 레벨별 값이 없는 모형은 이전과 같은 해시를 유지합니다.
    if levels:
        model["skills"] = [[key, levels[key]["values"]] for key in sorted(levels)]
    model_hash = hashlib.sha256(json.dumps(model, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return SimpleNamespace(nodes=nodes, adjacent=adjacent, roots=roots, board_ids=board_ids, latest=latest,
                           power=power, levels=levels, level_of=level_of, budget=budget, hash=model_hash)


def score_selection(model, selected):
    """선택한 노드의 전투력 합계, 보드별 합계, 노드별 배정값을 돌려줍니다.

    보드는 주어진 순서로, 보드 안의 노드는 번호가 작은 순서로 더합니다. 레벨별 값이 있는
    스킬은 이 순서에서 j번째로 선택된 노드에 j번째 값을 배정합니다. assets/optimizer.js의
    score()와 같은 순서이므로 두 계산의 결과는 마지막 자리까지 같습니다.
    """
    by_board = {board_id: [] for board_id in model.board_ids}
    for i in selected:
        by_board[model.nodes[i]["boardId"]].append(i)
    counts, worth, boards = Counter(), {}, {}
    total = 0
    for board_id in model.board_ids:
        subtotal = 0
        for i in sorted(by_board[board_id]):
            key = model.level_of.get(i)
            if key is None:
                worth[i] = model.power[i]
            else:
                worth[i] = model.levels[key]["values"][counts[key]]
                counts[key] += 1
            subtotal += worth[i]
        boards[board_id] = subtotal
        total += subtotal
    return total, boards, worth


def build_all_power_plan(boards, observations, *, recompute=False, cache_path=None, skills=None):
    if cache_path is None:
        cache_path = Path(__file__).resolve().parent.parent / "boards" / "all-optimization.json"
    model = shared_model(boards, observations, skills)
    latest, nodes, adjacent, roots, budget, model_hash = model.latest, model.nodes, model.adjacent, model.roots, model.budget, model.hash

    def validate(solution):
        ids = solution.get("nodeIds")
        if solution.get("modelHash") != model_hash or solution.get("status") not in {"optimal", "feasible"} or not isinstance(ids, list):
            return False
        if len(set(ids)) != len(ids) or any(i in roots or i not in nodes for i in ids):
            return False
        active = set(ids)
        reached, queue = set(roots), list(roots)
        for i in queue:
            for other in adjacent[i]:
                if other in active and other not in reached:
                    reached.add(other)
                    queue.append(other)
        total = score_selection(model, active)[0]
        return (reached == active | set(roots)
                and sum(COSTS[nodes[i]["grade"]] for i in active) == budget
                and isinstance(solution.get("upperBound"), (int, float)) and math.isfinite(solution["upperBound"])
                and solution["upperBound"] >= total - POWER_TOLERANCE
                and isinstance(solution.get("gap"), (int, float)) and math.isfinite(solution["gap"])
                and math.isclose(solution["gap"], (solution["upperBound"] - total) / max(1, abs(total)), rel_tol=0, abs_tol=1e-9)
                and (solution["status"] != "optimal" or certified_optimal(total, solution["upperBound"], solution["gap"]))
                and isinstance(solution.get("power"), (int, float))
                and math.isclose(total, solution["power"], rel_tol=0, abs_tol=POWER_TOLERANCE))

    solution = None
    if not recompute and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and validate(cached):
                solution = cached
        except (ValueError, TypeError):
            pass
    if solution is None:
        warm_start = {i for i, n in nodes.items() if i not in roots and n["open"] == 1}
        slugs = {71: "nezkhan", 72: "zikel", 73: "vaizel", 74: "triniel", 79: "lumiel"}
        try:
            combined = set()
            for board_id in sorted({n["boardId"] for n in nodes.values()}):
                path = cache_path.parent / f"{slugs.get(board_id, f'board-{board_id}')}-power-plan.json"
                combined.update(json.loads(path.read_text(encoding="utf-8"))["nodeIds"])
            reached, queue = set(roots), list(roots)
            for i in queue:
                for other in adjacent[i]:
                    if other in combined and other not in reached:
                        reached.add(other); queue.append(other)
            if (combined <= nodes.keys() - set(roots) and reached == combined | set(roots)
                    and sum(COSTS[nodes[i]["grade"]] for i in combined) == budget
                    and score_selection(model, combined)[0] > score_selection(model, warm_start)[0]):
                warm_start = combined
        except (OSError, ValueError, KeyError, TypeError):
            pass
        virtual_root = -1
        virtual_nodes = {**nodes, virtual_root: {"grade": "None"}}
        virtual_adjacent = {i: neighbors + ([virtual_root] if i in roots else []) for i, neighbors in adjacent.items()}
        virtual_adjacent[virtual_root] = roots
        sizes = Counter(n["boardId"] for n in nodes.values())
        capacities = {i: sizes[n["boardId"]] for i, n in nodes.items()}
        usable_start = sum(COSTS[nodes[i]["grade"]] for i in warm_start) == budget
        calculated = optimize_connected(virtual_nodes, virtual_adjacent, virtual_root,
                                        {**{i: 0 if value is None else value for i, value in model.power.items()}, virtual_root: 0},
                                        budget, forced_roots=roots,
                                        capacity_by_node=capacities, initial_nodes=warm_start if usable_start else None,
                                        seconds=120, allow_feasible=True,
                                        sequences=[(level["nodes"], level["values"]) for level in model.levels.values()])
        # 점수는 저장본을 검증할 때와 같은 순서로 다시 계산하고, 시작 구성보다 낮은 결과는 쓰지 않습니다.
        best = set(calculated["nodeIds"])
        if usable_start and score_selection(model, best)[0] < score_selection(model, warm_start)[0]:
            best = warm_start
        calculated["nodeIds"] = sorted(best)
        calculated["power"] = score_selection(model, best)[0]
        calculated["upperBound"] = max(calculated["upperBound"], calculated["power"])
        calculated["gap"] = (calculated["upperBound"] - calculated["power"]) / max(1, abs(calculated["power"]))
        calculated["status"] = "optimal" if certified_optimal(calculated["power"], calculated["upperBound"], calculated["gap"]) else "feasible"
        solution = {**calculated, "modelHash": model_hash}
        if not validate(solution):
            raise RuntimeError("전체 구성의 연결, 수량 또는 최적성 검증에 실패했습니다.")
        temporary = cache_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(solution, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(cache_path)
    selected = set(solution["nodeIds"])
    # 구성과 원본에 각각 따로 값을 배정하므로 보드별 합계를 더하면 전체 합계와 같습니다.
    total, board_power, worth = score_selection(model, selected)
    source_total, _, source_worth = score_selection(model, {i for i, n in nodes.items() if i not in roots and n["open"] == 1})
    all_worth = score_selection(model, nodes.keys() - set(roots))[2]
    solution = {**solution, "power": total, "gap": (solution["upperBound"] - total) / max(1, abs(total))}
    known = latest.keys() | model.levels.keys()
    plans = {}
    for data in boards:
        board_id = data["nodeList"][0]["boardId"]
        ids = sorted(i for i in selected if nodes[i]["boardId"] == board_id)
        spent = sum(COSTS[nodes[i]["grade"]] for i in ids)
        score = board_power[board_id]
        shared_slack = solution["upperBound"] - solution["power"]
        conditional = {**solution, "upperBound": score + shared_slack,
                       "gap": shared_slack / max(1, abs(score))}
        plans[board_id] = summarize_plan(data, observations, ids, spent, conditional, worth=worth,
                                         source_worth=source_worth, all_worth=all_worth, levels=model.levels.keys())
        plans[board_id]["sourceBudget"] = sum(COSTS[n["grade"]] for n in data["nodeList"] if n["type"] not in {"None", "Start"} and n["open"] == 1)
        plans[board_id]["unknownCount"] = len({option_key(n) for n in data["nodeList"] if n["type"] not in {"None", "Start"} and option_key(n) not in known})
        plans[board_id]["optimality"]["scope"] = "shared"
        plans[board_id]["optimality"]["sharedGap"] = solution["gap"]
    return {"budget": budget, "cost": budget, "power": total, "sourcePower": source_total,
            "powerDifference": total - source_total, "powerUpperBound": solution["upperBound"],
            "nodeCount": len(selected), "boards": plans,
            "unknownCount": len({option_key(n) for n in nodes.values() if n["type"] != "Start" and option_key(n) not in known}),
            "optimality": {k: solution[k] for k in ("status", "gap", "solver", "modelHash")}}
