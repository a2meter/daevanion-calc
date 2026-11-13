'use strict';

((scope) => {
  const { COSTS, planningBudget } = typeof module !== 'undefined' && module.exports
    ? require('./planner.js') : scope.DaevanionPlanner;
  const EPS = 1e-6;
  const key = node => JSON.stringify([node.grade, node.type, node.name,
    node.effectList.map(effect => effect.desc).filter(Boolean)]);
  const fail = message => { throw new Error(message); };

  // Exact CP of a set of node indexes. Boards are added in order and each
  // board's nodes by nodeId, so the same set always gives the same number and
  // the board subtotals add up to the total. A levelled skill is worth the first
  // c values of its sequence when c of its nodes are taken; in the same order,
  // its j-th taken node is credited with the j-th value (`worth`, when given).
  function score(problem, taken, worth = null) {
    const counts = problem.skills.map(() => 0), boards = {};
    let power = 0;
    for (const graph of problem.graphs) {
      let subtotal = 0;
      for (const node of graph.sorted) {
        if (!taken.has(node.index)) continue;
        const value = node.skill < 0 ? node.power : problem.skills[node.skill].values[counts[node.skill]++];
        subtotal += value;
        if (worth) worth.set(node.index, value);
      }
      boards[graph.id] = subtotal;
      power += subtotal;
    }
    return { power, boards };
  }

  // `required` lists, per board, the nodes every recalculated plan must contain.
  // `skills` maps an option key to the CP gained by the first, second, ... node
  // of that skill opened on any board. Its value depends on how many of its
  // nodes are taken, not on which ones.
  function createProblem(boards, values, { required = null, skills = null } = {}) {
    if (!Array.isArray(boards) || !boards.length) fail('보드 데이터가 없습니다.');
    if (skills !== null && skills !== undefined && (typeof skills !== 'object' || Array.isArray(skills))) fail('스킬 레벨별 전투력값이 올바르지 않습니다.');
    const nodes = [], byId = new Map(), graphs = [], levelled = new Map();
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
        const levels = !root && raw.type === 'SkillLevel' ? skills?.[optionKey] : undefined;
        // Without a level sequence, skill CP is a user-confirmed rule, independent of editable inputs.
        const measuredPower = root || levels !== undefined ? 0 : raw.type === 'SkillLevel' && raw.grade === 'Rare' ? 200
          : raw.type === 'SkillLevel' && raw.grade === 'Legend' ? 100 : values?.[optionKey];
        const unknown = board.id === 79 && measuredPower === undefined;
        const power = unknown ? 0 : measuredPower;
        if (!Number.isFinite(power) || power < 0) fail(`${raw.name}의 전투력값을 입력하십시오.`);
        if (!root && !COSTS[raw.grade]) fail('노드 소모량을 확인할 수 없습니다.');
        if (levels !== undefined && !levelled.has(optionKey)) levelled.set(optionKey, { key: optionKey, values: levels, nodes: [], index: levelled.size });
        const node = { ...raw, index: nodes.length, boardId: board.id, root, key: optionKey, power, unknown,
          skill: levels === undefined ? -1 : levelled.get(optionKey).index,
          cost: root ? 0 : COSTS[raw.grade], neighbors: [], required: false };
        if (node.skill >= 0) levelled.get(optionKey).nodes.push(node.index);
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
      graph.sorted = graph.nodes.filter(node => !node.root).sort((a, b) => a.nodeId - b.nodeId);
      graphs.push(graph);
    }
    const levels = [...levelled.values()];
    for (const skill of levels) {
      const count = skill.nodes.length;
      if (!Array.isArray(skill.values) || skill.values.length < count
        || skill.values.some(value => !Number.isFinite(value) || value < 0)) fail(`${nodes[skill.nodes[0]].name}의 레벨별 전투력값을 확인하십시오.`);
      skill.values = skill.values.slice(0, count);
      // Path and trade heuristics rank a node of this skill by the sequence
      // average. Every result is still accepted or rejected by score().
      const average = skill.values.reduce((sum, value) => sum + value, 0) / count;
      for (const index of skill.nodes) nodes[index].power = average;
    }
    // No value is negative, so taking every node gives the highest possible score.
    const allPower = score({ graphs, skills: levels }, new Set(nodes.keys())).power;
    if (!Number.isFinite(allPower) || allPower > 1e12) fail('전투력 합계가 계산 범위를 초과했습니다. 입력값을 확인하십시오.');
    const integral = nodes.every(node => node.skill >= 0 || Number.isInteger(node.power))
      && levels.every(skill => skill.values.every(Number.isInteger));
    const sourceBudget = budget;
    budget = planningBudget(sourceBudget);
    const pinned = [];
    if (required !== null && required !== undefined) {
      if (typeof required !== 'object' || Array.isArray(required)) fail('필수 노드 지정이 올바르지 않습니다.');
      for (const [boardId, ids] of Object.entries(required)) {
        if (!Array.isArray(ids)) fail('필수 노드 지정이 올바르지 않습니다.');
        for (const id of ids) {
          const node = byId.get(id);
          if (!node || node.root || String(node.boardId) !== boardId) fail('필수 노드 지정이 올바르지 않습니다.');
          if (!node.required) { node.required = true; pinned.push(node.index); }
        }
      }
    }
    pinned.sort((a, b) => a - b);
    // Without required nodes or level sequences the signature keeps its earlier
    // form, so results saved before these options existed still match their model.
    // Required nodes are appended as a list and sequences as an object.
    const model = [budget, graphs.map(g => g.id), nodes.map(n =>
      [n.nodeId, n.boardId, n.row, n.col, n.root, n.cost, n.skill < 0 ? n.power : null, n.open, n.key, n.unknown])];
    if (pinned.length) model.push(pinned.map(index => nodes[index].nodeId));
    if (levels.length) model.push({ skills: levels.map(skill => [skill.key, skill.values]) });
    return { nodes, byId, graphs, skills: levels, budget, sourceBudget, allPower, integral, signature: JSON.stringify(model), required: pinned,
      requiredCost: pinned.reduce((sum, index) => sum + nodes[index].cost, 0) };
  }

  function validate(problem, selections) {
    if (!selections || typeof selections !== 'object' || Array.isArray(selections)
      || Object.keys(selections).length !== problem.graphs.length) return null;
    let cost = 0;
    const selected = new Set();
    for (const graph of problem.graphs) {
      const ids = selections[graph.id];
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return null;
      const requested = new Set();
      for (const id of ids) {
        const node = problem.byId.get(id);
        if (!node || node.root || node.boardId !== graph.id) return null;
        requested.add(node.index); selected.add(node.index);
        cost += node.cost;
      }
      const seen = new Set([graph.root.index]), queue = [graph.root.index];
      for (const index of queue) for (const next of problem.nodes[index].neighbors) {
        if (requested.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
      if (seen.size !== requested.size + 1) return null;
    }
    if (problem.required.some(index => !selected.has(index))) return null;
    return cost === problem.budget ? { selections, selected, cost, power: score(problem, selected).power } : null;
  }

  // Cheapest way to reach every node of one board from the root and the nodes
  // already taken: only nodes outside `active` cost anything. Ties prefer the
  // path that collects more CP.
  function cheapestPaths(problem, graph, active) {
    const cost = new Map(), power = new Map(), previous = new Map(), done = new Set();
    for (const node of graph.nodes) if (node.root || active.has(node.index)) { cost.set(node.index, 0); power.set(node.index, 0); }
    for (;;) {
      let current = -1;
      for (const index of cost.keys()) {
        if (done.has(index)) continue;
        if (current < 0 || cost.get(index) < cost.get(current)
          || (cost.get(index) === cost.get(current) && power.get(index) > power.get(current))) current = index;
      }
      if (current < 0) break;
      done.add(current);
      for (const next of problem.nodes[current].neighbors) {
        if (done.has(next) || cost.get(next) === 0) continue;
        const node = problem.nodes[next], nextCost = cost.get(current) + node.cost, nextPower = power.get(current) + node.power;
        if (!cost.has(next) || nextCost < cost.get(next) || (nextCost === cost.get(next) && nextPower > power.get(next))) {
          cost.set(next, nextCost); power.set(next, nextPower); previous.set(next, current);
        }
      }
    }
    const path = index => {
      const steps = [];
      for (let at = index; previous.has(at); at = previous.get(at)) steps.push(at);
      return steps;
    };
    return { cost, power, path };
  }

  // Any connected plan must pay for each board's required nodes and for a full
  // path to its farthest one, whichever is larger.
  function requiredLowerBound(problem) {
    let bound = 0;
    for (const graph of problem.graphs) {
      const pins = problem.required.filter(index => problem.nodes[index].boardId === graph.id);
      if (!pins.length) continue;
      const { cost } = cheapestPaths(problem, graph, new Set());
      if (pins.some(index => !cost.has(index))) return Infinity;
      bound += Math.max(pins.reduce((sum, index) => sum + problem.nodes[index].cost, 0), ...pins.map(index => cost.get(index)));
    }
    return bound;
  }

  // Taken nodes that can be given back alone: not required, and no other taken
  // node reaches the root only through them (not a cut vertex of the layout).
  function removableNodes(problem, graph, taken) {
    const order = new Map(), low = new Map(), cut = new Set();
    const visit = (index, parent) => {
      order.set(index, order.size); low.set(index, order.get(index));
      for (const next of problem.nodes[index].neighbors) {
        if (next === parent || (next !== graph.root.index && !taken.has(next))) continue;
        if (order.has(next)) { low.set(index, Math.min(low.get(index), order.get(next))); continue; }
        visit(next, index);
        low.set(index, Math.min(low.get(index), low.get(next)));
        if (low.get(next) >= order.get(index)) cut.add(index);
      }
    };
    visit(graph.root.index, -1);
    return [...taken].filter(index => !cut.has(index) && !problem.nodes[index].required);
  }

  // Builds a starting plan from any layout: connect each required node by its
  // cheapest path, give back the least valuable removable nodes while over the
  // budget, then spend what remains on the best reachable paths. It is a
  // heuristic; validate() decides whether the result may be used.
  function repair(problem, selections) {
    const active = new Map(problem.graphs.map(graph => {
      const requested = new Set();
      for (const id of Array.isArray(selections?.[graph.id]) ? selections[graph.id] : []) {
        const node = problem.byId.get(id);
        if (node && !node.root && node.boardId === graph.id) requested.add(node.index);
      }
      const kept = new Set(), queue = [graph.root.index];
      for (const index of queue) for (const next of problem.nodes[index].neighbors) {
        if (requested.has(next) && !kept.has(next)) { kept.add(next); queue.push(next); }
      }
      return [graph.id, kept];
    }));
    let spent = 0;
    for (const nodes of active.values()) for (const index of nodes) spent += problem.nodes[index].cost;
    const add = (graph, indexes) => { for (const index of indexes) { active.get(graph.id).add(index); spent += problem.nodes[index].cost; } };

    for (const graph of problem.graphs) {
      const taken = active.get(graph.id);
      const pins = problem.required.filter(index => problem.nodes[index].boardId === graph.id);
      while (pins.some(index => !taken.has(index))) {
        const { cost, path } = cheapestPaths(problem, graph, taken);
        const missing = pins.filter(index => !taken.has(index));
        if (missing.some(index => !cost.has(index))) return null;
        add(graph, path(missing.reduce((best, index) => cost.get(index) < cost.get(best) ? index : best)));
      }
    }

    const removable = graph => removableNodes(problem, graph, active.get(graph.id));
    const worth = index => problem.nodes[index].power / problem.nodes[index].cost;
    const loose = new Map();
    while (spent > problem.budget) {
      let worst = -1, worstGraph = null;
      for (const graph of problem.graphs) {
        if (!loose.has(graph.id)) loose.set(graph.id, removable(graph));
        for (const index of loose.get(graph.id)) {
          if (worst < 0 || worth(index) < worth(worst) || (worth(index) === worth(worst) && index < worst)) { worst = index; worstGraph = graph; }
        }
      }
      if (worst < 0) return null;
      active.get(worstGraph.id).delete(worst);
      spent -= problem.nodes[worst].cost;
      loose.delete(worstGraph.id);
    }

    const reach = new Map();
    while (spent < problem.budget) {
      const room = problem.budget - spent;
      let target = -1, targetGraph = null, targetWorth = -1, targetCost = Infinity;
      for (const graph of problem.graphs) {
        if (!reach.has(graph.id)) reach.set(graph.id, cheapestPaths(problem, graph, active.get(graph.id)));
        const { cost, power } = reach.get(graph.id);
        for (const [index, price] of cost) {
          if (price === 0 || price > room) continue;
          const value = power.get(index) / price;
          if (value > targetWorth || (value === targetWorth && price < targetCost)) {
            target = index; targetGraph = graph; targetWorth = value; targetCost = price;
          }
        }
      }
      if (target < 0) return null;
      add(targetGraph, reach.get(targetGraph.id).path(target));
      reach.delete(targetGraph.id);
    }
    return Object.fromEntries(problem.graphs.map(graph =>
      [graph.id, [...active.get(graph.id)].map(index => problem.nodes[index].nodeId)]));
  }

  // Local search on a valid plan: pull in one more reachable node with its
  // cheapest path, let repair() give back the least valuable nodes for it, and
  // keep the trade whenever the total rises. Stops at a local optimum or the deadline.
  function improve(problem, start, deadline = Infinity) {
    let best = start;
    for (let improved = true; improved && Date.now() < deadline;) {
      improved = false;
      const trials = [];
      for (const graph of problem.graphs) {
        const taken = new Set(best.selections[graph.id].map(id => problem.byId.get(id).index));
        const { cost, power, path } = cheapestPaths(problem, graph, taken);
        for (const [index, price] of cost) if (price > 0) trials.push({ graph, index, path, price, worth: power.get(index) / price });
      }
      trials.sort((a, b) => b.worth - a.worth || a.price - b.price || a.index - b.index);
      for (const trial of trials) {
        if (Date.now() >= deadline) break;
        const added = trial.path(trial.index).map(index => problem.nodes[index].nodeId);
        const checked = validate(problem, repair(problem,
          { ...best.selections, [trial.graph.id]: [...best.selections[trial.graph.id], ...added] }));
        if (checked && checked.power > best.power + EPS) { best = checked; improved = true; break; }
      }
    }
    return best;
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
    const steps = count + edges.length;
    const size = steps + problem.skills.reduce((sum, skill) => sum + skill.values.length, 0);
    const colCost = new Float64Array(size), colLower = new Float64Array(size), colUpper = new Float64Array(size);
    const integrality = new Uint8Array(size);
    const capacities = new Map(problem.graphs.map(graph => [graph.id, graph.nodes.length - 1]));
    const rows = [], rowLower = [], rowUpper = [];
    const row = (entries, low, high) => { rows.push(entries); rowLower.push(low); rowUpper.push(high); };
    const balances = problem.nodes.map(() => []);
    for (const node of problem.nodes) {
      colCost[node.index] = node.skill < 0 ? node.power : 0;
      colUpper[node.index] = 1;
      integrality[node.index] = highs.constants.variableType.integer;
      // Required nodes are fixed on; the flow rows then force their path to the root.
      if (node.root || node.required) colLower[node.index] = 1;
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
    // A levelled skill is paid per step instead of per node: step j is on exactly
    // when at least j of its nodes are taken and carries the j-th value.
    let column = steps;
    for (const skill of problem.skills) {
      const first = column;
      for (const value of skill.values) {
        colCost[column] = value; colUpper[column] = 1;
        integrality[column++] = highs.constants.variableType.integer;
      }
      row([...skill.nodes.map(index => [index, 1]), ...skill.values.map((_, step) => [first + step, -1])], 0, 0);
      for (let next = first + 1; next < column; next++) row([[next, 1], [next - 1, -1]], -Infinity, 0);
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
    const steps = problem.nodes.length + edges.length;
    const values = new Float64Array(steps + problem.skills.reduce((sum, skill) => sum + skill.values.length, 0));
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
    let column = steps;
    for (const skill of problem.skills) {
      const taken = skill.nodes.filter(index => checked.selected.has(index)).length;
      skill.values.forEach((_, step) => { values[column++] = step < taken ? 1 : 0; });
    }
    return values;
  }

  function solve(problem, highs, { candidates = [], certificate = null, seconds = 30, progress = () => {} } = {}) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) fail('계산 시간을 확인하십시오.');
    const started = Date.now(), until = share => started + seconds * 1000 * share;
    const pinned = problem.required.length;
    const needed = requiredLowerBound(problem);
    if (needed > problem.budget) {
      fail(Number.isFinite(needed)
        ? `필수 노드 ${pinned}개를 루트와 연결하려면 데바니온이 최소 ${needed}개 필요합니다. 계산용 수량 ${problem.budget}개로는 구성할 수 없으므로 필수 지정을 줄이십시오.`
        : '루트와 연결할 수 없는 필수 노드가 있습니다. 필수 지정을 확인하십시오.');
    }
    let best = null;
    const starts = new Map();
    const consider = selection => {
      const checked = validate(problem, selection);
      if (!checked) return null;
      starts.set(problem.graphs.map(graph => [...checked.selections[graph.id]].sort((a, b) => a - b).join()).join('|'), checked);
      if (!best || checked.power > best.power) best = checked;
      return checked;
    };
    // Layouts that miss a required node or leave part of the budget unspent are
    // repaired into a usable start instead of being discarded.
    for (const selection of [sourceSelections(problem), ...candidates]) {
      if (!consider(selection)) consider(repair(problem, selection));
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
    // The exact search rarely improves a start within browser time limits, so a
    // local search first settles every distinct start into its local optimum.
    if (seconds > 0) {
      progress({ message: '시작 구성을 다듬고 있습니다.' });
      for (const start of [...starts.values()].sort((a, b) => b.power - a.power)) {
        if (Date.now() >= until(.3)) break;
        const settled = improve(problem, start, until(.3));
        if (settled.power > best.power) best = settled;
      }
    }
    const { data, edges } = buildModel(problem, highs);
    const model = highs.createModel(data);
    let upperBound = problem.allPower, infeasible = false;
    const accept = vector => {
      const selections = selectionsFromVector(problem, vector);
      const checked = selections && validate(problem, selections);
      if (checked && (!best || checked.power > best.power + EPS)) best = checked;
    };
    const bound = value => { if (Number.isFinite(value) && value >= (best?.power ?? 0) - EPS) upperBound = Math.min(upperBound, Math.max(best?.power ?? 0, value)); };
    let lastProgress = 0;
    try {
      // Whatever the start took comes out of the search time; the last tenth is kept for a final pass.
      model.options.set({ output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0,
        time_limit: Math.max(0, (until(.9) - Date.now()) / 1000) });
      if (best) model.setSolution({ colValue: startVector(problem, edges, best) });
      const report = event => {
        if (event.data.mip_solution) accept(event.data.mip_solution);
        bound(event.data.mip_dual_bound);
        const now = Date.now();
        if (now - lastProgress >= 250) { progress({ power: best?.power, upperBound, message: '루트 연결과 전량 사용을 만족하는 구성을 찾고 있습니다.' }); lastProgress = now; }
      };
      const outcome = model.run({ [highs.constants.callbackType.mipImprovingSolution]: report,
        [highs.constants.callbackType.mipLogging]: report });
      infeasible = outcome?.modelStatus === highs.constants.modelStatus.infeasible;
      if (model.info.get('primal_solution_status') === highs.constants.solutionStatus.feasible) {
        accept(model.getSolution().colValue);
      }
      bound(model.info.get('mip_dual_bound'));
    } finally { model.dispose(); }
    if (!best) {
      fail(infeasible
        ? `${pinned ? `필수 노드 ${pinned}개를 모두 포함하면서 ` : ''}데바니온 ${problem.budget}개를 정확히 사용하는 연결 구성이 없습니다.${pinned ? ' 필수 지정을 줄이십시오.' : ''}`
        : `계산 시간 안에 전량 사용과 루트 연결을 만족하는 구성을 찾지 못했습니다. 계산 시간을 늘려 다시 실행하십시오.${pinned ? ' 필수 노드가 많으면 수량이 부족할 수 있습니다.' : ''}`);
    }
    if (seconds > 0) best = improve(problem, best, until(1));
    // Integral objective values permit a valid integer upper bound. Decimal
    // inputs retain the original bound; they must never be rounded to CP units.
    if (problem.integral) upperBound = Math.floor(upperBound + EPS);
    upperBound = Math.max(best.power, upperBound);
    const proven = upperBound - best.power <= EPS;
    return { selections: Object.fromEntries(Object.entries(best.selections).map(([id, ids]) => [id, [...ids].sort((a, b) => a - b)])),
      power: best.power, upperBound, status: proven ? 'optimal' : 'feasible', signature: problem.signature,
      gap: (upperBound - best.power) / Math.max(1, Math.abs(best.power)), solver: `HiGHS ${highs.version.string} / WebAssembly + 개선 탐색` };
  }

  function summarize(problem, solution, observations = []) {
    const checked = validate(problem, solution?.selections);
    if (!checked || solution.signature !== problem.signature || !Number.isFinite(solution.upperBound)
      || solution.upperBound < checked.power - EPS || !Number.isFinite(solution.power) || Math.abs(solution.power - checked.power) > EPS
      || !['feasible', 'optimal'].includes(solution.status)
      || (solution.status === 'optimal' && Math.abs(solution.upperBound - checked.power) > EPS)) fail('재계산 결과의 연결, 수량 또는 전투력 검증에 실패했습니다.');
    const records = new Map(observations.map(record => [record.key, record]));
    // The plan and the source layout are each credited on their own, in score() order.
    const worth = new Map(), planned = score(problem, checked.selected, worth);
    const imported = score(problem, new Set(problem.nodes.filter(node => !node.root && node.open === 1).map(node => node.index)));
    const plans = {}, slack = Math.max(0, solution.upperBound - checked.power);
    const sharedGap = slack / Math.max(1, Math.abs(checked.power));
    const order = ['추가 공격력', '추가 방어력', '치명타', '치명타 저항', '생명력', '정신력', '전투 속도', '재시전 시간 감소'];
    for (const graph of problem.graphs) {
      const active = new Set(solution.selections[graph.id]), groups = new Map(), stats = new Map();
      const power = planned.boards[graph.id];
      let cost = 0, sourceBudget = 0;
      for (const node of graph.nodes) {
        if (node.root) continue;
        const source = node.open === 1, target = active.has(node.nodeId);
        if (source) sourceBudget += node.cost;
        if (target) {
          cost += node.cost;
          if (!groups.has(node.key)) {
            const record = records.get(node.key);
            groups.set(node.key, { key: node.key, name: node.name, grade: node.grade,
              effects: node.effectList.map(effect => effect.desc).filter(Boolean), count: 0, cost: 0,
              power: node.unknown ? null : node.skill < 0 ? node.power : 0,
              basis: node.unknown ? 'unknown' : node.skill >= 0 ? 'level' : record?.power === node.power ? record.basis : 'edited' });
          }
          const group = groups.get(node.key); group.count++; group.cost += node.cost;
          if (node.skill >= 0) group.power += worth.get(node.index);
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
      // A levelled group shows what this board's nodes of the skill were credited with, per node.
      for (const group of groups.values()) if (group.basis === 'level') group.power /= group.count;
      plans[graph.id] = { boardId: graph.id, name: graph.name, budget: cost, cost, sourceBudget, sourcePower: imported.boards[graph.id], power,
        unknownCount: new Set(graph.nodes.filter(node => node.unknown).map(node => node.key)).size,
        nodeIds: [...active].sort((a, b) => a - b),
        requiredNodeIds: graph.nodes.filter(node => node.required).map(node => node.nodeId).sort((a, b) => a - b), groups: [...groups.values()].sort((a, b) => b.power - a.power || a.key.localeCompare(b.key)),
        activationOrder, statComparison, skillsUnchanged, powerUpperBound: power + slack,
        optimality: { status: solution.status, gap: slack / Math.max(1, power), sharedGap, scope: 'shared', solver: solution.solver } };
    }
    return { budget: problem.budget, cost: checked.cost, power: checked.power, sourcePower: imported.power,
      powerDifference: checked.power - imported.power, powerUpperBound: solution.upperBound,
      nodeCount: checked.selected.size, requiredCount: problem.required.length, boards: plans,
      unknownCount: new Set(problem.nodes.filter(node => node.unknown).map(node => node.key)).size,
      optimality: { status: solution.status, gap: sharedGap, solver: solution.solver } };
  }

  function summarizeSource(problem, observations = []) {
    // Preserve the source activation when the update increases the planning budget.
    // Only this source report may use the original budget; solved plans still require
    // the full planning budget through validate() and summarize().
    const sourceProblem = { ...problem, budget: problem.sourceBudget, required: [] };
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

  const api = { key, createProblem, score, validate, sourceSelections, buildModel, startVector, selectionsFromVector,
    requiredLowerBound, repair, improve, solve, summarize, summarizeSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionOptimizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
