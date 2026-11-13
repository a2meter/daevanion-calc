const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const optimizer = require('../assets/optimizer.js');
const { Planner } = require('../assets/planner.js');
const loadHighs = require('../assets/vendor/highs/highs.js');
const runtime = loadHighs();
const root = { nodeId: 1, row: 8, col: 8, type: 'Start', grade: 'None', open: 1, name: '루트', effectList: [] };
function node(id, row, col, grade = 'Common', open = 0) {
  return { nodeId: id, row, col, grade, open, type: 'Stat', name: `스탯 ${id}`, effectList: [{ desc: `추가 공격력 +${id}` }] };
}
// Root at (8,8). 2-3-5 run upward, 4-6 run to the right, 7 is unreachable.
function fixture() {
  const boards = [{ id: 71, name: '테스트', file: 'test.html', nodes: [root,
    node(2, 7, 8, 'Common', 1), node(3, 6, 8, 'Rare', 1), node(4, 8, 9, 'Common', 1),
    node(5, 5, 8, 'Common'), node(6, 8, 10, 'Unique'), node(7, 1, 1, 'Common')] }];
  const values = Object.fromEntries(boards[0].nodes.filter(n => n.type !== 'Start')
    .map(n => [optimizer.key(n), { 2: 20, 3: 30, 4: 400, 5: 5, 6: 60, 7: 100000 }[n.nodeId]]));
  return { boards, values };
}
function exhaustive(problem) {
  const candidates = problem.nodes.filter(n => !n.root);
  let best = null;
  for (let mask = 0; mask < 2 ** candidates.length; mask++) {
    const selections = Object.fromEntries(problem.graphs.map(g => [g.id, []]));
    candidates.forEach((n, i) => { if (mask & (1 << i)) selections[n.boardId].push(n.nodeId); });
    const checked = optimizer.validate(problem, selections);
    if (checked && (best === null || checked.power > best)) best = checked.power;
  }
  return best;
}
function realBoards() {
  const context = { window: {} };
  for (const f of ['boards/manifest.js', 'boards/measurements.js', 'boards/skill-values.js', 'boards/power-plan.js']) vm.runInNewContext(fs.readFileSync(`${__dirname}/../${f}`, 'utf8'), context);
  const boards = JSON.parse(JSON.stringify(context.window.DAEVANION_BOARDS));
  const values = Object.fromEntries(context.window.DAEVANION_MEASUREMENTS.map(r => [r.key, r.power]));
  const skills = Object.fromEntries(JSON.parse(JSON.stringify(context.window.DAEVANION_SKILL_VALUES)).map(s => [s.key, s.values]));
  const stored = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(context.window.DAEVANION_ALL_POWER_PLAN.boards).map(([id, p]) => [id, p.nodeIds]))));
  return { boards, values, skills, stored, builtin: context.window.DAEVANION_ALL_POWER_PLAN };
}

