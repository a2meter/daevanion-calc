'use strict';
(() => {
  const model = window.DaevanionCharacters;
  const SESSION_KEY = 'daevanion-character-session:v1';
  const BASE_STATE = 'daevanion-planner:v2';
  const BASE_PLAN = 'daevanion-recalculated-plan:v1';

  function commit(character, rawBoards) {
    const { boards, state } = model.prepareBoards(rawBoards, character, window.DaevanionPlanner.Planner);
    const ending = model.suffix(character);
    // Required nodes are the user's own choice, so importing the same character again keeps them.
    try {
      const earlier = JSON.parse(localStorage.getItem(BASE_STATE + ending));
      if (earlier?.version === state.version && earlier.required) {
        state.required = new window.DaevanionPlanner.Planner(boards, { ...state, required: earlier.required }).snapshot().required;
      }
    } catch { /* An unreadable earlier state has no required nodes to keep. */ }
    const writes = [[BASE_STATE + ending, JSON.stringify(state)], [BASE_PLAN + ending, null],
      [SESSION_KEY, JSON.stringify({ version: 1, character, rawBoards })]];
    const previous = writes.map(([key]) => [key, localStorage.getItem(key)]);
    try {
      for (const [key, value] of writes) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    } catch {
      for (const [key, value] of previous) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Preserve the current visible board. */ } }
      throw new Error('캐릭터 보드를 보관하지 못했습니다. 브라우저의 저장 공간을 확인하십시오.');
    }
  }
  window.DaevanionCharacterSession = { commit, SESSION_KEY };
  function addLumiel(character, rawBoard) {
    const current = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (current?.version !== 1 || model.identity(current.character) !== model.identity(character)
      || current.rawBoards[79]) return false;
    const rawBoards = { ...current.rawBoards, 79: rawBoard };
    const { boards } = model.prepareBoards(rawBoards, character, window.DaevanionPlanner.Planner);
    const ending = model.suffix(character);
    const key = BASE_STATE + ending;
    const saved = JSON.parse(localStorage.getItem(key));
    const writes = [];
    if (saved?.version === 2) {
      const previousBoards = boards.filter(b => b.id !== 79);
      const previousPlanner = new window.DaevanionPlanner.Planner(previousBoards, saved);
      const selections = { ...previousPlanner.snapshot().boards, 79: boards.find(b => b.id === 79).nodes.filter(n => n.type !== 'Start' && n.open === 1).map(n => n.nodeId) };
      const validator = new window.DaevanionPlanner.Planner(boards);
      let cost = 0;
      for (const board of boards) {
        const checked = validator.validateBoard(board.id, selections[board.id]);
        if (!checked.ok) throw new Error(checked.message);
        cost += checked.cost;
      }
      if (cost > validator.total) {
        cost -= validator.validateBoard(79, selections[79]).cost;
        selections[79] = [];
      }
      if (cost > validator.total) throw new Error('기존 편집 소모량이 새 계산 수량을 초과합니다.');
      writes.push([key, JSON.stringify({ ...saved, total: validator.total, boards: selections })]);
    }
    writes.push([BASE_PLAN + ending, null], [SESSION_KEY, JSON.stringify({ ...current, rawBoards })]);
    const previous = writes.map(([key]) => [key, localStorage.getItem(key)]);
    try {
      for (const [key, value] of writes) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    } catch (error) {
      for (const [key, value] of previous) {
        try {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        } catch { /* Preserve the current source and edits if storage becomes unavailable. */ }
      }
      throw new Error('루미엘을 보관하지 못했습니다. 브라우저의 저장 공간을 확인하십시오.');
    }
    return true;
  }
  window.DaevanionCharacterSession.addLumiel = addLumiel;
  function activate(record, boards, character) {
    window.DAEVANION_BOARDS = boards;
    window.DAEVANION_CHARACTER = character;
    window.DAEVANION_SESSION_SUFFIX = model.suffix(character);
    window.DaevanionPlanner.setContext(window.DAEVANION_SESSION_SUFFIX);
    const data = document.getElementById('board-data');
    if (data) {
      const id = Number(document.body.dataset.boardId);
      data.textContent = JSON.stringify(record.rawBoards[id]);
      const boardLabel = document.querySelector('.board-id');
      if (boardLabel) boardLabel.textContent = `BOARD ${record.rawBoards[id].sourceBoardId ?? id}`;
      const link = document.querySelector('.data-link');
      if (link) link.href = URL.createObjectURL(new Blob([JSON.stringify(record.rawBoards[id], null, 2)], { type: 'application/json' }));
      const total = document.querySelector('.completion > span:nth-child(3)');
      if (total) total.textContent = `/ ${boards.find(b => b.id === id).total}`;
    }
  }
  let record;
  try {
    record = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (record?.version !== 1) return;
    const character = model.normalizeCharacter({ ...record.character, name: record.character.name,
      characterId: encodeURIComponent(record.character.characterId) });
    const legacy = !record.rawBoards?.[79];
    const { boards } = model.prepareBoards(record.rawBoards, character, window.DaevanionPlanner.Planner, { legacy });
    window.DAEVANION_LEGACY_BOARDS = legacy;
    if (document.body?.dataset?.boardId === '79' && legacy) {
      location.replace('index.html#79');
      return;
    }
    if (!window.DaevanionOptimizer) { activate(record, boards, character); return; }
    const groups = model.groupsFor(boards);
    const observations = [...window.DAEVANION_MEASUREMENTS];
    for (const option of groups) if (option.type === 'SkillLevel' && ['Rare','Legend'].includes(option.grade)) observations.push({
      id: `character-skill:${option.key}`, key: option.key, power: option.grade === 'Rare' ? 200 : 100,
      basis: 'fixed', note: '사용자가 확인한 등급별 스킬 고정 전투력입니다.',
    });
    const known = Object.fromEntries(observations.map(o => [o.key, o.power]));
    const unknown = groups.filter(g => !Object.hasOwn(known, g.key));
    // Zero is used only to build a partial report. Unknown values stay absent
    // from the editable measurements and block numerical recalculation.
    const requiredUnknown = unknown.filter(g => boards.some(b => b.id !== 79 && g.counts[b.id] > 0));
    const reportValues = { ...known, ...Object.fromEntries(requiredUnknown.map(g => [g.key, 0])) };
    const optimizer = window.DaevanionOptimizer;
    const problem = optimizer.createProblem(boards, reportValues);
    const plan = optimizer.summarizeSource(problem, observations);
    plan.unknownCount = unknown.length;
    plan.missingInputCount = requiredUnknown.length;
    if (requiredUnknown.length) plan.powerUpperBound = null;
    for (const b of Object.values(plan.boards)) {
      b.unknownCount = unknown.filter(g => g.counts[b.boardId] > 0).length;
      for (const g of b.groups) if (!Object.hasOwn(known, g.key)) { g.power = null; g.basis = 'unknown'; }
    }
    activate(record, boards, character);
    window.DAEVANION_OPTIONS = groups;
    window.DAEVANION_MEASUREMENTS = observations;
    window.DAEVANION_ALL_POWER_PLAN = plan;
    window.DAEVANION_POWER_PLANS = plan.boards;
  } catch {
    // Never replace the bundled boards with an incomplete or invalid record.
    window.DAEVANION_CHARACTER_LOAD_ERROR = '보관된 캐릭터 보드를 불러오지 못했습니다. 다시 검색하십시오.';
  }
})();
