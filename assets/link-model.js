'use strict';

// Reads the state the desktop companion (link/) puts after `#link=` and turns it
// into what the planner uses: the source layout of the five boards and, per
// skill, the CP each further node is worth at the character's own skill level.
((scope) => {
  const { Planner } = typeof module !== 'undefined' && module.exports
    ? require('./planner.js') : scope.DaevanionPlanner;
  const MARK = '#link=';
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const HEADER = 16, BITMAP = 29, BOARD = 1 + BITMAP, SKILL = 6, NODES = 225;
  const optionKey = node => JSON.stringify([node.grade, node.type, node.name,
    node.effectList.map(effect => effect.desc).filter(Boolean)]);
  const fail = message => { throw new Error(message); };

  // The data part of an address or fragment that carries a link, otherwise null.
  function fragment(text) {
    const value = String(text ?? '').trim(), at = value.indexOf(MARK);
    return at < 0 ? null : value.slice(at + MARK.length).split('&', 1)[0];
  }

  // Payload version 1, as specified in link/README.md. Accepts the data string
  // or an address containing `#link=`, like decode() of link/link_payload.py,
  // and returns the same structure.
  function decode(text) {
    const data = fragment(text) ?? String(text ?? '').trim();
    if (!data || data.length % 4 === 1) fail('링크의 데이터 길이가 맞지 않습니다.');
    const raw = new Uint8Array(Math.floor(data.length * 3 / 4));
    let held = 0, bits = 0, size = 0;
    for (const letter of data) {
      const value = ALPHABET.indexOf(letter);
      if (value < 0) fail('링크의 데이터가 패딩 없는 base64url 형식이 아닙니다.');
      held = ((held << 6) | value) & 0xfff;
      bits += 6;
      if (bits >= 8) { bits -= 8; raw[size++] = (held >> bits) & 0xff; }
    }
    if (raw.length < HEADER + 2) fail('링크의 데이터가 너무 짧습니다.');
    if (raw[0] !== 0x44 || raw[1] !== 0x56) fail('데바니온 링크의 데이터가 아닙니다.');
    if (raw[2] !== 1) fail(`지원하지 않는 링크 버전입니다: ${raw[2]}`);
    const view = new DataView(raw.buffer);
    let offset = HEADER;
    const boards = [];
    for (let left = raw[offset++], previous = -1; left > 0; left--, offset += BOARD) {
      if (offset + BOARD > raw.length) fail('링크의 보드 목록이 끊겼습니다.');
      const boardId = raw[offset];
      if (boardId <= previous) fail('링크의 보드 번호가 오름차순이 아닙니다.');
      previous = boardId;
      const nodeIds = [];
      // Bit k of the bitmap is node index k + 1; the seven bits after the 225th are padding.
      for (let bit = 0; bit < NODES; bit++) if (raw[offset + 1 + (bit >> 3)] >> (bit & 7) & 1) nodeIds.push(boardId * 10000 + bit + 1);
      boards.push({ boardId, nodeIds });
    }
    if (offset >= raw.length) fail('링크에 스킬 목록이 없습니다.');
    const count = raw[offset++], skills = [];
    if (raw.length - offset !== count * SKILL) fail('링크의 스킬 목록 길이가 맞지 않습니다.');
    for (let index = 0, previous = -1; index < count; index++, offset += SKILL) {
      const skillId = view.getUint32(offset, true);
      if (skillId <= previous) fail('링크의 스킬 번호가 오름차순이 아닙니다.');
      previous = skillId;
      skills.push({ skillId, level: raw[offset + 4], daevanionLevels: raw[offset + 5] });
    }
    return { version: raw[2], boardsComplete: (raw[3] & 1) !== 0, skillsComplete: (raw[3] & 2) !== 0,
      capturedAt: view.getUint32(4, true), power: view.getUint32(8, true), bestPower: view.getUint32(12, true), boards, skills };
  }

  // The open nodes of every planner board, without the start node. Bits that are
  // not a node of the board and boards the planner does not have are ignored.
  // A link that cannot describe all of the planner's boards is refused.
  function layout(boards, payload) {
    if (!payload?.boardsComplete) fail('링크에 보드 전체 정보가 없습니다. 데바니온 링크 프로그램을 켠 채로 게임에 다시 접속해 보드를 모두 읽은 뒤 다시 여십시오.');
    const sent = new Map(payload.boards.map(board => [board.boardId, board.nodeIds]));
    const missing = boards.filter(board => !sent.has(board.id));
    if (missing.length) {
      fail(`링크에 ${missing.map(board => `${board.name}(${board.id})`).join(', ')} 보드가 없습니다.${sent.size ? ` 링크에 든 보드 번호는 ${[...sent.keys()].join(', ')}입니다.` : ''}`);
    }
    return Object.fromEntries(boards.map(board => {
      const open = new Set(sent.get(board.id));
      return [board.id, board.nodes.filter(node => node.type !== 'Start' && open.has(node.nodeId)).map(node => node.nodeId).sort((a, b) => a - b)];
    }));
  }

  // The same boards with `open` as their source layout. The start node keeps its own flag.
  function withLayout(boards, open) {
    return boards.map(board => {
      const taken = new Set(open[board.id]);
      return { ...board, open: taken.size, nodes: board.nodes.map(node => node.type === 'Start' ? node : { ...node, open: taken.has(node.nodeId) ? 1 : 0 }) };
    });
  }

  // CP gained when a skill of this grade reaches `level`: { power, observed }.
  // Ranges are [from, to, power, observed]; a level outside every range has no value.
  function levelStep(levels, grade, level) {
    if (!Number.isInteger(level)) return null;
    for (const [from, to, power, observed] of levels?.[grade] || []) if (level >= from && level <= to) return { power, observed: observed === true };
    return null;
  }
  const levelPower = (levels, grade, level) => levelStep(levels, grade, level)?.power;

  // Why a skill of an import stays on the fixed grade rule.
  const reasons = {
    incomplete: '링크의 스킬 목록 미완료',
    unmapped: '번호표에 없는 스킬',
    missing: '링크에 레벨 없음',
    negative: '레벨이 열린 노드 수보다 작음',
    range: '레벨표 범위 밖',
  };

  // Per skill option of the boards: with level L in the link and c of its nodes
  // open, the skill is at L − c with every node closed, and its j-th node is
  // worth the step to level L − c + j. Anything that prevents this leaves the
  // option on the fixed grade rule and is listed with its reason.
  function skillSequences(boards, payload, tables) {
    const { levels = null, ids = [] } = tables || {};
    const options = new Map();
    for (const board of boards) for (const node of board.nodes) if (node.type === 'SkillLevel') {
      const key = optionKey(node);
      if (!options.has(key)) options.set(key, { key, grade: node.grade, name: node.name, effects: node.effectList.map(effect => effect.desc).filter(Boolean), nodes: 0, opened: 0 });
      const option = options.get(key);
      option.nodes++;
      if (node.open === 1) option.opened++;
    }
    const sent = new Map((payload?.skills || []).map(skill => [skill.skillId, skill]));
    const numbers = new Map(ids.map(item => [item.key, item.skillIds]));
    const skills = [], fallbacks = [];
    for (const option of options.values()) {
      const { key, grade, name, effects, nodes, opened } = option;
      const fallback = reason => fallbacks.push({ key, grade, name, reason, detail: reasons[reason] });
      if (!payload?.skillsComplete) { fallback('incomplete'); continue; }
      const own = [...(numbers.get(key) || [])].sort((a, b) => a - b);
      if (!own.length) { fallback('unmapped'); continue; }
      // A variant id can hold a stale level, so the base id (…0000) decides whenever the link has it.
      const chosen = own.filter(id => id % 10000 === 0).find(id => sent.has(id)) ?? own.find(id => sent.has(id));
      if (chosen === undefined) { fallback('missing'); continue; }
      const level = sent.get(chosen).level, baseLevel = level - opened;
      if (baseLevel < 0) { fallback('negative'); continue; }
      const steps = Array.from({ length: nodes }, (_, index) => levelStep(levels, grade, baseLevel + index + 1));
      if (steps.some(step => !step || !Number.isFinite(step.power) || step.power < 0)) { fallback('range'); continue; }
      skills.push({ key, grade, name, effects, baseLevel, level, opened, skillId: chosen, values: steps.map(step => step.power),
        unobservedLevels: steps.flatMap((step, index) => step.observed ? [] : [baseLevel + index + 1]) });
    }
    return { skills, fallbacks, total: options.size };
  }

  // Everything the planner needs from one link, or an error saying why it cannot be used.
  function prepare(boards, payload, tables) {
    const open = layout(boards, payload);
    const imported = withLayout(boards, open);
    const planner = new Planner(imported);
    if (planner.sourceTotal > planner.total) fail(`링크의 보드가 쓰는 데바니온 ${planner.sourceTotal}개가 계산용 수량 ${planner.total}개를 넘습니다.`);
    for (const board of imported) {
      if (!planner.validateBoard(board.id, open[board.id]).ok) fail(`링크의 ${board.name} 보드에 시작 노드와 이어지지 않은 열린 노드가 있습니다.`);
    }
    const known = new Set(boards.map(board => board.id));
    const { skills, fallbacks, total } = skillSequences(imported, payload, tables);
    return { boards: imported, open, skills, fallbacks,
      summary: { capturedAt: payload.capturedAt, power: payload.power, bestPower: payload.bestPower,
        counts: Object.fromEntries(imported.map(board => [board.id, open[board.id].length])), cost: planner.sourceTotal, budget: planner.total,
        ignoredBoards: payload.boards.map(board => board.boardId).filter(id => !known.has(id)),
        skillTotal: total, levelled: skills.length, unobserved: skills.filter(skill => skill.unobservedLevels.length).length,
        fallbacks: fallbacks.map(({ name, reason }) => ({ name, reason })) } };
  }

  const two = value => String(value).padStart(2, '0');
  // Local time of a UNIX second count, to the minute.
  function stamp(seconds) {
    const date = new Date(seconds * 1000);
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  // One line for the page: when the state was read, its CP, the open nodes per board and how the skills are valued.
  function describe(summary, boards) {
    const number = value => value.toLocaleString('ko-KR');
    const fixed = new Map();
    for (const item of summary.fallbacks) fixed.set(item.reason, (fixed.get(item.reason) || 0) + 1);
    return [
      summary.capturedAt ? `기준 시각 ${stamp(summary.capturedAt)}` : '기준 시각 모름',
      summary.power ? `전투력 ${number(summary.power)}${summary.bestPower ? ` (최고 ${number(summary.bestPower)})` : ''}` : '전투력 모름',
      `열린 노드 ${boards.map(board => `${board.name} ${summary.counts[board.id]}개`).join(', ')} (시작 노드 제외, 데바니온 ${summary.cost}개)`,
      `스킬 ${summary.skillTotal}종 중 ${summary.levelled}종을 현재 레벨로 계산${summary.fallbacks.length
        ? `, ${summary.fallbacks.length}종은 등급별 고정값(${[...fixed].map(([reason, count]) => `${reasons[reason]} ${count}종`).join(', ')})` : ''}${summary.unobserved
        ? `, 미관측 구간의 값을 쓰는 스킬 ${summary.unobserved}종` : ''}`,
    ].join(' · ');
  }

  const api = { MARK, fragment, decode, layout, withLayout, levelStep, levelPower, skillSequences, prepare, stamp, describe, reasons, optionKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionLink = api;
})(typeof window !== 'undefined' ? window : globalThis);
