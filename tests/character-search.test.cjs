const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../assets/character-model.js');
const { Planner } = require('../assets/planner.js');
const read = file => fs.readFileSync(`${__dirname}/../${file}`, 'utf8');
const rawBoards = Object.fromEntries([71,72,73,74,79].map(id => [id, JSON.parse(read(`boards/${id}.json`))]));
const rawCharacter = { characterId: 'AVjAApO77vZ9AnoMquwqdsIrxzd1bHPmsLfhjT_VnvM%3D',
  name: '<strong>힐피</strong>', race: 1, serverId: 1003,
  profileImageUrl: '/game_profile_images/aion2/images?gameServerKey=1003&charKey=282037926664096404' };
const character = model.normalizeCharacter(rawCharacter);
function context(record) {
  const items = new Map(record ? [['daevanion-character-session:v1', JSON.stringify(record)]] : []);
  const storage = { getItem: k => items.get(k) ?? null, setItem: (k,v) => items.set(k,v), removeItem: k => items.delete(k) };
  const ctx = { window: {}, localStorage: storage, document: { getElementById: () => null }, URL, Blob };
  ctx.window.localStorage = storage;
  for (const f of ['boards/manifest.js','assets/planner.js','boards/options.js','boards/measurements.js','assets/optimizer.js','assets/character-model.js','assets/character-session.js']) vm.runInNewContext(read(f), ctx);
  return { ctx, items, storage };
}

test('all supplied race and server mappings remain separate and query values are encoded once', () => {
  assert.equal(model.servers.length, 42);
  for (const race of [1,2]) assert.equal(model.servers.filter(s => s.raceId === race).length, 21);
  assert.equal(model.servers.find(s => s.serverId === 2005).serverName, '마르쿠탄');
  assert.equal(model.query({ keyword: ' 힐피 ', race: 1, serverId: 1003 }).get('keyword'), '힐피');
  assert.throws(() => model.query({ keyword: '힐피', race: 2, serverId: 1003 }));
  assert.throws(() => model.query({ keyword: ' ', race: 1, serverId: 1003 }));
  const detail = model.detailQuery(character, 71).toString();
  assert.ok(detail.includes('M%3D'));
  assert.ok(!detail.includes('%253D'));
});

test('highlight markup becomes safe text parts and only the official profile image host is used', () => {
  assert.deepEqual(model.nameParts('타미<strong>힐피</strong>거'), [
    {text:'타미',highlighted:false},{text:'힐피',highlighted:true},{text:'거',highlighted:false}]);
  assert.equal(character.name, '힐피');
  assert.ok(character.profileImageUrl.startsWith('https://profileimg.plaync.com/game_profile_images/'));
  assert.equal(model.normalizeCharacter({...rawCharacter, profileImageUrl: 'https://example.com/image.jpg'}).profileImageUrl, null);
  assert.equal(model.normalizeCharacter({...rawCharacter, profileImageUrl: 'https://[invalid'}).profileImageUrl, null);
  const text = model.nameParts('<img src=x onerror=alert(1)><strong>힐피</strong>');
  assert.deepEqual(text, [{text:'힐피',highlighted:true}]);
});

test('four imported boards preserve the exact API activation and derive shared currency from it', () => {
  const { boards, state } = model.prepareBoards(rawBoards, character, Planner);
  assert.equal(state.total, 837);
  assert.deepEqual(boards.map(b => b.open), [128,121,125,118,0]);
  for (const b of boards) {
    assert.equal(b.source, model.sourceUrl(character, b.id));
    assert.deepEqual(new Set(state.boards[b.id]), new Set(rawBoards[b.id].nodeList.filter(n => n.open === 1 && !['Start','None'].includes(n.type)).map(n => n.nodeId)));
  }
  assert.equal(model.groupsFor(boards).reduce((sum,g) => sum + Object.values(g.counts).reduce((a,b) => a+b,0),0),760);
  const changed = structuredClone(rawBoards);
  changed[71].nodeList.forEach(n => { if(n.type!=='Start') n.open=0; });
  assert.equal(model.prepareBoards(changed, character, Planner).state.total, 523);
});

