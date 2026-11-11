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


def optimize_connected(nodes, adjacent, root, power, budget, forced_roots=(), capacity_by_node=None, initial_nodes=None, seconds=None, allow_feasible=False):
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
    size, capacity = len(ids) + len(edges), len(ids) - 1
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
        solver.changeColsIntegrality(len(ids), np.arange(len(ids), dtype=np.int32), integrality[:len(ids)].astype(np.uint8))
        # A partial start supplies the known connected source layout. Flow values
        # are completed by the solver; this does not constrain the search.
        warm = np.array([1 if i in excluded_roots else (int(i in initial_nodes) if initial_nodes is not None else nodes[i].get("open", 0)) for i in ids], dtype=float)
        solver.setSolution(len(ids), np.arange(len(ids), dtype=np.int32), warm)
        solver.run()
        status = solver.getModelStatus()
        info = solver.getInfo()
        primal = solver.getSolution()
        if not primal.value_valid or info.primal_solution_status != int(highspy.kSolutionStatusFeasible):
            if allow_feasible and initial_nodes is not None:
                selected = sorted(i for i in initial_nodes if i not in excluded_roots)
                score = math.fsum(power[i] for i in selected)
                bound = math.fsum(max(0, value) for value in power.values())
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
    score = math.fsum(power[i] for i in selected)
    bound = -float(result.mip_dual_bound)
    if not math.isfinite(bound):
        bound = math.fsum(power.values())
    bound = max(score, bound)
    if all(float(value).is_integer() for value in power.values()):
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


def summarize_plan(data, observations, node_ids, budget, solution):
    nodes = {n["nodeId"]: n for n in data["nodeList"] if n["type"] != "None"}
    positions = {(n["col"], n["row"]): i for i, n in nodes.items()}
    root = positions[(8, 8)]
    adjacent = {i: [positions[p] for p in ((n["col"] - 1, n["row"]), (n["col"] + 1, n["row"]),
                                         (n["col"], n["row"] - 1), (n["col"], n["row"] + 1)) if p in positions]
                for i, n in nodes.items()}
    latest = {record["key"]: record for record in observations}
    power = {i: latest.get(option_key(n), {}).get("power", 0) for i, n in nodes.items()}
    active = set(node_ids)
    counts = Counter(option_key(nodes[i]) for i in active)
    groups = []
    for key, count in counts.items():
        grade, kind, name, effects = json.loads(key)
        record = latest.get(key)
        groups.append({"key": key, "name": name, "grade": grade, "effects": effects, "count": count,
                       "cost": count * COSTS[grade], "power": record["power"] if record else None,
                       "basis": record.get("basis", "measured") if record else "unknown"})
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
            "power": math.fsum(power[i] for i in active), "powerUpperBound": solution["upperBound"],
            "allNodesPower": math.fsum(power.values()),
            "sourcePower": math.fsum(power[i] for i, n in nodes.items() if n["open"] == 1),
            "valuedNodeCount": sum(power[i] > 0 for i in active),
            "valuedCandidateCount": sum(value > 0 for value in power.values()),
            "connectorCount": sum(option_key(nodes[i]) not in latest for i in active),
            "nodeIds": sorted(active), "groups": groups, "activationOrder": activation_order,
            "statComparison": comparison, "skillsUnchanged": original_skills == selected_skills,
            "optimality": {k: solution[k] for k in ("status", "gap", "solver", "modelHash")},
            "note": "측정·추정·고정값을 단순 합산하여 루트 연결과 수량 조건을 지키는 전투력 우선 구성입니다. 최고값 확정 여부는 최적성 상태를 확인하십시오. 실제 캐릭터 전투력은 옵션 간 영향에 따라 달라질 수 있습니다."}


