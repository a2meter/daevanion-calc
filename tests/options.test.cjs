const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { prepare, normalize, seed, merge, efficiency, rank, validPower } = require('../assets/options-model.js');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../boards/options.js'), 'utf8'), context);
const groups = JSON.parse(JSON.stringify(context.window.DAEVANION_OPTIONS));
const options = prepare(groups);
const find = (name, grade) => options.find(option => option.name === name && option.grade === grade);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../boards/measurements.js'), 'utf8'), context);
const observations = JSON.parse(JSON.stringify(context.window.DAEVANION_MEASUREMENTS));

test('all 760 nodes are represented exactly once in the 48 grouped options', () => {
  const expected = new Map();
  for (const board of [71, 72, 73, 74, 79]) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, `../boards/${board}.json`), 'utf8'));
    for (const node of data.nodeList) {
      if (['None', 'Start'].includes(node.type)) continue;
      const effects = node.effectList.map(effect => effect.desc).filter(Boolean);
      const key = JSON.stringify([node.grade, node.type, node.name, effects]);
      if (!expected.has(key)) expected.set(key, { 71: 0, 72: 0, 73: 0, 74: 0, 79: 0 });
      expected.get(key)[board]++;
    }
  }
  assert.equal(options.length, 48);
  assert.equal(expected.size, options.length);
  for (const option of options) assert.deepEqual(option.counts, expected.get(option.key));
  assert.equal(options.reduce((sum, option) => sum + option.total, 0), 760);
  for (const board of [71, 72, 73, 74, 79]) {
    assert.equal(options.reduce((sum, option) => sum + option.counts[board], 0), 152);
  }
  assert.deepEqual(['Common', 'Rare', 'Legend', 'Unique'].map(grade =>
    options.filter(option => option.grade === grade).length), [6, 14, 14, 14]);
});

test('different grades and amounts remain separate options with their own costs', () => {
  const common = find('공격력', 'Common');
  const unique = find('추가 공격력', 'Unique');
  assert.deepEqual(common.effects, ['추가 공격력 +5']);
  assert.deepEqual(unique.effects, ['추가 공격력 +50']);
  assert.equal(common.cost, 1);
  assert.equal(unique.cost, 4);
  assert.equal(common.total, 103);
  assert.equal(unique.total, 2);
  assert.deepEqual(['Common', 'Rare', 'Legend', 'Unique'].map(grade => options.find(option => option.grade === grade).cost), [1, 2, 3, 4]);
  assert.deepEqual(find('치명타 피해 증폭', 'Unique').counts, { 71: 0, 72: 0, 73: 4, 74: 0, 79: 0 });
});

test('power and per-currency efficiency can rank different options highest', () => {
  const common = find('공격력', 'Common');
  const unique = find('추가 공격력', 'Unique');
  const values = { [common.key]: 100, [unique.key]: 200 };
  assert.equal(rank(options, values, 'power')[0].key, unique.key);
  assert.equal(rank(options, values, 'efficiency')[0].key, common.key);
  assert.equal(efficiency(unique, values[unique.key]), 50);
  assert.equal(efficiency(unique, 25.5), 6.375);
});

test('zero is measured and always ranks before unknown values', () => {
  const option = find('공격력', 'Common');
  const values = { [option.key]: 0 };
  assert.equal(rank(options, values, 'power')[0].key, option.key);
  assert.equal(rank(options, values, 'efficiency')[0].key, option.key);
  assert.equal(efficiency(option, 0), 0);
  assert.equal(efficiency(option, undefined), null);
});

test('only valid known measurement values survive restoration', () => {
  const values = { [options[0].key]: 0, [options[1].key]: 12.5,
    [options[2].key]: -1, [options[3].key]: Infinity, [options[4].key]: '50',
    [options[5].key]: Number.MAX_SAFE_INTEGER + 1, stale: 200 };
  assert.deepEqual(normalize(values, options), { [options[0].key]: 0, [options[1].key]: 12.5 });
  assert.deepEqual(normalize(null, options), {});
  for (const value of [null, undefined, NaN, -1, Infinity, '0']) assert.equal(validPower(value), false);
});

test('sorting is numeric, deterministic and does not mutate source rows', () => {
  const original = options.map(option => option.key);
  const values = { [options[0].key]: 9, [options[1].key]: 100 };
  assert.equal(rank(options, values, 'power')[0].key, options[1].key);
  assert.deepEqual(rank(options, {}, 'power'), rank(options, {}, 'default'));
  assert.deepEqual(options.map(option => option.key), original);
});