test('missing, duplicate and disconnected source boards are rejected before session writes', () => {
  const { ctx, items } = context();
  const invalid = structuredClone(rawBoards); delete invalid[74];
  assert.throws(() => ctx.window.DaevanionCharacterSession.commit(character,invalid));
  assert.equal(items.size,0);
  const duplicated = structuredClone(rawBoards); duplicated[72].nodeList[0].nodeId = duplicated[71].nodeList[0].nodeId;
  assert.throws(() => model.prepareBoards(duplicated,character,Planner));
  const disconnected = structuredClone(rawBoards);
  disconnected[71].nodeList.forEach(n => { n.open = n.row===1 && n.col===1 ? 1:0; });
  assert.throws(() => model.prepareBoards(disconnected,character,Planner));
});

test('character commit and restore isolate planner state and replace source plans without reusing an old proof', () => {
  const { ctx, items } = context();
  items.set('daevanion-planner:v2','original-edits');
  ctx.window.DaevanionCharacterSession.commit(character,rawBoards);
  assert.equal(items.get('daevanion-planner:v2'),'original-edits');
  const record = JSON.parse(items.get('daevanion-character-session:v1'));
  const restored = context(record).ctx.window;
  assert.equal(restored.DAEVANION_CHARACTER.characterId,character.characterId);
  assert.equal(restored.DaevanionPlanner.STORAGE_KEY, `daevanion-planner:v2${model.suffix(character)}`);
  assert.equal(restored.DAEVANION_ALL_POWER_PLAN.cost,709);
  assert.equal(restored.DAEVANION_ALL_POWER_PLAN.optimality.status,'pending');
  assert.equal(restored.DAEVANION_ALL_POWER_PLAN.powerDifference,0);
});

test('failed session storage rolls back all writes and new unknown effects stay unmeasured', () => {
  const { ctx, storage, items } = context();
  const key = `daevanion-planner:v2${model.suffix(character)}`;
  items.set(key,'prior state');
  const set = storage.setItem; let count=0;
  storage.setItem=(k,v)=>{if(++count===2)throw new Error('quota');set(k,v);};
  assert.throws(()=>ctx.window.DaevanionCharacterSession.commit(character,rawBoards));
  assert.equal(items.get(key),'prior state');
  assert.equal(items.has('daevanion-character-session:v1'),false);
  const changed=structuredClone(rawBoards);
  const target=changed[71].nodeList.find(n=>n.grade==='Common');
  target.name='새 능력치'; target.effectList=[{desc:'새 능력치 +5'}];
  const w=context({version:1,character,rawBoards:changed}).ctx.window;
  assert.equal(w.DAEVANION_ALL_POWER_PLAN.unknownCount,1);
  assert.equal(w.DAEVANION_ALL_POWER_PLAN.powerUpperBound,null);
  assert.ok(!w.DAEVANION_MEASUREMENTS.some(r=>r.key===model.optionKey(target)));
});

test('Cloudflare proxy allowlists two official API routes and does not forward browser credentials or Origin', async () => {
  const { handleRequest, upstreamUrl }=await import('../worker/index.mjs');
  const input='https://planner.example/api/search/character?'+model.query({keyword:'힐피',race:1,serverId:1003});
  const upstream=upstreamUrl(input);
  assert.equal(upstream.origin,'https://aion2.plaync.com');
  const response=await handleRequest(new Request(input,{headers:{Origin:'https://planner.example',Cookie:'private=value'}}),{},async(url,options)=>{
    assert.equal(url,upstream.href); assert.equal(options.headers.Accept,'application/json');
    assert.equal(options.headers.Origin,undefined); assert.ok(!options.headers.Cookie.includes('private=value'));
    assert.ok(options.headers['User-Agent'].includes('DaevanionPlanner'));
    assert.equal(options.redirect,'manual');
    return Response.json({list:[],pagination:{endPage:0,total:0}});
  });
  assert.equal(response.status,200);
  assert.equal((await response.json()).list.length,0);
  assert.equal((await handleRequest(new Request('https://planner.example/api/other'),{})).status,404);
  assert.equal((await handleRequest(new Request(input,{method:'POST'}),{})).status,405);
  assert.equal((await handleRequest(new Request(input.replace('race=1','race=2')),{})).status,400);
  const redirect=await handleRequest(new Request(input),{},async()=>new Response(null,{status:302,headers:{Location:'https://example.com'}}));
  assert.equal(redirect.status,502);
  const detail='https://planner.example/api/character/daevanion/detail?'+model.detailQuery(character,74);
  assert.equal(upstreamUrl(detail).searchParams.get('characterId'),character.characterId);
  const asset=await handleRequest(new Request('https://planner.example/index.html'),{ASSETS:{fetch:()=>new Response('static')}});
  assert.equal(await asset.text(),'static');
});