test('required nodes are kept apart from the layout and survive saving, resets and source reloads', () => {
  const { boards } = fixture();
  const planner = new Planner(boards);
  assert.deepEqual(planner.snapshot().required, { 71: [] });
  assert.equal(planner.setRequired(71, 1, true).ok, false);
  assert.equal(planner.setRequired(71, 99, true).ok, false);
  assert.equal(planner.toggleRequired(71, 6).changed, true);
  assert.equal(planner.setRequired(71, 6, true).changed, false);
  assert.equal(planner.toggleRequired(71, 5).changed, true);
  assert.equal(planner.requiredCount(), 2);
  assert.equal(planner.requiredCount(71), 2);
  assert.equal(planner.requiredCost(), 5);
  assert.equal(planner.isRequired(71, 6), true);
  // Requiring a node never edits the active layout or the budget.
  assert.deepEqual(planner.snapshot().boards, { 71: [2, 3, 4] });
  assert.equal(planner.remaining(), 0);
  const restored = new Planner(boards, JSON.parse(JSON.stringify(planner.snapshot())));
  assert.deepEqual(restored.snapshot(), planner.snapshot());
  assert.deepEqual(restored.snapshot().required, { 71: [5, 6] });
  assert.equal(restored.reset().ok, true);
  assert.equal(restored.loadSource().ok, true);
  assert.equal(restored.deactivate(71, 4).ok, true);
  assert.deepEqual(restored.snapshot().required, { 71: [5, 6] });
  // Unknown nodes, the root and other boards never become required.
  const dirty = new Planner(boards, { ...planner.snapshot(), required: { 71: [6, 1, 999, 6], 72: [5] } });
  assert.deepEqual(dirty.snapshot().required, { 71: [6] });
  assert.equal(new Planner(boards, { ...planner.snapshot(), required: 'bad' }).requiredCount(), 0);
  assert.equal(restored.toggleRequired(71, 5).changed, true);
  assert.deepEqual(restored.snapshot().required, { 71: [6] });
  assert.equal(restored.clearRequired().changed, true);
  assert.equal(restored.clearRequired().changed, false);
  assert.equal(restored.requiredCount(), 0);
});

test('a required node changes the model only when one is set and rejects invalid choices', () => {
  const { boards, values } = fixture();
  const plain = optimizer.createProblem(boards, values);
  assert.equal(optimizer.createProblem(boards, values, { required: { 71: [] } }).signature, plain.signature);
  assert.equal(optimizer.createProblem(boards, values, { required: null }).signature, plain.signature);
  // Earlier saved results were signed without this option and must keep matching.
  assert.equal(JSON.parse(plain.signature).length, 3);
  const pinned = optimizer.createProblem(boards, values, { required: { 71: [5, 5] } });
  assert.notEqual(pinned.signature, plain.signature);
  assert.equal(pinned.required.length, 1);
  assert.equal(pinned.requiredCost, 1);
  assert.equal(pinned.byId.get(5).required, true);
  assert.notEqual(optimizer.createProblem(boards, values, { required: { 71: [6] } }).signature, pinned.signature);
  for (const bad of [{ 71: [1] }, { 71: [999] }, { 72: [5] }, { 71: 5 }, [5], 'x']) {
    assert.throws(() => optimizer.createProblem(boards, values, { required: bad }), /필수 노드/);
  }
});

test('plans missing a required node fail validation and the solved optimum contains it', async () => {
  const { boards, values } = fixture();
  const plain = optimizer.createProblem(boards, values);
  const free = optimizer.solve(plain, await runtime, { seconds: 2 });
  assert.deepEqual(free.selections, { 71: [2, 3, 4] });
  // Node 5 is worth less than what it displaces, so only the requirement brings it in.
  const pinned = optimizer.createProblem(boards, values, { required: { 71: [5] } });
  assert.equal(optimizer.validate(pinned, free.selections), null);
  assert.equal(optimizer.validate(pinned, optimizer.sourceSelections(pinned)), null);
  const solved = optimizer.solve(pinned, await runtime, { candidates: [free.selections], seconds: 2 });
  assert.deepEqual(solved.selections, { 71: [2, 3, 5] });
  assert.equal(solved.status, 'optimal');
  assert.equal(solved.power, exhaustive(pinned));
  assert.ok(solved.power < free.power);
  assert.equal(solved.signature, pinned.signature);
  assert.throws(() => optimizer.summarize(pinned, { ...free, signature: pinned.signature }), /검증/);
  const summary = optimizer.summarize(pinned, solved);
  assert.equal(summary.requiredCount, 1);
  assert.deepEqual(summary.boards[71].requiredNodeIds, [5]);
  assert.equal(optimizer.summarize(plain, free).requiredCount, 0);
  // The source report describes the character as imported, whatever is required.
  assert.equal(optimizer.summarizeSource(pinned).cost, 4);
  // A proof for the unrestricted model never certifies the restricted one.
  const again = optimizer.solve(pinned, await runtime, { certificate: free, seconds: 2 });
  assert.deepEqual(again.selections, { 71: [2, 3, 5] });
});

