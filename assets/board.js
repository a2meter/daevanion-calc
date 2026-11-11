'use strict';

(() => {
  const embedded = new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window;
  document.documentElement.classList.toggle('embedded', embedded);
  document.documentElement.classList.toggle('awaiting-state', embedded);
  document.body.classList.toggle('embedded', embedded);
  const data = JSON.parse(document.getElementById('board-data').textContent);
  const boardId = Number(document.body.dataset.boardId);
  const api = window.DaevanionPlanner;
  const saved = embedded ? null : api.read();
  const planner = new api.Planner(window.DAEVANION_BOARDS, saved);
  if (!embedded && saved?.version !== api.STATE_VERSION) api.write(undefined, planner);
  const grid = document.getElementById('board-grid');
  const viewport = document.getElementById('board-viewport');
  const detail = document.getElementById('node-detail');
  const tooltip = document.getElementById('node-tooltip');
  const notice = document.getElementById('board-notice');
  const zoomValue = document.getElementById('zoom-value');
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const grades = { Common: '일반 스탯', Rare: '패시브 스킬', Legend: '액티브 스킬', Unique: '특수 스탯', None: '루트' };
  const gradeLabel = node => node.type === 'Stat' && node.grade === 'Rare' ? '희귀 스탯'
    : node.type === 'Stat' && node.grade === 'Legend' ? '전설 스탯' : grades[node.grade];
  const nodes = data.nodeList.filter(node => node.type !== 'None').sort((a, b) => a.row - b.row || a.col - b.col);
  const buttons = new Map();
  const targetOrigin = location.protocol === 'file:' ? '*' : location.origin;
  let selectedId = null;
  let zoom = 1;
  let touchInput = false;
  let ready = !embedded;
  let transition = null;
  let transitionKey = null;
  let nodeSteps = new Map();
  const resources = embedded ? null : window.DaevanionResources(document.querySelector('.resource-panel'), planner, act);

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function isRoot(node) { return node.row === 8 && node.col === 8; }
  function effects(node) { return node.effectList.map(effect => effect.desc).filter(Boolean); }
  function status(node) { return isRoot(node) ? '활성화할 수 없는 루트' : planner.isActive(boardId, node.nodeId) ? '활성' : '비활성'; }
  function iconPath(node) {
    return isRoot(node) ? window.DaevanionCharacters.rootIcon(window.DAEVANION_CHARACTER, data.sourceBoardId)
      : `assets/board_icon_${node.grade.toLowerCase()}${planner.isActive(boardId, node.nodeId) ? '_open' : ''}.png`;
  }

  function updateTransition() {
    const state = planner.snapshot(), key = JSON.stringify(state.boards);
    if (key === transitionKey) return;
    transitionKey = key;
    if (!embedded) transition = window.DaevanionTransition.plan(window.DAEVANION_BOARDS, state);
    nodeSteps = new Map();
    if (transition?.ok) for (const step of transition.steps) if (step.boardId === boardId) {
      if (!nodeSteps.has(step.nodeId)) nodeSteps.set(step.nodeId, []);
      nodeSteps.get(step.nodeId).push(step);
    }
    for (const node of nodes) {
      const button = buttons.get(node.nodeId);
      button.querySelector('.node-step-badges')?.remove();
      const steps = nodeSteps.get(node.nodeId);
      if (!steps?.length) continue;
      const badges = make('span', 'node-step-badges');
      badges.setAttribute('aria-hidden', 'true');
      for (const step of steps) badges.append(make('span', `node-step-badge ${step.action === 'deactivate' ? 'step-remove' : 'step-add'}`, String(step.order)));
      button.append(badges);
    }
  }

  function act(action, value) {
    if (!ready) return;
    if (embedded) {
      window.parent.postMessage({ type: 'daevanion:action', boardId, action, nodeId: value }, targetOrigin);
      return;
    }
    let result;
    if (action === 'toggle') result = planner.toggle(boardId, value);
    else if (action === 'activate') result = planner.activate(boardId, value);
    else if (action === 'deactivate') result = planner.deactivate(boardId, value);
    else if (action === 'reset-all') result = planner.reset();
    else if (action === 'reset-board') result = planner.reset(boardId);
    else if (action === 'load-source') result = planner.loadSource();
    else return;
    if (result.changed) api.write(undefined, planner);
    render(result);
  }

  function showDetail(node) {
    const active = planner.isActive(boardId, node.nodeId);
    const path = planner.plan(boardId, node.nodeId);
    const label = make('p', 'section-label', '선택한 노드');
    const heading = make('div', 'node-detail-heading');
    const icon = make('img', 'detail-icon');
    icon.src = iconPath(node);
    icon.alt = '';
    const title = make('div');
    title.append(make('span', `grade-label grade-${node.grade.toLowerCase()}`, gradeLabel(node)), make('h3', '', node.name));
    heading.append(icon, title);
    const state = make('span', `node-state ${active ? 'is-open' : ''}`, status(node));
    const descriptions = make('ul', 'node-effect-list');
    for (const effect of effects(node)) descriptions.append(make('li', '', effect));
    const cost = make('p', 'node-cost', `노드 소모량 ${api.COSTS[node.grade]}개`);
    const pathInfo = make('p', 'path-info');
    if (!active && path) {
      pathInfo.textContent = `연결 경로 ${path.nodes.length}개 노드 · 소모 ${path.cost}개`;
      for (const id of path.nodes) buttons.get(id).classList.add('is-path');
    } else if (active) pathInfo.textContent = '루트와 연결되어 있습니다.';
    else pathInfo.textContent = '루트와 연결할 수 없습니다.';
    const action = make('button', 'activate-node', active ? '비활성화 · F' : '경로 활성화 · F');
    action.type = 'button';
    action.disabled = !ready || (!active && !path);
    action.addEventListener('click', () => act(active ? 'deactivate' : 'activate', node.nodeId));
    const position = make('p', 'node-coordinate', `${node.row}행 ${node.col}열 · 노드 ${node.nodeId}`);
    const sequence = make('ol', 'node-transition-steps');
    for (const step of nodeSteps.get(node.nodeId) || []) {
      const operation = step.action === 'deactivate' ? '해제' : step.temporary ? '복원' : '추가';
      sequence.append(make('li', step.action === 'deactivate' ? 'transition-remove' : 'transition-add',
        `${step.order}번 ${step.temporary ? '임시 ' : ''}${operation} · 작업 후 잔여 ${step.remaining}개`));
    }
    detail.replaceChildren(label, heading, state, descriptions, cost, pathInfo, action, position, sequence);
  }

  function showTooltip(node, button) {
    tooltip.replaceChildren(make('strong', '', isRoot(node) ? '루트' : node.name));
    for (const effect of effects(node)) tooltip.append(make('span', '', effect));
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8));
    const top = rect.top >= tip.height + 12 ? rect.top - tip.height - 8 : rect.bottom + 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - tip.height - 8))}px`;
  }
  function hideTooltip() { tooltip.hidden = true; }

  function renderEffects(items, target) {
    const list = document.getElementById(target);
    list.replaceChildren();
    for (const text of items) {
      const row = make('li');
      const match = text.match(/^(.*?)\s+([+-][\d.,]+%?)$/);
      if (match) row.append(make('span', '', match[1]), make('strong', '', match[2]));
      else row.textContent = text;
      list.append(row);
    }
    if (!items.length) list.append(make('li', 'empty-effects', '활성화된 효과가 없습니다.'));
  }

  function sumEffects() {
    const stat = new Map();
    const skill = new Map();
    for (const node of nodes) {
      if (!planner.isActive(boardId, node.nodeId)) continue;
      const group = node.type === 'SkillLevel' ? skill : stat;
      for (const desc of effects(node)) {
        const match = desc.match(/^(.*?)\s+([+-][\d.,]+)(%?)$/);
        if (!match) { group.set(desc, { text: desc }); continue; }
        const key = `${match[1]}|${match[3]}`;
        const old = group.get(key) || { name: match[1], value: 0, unit: match[3] };
        old.value += Number(match[2].replaceAll(',', ''));
        group.set(key, old);
      }
    }
    const format = group => [...group.values()].map(item => item.text || `${item.name} ${item.value >= 0 ? '+' : ''}${Number(item.value.toFixed(6))}${item.unit}`);
    renderEffects(format(stat), 'stat-effects');
    renderEffects(format(skill), 'skill-effects');
    document.getElementById('skill-count').textContent = skill.size;
  }

  function render(result = {}) {
    updateTransition();
    const hasRemaining = planner.remaining() > 0;
    for (const node of nodes) {
      const button = buttons.get(node.nodeId);
      const active = planner.isActive(boardId, node.nodeId);
      button.classList.toggle('is-open', active);
      button.classList.toggle('is-available', hasRemaining && planner.available(boardId, node.nodeId));
      button.classList.toggle('is-removed', !isRoot(node) && node.open === 1 && !active);
      button.classList.toggle('is-added', !isRoot(node) && node.open !== 1 && active);
      button.classList.toggle('is-selected', node.nodeId === selectedId);
      button.classList.remove('is-path');
      button.style.backgroundImage = `url("${iconPath(node)}")`;
      button.setAttribute('aria-pressed', String(active));
      const label = isRoot(node) ? ['루트', '활성화 불가'] : [node.name, gradeLabel(node), status(node), ...effects(node)];
      for (const step of nodeSteps.get(node.nodeId) || []) label.push(`${step.order}번 ${step.temporary ? '임시 ' : ''}${step.action === 'deactivate' ? '해제' : step.temporary ? '복원' : '추가'}`);
      button.setAttribute('aria-label', [...label, `${node.row}행 ${node.col}열`].join(', '));
    }
    document.getElementById('open-count').textContent = planner.active.get(boardId).size;
    document.getElementById('board-spent').textContent = planner.used(boardId);
    if (selectedId !== null) showDetail(nodes.find(node => node.nodeId === selectedId));
    sumEffects();
    notice.textContent = result.message || '';
    notice.classList.toggle('is-error', result.ok === false);
    resources?.render(result.message || '', result.ok === false);
  }

  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    const button = make('button', `board-node grade-${node.grade.toLowerCase()} ${isRoot(node) ? 'is-root' : ''}`);
    button.type = 'button';
    button.dataset.nodeId = node.nodeId;
    button.style.gridArea = `${node.row} / ${node.col}`;
    button.disabled = isRoot(node);
    button.addEventListener('click', () => { selectedId = node.nodeId; render(); });
    button.addEventListener('pointerdown', event => {
      touchInput = event.pointerType === 'touch';
      if (touchInput) hideTooltip();
    });
    button.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') showTooltip(node, button); });
    button.addEventListener('pointerleave', hideTooltip);
    button.addEventListener('focus', () => { if (!touchInput) showTooltip(node, button); });
    button.addEventListener('blur', hideTooltip);
    buttons.set(node.nodeId, button);
    fragment.append(button);
  }
  grid.append(fragment);
  render();

  function toggleSelected() {
    if (selectedId !== null) act('toggle', selectedId);
  }
  document.addEventListener('keydown', event => {
    touchInput = false;
    if (event.key === 'Escape') hideTooltip();
    if (event.code !== 'KeyF' || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    hideTooltip();
    toggleSelected();
  });
  document.getElementById('reset-board').addEventListener('click', () => act('reset-board'));
  document.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('resize', hideTooltip);
  if (!embedded) window.addEventListener('storage', event => {
    if (event.key === window.DaevanionCharacterSession?.SESSION_KEY) { location.reload(); return; }
    if (event.key === api.STORAGE_KEY || event.key === null) { planner.restore(api.read()); render(); }
  });

  function setZoom(value) {
    const previous = zoom;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / grid.offsetWidth;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / grid.offsetHeight;
    zoom = Math.max(1, Math.min(2.5, Math.round(value * 100) / 100));
    if (zoom === previous) return;
    grid.style.width = `${zoom * 100}%`;
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    zoomOut.disabled = zoom === 1;
    zoomIn.disabled = zoom === 2.5;
    viewport.scrollLeft = centerX * grid.offsetWidth - viewport.clientWidth / 2;
    viewport.scrollTop = centerY * grid.offsetHeight - viewport.clientHeight / 2;
    hideTooltip();
  }
  zoomOut.disabled = true;
  zoomIn.addEventListener('click', () => setZoom(zoom + 0.25));
  zoomOut.addEventListener('click', () => setZoom(zoom - 0.25));
  document.getElementById('zoom-reset').addEventListener('click', () => setZoom(1));

  if (embedded) {
    let scheduled = false;
    let lastHeight = 0;
    function sendHeight() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const height = Math.ceil(document.body.getBoundingClientRect().height);
        if (height === lastHeight) return;
        lastHeight = height;
        window.parent.postMessage({ type: 'daevanion:height', boardId, height }, targetOrigin);
      });
    }
    new ResizeObserver(sendHeight).observe(document.body);
    window.addEventListener('load', sendHeight);
    window.addEventListener('message', event => {
      if (event.source !== window.parent) return;
      if (location.protocol !== 'file:' && event.origin !== location.origin) return;
      const message = event.data;
      if (!message) return;
      if (message.type === 'daevanion:state') {
        planner.restore(message.state);
        transition = message.transition || null;
        transitionKey = null;
        ready = true;
        render(message.result);
        document.documentElement.classList.remove('awaiting-state');
      }
      if (message.type === 'daevanion:toggle-selected') toggleSelected();
      if (message.type === 'daevanion:request-height') { lastHeight = 0; sendHeight(); }
    });
    window.parent.postMessage({ type: 'daevanion:ready', boardId }, targetOrigin);
    sendHeight();
  }
})();
