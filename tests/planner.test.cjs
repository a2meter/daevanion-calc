const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Planner, COSTS, STATE_VERSION, STORAGE_KEY, read, write } = require('../assets/planner.js');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../boards/manifest.js'), 'utf8'), context);
const boards = JSON.parse(JSON.stringify(context.window.DAEVANION_BOARDS));
const at = (boardId, row, col) => boards.find(board => board.id === boardId).nodes.find(node => node.row === row && node.col === col).nodeId;
const empty = definitions => new Planner(definitions, { version: STATE_VERSION,
  boards: Object.fromEntries(definitions.map(board => [board.id, []])) });
const create = (total) => {
  if (total === undefined) return empty(boards);
  const source = JSON.parse(JSON.stringify(boards));
  let remaining = total;
  for (const board of source) for (const node of board.nodes) {
    node.open = node.grade === 'Common' && remaining > 0 ? 1 : 0;
    if (node.open) remaining--;
  }
  assert.equal(remaining, 0);
  return empty(source);
};

test('new planners activate exactly the original JSON nodes and spend the source budget', () => {
  const costs = boards.map(board => {
    const original = JSON.parse(fs.readFileSync(path.join(__dirname, `../boards/${board.id}.json`), 'utf8'));
    for (const node of board.nodes) {
      assert.equal(node.open, original.nodeList.find(item => item.nodeId === node.nodeId).open);
    }
    return original.nodeList.filter(node => node.open === 1 && node.type !== 'Start' && node.type !== 'None')
      .reduce((sum, node) => sum + COSTS[node.grade], 0);
  });
  assert.deepEqual(costs, [186, 173, 183, 167, 0]);
  const planner = new Planner(boards);
  assert.equal(planner.total, 837);
  assert.equal(planner.remaining(), 128);
  assert.equal(planner.used(), 709);
  assert.deepEqual(boards.map(board => planner.active.get(board.id).size), [128, 121, 125, 118, 0]);
  for (const board of boards) for (const node of board.nodes) {
    assert.equal(planner.isActive(board.id, node.nodeId), node.type !== 'Start' && node.open === 1);
  }
});

test('explicitly saved empty boards remain empty, and the root cannot consume a point', () => {
  const planner = create();
  for (const board of boards) {
    assert.equal(planner.active.get(board.id).size, 0);
    assert.equal(planner.activate(board.id, at(board.id, 8, 8)).ok, false);
  }
  assert.equal(planner.used(), 0);
  assert.equal(planner.remaining(), 837);
});

test('Nezkhan frontier matches the supplied orthogonal root example', () => {
  const planner = create();
  const available = () => boards[0].nodes.filter(node => planner.available(71, node.nodeId)).map(node => `${node.row},${node.col}`).sort();
  assert.deepEqual(available(), ['7,8', '9,8']);
  planner.activate(71, at(71, 7, 8));
  assert.equal(planner.available(71, at(71, 7, 7)), true);
  assert.equal(planner.available(71, at(71, 7, 9)), true);
  assert.equal(planner.available(71, at(71, 6, 7)), false);
});

test('every real node has a shortest orthogonal path, with exact grade cost', () => {
  const planner = create();
  for (const definition of boards) {
    const board = planner.catalog.get(definition.id);
    const distances = new Map([[board.root, 0]]);
    const queue = [board.root];
    for (let i = 0; i < queue.length; i++) {
      for (const id of board.neighbors.get(queue[i])) {
        if (!distances.has(id)) { distances.set(id, distances.get(queue[i]) + 1); queue.push(id); }
      }
    }
    for (const node of definition.nodes.filter(node => node.type !== 'Start')) {
      const plan = planner.plan(definition.id, node.nodeId);
      assert.equal(plan.nodes.length, distances.get(node.nodeId));
      assert.equal(plan.cost, plan.nodes.reduce((sum, id) => sum + COSTS[board.nodes.get(id).grade], 0));
      let previous = board.root;
      for (const id of plan.nodes) {
        assert.ok(board.neighbors.get(previous).includes(id));
        previous = id;
      }
    }
  }
});

const synthetic = [{ id: 71, nodes: [
  { nodeId: 0, row: 8, col: 8, type: 'Start', grade: 'None', open: 1 },
  { nodeId: 1, row: 8, col: 7, type: 'Stat', grade: 'Common', open: 1 },
  { nodeId: 2, row: 7, col: 8, type: 'Stat', grade: 'Unique', open: 1 },
  { nodeId: 3, row: 7, col: 7, type: 'SkillLevel', grade: 'Legend', open: 1 }
] }];

