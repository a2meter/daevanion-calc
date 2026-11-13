const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const link = require('../assets/link-model.js');
const optimizer = require('../assets/optimizer.js');
const { Planner, COSTS, planningBudget } = require('../assets/planner.js');
const loadHighs = require('../assets/vendor/highs/highs.js');
const runtime = loadHighs();

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const DATA = ['boards/manifest.js', 'boards/power-plan.js', 'boards/options.js', 'boards/measurements.js', 'boards/skill-values.js', 'boards/skill-tables.js'];
const bundled = (() => {
  const context = { window: {} };
  for (const file of DATA) vm.runInNewContext(read(file), context);
  return plain(context.window);
})();
const boards = bundled.DAEVANION_BOARDS;
const tables = bundled.DAEVANION_SKILL_TABLES;
const values = Object.fromEntries(bundled.DAEVANION_MEASUREMENTS.map(record => [record.key, record.power]));
const board = id => boards.find(item => item.id === id);
const short = name => name.replace('스킬 레벨 상승 - ', '');
const recorded = new Map(bundled.DAEVANION_SKILL_VALUES.map(skill => [short(skill.name), skill]));
const idsOf = name => tables.ids.find(item => item.key === recorded.get(name).key).skillIds;

// The state at the end of the 2026-11-13 capture, as printed by `link/daevanion_link.py --read`:
// nine boards (71 empty, 72~74 and 79 nearly full, 75~78 not in the planner) and 94 skills.
const REAL = [
  'RFYBA2C89mps4w4AAo4PAAlHAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABIx7M-6xVfvvR1r-9e3aurd_Xu611f-vRRr_mexwBJ3_c67v',
  'NdreWTW33nK1_1qc99tZNPa3Wf77ja9wFK7_Nc7_s8SfR3J-ne3zu59_cuyd1fJHm-73We7wFLx_2-6vJfT_WkS1_9-sunv371pUte5fWfrvp-',
  'xwFMr0BcIDocCAIEAYIAfw7h_AGQAEmAIPA_KHW86gFNx_22627fHaX7uqj3f1OV_d8rur5Lcfftrtt-xwFOx_2-60lf_vjFrzd9zmut53zZ60',
  'c__vQlr_t-xwFPx_M-b_X01y8u8v2rVb_7Vat_n-jo119e7fmexwFeLQEAAAEA6QMAAAEA6gMAAAEA6wMAAAEA7AMAAAEA7QMAAAEA7gMAAAEA',
  '7wMAAAEA8AMAAAEA8QMAAAEATQQAAAEATgQAAAEAsQQAAAEAsgQAAAEAswQAAAEAQB8AAAEAdyMAAAEAasVKAAEAfMVKAAEAQGYDAQEApGYDAQ',
  'EAUI0DARIDQI4DARIDYLQDARMAULUDARMAcNsDARMAYNwDARMAgAIEARMDegMEARMDYgcEARQEkCkEARQAci4EARQAoFAEARMD9FEEARMDxFkE',
  'ARQEsHcEAQ8DoHgEAQ8DwJ4EAQ0D1J4EAQsBsJ8EAQ0D0MUEARIDkscEARID4OwEAREDbO0EAREDADsFARMDeDsFARMD4j8FARQEMLAFARADhL',
  'EFARADQNcFARcAaNcFARcAcEwGARQAmEwGARQAwA8HAQsD3g8HAQsDFBEHAQwE8IQHARQAGIUHARQAGYUHARQAg4UHAQEAAKwHARQAKKwHARQA',
  'ENMHARQAONMHARQAIPoHARQASPoHARQAcL0IARMDMr8IARMDAscIARQEkAsJAQYDsFkJARQA2FkJARQAwIAJARkA8oAJARkA0KcJARQA-KcJAR',
  'QA4M4JARkAEs8JARkA8PUJARkAIvYJARkAAB0KARkAMh0KARkAoBQOARQAyBQOARQAsDsOAQ0CwGIOAQ4C0IkOAR0C4LAOARIC8NcOAQ8CAP8O',
  'AQYEECYPAQ8EIE0PAR4EMHQPAQ4EQJsPAQ4E',
].join('');

// Written from the table in link/README.md, apart from the planner's decoder.
const u32 = value => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
function pack({ flags = 3, capturedAt = 0, power = 0, bestPower = 0, boards: sent = {}, skills = [] } = {}) {
  const bytes = [0x44, 0x56, 1, flags, ...u32(capturedAt), ...u32(power), ...u32(bestPower)];
  const ids = Object.keys(sent).map(Number).sort((a, b) => a - b);
  bytes.push(ids.length);
  for (const id of ids) {
    const bitmap = new Array(29).fill(0);
    for (const index of sent[id]) bitmap[(index - 1) >> 3] |= 1 << ((index - 1) & 7);
    bytes.push(id, ...bitmap);
  }
  const list = [...skills].sort((a, b) => a[0] - b[0]);
  bytes.push(list.length);
  for (const [skillId, level, daevanion = 0] of list) bytes.push(...u32(skillId), level, daevanion);
  return bytes;
}
const text = bytes => Buffer.from(bytes).toString('base64url');
const encode = state => text(pack(state));
const indexes = nodeIds => nodeIds.map(id => id % 10000);
// The nodes nearest to the start node: always a connected layout.
function near(item, count) {
  const at = new Map(item.nodes.map(node => [`${node.row},${node.col}`, node]));
  const seen = new Set(['8,8']), queue = [at.get('8,8')], taken = [];
  for (const node of queue) for (const [row, col] of [[node.row - 1, node.col], [node.row + 1, node.col], [node.row, node.col - 1], [node.row, node.col + 1]]) {
    const next = at.get(`${row},${col}`);
    if (!next || seen.has(`${row},${col}`)) continue;
    seen.add(`${row},${col}`); queue.push(next);
    if (taken.length < count) taken.push(next.nodeId);
  }
  return taken.sort((a, b) => a - b);
}
const opened = list => Object.fromEntries(list.map(item => [item.id, item.nodes.filter(node => node.type !== 'Start' && node.open === 1).map(node => node.nodeId).sort((a, b) => a - b)]));
const cost = open => Object.entries(open).reduce((sum, [id, ids]) => sum + ids.reduce((part, nodeId) => part + COSTS[board(Number(id)).nodes.find(node => node.nodeId === nodeId).grade], 0), 0);
// The bundled layout, and the same with Nezkhan emptied: every skill then has three of its four nodes open.
const sourceLayout = opened(boards);
const threeBoards = { ...sourceLayout, 71: [] };
const sent = layout => Object.fromEntries(Object.entries(layout).map(([id, ids]) => [id, [113, ...indexes(ids)]]));
// How many nodes of a skill a layout has open. An active skill has one node on each of the first four
// boards; a passive one has two on Nezkhan or Zikel and one each on Vaizel and Triniel.
const openCount = (layout, key) => boards.reduce((sum, item) => sum + item.nodes
  .filter(node => node.type === 'SkillLevel' && link.optionKey(node) === key && layout[item.id].includes(node.nodeId)).length, 0);