test('measurement patches preserve other options and support deletion and undo', () => {
  const first = options[0].key;
  const second = options[1].key;
  const latest = { [first]: 100, [second]: 200 };
  const updated = merge(latest, { [first]: 150 }, options);
  assert.deepEqual(updated, { [first]: 150, [second]: 200 });
  const cleared = merge(updated, { [first]: null }, options);
  assert.deepEqual(cleared, { [second]: 200 });
  assert.deepEqual(merge(cleared, { [first]: 150 }, options), updated);
  assert.deepEqual(merge(latest, { [first]: -1, unknown: 999 }, options), latest);
});

test('reported attack observation records exactly 439 power without extrapolating to other amounts', () => {
  const observation = observations.find(item => item.id === '2026-11-02-attack-5-01');
  const common = find('공격력', 'Common');
  const unique = find('추가 공격력', 'Unique');
  assert.equal(observation.before, 990034);
  assert.equal(observation.after, 989595);
  assert.equal(observation.power, (990034 - 989595) / observation.nodeCount);
  const initial = seed(null, [observation], options);
  assert.equal(initial.values[common.key], 439);
  assert.equal(efficiency(common, initial.values[common.key]), 439);
  assert.equal(initial.values[unique.key], undefined);
  assert.equal(Object.keys(initial.values).length, 1);
});

test('critical observation uses the restored 990034 baseline and preserves the attack measurement', () => {
  const attack = observations.find(item => item.id === '2026-11-02-attack-5-01');
  const critical = observations.find(item => item.id === '2026-11-02-critical-10-01');
  const attackOption = find('공격력', 'Common');
  const criticalOption = find('치명타', 'Common');
  assert.equal(critical.before, 990034);
  assert.equal(critical.after, 989922);
  assert.equal(critical.nodeCount, 1);
  assert.equal(critical.power, 112);
  const previous = seed(null, [attack], options);
  const updated = seed(previous, observations, options);
  assert.equal(updated.values[attackOption.key], 439);
  assert.equal(updated.values[criticalOption.key], 112);
  assert.equal(efficiency(criticalOption, updated.values[criticalOption.key]), 112);
  const historical = seed(previous, [attack, critical], options);
  assert.equal(historical.values[find('치명타 피해 증폭', 'Unique').key], undefined);
});

test('new observations override only their own option once, preserving later manual edits and clears', () => {
  const common = find('공격력', 'Common');
  const defense = find('방어력', 'Common');
  const attackObservations = observations.filter(item => item.id === '2026-11-02-attack-5-01');
  const initial = seed({ version: 1, values: { [common.key]: 100, [defense.key]: 200 } }, attackObservations, options);
  assert.equal(initial.changed, true);
  assert.equal(initial.values[common.key], 439);
  assert.equal(initial.values[defense.key], 200);
  const edited = seed({ ...initial, values: { ...initial.values, [common.key]: 450 } }, attackObservations, options);
  assert.equal(edited.changed, false);
  assert.equal(edited.values[common.key], 450);
  const cleared = seed({ ...initial, values: {} }, attackObservations, options);
  assert.equal(cleared.changed, false);
  assert.deepEqual(cleared.values, {});
  const next = { ...attackObservations[0], id: 'next-record', power: 440 };
  const updated = seed(edited, [...attackObservations, next], options);
  assert.equal(updated.values[common.key], 440);
  assert.equal(updated.values[defense.key], 200);
});

test('defense uses the critical-removed baseline and records only the incremental 93 CP', () => {
  const defense = observations.find(item => item.id === '2026-11-02-defense-50-01');
  const critical = observations.find(item => item.id === '2026-11-02-critical-10-01');
  const defenseOption = find('방어력', 'Common');
  assert.equal(defense.before, critical.after);
  assert.equal(defense.before, 989922);
  assert.equal(defense.after, 989829);
  assert.equal(defense.power, 93);
  assert.notEqual(defense.power, 990034 - defense.after);
  const previous = seed(null, observations.filter(item => item.id !== defense.id), options);
  const updated = seed(previous, observations, options);
  assert.equal(updated.values[find('공격력', 'Common').key], 439);
  assert.equal(updated.values[find('치명타', 'Common').key], 112);
  assert.equal(updated.values[defenseOption.key], 93);
  assert.equal(efficiency(defenseOption, updated.values[defenseOption.key]), 93);
  assert.equal(previous.values[defenseOption.key], undefined);
});

test('Nezkhan attack remeasurement follows the three-node removal sequence and remains 439 CP', () => {
  const repeated = observations.find(item => item.id === '2026-11-02-attack-5-02');
  const first = observations.find(item => item.id === '2026-11-02-attack-5-01');
  const defense = observations.find(item => item.id === '2026-11-02-defense-50-01');
  assert.equal(repeated.boardId, 71);
  assert.equal(repeated.before, defense.after);
  assert.equal(repeated.before, 989829);
  assert.equal(repeated.after, 989390);
  assert.equal(repeated.power, 439);
  assert.equal(repeated.power, first.power);
  const previous = seed(null, observations.filter(item => item.id !== repeated.id), options);
  const updated = seed(previous, observations, options);
  assert.equal(updated.values[find('공격력', 'Common').key], 439);
  assert.equal(updated.values[find('치명타', 'Common').key], 112);
  assert.equal(updated.values[find('방어력', 'Common').key], 93);
  const historical = seed(null, observations.slice(0, observations.indexOf(repeated) + 1), options);
  assert.equal(Object.keys(historical.values).length, 3);
  assert.equal(990034 - repeated.after, 439 + 112 + 93);
});