test('equal-length paths prefer lower cost; existing active paths are free', () => {
  const planner = empty(synthetic);
  assert.equal(planner.total, 8);
  assert.deepEqual(planner.plan(71, 3), { nodes: [1, 3], cost: 4 });
  planner.activate(71, 1);
  assert.deepEqual(planner.plan(71, 3), { nodes: [3], cost: 3 });
  planner.activate(71, 3);
  assert.equal(planner.used(), 4);
  const before = planner.snapshot();
  planner.activate(71, 3);
  assert.deepEqual(planner.snapshot(), before);
});

test('budget is shared across boards, and insufficient paths are atomic', () => {
  const planner = create(5);
  const first = at(71, 7, 8);
  const second = at(72, 8, 7);
  assert.equal(planner.activate(71, first).ok, true);
  assert.equal(planner.activate(72, second).ok, true);
  assert.equal(planner.remaining(), 5 - planner.used(71) - planner.used(72));
  const before = planner.snapshot();
  assert.equal(planner.activate(73, at(73, 1, 1)).ok, false);
  assert.deepEqual(planner.snapshot(), before);
});

test('deactivation refuses to disconnect other nodes without changing state or refunding', () => {
  const planner = empty(synthetic);
  planner.activate(71, 3);
  assert.equal(planner.used(), 4);
  const before = planner.snapshot();
  const result = planner.deactivate(71, 1);
  assert.equal(result.ok, false);
  assert.notEqual(result.changed, true);
  assert.deepEqual(planner.snapshot(), before);
  assert.equal(planner.remaining(), 4);
  assert.equal(planner.deactivate(71, 3).ok, true);
  assert.equal(planner.used(), 1);
  assert.equal(planner.remaining(), 7);
  assert.equal(planner.deactivate(71, 1).ok, true);
  assert.equal(planner.used(), 0);
  assert.equal(planner.remaining(), 8);
  assert.equal(planner.active.get(71).size, 0);
  assert.equal(planner.deactivate(71, 1).changed, false);
  assert.equal(planner.remaining(), 8);
});

test('alternate root connections keep downstream nodes active', () => {
  const planner = empty(synthetic);
  planner.activate(71, 3);
  planner.activate(71, 2);
  assert.equal(planner.used(), 8);
  planner.deactivate(71, 1);
  assert.deepEqual([...planner.active.get(71)].sort(), [2, 3]);
  assert.equal(planner.used(), 7);
  assert.equal(planner.remaining(), 1);
});

test('blocked branches preserve every board; valid leaf removal refunds each grade across restore', () => {
  const branch = { id: 71, nodes: [
    { nodeId: 0, row: 8, col: 8, type: 'Start', grade: 'None', open: 1 },
    { nodeId: 1, row: 7, col: 8, type: 'Stat', grade: 'Common', open: 1 },
    { nodeId: 2, row: 6, col: 8, type: 'SkillLevel', grade: 'Rare', open: 1 },
    { nodeId: 3, row: 5, col: 8, type: 'SkillLevel', grade: 'Legend', open: 1 },
    { nodeId: 4, row: 6, col: 7, type: 'Stat', grade: 'Unique', open: 1 },
    { nodeId: 5, row: 9, col: 8, type: 'Stat', grade: 'Common', open: 1 }
  ] };
  const other = { id: 72, nodes: synthetic[0].nodes.map(node => ({ ...node, nodeId: node.nodeId + 100 })) };
  const definitions = [branch, other];
  const planner = empty(definitions);
  for (const nodeId of [3, 4, 5]) planner.activate(71, nodeId);
  planner.activate(72, 101);
  const before = planner.remaining();
  const beforeState = planner.snapshot();
  const otherState = planner.snapshot().boards[72];
  const result = planner.deactivate(71, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(planner.snapshot(), beforeState);
  for (const [nodeId, refund] of [[4, 4], [3, 3], [2, 2], [1, 1]]) {
    const remaining = planner.remaining();
    assert.equal(planner.deactivate(71, nodeId).ok, true);
    assert.equal(planner.remaining(), remaining + refund);
  }
  assert.deepEqual([...planner.active.get(71)], [5]);
  assert.deepEqual(planner.snapshot().boards[72], otherState);
  assert.equal(planner.remaining(), before + 10);
  assert.equal(planner.used(), 2);
  const restored = new Planner(definitions, planner.snapshot());
  assert.deepEqual(restored.snapshot(), planner.snapshot());
});

test('toggle activates shortest paths and deactivates active nodes without changing the root', () => {
  const planner = empty(synthetic);
  assert.equal(planner.toggle(71, 0).ok, false);
  assert.equal(planner.toggle(71, 3).ok, true);
  assert.equal(planner.used(), 4);
  assert.equal(planner.toggle(71, 1).ok, false);
  assert.equal(planner.used(), 4);
  assert.equal(planner.toggle(71, 3).ok, true);
  assert.equal(planner.used(), 1);
  assert.equal(planner.toggle(71, 1).ok, true);
  assert.equal(planner.used(), 0);
  assert.equal(planner.remaining(), 8);
  assert.equal(planner.toggle(71, 1).ok, true);
  assert.equal(planner.used(), 1);
  assert.equal(planner.isActive(71, 0), false);
});

test('state round-trips through storage and excludes root and disconnected nodes', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const planner = create();
  planner.activate(71, at(71, 7, 8));
  planner.activate(72, at(72, 8, 7));
  assert.equal(write(storage, planner), true);
  assert.ok(memory.has(STORAGE_KEY));
  const restored = new Planner(boards, read(storage));
  assert.deepEqual(restored.snapshot(), planner.snapshot());
  const corrupt = planner.snapshot();
  corrupt.boards[71].push(at(71, 8, 8), at(71, 1, 1), -99);
  assert.deepEqual(new Planner(boards, corrupt).snapshot(), planner.snapshot());
  corrupt.total = 0;
  assert.equal(new Planner(boards, corrupt).used(), planner.used());
  assert.equal(new Planner(boards, corrupt).total, 837);
  const emptySource = boards.map(board => ({ ...board, nodes: board.nodes.map(node => ({ ...node, open: 0 })) }));
  assert.equal(new Planner(emptySource, corrupt).used(), planner.used());
});

