'use strict';

(() => {
  const model = window.DaevanionOptions;
  const options = model.prepare(window.DAEVANION_OPTIONS);
  const boards = window.DAEVANION_BOARDS;
  for (const header of document.querySelectorAll('[data-board-column]')) {
    header.hidden = !boards.some(b => b.id === Number(header.dataset.boardColumn));
  }
  const gradeNames = { Common: '일반 스탯', Rare: '패시브 스킬', Legend: '액티브 스킬', Unique: '특수 스탯' };
  const gradeLabel = option => option.type === 'Stat' && option.grade === 'Rare' ? '희귀 스탯'
    : option.type === 'Stat' && option.grade === 'Legend' ? '전설 스탯' : gradeNames[option.grade];
  const section = document.getElementById('option-comparison');
  const tbody = section.querySelector('tbody');
  const category = document.getElementById('option-category');
  const notice = document.getElementById('options-notice');
  const measured = document.getElementById('options-measured');
  const best = document.getElementById('options-best');
  const observations = window.DAEVANION_MEASUREMENTS || [];
  const fixedKeys = new Set(observations.filter(item => item.basis === 'fixed').map(item => item.key));
  let appliedObservations = [];
  let values = read();
  let sort = 'power';
  let localEdits = {};
  let pendingExternal = false;
  let lastCleared = null;
  const undo = document.getElementById('options-undo');
  const sortNames = { default: '분류순', power: '전투력순', efficiency: '소모량 대비순' };
  const format = number => number.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
  const displayName = option => option.name.replace(/^스킬 레벨 상승 - /, '');

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function read(fallback = {}) {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(model.STORAGE_KEY));
    } catch { saved = { version: 1, values: fallback, appliedObservations }; }
    const seeded = model.seed(saved, observations, options);
    appliedObservations = seeded.appliedObservations;
    if (seeded.changed) {
      try {
        localStorage.setItem(model.STORAGE_KEY, JSON.stringify({ version: 1, values: seeded.values, appliedObservations }));
      } catch { /* Use the recorded values in memory. */ }
    }
    return seeded.values;
  }

  function save(changes) {
    Object.assign(localEdits, changes);
    values = model.merge(read(values), localEdits, options);
    try {
      localStorage.setItem(model.STORAGE_KEY, JSON.stringify({ version: 1, values, appliedObservations }));
      localEdits = {};
    } catch { /* Keep unsaved edits in memory. */ }
    window.dispatchEvent(new Event('daevanion:measurements-changed'));
  }

  function summarize() {
    measured.textContent = `전투력 확인 ${Object.keys(values).length} / ${options.length}종`;
    const winner = model.rank(options, values, 'efficiency').find(option => model.validPower(values[option.key]));
    const ties = winner ? options.filter(option => model.efficiency(option, values[option.key]) === model.efficiency(winner, values[winner.key])).length : 0;
    best.textContent = winner
      ? `확인한 옵션 중 최고 효율: ${displayName(winner)}${ties > 1 ? ` 외 ${ties - 1}종 (동률)` : ''} · 데바니온 1개당 ${format(model.efficiency(winner, values[winner.key]))}`
      : '전투력 상승량을 입력하면 옵션별 효율을 비교할 수 있습니다.';
  }

  function render() {
    if (pendingExternal) values = model.merge(read(values), localEdits, options);
    pendingExternal = false;
    const visible = model.rank(options.filter(option => !category.value || option.grade === category.value), values, sort);
    const fragment = document.createDocumentFragment();
    for (const option of visible) {
      const row = make('tr');
      row.dataset.optionKey = option.key;
      const name = make('th', 'option-name', displayName(option));
      name.scope = 'row';
      const grade = make('td');
      grade.append(make('span', `option-grade option-grade-${option.grade.toLowerCase()}`, gradeLabel(option)));
      const effect = make('td', 'option-effect', option.effects.join(' / '));
      row.append(name, grade, effect, make('td', 'number', `${option.cost}개`));
      for (const board of boards) row.append(make('td', 'number option-count', option.counts[board.id]));
      row.append(make('td', 'number option-count-total', option.total));
      const pinCell = make('td', 'number option-required');
      const pin = make('button', 'option-required-toggle');
      pin.type = 'button';
      pin.dataset.requiredOption = option.key;
      pin.addEventListener('click', () => {
        const result = window.DaevanionRequired?.toggleOption(option.key);
        if (result) notice.textContent = result.message;
      });
      pinCell.append(pin);
      row.append(pinCell);
      const measurement = make('td', 'option-measurement');
      const input = make('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(Number.MAX_SAFE_INTEGER);
      input.step = 'any';
      input.inputMode = 'decimal';
      input.placeholder = '미측정';
      input.value = values[option.key] ?? '';
      input.setAttribute('aria-label', `${displayName(option)} ${gradeLabel(option)} 노드 1개 전투력 상승량`);
      const recorded = observations.filter(item => item.key === option.key).at(-1);
      input.readOnly = fixedKeys.has(option.key);
      if (['inferred', 'fixed'].includes(recorded?.basis) && values[option.key] === recorded.power) {
        const label = make('span', 'measurement-basis', recorded.basis === 'fixed' ? '고정값' : '추정값');
        label.title = recorded.note;
        measurement.append(label);
      }
      const ratio = make('td', 'number option-efficiency');
      const updateRatio = () => {
        const value = model.efficiency(option, values[option.key]);
        ratio.textContent = value === null ? '—' : format(value);
      };
      input.addEventListener('input', () => {
        if (input.validity.badInput) {
          input.setAttribute('aria-invalid', 'true');
          notice.textContent = '유효한 수치를 입력하십시오. 기존 측정값은 유지됩니다.';
          return;
        }
        const value = input.value.trim() === '' ? null : Number(input.value);
        if (value !== null && !model.validPower(value)) {
          input.setAttribute('aria-invalid', 'true');
          notice.textContent = '전투력 상승량은 0 이상의 유효한 수치로 입력하십시오.';
          return;
        }
        input.removeAttribute('aria-invalid');
        save({ [option.key]: value });
        measurement.querySelector('.measurement-basis')?.remove();
        updateRatio();
        summarize();
        notice.textContent = '';
      });
      updateRatio();
      measurement.append(input);
      row.append(measurement, ratio);
      fragment.append(row);
    }
    tbody.replaceChildren(fragment);
    renderRequired();
    document.getElementById('options-visible').textContent = `${visible.length}종`;
    document.getElementById('options-sort-status').textContent = `마지막 정렬: ${sortNames[sort]}`;
    summarize();
  }

  // The planner owns the required nodes; this table only mirrors and toggles them per option.
  function renderRequired() {
    const required = window.DaevanionRequired;
    for (const pin of tbody.querySelectorAll('[data-required-option]')) {
      const option = options.find(item => item.key === pin.dataset.requiredOption);
      const count = required ? required.count(option.key) : 0;
      pin.disabled = !required;
      pin.textContent = `${count}/${option.total}`;
      pin.setAttribute('aria-pressed', String(count === option.total));
      pin.classList.toggle('is-partial', count > 0 && count < option.total);
      pin.setAttribute('aria-label', `${displayName(option)} ${gradeLabel(option)} 노드 ${option.total}개 중 ${count}개 재계산 필수 · ${count === option.total ? '모두 해제' : '모두 지정'}`);
    }
  }
  window.addEventListener('daevanion:required-changed', renderRequired);

  document.getElementById('options-total').textContent = `${options.length}종 · 노드 ${options.reduce((sum, option) => sum + option.total, 0)}개`;
  const totals = document.getElementById('options-node-totals');
  for (const board of boards) {
    totals.append(make('td', 'number', options.reduce((sum, option) => sum + option.counts[board.id], 0)));
  }
  totals.append(make('td', 'number', options.reduce((sum, option) => sum + option.total, 0)));
  const empty = make('td');
  empty.colSpan = 3;
  totals.append(empty);

  category.addEventListener('change', render);
  section.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    sort = button.dataset.sort;
    render();
    notice.textContent = `${button.textContent}으로 정렬했습니다.`;
  }));
  document.getElementById('options-clear').addEventListener('click', () => {
    const current = model.merge(read(values), localEdits, options);
    const editable = Object.fromEntries(Object.entries(current).filter(([key]) => !fixedKeys.has(key)));
    if (!Object.keys(editable).length) { notice.textContent = '초기화할 측정값이 없습니다.'; return; }
    lastCleared = editable;
    save(Object.fromEntries(options.filter(option => !fixedKeys.has(option.key)).map(option => [option.key, null])));
    render();
    undo.hidden = false;
    notice.textContent = '측정값을 초기화했습니다. 스킬 고정값은 유지됩니다.';
  });
  undo.addEventListener('click', () => {
    if (!lastCleared) return;
    const current = model.merge(read(values), localEdits, options);
    const changes = Object.fromEntries(Object.entries(lastCleared).filter(([key]) => !Object.hasOwn(current, key)));
    save(changes);
    lastCleared = null;
    undo.hidden = true;
    render();
    notice.textContent = '이전 측정값을 복원했습니다.';
  });
  tbody.addEventListener('focusout', () => {
    if (!pendingExternal) return;
    requestAnimationFrame(() => {
      if (!pendingExternal || tbody.contains(document.activeElement)) return;
      values = model.merge(read(values), localEdits, options);
      render();
    });
  });
  window.addEventListener('storage', event => {
    if (event.key !== model.STORAGE_KEY && event.key !== null) return;
    if (tbody.contains(document.activeElement)) {
      pendingExternal = true;
      window.dispatchEvent(new Event('daevanion:measurements-changed'));
      return;
    }
    values = model.merge(read(values), localEdits, options);
    render();
    window.dispatchEvent(new Event('daevanion:measurements-changed'));
  });
  window.DaevanionMeasurements = {
    getValues: () => model.merge(read(values), localEdits, options),
    hasInvalidInputs: () => [...tbody.querySelectorAll('input')].some(input => input.validity.badInput || input.getAttribute('aria-invalid') === 'true'),
  };
  render();
})();