// Every recorded skill at the level the bundled character has with that layout, under each of its ids.
const levelsFor = (layout, overrides = {}) => [...recorded].flatMap(([name, skill]) => {
  const open = openCount(layout, skill.key);
  return idsOf(name).filter(id => overrides[id] !== null).map(id => [id, overrides[id] ?? skill.baseLevel + open, open]);
});

// One page load: the generated data, the planner and the link scripts, in the order index.html lists them.
function page(items, { hash = '', storage, element = null } = {}) {
  const local = storage || { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); }, removeItem: key => { items.delete(key); } };
  const location = { hash, pathname: '/index.html', search: '?boardId=72' };
  const history = { replaceState(_state, _title, url) { location.replaced = url; location.hash = ''; } };
  const document = { getElementById: id => id === 'board-data' ? element : null, querySelector: () => null, body: { dataset: { boardId: '72' } } };
  const context = { window: {}, localStorage: local, document, location, history, URL, Blob };
  context.window.localStorage = local;
  for (const file of ['assets/planner.js', ...DATA, 'assets/optimizer.js', 'assets/link-model.js', 'assets/link-session.js']) vm.runInNewContext(read(file), context, { filename: file });
  return { window: context.window, session: context.window.DaevanionLinkSession, location, storage: local };
}
const saved = (items, key) => JSON.parse(items.get(key));
const LINK = 'daevanion-link-import:v1', STATE = 'daevanion-planner:v2', PLAN = 'daevanion-recalculated-plan:v1';

test('the byte-exact example of link/README.md decodes as the reference decoder does', () => {
  const readme = read('link/README.md');
  const example = readme.match(/^RFYB[A-Za-z0-9_-]+$/m)[0];
  const expected = JSON.parse(readme.slice(readme.indexOf('`decode`의 결과입니다.')).match(/```json\n([\s\S]*?)```/)[1]);
  assert.equal(example.length, 120);
  assert.deepEqual(link.decode(example), expected);
  assert.deepEqual(link.decode(example), { version: 1, boardsComplete: true, skillsComplete: true, capturedAt: 1794553175, power: 975724, bestPower: 1019394,
    boards: [{ boardId: 71, nodeIds: [710113] }, { boardId: 79, nodeIds: [790001, 790016, 790113, 790225] }],
    skills: [{ skillId: 17040250, level: 20, daevanionLevels: 0 }, { skillId: 17750000, level: 17, daevanionLevels: 4 }] });
  // The same 90 bytes come out of this file's own encoder, so the fixtures below follow the specification too.
  const bytes = pack({ capturedAt: 1794553175, power: 975724, bestPower: 1019394, boards: { 71: [113], 79: [1, 16, 113, 225] },
    skills: [[17040250, 20, 0], [17750000, 17, 4]] });
  assert.equal(bytes.length, 90);
  assert.equal(text(bytes), example);
  // An address is read up to the next `&`; surrounding white space is ignored.
  for (const address of [`https://daevanion.a2meter.workers.dev/#link=${example}`, `#link=${example}`,
    `http://localhost:8765/?boardId=72#link=${example}&from=program`, `  ${example}\n`]) assert.deepEqual(link.decode(address), expected);
  assert.equal(link.fragment(`#link=${example}&x=1`), example);
  assert.equal(link.fragment('#72'), null);
  assert.equal(link.fragment(''), null);
  // The node numbering of the payload is the one the bundled boards use.
  for (const item of boards) for (const node of item.nodes) assert.equal(node.nodeId, item.id * 10000 + (node.row - 1) * 15 + node.col);
});

test('corrupt, truncated and foreign data is rejected, and unused bits are ignored', () => {
  const good = pack({ boards: { 71: [113], 72: [1, 225] }, skills: [[17040000, 19, 3], [17040250, 19, 3]] });
  const changed = change => { const bytes = [...good]; change(bytes); return text(bytes); };
  assert.deepEqual(link.decode(text(good)).boards, [{ boardId: 71, nodeIds: [710113] }, { boardId: 72, nodeIds: [720001, 720225] }]);
  assert.throws(() => link.decode(changed(bytes => { bytes[0] = 0x45; })), /데바니온 링크의 데이터가 아닙니다/);
  assert.throws(() => link.decode(changed(bytes => { bytes[1] = 0x44; })), /데바니온 링크의 데이터가 아닙니다/);
  for (const version of [0, 2, 255]) assert.throws(() => link.decode(changed(bytes => { bytes[2] = version; })), /지원하지 않는 링크 버전/);
  // Length: 18 + 30 × boards + 6 × skills, nothing more and nothing less.
  assert.equal(good.length, 18 + 30 * 2 + 6 * 2);
  assert.throws(() => link.decode(text(good.slice(0, 17))), /너무 짧습니다/);
  assert.throws(() => link.decode(text(good.slice(0, 16 + 1 + 30 + 12))), /보드 목록이 끊겼습니다/);
  assert.throws(() => link.decode(text(good.slice(0, 16 + 1 + 60))), /스킬 목록이 없습니다/);
  assert.throws(() => link.decode(text(good.slice(0, -1))), /스킬 목록 길이/);
  assert.throws(() => link.decode(text([...good, 0])), /스킬 목록 길이/);
  assert.throws(() => link.decode(changed(bytes => { bytes[16 + 1 + 60] = 3; })), /스킬 목록 길이/);
  assert.throws(() => link.decode(changed(bytes => { bytes[16] = 3; })), /보드 목록이 끊겼습니다|스킬 목록/);
  // Boards and skills are ascending and never repeated.
  assert.throws(() => link.decode(changed(bytes => { bytes[17] = 72; })), /보드 번호가 오름차순/);
  assert.throws(() => link.decode(changed(bytes => { bytes[17] = 73; })), /보드 번호가 오름차순/);
  assert.throws(() => link.decode(changed(bytes => { bytes.splice(-6, 4, ...u32(17040000)); })), /스킬 번호가 오름차순/);
  assert.throws(() => link.decode(changed(bytes => { bytes.splice(-6, 4, ...u32(1003)); })), /스킬 번호가 오름차순/);
  // Only the base64url alphabet without padding, and no impossible length.
  const data = text(good);
  assert.equal(data.length % 4, 0);
  for (const bad of [`${data.slice(0, -1)}+`, `${data.slice(0, -1)}/`, `${data.slice(0, -1)}=`, `${data.slice(0, 40)} ${data.slice(41)}`, `${data}%3D`, `${data.slice(0, -2)}한글`]) {
    assert.throws(() => link.decode(bad), /base64url/, bad.slice(-8));
  }
  for (const bad of ['', '   ', '#link=', 'https://daevanion.a2meter.workers.dev/#link=', `${data}A`, null, undefined]) assert.throws(() => link.decode(bad), /길이가 맞지 않습니다/);
  // Flag bits other than the two defined ones, and the seven bits after node 225, carry nothing.
  const noisy = link.decode(changed(bytes => { bytes[3] = 0xff; bytes[16 + 1 + 30 + 29] |= 0xfe; }));
  assert.deepEqual([noisy.boardsComplete, noisy.skillsComplete], [true, true]);
  assert.deepEqual(noisy.boards[1].nodeIds, [720001, 720225]);
  const bare = link.decode(changed(bytes => { bytes[3] = 0xfc; }));
  assert.deepEqual([bare.boardsComplete, bare.skillsComplete], [false, false]);
  assert.deepEqual([link.decode(changed(bytes => { bytes[3] = 1; })).skillsComplete, link.decode(changed(bytes => { bytes[3] = 2; })).boardsComplete], [false, false]);
  // Little-endian 32-bit fields keep their full range.
  const wide = link.decode(encode({ capturedAt: 0xfffffffe, power: 0x80000000, bestPower: 1, skills: [[0xfffffff0, 255, 255]] }));
  assert.deepEqual([wide.capturedAt, wide.power, wide.bestPower, wide.skills[0]], [4294967294, 2147483648, 1, { skillId: 4294967280, level: 255, daevanionLevels: 255 }]);
});

