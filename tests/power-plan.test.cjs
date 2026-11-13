const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Planner, COSTS } = require('../assets/planner.js');
const optimizer = require('../assets/optimizer.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const all = JSON.parse(read('boards/all-power-plan.json'));
const plans = Object.values(all.boards);
const context = { window: {} };
for (const file of ['boards/manifest.js', 'boards/measurements.js', 'boards/skill-values.js', 'boards/power-plan.js']) vm.runInNewContext(read(file), context);
const boards = JSON.parse(JSON.stringify(context.window.DAEVANION_BOARDS));
const observations = JSON.parse(JSON.stringify(context.window.DAEVANION_MEASUREMENTS));
const powers = Object.fromEntries(observations.map(record => [record.key, record.power]));
const originals = Object.fromEntries(boards.map(board => [board.id, JSON.parse(read(`boards/${board.id}.json`)).nodeList]));
const key = node => JSON.stringify([node.grade, node.type, node.name, node.effectList.map(effect => effect.desc).filter(Boolean)]);
const selections = () => Object.fromEntries(plans.map(plan => [plan.boardId, plan.nodeIds]));
const sequences = Object.fromEntries(JSON.parse(JSON.stringify(context.window.DAEVANION_SKILL_VALUES)).map(item => [item.key, item.values]));
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const byId = (a, b) => a.nodeId - b.nodeId;
// What each chosen node is worth, written out apart from the optimizer: boards
// in order and nodes by nodeId, the j-th chosen node of a levelled skill gets
// the j-th value of its sequence, and every other node its option value.
function credit(chosen) {
  const counts = new Map(), worth = new Map();
  for (const board of boards) for (const node of originals[board.id].filter(node => !['None', 'Start'].includes(node.type) && chosen(node)).sort(byId)) {
    const sequence = node.type === 'SkillLevel' ? sequences[key(node)] : undefined;
    if (sequence) counts.set(key(node), (counts.get(key(node)) || 0) + 1);
    worth.set(node.nodeId, sequence ? sequence[counts.get(key(node)) - 1] : powers[key(node)] ?? 0);
  }
  return worth;
}
const total = (worth, nodes) => [...nodes].sort(byId).reduce((sum, node) => sum + worth.get(node.nodeId), 0);
const chosenIds = new Set(plans.flatMap(plan => plan.nodeIds));
const targetWorth = credit(node => chosenIds.has(node.nodeId));
const sourceWorth = credit(node => node.open === 1);

test('global recommendation exhausts the shared pool and honestly reports its objective and bound', () => {
  assert.equal(all.budget, 837);
  assert.equal(all.cost, 837);
  assert.ok(['optimal', 'feasible'].includes(all.optimality.status));
  assert.ok(all.powerUpperBound >= all.power);
  assert.equal(all.optimality.gap, (all.powerUpperBound - all.power) / all.power);
  if (all.optimality.status === 'optimal') assert.equal(all.powerUpperBound, all.power);
  assert.ok(all.power >= 124730);
  assert.equal(plans.reduce((sum, plan) => sum + plan.cost, 0), 837);
  assert.deepEqual(plans.map(plan => plan.sourceBudget), [186, 173, 183, 167, 0]);
  let score = 0, source = 0, count = 0;
  for (const plan of plans) {
    const nodes = originals[plan.boardId].filter(node => !['None', 'Start'].includes(node.type));
    assert.equal(nodes.length, 152);
    assert.ok(nodes.every(node => Number.isFinite(powers[key(node)]) || plan.boardId === 79));
    const selected = nodes.filter(node => plan.nodeIds.includes(node.nodeId));
    const actual = total(targetWorth, selected);
    assert.equal(selected.length, plan.nodeIds.length);
    assert.equal(new Set(plan.nodeIds).size, plan.nodeIds.length);
    assert.equal(plan.cost, selected.reduce((sum, node) => sum + COSTS[node.grade], 0));
    assert.equal(plan.power, actual);
    assert.equal(plan.connectorCount, plan.groups.filter(g => g.power === null).reduce((sum,g) => sum+g.count,0));
    assert.equal(plan.optimality.scope, 'shared');
    // The board bound is its score plus the shared slack, so it matches up to rounding.
    close(plan.optimality.gap, (plan.powerUpperBound - plan.power) / Math.max(1, Math.abs(plan.power)), 1e-12);
    assert.equal(plan.optimality.sharedGap, all.optimality.gap);
    assert.equal(plan.sourcePower, total(sourceWorth, nodes.filter(node => node.open === 1)));
    assert.equal(plan.groups.reduce((sum, group) => sum + group.count, 0), selected.length);
    close(plan.groups.reduce((sum, group) => sum + group.count * group.power, 0), actual);
    for (const group of plan.groups) {
      // A levelled skill reports what this board's nodes of it were credited with.
      assert.equal(group.basis === 'level', Object.hasOwn(sequences, group.key));
      if (group.basis === 'level') close(group.count * group.power, total(targetWorth, selected.filter(node => key(node) === group.key)), 1e-9);
      else assert.equal(group.power, powers[group.key]);
    }
    score += actual;
    source += plan.sourcePower;
    count += selected.length;
  }
  assert.equal(all.power, score);
  assert.equal(all.sourcePower, source);
  assert.equal(all.powerDifference, score - source);
  assert.equal(all.nodeCount, count);
  // Each skill is worth the first c values of its sequence for its c chosen nodes over all boards.
  const skillNodes = Object.values(originals).flat().filter(node => node.type === 'SkillLevel');
  assert.equal(skillNodes.length, 88);
  for (const [worth, chosen] of [[targetWorth, node => chosenIds.has(node.nodeId)], [sourceWorth, node => node.open === 1]]) {
    for (const [skillKey, sequence] of Object.entries(sequences)) {
      const taken = skillNodes.filter(node => key(node) === skillKey && chosen(node));
      assert.equal(taken.reduce((sum, node) => sum + worth.get(node.nodeId), 0), sequence.slice(0, taken.length).reduce((sum, value) => sum + value, 0));
    }
  }
});

test('the JS model scores and summarises the stored plan exactly as the Python-generated files do', () => {
  const problem = optimizer.createProblem(boards, powers, { skills: sequences });
  assert.equal(problem.skills.length, 22);
  assert.equal(problem.budget, all.budget);
  const checked = optimizer.validate(problem, selections());
  assert.equal(checked.cost, all.cost);
  assert.equal(checked.power, all.power);
  const summary = optimizer.summarize(problem, { selections: selections(), signature: problem.signature, power: all.power,
    upperBound: all.powerUpperBound, status: all.optimality.status, solver: all.optimality.solver }, observations);
  for (const field of ['budget', 'cost', 'power', 'sourcePower', 'powerDifference', 'powerUpperBound', 'nodeCount', 'unknownCount']) {
    assert.equal(summary[field], all[field], field);
  }
  assert.equal(summary.optimality.gap, all.optimality.gap);
  assert.equal(summary.power, plans.reduce((sum, plan) => sum + summary.boards[plan.boardId].power, 0));
  assert.equal(summary.sourcePower, plans.reduce((sum, plan) => sum + summary.boards[plan.boardId].sourcePower, 0));
  for (const plan of plans) {
    const mine = summary.boards[plan.boardId];
    for (const field of ['cost', 'budget', 'sourceBudget', 'power', 'sourcePower', 'powerUpperBound', 'skillsUnchanged', 'unknownCount']) {
      assert.equal(mine[field], plan[field], `${plan.boardId} ${field}`);
    }
    assert.deepEqual(mine.nodeIds, plan.nodeIds);
    const groups = list => Object.fromEntries(list.map(group => [group.key, [group.count, group.cost, group.power, group.basis]]));
    assert.deepEqual(groups(mine.groups), groups(plan.groups));
    const stats = list => Object.fromEntries(list.map(stat => [`${stat.name}:${stat.unit}`, [stat.source, stat.target, stat.difference, stat.powerDifference]]));
    assert.deepEqual(stats(mine.statComparison), stats(plan.statComparison));
  }
});

test('all-board replacement is atomic, root connected and persistent across reload', () => {
  const planner = new Planner(boards);
  assert.equal(planner.replaceAllBoards(selections()).ok, true);
  assert.equal(planner.used(), 837);
  assert.equal(planner.remaining(), 0);
  assert.deepEqual(planner.snapshot().boards, selections());
  const restored = new Planner(boards, planner.snapshot());
  assert.deepEqual(restored.snapshot(), planner.snapshot());
  for (const board of boards) {
    const root = board.nodes.find(node => node.type === 'Start');
    assert.equal(planner.isActive(board.id, root.nodeId), false);
  }
});

test('invalid, disconnected, incomplete and wrong-cost full plans preserve every prior board', () => {
  const planner = new Planner(boards);
  const before = planner.snapshot();
  const wrongRoot = selections();
  wrongRoot[71] = [...wrongRoot[71], boards[0].nodes.find(node => node.type === 'Start').nodeId];
  const disconnected = selections();
  disconnected[72] = [boards[1].nodes.find(node => node.row === 1 && node.col === 1).nodeId];
  const incomplete = selections();
  delete incomplete[73];
  const over = Object.fromEntries(boards.map(board => [board.id, board.nodes.filter(node => node.type !== 'Start').map(node => node.nodeId)]));
  const under = Object.fromEntries(boards.map(board => [board.id, []]));
  for (const value of [null, [], wrongRoot, disconnected, incomplete, over, under]) {
    assert.equal(planner.replaceAllBoards(value).ok, false);
    assert.deepEqual(planner.snapshot(), before);
  }
});

test('saved activation sequences construct all five plans without extra paths or currency', () => {
  const planner = new Planner(boards);
  planner.reset();
  for (const plan of plans) {
    for (const entry of plan.activationOrder) {
      const node = originals[plan.boardId].find(node => node.nodeId === entry.nodeId);
      assert.equal(entry.col, node.col);
      assert.equal(entry.row, node.row);
      assert.equal(planner.available(plan.boardId, node.nodeId), true);
      assert.equal(planner.plan(plan.boardId, node.nodeId).nodes.length, 1);
      assert.equal(planner.activate(plan.boardId, node.nodeId).ok, true);
    }
    assert.deepEqual(planner.snapshot().boards[plan.boardId], plan.nodeIds);
  }
  assert.equal(planner.remaining(), 0);
});

test('stat comparisons independently aggregate original and selected effects for each board', () => {
  for (const plan of plans) {
    const stats = new Map();
    let sourceSkills = 0, targetSkills = 0;
    for (const node of originals[plan.boardId]) {
      const source = node.open === 1;
      const target = plan.nodeIds.includes(node.nodeId);
      if (node.type === 'SkillLevel') {
        if (source) sourceSkills += sourceWorth.get(node.nodeId);
        if (target) targetSkills += targetWorth.get(node.nodeId);
      }
      if (node.type !== 'Stat') continue;
      for (const effect of node.effectList) {
        const match = effect.desc.match(/^(.*?)\s+([+-][\d.,]+)(%?)$/);
        assert.ok(match);
        const [, name, text, unit] = match;
        const value = Number(text.replaceAll(',', ''));
        const row = stats.get(name) || { name, unit, source: 0, target: 0, sourcePower: 0, targetPower: 0, known: true };
        const known = node.effectList.length === 1 && Number.isFinite(powers[key(node)]);
        if (source || target) row.known &&= known;
        // Averages are decimals, so each side is added up on its own before the two are compared.
        if (source) { row.source += value; if (known) row.sourcePower += powers[key(node)]; }
        if (target) { row.target += value; if (known) row.targetPower += powers[key(node)]; }
        stats.set(name, row);
      }
    }
    assert.equal(plan.statComparison.length, stats.size);
    for (const row of plan.statComparison) {
      const actual = stats.get(row.name);
      assert.equal(row.source, actual.source);
      assert.equal(row.target, actual.target);
      assert.equal(row.unit, actual.unit);
      assert.equal(row.difference, actual.target - actual.source);
      assert.equal(row.powerDifference, actual.known ? actual.targetPower - actual.sourcePower : null);
    }
    const knownDelta = [...stats.values()].filter(row => row.known).reduce((sum, row) => sum + row.targetPower - row.sourcePower, 0);
    close(plan.statComparison.reduce((sum, row) => sum + row.powerDifference, 0), knownDelta);
    if ([...stats.values()].every(row => row.known)) {
      close(knownDelta + targetSkills - sourceSkills, plan.power - plan.sourcePower);
    }
  }
});

test('generated catalog and downloads expose all five allocations under one shared plan', () => {
  const generated = JSON.parse(JSON.stringify(context.window.DAEVANION_ALL_POWER_PLAN));
  assert.deepEqual(generated, all);
  assert.deepEqual(Object.keys(generated.boards), ['71', '72', '73', '74', '79']);
  for (const plan of plans) {
    assert.deepEqual(plan, JSON.parse(read(plan.file)));
    assert.ok(plan.nodeIds.every(id => Math.floor(id / 10000) === plan.boardId));
  }
});
