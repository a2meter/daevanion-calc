const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Planner, COSTS } = require('../assets/planner.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const all = JSON.parse(read('boards/all-power-plan.json'));
const plans = Object.values(all.boards);
const context = { window: {} };
for (const file of ['boards/manifest.js', 'boards/measurements.js', 'boards/power-plan.js']) vm.runInNewContext(read(file), context);
const boards = JSON.parse(JSON.stringify(context.window.DAEVANION_BOARDS));
const observations = JSON.parse(JSON.stringify(context.window.DAEVANION_MEASUREMENTS));
const powers = Object.fromEntries(observations.map(record => [record.key, record.power]));
const originals = Object.fromEntries(boards.map(board => [board.id, JSON.parse(read(`boards/${board.id}.json`)).nodeList]));
const key = node => JSON.stringify([node.grade, node.type, node.name, node.effectList.map(effect => effect.desc).filter(Boolean)]);
const selections = () => Object.fromEntries(plans.map(plan => [plan.boardId, plan.nodeIds]));

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
    const actual = selected.reduce((sum, node) => sum + (powers[key(node)] ?? 0), 0);
    assert.equal(selected.length, plan.nodeIds.length);
    assert.equal(new Set(plan.nodeIds).size, plan.nodeIds.length);
    assert.equal(plan.cost, selected.reduce((sum, node) => sum + COSTS[node.grade], 0));
    assert.equal(plan.power, actual);
    assert.equal(plan.connectorCount, plan.groups.filter(g => g.power === null).reduce((sum,g) => sum+g.count,0));
    assert.equal(plan.optimality.scope, 'shared');
    assert.equal(plan.optimality.gap, (plan.powerUpperBound - plan.power) / Math.max(1, Math.abs(plan.power)));
    assert.equal(plan.optimality.sharedGap, all.optimality.gap);
    assert.equal(plan.sourcePower, nodes.filter(node => node.open === 1).reduce((sum, node) => sum + (powers[key(node)] ?? 0), 0));
    assert.equal(plan.groups.reduce((sum, group) => sum + group.count, 0), selected.length);
    score += actual;
    source += plan.sourcePower;
    count += selected.length;
  }
  assert.equal(all.power, score);
  assert.equal(all.sourcePower, source);
  assert.equal(all.powerDifference, score - source);
  assert.equal(all.nodeCount, count);
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
        if (source) sourceSkills += (powers[key(node)] ?? 0);
        if (target) targetSkills += (powers[key(node)] ?? 0);
      }
      if (node.type !== 'Stat') continue;
      for (const effect of node.effectList) {
        const match = effect.desc.match(/^(.*?)\s+([+-][\d.,]+)(%?)$/);
        assert.ok(match);
        const [, name, text, unit] = match;
        const value = Number(text.replaceAll(',', ''));
        const row = stats.get(name) || { name, unit, source: 0, target: 0, powerDifference: 0, known: true };
        const known = node.effectList.length === 1 && Number.isFinite(powers[key(node)]);
        if (source || target) row.known &&= known;
        if (source) { row.source += value; if (known) row.powerDifference -= powers[key(node)]; }
        if (target) { row.target += value; if (known) row.powerDifference += powers[key(node)]; }
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
      assert.equal(row.powerDifference, actual.known ? actual.powerDifference : null);
    }
    const knownDelta = [...stats.values()].filter(row => row.known).reduce((sum, row) => sum + row.powerDifference, 0);
    assert.equal(plan.statComparison.reduce((sum, row) => sum + row.powerDifference, 0), knownDelta);
    if ([...stats.values()].every(row => row.known)) {
      assert.equal(knownDelta + targetSkills - sourceSkills, plan.power - plan.sourcePower);
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