test('requirements that cannot fit report why instead of running out of time', async () => {
  const { boards, values } = fixture();
  const unreachable = optimizer.createProblem(boards, values, { required: { 71: [7] } });
  assert.equal(optimizer.requiredLowerBound(unreachable), Infinity);
  assert.throws(() => optimizer.solve(unreachable, null, { seconds: 2 }), /연결할 수 없는 필수 노드/);
  // 5 needs 2 and 3 (4 points); 6 needs 4 (5 points): the budget is 4.
  const tooMany = optimizer.createProblem(boards, values, { required: { 71: [5, 6] } });
  assert.equal(optimizer.requiredLowerBound(tooMany), 5);
  assert.throws(() => optimizer.solve(tooMany, null, { seconds: 2 }), /최소 5개/);
  // The bound passes (5 costs 4 with its path) yet no exact-budget plan holds both 4 and 5.
  const blocked = optimizer.createProblem(boards, values, { required: { 71: [4, 5] } });
  assert.equal(optimizer.requiredLowerBound(blocked), 4);
  assert.equal(exhaustive(blocked), null);
  assert.equal(optimizer.repair(blocked, optimizer.sourceSelections(blocked)), null);
  await assert.rejects(async () => optimizer.solve(blocked, await runtime, { seconds: 2 }), /필수 노드 2개를 모두 포함하면서/);
});

test('repair turns incomplete layouts into exact-budget starts and improvement never lowers them', () => {
  const { boards, values } = fixture();
  const pinned = optimizer.createProblem(boards, values, { required: { 71: [5] } });
  const repaired = optimizer.validate(pinned, optimizer.repair(pinned, optimizer.sourceSelections(pinned)));
  assert.deepEqual([...repaired.selections[71]].sort(), [2, 3, 5]);
  for (const start of [{}, { 71: [] }, { 71: [4] }, { 71: [7, 999, 1] }, null]) {
    const checked = optimizer.validate(pinned, optimizer.repair(pinned, start));
    assert.ok(checked, JSON.stringify(start));
    assert.equal(checked.cost, 4);
    assert.ok(checked.selections[71].includes(5));
    const better = optimizer.improve(pinned, checked);
    assert.ok(optimizer.validate(pinned, better.selections));
    assert.ok(better.power >= checked.power);
  }
});

test('random small boards with required nodes match exhaustive enumeration', async () => {
  let seed = 20261113;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const grades = ['Common', 'Common', 'Common', 'Rare', 'Legend', 'Unique'];
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const highs = await runtime;
  let solved = 0, impossible = 0;
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
        nodes.push(node(id++, r + dr, c + dc, grades[Math.floor(random() * grades.length)]));
      }
      // A connected source layout defines the shared budget.
      const at = new Map(nodes.map(n => [`${n.row},${n.col}`, n]));
      for (let pass = 0; pass < 3; pass++) for (const n of nodes) {
        if (n.type === 'Start' || n.open === 1 || random() > .4) continue;
        if (steps.some(([dr, dc]) => { const next = at.get(`${n.row + dr},${n.col + dc}`); return next && (next.type === 'Start' || next.open === 1); })) n.open = 1;
      }
      boards.push({ id: 71 + b, name: `보드 ${b}`, file: 'test.html', nodes });
    }
    const all = boards.flatMap(board => board.nodes.filter(n => n.type !== 'Start').map(n => ({ boardId: board.id, n })));
    if (!all.some(({ n }) => n.open === 1)) continue;
    const values = Object.fromEntries(all.map(({ n }) => [optimizer.key(n), random() < .2 ? 0 : Math.floor(random() * 500) + (random() < .2 ? .5 : 0)]));
    const required = {};
    for (const { boardId, n } of all) if (random() < .25) (required[boardId] ||= []).push(n.nodeId);
    const problem = optimizer.createProblem(boards, values, { required });
    const expected = exhaustive(problem);
    if (expected === null) {
      impossible++;
      assert.throws(() => optimizer.solve(problem, highs, { seconds: 5 }), /필수|구성/);
      continue;
    }
    const result = optimizer.solve(problem, highs, { seconds: 5 });
    solved++;
    assert.equal(result.status, 'optimal', `trial ${trial}`);
    assert.ok(Math.abs(result.power - expected) < 1e-6, `trial ${trial}: ${result.power} != ${expected}`);
    const checked = optimizer.validate(problem, result.selections);
    assert.ok(checked && problem.required.every(index => checked.selected.has(index)));
    // The heuristic start alone must already be a valid plan that never beats the optimum.
    const start = optimizer.validate(problem, optimizer.repair(problem, {}));
    if (start) assert.ok(optimizer.improve(problem, start).power <= expected + 1e-6);
  }
  assert.ok(solved >= 40 && impossible >= 5, `${solved} solved, ${impossible} impossible`);
});

