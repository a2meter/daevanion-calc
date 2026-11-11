'use strict';
(() => {
  const model = window.DaevanionCharacters;
  const session = window.DaevanionCharacterSession;
  const section = document.getElementById('character-search');
  const form = section.querySelector('form');
  const race = document.getElementById('character-race');
  const server = document.getElementById('character-server');
  const input = document.getElementById('character-keyword');
  const panel = document.getElementById('character-results');
  const list = document.getElementById('character-result-list');
  const status = document.getElementById('character-search-status');
  const more = document.getElementById('character-search-more');
  const submit = form.querySelector('button[type="submit"]');
  let searchController = null, loadController = null, upgradeController = null;
  let searchVersion = 0, loadVersion = 0, currentQuery = null, nextPage = null;
  let rows = [];
  const make = (tag, className, text) => {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text !== undefined) el.textContent = text; return el;
  };
  function open() { panel.hidden = false; input.setAttribute('aria-expanded', 'true'); }
  function close() { panel.hidden = true; input.setAttribute('aria-expanded', 'false'); }
  function populateServers(selected = '') {
    server.replaceChildren(new Option('서버 선택', ''));
    for (const s of model.servers.filter(s => s.raceId === Number(race.value))) server.add(new Option(s.serverName, String(s.serverId)));
    server.value = selected; server.disabled = !race.value;
  }
  function invalidate() {
    searchVersion++; searchController?.abort(); searchController = null;
    loadVersion++; loadController?.abort(); loadController = null;
    submit.disabled = false; more.disabled = false; section.removeAttribute('aria-busy');
    rows = []; list.replaceChildren(); nextPage = null; currentQuery = null; more.hidden = true;
    status.textContent = ''; close();
  }
  async function fetchJson(url, signal) {
    let response;
    try { response = await fetch(url, { signal, headers: { Accept: 'application/json' }, cache: 'no-store' }); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하십시오.');
    }
    let data;
    try { data = await response.json(); } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('검색 API를 사용할 수 없습니다. Cloudflare Worker와 함께 배포하십시오.');
    }
    if (!data || typeof data !== 'object') throw new Error('캐릭터 API 응답 형식이 올바르지 않습니다.');
    if (!response.ok) throw new Error(data.message || '캐릭터 정보를 불러오지 못했습니다.');
    return data;
  }
  async function choose(character) {
    upgradeController?.abort('character-selection');
    loadController?.abort(); const controller = new AbortController(); loadController = controller;
    const version = ++loadVersion;
    const timer = setTimeout(() => controller.abort(), 20000);
    section.setAttribute('aria-busy', 'true');
    submit.disabled = true; more.disabled = true;
    for (const row of rows) row.disabled = true;
    status.classList.remove('is-error'); status.textContent = `${character.name} 캐릭터의 다섯 보드를 불러오고 있습니다.`;
    try {
      const info = await fetchJson(`/api/character/info?${model.infoQuery(character)}`, controller.signal);
      const pcId = info?.profile?.pcId;
      character = { ...character, pcId: Number.isSafeInteger(pcId) ? pcId : character.pcId };
      const mappings = model.boardMapping(info);
      const replies = await Promise.all(mappings.map(async mapping =>
        [mapping.id, model.normalizeBoard(await fetchJson(`/api/character/daevanion/detail?${model.detailQuery(character, mapping.sourceId)}`, controller.signal), mapping)]));
      if (version !== loadVersion) return;
      session.commit(character, Object.fromEntries(replies));
      location.reload();
    } catch (error) {
      if (version !== loadVersion) return;
      controller.abort();
      status.classList.add('is-error');
      status.textContent = controller.signal.aborted && error.name === 'AbortError'
        ? '보드 조회 시간이 초과했습니다. 다시 선택하십시오.' : error.message;
      for (const row of rows) row.disabled = false;
    } finally {
      clearTimeout(timer);
      if (version === loadVersion) {
        section.removeAttribute('aria-busy'); loadController = null;
        submit.disabled = false; more.disabled = false;
      }
    }
  }
  function append(character) {
    const li = make('li');
    const button = make('button', 'character-result'); button.type = 'button';
    button.setAttribute('aria-label', `${character.name}, ${character.serverName}, 다섯 보드 불러오기`);
    const avatar = make('span', 'character-avatar', character.name.slice(0, 1));
    if (character.profileImageUrl) {
      const image = make('img'); image.src = character.profileImageUrl; image.alt = ''; image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true }); avatar.append(image);
    }
    const content = make('span', 'character-result-content'), name = make('span', 'character-result-name');
    for (const part of character.parts) name.append(make(part.highlighted ? 'strong' : 'span', '', part.text));
    content.append(name, make('span', 'character-result-server', character.serverName));
    button.append(avatar, content); button.addEventListener('click', () => choose(character));
    li.append(button); list.append(li); rows.push(button);
  }
  async function search(page = 1) {
    if (loadController && !loadController.signal.aborted) return;
    let parameters;
    try { parameters = model.query(page === 1 ? { keyword: input.value, race: race.value, serverId: server.value, page } : { ...currentQuery, page }); }
    catch (error) { status.textContent = error.message; status.classList.add('is-error'); open(); return; }
    searchController?.abort(); loadController?.abort(); loadVersion++;
    section.removeAttribute('aria-busy');
    const controller = new AbortController(); searchController = controller;
    const version = ++searchVersion, timer = setTimeout(() => controller.abort(), 20000);
    if (page === 1) { rows = []; list.replaceChildren(); nextPage = null; currentQuery = Object.fromEntries(parameters); }
    submit.disabled = true; more.disabled = true; more.hidden = true;
    status.classList.remove('is-error'); status.textContent = '검색하고 있습니다.'; open();
    try {
      const data = await fetchJson(`/api/search/character?${parameters}`, controller.signal);
      if (version !== searchVersion) return;
      if (!Array.isArray(data.list) || !Number.isSafeInteger(data.pagination?.endPage) || data.pagination.endPage < 0
        || (data.list.length > 0 && data.pagination.endPage < page)) throw new Error('검색 응답 형식이 올바르지 않습니다.');
      const seen = new Set(rows.map(row => row.dataset.identity));
      for (const raw of data.list) {
        let character;
        try { character = model.normalizeCharacter(raw); } catch { continue; }
        const id = model.identity(character);
        if (seen.has(id)) continue;
        append(character); rows.at(-1).dataset.identity = id; seen.add(id);
      }
      if (data.list.length && !rows.length) throw new Error('표시할 수 있는 캐릭터 정보가 없습니다.');
      nextPage = page < data.pagination.endPage ? page + 1 : null;
      more.hidden = nextPage === null;
      status.textContent = rows.length ? `${data.pagination.total ?? rows.length}개 캐릭터 · 선택하면 보드를 불러옵니다.` : '검색 결과가 없습니다.';
    } catch (error) {
      if (version !== searchVersion) return;
      status.textContent = error.name === 'AbortError' ? '검색 시간이 초과했습니다. 다시 검색하십시오.' : error.message;
      status.classList.add('is-error'); more.hidden = nextPage === null;
    } finally {
      clearTimeout(timer);
      if (version === searchVersion) { submit.disabled = false; more.disabled = false; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); search(); });
  race.addEventListener('change', () => { invalidate(); populateServers(); });
  server.addEventListener('change', invalidate);
  input.addEventListener('input', invalidate);
  input.addEventListener('focus', () => { if (list.children.length || status.textContent) open(); });
  more.addEventListener('click', () => { if (nextPage) search(nextPage); });
  document.addEventListener('pointerdown', event => { if (!section.contains(event.target)) close(); });
  section.addEventListener('keydown', event => {
    if (event.key === 'Escape') { input.focus(); close(); }
    if (event.key === 'ArrowDown' && event.target === input && rows.length) { event.preventDefault(); open(); rows[0].focus(); }
    const i = rows.indexOf(event.target);
    if (i >= 0 && ['ArrowUp','ArrowDown'].includes(event.key)) {
      event.preventDefault(); const next = i + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) input.focus(); else rows[Math.min(next, rows.length - 1)].focus();
    }
  });
  const current = window.DAEVANION_CHARACTER;
  race.value = String(current?.race ?? 1); populateServers(String(current?.serverId ?? 1003));
  if (current) {
    input.value = current.name;
    document.getElementById('current-character').textContent = `${current.name} · ${current.race === 1 ? '천족' : '마족'} · ${current.serverName}`;
  }
  async function upgradeLumiel() {
    const controller = new AbortController();
    upgradeController = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    const label = document.getElementById('current-character');
    const originalLabel = label.textContent;
    label.textContent = `${originalLabel} · 루미엘 불러오는 중`;
    try {
      const info = await fetchJson(`/api/character/info?${model.infoQuery(current)}`, controller.signal);
      const mapping = model.boardMapping(info).find(b => b.id === 79);
      const raw = await fetchJson(`/api/character/daevanion/detail?${model.detailQuery(current, mapping.sourceId)}`, controller.signal);
      controller.signal.throwIfAborted();
      if (session.addLumiel(current, model.normalizeBoard(raw, mapping))) location.reload();
      else label.textContent = originalLabel;
    } catch (error) {
      const message = controller.signal.aborted ? '루미엘 조회 시간이 초과되었습니다.'
        : error instanceof Error ? error.message : '루미엘을 불러오지 못했습니다.';
      label.textContent = controller.signal.reason === 'character-selection'
        ? originalLabel : `${originalLabel} · ${message}`;
    } finally {
      clearTimeout(timer);
      if (upgradeController === controller) upgradeController = null;
    }
  }
  if (current && window.DAEVANION_LEGACY_BOARDS) upgradeLumiel();
  if (window.DAEVANION_CHARACTER_LOAD_ERROR) { status.textContent = window.DAEVANION_CHARACTER_LOAD_ERROR; status.classList.add('is-error'); open(); }
})();