test('class-specific board IDs are resolved by name and activation counts are checked before import', () => {
  const info={daevanion:{boardList:[81,82,83,84,89].map((id,i)=>({id,name:model.boardNames[[71,72,73,74,79][i]][0],openNodeCount:[128,121,125,118,0][i]}))}};
  const mappings=model.boardMapping(info);
  const imported=Object.fromEntries(mappings.map(m=>{
    const raw=structuredClone(rawBoards[m.id]);
    raw.nodeList.forEach(n=>{n.boardId=m.sourceId;n.nodeId+=100000;});
    return [m.id,model.normalizeBoard(raw,m)];
  }));
  const {boards,state}=model.prepareBoards(imported,character,Planner);
  assert.equal(state.total,837);
  assert.deepEqual(boards.map(b=>b.open),[128,121,125,118,0]);
  assert.ok(boards[0].source.endsWith('boardId=81'));
  assert.throws(()=>model.normalizeBoard(rawBoards[71],mappings[0]));
  assert.throws(()=>model.normalizeBoard({...rawBoards[71],nodeList:rawBoards[71].nodeList.map(n=>({...n,boardId:81,open:0}))},mappings[0]));
  assert.throws(()=>model.boardMapping({daevanion:{boardList:[]}}));
});

test('proxy supports public character info and class-specific detail without opening arbitrary paths',async()=>{
  const {upstreamUrl}=await import('../worker/index.mjs');
  const info=upstreamUrl('https://planner.example/api/character/info?'+model.infoQuery(character));
  assert.equal(info.pathname,'/api/character/info');
  assert.equal(info.searchParams.has('boardId'),false);
  assert.equal(upstreamUrl('https://planner.example/api/character/daevanion/detail?'+model.detailQuery(character,81)).searchParams.get('boardId'),'81');
  for (const boardId of [19, 29, 39, 49, 59, 69, 79, 89, 99]) {
    const url = 'https://planner.example/api/character/daevanion/detail?' + model.detailQuery(character, boardId);
    assert.equal(upstreamUrl(url).searchParams.get('boardId'), String(boardId));
  }
  assert.throws(()=>upstreamUrl('https://planner.example/api/character/daevanion/detail?'+model.detailQuery(character,85)));
});

test('empty imported boards keep source activation empty and offer a 837-point planning budget after reload', () => {
  const raw=structuredClone(rawBoards);
  for(const board of Object.values(raw)) for(const node of board.nodeList) node.open=0;
  const {ctx,items}=context();
  ctx.window.DaevanionCharacterSession.commit(character,raw);
  const record=JSON.parse(items.get('daevanion-character-session:v1'));
  const w=context(record).ctx.window;
  assert.equal(w.DAEVANION_CHARACTER_LOAD_ERROR,undefined);
  assert.equal(w.DAEVANION_CHARACTER.name,character.name);
  const planner=new w.DaevanionPlanner.Planner(w.DAEVANION_BOARDS);
  assert.equal(planner.total,837);
  assert.equal(planner.used(),0);
  assert.equal(w.DAEVANION_ALL_POWER_PLAN.budget,837);
  assert.equal(w.DAEVANION_ALL_POWER_PLAN.cost,0);
  assert.equal(w.DAEVANION_ALL_POWER_PLAN.pending,true);
  assert.equal(w.DAEVANION_ALL_POWER_PLAN.optimality.status,'pending');
  assert.ok(Object.values(w.DAEVANION_ALL_POWER_PLAN.boards).every(b=>b.sourceBudget===0 && b.nodeIds.length===0));
});

test('all nine class decades map the fifth board to x9', () => {
  const ids = [71, 72, 73, 74, 79];
  for (let decade = 1; decade <= 9; decade++) {
    const boardList = ids.map(id => ({ id: decade * 10 + id % 10, name: model.boardNames[id][0], openNodeCount: 0 }));
    const mappings = model.boardMapping({ daevanion: { boardList } });
    assert.deepEqual(mappings.map(board => board.sourceId), [1, 2, 3, 4, 9].map(suffix => decade * 10 + suffix));
  }
});

