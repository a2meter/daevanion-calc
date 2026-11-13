#!/usr/bin/env node
// Solves the bundled five-board plan with the web optimizer and stores it as
// boards/all-optimization.json, the cache scripts/build_boards.py validates.
//
//   node scripts/solve_plan.cjs [seconds]      (default 120, at most 600)
//   python3 scripts/build_boards.py            (validates and regenerates the files)
//
// The option values, the skill level sequences and the model hash come from
// `build_boards.py --model`, so this script and the validation that follows
// read the same inputs. Set PYTHON when the interpreter is not `python3`.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const optimizer = require('../assets/optimizer.js');
const loadHighs = require('../assets/vendor/highs/highs.js');

const root = path.join(__dirname, '..');
const cachePath = path.join(root, 'boards', 'all-optimization.json');
const seconds = process.argv[2] === undefined ? 120 : Number(process.argv[2]);

async function main() {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new Error('계산 시간은 0~600초 사이로 지정하십시오.');
  const python = process.env.PYTHON || 'python3';
  let inputs;
  try {
    inputs = JSON.parse(execFileSync(python, [path.join(__dirname, 'build_boards.py'), '--model'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
  } catch (error) {
    throw new Error(`파이썬(${python})으로 scripts/build_boards.py --model을 실행하지 못했습니다. 실행 파일은 PYTHON 환경 변수로 지정할 수 있습니다. (${error.message})`);
  }
  const boards = inputs.boards.map(id => ({ id, name: String(id),
    nodes: JSON.parse(fs.readFileSync(path.join(root, 'boards', `${id}.json`), 'utf8')).nodeList.filter(node => node.type !== 'None') }));
  const problem = optimizer.createProblem(boards, inputs.values, { skills: inputs.skills });
  if (problem.budget !== inputs.budget) throw new Error('계산용 수량이 build_boards.py의 모형과 다릅니다.');

  // The stored plan is only a starting layout. solve() repairs it when the
  // budget or the boards changed, and never returns less than a valid start.
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* No earlier result to start from. */ }
  const candidates = Array.isArray(cache?.nodeIds) ? [Object.fromEntries(problem.graphs.map(graph =>
    [graph.id, cache.nodeIds.filter(id => problem.byId.get(id)?.boardId === graph.id)]))] : [];
  const before = candidates.length ? optimizer.validate(problem, candidates[0]) : null;
  // A stored plan of this same model was scored by build_boards.py, so the web model must score it alike.
  const sameModel = before !== null && cache.modelHash === inputs.modelHash;
  if (sameModel && !(Math.abs(before.power - cache.power) <= 1e-7)) {
    throw new Error('저장된 구성의 점수가 웹 계산 모형과 다릅니다. build_boards.py와 assets/optimizer.js의 모형을 확인하십시오.');
  }

  const started = Date.now();
  const solved = optimizer.solve(problem, await loadHighs(), { candidates, seconds });
  const verified = optimizer.validate(problem, solved.selections);
  if (!verified || verified.cost !== problem.budget || verified.power !== solved.power || solved.upperBound < verified.power) {
    throw new Error('계산 결과의 연결, 수량 또는 전투력 검증에 실패했습니다.');
  }
  // An earlier upper bound holds only for the identical model.
  const upperBound = sameModel && Number.isFinite(cache.upperBound) && cache.upperBound >= verified.power
    ? Math.min(cache.upperBound, solved.upperBound) : solved.upperBound;
  const result = { nodeIds: Object.values(solved.selections).flat().sort((a, b) => a - b), power: verified.power, upperBound,
    gap: (upperBound - verified.power) / Math.max(1, Math.abs(verified.power)),
    status: upperBound === verified.power ? 'optimal' : 'feasible', solver: solved.solver, modelHash: inputs.modelHash };
  fs.writeFileSync(`${cachePath}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(`${cachePath}.tmp`, cachePath);

  const number = value => value.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
  console.log(`${Math.round((Date.now() - started) / 1000)}초 계산 · 노드 ${result.nodeIds.length}개 · 데바니온 ${verified.cost}개 · 기록값 점수 ${number(result.power)}점 · 상한 ${number(upperBound)}점 · ${result.status}`);
  if (before) console.log(`이전 저장본의 구성은 현재 모형에서 ${number(before.power)}점입니다.`);
  console.log('boards/all-optimization.json에 기록했습니다. python3 scripts/build_boards.py로 검증하고 보드 파일을 다시 생성하십시오.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
