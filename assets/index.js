'use strict';

(() => {
  const boards = window.DAEVANION_BOARDS;
  const api = window.DaevanionPlanner;
  const saved = api.read();
  const planner = new api.Planner(boards, saved);
  if (saved?.version !== api.STATE_VERSION) api.write(undefined, planner);
  const tabs = [...document.querySelectorAll('[role="tab"]')].filter(tab => {
    const present = boards.some(b => b.id === Number(tab.dataset.board));
    tab.hidden = !present;
    return present;
  });
  const panel = document.getElementById('board-panel');
  let frame = document.getElementById('board-frame');
  const source = document.querySelector('.source-link');
  let activeId = null;
  const targetOrigin = location.protocol === 'file:' ? '*' : location.origin;
  const resources = window.DaevanionResources(document.querySelector('.resource-panel'), planner, applyAction);
  const optimizer = window.DaevanionOptimizer;
  const measurements = window.DaevanionMeasurements;
  const observations = window.DAEVANION_MEASUREMENTS;
  const originalPlan = window.DAEVANION_ALL_POWER_PLAN;
  const runtimeKey = `daevanion-recalculated-plan:v1${window.DAEVANION_SESSION_SUFFIX || ''}`;
  let allPlan = originalPlan;
  let powerPlans = allPlan.boards;
  let planValues = Object.fromEntries(observations.map(record => [record.key, record.power]));
  let planSignature = null;
  try { planSignature = optimizer.createProblem(boards, planValues).signature; } catch { /* Newly discovered effects require a CP value before recalculation. */ }
  const originalSignature = planSignature;
  document.getElementById('original-proof-download').hidden = true;
  let dirty = false;
  let worker = null;
  let calculationTimer = null;
  let downloads = new Map();
  let transitionSignature = null;
  let transition = null;
  let powerPlan = null;
  const planSection = document.querySelector('.board-power-plan');
  const comparisonSection = document.getElementById('stat-comparison');
  const planButton = document.getElementById('apply-power-plan');
  const format = number => number.toLocaleString('ko-KR');

  const signed = value => `${value > 0 ? '+' : ''}${format(value)}`;
  const allButton = document.getElementById('apply-all-power-plans');
  const recalculateButtons = [...document.querySelectorAll('[data-recalculate]')];
  const cancelCalculation = document.getElementById('cancel-recalculation');
  const calculationStatus = document.getElementById('recalculation-status');
  const calculationSeconds = document.getElementById('calculation-seconds');
  const calculationPresets = [...document.querySelectorAll('[data-calculation-seconds]')];
  function syncTimePresets() {
    for (const button of calculationPresets) button.setAttribute('aria-pressed', String(
      calculationSeconds.validity.valid && Number(calculationSeconds.value) === Number(button.dataset.calculationSeconds)));
  }
  calculationSeconds.addEventListener('input', syncTimePresets);
  for (const button of calculationPresets) button.addEventListener('click', () => {
    if (worker) return;
    calculationSeconds.value = button.dataset.calculationSeconds;
    syncTimePresets();
  });
  syncTimePresets();

  function restoreCalculation() {
    allPlan = originalPlan;
    powerPlans = allPlan.boards;
    planValues = Object.fromEntries(observations.map(record => [record.key, record.power]));
    planSignature = originalSignature;
    try {
      const record = JSON.parse(localStorage.getItem(runtimeKey));
      if (record?.version !== 1) return;
      const problem = optimizer.createProblem(boards, record.values);
      const solution = record.solution;
      if (problem.signature === originalSignature && originalPlan.optimality.status === 'optimal'
        && solution.power === originalPlan.power) {
        solution.upperBound = originalPlan.powerUpperBound;
        solution.status = 'optimal';
        solution.solver = originalPlan.optimality.solver;
      }
      allPlan = optimizer.summarize(problem, solution, observations);
      powerPlans = allPlan.boards;
      planValues = record.values;
      planSignature = problem.signature;
    } catch { /* Invalid or outdated numerical models never replace the built-in plan. */ }
  }

  function renderOptimality() {
    const note = allPlan.unknownCount && !allPlan.missingInputCount
      ? ` 루미엘 미측정 옵션 ${allPlan.unknownCount}종은 합산 점수에서 제외합니다. 옵션표에 값을 입력하면 재계산에 반영됩니다.` : '';
    const message = allPlan.missingInputCount
      ? `전투력 미측정 옵션 ${allPlan.missingInputCount}종의 값을 입력한 뒤 재계산하십시오.`
      : allPlan.pending
      ? `원본 소모량 ${allPlan.cost}개 · 전투력 재계산을 누르면 ${allPlan.budget}개 기준으로 구성합니다.`
      : dirty
      ? '입력값이 변경되어 합산 모형의 최고 점수는 아직 검증되지 않았습니다.'
      : allPlan.optimality.status === 'optimal'
        ? '입력값 합산 모형의 최고 점수를 검증했습니다. 실제 게임 전투력의 최고값은 검증하지 않았습니다.'
        : `합산 모형의 최고 점수는 아직 확정되지 않았습니다. 모형 상한은 ${format(allPlan.powerUpperBound)}점이며, 현재 점수와의 차이는 ${format(allPlan.powerUpperBound - allPlan.power)}점입니다. 실제 게임 전투력은 별도 확인이 필요합니다.`;
    document.getElementById('global-optimality-status').textContent = message + note;
  }

  function renderGlobalPlan() {
    document.getElementById('global-power-summary').textContent = `데바니온 ${allPlan.cost}/${allPlan.budget}개${allPlan.pending ? ' · 재계산 대기' : ' 전부 사용'} · ${allPlan.nodeCount}개 노드 · ${allPlan.unknownCount ? '확인된 ' : ''}기록값 점수 ${format(allPlan.power)}점 · 원본 대비 ${signed(allPlan.powerDifference)}점`;
    renderOptimality();
    const allocationRows = document.getElementById('global-allocation-rows');
    allocationRows.replaceChildren();
    for (const board of boards) {
      const plan = powerPlans[board.id];
      const row = document.createElement('tr');
      const cells = [board.name, `${plan.sourceBudget}개`, `${plan.cost}개`, `${plan.nodeIds.length}개`, `${signed(plan.power - plan.sourcePower)}점`];
      cells.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        cell.textContent = value;
        row.append(cell);
      });
      allocationRows.append(row);
    }
    for (const url of downloads.values()) URL.revokeObjectURL(url);
    downloads = new Map([['all', allPlan], ...Object.entries(powerPlans)].map(([id, plan]) =>
      [String(id), URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }))]));
    document.getElementById('all-power-plan-download').href = downloads.get('all');
  }

  function updateDirty() {
    try { dirty = optimizer.createProblem(boards, measurements.getValues()).signature !== planSignature || measurements.hasInvalidInputs(); }
    catch { dirty = true; }
    document.getElementById('recalculation-note').textContent = dirty
      ? '전투력값이 변경되었습니다. 재계산하면 수정값을 기준으로 다섯 보드를 함께 구성합니다.'
      : '옵션표에서 전투력값을 수정한 뒤 재계산하면 다섯 보드에 함께 적용합니다.';
    renderOptimality();
  }

  function stopCalculation(message = '') {
    worker?.terminate(); worker = null;
    clearInterval(calculationTimer);
    calculationTimer = null;
    recalculateButtons.forEach(button => { button.disabled = false; });
    cancelCalculation.hidden = true;
    calculationSeconds.disabled = false;
    calculationPresets.forEach(button => { button.disabled = false; });
    document.getElementById('global-power-plan').setAttribute('aria-busy', 'false');
    calculationStatus.textContent = message;
    updateDirty();
    sync();
  }

  function recalculate() {
    if (worker) return;
    calculationStatus.classList.remove('is-error');
    try {
      if (!calculationSeconds.checkValidity()) throw new Error('계산 시간을 1~600초 사이의 정수로 입력하십시오.');
      if (measurements.hasInvalidInputs()) throw new Error('옵션표의 올바르지 않은 전투력값을 수정하십시오.');
      const values = measurements.getValues();
      const problem = optimizer.createProblem(boards, values);
      const before = planner.snapshot();
      const seconds = Number(calculationSeconds.value);
      const candidates = [before.boards, Object.fromEntries(Object.entries(powerPlans).map(([id, plan]) => [id, plan.nodeIds])),
        Object.fromEntries(Object.entries(originalPlan.boards).map(([id, plan]) => [id, plan.nodeIds]))];
      const proven = [{ plan: allPlan, signature: planSignature }, { plan: originalPlan, signature: originalSignature }]
        .find(item => item.plan.optimality.status === 'optimal' && item.signature === problem.signature);
      const certificate = proven ? {
        signature: proven.signature, selections: Object.fromEntries(Object.entries(proven.plan.boards).map(([id, plan]) => [id, plan.nodeIds])),
        power: proven.plan.power, upperBound: proven.plan.powerUpperBound, status: 'optimal', gap: 0, solver: proven.plan.optimality.solver,
      } : null;
      const running = new Worker('assets/optimizer-worker.js');
      worker = running;
      const started = Date.now();
      let progressMessage = '최적화 엔진을 준비하고 있습니다.';
      const showProgress = () => { calculationStatus.textContent = `재계산 중 · ${Math.floor((Date.now() - started) / 1000)}초 경과 · 탐색 최대 ${seconds}초. ${progressMessage}`; };
      showProgress();
      calculationTimer = setInterval(showProgress, 1000);
      recalculateButtons.forEach(button => { button.disabled = true; });
      cancelCalculation.hidden = false;
      calculationSeconds.disabled = true;
      calculationPresets.forEach(button => { button.disabled = true; });
      document.getElementById('global-power-plan').setAttribute('aria-busy', 'true');
      sync();
      running.onmessage = event => {
        if (worker !== running) return;
        const data = event.data;
        if (data.type === 'progress') {
          progressMessage = Number.isFinite(data.power) ? `현재 모형 점수 ${format(data.power)}점 · 상한 ${format(data.upperBound)}점` : data.message;
          showProgress(); return;
        }
        if (data.type === 'error') {
          stopCalculation(`재계산을 적용하지 못했습니다. ${data.message}`);
          calculationStatus.classList.add('is-error'); return;
        }
        if (data.type !== 'result') return;
        try {
          if (measurements.hasInvalidInputs() || optimizer.createProblem(boards, measurements.getValues()).signature !== problem.signature) {
            throw new Error('계산 도중 전투력값이 바뀌었습니다. 현재 값으로 다시 계산하십시오.');
          }
          if (JSON.stringify(planner.snapshot().boards) !== JSON.stringify(before.boards)) {
            throw new Error('계산 도중 보드 상태가 바뀌었습니다. 현재 상태에서 다시 계산하십시오.');
          }
          const plan = optimizer.summarize(problem, data.solution, observations);
          const previousRecord = localStorage.getItem(runtimeKey);
          const result = planner.replaceAllBoards(data.solution.selections);
          if (!result.ok) throw new Error(result.message);
          try {
            localStorage.setItem(runtimeKey, JSON.stringify({ version: 1, values, solution: data.solution }));
            if (!api.write(undefined, planner)) throw new Error('브라우저의 저장 공간을 확인하십시오.');
          } catch (error) {
            planner.restore(before);
            try { if (previousRecord === null) localStorage.removeItem(runtimeKey); else localStorage.setItem(runtimeKey, previousRecord); } catch { /* Keep the existing in-memory board on failure. */ }
            throw error;
          }
          allPlan = plan; powerPlans = plan.boards; planValues = values; planSignature = problem.signature;
          renderGlobalPlan();
          renderPowerPlan(boards.find(board => board.id === activeId));
          stopCalculation(`다섯 보드를 재구성했습니다. 데바니온 ${plan.cost}개 전부 사용 · 잔여 0개 · 기록값 점수 ${format(plan.power)}점 · 실제 게임 CP는 확인이 필요합니다.`);
          sync(result);
        } catch (error) {
          stopCalculation(`재계산을 적용하지 못했습니다. ${error.message}`);
          calculationStatus.classList.add('is-error');
        }
      };
      running.onerror = () => {
        if (worker !== running) return;
        stopCalculation('계산 엔진을 불러오지 못했습니다. 로컬 서버에서 페이지를 열고 다시 실행하십시오.');
        calculationStatus.classList.add('is-error');
      };
      running.postMessage({ boards, values, candidates, certificate, seconds });
    } catch (error) {
      stopCalculation(error.message);
      calculationStatus.classList.add('is-error');
    }
  }
  recalculateButtons.forEach(button => button.addEventListener('click', recalculate));
  cancelCalculation.addEventListener('click', () => stopCalculation('재계산을 취소했습니다.'));
  window.addEventListener('daevanion:measurements-changed', () => { updateDirty(); sync(); });
  window.addEventListener('beforeunload', () => {
    worker?.terminate();
    for (const url of downloads.values()) URL.revokeObjectURL(url);
  });
  restoreCalculation();
  renderGlobalPlan();
  updateDirty();
  allButton.addEventListener('click', () => {
    if (dirty || worker) return;
    const previous = planner.snapshot();
    let result = planner.replaceAllBoards(Object.fromEntries(boards.map(board => [board.id, powerPlans[board.id].nodeIds])));
    result = persist(result, previous);
    sync(result);
    const status = document.getElementById('global-power-status');
    status.textContent = result.message;
    status.classList.toggle('is-error', result.ok === false);
  });

  function renderPowerPlan(board) {
    powerPlan = powerPlans[board.id] || null;
    planSection.hidden = !powerPlan;
    comparisonSection.hidden = !powerPlan;
    if (allPlan.pending) { planSection.hidden = true; comparisonSection.hidden = true; }
    planButton.disabled = !powerPlan;
    if (!powerPlan) return;
    document.getElementById('power-plan-heading').textContent = `${board.name} 기록값 기준 구성`;
    document.getElementById('power-plan-summary').textContent = `${powerPlan.nodeIds.length}개 노드 · 데바니온 ${powerPlan.cost}/${powerPlan.budget}개 전부 사용 · 기록값 점수 ${format(powerPlan.power)}점 · 원본 대비 ${signed(powerPlan.power - powerPlan.sourcePower)}점`;
    document.getElementById('power-plan-description').textContent = `전체 전투력 우선 구성에서 ${board.name}에 데바니온 ${powerPlan.budget}개를 배정했습니다. 모든 활성 노드는 루트와 연결됩니다. 기록값 합산 기준이며 실제 게임 전투력 상승은 검증되지 않았습니다.`;
    document.getElementById('power-plan-download').href = downloads.get(String(board.id)) || powerPlan.file;
    document.getElementById('power-plan-download').download = `${board.file.replace(/\.html$/, '')}-power-plan.json`;
    planSection.querySelector('.power-plan-table caption').textContent = `${board.name} 기록값 기준 구성의 옵션별 활성 노드 수`;
    document.getElementById('stat-comparison-board').textContent = `${board.name} · 원본 JSON / 재계산 구성`;
    document.querySelector('.stat-comparison-table caption').textContent = `${board.name} 원본과 기록값 기준 구성의 스탯 비교`;
    document.getElementById('power-plan-status').textContent = '';
    const planRows = document.getElementById('power-plan-options');
    planRows.replaceChildren();
    for (const group of powerPlan.groups) {
      const row = document.createElement('tr');
      const measured = group.power !== null;
      const cells = [group.effects.join(' / '), `${group.count}개`, `${group.cost}개`,
        measured ? `${format(group.power)}${group.basis === 'inferred' ? ' (추정)' : group.basis === 'fixed' ? ' (고정)' : ''}` : '미측정 · 연결용',
        measured ? format(group.power * group.count) : '—'];
      cells.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        cell.textContent = value;
        row.append(cell);
      });
      planRows.append(row);
    }
    const comparisonRows = document.getElementById('stat-comparison-rows');
    comparisonRows.replaceChildren();
    for (const stat of powerPlan.statComparison) {
      const row = document.createElement('tr');
      const cells = [stat.name, `${format(stat.source)}${stat.unit}`, `${format(stat.target)}${stat.unit}`,
        `${signed(stat.difference)}${stat.unit}`, stat.powerDifference === null ? '미측정' : `${signed(stat.powerDifference)}점`];
      cells.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        if (index === 3 && stat.difference !== 0) cell.className = stat.difference > 0 ? 'stat-increase' : 'stat-decrease';
        if (index === 4 && stat.powerDifference) cell.className = stat.powerDifference > 0 ? 'stat-increase' : 'stat-decrease';
        cell.textContent = value;
        row.append(cell);
      });
      comparisonRows.append(row);
    }
    document.getElementById('stat-comparison-summary').textContent = `기록값 합산 점수: 원본 ${format(powerPlan.sourcePower)}점 → 재계산 ${format(powerPlan.power)}점 (${signed(powerPlan.power - powerPlan.sourcePower)}점)`;
    document.getElementById('stat-comparison-skills').textContent = powerPlan.skillsUnchanged ? '패시브·액티브 스킬 구성은 원본과 같습니다.' : '패시브·액티브 스킬 구성도 변경되었습니다. 구성 내역을 확인하십시오.';
  }
  planButton.addEventListener('click', () => {
    if (!powerPlan || dirty || worker) return;
    const previous = planner.snapshot();
    let result = planner.replaceBoard(powerPlan.boardId, powerPlan.nodeIds);
    result = persist(result, previous);
    if (result.ok) {
      selectBoard(powerPlan.boardId);
      window.location.hash = String(powerPlan.boardId);
    }
    sync(result);
    const status = document.getElementById('power-plan-status');
    status.textContent = result.message;
    status.classList.toggle('is-error', result.ok === false);
  });

  function send(message) { frame.contentWindow.postMessage(message, targetOrigin); }
  function requestHeight() { send({ type: 'daevanion:request-height' }); }
  function renderTransition() {
    const status = document.getElementById('transition-status');
    const rows = document.getElementById('transition-rows');
    rows.replaceChildren();
    status.classList.toggle('is-error', !transition.ok);
    status.textContent = !transition.ok ? transition.message : !transition.steps.length
      ? '원본과 같은 구성입니다.'
      : `${transition.steps.length}단계 · 각 단계의 루트 연결과 잔여 수량을 검증했습니다.${transition.temporarySteps ? ` 임시 해제·복원 ${transition.temporarySteps}단계가 포함됩니다.` : ''}`;
    document.getElementById('transition-step-count').textContent = `(${transition.steps.length}단계)`;
    for (const step of transition.steps) {
      const row = document.createElement('tr');
      const action = step.action === 'deactivate' ? '해제' : step.temporary ? '복원' : '추가';
      const values = [String(step.order), boards.find(b => b.id === step.boardId).name,
        `(${step.col}, ${step.row})`, `${step.temporary ? '임시 ' : ''}${action}`, step.effects.join(' / ') || step.name, `${step.remaining}개`];
      values.forEach((value, index) => {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        if (index === 3) cell.className = step.action === 'deactivate' ? 'transition-remove' : 'transition-add';
        cell.textContent = value; row.append(cell);
      });
      rows.append(row);
    }
  }
  function sync(result = {}) {
    const state = planner.snapshot();
    const signature = JSON.stringify(state.boards);
    if (signature !== transitionSignature) {
      transitionSignature = signature;
      transition = window.DaevanionTransition.plan(boards, state);
      renderTransition();
    }
    for (const board of boards) {
      document.querySelector(`[data-count="${board.id}"]`).textContent = `(${planner.active.get(board.id).size}/${board.total})`;
    }
    resources.render(result.message || '', result.ok === false);
    const allApplied = boards.every(board => {
      const current = planner.active.get(board.id);
      return current.size === powerPlans[board.id].nodeIds.length && powerPlans[board.id].nodeIds.every(id => current.has(id));
    });
    allButton.disabled = !!allPlan.pending || allApplied || dirty || !!worker;
    allButton.textContent = allPlan.pending ? '재계산 후 적용' : allApplied ? '전체 구성 적용됨' : '전체 구성 적용';
    if (powerPlan) {
      const current = planner.active.get(powerPlan.boardId);
      const applied = current.size === powerPlan.nodeIds.length && powerPlan.nodeIds.every(id => current.has(id));
      planButton.disabled = applied || dirty || !!worker;
      planButton.textContent = applied ? '구성 적용됨' : '전투력 구성 적용';
    }
    send({ type: 'daevanion:state', state, transition, result });
  }
  function onFrameLoad() { requestHeight(); sync(); }
  frame.addEventListener('load', onFrameLoad);

  function persist(result, previous) {
    if (result.changed && !api.write(undefined, planner)) {
      planner.restore(previous);
      return { ok: false, message: '변경 내용을 보관하지 못해 적용을 취소했습니다. 브라우저의 저장 공간을 확인하십시오.' };
    }
    return result;
  }

  function applyAction(action, value) {
    const previous = planner.snapshot();
    let result;
    if (action === 'toggle') result = planner.toggle(activeId, value);
    else if (action === 'activate') result = planner.activate(activeId, value);
    else if (action === 'deactivate') result = planner.deactivate(activeId, value);
    else if (action === 'reset-board') result = planner.reset(activeId);
    else if (action === 'reset-all') result = planner.reset();
    else if (action === 'load-source') result = planner.loadSource();
    else return;
    result = persist(result, previous);
    sync(result);
  }

  function selectBoard(id) {
    const board = boards.find(item => item.id === id) || boards[0];
    if (activeId === board.id) return;
    activeId = board.id;
    renderPowerPlan(board);
    const url = new URL(location.href);
    url.searchParams.set('boardId', String(board.id));
    try { history.replaceState(null, '', url); } catch { /* File URL policies can restrict history edits. */ }
    tabs.forEach(tab => {
      const active = Number(tab.dataset.board) === board.id;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `tab-${board.id}`);
    frame.title = `${board.name} 데바니온 보드`;
    const path = `${board.file}?embedded=1`;
    if (frame.getAttribute('src') !== path) {
      // Replacing the element keeps iframe navigation out of the tab history.
      const nextFrame = frame.cloneNode(false);
      nextFrame.style.height = '1120px';
      nextFrame.src = path;
      nextFrame.addEventListener('load', onFrameLoad);
      frame.replaceWith(nextFrame);
      frame = nextFrame;
    }
    source.href = board.source;
    document.title = `${window.DAEVANION_CHARACTER ? `${window.DAEVANION_CHARACTER.name} · ` : ''}${board.name} · 데바니온 보드 · AION2`;
    requestHeight();
    sync();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      selectBoard(Number(tab.dataset.board));
      window.location.hash = tab.dataset.board;
    });
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    });
  });

  document.addEventListener('keydown', event => {
    if (event.code !== 'KeyF' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"], #character-search')) return;
    event.preventDefault();
    send({ type: 'daevanion:toggle-selected' });
  });
  window.addEventListener('storage', event => {
    if (event.key === window.DaevanionCharacterSession?.SESSION_KEY) { location.reload(); return; }
    if (event.key === runtimeKey || event.key === null) {
      restoreCalculation();
      renderGlobalPlan();
      renderPowerPlan(boards.find(board => board.id === activeId));
      updateDirty();
      sync();
    }
    if (event.key !== api.STORAGE_KEY && event.key !== null) return;
    planner.restore(api.read());
    sync();
  });
  window.addEventListener('hashchange', () => {
    const id = Number(window.location.hash.slice(1));
    if (boards.some(board => board.id === id)) selectBoard(id);
  });
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow) return;
    if (location.protocol !== 'file:' && event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.boardId !== activeId) return;
    if (data.type === 'daevanion:ready') sync();
    if (data.type === 'daevanion:action' && ['toggle', 'activate', 'deactivate', 'reset-board'].includes(data.action)) applyAction(data.action, data.nodeId);
    if (data.type === 'daevanion:height' && Number.isFinite(data.height) && data.height >= 300 && data.height <= 6000) {
      frame.style.height = `${Math.ceil(data.height)}px`;
    }
  });
  const hashId = Number(window.location.hash.slice(1));
  selectBoard(boards.some(board => board.id === hashId) ? hashId : Number(new URLSearchParams(location.search).get('boardId')));
})();
