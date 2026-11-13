const test = require('node:test');
const assert = require('node:assert/strict');
const optimizer = require('../assets/optimizer.js');
const { Planner, COSTS } = require('../assets/planner.js');
const loadHighs = require('../assets/vendor/highs/highs.js');
const runtime = loadHighs();
const root = { nodeId: 1, row: 8, col: 8, type: 'Start', grade: 'None', open: 1, name: '루트', effectList: [] };
function stat(id, row, col, grade = 'Common', open = 0) {
  return { nodeId: id, row, col, grade, open, type: 'Stat', name: `스탯 ${id}`, effectList: [{ desc: `추가 공격력 +${id}` }] };
}
// Every node of one skill shares its option key, whichever board it is on.
function skill(id, row, col, name = '시험', grade = 'Common', open = 0) {
  return { nodeId: id, row, col, grade, open, type: 'SkillLevel', name: `스킬 레벨 상승 - ${name}`, effectList: [{ desc: `${name} +1` }] };
}
const skillKey = (name = '시험', grade = 'Common') => optimizer.key(skill(0, 0, 0, name, grade));
// Two boards, each with two nodes of the same skill above the root and stats to its right.
function fixture() {
  const boards = [
    { id: 71, name: '첫 보드', file: 'a.html', nodes: [root, skill(2, 7, 8, '시험', 'Common', 1), skill(3, 6, 8), stat(4, 8, 9, 'Common', 1)] },
    { id: 72, name: '둘째 보드', file: 'b.html', nodes: [{ ...root, nodeId: 11 }, skill(12, 7, 8, '시험', 'Common', 1), skill(13, 6, 8), stat(14, 8, 9), stat(15, 8, 10)] },
  ];
  const values = Object.fromEntries(boards.flatMap(board => board.nodes.filter(n => n.type === 'Stat').map(n => [optimizer.key(n), 450])));
  return { boards, values, skills: { [skillKey()]: [100, 900, 200, 1000] } };
}
// Independent of optimizer.score(): per-node values plus, for each levelled
// skill, the first c values of its sequence for its c selected nodes.
function expectedPower(boards, values, skills, selections) {
  const counts = new Map();
  let power = 0;
  for (const board of boards) for (const node of board.nodes) {
    if (node.type === 'Start' || !selections[board.id].includes(node.nodeId)) continue;
    const key = optimizer.key(node);
    if (node.type === 'SkillLevel' && skills[key]) counts.set(key, (counts.get(key) || 0) + 1);
    else power += node.type === 'SkillLevel' ? { Rare: 200, Legend: 100 }[node.grade] ?? values[key] : values[key];
  }
  for (const [key, count] of counts) for (let step = 0; step < count; step++) power += skills[key][step];
  return power;
}
function exhaustive(problem, boards, values, skills) {
  const candidates = problem.nodes.filter(n => !n.root);
  let best = null;
  for (let mask = 0; mask < 2 ** candidates.length; mask++) {
    const selections = Object.fromEntries(problem.graphs.map(g => [g.id, []]));
    candidates.forEach((n, i) => { if (mask & (1 << i)) selections[n.boardId].push(n.nodeId); });
    const checked = optimizer.validate(problem, selections);
    if (!checked) continue;
    const power = expectedPower(boards, values, skills, selections);
    assert.ok(Math.abs(checked.power - power) < 1e-6, `${JSON.stringify(selections)}: ${checked.power} != ${power}`);
    if (best === null || power > best) best = power;
  }
  return best;
}