test('a link becomes the source layout of the five boards; other boards and stray bits are ignored', () => {
  const layout = { 71: [], 72: near(board(72), 30), 73: near(board(73), 5), 74: near(board(74), 1), 79: near(board(79), 60) };
  const holes = id => Array.from({ length: 225 }, (_, bit) => bit + 1).filter(index => !board(id).nodes.some(node => node.nodeId === id * 10000 + index));
  assert.equal(holes(72).length, 72);
  const before = plain(boards);
  // Board 71 carries only the start bit, 72 adds bits that are no node, 73 omits the start bit.
  const payload = link.decode(encode({ capturedAt: 1794553175, power: 975724, bestPower: 1019394, boards: {
    71: [113], 72: [113, ...indexes(layout[72]), ...holes(72).slice(0, 9)], 73: indexes(layout[73]), 74: [113, ...indexes(layout[74])],
    75: Array.from({ length: 225 }, (_, bit) => bit + 1), 79: [113, ...indexes(layout[79])], 255: [1] } }));
  const prepared = link.prepare(boards, payload, tables);
  assert.deepEqual(prepared.open, layout);
  assert.deepEqual(boards, before);
  assert.deepEqual(prepared.boards.map(item => [item.id, item.name, item.open, item.total]), boards.map(item => [item.id, item.name, layout[item.id].length, item.total]));
  for (const item of prepared.boards) for (const node of item.nodes) {
    const original = board(item.id).nodes.find(other => other.nodeId === node.nodeId);
    if (node.type === 'Start') assert.deepEqual(node, original);
    else assert.deepEqual(node, { ...original, open: layout[item.id].includes(node.nodeId) ? 1 : 0 });
  }
  assert.deepEqual(prepared.summary.counts, { 71: 0, 72: 30, 73: 5, 74: 1, 79: 60 });
  assert.deepEqual(prepared.summary.ignoredBoards, [75, 255]);
  assert.equal(prepared.summary.cost, cost(layout));
  assert.equal(prepared.summary.budget, planningBudget(cost(layout)));
  assert.deepEqual([prepared.summary.capturedAt, prepared.summary.power, prepared.summary.bestPower], [1794553175, 975724, 1019394]);
  // The planner and the optimizer both take the imported layout as the original one.
  const planner = new Planner(prepared.boards);
  assert.equal(planner.sourceTotal, cost(layout));
  assert.deepEqual(planner.snapshot().boards, layout);
  planner.reset();
  assert.equal(planner.loadSource().ok, true);
  assert.deepEqual(planner.snapshot().boards, layout);
  const problem = optimizer.createProblem(prepared.boards, values);
  assert.equal(problem.sourceBudget, cost(layout));
  assert.deepEqual(Object.fromEntries(Object.entries(optimizer.sourceSelections(problem)).map(([id, ids]) => [id, [...ids].sort((a, b) => a - b)])), layout);
  // The start node is open whether or not its bit is set.
  const without = link.decode(encode({ boards: Object.fromEntries(Object.entries(layout).map(([id, ids]) => [id, indexes(ids)])) }));
  assert.deepEqual(link.prepare(boards, without, tables).open, layout);
  // Empty boards are a valid state and plan with the full 837 points.
  const empty = link.prepare(boards, link.decode(encode({ boards: { 71: [113], 72: [], 73: [113], 74: [], 79: [] } })), tables);
  assert.deepEqual(empty.summary.counts, { 71: 0, 72: 0, 73: 0, 74: 0, 79: 0 });
  assert.deepEqual([empty.summary.cost, empty.summary.budget], [0, 837]);
});

