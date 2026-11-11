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
function fixture() {
  const boards = [{ id: 71, name: '테스트', file: 'test.html', nodes: [root,
    node(2, 7, 8, 'Common', 1), { ...node(3, 6, 8, 'Rare', 1), type: 'SkillLevel' }, node(4, 8, 9, 'Common', 1),
    node(5, 5, 8, 'Common'), node(6, 8, 10, 'Unique'), node(7, 1, 1, 'Common')] }];
  const values = Object.fromEntries(boards[0].nodes.filter(n => n.type !== 'Start').map(n => [optimizer.key(n), n.nodeId === 7 ? 100000 : n.nodeId === 6 ? 500 : n.nodeId * 10]));
  return { boards, values };
}
function exhaustive(problem) {
  const candidates = problem.nodes.filter(n => !n.root);
  let best = -Infinity;
  for (let mask = 0; mask < 2 ** candidates.length; mask++) {
    const selections = Object.fromEntries(problem.graphs.map(g => [g.id, []]));
    candidates.forEach((n, i) => { if (mask & (1 << i)) selections[n.boardId].push(n.nodeId); });
    const checked = optimizer.validate(problem, selections);
    if (checked) best = Math.max(best, checked.power);
  }
  return best;
}

test('browser MIP matches exhaustive optimum, including connectivity and exact cost', async () => {
  const { boards, values } = fixture();
  const problem = optimizer.createProblem(boards, values);
  const solution = optimizer.solve(problem, await runtime, { seconds: 2 });
  assert.equal(solution.power, exhaustive(problem));
  assert.equal(solution.status, 'optimal');
  assert.ok(!Object.values(solution.selections).flat().includes(7));
  const planner = new Planner(boards);
  assert.equal(planner.replaceAllBoards(solution.selections).ok, true);
  assert.equal(planner.remaining(), 0);
  assert.ok(!solution.selections[71].includes(1));
  assert.equal(optimizer.createProblem(boards, values).byId.get(3).power, 200);
});

test('changed and decimal CP values trigger a new optimum without reusing a stale model', async () => {
  const { boards, values } = fixture();
  const before = optimizer.createProblem(boards, values);
  const first = optimizer.solve(before, await runtime, { seconds: 2 });
  values[optimizer.key(boards[0].nodes.find(n => n.nodeId === 5))] = 1000.125;
  const changed = optimizer.createProblem(boards, values);
  const second = optimizer.solve(changed, await runtime, { candidates: [first.selections], seconds: 2 });
  assert.notEqual(before.signature, changed.signature);
  assert.equal(second.power, exhaustive(changed));
  assert.ok(second.selections[71].includes(5));
  assert.throws(() => optimizer.summarize(changed, first), /검증/);
  const summary = optimizer.summarize(changed, second);
  assert.equal(summary.cost, 4);
  assert.equal(summary.boards[71].statComparison.reduce((sum, stat) => sum + stat.powerDifference, 0), second.power - summary.sourcePower);
});

test('shared allocation may move every point away from an original board', async () => {
  const boards = [
    { id: 71, name: '첫 보드', nodes: [root, node(2, 7, 8, 'Common', 1), node(3, 6, 8, 'Common', 1)] },
    { id: 72, name: '둘째 보드', nodes: [{ ...root, nodeId: 10 }, node(11, 7, 8), node(12, 6, 8)] },
  ];
  const values = Object.fromEntries(boards.flatMap(b => b.nodes.filter(n => n.type !== 'Start').map(n => [optimizer.key(n), n.nodeId < 10 ? 1 : 100])));
  const problem = optimizer.createProblem(boards, values);
  const result = optimizer.solve(problem, await runtime, { seconds: 2 });
  assert.deepEqual(result.selections, { 71: [], 72: [11, 12] });
  assert.equal(result.power, 200);
  assert.equal(result.power, exhaustive(problem));
});

test('zero-time solves retain a valid complete starting layout and an honest bound', async () => {
  const { boards, values } = fixture();
  const problem = optimizer.createProblem(boards, values);
  const result = optimizer.solve(problem, await runtime, { seconds: 0 });
  assert.ok(optimizer.validate(problem, result.selections));
  assert.ok(result.upperBound >= exhaustive(problem));
  assert.ok(result.power <= exhaustive(problem));
  if (result.status === 'optimal') assert.equal(result.power, exhaustive(problem));
});