test('a levelled skill is worth its first c values for c selected nodes, whichever they are', () => {
  const { boards, values, skills } = fixture();
  const problem = optimizer.createProblem(boards, values, { skills });
  assert.equal(problem.budget, 3);
  assert.equal(problem.skills.length, 1);
  assert.deepEqual(problem.skills[0].values, [100, 900, 200, 1000]);
  assert.equal(problem.allPower, 2200 + 3 * 450);
  assert.equal(problem.integral, true);
  const power = selections => optimizer.validate(problem, selections).power;
  // One, two and three nodes of the skill, taken from either board.
  assert.equal(power({ 71: [2, 4], 72: [14] }), 100 + 900);
  assert.equal(power({ 71: [4], 72: [12, 14] }), 100 + 900);
  assert.equal(power({ 71: [2], 72: [12, 14] }), 1000 + 450);
  assert.equal(power({ 71: [2, 3], 72: [14] }), 1000 + 450);
  assert.equal(power({ 71: [2, 3], 72: [12] }), 1200);
  assert.equal(power({ 71: [2], 72: [12, 13] }), 1200);
  assert.equal(power({ 71: [], 72: [12, 14, 15] }), 100 + 900);
  // The same selection scores the same whatever order its ids are listed in.
  assert.equal(power({ 71: [3, 2], 72: [12] }), power({ 71: [2, 3], 72: [12] }));
  // Without a sequence the grade rule still applies: a Rare skill node is 200, a Legend one 100.
  const rare = [{ id: 71, name: '보드', nodes: [root, skill(2, 7, 8, '패시브', 'Rare', 1), skill(3, 6, 8, '액티브', 'Legend', 1)] }];
  const fixed = optimizer.createProblem(rare, {});
  assert.equal(fixed.skills.length, 0);
  assert.equal(fixed.byId.get(2).power, 200);
  assert.equal(fixed.byId.get(3).power, 100);
  assert.equal(optimizer.validate(fixed, { 71: [2, 3] }).power, 300);
  const mixed = optimizer.createProblem(rare, {}, { skills: { [skillKey('패시브', 'Rare')]: [700] } });
  assert.equal(optimizer.validate(mixed, { 71: [2, 3] }).power, 800);
});

test('sequences enter the signature only when a board uses them and invalid ones are rejected', () => {
  const { boards, values: stats, skills } = fixture();
  // A skill node of Common grade has no fixed rule, so without a sequence it needs an entered value.
  const values = { ...stats, [skillKey()]: 550 };
  const plain = optimizer.createProblem(boards, values);
  assert.throws(() => optimizer.createProblem(boards, stats), /전투력값을 입력/);
  // Results saved before sequences existed keep matching a model without them.
  assert.equal(JSON.parse(plain.signature).length, 3);
  for (const none of [null, undefined, {}, { [skillKey('다른 스킬')]: [1, 2, 3, 4] }]) {
    assert.equal(optimizer.createProblem(boards, values, { skills: none }).signature, plain.signature);
  }
  const levelled = optimizer.createProblem(boards, values, { skills });
  assert.notEqual(levelled.signature, plain.signature);
  assert.deepEqual(JSON.parse(levelled.signature).at(-1), { skills: [[skillKey(), [100, 900, 200, 1000]]] });
  assert.equal(optimizer.createProblem(boards, values, { skills: { [skillKey()]: [100, 900, 200, 1000] } }).signature, levelled.signature);
  assert.notEqual(optimizer.createProblem(boards, values, { skills: { [skillKey()]: [100, 900, 200, 1001] } }).signature, levelled.signature);
  // Values beyond the number of nodes can never be reached and do not change the model.
  assert.equal(optimizer.createProblem(boards, values, { skills: { [skillKey()]: [100, 900, 200, 1000, 5] } }).signature, levelled.signature);
  // Required nodes stay a list and sequences an object, so the two never look alike.
  const both = JSON.parse(optimizer.createProblem(boards, values, { skills, required: { 71: [3] } }).signature);
  assert.deepEqual(both.slice(3), [[3], { skills: [[skillKey(), [100, 900, 200, 1000]]] }]);
  for (const bad of [[100, 900, 200], [100, 900, 200, -1], [100, 900, 200, NaN], [100, 900, 200, '1000'], 'x', null, 550]) {
    assert.throws(() => optimizer.createProblem(boards, values, { skills: { [skillKey()]: bad } }), /레벨별 전투력값/);
  }
  for (const bad of [[], 'x', 5]) assert.throws(() => optimizer.createProblem(boards, values, { skills: bad }), /레벨별 전투력값/);
});