test('a link without every board, without the complete flag or with an impossible layout is refused', () => {
  const full = sent(sourceLayout);
  assert.deepEqual(link.prepare(boards, link.decode(encode({ boards: full })), tables).open, sourceLayout);
  // A missing board, whichever it is, and boards of another class.
  const { 74: _triniel, ...four } = full;
  assert.throws(() => link.prepare(boards, link.decode(encode({ boards: four })), tables), /트리니엘\(74\) 보드가 없습니다\. 링크에 든 보드 번호는 71, 72, 73, 79입니다\./);
  for (const id of [71, 72, 73, 74, 79]) {
    const rest = Object.fromEntries(Object.entries(full).filter(([key]) => Number(key) !== id));
    assert.throws(() => link.prepare(boards, link.decode(encode({ boards: rest })), tables), new RegExp(`${board(id).name}\\(${id}\\) 보드가 없습니다`));
  }
  const chanter = Object.fromEntries(Object.entries(full).map(([id, bits]) => [Number(id) + 10, bits]));
  assert.throws(() => link.prepare(boards, link.decode(encode({ boards: chanter })), tables), /네자칸\(71\), 지켈\(72\), 바이젤\(73\), 트리니엘\(74\), 루미엘\(79\) 보드가 없습니다\. 링크에 든 보드 번호는 81, 82, 83, 84, 89입니다\./);
  assert.throws(() => link.prepare(boards, link.decode(encode({})), tables), /보드가 없습니다\.$/);
  // Boards seen only through later changes are not a full state.
  for (const flags of [0, 2]) assert.throws(() => link.prepare(boards, link.decode(encode({ flags, boards: full })), tables), /보드 전체 정보가 없습니다/);
  // An open node that does not reach the start node, and more points than the planner has.
  const corner = board(79).nodes.find(node => node.row === 1 && node.col === 1).nodeId;
  assert.throws(() => link.prepare(boards, link.decode(encode({ boards: { ...full, 79: [113, corner % 10000] } })), tables), /루미엘 보드에 시작 노드와 이어지지 않은 열린 노드가 있습니다/);
  const everything = Object.fromEntries(boards.map(item => [item.id, indexes(item.nodes.map(node => node.nodeId))]));
  assert.throws(() => link.prepare(boards, link.decode(encode({ boards: everything })), tables), /데바니온 \d+개가 계산용 수량 837개를 넘습니다/);
  // Without the skill flag the layout is still imported; only the skills stay on the fixed rule.
  const layoutOnly = link.prepare(boards, link.decode(encode({ flags: 1, boards: full, skills: levelsFor(sourceLayout) })), tables);
  assert.deepEqual(layoutOnly.open, sourceLayout);
  assert.equal(layoutOnly.skills.length, 0);
  assert.equal(layoutOnly.fallbacks.length, 22);
  assert.ok(layoutOnly.fallbacks.every(item => item.reason === 'incomplete'));
});

test('the level table gives the CP of each level and tells observed ranges from filled-in ones', () => {
  const source = JSON.parse(read('boards/skill-values.json'));
  assert.deepEqual(tables.levels, { Legend: source.levels.Legend, Rare: source.levels.Rare });
  const power = (grade, level) => link.levelPower(tables.levels, grade, level);
  assert.deepEqual([1, 11, 12, 13, 15, 16, 17, 19, 20, 21, 60].map(level => power('Legend', level)), [100, 100, 500, 100, 100, 900, 200, 200, 1000, 200, 200]);
  assert.deepEqual([1, 14, 15, 20, 21, 26, 27, 31, 32, 60].map(level => power('Rare', level)), [100, 100, 200, 200, 200, 200, 300, 300, 300, 300]);
  for (const [grade, level] of [['Legend', 0], ['Legend', 61], ['Rare', 0], ['Rare', 61], ['Rare', -1], ['Unique', 5], ['Rare', 1.5]]) assert.equal(power(grade, level), undefined);
  assert.equal(link.levelPower(null, 'Rare', 5), undefined);
  const observed = (grade, level) => link.levelStep(tables.levels, grade, level).observed;
  assert.deepEqual([20, 21, 60].map(level => observed('Legend', level)), [true, false, false]);
  assert.deepEqual([20, 21, 26, 27, 31, 32].map(level => observed('Rare', level)), [true, false, false, true, true, false]);
  // The bundled sequences are what the table gives at each skill's recorded base level.
  for (const skill of bundled.DAEVANION_SKILL_VALUES) {
    assert.deepEqual(skill.values, skill.values.map((_, index) => power(skill.grade, skill.baseLevel + index + 1)), skill.name);
    assert.ok(skill.values.every((_, index) => observed(skill.grade, skill.baseLevel + index + 1)), skill.name);
  }
  // The id table names every recorded skill once, by the option key the boards use.
  const ids = JSON.parse(read('boards/skill-ids.json')).skills;
  assert.equal(tables.ids.length, 22);
  for (const item of ids) {
    const key = JSON.stringify([item.grade, 'SkillLevel', item.name, item.effects]);
    assert.deepEqual(tables.ids.find(entry => entry.key === key).skillIds, [...item.skillIds].sort((a, b) => a - b));
    assert.ok(bundled.DAEVANION_OPTIONS.some(option => option.key === key));
  }
  assert.equal(new Set(tables.ids.flatMap(item => item.skillIds)).size, tables.ids.flatMap(item => item.skillIds).length);
});

