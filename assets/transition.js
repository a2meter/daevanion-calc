'use strict';

((scope) => {
  const { Planner, COSTS, STATE_VERSION } = typeof module !== 'undefined' && module.exports
    ? require('./planner.js') : scope.DaevanionPlanner;

  function plan(boards, targetState) {
    try {
      const source = new Planner(boards);
      if (targetState?.version !== STATE_VERSION || !targetState.boards
        || Object.keys(targetState.boards).length !== source.catalog.size) throw new Error('변경할 보드 구성을 확인할 수 없습니다.');
      const target = new Map(), original = new Map();
      let targetUsed = 0;
      for (const board of boards) {
        const selected = board.nodes.filter(n => n.type !== 'Start' && n.open === 1).map(n => n.nodeId);
        if (!source.validateBoard(board.id, selected).ok) throw new Error('원본 보드의 루트 연결을 확인할 수 없습니다.');
        original.set(board.id, new Set(selected));
        const checked = source.validateBoard(board.id, targetState.boards[board.id]);
        if (!checked.ok) throw new Error(checked.message);
        target.set(board.id, checked.nodes);
        targetUsed += checked.cost;
      }
      if (targetUsed > source.total) throw new Error('변경할 구성의 데바니온 수량이 부족합니다.');
      const initialUsed = source.used();

      const ordered = boards.flatMap(b => b.nodes.filter(n => n.type !== 'Start').map(node => ({ boardId: b.id, node })))
        .sort((a, b) => a.boardId - b.boardId || a.node.row - b.node.row || a.node.col - b.node.col || a.node.nodeId - b.node.nodeId);
      const current = source, steps = [], deferred = new Set();
      const token = (boardId, nodeId) => `${boardId}:${nodeId}`;
      const perform = (boardId, nodeId, action) => {
        // Adds must be single frontier nodes, never an implicit multi-node path.
        if (action === 'activate' && (!current.available(boardId, nodeId)
          || COSTS[current.catalog.get(boardId).nodes.get(nodeId).grade] > current.remaining())) return false;
        const result = current[action](boardId, nodeId);
        if (!result.ok || !result.changed) return false;
        const node = current.catalog.get(boardId).nodes.get(nodeId);
        const temporary = action === 'deactivate' ? target.get(boardId).has(nodeId) : deferred.has(token(boardId, nodeId));
        if (temporary && action === 'deactivate') deferred.add(token(boardId, nodeId));
        steps.push({ order: steps.length + 1, boardId, nodeId, action, col: node.col, row: node.row,
          name: node.name, effects: (node.effectList || []).map(e => e.desc).filter(Boolean), cost: COSTS[node.grade],
          remaining: current.remaining(), temporary });
        return true;
      };
      const done = () => [...target].every(([id, ids]) => ids.size === current.active.get(id).size
        && [...ids].every(nodeId => current.isActive(id, nodeId)));

      // Prefer final removals and bridge additions. If budget or connectivity blocks
      // progress, temporarily remove a safe target leaf and defer its restoration
      // until every source-only node is gone. Each deferred node stays off during
      // this phase, so progress cannot cycle. Once the current state is a subset
      // of the target, every connected target prefix fits the final budget.
      while (!done()) {
        const removed = ordered.find(({ boardId, node }) => current.isActive(boardId, node.nodeId)
          && !target.get(boardId).has(node.nodeId) && perform(boardId, node.nodeId, 'deactivate'));
        if (removed) continue;
        const hasSourceOnly = ordered.some(({ boardId, node }) => current.isActive(boardId, node.nodeId) && !target.get(boardId).has(node.nodeId));
        const additions = ordered.filter(({ boardId, node }) => target.get(boardId).has(node.nodeId)
          && (!hasSourceOnly || !deferred.has(token(boardId, node.nodeId)))
          && current.available(boardId, node.nodeId) && COSTS[node.grade] <= current.remaining());
        const neighbors = item => current.catalog.get(item.boardId).neighbors.get(item.node.nodeId);
        const score = item => neighbors(item).filter(id => id === current.catalog.get(item.boardId).root
          || current.isActive(item.boardId, id)).length;
        additions.sort((a, b) => score(b) - score(a) || COSTS[a.node.grade] - COSTS[b.node.grade]
          || a.boardId - b.boardId || a.node.nodeId - b.node.nodeId);
        if (additions.length && perform(additions[0].boardId, additions[0].node.nodeId, 'activate')) continue;
        const temporaryLeaves = ordered.filter(({ boardId, node }) => current.isActive(boardId, node.nodeId) && target.get(boardId).has(node.nodeId));
        // Prefer untouched original nodes over removing a just-added target node.
        temporaryLeaves.sort((a,b) => Number(original.get(b.boardId).has(b.node.nodeId)) - Number(original.get(a.boardId).has(a.node.nodeId))
          || COSTS[b.node.grade] - COSTS[a.node.grade] || a.boardId - b.boardId || a.node.nodeId - b.node.nodeId);
        if (hasSourceOnly && temporaryLeaves.some(({boardId,node}) => perform(boardId,node.nodeId,'deactivate'))) continue;
        throw new Error('루트 연결과 잔여 수량을 지키는 변경 순서를 찾지 못했습니다.');
      }
      if (current.used() !== targetUsed || !done()) throw new Error('변경 순서의 최종 구성 검증에 실패했습니다.');
      return { ok: true, steps, budget: source.total, initialUsed, targetUsed,
        temporarySteps: steps.filter(s => s.temporary).length };
    } catch (error) {
      return { ok: false, steps: [], message: error.message };
    }
  }

  const api = { plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionTransition = api;
})(typeof window !== 'undefined' ? window : globalThis);
