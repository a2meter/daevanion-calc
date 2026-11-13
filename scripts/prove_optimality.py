#!/usr/bin/env python3
"""공용 예산 보드의 정수 최적값을 독립적인 정점 절단 모형으로 검증합니다."""

import argparse
from collections import deque
import hashlib
import itertools
import json
import math
from pathlib import Path
from optimize_board import shared_model
import time

ROOT = Path(__file__).resolve().parent.parent
COSTS = {"None": 0, "Common": 1, "Rare": 2, "Legend": 3, "Unique": 4}


def key(node):
    return json.dumps([node["grade"], node["type"], node["name"],
                       [effect["desc"] for effect in node["effectList"] if effect["desc"]]],
                      ensure_ascii=False, separators=(",", ":"))


def generated(name, variable):
    source = (ROOT / "boards" / name).read_text(encoding="utf-8")
    return json.loads(source.split(f"window.{variable} = ", 1)[1].strip().removesuffix(";"))


def load_shared():
    """생성된 측정값과 스킬 레벨별 값으로 build_boards.py와 같은 공용 수량 모형을 만듭니다."""
    skills = {item["key"]: item["values"] for item in generated("skill-values.js", "DAEVANION_SKILL_VALUES")}
    boards = [json.loads((ROOT / f"boards/{board_id}.json").read_text(encoding="utf-8")) for board_id in [71, 72, 73, 74, 79]]
    return shared_model(boards, generated("measurements.js", "DAEVANION_MEASUREMENTS"), skills)


def load_model():
    model = load_shared()
    nodes, roots = model.nodes, model.roots
    adjacency = {i: set(neighbors) for i, neighbors in model.adjacent.items()}
    costs = {i: COSTS[n["grade"]] if i not in roots else 0 for i, n in nodes.items()}
    # 레벨별 값이 있는 스킬 노드의 power는 None입니다. 노드별 합산으로는 계산할 수 없습니다.
    return nodes, adjacency, roots, model.power, costs, model.budget, model.hash


def reach(adjacency, starts, forbidden=frozenset(), allowed=None):
    seen = set(starts) - set(forbidden)
    queue = deque(seen)
    while queue:
        for other in adjacency[queue.popleft()]:
            if other not in seen and other not in forbidden and (allowed is None or other in allowed):
                seen.add(other)
                queue.append(other)
    return seen


def valid_selection(ids, nodes, adjacency, roots, costs, budget):
    selected = set(ids)
    return (len(selected) == len(ids) and not selected.intersection(roots)
            and selected <= nodes.keys() and sum(costs[i] for i in selected) == budget
            and reach(adjacency, roots, allowed=selected | set(roots)) == selected | set(roots))


def minimal_separator(target, boundary, adjacency, roots, reverse=False):
    """실제 그래프의 분리 여부를 확인하며 불필요한 절단 정점을 제거합니다."""
    separator = set(boundary)
    for node in sorted(boundary, reverse=reverse):
        trial = separator - {node}
        if target not in reach(adjacency, roots, forbidden=trial):
            separator = trial
    assert target not in separator and not separator.intersection(roots)
    assert target not in reach(adjacency, roots, forbidden=separator)
    return tuple(sorted(separator))