test('skill levels become sequences: the base id decides, then the lowest id present, else the fixed rule', () => {
  const run = (layout, skills, options = {}) => link.prepare(boards, link.decode(encode({ flags: options.flags ?? 3, boards: sent(layout), skills })), 'tables' in options ? options.tables : tables);
  const find = (prepared, name) => prepared.skills.find(skill => short(skill.name) === name);
  const reason = (prepared, name) => prepared.fallbacks.find(item => short(item.name) === name)?.reason;
  // The bundled character at its recorded levels: 22 sequences, each equal to the recorded one.
  for (const [layout, total] of [[sourceLayout, 88], [threeBoards, 66]]) {
    const prepared = run(layout, levelsFor(layout));
    assert.equal(prepared.skills.length, 22);
    assert.deepEqual(prepared.fallbacks, []);
    assert.equal(prepared.skills.reduce((sum, skill) => sum + skill.opened, 0), total);
    for (const skill of prepared.skills) {
      const record = recorded.get(short(skill.name)), open = openCount(layout, record.key);
      assert.deepEqual([skill.key, skill.grade, skill.baseLevel, skill.level, skill.opened, skill.values, skill.unobservedLevels],
        [record.key, record.grade, record.baseLevel, record.baseLevel + open, open, record.values, []], skill.name);
    }
    assert.deepEqual([prepared.summary.skillTotal, prepared.summary.levelled, prepared.summary.unobserved, prepared.summary.fallbacks], [22, 22, 0, []]);
  }
  // The open nodes are counted on the imported layout. The link's own Daevanion share is not used: 0 there can mean "unknown".
  const counted = run(threeBoards, levelsFor(threeBoards));
  for (const share of [0, 1, 9]) {
    const other = run(threeBoards, levelsFor(threeBoards).map(([id, level]) => [id, level, share]));
    assert.deepEqual([other.skills, other.fallbacks], [counted.skills, counted.fallbacks]);
  }
  // 약화의 낙인 has a base id and two variants. A variant left behind at an old level does not count.
  const [base, lower, upper] = idsOf('약화의 낙인');
  assert.deepEqual([base, lower, upper], [17080000, 17080020, 17080240]);
  const stale = find(run(threeBoards, levelsFor(threeBoards, { [base]: 13, [lower]: 11, [upper]: 12 })), '약화의 낙인');
  assert.deepEqual([stale.skillId, stale.level, stale.baseLevel, stale.values], [base, 13, 10, [100, 500, 100, 100]]);
  // Without the base id the lowest id present is used, here the stale variant.
  const variant = find(run(threeBoards, levelsFor(threeBoards, { [base]: null, [lower]: 11, [upper]: 13 })), '약화의 낙인');
  assert.deepEqual([variant.skillId, variant.level, variant.baseLevel, variant.values], [lower, 11, 8, [100, 100, 100, 500]]);
  const last = find(run(threeBoards, levelsFor(threeBoards, { [base]: null, [lower]: null, [upper]: 13 })), '약화의 낙인');
  assert.deepEqual([last.skillId, last.baseLevel, last.values], [upper, 10, [100, 500, 100, 100]]);
  // The levels of the link apply to its own layout: the same level with fewer nodes open means a higher base.
  const [thunder] = idsOf('벼락 난사');
  assert.deepEqual(find(run(threeBoards, levelsFor(threeBoards, { [thunder]: 6 })), '벼락 난사').baseLevel, 3);
  assert.deepEqual(find(run(sourceLayout, levelsFor(sourceLayout, { [thunder]: 6 })), '벼락 난사').baseLevel, 2);
  // Ranges nobody measured are used and marked.
  const [judgement] = idsOf('단죄'), [healing] = idsOf('치유력 강화'), [grace] = idsOf('주신의 은총'), [block] = idsOf('회복 차단');
  // 단죄 has three nodes open there, the two passives two each (their other two are on Nezkhan).
  const high = run(threeBoards, levelsFor(threeBoards, { [judgement]: 21, [healing]: 21, [grace]: 58 }));
  assert.deepEqual([find(high, '단죄').baseLevel, find(high, '단죄').values, find(high, '단죄').unobservedLevels], [18, [200, 1000, 200, 200], [21, 22]]);
  assert.deepEqual([find(high, '치유력 강화').baseLevel, find(high, '치유력 강화').values, find(high, '치유력 강화').unobservedLevels], [19, [200, 200, 200, 200], [21, 22, 23]]);
  assert.deepEqual([find(high, '주신의 은총').baseLevel, find(high, '주신의 은총').values, find(high, '주신의 은총').unobservedLevels], [56, [300, 300, 300, 300], [57, 58, 59, 60]]);
  assert.deepEqual([high.skills.length, high.summary.unobserved], [22, 3]);
  // What cannot be valued keeps the fixed rule, each with its reason.
  const partial = run(threeBoards, levelsFor(threeBoards, { [thunder]: null, [block]: 2, [grace]: 60, [judgement]: 255 }),
    { tables: { ...tables, ids: tables.ids.filter(item => item.key !== recorded.get('벽력').key) } });
  assert.deepEqual(partial.fallbacks.map(item => [short(item.name), item.reason]).sort(), [['단죄', 'range'], ['벼락 난사', 'missing'], ['벽력', 'unmapped'], ['주신의 은총', 'range'], ['회복 차단', 'negative']]);
  assert.ok(partial.fallbacks.every(item => item.detail === link.reasons[item.reason] && item.key === recorded.get(short(item.name)).key));
  assert.deepEqual([partial.skills.length, partial.summary.levelled, partial.summary.fallbacks.length], [17, 17, 5]);
  assert.equal(reason(partial, '고통의 연쇄'), undefined);
  // A level equal to the open nodes is base 0: the sequence starts at level 1. 회복 차단 has all four nodes open here.
  const zero = find(run(threeBoards, levelsFor(threeBoards, { [block]: 4 })), '회복 차단');
  assert.deepEqual([zero.opened, zero.baseLevel, zero.values], [4, 0, [100, 100, 100, 100]]);
  const nothing = { 71: [], 72: [], 73: [], 74: [], 79: [] };
  assert.deepEqual(find(run(nothing, levelsFor(nothing, { [thunder]: 0 })), '벼락 난사').baseLevel, 0);
  // No table, no ids or no skill flag: nothing is level-based.
  for (const none of [run(threeBoards, levelsFor(threeBoards), { tables: undefined }), run(threeBoards, levelsFor(threeBoards), { tables: { levels: tables.levels } }),
    run(threeBoards, levelsFor(threeBoards), { tables: { ids: tables.ids } }), run(threeBoards, levelsFor(threeBoards), { flags: 1 }), run(threeBoards, [])]) {
    assert.deepEqual([none.skills.length, none.fallbacks.length], [0, 22]);
  }
  // In the model a fallback skill is a fixed-rule node again and a levelled one follows its sequence.
  const problem = optimizer.createProblem(partial.boards, values, { skills: Object.fromEntries(partial.skills.map(skill => [skill.key, skill.values])) });
  assert.equal(problem.skills.length, 17);
  const nodeOf = name => problem.nodes.find(node => node.key === recorded.get(name).key);
  assert.deepEqual([nodeOf('벼락 난사').skill, nodeOf('벼락 난사').power, nodeOf('주신의 은총').skill, nodeOf('주신의 은총').power], [-1, 100, -1, 200]);
  assert.ok(nodeOf('고통의 연쇄').skill >= 0);
});

test('without an import the page uses the bundled data exactly as generated', () => {
  const items = new Map();
  const { window, session, location } = page(items);
  for (const name of ['DAEVANION_BOARDS', 'DAEVANION_SKILL_VALUES', 'DAEVANION_ALL_POWER_PLAN', 'DAEVANION_POWER_PLANS', 'DAEVANION_MEASUREMENTS', 'DAEVANION_OPTIONS']) {
    assert.deepEqual(plain(window[name]), bundled[name], name);
  }
  assert.deepEqual([session.summary, session.fresh, session.error, session.describe()], [null, false, '', '']);
  assert.equal(window.DAEVANION_SESSION_SUFFIX, undefined);
  assert.equal(window.DAEVANION_SKILL_FALLBACKS, undefined);
  assert.equal(window.DaevanionPlanner.STORAGE_KEY, STATE);
  assert.equal(items.size, 0);
  assert.equal(location.replaced, undefined);
  // A board tab in the fragment is not a link.
  assert.equal(page(items, { hash: '#72' }).session.summary, null);
  assert.equal(items.size, 0);
  // The default model is the one the bundled plan was solved for, 22 level sequences included.
  const skills = Object.fromEntries(bundled.DAEVANION_SKILL_VALUES.map(skill => [skill.key, skill.values]));
  const problem = optimizer.createProblem(boards, values, { skills });
  const plan = bundled.DAEVANION_ALL_POWER_PLAN;
  assert.equal(optimizer.validate(problem, Object.fromEntries(Object.entries(plan.boards).map(([id, item]) => [id, item.nodeIds]))).power, plan.power);
  // Importing the very state the bundle describes gives the same model, down to the signature.
  const same = link.prepare(boards, link.decode(encode({ boards: sent(sourceLayout), skills: levelsFor(sourceLayout) })), tables);
  assert.equal(optimizer.createProblem(same.boards, values, { skills: Object.fromEntries(same.skills.map(skill => [skill.key, skill.values])) }).signature, problem.signature);
});

