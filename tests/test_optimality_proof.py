import itertools
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from optimize_board import score_selection
from prove_optimality import load_model, load_shared, minimal_separator, reach, solve, valid_selection


class OptimalityProofTests(unittest.TestCase):
    def test_original_witness_is_independently_connected_and_exhausts_global_budget(self):
        nodes, adjacent, roots, power, costs, budget, digest = load_model()
        source = json.loads((Path(__file__).resolve().parents[1] / "boards/all-optimization.json").read_text())
        self.assertEqual(digest, source["modelHash"])
        self.assertEqual(budget, 837)
        self.assertTrue(valid_selection(source["nodeIds"], nodes, adjacent, roots, costs, budget))
        self.assertEqual(score_selection(load_shared(), set(source["nodeIds"]))[0], source["power"])
        self.assertFalse(valid_selection(source["nodeIds"] + [roots[0]], nodes, adjacent, roots, costs, budget))
        self.assertFalse(valid_selection(source["nodeIds"] * 2, nodes, adjacent, roots, costs, budget))

    def test_proof_refuses_a_model_whose_values_are_not_one_integer_per_node(self):
        # 현재 입력에는 스킬 레벨별 값과 소수 평균값이 있어 노드별 정수 합산을 전제로 한 증명을 쓸 수 없습니다.
        power = load_model()[3]
        self.assertTrue(any(type(value) is not int for value in power.values()))
        with self.assertRaisesRegex(RuntimeError, "정수"):
            solve(seconds=0)

    def test_generated_minimal_cuts_never_remove_any_connected_subset(self):
        rng = random.Random(71)
        checked = 0
        for size in range(3, 9):
            for _ in range(12):
                adjacent = {i: set() for i in range(size)}
                for i in range(1, size):
                    j = rng.randrange(i)
                    adjacent[i].add(j)
                    adjacent[j].add(i)
                for a, b in itertools.combinations(range(size), 2):
                    if rng.random() < .2:
                        adjacent[a].add(b)
                        adjacent[b].add(a)
                subsets = [{0} | {i for i in range(size) if mask >> i & 1}
                           for mask in range(1 << size)]
                connected = [s for s in subsets if reach(adjacent, [0], allowed=s) == s]
                for selected in subsets:
                    unseen = selected - reach(adjacent, [0], allowed=selected)
                    while unseen:
                        comp = reach(adjacent, [next(iter(unseen))], allowed=unseen)
                        boundary = set().union(*(adjacent[i] for i in comp)) - comp
                        for target in comp:
                            separator = set(minimal_separator(target, boundary, adjacent, [0]))
                            self.assertTrue(separator <= boundary)
                            self.assertNotIn(target, reach(adjacent, [0], forbidden=separator))
                            self.assertFalse(separator & selected)
                            for other in connected:
                                self.assertTrue(target not in other or separator & other)
                                checked += 1
                        unseen -= comp
        self.assertGreater(checked, 100000)


if __name__ == "__main__":
    unittest.main()