test('legacy four-board sessions add Lumiel while preserving the source and edited selection', () => {
  const legacyRaw = structuredClone(rawBoards);
  delete legacyRaw[79];
  const record = { version: 1, character, rawBoards: legacyRaw };
  const { ctx, items } = context(record);
  assert.equal(ctx.window.DAEVANION_LEGACY_BOARDS, true);
  assert.equal(ctx.window.DAEVANION_BOARDS.length, 4);
  const key = `daevanion-planner:v2${model.suffix(character)}`;
  const editing = new Planner(ctx.window.DAEVANION_BOARDS);
  editing.reset(71);
  items.set(key, JSON.stringify(editing.snapshot()));
  const planKey = `daevanion-recalculated-plan:v1${model.suffix(character)}`;
  items.set(planKey, 'old-four-board-plan');
  const original = JSON.stringify(legacyRaw);
  assert.equal(ctx.window.DaevanionCharacterSession.addLumiel(character, rawBoards[79]), true);
  const upgraded = JSON.parse(items.get('daevanion-character-session:v1'));
  const saved = JSON.parse(items.get(key));
  for (const id of [71, 72, 73, 74]) assert.deepEqual(saved.boards[id], editing.snapshot().boards[id]);
  assert.deepEqual(saved.boards[79], []);
  assert.equal(items.has(planKey), false);
  assert.equal(JSON.stringify(legacyRaw), original);
  assert.equal(upgraded.rawBoards[79].nodeList.length, 225);
  const restored = context(upgraded).ctx.window;
  assert.equal(restored.DAEVANION_BOARDS.length, 5);
  assert.equal(restored.DAEVANION_CHARACTER.name, character.name);
  assert.equal(restored.DAEVANION_ALL_POWER_PLAN.budget, 837);
  assert.equal(restored.DAEVANION_ALL_POWER_PLAN.unknownCount, 0);
  assert.equal(restored.DAEVANION_ALL_POWER_PLAN.missingInputCount, 0);
});

test('Lumiel migration rolls back the edit write if the source record cannot be saved', () => {
  const legacyRaw = structuredClone(rawBoards);
  delete legacyRaw[79];
  const record = { version: 1, character, rawBoards: legacyRaw };
  const { ctx, items, storage } = context(record);
  const key = `daevanion-planner:v2${model.suffix(character)}`;
  const saved = JSON.stringify(new Planner(ctx.window.DAEVANION_BOARDS).snapshot());
  items.set(key, saved);
  const planKey = `daevanion-recalculated-plan:v1${model.suffix(character)}`;
  items.set(planKey, 'old-four-board-plan');
  const original = items.get('daevanion-character-session:v1');
  const set = storage.setItem;
  let writes = 0;
  storage.setItem = (key, value) => {
    if (++writes === 2) throw Error('quota');
    set(key, value);
  };
  assert.throws(() => ctx.window.DaevanionCharacterSession.addLumiel(character, rawBoards[79]));
  assert.equal(items.get(key), saved);
  assert.equal(items.get(planKey), 'old-four-board-plan');
  assert.equal(items.get('daevanion-character-session:v1'), original);
});

test('migration preserves stored edits when a new source budget is smaller than the old edited cost', () => {
  const legacyRaw = structuredClone(rawBoards);
  delete legacyRaw[79];
  for (const raw of Object.values(legacyRaw)) for (const node of raw.nodeList) node.open = 0;
  const { ctx, items } = context({ version: 1, character, rawBoards: legacyRaw });
  const key = `daevanion-planner:v2${model.suffix(character)}`;
  const { boards } = model.prepareBoards(rawBoards, character, Planner);
  const edited = new Planner(boards.filter(board => board.id !== 79));
  items.set(key, JSON.stringify(edited.snapshot()));
  const before = new Map(items);
  const lumiel = structuredClone(rawBoards[79]);
  const nearRoot = lumiel.nodeList.find(node => node.type === 'Stat' && Math.abs(node.col - 8) + Math.abs(node.row - 8) === 1);
  nearRoot.open = 1;
  assert.throws(() => ctx.window.DaevanionCharacterSession.addLumiel(character, lumiel), /초과/);
  assert.deepEqual(items, before);
});

test('different source class decades cannot be merged into one character', () => {
  const mixed = structuredClone(rawBoards);
  mixed[79].sourceBoardId = 89;
  assert.throws(() => model.prepareBoards(mixed, character, Planner), /직업별/);
});
