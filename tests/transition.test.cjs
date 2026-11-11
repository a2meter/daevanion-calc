const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { plan } = require('../assets/transition.js');
const { Planner, COSTS, STATE_VERSION } = require('../assets/planner.js');
const node=(id,row,col,open=0,grade='Common',type='Stat')=>({nodeId:id,row,col,open,grade,type,name:`노드 ${id}`,effectList:[]});
const root=id=>node(id,8,8,0,'None','Start');
const state=boards=>({version:STATE_VERSION,boards});
const real=()=>{const ctx={window:{}};vm.runInNewContext(fs.readFileSync(`${__dirname}/../boards/manifest.js`,'utf8'),ctx);return JSON.parse(JSON.stringify(ctx.window.DAEVANION_BOARDS));};

// Replay every individual toggle independently of Planner's mutation methods.
function replay(boards,target,result){
 assert.equal(result.ok,true,result.message);
 const budget=new Planner(boards).total;
 const active=new Map(boards.map(b=>[b.id,new Set(b.nodes.filter(n=>n.type!=='Start'&&n.open===1).map(n=>n.nodeId))]));
 const byBoard=new Map(boards.map(b=>[b.id,b]));
 const used=()=>boards.reduce((sum,b)=>sum+b.nodes.filter(n=>active.get(b.id).has(n.nodeId)).reduce((s,n)=>s+COSTS[n.grade],0),0);
 assert.equal(result.initialUsed,used());
 for(const [i,step] of result.steps.entries()){
  assert.equal(step.order,i+1);
  const b=byBoard.get(step.boardId),n=b.nodes.find(n=>n.nodeId===step.nodeId),set=active.get(b.id);
  assert.notEqual(n.type,'Start');
  if(step.action==='deactivate'){assert.ok(set.has(n.nodeId));set.delete(n.nodeId);}
  else{assert.equal(step.action,'activate');assert.ok(!set.has(n.nodeId));set.add(n.nodeId);}
  for(const b of boards){
   const r=b.nodes.find(n=>n.type==='Start');
   const available=b.nodes.filter(n=>n.type==='Start'||active.get(b.id).has(n.nodeId));
   const positions=new Map(available.map(n=>[`${n.row},${n.col}`,n]));
   const seen=new Set([r.nodeId]),queue=[r];
   for(const n of queue)for(const [row,col] of [[n.row-1,n.col],[n.row+1,n.col],[n.row,n.col-1],[n.row,n.col+1]]){
    const next=positions.get(`${row},${col}`);if(next&&!seen.has(next.nodeId)){seen.add(next.nodeId);queue.push(next);}
   }
   assert.equal(seen.size,active.get(b.id).size+1,`disconnected at step ${i+1}`);
  }
  assert.ok(used()<=budget,`overspending at step ${i+1}`);
  assert.equal(step.remaining,budget-used());
 }
 for(const [id,ids] of Object.entries(target.boards))assert.deepEqual([...active.get(Number(id))].sort((a,b)=>a-b),[...ids].sort((a,b)=>a-b));
 assert.equal(result.targetUsed,used());
}

test('bridge removal waits for a funded alternative connection, and numbering spans the whole transition',()=>{
 const boards=[{id:71,name:'보드',nodes:[root(1),node(2,7,8,1),node(3,7,9,1),node(4,8,9),node(5,9,8,1),node(6,8,7)]}];
 const target=state({71:[3,4,6]});const result=plan(boards,target);
 replay(boards,target,result);
 assert.equal(result.temporarySteps,0);
 const index=id=>result.steps.findIndex(s=>s.nodeId===id);
 assert.ok(index(5)<index(4)); // free the source-only leaf before paying for the new bridge
 assert.ok(index(4)<index(2)); // new bridge before removing the old bridge
});

