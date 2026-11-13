'use strict';

((scope) => {
  const { COSTS } = typeof module !== 'undefined' && module.exports
    ? require('./planner.js') : scope.DaevanionPlanner;
  const GRADES = ['Common', 'Rare', 'Legend', 'Unique'];
  const STORAGE_KEY = 'daevanion-option-measurements:v1';

  function prepare(groups) {
    return groups.map(group => {
      if (!COSTS[group.grade]) throw new Error('옵션 등급의 소모량을 확인할 수 없습니다.');
      return { ...group, cost: COSTS[group.grade],
        total: Object.values(group.counts).reduce((sum, count) => sum + count, 0) };
    });
  }

  function validPower(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  }

  function normalize(values, options) {
    const result = {};
    for (const option of options) {
      if (validPower(values?.[option.key])) result[option.key] = values[option.key];
    }
    return result;
  }

  function efficiency(option, power) { return validPower(power) ? power / option.cost : null; }

  // A levelled skill has no single per-node value: each further node of it is
  // worth the next value of its sequence. Its average stands in wherever options
  // are ranked or compared per point.
  function levelAverages(skills, options) {
    const known = new Set(options.map(option => option.key)), result = {};
    for (const skill of Array.isArray(skills) ? skills : []) {
      if (!known.has(skill?.key) || !Array.isArray(skill.values) || !skill.values.length || !skill.values.every(validPower)) continue;
      result[skill.key] = skill.values.reduce((sum, value) => sum + value, 0) / skill.values.length;
    }
    return result;
  }

  // Averages of many samples are shown to one decimal place; calculations keep the full value.
  function rounded(value) { return Math.round(value * 10) / 10; }

  function seed(saved, observations, options) {
    const validSaved = saved?.version === 1;
    const values = normalize(validSaved ? saved.values : null, options);
    const applied = new Set(validSaved && Array.isArray(saved.appliedObservations)
      ? saved.appliedObservations.filter(id => typeof id === 'string') : []);
    const known = new Set(options.map(option => option.key));
    let changed = false;
    for (const observation of observations) {
      if (typeof observation.id !== 'string' || !observation.id
        || !known.has(observation.key) || !validPower(observation.power)) continue;
      if (observation.basis === 'fixed') {
        if (!applied.has(observation.id) || values[observation.key] !== observation.power) changed = true;
        values[observation.key] = observation.power;
        applied.add(observation.id);
        continue;
      }
      if (applied.has(observation.id)) continue;
      values[observation.key] = observation.power;
      applied.add(observation.id);
      changed = true;
    }
    return { version: 1, values, appliedObservations: [...applied], changed };
  }

  function merge(values, changes, options) {
    const result = normalize(values, options);
    for (const option of options) {
      const value = changes[option.key];
      if (value === null) delete result[option.key];
      else if (validPower(value)) result[option.key] = value;
    }
    return result;
  }

  function compareBase(a, b) {
    return GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade)
      || a.name.localeCompare(b.name, 'ko') || a.key.localeCompare(b.key, 'ko');
  }

  function rank(options, values, mode = 'default') {
    return [...options].sort((a, b) => {
      if (mode === 'power' || mode === 'efficiency') {
        const first = values[a.key];
        const second = values[b.key];
        const aValid = validPower(first);
        const bValid = validPower(second);
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid) {
          const difference = mode === 'power' ? second - first
            : efficiency(b, second) - efficiency(a, first);
          if (difference) return difference;
        }
      }
      return compareBase(a, b);
    });
  }

  const api = { STORAGE_KEY, GRADES, prepare, validPower, normalize, seed, merge, efficiency, levelAverages, rounded, rank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionOptions = api;
})(typeof window !== 'undefined' ? window : globalThis);
