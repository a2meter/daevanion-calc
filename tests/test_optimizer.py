"""작은 그래프를 전수 조사하여 연결·예산 제약 최적화와 비교합니다."""

from itertools import combinations
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from optimize_board import COSTS, build_power_plan, build_all_power_plan, optimize_connected, option_key, score_selection, shared_model


def node(i, col, row, grade="Common", opened=0, root=False):
    return {"nodeId": i, "boardId": 71, "col": col, "row": row,
            "grade": "None" if root else grade, "open": opened,
            "type": "Start" if root else "Stat", "name": f"노드 {i}",
            "effectList": [] if root else [{"desc": f"효과 {i}"}]}


def skill(i, col, row, board=71, opened=0):
    """한 스킬의 노드는 어느 보드에 있든 같은 옵션 키를 가집니다."""
    return {"nodeId": i, "boardId": board, "col": col, "row": row, "grade": "Common", "open": opened,
            "type": "SkillLevel", "name": "스킬 레벨 상승 - 시험", "effectList": [{"desc": "시험 +1"}]}


def brute_force_levels(boards, powers, sequence, budget):
    """보드별 루트 연결과 수량을 직접 확인하고, 스킬은 선택한 노드 수만큼 값을 앞에서부터 더합니다."""
    choices = [n for board in boards for n in board if n["type"] != "Start"]
    best = None
    for size in range(len(choices) + 1):
        for subset in combinations(choices, size):
            if sum(COSTS[n["grade"]] for n in subset) != budget:
                continue
            connected = True
            for board in boards:
                root = next(n for n in board if n["type"] == "Start")
                positions = {(n["col"], n["row"]) for n in subset if n["boardId"] == root["boardId"]}
                start = (root["col"], root["row"])
                reached, queue = {start}, [start]
                for c, r in queue:
                    for other in ((c - 1, r), (c + 1, r), (c, r - 1), (c, r + 1)):
                        if other in positions and other not in reached:
                            reached.add(other)
                            queue.append(other)
                connected = connected and reached == positions | {start}
            if connected:
                count = sum(n["type"] == "SkillLevel" for n in subset)
                score = sum(powers[n["nodeId"]] for n in subset if n["type"] != "SkillLevel") + sum(sequence[:count])
                best = score if best is None else max(best, score)
    return best


def brute_force(nodes, powers, budget):
    root = next(n for n in nodes if n["type"] == "Start")
    choices = [n for n in nodes if n != root]
    best = None
    for size in range(len(choices) + 1):
        for subset in combinations(choices, size):
            if sum(COSTS[n["grade"]] for n in subset) != budget:
                continue
            positions = {(n["col"], n["row"]) for n in subset}
            start = (root["col"], root["row"])
            reached, queue = {start}, [start]
            for c, r in queue:
                for other in ((c - 1, r), (c + 1, r), (c, r - 1), (c, r + 1)):
                    if other in positions and other not in reached:
                        reached.add(other)
                        queue.append(other)
            if reached == positions | {start}:
                score = sum(powers.get(n["nodeId"], 0) for n in subset)
                best = score if best is None else max(best, score)
    return best


class OptimizerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cache = Path(self.temporary.name) / "solution.json"
        self.nodes = [node(1, 8, 8, root=True), node(2, 8, 7, opened=1),
                      node(3, 8, 6, opened=1), node(4, 7, 8, "Rare", 1),
                      node(5, 6, 8), node(6, 7, 7), node(7, 7, 6, "Unique"),
                      node(8, 1, 1)]
        self.powers = {2: 1, 3: 100, 4: 40, 5: 100, 6: 10, 7: 500, 8: 9999}

    def solve(self, recompute=False):
        records = [{"key": option_key(n), "power": self.powers[n["nodeId"]]}
                   for n in self.nodes if n["type"] != "Start"]
        return build_power_plan({"nodeList": self.nodes}, records,
                                recompute=recompute, cache_path=self.cache)

    def test_exact_result_matches_independent_enumeration_and_excludes_unreachable_node(self):
        plan = self.solve()
        self.assertEqual(plan["cost"], 4)
        self.assertEqual(plan["power"], brute_force(self.nodes, self.powers, 4))
        self.assertEqual(plan["power"], 150)
        self.assertNotIn(1, plan["nodeIds"])
        self.assertNotIn(8, plan["nodeIds"])
        self.assertEqual(plan["power"], plan["powerUpperBound"])
        self.assertEqual(plan["optimality"]["gap"], 0)

    def test_valid_cache_needs_no_solver_and_measurement_changes_invalidate_it(self):
        original = self.solve()
        with patch("optimize_board.optimize_connected", side_effect=AssertionError("재계산하면 안 됩니다.")):
            self.assertEqual(self.solve(), original)
        self.powers[2] = 1000
        updated = self.solve()
        self.assertNotEqual(updated["optimality"]["modelHash"], original["optimality"]["modelHash"])
        self.assertEqual(updated["power"], brute_force(self.nodes, self.powers, 4))

    def test_disconnected_cache_is_rejected_and_resolved(self):
        plan = self.solve()
        cached = json.loads(self.cache.read_text())
        cached["nodeIds"] = [8]
        self.cache.write_text(json.dumps(cached))
        self.assertEqual(self.solve()["power"], plan["power"])

    def test_solver_and_cache_accept_the_same_tiny_numerical_gap(self):
        plan = self.solve()
        cached = json.loads(self.cache.read_text())
        cached["gap"] = 5e-12
        cached["upperBound"] = cached["power"] + 5e-8
        self.cache.write_text(json.dumps(cached))
        with patch("optimize_board.optimize_connected", side_effect=AssertionError("허용 오차 안의 결과를 다시 계산하면 안 됩니다.")):
            self.assertEqual(self.solve()["power"], plan["power"])

    def test_impossible_exact_budget_is_not_published(self):
        self.nodes = [node(1, 8, 8, root=True), node(2, 8, 7, "Rare"), node(8, 1, 1, opened=1)]
        with self.assertRaises(RuntimeError):
            self.solve()
        self.assertFalse(self.cache.exists())

    def test_forced_root_never_uses_currency_even_if_source_grade_has_a_cost(self):
        self.nodes[0]["grade"] = "Unique"
        self.assertEqual(self.solve()["power"], 150)

    def test_zero_time_budget_keeps_a_valid_start_and_an_honest_upper_bound(self):
        by_id = {n["nodeId"]: n for n in self.nodes}
        positions = {(n["col"], n["row"]): n["nodeId"] for n in self.nodes}
        adjacent = {i: [positions[p] for p in ((n["col"] - 1, n["row"]), (n["col"] + 1, n["row"]),
                                              (n["col"], n["row"] - 1), (n["col"], n["row"] + 1)) if p in positions]
                    for i, n in by_id.items()}
        powers = {**self.powers, 1: 0}
        result = optimize_connected(by_id, adjacent, 1, powers, 4, initial_nodes={2, 3, 4}, seconds=0, allow_feasible=True)
        self.assertGreaterEqual(result["power"], 141)
        self.assertGreaterEqual(result["upperBound"], 150)
        self.assertEqual(sum(COSTS[by_id[i]["grade"]] for i in result["nodeIds"]), 4)
        self.assertNotIn(8, result["nodeIds"])
        if result["status"] == "optimal":
            self.assertEqual(result["power"], 150)

    def test_shared_pool_reallocates_budget_to_the_board_with_better_connected_gains(self):
        a = [node(101, 8, 8, root=True), node(102, 8, 7, opened=1), node(103, 8, 6)]
        b = [node(201, 8, 8, root=True), node(202, 8, 7, opened=1), node(203, 8, 6)]
        for n in b:
            n["boardId"] = 72
        powers = {102: 1, 103: 100, 202: 2, 203: 1}
        observations = [{"key": option_key(n), "power": powers[n["nodeId"]]}
                        for n in a + b if n["type"] != "Start"]
        plan = build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations, cache_path=self.cache)
        self.assertEqual(plan["cost"], 2)
        self.assertEqual(plan["power"], 101)
        self.assertEqual(plan["power"], plan["powerUpperBound"])
        self.assertEqual(plan["boards"][71]["cost"], 2)
        self.assertEqual(plan["boards"][72]["cost"], 0)
        self.assertEqual(plan["boards"][71]["nodeIds"], [102, 103])
        self.assertEqual(plan["boards"][72]["nodeIds"], [])
        # Each separate source allocation is one point: total 1 + 2 = 3.
        self.assertGreater(plan["power"], 3)
        with patch("optimize_board.optimize_connected", side_effect=AssertionError("유효한 전체 결과는 재사용해야 합니다.")):
            restored = build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations, cache_path=self.cache)
            self.assertEqual(restored, plan)

    def test_global_missing_measurement_is_rejected(self):
        data = {"nodeList": [node(1, 8, 8, root=True), node(2, 8, 7, opened=1)]}
        with self.assertRaises(ValueError):
            build_all_power_plan([data], [], cache_path=self.cache)

    def test_global_solver_rejects_the_relaxed_winner_when_it_is_disconnected(self):
        a = [node(101, 8, 8, root=True), node(102, 8, 7, opened=1), node(103, 1, 1)]
        b = [node(201, 8, 8, root=True), node(202, 8, 7, opened=1)]
        for n in b:
            n["boardId"] = 72
        power = {102: 1, 103: 1000, 202: 2}
        observations = [{"key": option_key(n), "power": power[n["nodeId"]]}
                        for n in a + b if n["type"] != "Start"]
        plan = build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations, cache_path=self.cache)
        self.assertEqual(plan["power"], 3)
        self.assertEqual(plan["cost"], 2)
        self.assertNotIn(103, plan["boards"][71]["nodeIds"])

    def level_boards(self):
        a = [node(101, 8, 8, root=True), skill(102, 8, 7, opened=1), skill(103, 8, 6), node(104, 9, 8, opened=1)]
        b = [node(201, 8, 8, root=True), skill(202, 8, 7, 72, 1), skill(203, 8, 6, 72), node(204, 9, 8), node(205, 10, 8)]
        for n in b:
            n["boardId"] = 72
        powers = {104: 450, 204: 450, 205: 450}
        observations = [{"key": option_key(n), "power": powers[n["nodeId"]]} for n in a + b if n["type"] == "Stat"]
        return a, b, powers, observations, option_key(a[1])

    def test_level_sequences_match_enumeration_where_an_additive_value_would_not(self):
        a, b, powers, observations, key = self.level_boards()
        sequence = [100, 900, 200, 1000]
        plan = build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations, cache_path=self.cache, skills={key: sequence})
        # 스킬 노드 2개(100 + 900)와 스탯 1개(450)가 최고입니다. 스킬 노드를 평균 550으로 치면
        # 3개를 고르게 되지만 그 구성의 실제 값은 1,200입니다.
        self.assertEqual(plan["cost"], 3)
        self.assertEqual(plan["power"], brute_force_levels([a, b], powers, sequence, 3))
        self.assertEqual(plan["power"], 1450)
        self.assertEqual(plan["powerUpperBound"], 1450)
        self.assertEqual(plan["optimality"]["status"], "optimal")
        selected = plan["boards"][71]["nodeIds"] + plan["boards"][72]["nodeIds"]
        self.assertEqual(sum(i in {102, 103, 202, 203} for i in selected), 2)
        self.assertEqual(plan["power"], plan["boards"][71]["power"] + plan["boards"][72]["power"])
        with patch("optimize_board.optimize_connected", side_effect=AssertionError("유효한 전체 결과는 재사용해야 합니다.")):
            self.assertEqual(build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations,
                                                  cache_path=self.cache, skills={key: sequence}), plan)
        # 값이 달라지면 해시가 바뀌어 저장본을 다시 계산합니다.
        changed = build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations, cache_path=self.cache,
                                       skills={key: [100, 900, 900, 1000]})
        self.assertNotEqual(changed["optimality"]["modelHash"], plan["optimality"]["modelHash"])
        self.assertEqual(changed["power"], brute_force_levels([a, b], powers, [100, 900, 900, 1000], 3))
        self.assertEqual(changed["power"], 1900)
        # 전수 조사와 맞는지 여러 값으로 확인합니다. 감소하거나 0이 섞인 값도 포함합니다.
        for sequence in ([1000, 0, 0, 0], [0, 0, 0, 5000], [300, 300, 300, 300], [0, 950, 0, 0], [100.5, 900.25, 200, 1000]):
            plan = build_all_power_plan([{"nodeList": a}, {"nodeList": b}], observations, cache_path=self.cache, skills={key: sequence})
            self.assertAlmostEqual(plan["power"], brute_force_levels([a, b], powers, sequence, 3), places=9)
            self.assertEqual(plan["optimality"]["status"], "optimal")

    def test_level_values_are_credited_in_board_then_node_order_and_board_sums_equal_the_total(self):
        # 보드 71은 30번 노드를 20번보다 먼저 싣고, 가장 작은 번호는 보드 72에 있습니다.
        a = [node(1, 8, 8, root=True), skill(30, 8, 7, opened=1), skill(20, 9, 8), node(4, 7, 8, opened=1)]
        b = [node(11, 8, 8, root=True), skill(5, 8, 7, 72, 1), skill(6, 8, 6, 72), node(14, 9, 8, opened=1), node(15, 10, 8)]
        for n in b:
            n["boardId"] = 72
        average = 42215 / 101
        observations = [{"key": option_key(n), "power": average, "basis": "aggregate"} for n in a + b if n["type"] == "Stat"]
        skills = {option_key(a[1]): [100, 900, 200, 1000]}
        boards = [{"nodeList": a}, {"nodeList": b}]
        model = shared_model(boards, observations, skills)
        total, by_board, worth = score_selection(model, {30, 20, 5, 14})
        self.assertEqual(worth, {20: 100, 30: 900, 5: 200, 14: average})
        self.assertEqual(by_board, {71: 1000, 72: 200 + average})
        self.assertEqual(total, by_board[71] + by_board[72])
        upper = total + 50
        self.cache.write_text(json.dumps({"nodeIds": [5, 14, 20, 30], "power": total, "upperBound": upper,
                                          "gap": (upper - total) / total, "status": "feasible", "solver": "시험",
                                          "modelHash": model.hash}))
        with patch("optimize_board.optimize_connected", side_effect=AssertionError("유효한 저장본은 다시 계산하면 안 됩니다.")):
            plan = build_all_power_plan(boards, observations, cache_path=self.cache, skills=skills)
        self.assertEqual(plan["boards"][71]["power"], 100 + 900)
        self.assertEqual(plan["boards"][72]["power"], 200 + average)
        self.assertEqual(plan["power"], plan["boards"][71]["power"] + plan["boards"][72]["power"])
        # 원본(30, 4 | 5, 14)은 따로 배정합니다. 30번이 첫째, 5번이 둘째로 열린 노드입니다.
        self.assertEqual(plan["boards"][71]["sourcePower"], 100 + average)
        self.assertEqual(plan["boards"][72]["sourcePower"], 900 + average)
        self.assertEqual(plan["sourcePower"], plan["boards"][71]["sourcePower"] + plan["boards"][72]["sourcePower"])
        self.assertEqual(plan["powerDifference"], plan["power"] - plan["sourcePower"])
        levels = {board: [(g["count"], g["cost"], g["power"]) for g in plan["boards"][board]["groups"] if g["basis"] == "level"] for board in (71, 72)}
        self.assertEqual(levels, {71: [(2, 2, 500)], 72: [(1, 1, 200)]})
        self.assertEqual([(g["count"], g["power"]) for g in plan["boards"][72]["groups"] if g["basis"] == "aggregate"], [(1, average)])
        self.assertEqual(plan["boards"][71]["skillsUnchanged"], False)
        self.assertEqual(plan["optimality"]["gap"], (plan["powerUpperBound"] - plan["power"]) / plan["power"])

    def test_sequences_enter_the_model_hash_only_when_a_board_uses_them(self):
        a, b, powers, observations, key = self.level_boards()
        boards = [{"nodeList": a}, {"nodeList": b}]
        fixed = observations + [{"key": key, "power": 550}]
        plain = shared_model(boards, fixed)
        # 레벨별 값이 없는 모형의 해시는 이 기능을 넣기 전의 계산식 그대로입니다.
        earlier = {"version": 1, "roots": [101, 201], "budget": 3,
                   "nodes": [[n["nodeId"], n["boardId"], n["col"], n["row"], COSTS[n["grade"]],
                              0 if n["type"] == "Start" else 550 if n["type"] == "SkillLevel" else 450]
                             for n in sorted(a + b, key=lambda n: n["nodeId"])]}
        self.assertEqual(plain.hash, hashlib.sha256(json.dumps(earlier, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        self.assertEqual(shared_model(boards, fixed, {}).hash, plain.hash)
        self.assertEqual(shared_model(boards, fixed, {"다른 옵션": [1, 2, 3, 4]}).hash, plain.hash)
        levelled = shared_model(boards, fixed, {key: [100, 900, 200, 1000]})
        self.assertNotEqual(levelled.hash, plain.hash)
        self.assertEqual(shared_model(boards, observations, {key: [100, 900, 200, 1000, 7]}).hash, levelled.hash)
        self.assertNotEqual(shared_model(boards, fixed, {key: [100, 900, 200, 1001]}).hash, levelled.hash)
        # 레벨별 값이 있으면 그 스킬에는 옵션 기록값이 필요하지 않고, 없으면 필요합니다.
        with self.assertRaises(ValueError):
            shared_model(boards, observations)
        for bad in ([100, 900, 200], [100, 900, 200, -1], [100, 900, 200, "1000"], [100, 900, 200, float("nan")], "x", 550):
            with self.assertRaises(ValueError):
                shared_model(boards, observations, {key: bad})

    def test_bundled_plan_is_valid_for_the_current_inputs_without_a_solver(self):
        import build_boards
        loaded, _, measurements, skill_values = build_boards.load()
        boards = [data for _, _, _, data in loaded]
        skills = {item["key"]: item["values"] for item in skill_values}
        self.assertEqual(len(skills), 22)
        with patch("optimize_board.optimize_connected", side_effect=AssertionError("저장된 구성이 현재 입력과 맞지 않습니다.")):
            plan = build_all_power_plan(boards, measurements, skills=skills)
        stored = json.loads((Path(build_boards.ROOT) / "boards" / "all-power-plan.json").read_text(encoding="utf-8"))
        self.assertEqual(plan["cost"], 837)
        for field in ("power", "sourcePower", "powerDifference", "powerUpperBound", "nodeCount", "optimality"):
            self.assertEqual(plan[field], stored[field])
        self.assertEqual(plan["power"], sum(plan["boards"][board]["power"] for board in (71, 72, 73, 74, 79)))
        self.assertEqual(plan["sourcePower"], sum(plan["boards"][board]["sourcePower"] for board in (71, 72, 73, 74, 79)))
        for board_id, board in plan["boards"].items():
            for field in ("power", "sourcePower", "nodeIds", "groups", "statComparison"):
                self.assertEqual(board[field], stored["boards"][str(board_id)][field])
        # 스킬은 열린 노드 수로 값이 정해지므로 원본의 스킬 88개는 스킬별 값의 합과 같습니다.
        model = shared_model(boards, measurements, skills)
        opened = {i for i, n in model.nodes.items() if i not in model.roots and n["open"] == 1}
        worth = score_selection(model, opened)[2]
        self.assertEqual(sum(worth[i] for i in opened if model.nodes[i]["type"] == "SkillLevel"),
                         sum(sum(values) for values in skills.values()))

    def test_skill_tables_for_link_imports_follow_their_sources(self):
        import build_boards
        _, options, _, skill_values = build_boards.load()
        tables = build_boards.load_skill_tables(options)
        boards = Path(build_boards.ROOT) / "boards"
        recorded = json.loads((boards / "skill-values.json").read_text(encoding="utf-8"))
        self.assertEqual(tables["levels"], {grade: recorded["levels"][grade] for grade in ("Legend", "Rare")})
        # 생성된 브라우저 데이터는 같은 표입니다.
        generated = (boards / "skill-tables.js").read_text(encoding="utf-8")
        self.assertEqual(json.loads(generated.split("window.DAEVANION_SKILL_TABLES = ", 1)[1].strip().removesuffix(";")), tables)
        # 번호표의 스킬은 모두 보드의 스킬 옵션이고, 한 번호는 한 스킬에만 있습니다.
        ids = json.loads((boards / "skill-ids.json").read_text(encoding="utf-8"))["skills"]
        self.assertEqual([(item["key"], item["skillIds"]) for item in tables["ids"]],
                         [(build_boards.skill_key(skill), sorted(skill["skillIds"])) for skill in ids])
        self.assertTrue(all(item["key"] in options for item in tables["ids"]))
        numbers = [number for item in tables["ids"] for number in item["skillIds"]]
        self.assertEqual(len(numbers), len(set(numbers)))
        self.assertEqual({item["key"] for item in tables["ids"]}, {item["key"] for item in skill_values})
        # 레벨표는 구간의 양 끝을 포함하고, 표 밖의 레벨에는 값이 없습니다.
        power = lambda grade, level: build_boards.level_power(tables["levels"], grade, level)
        self.assertEqual([power("Legend", level) for level in (0, 1, 11, 12, 13, 16, 19, 20, 21, 60, 61)],
                         [None, 100, 100, 500, 100, 900, 200, 1000, 200, 200, None])
        self.assertEqual([power("Rare", level) for level in (0, 14, 15, 26, 27, 31, 32, 60, 61)],
                         [None, 100, 200, 200, 300, 300, 300, 300, None])
        # 기본 캐릭터의 기록은 그 표에서 나오는 값과 같으므로, 같은 상태를 링크로 가져와도 모형이 같습니다.
        for skill in skill_values:
            self.assertEqual(skill["values"], [power(skill["grade"], skill["baseLevel"] + step) for step in range(1, len(skill["values"]) + 1)])
        # 빈틈이나 겹침이 있는 표, 1레벨에서 시작하지 않는 표, 값이 잘못된 표는 받지 않습니다.
        rare = recorded["levels"]["Rare"]
        for legend in ([[2, 11, 100, True]], [[1, 11, 100, True], [13, 20, 100, True]], [[1, 11, 100, True], [11, 20, 100, True]],
                       [[1, 11, -1, True]], [[1, 11, "100", True]], [[1, 11, 100, 1]], [[1, 11, 100]], [[5, 4, 100, True]], [], None):
            with self.assertRaises((AssertionError, TypeError)):
                build_boards.skill_levels({"Legend": legend, "Rare": rare})
        with self.assertRaises(KeyError):
            build_boards.skill_levels({"Rare": rare})


if __name__ == "__main__":
    unittest.main()