test('real five boards honour required skill nodes within the shared 837 points', async () => {
  const { boards, values, skills, stored, builtin } = realBoards();
  const plain = optimizer.createProblem(boards, values, { skills });
  // Every node of two active skills, one of which the stored plan leaves a node of out, plus all
  // Lumiel regeneration nodes, none of which it takes.
  const wanted = plain.nodes.filter(n => !n.root && (['벼락 난사 +1', '심판의 번개 +1'].includes(n.effectList[0].desc)
    || (n.boardId === 79 && n.effectList[0].desc === '재생 +1%')));
  assert.equal(wanted.length, 14);
  assert.ok(wanted.filter(n => !stored[n.boardId].includes(n.nodeId)).length >= 7);
  const required = {};
  for (const n of wanted) (required[n.boardId] ||= []).push(n.nodeId);
  const problem = optimizer.createProblem(boards, values, { required, skills });
  assert.equal(problem.required.length, 14);
  const started = Date.now();
  const solved = optimizer.solve(problem, await runtime, { candidates: [stored], seconds: 2 });
  assert.ok(Date.now() - started < 6000);
  const checked = optimizer.validate(problem, solved.selections);
  assert.ok(checked);
  assert.equal(checked.cost, 837);
  assert.ok(wanted.every(n => solved.selections[n.boardId].includes(n.nodeId)));
  const planner = new Planner(boards, { version: 2, required });
  assert.equal(planner.replaceAllBoards(solved.selections).ok, true);
  assert.equal(planner.remaining(), 0);
  assert.equal(planner.requiredCount(), 14);
  const summary = optimizer.summarize(problem, solved);
  assert.equal(summary.requiredCount, 14);
  assert.equal(Object.values(summary.boards).reduce((sum, plan) => sum + plan.requiredNodeIds.length, 0), 14);
  // Restricting the plan cannot score above the unrestricted bound, and the
  // unrestricted search may not fall below the stored plan.
  assert.ok(solved.power <= builtin.powerUpperBound);
  const free = optimizer.solve(plain, await runtime, { candidates: [stored], seconds: 2 });
  assert.ok(free.power >= builtin.power);
  assert.ok(free.power >= solved.power);
});

test('an empty import gets a full-budget start at once, without waiting for the exact search', () => {
  const { boards, values, skills } = realBoards();
  for (const board of boards) for (const n of board.nodes) n.open = 0;
  const problem = optimizer.createProblem(boards, values, { skills });
  const started = Date.now();
  const start = optimizer.validate(problem, optimizer.repair(problem, optimizer.sourceSelections(problem)));
  assert.ok(start);
  assert.equal(start.cost, 837);
  assert.ok(Date.now() - started < 2000);
  const better = optimizer.improve(problem, start, Date.now() + 3000);
  assert.ok(optimizer.validate(problem, better.selections));
  assert.ok(better.power >= start.power);
});