test('opening a link imports it once, removes the fragment and survives a reload', () => {
  const items = new Map();
  const { window, session, location } = page(items, { hash: `#link=${REAL}` });
  assert.deepEqual([session.fresh, session.error], [true, '']);
  assert.deepEqual([location.hash, location.replaced], ['', '/index.html?boardId=72']);
  assert.deepEqual([...items.keys()].sort(), [LINK, `${STATE}:link`].sort());
  const record = saved(items, LINK);
  assert.deepEqual([record.version, record.data], [1, REAL]);
  assert.ok(Number.isInteger(record.importedAt) && Math.abs(record.importedAt - Date.now() / 1000) < 60);
  // The five boards of the planner; boards 75~78 of the link are not used.
  const imported = plain(window.DAEVANION_BOARDS);
  assert.deepEqual(imported.map(item => [item.id, item.open]), [[71, 0], [72, 150], [73, 151], [74, 152], [79, 152]]);
  const summary = plain(session.summary);
  assert.deepEqual(summary.counts, { 71: 0, 72: 150, 73: 151, 74: 152, 79: 152 });
  assert.deepEqual(summary.ignoredBoards, [75, 76, 77, 78]);
  assert.deepEqual([summary.capturedAt, summary.power, summary.bestPower, summary.cost, summary.budget], [1794554976, 975724, 1019394, 828, 837]);
  const state = saved(items, `${STATE}:link`);
  assert.deepEqual(state.boards, opened(imported));
  assert.deepEqual(state.required, { 71: [], 72: [], 73: [], 74: [], 79: [] });
  assert.equal(window.DaevanionPlanner.STORAGE_KEY, `${STATE}:link`);
  assert.equal(window.DAEVANION_SESSION_SUFFIX, ':link');
  // The trained levels did not change during the day, so every base level is the recorded one.
  const source = JSON.parse(read('boards/skill-values.json')).skills;
  const levelled = plain(window.DAEVANION_SKILL_VALUES);
  assert.equal(levelled.length, 22);
  for (const skill of source) {
    const found = levelled.find(item => item.name === skill.name);
    assert.deepEqual([found.baseLevel, found.values, found.unobservedLevels], [skill.baseLevel, skill.values, []], skill.name);
    assert.equal(found.skillId % 10000, 0);
  }
  const thunder = levelled.find(item => short(item.name) === '벼락 난사'), grace = levelled.find(item => short(item.name) === '주신의 은총');
  assert.deepEqual([thunder.level, thunder.opened, thunder.baseLevel, grace.level, grace.opened, grace.baseLevel], [6, 3, 3, 29, 2, 27]);
  assert.deepEqual(plain(window.DAEVANION_SKILL_FALLBACKS), []);
  assert.deepEqual([summary.skillTotal, summary.levelled, summary.unobserved, summary.fallbacks], [22, 22, 0, []]);
  // Until the recalculation the plan on the page is the imported layout itself, waiting for the full budget.
  const plan = plain(window.DAEVANION_ALL_POWER_PLAN);
  assert.deepEqual([plan.cost, plan.budget, plan.pending, plan.optimality.status, plan.powerDifference, plan.unknownCount], [828, 837, true, 'pending', 0, 0]);
  assert.deepEqual(Object.fromEntries(Object.entries(plan.boards).map(([id, item]) => [id, item.nodeIds])), state.boards);
  assert.deepEqual(plain(window.DAEVANION_POWER_PLANS), plan.boards);
  const skills = Object.fromEntries(levelled.map(skill => [skill.key, skill.values]));
  assert.equal(plan.power, optimizer.validate({ ...optimizer.createProblem(imported, values, { skills }), budget: 828 }, state.boards).power);
  // The notice: when, CP, nodes per board, skills.
  assert.equal(session.describe(), `기준 시각 ${link.stamp(1794554976)} · 전투력 975,724 (최고 1,019,394) · 열린 노드 네자칸 0개, 지켈 150개, 바이젤 151개, 트리니엘 152개, 루미엘 152개 (시작 노드 제외, 데바니온 828개) · 스킬 22종 중 22종을 현재 레벨로 계산`);
  const moment = new Date(1794554976 * 1000);
  assert.match(link.stamp(1794554976), /^2026-11-1[34] \d\d:\d\d$/);
  assert.ok(link.stamp(1794554976).endsWith(`:${String(moment.getMinutes()).padStart(2, '0')}`));
  // A reload reads the stored import: same state, nothing imported again, nothing rewritten.
  const before = new Map(items);
  const again = page(items);
  assert.deepEqual([again.session.fresh, again.session.error, plain(again.session.summary)], [false, '', summary]);
  assert.deepEqual(plain(again.window.DAEVANION_BOARDS), imported);
  assert.deepEqual(plain(again.window.DAEVANION_SKILL_VALUES), levelled);
  assert.deepEqual(items, before);
  // Another address form of the same link, opened later, imports again and counts as new.
  assert.equal(page(items, { hash: `#link=${REAL}&from=program` }).session.fresh, true);
  assert.equal(saved(items, LINK).data, REAL);
});