test('the solver finds the brute-force optimum where an additive shortcut would not', async () => {
  const { boards, values, skills } = fixture();
  const problem = optimizer.createProblem(boards, values, { skills });
  const expected = exhaustive(problem, boards, values, skills);
  // Two skill nodes (100 + 900) and one stat (450). Valuing each skill node at
  // the sequence average of 550 would take three of them, which is worth 1,200.
  assert.equal(expected, 1450);
  const solved = optimizer.solve(problem, await runtime, { seconds: 2 });
  assert.equal(solved.power, expected);
  assert.equal(solved.status, 'optimal');
  assert.equal(solved.upperBound, expected);
  assert.equal(Object.values(solved.selections).flat().filter(id => [2, 3, 12, 13].includes(id)).length, 2);
  const planner = new Planner(boards);
  assert.equal(planner.replaceAllBoards(solved.selections).ok, true);
  assert.equal(planner.remaining(), 0);
  // The exact search alone reaches it too, from the worst start and without the local search.
  const highs = await runtime;
  const { data, edges } = optimizer.buildModel(problem, highs);
  const model = highs.createModel(data);
  try {
    model.options.set({ output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0 });
    model.setSolution({ colValue: optimizer.startVector(problem, edges, optimizer.validate(problem, { 71: [2, 3], 72: [12] })) });
    model.run();
    const exact = optimizer.validate(problem, optimizer.selectionsFromVector(problem, model.getSolution().colValue));
    assert.equal(exact.power, expected);
    assert.ok(Math.abs(model.info.get('objective_function_value') - expected) < 1e-6);
  } finally { model.dispose(); }
  // A proof is reused for the identical model only, and is checked with the exact score.
  assert.equal(optimizer.solve(problem, null, { certificate: solved }).power, expected);
  const changed = optimizer.createProblem(boards, values, { skills: { [skillKey()]: [100, 900, 900, 1000] } });
  const again = optimizer.solve(changed, await runtime, { certificate: solved, candidates: [solved.selections], seconds: 2 });
  assert.equal(again.power, 1900);
  assert.throws(() => optimizer.solve(problem, null, { certificate: { ...solved, power: 1650, upperBound: 1650 } }), /검증/);
});

