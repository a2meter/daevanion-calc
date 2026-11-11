'use strict';
((scope) => {
  const names = [
    ['시엘','네자칸','바이젤','카이시넬','유스티엘','아리엘','프레기온','메스람타에다','히타니에','나니아','타하바타','루터스','페르노스','다미누','카사카','바카르마','챈가룽','코치룽','이슈타르','티아마트','포에타'],
    ['이스라펠','지켈','트리니엘','루미엘','마르쿠탄','아스펠','에레슈키갈','브리트라','네몬','하달','루드라','울고른','무닌','오다르','젠카카','크로메데','콰이링','바바룽','파프니르','인드나흐','이스할겐'],
  ];
  const shortNames = [
    ['시엘','네자','바이','카이','유스','아리','프레','메스','히타','나니','타하','루터','페르','다미','카사','바카','챈가','코치','이슈','티아','포에'],
    ['이스','지켈','트리','루미','마르','아스','에레','브리','네몬','하달','루드','울고','무닌','오다','젠카','크로','콰이','바바','파프','인드','할겐'],
  ];
  const servers = names.flatMap((list, race) => list.map((serverName, i) =>
    ({ raceId: race + 1, serverId: (race + 1) * 1000 + i + 1, serverName, serverShortName: shortNames[race][i] })));
  const boardNames = { 71: ['네자칸','Nezkhan.html'], 72: ['지켈','Zikel.html'], 73: ['바이젤','Vaizel.html'], 74: ['트리니엘','Triniel.html'], 79: ['루미엘','Lumiel.html'] };
  // Official /api/gameinfo/pcdata class groups (including race and gender variants).
  const pcClasses = { 1: 'gladiator', 2: 'templar', 3: 'ranger', 4: 'assassin', 5: 'elementalist', 6: 'sorcerer', 7: 'cleric', 8: 'chanter', 11: 'fighter' };
  const boardClasses = { ...pcClasses, 9: 'fighter' };
  function rootIcon(character, sourceBoardId = 71) {
    const className = pcClasses[Math.floor((Number(character?.pcId) - 1) / 4)]
      || boardClasses[Math.floor(sourceBoardId / 10)] || 'cleric';
    return `assets/board_icon_start_${className}.png`;
  }
  const optionKey = n => JSON.stringify([n.grade, n.type, n.name, n.effectList.map(e => e.desc).filter(Boolean)]);
  const identity = c => `${c.serverId}:${c.characterId}`;
  const suffix = c => `:character:${identity(c)}`;
  function characterId(value) {
    let id;
    try { id = decodeURIComponent(value); } catch { throw new Error('캐릭터 번호가 올바르지 않습니다.'); }
    if (typeof value !== 'string' || !/^[A-Za-z0-9_+/=-]{1,512}$/.test(id)) throw new Error('캐릭터 번호가 올바르지 않습니다.');
    return id;
  }
  function nameParts(markup) {
    let highlighted = false;
    return String(markup).split(/(<strong>|<\/strong>)/gi).flatMap(part => {
      if (/^<strong>$/i.test(part)) { highlighted = true; return []; }
      if (/^<\/strong>$/i.test(part)) { highlighted = false; return []; }
      const text = part.replace(/<[^>]*>/g, '');
      return text ? [{ text, highlighted }] : [];
    });
  }
  function normalizeCharacter(raw) {
    const server = servers.find(s => s.serverId === Number(raw.serverId) && s.raceId === Number(raw.race));
    if (!server || typeof raw.name !== 'string' || raw.name.length > 512) throw new Error('검색 결과의 캐릭터 정보가 올바르지 않습니다.');
    const parts = nameParts(raw.name);
    const name = parts.map(p => p.text).join('');
    if (!name.trim()) throw new Error('캐릭터 이름이 없습니다.');
    let profileImageUrl = null;
    if (typeof raw.profileImageUrl === 'string') {
      try {
        const url = new URL(raw.profileImageUrl, 'https://profileimg.plaync.com');
        if (url.origin === 'https://profileimg.plaync.com' && url.pathname === '/game_profile_images/aion2/images') profileImageUrl = url.href;
      } catch { /* A broken avatar URL must not hide a valid character. */ }
    }
    return { characterId: characterId(raw.characterId), name, parts, race: server.raceId, pcId: Number.isSafeInteger(raw.pcId) ? raw.pcId : null,
      serverId: server.serverId, serverName: server.serverName, profileImageUrl };
  }
  function query({ keyword, race, serverId, page = 1 }) {
    keyword = String(keyword ?? '').trim();
    if (!keyword || keyword.length > 50) throw new Error('캐릭터 이름을 1~50자로 입력하십시오.');
    if (!servers.some(s => s.serverId === Number(serverId) && s.raceId === Number(race))) throw new Error('종족과 서버를 선택하십시오.');
    if (!Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1000) throw new Error('검색 페이지가 올바르지 않습니다.');
    return new URLSearchParams({ keyword, race: String(race), serverId: String(serverId), page: String(page), size: '30' });
  }
  const detailQuery = (c, boardId) => new URLSearchParams({ lang: 'ko', characterId: c.characterId, serverId: String(c.serverId), boardId: String(boardId) });
  const infoQuery = c => new URLSearchParams({ lang: 'ko', characterId: c.characterId, serverId: String(c.serverId) });
  function boardMapping(info) {
    const list = info?.daevanion?.boardList;
    if (!Array.isArray(list)) throw new Error('캐릭터의 보드 목록을 확인할 수 없습니다.');
    const mappings = Object.entries(boardNames).map(([id, [name]]) => {
      const matches = list.filter(b => b.name === name);
      const source = matches[0];
      if (matches.length !== 1 || !Number.isSafeInteger(source.id) || source.id < 11 || source.id > 99
        || source.id % 10 !== Number(id) % 10 || !Number.isSafeInteger(source.openNodeCount) || source.openNodeCount < 0) {
        throw new Error(`${name} 보드를 확인할 수 없습니다.`);
      }
      return { id: Number(id), sourceId: source.id, expectedOpen: source.openNodeCount };
    });
    if (new Set(mappings.map(b => Math.floor(b.sourceId / 10))).size !== 1) throw new Error('직업별 보드 번호가 일치하지 않습니다.');
    return mappings;
  }
  function normalizeBoard(raw, mapping) {
    if (!Array.isArray(raw?.nodeList) || raw.nodeList.some(n => n.boardId !== mapping.sourceId)) throw new Error('조회한 보드 번호가 일치하지 않습니다.');
    const open = raw.nodeList.filter(n => !['None','Start'].includes(n.type) && n.open === 1).length;
    if (open !== mapping.expectedOpen) throw new Error('공식 보드의 활성 개수가 일치하지 않습니다. 다시 검색하십시오.');
    return { ...raw, sourceBoardId: mapping.sourceId, nodeList: raw.nodeList.map(n => ({ ...n, boardId: mapping.id })) };
  }
  const sourceUrl = (c, id) => `https://aion2.plaync.com/ko-kr/characters/${c.serverId}/${encodeURIComponent(c.characterId)}?tab=daevanion&boardId=${id}`;

  function prepareBoards(rawBoards, character, Planner, { legacy = false } = {}) {
    const ids = Object.keys(boardNames).map(Number).filter(id => !legacy || id !== 79);
    if (!rawBoards || Object.keys(rawBoards).length !== ids.length) throw new Error('모든 보드의 응답이 필요합니다.');
    const sourceIds = ids.map(id => rawBoards[id]?.sourceBoardId ?? id);
    if (sourceIds.some((sourceId, index) => !Number.isSafeInteger(sourceId) || sourceId < 11 || sourceId > 99 || sourceId % 10 !== ids[index] % 10)
      || new Set(sourceIds.map(id => Math.floor(id / 10))).size !== 1) throw new Error('직업별 보드 번호가 일치하지 않습니다.');
    const allIds = new Set();
    const boards = ids.map(id => {
      const raw = rawBoards[id];
      if (!Array.isArray(raw?.nodeList) || raw.nodeList.length !== 225) throw new Error(`${boardNames[id][0]} 보드의 좌표 데이터가 올바르지 않습니다.`);
      const positions = new Set();
      for (const n of raw.nodeList) {
        if (n.boardId !== id || !Number.isSafeInteger(n.nodeId) || allIds.has(n.nodeId)
          || !Number.isInteger(n.row) || !Number.isInteger(n.col) || n.row < 1 || n.row > 15 || n.col < 1 || n.col > 15
          || !['None','Stat','SkillLevel','Start'].includes(n.type) || !['None','Common','Rare','Legend','Unique'].includes(n.grade)
          || (!['None','Start'].includes(n.type) && n.grade === 'None') || ![0,1].includes(n.open)
          || typeof n.name !== 'string' || !Array.isArray(n.effectList) || n.effectList.some(e => typeof e.desc !== 'string')) throw new Error('보드 응답의 노드 정보가 올바르지 않습니다.');
        const position = `${n.row},${n.col}`;
        if (positions.has(position)) throw new Error('보드 좌표가 중복되었습니다.');
        positions.add(position); allIds.add(n.nodeId);
      }
      const nodes = raw.nodeList.filter(n => n.type !== 'None');
      if (nodes.filter(n => n.type === 'Start').length !== 1 || !nodes.some(n => n.type === 'Start' && n.row === 8 && n.col === 8)) throw new Error('보드 루트를 확인할 수 없습니다.');
      return { id, name: boardNames[id][0], file: boardNames[id][1], source: sourceUrl(character, raw.sourceBoardId ?? id), nodes,
        total: nodes.filter(n => n.type !== 'Start').length, open: nodes.filter(n => n.type !== 'Start' && n.open === 1).length };
    });
    const planner = new Planner(boards);
    if (planner.sourceTotal > planner.total) throw new Error('원본 보드의 소모량이 계산 수량을 초과합니다.');
    for (const b of boards) {
      const source = b.nodes.filter(n => n.type !== 'Start' && n.open === 1).map(n => n.nodeId);
      if (!planner.validateBoard(b.id, source).ok) throw new Error('원본 보드에 루트와 연결되지 않은 활성 노드가 있습니다.');
    }
    return { boards, state: planner.snapshot() };
  }
  function groupsFor(boards) {
    const groups = new Map();
    for (const b of boards) for (const n of b.nodes) if (n.type !== 'Start') {
      const key = optionKey(n);
      if (!groups.has(key)) groups.set(key, { key, grade: n.grade, type: n.type, name: n.name,
        effects: n.effectList.map(e => e.desc).filter(Boolean), counts: Object.fromEntries(boards.map(x => [x.id, 0])) });
      groups.get(key).counts[b.id]++;
    }
    return [...groups.values()];
  }
  const api = { servers, boardNames, rootIcon, optionKey, identity, suffix, characterId, nameParts, normalizeCharacter, query, detailQuery, infoQuery, boardMapping, normalizeBoard, sourceUrl, prepareBoards, groupsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DaevanionCharacters = api;
})(typeof window !== 'undefined' ? window : globalThis);