test('required nodes pinned beforehand stay pinned through imports and back, and the recalculation contains them', async () => {
  const items = new Map();
  const first = page(items);
  // Pins and an edit made while the bundled default is on screen.
  const pins = { 71: [], 72: [board(72).nodes.find(node => node.type === 'SkillLevel').nodeId], 73: [], 74: [], 79: [near(board(79), 40).at(-1), board(79).nodes.find(node => node.row === 1 && node.col === 15).nodeId].sort((a, b) => a - b) };
  const editing = new Planner(boards);
  for (const [id, ids] of Object.entries(pins)) for (const nodeId of ids) assert.equal(editing.setRequired(Number(id), nodeId, true).changed, true);
  assert.equal(editing.reset(71).ok, true);
  assert.equal(first.window.DaevanionPlanner.write(first.storage, editing), true);
  const defaultState = items.get(STATE);
  assert.deepEqual(JSON.parse(defaultState).required, pins);
  // The import starts from the imported layout and carries the pins over; the default state is not touched.
  const second = page(items, { hash: `#link=${REAL}` });
  assert.equal(second.session.fresh, true);
  const state = saved(items, `${STATE}:link`);
  assert.deepEqual(state.required, pins);
  assert.deepEqual(state.boards, opened(plain(second.window.DAEVANION_BOARDS)));
  assert.equal(items.get(STATE), defaultState);
  // What the page hands to the recalculation: the imported boards, the saved pins, the imported sequences.
  const planner = new Planner(plain(second.window.DAEVANION_BOARDS), plain(second.window.DaevanionPlanner.read(second.storage)));
  assert.equal(planner.requiredCount(), 3);
  assert.equal(planner.total, 837);
  const skills = Object.fromEntries(plain(second.window.DAEVANION_SKILL_VALUES).map(skill => [skill.key, skill.values]));
  const problem = optimizer.createProblem(plain(second.window.DAEVANION_BOARDS), values, { required: planner.snapshot().required, skills });
  assert.deepEqual(problem.required.map(index => problem.nodes[index].nodeId).sort((a, b) => a - b), Object.values(pins).flat().sort((a, b) => a - b));
  const solved = optimizer.solve(problem, await runtime, { candidates: [planner.snapshot().boards], seconds: 1 });
  const chosen = new Set(Object.values(solved.selections).flat());
  assert.ok(Object.values(pins).flat().every(nodeId => chosen.has(nodeId)));
  assert.equal(optimizer.validate(problem, solved.selections).cost, 837);
  assert.equal(planner.replaceAllBoards(solved.selections).ok, true);
  // A recalculated layout, a stored plan and changed pins, all made while the import is on screen.
  const extra = board(73).nodes.find(node => node.type === 'SkillLevel').nodeId;
  planner.setRequired(73, extra, true);
  planner.setRequired(72, pins[72][0], false);
  const later = { ...pins, 72: [], 73: [extra] };
  assert.equal(second.window.DaevanionPlanner.write(second.storage, planner), true);
  items.set(`${PLAN}:link`, JSON.stringify({ version: 1, solution: solved }));
  // A later import replaces the layout, drops the plan of the earlier one and keeps the pins as they are now.
  const smaller = { 71: near(board(71), 20), 72: near(board(72), 30), 73: [], 74: near(board(74), 3), 79: near(board(79), 60) };
  const third = page(items, { hash: `#link=${encode({ capturedAt: 1794560000, boards: sent(smaller), skills: levelsFor(smaller) })}` });
  assert.deepEqual([third.session.fresh, third.session.error], [true, '']);
  assert.deepEqual(saved(items, `${STATE}:link`), { version: 2, total: planningBudget(cost(smaller)), boards: smaller, required: later });
  assert.equal(items.has(`${PLAN}:link`), false);
  assert.equal(items.get(STATE), defaultState);
  // Back to the default: the import is gone, the pins come along, the default's own edit is still there.
  third.session.clear();
  assert.deepEqual([...items.keys()], [STATE]);
  const restored = saved(items, STATE);
  assert.deepEqual(restored.required, later);
  assert.deepEqual(restored.boards, JSON.parse(defaultState).boards);
  assert.deepEqual(restored.boards[71], []);
  const fourth = page(items);
  assert.deepEqual([fourth.session.summary, fourth.window.DaevanionPlanner.STORAGE_KEY], [null, STATE]);
  assert.deepEqual(plain(fourth.window.DAEVANION_BOARDS), boards);
  // And onto the next import again.
  page(items, { hash: `#link=${REAL}` });
  assert.deepEqual(saved(items, `${STATE}:link`).required, later);
});

test('a refused link, a failed write and a broken record leave the page on a state that works', () => {
  // Refused while the default is on screen: nothing stored, the fragment stays, the reason is given.
  const items = new Map([[STATE, JSON.stringify(new Planner(boards).snapshot())]]);
  const untouched = new Map(items);
  const incomplete = encode({ flags: 2, boards: sent(sourceLayout), skills: levelsFor(sourceLayout) });
  const refused = page(items, { hash: `#link=${incomplete}` });
  assert.deepEqual([refused.session.fresh, refused.session.summary], [false, null]);
  assert.match(refused.session.error, /^링크를 가져오지 못했습니다\. 링크에 보드 전체 정보가 없습니다\..* 기본 보드를 그대로 표시합니다\.$/);
  assert.equal(refused.location.hash, `#link=${incomplete}`);
  assert.deepEqual(items, untouched);
  assert.deepEqual(plain(refused.window.DAEVANION_BOARDS), boards);
  assert.equal(refused.window.DaevanionPlanner.STORAGE_KEY, STATE);
  for (const [bad, message] of [['RFYB', /너무 짧습니다/], [encode({ boards: { 71: [113] } }), /보드가 없습니다/], [`${REAL.slice(0, -4)}`, /스킬 목록 길이/], ['', /길이/]]) {
    const result = page(items, { hash: `#link=${bad}` });
    assert.match(result.session.error, message);
    assert.deepEqual(items, untouched);
  }
  // Refused while an import is on screen: that import stays.
  page(items, { hash: `#link=${REAL}` });
  const imported = new Map(items);
  const kept = page(items, { hash: `#link=${incomplete}` });
  assert.match(kept.session.error, /이전에 가져온 상태를 그대로 표시합니다\.$/);
  assert.deepEqual([kept.session.fresh, kept.session.summary.cost], [false, 828]);
  assert.deepEqual(items, imported);
  // A write that fails halfway is undone.
  const fresh = new Map(untouched);
  let writes = 0;
  const failing = { getItem: key => fresh.get(key) ?? null, removeItem: key => { fresh.delete(key); },
    setItem: (key, value) => { if (++writes === 2) throw new Error('quota'); fresh.set(key, value); } };
  const failed = page(fresh, { hash: `#link=${REAL}`, storage: failing });
  assert.match(failed.session.error, /가져온 상태를 보관하지 못했습니다/);
  assert.deepEqual([failed.session.fresh, failed.session.summary], [false, null]);
  assert.deepEqual(fresh, untouched);
  // A stored import that can no longer be read is dropped, its pins moved to the default state.
  const pinned = saved(items, `${STATE}:link`);
  pinned.required[79] = [board(79).nodes.find(node => node.row === 1 && node.col === 1).nodeId];
  items.set(`${STATE}:link`, JSON.stringify(pinned));
  for (const broken of ['{', JSON.stringify({ version: 2, data: REAL }), JSON.stringify({ version: 1, data: 'RFYB' }), JSON.stringify({ version: 1, data: incomplete })]) {
    const store = new Map(items).set(LINK, broken);
    const result = page(store);
    assert.match(result.session.error, /보관된 가져오기 상태를 읽을 수 없어 지웠습니다/);
    assert.equal(result.session.summary, null);
    assert.deepEqual([...store.keys()], [STATE]);
    assert.deepEqual(saved(store, STATE).required, pinned.required);
    assert.deepEqual(plain(result.window.DAEVANION_BOARDS), boards);
    assert.equal(page(store).session.error, '');
  }
});