test('random small boards with level sequences and required nodes match exhaustive enumeration', async () => {
  let seed = 20261114;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const grades = ['Common', 'Common', 'Common', 'Rare', 'Legend', 'Unique'];
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const names = ['가', '나'];
  const highs = await runtime;
  let solved = 0, impossible = 0, levelled = 0;
  for (let trial = 0; trial < 120; trial++) {
    let id = 1;
    const boards = [];
    for (let b = 0; b < 1 + Math.floor(random() * 2); b++) {
      const nodes = [{ ...root, nodeId: id++ }], cells = [[8, 8]], used = new Set(['8,8']);
      const size = 4 + Math.floor(random() * 5);
      while (nodes.length <= size) {
        const [r, c] = cells[Math.floor(random() * cells.length)], [dr, dc] = steps[Math.floor(random() * 4)];
        if (used.has(`${r + dr},${c + dc}`)) continue;
        used.add(`${r + dr},${c + dc}`); cells.push([r + dr, c + dc]);
        // About four nodes in ten belong to one of two skills, each skill keeping a single grade.
        const which = Math.floor(random() * 5);
        nodes.push(which < 2 ? skill(id++, r + dr, c + dc, names[which], which ? 'Legend' : 'Rare')
          : stat(id++, r + dr, c + dc, grades[Math.floor(random() * grades.length)]));
      }
      const at = new Map(nodes.map(n => [`${n.row},${n.col}`, n]));
      for (let pass = 0; pass < 3; pass++) for (const n of nodes) {
        if (n.type === 'Start' || n.open === 1 || random() > .4) continue;
        if (steps.some(([dr, dc]) => { const next = at.get(`${n.row + dr},${n.col + dc}`); return next && (next.type === 'Start' || next.open === 1); })) n.open = 1;
      }
      boards.push({ id: 71 + b, name: `보드 ${b}`, file: 'test.html', nodes });
    }
    const all = boards.flatMap(board => board.nodes.filter(n => n.type !== 'Start').map(n => ({ boardId: board.id, n })));
    if (!all.some(({ n }) => n.open === 1)) continue;
    const values = Object.fromEntries(all.filter(({ n }) => n.type === 'Stat')
      .map(({ n }) => [optimizer.key(n), random() < .2 ? 0 : Math.floor(random() * 500) + (random() < .2 ? .5 : 0)]));
    // One skill always has a sequence; the other sometimes keeps the fixed grade rule.
    const skills = {};
    for (const [which, name] of names.entries()) {
      const count = all.filter(({ n }) => n.type === 'SkillLevel' && n.name.endsWith(name)).length;
      if (!count || (which && random() < .4)) continue;
      skills[skillKey(name, which ? 'Legend' : 'Rare')] = Array.from({ length: count },
        () => [0, 100, 100, 200, 900, 1000, 350.5][Math.floor(random() * 7)]);
    }
    if (Object.keys(skills).length) levelled++;
    const required = {};
    for (const { boardId, n } of all) if (random() < .15) (required[boardId] ||= []).push(n.nodeId);
    const problem = optimizer.createProblem(boards, values, { required, skills });
    const expected = exhaustive(problem, boards, values, skills);
    if (expected === null) {
      impossible++;
      assert.throws(() => optimizer.solve(problem, highs, { seconds: 5 }), /필수|구성/);
      continue;
    }
    const result = optimizer.solve(problem, highs, { seconds: 5 });
    solved++;
    assert.equal(result.status, 'optimal', `trial ${trial}`);
    assert.ok(Math.abs(result.power - expected) < 1e-6, `trial ${trial}: ${result.power} != ${expected}`);
    assert.ok(Math.abs(result.upperBound - expected) < 1e-6, `trial ${trial}: bound ${result.upperBound}`);
    const checked = optimizer.validate(problem, result.selections);
    assert.ok(checked && checked.power === result.power && checked.cost === problem.budget);
    const summary = optimizer.summarize(problem, result);
    assert.equal(summary.power, problem.graphs.reduce((sum, graph) => sum + summary.boards[graph.id].power, 0));
    assert.equal(summary.sourcePower, problem.graphs.reduce((sum, graph) => sum + summary.boards[graph.id].sourcePower, 0));
    // Heuristic starts are valid plans that never beat the optimum.
    const start = optimizer.validate(problem, optimizer.repair(problem, {}));
    if (start) assert.ok(optimizer.improve(problem, start).power <= expected + 1e-6);
  }
  assert.ok(solved >= 40 && levelled >= 60, `${solved} solved, ${impossible} impossible, ${levelled} with sequences`);
});

