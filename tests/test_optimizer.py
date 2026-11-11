"""작은 그래프를 전수 조사하여 연결·예산 제약 최적화와 비교합니다."""

from itertools import combinations
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from optimize_board import COSTS, build_power_plan, build_all_power_plan, optimize_connected, option_key


def node(i, col, row, grade="Common", opened=0, root=False):
    return {"nodeId": i, "boardId": 71, "col": col, "row": row,
            "grade": "None" if root else grade, "open": opened,
            "type": "Start" if root else "Stat", "name": f"노드 {i}",
            "effectList": [] if root else [{"desc": f"효과 {i}"}]}


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


if __name__ == "__main__":
    unittest.main()