test('state saved by the removed character search does not break the page; its pins are adopted once', () => {
  const SESSION = 'daevanion-character-session:v1';
  const character = { characterId: 'AVjAApO77vZ9AnoMquwqdsIrxzd1bHPmsLfhjT_VnvM=', name: '힐피', race: 1, serverId: 1003 };
  const own = `${STATE}:character:1003:${character.characterId}`;
  const record = offset => JSON.stringify({ version: 1, character, rawBoards: Object.fromEntries(boards.map(item => [item.id, { sourceBoardId: item.id + offset, nodeList: [] }])) });
  const defaults = new Planner(boards);
  defaults.setRequired(71, near(board(71), 3)[0], true);
  defaults.reset(74);
  const searched = new Planner(boards);
  const pin = board(79).nodes.find(node => node.row === 15 && node.col === 15).nodeId;
  searched.setRequired(79, pin, true);
  const searchedState = JSON.stringify({ ...searched.snapshot(), required: { ...searched.snapshot().required, 72: [999999, 720113] } });
  const seed = offset => new Map([[STATE, JSON.stringify(defaults.snapshot())], [SESSION, record(offset)], [own, searchedState], [`${PLAN}:character:1003:${character.characterId}`, 'old plan']]);
  // The searched character had these boards: its pins were the ones on screen, so they become the default's.
  const items = seed(0);
  const result = page(items);
  assert.deepEqual([result.session.error, result.session.summary], ['', null]);
  assert.deepEqual(plain(result.window.DAEVANION_BOARDS), boards);
  assert.equal(result.window.DAEVANION_CHARACTER, undefined);
  assert.equal(result.window.DaevanionPlanner.STORAGE_KEY, STATE);
  assert.equal(items.has(SESSION), false);
  assert.deepEqual(saved(items, STATE).required, { 71: [], 72: [], 73: [], 74: [], 79: [pin] });
  assert.deepEqual(saved(items, STATE).boards, defaults.snapshot().boards);
  // Its own layout and plan are not read any more; they are left where they were.
  assert.equal(items.get(own), searchedState);
  assert.equal(items.get(`${PLAN}:character:1003:${character.characterId}`), 'old plan');
  // Once only: later changes to the default pins are not overwritten again.
  const after = new Map(items);
  page(items);
  assert.deepEqual(items, after);
  // The adopted pins go into the next import like any others.
  page(items, { hash: `#link=${REAL}` });
  assert.deepEqual(saved(items, `${STATE}:link`).required[79], [pin]);
  // A character of another class had other boards: nothing is adopted, the record still goes.
  const other = seed(10);
  assert.equal(page(other).session.error, '');
  assert.equal(other.has(SESSION), false);
  assert.equal(other.get(STATE), JSON.stringify(defaults.snapshot()));
  // An unreadable record or a missing per-character state is dropped without touching anything else.
  for (const broken of ['{', 'null', JSON.stringify({ version: 1 })]) {
    const store = seed(0).set(SESSION, broken);
    assert.equal(page(store).session.error, '');
    assert.equal(store.has(SESSION), false);
    assert.equal(store.get(STATE), JSON.stringify(defaults.snapshot()));
  }
  const lone = seed(0);
  lone.delete(own);
  page(lone);
  assert.deepEqual([lone.has(SESSION), lone.get(STATE)], [false, JSON.stringify(defaults.snapshot())]);
});

test('a board page draws the imported layout from its own data and never imports a link itself', () => {
  const raw = JSON.parse(read('boards/72.json'));
  const element = { textContent: JSON.stringify(raw) };
  const items = new Map();
  // A link in the address of a board page is left alone.
  const ignored = page(items, { hash: `#link=${REAL}`, element });
  assert.deepEqual([ignored.session.summary, ignored.location.hash, items.size], [null, `#link=${REAL}`, 0]);
  assert.deepEqual(JSON.parse(element.textContent), raw);
  page(items, { hash: `#link=${REAL}` });
  const imported = page(items, { element });
  const open = new Set(saved(items, `${STATE}:link`).boards[72]);
  assert.equal(open.size, 150);
  const drawn = JSON.parse(element.textContent).nodeList;
  assert.equal(drawn.length, 225);
  for (const [index, node] of drawn.entries()) {
    const original = raw.nodeList[index];
    assert.deepEqual(node, ['None', 'Start'].includes(original.type) ? original : { ...original, open: open.has(original.nodeId) ? 1 : 0 });
  }
  assert.equal(imported.window.DaevanionPlanner.STORAGE_KEY, `${STATE}:link`);
  assert.equal(imported.session.summary.counts[72], 150);
});

test('the pages load the link scripts where the search used to be and the deployment serves files only', () => {
  const index = read('index.html');
  const scripts = [...index.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]);
  const position = file => { const at = scripts.indexOf(file); assert.ok(at >= 0, file); return at; };
  // The session replaces the bundled globals, so it follows everything it reads and precedes everything that reads them.
  for (const earlier of ['boards/manifest.js', 'assets/planner.js', 'boards/power-plan.js', 'boards/measurements.js', 'boards/skill-values.js', 'boards/skill-tables.js', 'assets/optimizer.js', 'assets/link-model.js']) {
    assert.ok(position(earlier) < position('assets/link-session.js'), earlier);
  }
  for (const later of ['assets/options-table.js', 'assets/index.js']) assert.ok(position('assets/link-session.js') < position(later), later);
  for (const id of ['link-status', 'link-error', 'link-reset']) assert.ok(index.includes(`id="${id}"`), id);
  for (const file of ['Nezkhan.html', 'Zikel.html', 'Vaizel.html', 'Triniel.html', 'Lumiel.html', 'scripts/board-template.html']) {
    const html = read(file);
    assert.ok(html.indexOf('assets/planner.js') < html.indexOf('assets/link-model.js') && html.indexOf('assets/link-model.js') < html.indexOf('assets/link-session.js')
      && html.indexOf('assets/link-session.js') < html.indexOf('assets/board.js'), file);
  }
  for (const file of ['index.html', 'Nezkhan.html', 'scripts/board-template.html', 'assets/index.js', 'assets/board.js', 'assets/styles.css']) assert.ok(!/character-(search|session|model)|DaevanionCharacter/.test(read(file)), file);
  for (const gone of ['assets/character-search.js', 'assets/character-session.js', 'assets/character-model.js', 'worker/index.mjs']) assert.equal(fs.existsSync(path.join(__dirname, '..', gone)), false, gone);
  // No Worker script and nothing that needs one: every request is answered from the built files.
  const wrangler = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(Object.keys(wrangler).sort(), ['$schema', 'assets', 'build', 'compatibility_date', 'name']);
  assert.deepEqual([wrangler.name, wrangler.assets.directory, wrangler.assets.binding, wrangler.assets.run_worker_first], ['daevanion', './dist', undefined, undefined]);
});