test('zero source budgets use 837 shared points without preactivating nodes and survive storage failure', () => {
  const planner = create(0);
  assert.equal(planner.total, 837);
  assert.equal(planner.used(), 0);
  assert.equal(planner.remaining(), 837);
  assert.equal(planner.activate(71, at(71, 7, 8)).ok, true);
  assert.equal(planner.remaining(), 836);
  const unavailable = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
  assert.equal(read(unavailable), null);
  assert.equal(write(unavailable, planner), false);
});

test('unreachable nodes and invalid targets leave state unchanged', () => {
  const isolated = [{ id: 71, nodes: [...synthetic[0].nodes,
    { nodeId: 99, row: 1, col: 1, type: 'Stat', grade: 'Common' }] }];
  const planner = empty(isolated);
  const before = planner.snapshot();
  assert.equal(planner.plan(71, 99), null);
  assert.equal(planner.activate(71, 99).message, '루트와 연결할 수 없습니다.');
  assert.equal(planner.activate(71, -1).ok, false);
  assert.deepEqual(planner.snapshot(), before);
});

test('legacy manual totals never override the source budget or valid edited nodes', () => {
  const planner = create();
  planner.activate(71, at(71, 7, 8));
  for (const total of [null, 0, 100, 1000, -1, 'invalid']) {
    const saved = { ...planner.snapshot(), total };
    const restored = new Planner(boards, saved);
    assert.equal(restored.total, 837);
    assert.equal(restored.remaining(), 836);
    assert.equal(restored.isActive(71, at(71, 7, 8)), true);
    restored.reset();
    assert.equal(restored.remaining(), 837);
  }
});

test('source import replaces legacy defaults once, preserves later edits, and leaves measurements intact', () => {
  const legacy = JSON.stringify({ version: 1, total: 0, boards: {} });
  const measurements = JSON.stringify({ version: 1, values: { recorded: 439 } });
  const memory = new Map([['daevanion-planner:v1', legacy], ['daevanion-option-measurements:v1', measurements]]);
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const planner = new Planner(boards, read(storage));
  assert.equal(planner.used(), 709);
  assert.equal(new Planner(boards, JSON.parse(legacy)).used(), 709);
  assert.equal(write(storage, planner), true);
  assert.equal(memory.get('daevanion-planner:v1'), legacy);
  assert.equal(memory.get('daevanion-option-measurements:v1'), measurements);
  planner.reset(71);
  write(storage, planner);
  const restored = new Planner(boards, read(storage));
  assert.equal(restored.active.get(71).size, 0);
  assert.equal(restored.used(), 523);
  assert.equal(restored.remaining(), 314);
  assert.equal(restored.loadSource().ok, true);
  assert.equal(restored.used(), 709);
  assert.deepEqual(boards.map(board => restored.active.get(board.id).size), [128, 121, 125, 118, 0]);
  restored.reset();
  write(storage, restored);
  assert.equal(new Planner(boards, read(storage)).used(), 0);
});

test('missing saved board arrays use the JSON source while explicit empty arrays stay empty', () => {
  const saved = empty(boards).snapshot();
  delete saved.boards[72];
  const restored = new Planner(boards, saved);
  assert.deepEqual(boards.map(board => restored.active.get(board.id).size), [0, 121, 0, 0, 0]);
  assert.equal(restored.used(), 173);
  assert.equal(new Planner(boards, { version: STATE_VERSION }).used(), 709);
});