def build_all_power_plan(boards, observations, *, recompute=False, cache_path=None):
    if cache_path is None:
        cache_path = Path(__file__).resolve().parent.parent / "boards" / "all-optimization.json"
    latest = {record["key"]: record for record in observations}
    nodes, adjacent, roots = {}, {}, []
    budget = 0
    for data in boards:
        board_nodes = {n["nodeId"]: n for n in data["nodeList"] if n["type"] != "None"}
        if nodes.keys() & board_nodes.keys():
            raise ValueError("보드 사이에 중복된 노드 번호가 있습니다.")
        positions = {(n["col"], n["row"]): i for i, n in board_nodes.items()}
        root = positions[(8, 8)]
        roots.append(root)
        nodes.update(board_nodes)
        for i, n in board_nodes.items():
            adjacent[i] = [positions[p] for p in ((n["col"] - 1, n["row"]), (n["col"] + 1, n["row"]),
                                                (n["col"], n["row"] - 1), (n["col"], n["row"] + 1)) if p in positions]
            if i != root and option_key(n) not in latest and n["boardId"] != 79:
                raise ValueError("전체 최적화에는 모든 노드의 전투력 값이 필요합니다.")
            if i != root and n["open"] == 1:
                budget += COSTS[n["grade"]]
    power = {i: latest.get(option_key(n), {}).get("power", 0) for i, n in nodes.items()}
    budget = planning_budget(budget)
    model = {"version": 1, "roots": sorted(roots), "budget": budget,
             "nodes": [[i, n["boardId"], n["col"], n["row"], COSTS[n["grade"]], power[i]] for i, n in sorted(nodes.items())]}
    model_hash = hashlib.sha256(json.dumps(model, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

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
        total = math.fsum(power[i] for i in active)
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
                    and sum(power[i] for i in combined) > sum(power[i] for i in warm_start)):
                warm_start = combined
        except (OSError, ValueError, KeyError, TypeError):
            pass
        virtual_root = -1
        virtual_nodes = {**nodes, virtual_root: {"grade": "None"}}
        virtual_adjacent = {i: neighbors + ([virtual_root] if i in roots else []) for i, neighbors in adjacent.items()}
        virtual_adjacent[virtual_root] = roots
        sizes = Counter(n["boardId"] for n in nodes.values())
        capacities = {i: sizes[n["boardId"]] for i, n in nodes.items()}
        calculated = optimize_connected(virtual_nodes, virtual_adjacent, virtual_root,
                                        {**power, virtual_root: 0}, budget, forced_roots=roots,
                                        capacity_by_node=capacities, initial_nodes=warm_start if sum(COSTS[nodes[i]["grade"]] for i in warm_start) == budget else None,
                                        seconds=120, allow_feasible=True)
        if sum(COSTS[nodes[i]["grade"]] for i in warm_start) == budget and calculated["power"] < sum(power[i] for i in warm_start):
            calculated["nodeIds"] = sorted(warm_start)
            calculated["power"] = sum(power[i] for i in warm_start)
            calculated["gap"] = (calculated["upperBound"] - calculated["power"]) / max(1, abs(calculated["power"]))
            calculated["status"] = "optimal" if certified_optimal(calculated["power"], calculated["upperBound"], calculated["gap"]) else "feasible"
        solution = {**calculated, "modelHash": model_hash}
        if not validate(solution):
            raise RuntimeError("전체 구성의 연결, 수량 또는 최적성 검증에 실패했습니다.")
        temporary = cache_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(solution, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(cache_path)
    selected = set(solution["nodeIds"])
    plans = {}
    for data in boards:
        board_id = data["nodeList"][0]["boardId"]
        ids = sorted(i for i in selected if nodes[i]["boardId"] == board_id)
        spent = sum(COSTS[nodes[i]["grade"]] for i in ids)
        score = math.fsum(power[i] for i in ids)
        shared_slack = solution["upperBound"] - solution["power"]
        conditional = {**solution, "upperBound": score + shared_slack,
                       "gap": shared_slack / max(1, abs(score))}
        plans[board_id] = summarize_plan(data, observations, ids, spent, conditional)
        plans[board_id]["sourceBudget"] = sum(COSTS[n["grade"]] for n in data["nodeList"] if n["type"] not in {"None", "Start"} and n["open"] == 1)
        plans[board_id]["unknownCount"] = len({option_key(n) for n in data["nodeList"] if n["type"] not in {"None", "Start"} and option_key(n) not in latest})
        plans[board_id]["optimality"]["scope"] = "shared"
        plans[board_id]["optimality"]["sharedGap"] = solution["gap"]
    source_power = math.fsum(plan["sourcePower"] for plan in plans.values())
    return {"budget": budget, "cost": budget, "power": solution["power"], "sourcePower": source_power,
            "powerDifference": solution["power"] - source_power, "powerUpperBound": solution["upperBound"],
            "nodeCount": len(selected), "boards": plans,
            "unknownCount": len({option_key(n) for n in nodes.values() if n["type"] != "Start" and option_key(n) not in latest}),
            "optimality": {k: solution[k] for k in ("status", "gap", "solver", "modelHash")}}