def solve(seconds=300, output=None, resume=None):
    nodes, adjacent, roots, power, costs, budget, digest = load_model()
    if any(type(value) is not int or value < 0 for value in power.values()):
        raise RuntimeError("이 증명은 노드마다 정수 전투력을 더하는 모형에만 적용됩니다. 스킬 레벨별 값이나 소수 평균값이 있는 모형은 검증할 수 없습니다.")
    import highspy
    import numpy as np
    from scipy.sparse import coo_matrix

    initial = json.loads((ROOT / "boards/all-optimization.json").read_text(encoding="utf-8"))
    assert initial["modelHash"] == digest, "원본 최적화 모형과 일치하지 않습니다."
    assert valid_selection(initial["nodeIds"], nodes, adjacent, roots, costs, budget)
    best_ids = sorted(initial["nodeIds"])
    restored_cuts = []
    if resume is not None:
        state = json.loads(Path(resume).read_text(encoding="utf-8"))
        assert state["modelHash"] == digest, "재시작 모형이 다릅니다."
        if valid_selection(state["nodeIds"], nodes, adjacent, roots, costs, budget):
            if sum(power[i] for i in state["nodeIds"]) > sum(power[i] for i in best_ids):
                best_ids = sorted(state["nodeIds"])
        for target, boundary in state["cuts"]:
            assert target in nodes and target not in roots and target not in boundary
            assert set(boundary) <= nodes.keys() and not set(boundary).intersection(roots)
            assert target not in reach(adjacent, roots, forbidden=boundary)
            restored_cuts.append((target, tuple(boundary)))
    best_power = sum(power[i] for i in best_ids)
    assert sum(power[i] for i in initial["nodeIds"]) == initial["power"]
    # The cached witness is independently validated above. Its alleged upper
    # bound is deliberately ignored: only this solve can certify a bound.
    bound = sum(power.values())
    ids = sorted(nodes)
    index = {i: k for k, i in enumerate(ids)}
    cuts = set(restored_cuts)
    started = time.monotonic()
    # For any separator S and vertex v disconnected from its root in G-S,
    # x[v] <= sum(x[s] for s in S) is necessary for every valid layout.
    for root in roots:
        board = reach(adjacent, [root])
        singles = {}
        for a in board - {root}:
            detached = board - reach(adjacent, [root], {a}) - {a}
            singles[a] = detached
            cuts.update((v, (a,)) for v in detached)
        for a, b in itertools.combinations(sorted(board - {root}), 2):
            detached = board - reach(adjacent, [root], {a, b}) - {a, b}
            detached -= singles[a] | singles[b]
            cuts.update((v, (a, b)) for v in detached)
    solver = highspy.Highs()
    solver.setOptionValue("output_flag", False)
    solver.setOptionValue("mip_rel_gap", 0.0)
    solver.setOptionValue("mip_abs_gap", 0.0)
    solver.setOptionValue("threads", 2)
    lower, upper = np.zeros(len(ids)), np.ones(len(ids))
    for root in roots:
        lower[index[root]] = 1
    solver.addVars(len(ids), lower, upper)
    solver.changeColsCost(len(ids), np.arange(len(ids), dtype=np.int32), np.array([-power[i] for i in ids], dtype=float))
    solver.changeColsIntegrality(len(ids), np.arange(len(ids), dtype=np.int32), np.ones(len(ids), dtype=np.uint8))

    def add_rows(items):
        row, col, values = [], [], []
        for r, (target, separator) in enumerate(items):
            row.append(r); col.append(index[target]); values.append(1.)
            for other in separator:
                row.append(r); col.append(index[other]); values.append(-1.)
        matrix = coo_matrix((values, (row, col)), shape=(len(items), len(ids))).tocsr()
        solver.addRows(len(items), np.full(len(items), -np.inf), np.zeros(len(items)), matrix.nnz,
                       matrix.indptr.astype(np.int32), matrix.indices.astype(np.int32), matrix.data)

    add_rows(sorted(cuts))
    budget_indices = np.array([index[i] for i in ids if costs[i]], dtype=np.int32)
    solver.addRow(budget, budget, len(budget_indices), budget_indices, np.array([costs[ids[j]] for j in budget_indices], dtype=float))
    # The verified incumbent proves that lower-scoring layouts can be removed
    # without changing the maximum. An explicit row also aids propagation.
    solver.addRow(best_power, np.inf, len(ids), np.arange(len(ids), dtype=np.int32),
                  np.array([power[i] for i in ids], dtype=float))
    solver.setSolution(len(ids), np.arange(len(ids), dtype=np.int32), np.array([int(i in best_ids or i in roots) for i in ids], dtype=float))
    iterations = 0
    statuses = []
    output = Path(output or ROOT / "boards/optimality-proof.json")
    def checkpoint():
        state = {"modelHash": digest, "nodeIds": best_ids, "cuts": sorted(cuts),
                 "power": best_power, "upperBound": bound,
                 "note": "재시작 시 모든 절단의 그래프 분리와 실현 구성을 다시 검증하며 상한은 새로 계산합니다."}
        temporary = output.with_suffix(".state.json.tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        temporary.replace(output.with_suffix(".state.json"))

    while time.monotonic() - started < seconds:
        remaining = seconds - (time.monotonic() - started)
        solver.setOptionValue("time_limit", min(60., max(.01, remaining)))
        solver.run()
        iterations += 1
        info = solver.getInfo()
        status = solver.getModelStatus()
        statuses.append(str(status))
        if info.valid and math.isfinite(info.mip_dual_bound):
            candidate_bound = -info.mip_dual_bound
            if candidate_bound < best_power - 1e-6:
                raise RuntimeError("솔버 상한이 독립 검증한 실현 구성보다 낮습니다.")
            bound = min(bound, math.floor(candidate_bound + 1e-6))
        primal = solver.getSolution()
        if primal.value_valid and info.primal_solution_status == int(highspy.kSolutionStatusFeasible):
            selected = {i for i in ids if i not in roots and primal.col_value[index[i]] > .5}
            if valid_selection(list(selected), nodes, adjacent, roots, costs, budget):
                score = sum(power[i] for i in selected)
                if score > best_power:
                    best_ids, best_power = sorted(selected), score
                if bound == best_power:
                    break
                # A connected optimum of the relaxation is a certified optimum.
                if status == highspy.HighsModelStatus.kOptimal:
                    bound = best_power
                    break
            else:
                new = set()
                unseen = selected - reach(adjacent, roots, allowed=selected | set(roots))
                while unseen:
                    comp = reach(adjacent, [next(iter(unseen))], allowed=unseen)
                    boundary = set().union(*(adjacent[i] for i in comp)) - comp
                    for v in comp:
                        new.add((v, minimal_separator(v, boundary, adjacent, roots)))
                        new.add((v, minimal_separator(v, boundary, adjacent, roots, reverse=True)))
                    unseen -= comp
                new -= cuts
                if new:
                    cuts.update(new)
                    add_rows(sorted(new))
                    solver.setSolution(len(ids), np.arange(len(ids), dtype=np.int32), np.array([int(i in best_ids or i in roots) for i in ids], dtype=float))
        checkpoint()
        print(json.dumps({"iteration": iterations, "power": best_power, "upperBound": bound, "cuts": len(cuts), "seconds": round(time.monotonic()-started, 2)}, ensure_ascii=False), flush=True)
        if bound == best_power:
            break
    assert valid_selection(best_ids, nodes, adjacent, roots, costs, budget)
    assert sum(power[i] for i in best_ids) == best_power
    result = {"modelHash": digest, "status": "optimal" if bound == best_power else "feasible",
              "power": best_power, "upperBound": bound, "gap": (bound-best_power)/max(1, abs(best_power)),
              "budget": budget, "cost": sum(costs[i] for i in best_ids), "nodeIds": best_ids,
              "method": "정점 절단 부등식의 정수 완화 모형과 독립 연결 검증", "solver": f"HiGHS {solver.version()}",
              "iterations": iterations, "cutCount": len(cuts), "seconds": time.monotonic()-started,
              "solverStatuses": statuses,
              "proofScope": "저장된 원본 보드와 전투력 측정값의 합산 모형"}
    checkpoint()
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=300)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume", type=Path)
    args = parser.parse_args()
    report = solve(args.seconds, args.output, args.resume)
    print(json.dumps({k: v for k, v in report.items() if k != "nodeIds"}, ensure_ascii=False, indent=2))
