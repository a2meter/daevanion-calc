'use strict';

((scope) => {
  const { COSTS, planningBudget } = typeof module !== 'undefined' && module.exports
    ? require('./planner.js') : scope.DaevanionPlanner;
  const EPS = 1e-6;
  const key = node => JSON.stringify([node.grade, node.type, node.name,
    node.effectList.map(effect => effect.desc).filter(Boolean)]);
  const fail = message => { throw new Error(message); };

  function createProblem(boards, values) {
    if (!Array.isArray(boards) || !boards.length) fail('보드 데이터가 없습니다.');
    const nodes = [], byId = new Map(), graphs = [];
    let budget = 0;
    for (const board of boards) {
      const source = board.nodes.filter(node => node.type !== 'None');
      const roots = source.filter(node => node.row === 8 && node.col === 8 && node.type === 'Start');
      if (roots.length !== 1 || source.filter(node => node.type === 'Start').length !== 1) fail('보드의 루트를 확인할 수 없습니다.');
      const positions = new Map();
      const graph = { id: board.id, name: board.name, file: board.file, nodes: [], root: null };
      if (graphs.some(item => item.id === board.id)) fail('보드 번호가 중복되었습니다.');
      for (const raw of source) {
        if (!Number.isSafeInteger(raw.nodeId) || byId.has(raw.nodeId) || positions.has(`${raw.row},${raw.col}`)) fail('노드 번호 또는 위치가 중복되었습니다.');
        const root = raw === roots[0];
        const optionKey = root ? null : key(raw);
        // Skill CP is a user-confirmed rule, independent of editable inputs.
        const measuredPower = root ? 0 : raw.type === 'SkillLevel' && raw.grade === 'Rare' ? 200
          : raw.type === 'SkillLevel' && raw.grade === 'Legend' ? 100 : values?.[optionKey];
        const unknown = board.id === 79 && measuredPower === undefined;
        const power = unknown ? 0 : measuredPower;
        if (!Number.isFinite(power) || power < 0) fail(`${raw.name}의 전투력값을 입력하십시오.`);
        if (!root && !COSTS[raw.grade]) fail('노드 소모량을 확인할 수 없습니다.');
        const node = { ...raw, index: nodes.length, boardId: board.id, root, key: optionKey,
          power, unknown, cost: root ? 0 : COSTS[raw.grade], neighbors: [] };
        nodes.push(node); graph.nodes.push(node); byId.set(node.nodeId, node);
        positions.set(`${node.row},${node.col}`, node);
        if (root) graph.root = node;
        else if (node.open === 1) budget += node.cost;
      }
      for (const node of graph.nodes) {
        node.neighbors = [[node.row - 1, node.col], [node.row + 1, node.col],
          [node.row, node.col - 1], [node.row, node.col + 1]]
          .map(([r, c]) => positions.get(`${r},${c}`)).filter(Boolean).map(item => item.index);
      }
      graphs.push(graph);
    }
    const allPower = nodes.reduce((sum, node) => sum + node.power, 0);
    if (!Number.isFinite(allPower) || allPower > 1e12) fail('전투력 합계가 계산 범위를 초과했습니다. 입력값을 확인하십시오.');
    const sourceBudget = budget;
    budget = planningBudget(sourceBudget);
    const signature = JSON.stringify([budget, graphs.map(g => g.id), nodes.map(n =>
      [n.nodeId, n.boardId, n.row, n.col, n.root, n.cost, n.power, n.open, n.key, n.unknown])]);
    return { nodes, byId, graphs, budget, sourceBudget, allPower, signature };
  }

  function validate(problem, selections) {
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)
      || Object.keys(selections).length !== problem.graphs.length) return null;
    let cost = 0, power = 0;
    const selected = new Set();
    for (const graph of problem.graphs) {
      const ids = selections[graph.id];
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return null;
      const requested = new Set();
      for (const id of ids) {
        const node = problem.byId.get(id);
        if (!node || node.root || node.boardId !== graph.id) return null;
        requested.add(node.index); selected.add(node.index);
        cost += node.cost; power += node.power;
      }
      const seen = new Set([graph.root.index]), queue = [graph.root.index];
      for (const index of queue) for (const next of problem.nodes[index].neighbors) {
        if (requested.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
      if (seen.size !== requested.size + 1) return null;
    }
    return cost === problem.budget ? { selections, selected, cost, power } : null;
  }

  function sourceSelections(problem) {
    return Object.fromEntries(problem.graphs.map(graph => [graph.id,
      graph.nodes.filter(node => !node.root && node.open === 1).map(node => node.nodeId)]));
  }

  function selectionsFromVector(problem, vector) {
    if (!vector || vector.length < problem.nodes.length) return null;
    const result = Object.fromEntries(problem.graphs.map(graph => [graph.id, []]));
    for (const node of problem.nodes) {
      const value = vector[node.index];
      if (!Number.isFinite(value) || Math.abs(value - Math.round(value)) > EPS || value < -EPS || value > 1 + EPS) return null;
      if (node.root) { if (value < 1 - EPS) return null; }
      else if (value > .5) result[node.boardId].push(node.nodeId);
    }
    return result;
  }

  // A single-commodity flow per board proves root connectivity. Every selected
  // nonroot consumes one unit, and only that board's root can supply it.
  function buildModel(problem, highs) {
    const count = problem.nodes.length, edges = [];
    for (const node of problem.nodes) for (const next of node.neighbors) edges.push([node.index, next]);
    const size = count + edges.length;
    const colCost = new Float64Array(size), colLower = new Float64Array(size), colUpper = new Float64Array(size);
    const integrality = new Uint8Array(size);
    const capacities = new Map(problem.graphs.map(graph => [graph.id, graph.nodes.length - 1]));
    const rows = [], rowLower = [], rowUpper = [];
    const row = (entries, low, high) => { rows.push(entries); rowLower.push(low); rowUpper.push(high); };
    const balances = problem.nodes.map(() => []);
    for (const node of problem.nodes) {
      colCost[node.index] = node.power;
      colUpper[node.index] = 1;
      integrality[node.index] = highs.constants.variableType.integer;
      if (node.root) colLower[node.index] = 1;
    }
    row(problem.nodes.filter(node => !node.root).map(node => [node.index, node.cost]), problem.budget, problem.budget);
    for (const node of problem.nodes) if (!node.root) {
      row([[node.index, 1], ...node.neighbors.map(next => [next, -1])], -Infinity, 0);
    }
    // Removing an articulation vertex exposes nodes that require that vertex.
    for (const graph of problem.graphs) for (const separator of graph.nodes) {
      if (separator.root) continue;
      const seen = new Set([graph.root.index]), queue = [graph.root.index];
      for (const index of queue) for (const next of problem.nodes[index].neighbors) {
        if (next !== separator.index && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
      for (const node of graph.nodes) if (node !== separator && !seen.has(node.index)) {
        row([[node.index, 1], [separator.index, -1]], -Infinity, 0);
      }
    }
    edges.forEach(([from, to], offset) => {
      const col = count + offset, cap = capacities.get(problem.nodes[from].boardId);
      colUpper[col] = cap;
      row([[col, 1], [from, -cap]], -Infinity, 0);
      row([[col, 1], [to, -cap]], -Infinity, 0);
      balances[from].push([col, -1]); balances[to].push([col, 1]);
    });
    for (const graph of problem.graphs) for (const node of graph.nodes) {
      row([...balances[node.index], ...(node.root
        ? graph.nodes.filter(other => !other.root).map(other => [other.index, 1]) : [[node.index, -1]])], 0, 0);
    }
    const starts = [0], indices = [], coefficients = [];
    for (const entries of rows) {
      for (const [col, value] of entries) if (value !== 0) { indices.push(col); coefficients.push(value); }
      starts.push(indices.length);
    }
    return { edges, data: { numCols: size, numRows: rows.length, sense: highs.constants.objectiveSense.maximize,
      colCost, colLower, colUpper, integrality, rowLower, rowUpper,
      matrix: { format: 'csr', numRows: rows.length, numCols: size, starts, indices, values: coefficients } } };
  }

  function startVector(problem, edges, checked) {
    const values = new Float64Array(problem.nodes.length + edges.length);
    const edgeIndex = new Map(edges.map(([a, b], index) => [`${a},${b}`, problem.nodes.length + index]));
    for (const graph of problem.graphs) {
      const seen = new Set([graph.root.index]), queue = [graph.root.index], parent = new Map();
      for (const index of queue) for (const next of problem.nodes[index].neighbors) {
        if (checked.selected.has(next) && !seen.has(next)) { seen.add(next); parent.set(next, index); queue.push(next); }
      }
      const subtotal = new Map(queue.map(index => [index, index === graph.root.index ? 0 : 1]));
      for (const index of [...queue].reverse()) {
        values[index] = 1;
        if (!parent.has(index)) continue;
        const p = parent.get(index), flow = subtotal.get(index);
        values[edgeIndex.get(`${p},${index}`)] = flow;
        subtotal.set(p, subtotal.get(p) + flow);
      }
    }
    return values;
  }

  function solve(problem, highs, { candidates = [], certificate = null, seconds = 30, progress = () => {} } = {}) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) fail('계산 시간을 확인하십시오.');
    let best = null;
    for (const selection of [sourceSelections(problem), ...candidates]) {
      const checked = validate(problem, selection);
      if (checked && (!best || checked.power > best.power)) best = checked;
    }
    // A proved result applies only to the identical graph, costs, budget and
    // every CP coefficient. Editing even one value invalidates this reuse.
    if (certificate?.status === 'optimal' && certificate.signature === problem.signature) {
      const witness = validate(problem, certificate.selections);
      if (!witness || !Number.isFinite(certificate.power) || Math.abs(witness.power - certificate.power) > EPS
        || !Number.isFinite(certificate.upperBound) || Math.abs(certificate.upperBound - witness.power) > EPS
        || (best && best.power > witness.power + EPS)) fail('기존 최고값 검증 결과가 현재 모형과 일치하지 않습니다.');
      return { ...certificate, selections: witness.selections, gap: 0, status: 'optimal' };
    }
    const { data, edges } = buildModel(problem, highs);
    const model = highs.createModel(data);
    let upperBound = problem.allPower;
    const accept = vector => {
      const selections = selectionsFromVector(problem, vector);
      const checked = selections && validate(problem, selections);
      if (checked && (!best || checked.power > best.power + EPS)) best = checked;
    };
    const bound = value => { if (Number.isFinite(value) && value >= (best?.power ?? 0) - EPS) upperBound = Math.min(upperBound, Math.max(best?.power ?? 0, value)); };
    let lastProgress = 0;
    try {
      model.options.set({ output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0, time_limit: seconds });
      if (best) model.setSolution({ colValue: startVector(problem, edges, best) });
      const report = event => {
        if (event.data.mip_solution) accept(event.data.mip_solution);
        bound(event.data.mip_dual_bound);
        const now = Date.now();
        if (now - lastProgress >= 250) { progress({ power: best?.power, upperBound, message: '루트 연결과 전량 사용을 만족하는 구성을 찾고 있습니다.' }); lastProgress = now; }
      };
      model.run({ [highs.constants.callbackType.mipImprovingSolution]: report,
        [highs.constants.callbackType.mipLogging]: report });
      if (model.info.get('primal_solution_status') === highs.constants.solutionStatus.feasible) {
        accept(model.getSolution().colValue);
      }
      bound(model.info.get('mip_dual_bound'));
    } finally { model.dispose(); }
    if (!best) fail('계산 시간 안에 전량 사용과 루트 연결을 만족하는 구성을 찾지 못했습니다. 계산 시간을 늘려 다시 실행하십시오.');
    // Integral objective values permit a valid integer upper bound. Decimal
    // inputs retain the original bound; they must never be rounded to CP units.
    if (problem.nodes.every(node => Number.isInteger(node.power))) upperBound = Math.floor(upperBound + EPS);
    upperBound = Math.max(best.power, upperBound);
    const proven = upperBound - best.power <= EPS;
    return { selections: Object.fromEntries(Object.entries(best.selections).map(([id, ids]) => [id, [...ids].sort((a, b) => a - b)])),
      power: best.power, upperBound, status: proven ? 'optimal' : 'feasible', signature: problem.signature,
      gap: (upperBound - best.power) / Math.max(1, Math.abs(best.power)), solver: `HiGHS ${highs.version.string} / WebAssembly` };
  }

  function summarize(problem, solution, observations = []) {
    const checked = validate(problem, solution?.selections);
    if (!checked || solution.signature !== problem.signature || !Number.isFinite(solution.upperBound)
      || solution.upperBound < checked.power - EPS || !Number.isFinite(solution.power) || Math.abs(solution.power - checked.power) > EPS
      || !['feasible', 'optimal'].includes(solution.status)
      || (solution.status === 'optimal' && Math.abs(solution.upperBound - checked.power) > EPS)) fail('재계산 결과의 연결, 수량 또는 전투력 검증에 실패했습니다.');
    const records = new Map(observations.map(record => [record.key, record]));
    const plans = {}, slack = Math.max(0, solution.upperBound - checked.power);
    const sharedGap = slack / Math.max(1, Math.abs(checked.power));
    const order = ['추가 공격력', '추가 방어력', '치명타', '치명타 저항', '생명력', '정신력', '전투 속도', '재시전 시간 감소'];
    for (const graph of problem.graphs) {
      const active = new Set(solution.selections[graph.id]), groups = new Map(), stats = new Map();
      let cost = 0, power = 0, sourceBudget = 0, sourcePower = 0;
      for (const node of graph.nodes) {
        if (node.root) continue;
        const source = node.open === 1, target = active.has(node.nodeId);
        if (source) { sourceBudget += node.cost; sourcePower += node.power; }
        if (target) {
          cost += node.cost; power += node.power;
          if (!groups.has(node.key)) {
            const record = records.get(node.key);
            groups.set(node.key, { key: node.key, name: node.name, grade: node.grade,
              effects: node.effectList.map(effect => effect.desc).filter(Boolean), count: 0, cost: 0,
              power: node.unknown ? null : node.power,
              basis: node.unknown ? 'unknown' : record?.power === node.power ? record.basis : 'edited' });
          }
          const group = groups.get(node.key); group.count++; group.cost += node.cost;
        }
        if (node.type !== 'Stat') continue;
        const effects = node.effectList.map(effect => effect.desc).filter(Boolean);
        for (const effect of effects) {
          const match = effect.match(/^(.*?)\s+([+-][\d.,]+)(%?)$/);
          if (!match) continue;
          const [, name, raw, unit] = match, statKey = `${name}:${unit}`, value = Number(raw.replaceAll(',', ''));
          if (!stats.has(statKey)) stats.set(statKey, { name, unit, source: 0, target: 0, sourcePower: 0, targetPower: 0, known: true });
          const stat = stats.get(statKey);
          if (source) { stat.source += value; stat.sourcePower += node.power; }
          if (target) { stat.target += value; stat.targetPower += node.power; }
          if ((source || target) && (effects.length !== 1 || node.unknown)) stat.known = false;
        }
      }
      const seen = new Set([graph.root.index]), queue = [graph.root.index], activationOrder = [];
      for (const index of queue) for (const next of [...problem.nodes[index].neighbors].sort((a, b) => a - b)) {
        const node = problem.nodes[next];
        if (active.has(node.nodeId) && !seen.has(next)) {
          seen.add(next); queue.push(next);
          activationOrder.push({ nodeId: node.nodeId, col: node.col, row: node.row, name: node.name, grade: node.grade });
        }
      }
      const statComparison = [...stats.values()].sort((a, b) => {
        const rank = name => order.includes(name) ? order.indexOf(name) : order.length;
        return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'ko');
      }).map(stat => ({ name: stat.name, unit: stat.unit, source: stat.source, target: stat.target,
        difference: stat.target - stat.source, powerDifference: stat.known ? stat.targetPower - stat.sourcePower : null }));
      const skillsUnchanged = graph.nodes.filter(node => node.type === 'SkillLevel').every(node => (node.open === 1) === active.has(node.nodeId));
      plans[graph.id] = { boardId: graph.id, name: graph.name, budget: cost, cost, sourceBudget, sourcePower, power,
        unknownCount: new Set(graph.nodes.filter(node => node.unknown).map(node => node.key)).size,
        nodeIds: [...active].sort((a, b) => a - b), groups: [...groups.values()].sort((a, b) => b.power - a.power || a.key.localeCompare(b.key)),
        activationOrder, statComparison, skillsUnchanged, powerUpperBound: power + slack,
        optimality: { status: solution.status, gap: slack / Math.max(1, power), sharedGap, scope: 'shared', solver: solution.solver } };
    }
    const sourcePower = Object.values(plans).reduce((sum, plan) => sum + plan.sourcePower, 0);
    return { budget: problem.budget, cost: checked.cost, power: checked.power, sourcePower,
      powerDifference: checked.power - sourcePower, powerUpperBound: solution.upperBound,
      nodeCount: checked.selected.size, boards: plans,
      unknownCount: new Set(problem.nodes.filter(node => node.unknown).map(node => node.key)).size,
      optimality: { status: solution.status, gap: sharedGap, solver: solution.solver } };
  }

  function summarizeSource(problem, observations = []) {
    // Preserve the source activation when the update increases the planning budget.
    // Only this source report may use the original budget; solved plans still require
    // the full planning budget through validate() and summarize().
    const sourceProblem = { ...problem, budget: problem.sourceBudget };
    const selections = sourceSelections(problem), checked = validate(sourceProblem, selections);
    if (!checked) fail('원본 보드의 연결을 확인할 수 없습니다.');
    const plan = summarize(sourceProblem, { selections, signature: problem.signature,
      power: checked.power, upperBound: problem.allPower, status: 'feasible', solver: '캐릭터 원본 보드' }, observations);
    if (problem.sourceBudget !== problem.budget) {
      plan.budget = problem.budget;
      plan.pending = true;
      plan.optimality.status = 'pending';
      for (const board of Object.values(plan.boards)) { board.pending = true; board.optimality.status = 'pending'; }
    }
    return plan;
  }

  const api = { key, createProblem, validate, sourceSelections, buildModel, startVector, selectionsFromVector, solve, summarize, summarizeSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionOptimizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