test('reported observations and fixed skill rules produce all 48 option values with explicit composite estimates', () => {
  const recorded = seed(null, observations, options).values;
  assert.equal(Object.keys(recorded).length, 48);
  const expected = [
    ['공격력', 'Common', 439], ['치명타', 'Common', 112], ['방어력', 'Common', 93], ['치명타 저항', 'Common', 10],
    ['최대 정신력', 'Common', 14], ['최대 생명력', 'Common', 24],
    ['스킬 레벨 상승 - 벼락 난사', 'Legend', 100], ['추가 방어력', 'Unique', 982],
    ['스킬 레벨 상승 - 따뜻한 가호', 'Rare', 200], ['추가 공격력', 'Unique', 4458],
    ['전투 속도', 'Unique', 4050], ['스킬 레벨 상승 - 치유력 강화', 'Rare', 200],
    ['재시전 시간 감소', 'Unique', 750], ['피해 내성', 'Unique', 2442], ['회피', 'Unique', 80],
    ['피해 증폭', 'Unique', 5100], ['명중', 'Unique', 696],
    ['치명타 피해 내성', 'Unique', 1218], ['치명타 피해 증폭', 'Unique', 2460],
    ['다단 히트 적중', 'Unique', 1215], ['다단 히트 저항', 'Unique', 90],
    ['공격력 증가', 'Unique', 5937], ['방어력 증가', 'Unique', 736], ['방어력, 치명타', 'Rare', 180],
    ['철벽', 'Legend', 111], ['명중, 회피', 'Rare', 92], ['최대 생명력 증가', 'Rare', 56],
    ['재생', 'Legend', 54], ['막기 관통, 막기', 'Rare', 48]
  ];
  for (const [name, grade, power] of expected) assert.equal(recorded[find(name, grade).key], power);
  for (const record of observations.filter(item => item.basis === 'inferred')) {
    assert.equal(record.power, record.before - record.after - record.excludedPower);
    assert.ok(record.excludedPower > 0);
    if (record.adjustments) {
      const excluded = record.adjustments.reduce((sum, adjustment) => {
        const reference = observations.find(item => item.id === adjustment.observationId);
        return sum + reference.power * adjustment.nodeCount * (adjustment.operation === record.operation ? 1 : -1);
      }, 0);
      assert.equal(excluded, record.excludedPower);
    } else assert.equal(observations.find(item => item.id === record.excludedObservationId).power, record.excludedPower);
  }
  const sorted = rank(options, recorded, 'power').slice(0, 5).map(option => recorded[option.key]);
  assert.deepEqual(sorted, [5937, 5100, 4458, 4050, 2460]);
});

test('Zikel composite removal excludes evasion loss and mana gain, and resistance remeasurement agrees', () => {
  const damage = observations.find(item => item.id === '2026-11-02-damage-amplification-inferred-01');
  assert.equal(damage.before - damage.after, 5166);
  assert.equal(damage.excludedPower, 80 - 14);
  assert.equal(damage.power, 5100);
  assert.equal(efficiency(find('피해 증폭', 'Unique'), damage.power), 1275);
  const resistance = observations.filter(item => item.grade === 'Unique' && item.effects?.[0] === '피해 내성 +5%');
  assert.deepEqual(resistance.map(item => item.power), [2442, 2442]);
  assert.equal(seed(null, observations, options).values[find('회피', 'Unique').key], 80);
});

test('every passive and active option retains its fixed value across edits, clears and reloads', () => {
  const initial = seed(null, observations, options);
  const cleared = seed({ ...initial, values: {} }, observations, options);
  const editable = find('공격력', 'Common');
  const overwritten = seed({ ...initial, values: Object.fromEntries(options.map(option => [option.key, 999])) }, observations, options);
  for (const option of options) {
    if (option.type !== 'SkillLevel' || !['Rare', 'Legend'].includes(option.grade)) continue;
    const expected = option.grade === 'Rare' ? 200 : 100;
    assert.equal(initial.values[option.key], expected);
    assert.equal(cleared.values[option.key], expected);
    assert.equal(overwritten.values[option.key], expected);
  }
  assert.equal(Object.keys(cleared.values).length, 22);
  assert.equal(cleared.values[editable.key], undefined);
  assert.equal(overwritten.values[editable.key], 999);
  assert.equal(seed(cleared, observations, options).changed, false);
});