test('proved results are reused only for an identical CP model and valid exact-budget witness', async () => {
  const { boards, values } = fixture();
  const problem = optimizer.createProblem(boards, values);
  const certified = optimizer.solve(problem, await runtime, { seconds: 2 });
  assert.equal(certified.status, 'optimal');
  // No native solver is needed when the complete model already has a proof.
  assert.equal(optimizer.solve(problem, null, { certificate: certified }).power, certified.power);
  const changed = optimizer.createProblem(boards, { ...values, [optimizer.key(boards[0].nodes.find(n => n.nodeId === 5))]: 1000.5 });
  const recalculated = optimizer.solve(changed, await runtime, { certificate: certified, seconds: 2 });
  assert.equal(recalculated.power, exhaustive(changed));
  assert.ok(recalculated.power > certified.power);
  assert.throws(() => optimizer.solve(problem, null, { certificate: { ...certified, power: NaN } }), /검증/);
  assert.throws(() => optimizer.solve(problem, null, { certificate: { ...certified, selections: { 71: [] } } }), /검증/);
});

test('invalid and missing values and malformed or disconnected plans fail validation', () => {
  const { boards, values } = fixture();
  const problem = optimizer.createProblem(boards, values);
  assert.equal(optimizer.validate(problem, { 71: [7, 2, 4, 5] }), null);
  assert.equal(optimizer.validate(problem, { 71: [2] }), null);
  assert.equal(optimizer.validate(problem, { 71: [1, 2, 3, 4] }), null);
  assert.equal(optimizer.validate(problem, { 71: [2, 2, 3] }), null);
  assert.equal(optimizer.validate(problem, {}), null);
  const k = optimizer.key(boards[0].nodes[1]);
  for (const bad of [undefined, NaN, -1, Infinity]) assert.throws(() => optimizer.createProblem(boards, { ...values, [k]: bad }));
  assert.throws(() => optimizer.createProblem(boards, { ...values, [k]: 1e13 }));
  const fake = { signature: problem.signature, selections: optimizer.sourceSelections(problem),
    upperBound: problem.allPower, status: 'feasible', power: NaN };
  assert.throws(() => optimizer.summarize(problem, fake), /검증/);
});

test('real five-board JS model uses current inputs, validates the witness and rebuilds comparisons', async () => {
  const context = { window: {} };
  for (const f of ['boards/manifest.js', 'boards/measurements.js', 'boards/power-plan.js']) vm.runInNewContext(fs.readFileSync(`${__dirname}/../${f}`, 'utf8'), context);
  const boards = JSON.parse(JSON.stringify(context.window.DAEVANION_BOARDS));
  const observations = JSON.parse(JSON.stringify(context.window.DAEVANION_MEASUREMENTS));
  const values = Object.fromEntries(observations.map(r => [r.key, r.power]));
  const builtin = context.window.DAEVANION_ALL_POWER_PLAN;
  const candidates = [JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(builtin.boards).map(([id, p]) => [id, p.nodeIds]))))];
  const problem = optimizer.createProblem(boards, values);
  const solved = optimizer.solve(problem, await runtime, { candidates, seconds: .1 });
  assert.ok(solved.power >= builtin.power);
  assert.ok(solved.upperBound >= solved.power);
  const summary = optimizer.summarize(problem, solved, observations);
  const planner = new Planner(boards);
  assert.equal(planner.replaceAllBoards(solved.selections).ok, true);
  assert.equal(planner.used(), 837);
  assert.equal(planner.remaining(), 0);
  assert.equal(summary.power, Object.values(summary.boards).reduce((sum, p) => sum + p.power, 0));
  for (const plan of Object.values(summary.boards)) {
    assert.equal(plan.groups.reduce((sum, g) => sum + g.count * g.power, 0), plan.power);
    const statDelta = plan.statComparison.reduce((sum, s) => sum + s.powerDifference, 0);
    const skillDelta = problem.graphs.find(g => g.id === plan.boardId).nodes.filter(n => n.type === 'SkillLevel')
      .reduce((sum, n) => sum + (plan.nodeIds.includes(n.nodeId) - (n.open === 1)) * n.power, 0);
    if (plan.statComparison.every(stat => stat.powerDifference !== null)) {
      assert.equal(statDelta + skillDelta, plan.power - plan.sourcePower);
    } else {
      const knownStats = new Set(plan.statComparison.filter(stat => stat.powerDifference !== null).map(stat => `${stat.name}:${stat.unit}`));
      const knownDelta = problem.graphs.find(graph => graph.id === plan.boardId).nodes
        .filter(node => node.type === 'Stat' && node.effectList.length === 1)
        .filter(node => {
          const match = node.effectList[0].desc.match(/^(.*?)\s+([+-][\d.,]+)(%?)$/);
          return match && knownStats.has(`${match[1]}:${match[3]}`);
        })
        .reduce((sum, node) => sum + (plan.nodeIds.includes(node.nodeId) - (node.open === 1)) * node.power, 0);
      assert.equal(statDelta, knownDelta);
    }
    assert.equal(plan.activationOrder.length, plan.nodeIds.length);
  }
});

