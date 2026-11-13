'use strict';

// Runs before the planner scripts read the bundled data. A link in the address
// (`#link=…`) is imported and kept in localStorage; the stored import then
// replaces the boards' source layout, the skill level sequences and the bundled
// plan for this page load. Without an import the bundled data stays untouched.
(() => {
  const model = window.DaevanionLink;
  const editor = window.DaevanionPlanner;
  const STORAGE_KEY = 'daevanion-link-import:v1';
  const SUFFIX = ':link';
  const BASE_STATE = 'daevanion-planner:v2';
  const BASE_PLAN = 'daevanion-recalculated-plan:v1';
  const SEARCH_SESSION = 'daevanion-character-session:v1';
  const bundled = window.DAEVANION_BOARDS;
  const boardPage = document.getElementById('board-data');
  const session = { STORAGE_KEY, SUFFIX, summary: null, fresh: false, error: '', clear,
    describe: () => session.summary ? model.describe(session.summary, bundled) : '' };
  window.DaevanionLinkSession = session;

  const parse = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };

  // All writes or none: a failed write puts back what was there before.
  function store(writes, message) {
    const put = ([key, value]) => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); };
    let previous = [];
    try {
      previous = writes.map(([key]) => [key, localStorage.getItem(key)]);
      writes.forEach(put);
    } catch {
      for (const entry of previous) { try { put(entry); } catch { /* Keep whatever can still be kept. */ } }
      throw new Error(message);
    }
  }

  // The required nodes of a saved planner state that exist on the bundled boards; null without a usable state.
  function pinsOf(key) {
    const saved = parse(key);
    if (saved?.version !== editor.STATE_VERSION || !saved.required || typeof saved.required !== 'object') return null;
    return new editor.Planner(bundled, { version: saved.version, required: saved.required }).requiredSelections();
  }

  // The planner state saved under `key`, or the source layout when there is none, with these required nodes.
  function withPins(key, pins) {
    const saved = parse(key);
    return JSON.stringify(new editor.Planner(bundled,
      { ...(saved?.version === editor.STATE_VERSION ? saved : { version: editor.STATE_VERSION }), required: pins }).snapshot());
  }

  // The character search is gone, and the per-character states it saved are no
  // longer read. Required nodes are the one thing the user set by hand that still
  // applies, so those of the last searched character move to the default state
  // once, when that character used these same boards. The record is then dropped.
  function adoptSearchPins() {
    let raw;
    try { raw = localStorage.getItem(SEARCH_SESSION); } catch { return; }
    if (raw === null) return;
    try {
      const writes = [[SEARCH_SESSION, null]];
      let record = null;
      try { record = JSON.parse(raw); } catch { /* An unreadable record has nothing to carry over. */ }
      const sameBoards = !!record?.rawBoards?.[bundled[0].id]
        && bundled.every(board => (record.rawBoards[board.id]?.sourceBoardId ?? board.id) === board.id);
      const pins = sameBoards && record.character
        ? pinsOf(`${BASE_STATE}:character:${record.character.serverId}:${record.character.characterId}`) : null;
      if (pins) writes.unshift([BASE_STATE, withPins(BASE_STATE, pins)]);
      store(writes, '');
    } catch { /* Tried again on the next load. */ }
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* Without storage there is nothing imported. */ }
    if (raw === null) return null;
    const record = JSON.parse(raw);
    if (record?.version !== 1 || typeof record.data !== 'string') throw new Error('보관된 가져오기 기록의 형식이 올바르지 않습니다.');
    return model.prepare(bundled, model.decode(record.data), window.DAEVANION_SKILL_TABLES);
  }

  // Stores a link as the character's current state. The required nodes saved for
  // the state on screen (an earlier import, otherwise the bundled default) go with
  // it; the layout starts as the imported one and no earlier plan is kept.
  function commit(data, imported) {
    const prepared = model.prepare(bundled, model.decode(data), window.DAEVANION_SKILL_TABLES);
    const pins = (imported ? pinsOf(BASE_STATE + SUFFIX) : null) ?? pinsOf(BASE_STATE) ?? {};
    const state = new editor.Planner(prepared.boards, { version: editor.STATE_VERSION, boards: prepared.open, required: pins }).snapshot();
    store([[BASE_STATE + SUFFIX, JSON.stringify(state)], [BASE_PLAN + SUFFIX, null],
      [STORAGE_KEY, JSON.stringify({ version: 1, data, importedAt: Math.floor(Date.now() / 1000) })]],
      '가져온 상태를 보관하지 못했습니다. 브라우저의 저장 공간을 확인하십시오.');
    return prepared;
  }

  // Back to the bundled boards. The required nodes go along; the import's own edits and plan are dropped.
  function clear() {
    const pins = pinsOf(BASE_STATE + SUFFIX);
    const writes = [[STORAGE_KEY, null], [BASE_STATE + SUFFIX, null], [BASE_PLAN + SUFFIX, null]];
    if (pins) writes.unshift([BASE_STATE, withPins(BASE_STATE, pins)]);
    store(writes, '기본 상태로 돌아가지 못했습니다. 브라우저의 저장 공간을 확인하십시오.');
  }

  function apply(prepared) {
    const optimizer = window.DaevanionOptimizer;
    let plan = null;
    if (optimizer) {
      // The bundled plan belongs to the bundled source layout. Until a recalculation, the
      // imported layout itself is reported, valued with the character's own skill levels.
      const observations = window.DAEVANION_MEASUREMENTS;
      const problem = optimizer.createProblem(prepared.boards, Object.fromEntries(observations.map(record => [record.key, record.power])),
        { skills: Object.fromEntries(prepared.skills.map(skill => [skill.key, skill.values])) });
      plan = optimizer.summarizeSource(problem, observations);
    }
    // A board page draws from its embedded JSON, so the imported layout goes there too.
    let nodeList = null;
    if (boardPage) {
      const open = new Set(prepared.open[Number(document.body.dataset.boardId)]);
      nodeList = JSON.parse(boardPage.textContent).nodeList
        .map(node => ['None', 'Start'].includes(node.type) ? node : { ...node, open: open.has(node.nodeId) ? 1 : 0 });
    }
    // Nothing above changed the page; from here on nothing can fail halfway.
    window.DAEVANION_BOARDS = prepared.boards;
    window.DAEVANION_SESSION_SUFFIX = SUFFIX;
    editor.setContext(SUFFIX);
    if (plan) {
      window.DAEVANION_SKILL_VALUES = prepared.skills;
      window.DAEVANION_SKILL_FALLBACKS = prepared.fallbacks;
      // The bundled plan no longer describes this layout, but its node choice is still a good
      // place for the search to start from.
      const bundledPlan = window.DAEVANION_ALL_POWER_PLAN;
      window.DAEVANION_PLAN_CANDIDATE = bundledPlan?.boards
        ? Object.fromEntries(Object.entries(bundledPlan.boards).map(([id, board]) => [id, board.nodeIds])) : null;
      window.DAEVANION_ALL_POWER_PLAN = plan;
      window.DAEVANION_POWER_PLANS = plan.boards;
    }
    if (!nodeList) return;
    // The official effect summaries describe the bundled layout, so they are left out here.
    boardPage.textContent = JSON.stringify({ nodeList });
    const download = document.querySelector('.data-link');
    if (download) download.href = URL.createObjectURL(new Blob([JSON.stringify({ nodeList }, null, 2)], { type: 'application/json' }));
  }

  adoptSearchPins();
  let current = null;
  try { current = load(); } catch {
    try { clear(); } catch { /* The unreadable record stays and is reported again. */ }
    session.error = '보관된 가져오기 상태를 읽을 수 없어 지웠습니다. 기본 보드를 표시합니다.';
  }
  const data = boardPage ? null : model.fragment(location.hash);
  if (data !== null) {
    try {
      current = commit(data, current !== null);
      session.fresh = true;
      session.error = '';
      // The fragment is dropped so that reloading the page does not import the link again.
      try { history.replaceState(null, '', location.pathname + location.search); } catch { location.hash = ''; }
    } catch (error) {
      session.error = `링크를 가져오지 못했습니다. ${error.message} ${current ? '이전에 가져온 상태를' : '기본 보드를'} 그대로 표시합니다.`;
    }
  }
  if (current) {
    try {
      apply(current);
      session.summary = current.summary;
    } catch {
      session.fresh = false;
      session.error = '가져온 상태를 적용하지 못해 기본 보드를 표시합니다.';
    }
  }
})();