test('summaries credit a sequence in board then nodeId order and their board sums equal the total', () => {
  // Board 71 lists node 30 before node 20; board 72 holds the lowest id of all.
  const boards = [
    { id: 71, name: '첫 보드', nodes: [root, skill(30, 7, 8, '시험', 'Common', 1), skill(20, 8, 9), stat(4, 8, 7, 'Common', 1)] },
    { id: 72, name: '둘째 보드', nodes: [{ ...root, nodeId: 11 }, skill(5, 7, 8, '시험', 'Common', 1), skill(6, 6, 8), stat(14, 8, 9, 'Common', 1), stat(15, 8, 10)] },
  ];
  // 42215 / 101 is one of the recorded averages: it has no exact binary form.
  const average = 42215 / 101;
  const values = Object.fromEntries(boards.flatMap(board => board.nodes.filter(n => n.type === 'Stat').map(n => [optimizer.key(n), average])));
  const skills = { [skillKey()]: [100, 900, 200, 1000] };
  const observations = Object.keys(values).map(key => ({ key, power: average, basis: 'aggregate' }));
  const problem = optimizer.createProblem(boards, values, { skills });
  assert.equal(problem.budget, 4);
  assert.equal(problem.integral, false);
  const selections = { 71: [30, 20], 72: [5, 14] };
  const checked = optimizer.validate(problem, selections);
  const summary = optimizer.summarize(problem, { selections, signature: problem.signature, power: checked.power,
    upperBound: problem.allPower, status: 'feasible', solver: '시험' }, observations);
  // Target: board 71 first, node 20 before node 30, then node 5 on board 72.
  assert.equal(summary.boards[71].power, 100 + 900);
  assert.equal(summary.boards[72].power, 200 + average);
  assert.equal(summary.power, summary.boards[71].power + summary.boards[72].power);
  assert.equal(summary.power, checked.power);
  // Source (30, 4 | 5, 14): node 30 is the first open node of the skill, node 5 the second.
  assert.equal(summary.boards[71].sourcePower, 100 + average);
  assert.equal(summary.boards[72].sourcePower, 900 + average);
  assert.equal(summary.sourcePower, summary.boards[71].sourcePower + summary.boards[72].sourcePower);
  assert.equal(summary.powerDifference, summary.power - summary.sourcePower);
  const group = (board, basis) => summary.boards[board].groups.filter(item => item.basis === basis);
  assert.deepEqual(group(71, 'level').map(item => [item.count, item.cost, item.power]), [[2, 2, 500]]);
  assert.deepEqual(group(72, 'level').map(item => [item.count, item.cost, item.power]), [[1, 1, 200]]);
  assert.deepEqual(group(72, 'aggregate').map(item => [item.count, item.power]), [[1, average]]);
  for (const plan of Object.values(summary.boards)) {
    assert.ok(Math.abs(plan.groups.reduce((sum, item) => sum + item.count * item.power, 0) - plan.power) < 1e-9);
    assert.equal(plan.cost, plan.groups.reduce((sum, item) => sum + item.count * COSTS[item.grade], 0));
  }
  // The source report credits the imported layout the same way.
  const source = optimizer.summarizeSource(problem, observations);
  assert.equal(source.power, summary.sourcePower);
  assert.equal(source.boards[71].power, 100 + average);
  assert.equal(source.boards[72].power, 900 + average);
  // Many decimal values: the board sums still add up to the total exactly.
  const wide = [0, 1].map(b => ({ id: 71 + b, name: `보드 ${b}`, nodes: [{ ...root, nodeId: 1000 * (b + 1) },
    ...Array.from({ length: 7 }, (_, i) => stat(1000 * (b + 1) + 7 - i, 8, 9 + i, 'Common', 1)),
    ...Array.from({ length: 7 }, (_, i) => skill(1000 * (b + 1) + 50 - i, 7 - i, 8, '시험', 'Common', 1))] }));
  const decimals = Object.fromEntries(wide.flatMap(board => board.nodes.filter(n => n.type === 'Stat').map((n, i) => [optimizer.key(n), [average, 10311 / 101, 8484 / 100, 2264 / 97][i % 4]])));
  const sequence = { [skillKey()]: Array.from({ length: 14 }, (_, i) => 1381 / 102 + i / 7) };
  const big = optimizer.createProblem(wide, decimals, { skills: sequence });
  const full = optimizer.summarizeSource(big);
  assert.equal(full.cost, 28);
  assert.equal(full.power, full.boards[71].power + full.boards[72].power);
  assert.equal(full.power, optimizer.validate(big, optimizer.sourceSelections(big)).power);
  assert.ok(!Number.isInteger(full.power));
});
