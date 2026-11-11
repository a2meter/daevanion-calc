'use strict';

((scope) => {
  const COSTS = Object.freeze({ Common: 1, Rare: 2, Legend: 3, Unique: 4 });
  const STATE_VERSION = 2;
  const planningBudget = sourceTotal => sourceTotal === 0 || sourceTotal >= 709 ? 837 : sourceTotal;
  let STORAGE_KEY = 'daevanion-planner:v2';

  class Planner {
    constructor(boards, saved) {
      this.catalog = new Map(boards.map(board => {
        const nodes = new Map(board.nodes.map(node => [node.nodeId, node]));
        const positions = new Map(board.nodes.map(node => [`${node.row},${node.col}`, node.nodeId]));
        const root = board.nodes.find(node => node.row === 8 && node.col === 8);
        if (!root || root.type !== 'Start') throw new Error('루트 노드가 없습니다.');
        const neighbors = new Map(board.nodes.map(node => [node.nodeId,
          [[node.row - 1, node.col], [node.row + 1, node.col], [node.row, node.col - 1], [node.row, node.col + 1]]
            .map(([row, col]) => positions.get(`${row},${col}`)).filter(id => id !== undefined)]));
        return [board.id, { nodes, neighbors, root: root.nodeId }];
      }));
      // Recover the shared pool from the original activated nodes, not the edited plan.
      this.sourceTotal = [...this.catalog.values()].reduce((sum, board) => sum + [...board.nodes.values()]
        .filter(node => node.nodeId !== board.root && node.open === 1)
        .reduce((cost, node) => cost + COSTS[node.grade], 0), 0);
      this.restore(saved);
    }

    restore(saved) {
      // Old saved manual totals must not override the amount recovered from the API.
      this.total = planningBudget(this.sourceTotal);
      this.active = new Map();
      const hasSavedState = saved?.version === STATE_VERSION;
      for (const [id, board] of this.catalog) {
        const raw = hasSavedState && Array.isArray(saved.boards?.[id])
          ? saved.boards[id]
          : [...board.nodes.values()].filter(node => node.open === 1 && node.nodeId !== board.root).map(node => node.nodeId);
        const requested = new Set(raw.filter(nodeId => board.nodes.has(nodeId) && nodeId !== board.root));
        const connected = new Set([board.root]);
        const queue = [board.root];
        for (let index = 0; index < queue.length; index++) {
          for (const next of board.neighbors.get(queue[index])) {
            if (requested.has(next) && !connected.has(next)) {
              connected.add(next);
              queue.push(next);
            }
          }
        }
        connected.delete(board.root);
        this.active.set(id, connected);
      }
      // Never restore a plan that spends more than its shared budget.
      if (this.used() > this.total) for (const active of this.active.values()) active.clear();
    }

    snapshot() {
      return { version: STATE_VERSION, total: this.total, boards: Object.fromEntries(
        [...this.active].map(([id, nodes]) => [id, [...nodes].sort((a, b) => a - b)])) };
    }

    used(boardId) {
      let total = 0;
      for (const [id, active] of this.active) {
        if (boardId !== undefined && id !== boardId) continue;
        for (const nodeId of active) total += COSTS[this.catalog.get(id).nodes.get(nodeId).grade];
      }
      return total;
    }

    remaining() { return this.total - this.used(); }
    isActive(boardId, nodeId) { return this.active.get(boardId)?.has(nodeId) || false; }

    available(boardId, nodeId) {
      const board = this.catalog.get(boardId);
      return !!board?.nodes.has(nodeId) && nodeId !== board.root && !this.isActive(boardId, nodeId)
        && board.neighbors.get(nodeId).some(id => id === board.root || this.isActive(boardId, id));
    }

    plan(boardId, target) {
      const board = this.catalog.get(boardId);
      if (!board?.nodes.has(target) || target === board.root) return null;
      if (this.isActive(boardId, target)) return { nodes: [], cost: 0 };
      // Multi-source shortest path: add the fewest inactive nodes, then minimize cost.
      const best = new Map();
      const previous = new Map();
      const pending = [];
      for (const id of [board.root, ...this.active.get(boardId)]) {
        best.set(id, [0, 0]);
        previous.set(id, null);
        pending.push({ id, distance: 0, cost: 0 });
      }
      while (pending.length) {
        pending.sort((a, b) => a.distance - b.distance || a.cost - b.cost || a.id - b.id);
        const item = pending.shift();
        const score = best.get(item.id);
        if (item.distance !== score[0] || item.cost !== score[1]) continue;
        if (item.id === target) {
          const path = [];
          for (let id = target; previous.get(id) !== null; id = previous.get(id)) path.push(id);
          return { nodes: path.reverse(), cost: item.cost };
        }
        for (const next of board.neighbors.get(item.id)) {
          if (next === board.root || this.isActive(boardId, next)) continue;
          const distance = item.distance + 1;
          const cost = item.cost + COSTS[board.nodes.get(next).grade];
          const old = best.get(next);
          if (old && (old[0] < distance || (old[0] === distance && old[1] <= cost))) continue;
          best.set(next, [distance, cost]);
          previous.set(next, item.id);
          pending.push({ id: next, distance, cost });
        }
      }
      return null;
    }

    activate(boardId, nodeId) {
      const board = this.catalog.get(boardId);
      if (!board?.nodes.has(nodeId)) return { ok: false, message: '유효한 노드를 선택하십시오.' };
      if (nodeId === board.root) return { ok: false, message: '루트는 활성화할 수 없습니다.' };
      const path = this.plan(boardId, nodeId);
      if (!path) return { ok: false, message: '루트와 연결할 수 없습니다.' };
      if (!path.nodes.length) return { ok: true, changed: false, message: '이미 활성화된 노드입니다.' };
      if (path.cost > this.remaining()) return { ok: false, message: `데바니온이 ${path.cost - this.remaining()}개 부족합니다. 경로 활성화에 ${path.cost}개가 필요합니다.` };
      for (const id of path.nodes) this.active.get(boardId).add(id);
      return { ok: true, changed: true, message: `${path.nodes.length}개 노드를 활성화했습니다. 데바니온 ${path.cost}개를 사용했습니다.` };
    }

    deactivate(boardId, nodeId) {
      const board = this.catalog.get(boardId);
      if (!board?.nodes.has(nodeId)) return { ok: false, message: '유효한 노드를 선택하십시오.' };
      if (nodeId === board.root) return { ok: false, message: '루트는 변경할 수 없습니다.' };
      if (!this.isActive(boardId, nodeId)) return { ok: true, changed: false, message: '이미 비활성 상태입니다.' };
      const remaining = new Set(this.active.get(boardId));
      remaining.delete(nodeId);
      const reached = new Set([board.root]);
      const queue = [board.root];
      for (let index = 0; index < queue.length; index++) {
        for (const next of board.neighbors.get(queue[index])) {
          if (remaining.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
        }
      }
      if (reached.size !== remaining.size + 1) return { ok: false, message: '다른 노드의 루트 연결이 끊깁니다. 끝 노드부터 비활성화하십시오.' };
      this.active.set(boardId, remaining);
      return { ok: true, changed: true, message: `노드를 비활성화했습니다. 데바니온 ${COSTS[board.nodes.get(nodeId).grade]}개가 반환되었습니다.` };
    }

    toggle(boardId, nodeId) {
      return this.isActive(boardId, nodeId) ? this.deactivate(boardId, nodeId) : this.activate(boardId, nodeId);
    }

    loadSource() {
      this.restore(null);
      return { ok: true, changed: true, message: '원본 보드의 활성 상태를 불러왔습니다.' };
    }

    validateBoard(boardId, nodeIds) {
      const board = this.catalog.get(boardId);
      if (!board || !Array.isArray(nodeIds) || new Set(nodeIds).size !== nodeIds.length
        || nodeIds.some(id => id === board.root || !board.nodes.has(id))) {
        return { ok: false, message: '보드 구성의 노드 목록이 올바르지 않습니다.' };
      }
      const proposed = new Set(nodeIds);
      const reached = new Set([board.root]);
      const queue = [board.root];
      for (let index = 0; index < queue.length; index++) {
        for (const next of board.neighbors.get(queue[index])) {
          if (proposed.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
        }
      }
      if (reached.size !== proposed.size + 1) return { ok: false, message: '구성에 루트와 연결되지 않은 노드가 있습니다.' };
      const cost = nodeIds.reduce((sum, id) => sum + COSTS[board.nodes.get(id).grade], 0);
      return { ok: true, nodes: proposed, cost };
    }

    replaceBoard(boardId, nodeIds) {
      const checked = this.validateBoard(boardId, nodeIds);
      if (!checked.ok) return checked;
      const { nodes: proposed, cost } = checked;
      const budget = this.remaining() + this.used(boardId);
      if (cost > budget) return { ok: false, message: `구성을 적용하려면 데바니온이 ${cost - budget}개 더 필요합니다.` };
      this.active.set(boardId, proposed);
      return { ok: true, changed: true, message: `전투력 구성을 적용했습니다. ${proposed.size}개 노드 · 소모 ${cost}개` };
    }

    replaceAllBoards(selections) {
      if (!selections || typeof selections !== 'object' || Array.isArray(selections)
        || Object.keys(selections).length !== this.catalog.size) {
        return { ok: false, message: '전체 보드 구성이 올바르지 않습니다.' };
      }
      const proposed = new Map();
      let cost = 0;
      for (const [id] of this.catalog) {
        const checked = this.validateBoard(id, selections[id]);
        if (!checked.ok) return checked;
        proposed.set(id, checked.nodes);
        cost += checked.cost;
      }
      if (cost !== this.total) return { ok: false, message: `전체 구성은 보유 데바니온 ${this.total}개를 정확히 사용해야 합니다.` };
      this.active = proposed;
      return { ok: true, changed: true, message: `모든 보드의 전투력 우선 구성을 적용했습니다. 데바니온 ${cost}개를 전부 사용했습니다.` };
    }

    reset(boardId) {
      if (boardId !== undefined && !this.catalog.has(boardId)) return { ok: false, message: '유효한 보드를 선택하십시오.' };
      if (boardId === undefined) for (const active of this.active.values()) active.clear();
      else this.active.get(boardId)?.clear();
      return { ok: true, changed: true, message: boardId === undefined ? '전체 보드를 초기화했습니다.' : '이 보드를 초기화했습니다.' };
    }
  }

  function read(storage) {
    try { return JSON.parse((storage ?? scope.localStorage).getItem(STORAGE_KEY)); } catch { return null; }
  }

  function write(storage, planner) {
    try { (storage ?? scope.localStorage).setItem(STORAGE_KEY, JSON.stringify(planner.snapshot())); return true; } catch { return false; }
  }

  function setContext(suffix = '') { STORAGE_KEY = `daevanion-planner:v2${suffix}`; }
  const api = { Planner, COSTS, STATE_VERSION, planningBudget, get STORAGE_KEY() { return STORAGE_KEY; }, setContext, read, write };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionPlanner = api;
})(typeof window !== 'undefined' ? window : globalThis);