test('empty five-board imports solve without an initial full-budget witness and spend all 837 points', async () => {
  const context={window:{}};
  for(const f of ['boards/manifest.js','boards/measurements.js']) vm.runInNewContext(fs.readFileSync(`${__dirname}/../${f}`,'utf8'),context);
  const boards=JSON.parse(JSON.stringify(context.window.DAEVANION_BOARDS));
  for(const board of boards) for(const node of board.nodes) node.open=0;
  const values=Object.fromEntries(context.window.DAEVANION_MEASUREMENTS.map(r=>[r.key,r.power]));
  const problem=optimizer.createProblem(boards,values);
  assert.equal(problem.budget,837);
  assert.equal(problem.sourceBudget,0);
  assert.equal(optimizer.validate(problem,optimizer.sourceSelections(problem)),null);
  const pending=optimizer.summarizeSource(problem);
  assert.equal(pending.pending,true);
  assert.equal(pending.cost,0);
  const solved=optimizer.solve(problem,await runtime,{seconds:10});
  const summary=optimizer.summarize(problem,solved);
  const planner=new Planner(boards);
  assert.equal(planner.replaceAllBoards(solved.selections).ok,true);
  assert.equal(planner.used(),837);
  assert.equal(planner.remaining(),0);
  assert.equal(summary.sourcePower,0);
  assert.equal(summary.cost,837);
  assert.equal(summary.pending,undefined);
  assert.ok(summary.power>0);
  assert.equal(planner.loadSource().ok,true);
  assert.equal(planner.used(),0);
  assert.equal(planner.remaining(),837);
});

test('Lumiel stat nodes of Rare and Legend grades stay unmeasured instead of receiving skill CP', () => {
  const nodes = [root, { ...node(2, 7, 8, 'Rare'), type: 'Stat' }, { ...node(3, 6, 8, 'Legend'), type: 'Stat' }];
  const boards = [{ id: 79, name: '루미엘', nodes }];
  const problem = optimizer.createProblem(boards, {});
  assert.equal(problem.budget, 837);
  assert.equal(problem.byId.get(2).power, 0);
  assert.equal(problem.byId.get(2).unknown, true);
  assert.equal(problem.byId.get(3).power, 0);
  assert.equal(problem.byId.get(3).unknown, true);
  const known = optimizer.createProblem(boards, { [optimizer.key(nodes[1])]: 350, [optimizer.key(nodes[2])]: 0 });
  assert.equal(known.byId.get(2).power, 350);
  assert.equal(known.byId.get(2).unknown, false);
  assert.equal(known.byId.get(3).unknown, false);
  assert.notEqual(problem.signature, known.signature);
});

test('planning budget threshold matches the editor at 0, 708, 709 and above', () => {
  const { planningBudget } = require('../assets/planner.js');
  for (const [source, expected] of [[0, 837], [1, 1], [708, 708], [709, 837], [710, 837], [837, 837]]) {
    assert.equal(planningBudget(source), expected);
  }
});