test('a full-budget bridge cycle includes safe temporary removal and restoration of shared nodes',()=>{
 const boards=[{id:71,name:'보드',nodes:[root(1),node(2,7,8,1),node(3,7,9,1),node(4,8,9),node(5,6,9,1)]}];
 const target=state({71:[3,4,5]});const result=plan(boards,target);
 replay(boards,target,result);
 assert.ok(result.temporarySteps>0);
 for(const id of [5]){
  const steps=result.steps.filter(s=>s.nodeId===id);
  assert.deepEqual(steps.map(s=>s.action),['deactivate','activate']);
  assert.ok(steps.every(s=>s.temporary));
 }
 assert.equal(result.steps.filter(s=>s.nodeId===3).length,0);
 assert.equal(result.steps.filter(s=>s.nodeId===2).length,1);
 assert.equal(result.steps.filter(s=>s.nodeId===4).length,1);
});

test('points refunded on another board fund additions under the one shared pool',()=>{
 const boards=[{id:71,name:'첫째',nodes:[root(1),node(2,7,8,1,'Unique')]},
 {id:72,name:'둘째',nodes:[root(10),node(11,7,8),node(12,6,8),node(13,5,8),node(14,4,8)]}];
 const target=state({71:[],72:[11,12,13,14]});const result=plan(boards,target);
 replay(boards,target,result);
 assert.equal(result.steps[0].boardId,71);
 assert.equal(result.steps[0].remaining,4);
 assert.deepEqual(result.steps.slice(1).map(s=>s.boardId),[72,72,72,72]);
});

test('real five-board source to optimized layout is replayable without changing inputs',()=>{
 const boards=real();const saved=JSON.stringify(boards);
 const built=JSON.parse(fs.readFileSync(`${__dirname}/../boards/all-power-plan.json`,'utf8'));
 const target=state(Object.fromEntries(Object.values(built.boards).map(b=>[b.boardId,b.nodeIds])));
 const result=plan(boards,target);replay(boards,target,result);
 assert.equal(result.budget,837);
 assert.equal(result.steps.at(-1).remaining,0);
 assert.equal(JSON.stringify(boards),saved);
 assert.deepEqual(plan(boards,target),result);
});

test('zero-source fallback can build the target using 837 points; partial and unchanged targets are supported',()=>{
 const boards=real();const original=new Planner(boards).snapshot();
 assert.deepEqual(plan(boards,original).steps,[]);
 const partial=structuredClone(original);partial.boards[71]=[];
 replay(boards,partial,plan(boards,partial));
 const blank=boards.map(b=>({...b,nodes:b.nodes.map(n=>({...n,open:0}))}));
 const result=plan(blank,original);replay(blank,original,result);
 assert.equal(result.initialUsed,0);assert.equal(result.budget,837);
 assert.ok(result.steps.every(s=>s.action==='activate'&&!s.temporary));
});

test('disconnected, overspending and malformed targets never receive executable numbers',()=>{
 const boards=[{id:71,name:'보드',nodes:[root(1),node(2,7,8,1),node(3,6,8),node(4,8,9,0,'Unique')]}];
 for(const target of [state({71:[3]}),state({71:[2,4]}),state({71:[1]}),state({71:[2,2]}),state({}),null]){
  const result=plan(boards,target);assert.equal(result.ok,false);assert.deepEqual(result.steps,[]);
 }
});

test('small cyclic boards support every connected source/target pair within budget',()=>{
 const base=[root(1),node(2,7,8),node(3,7,9,0,'Rare'),node(4,8,9),node(5,9,8,0,'Unique'),node(6,9,9),node(7,8,7)];
 const definition=[{id:71,name:'순환 보드',nodes:base}];
 const validator=new Planner(definition);
 const states=[];
 for(let mask=0;mask<64;mask++){
  const ids=base.slice(1).filter((n,i)=>mask&(1<<i)).map(n=>n.nodeId);
  const checked=validator.validateBoard(71,ids);if(checked.ok)states.push({ids,cost:checked.cost});
 }
 for(const source of states){
  const boards=[{...definition[0],nodes:base.map(n=>({...n,open:source.ids.includes(n.nodeId)?1:0}))}];
  for(const goal of states){
   if(goal.cost>(source.cost||837))continue;
   const target=state({71:goal.ids}),result=plan(boards,target);
   replay(boards,target,result);
   assert.ok(result.steps.length<=3*(base.length-1));
  }
 }
});
