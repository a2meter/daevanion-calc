'use strict';

importScripts('planner.js', 'optimizer.js', 'vendor/highs/highs.js');

self.onmessage = async event => {
  try {
    const { boards, values, required, candidates, certificate, seconds } = event.data;
    const problem = self.DaevanionOptimizer.createProblem(boards, values, { required });
    self.postMessage({ type: 'progress', message: '최적화 엔진을 준비하고 있습니다.' });
    const highs = await Module({ locateFile: file => new URL(`vendor/highs/${file}`, self.location.href).href });
    self.postMessage({ type: 'progress', message: '모든 보드의 연결과 공용 수량을 계산하고 있습니다.' });
    const solution = self.DaevanionOptimizer.solve(problem, highs, { candidates, certificate, seconds,
      progress: detail => self.postMessage({ type: 'progress', ...detail }) });
    self.postMessage({ type: 'result', solution });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '계산을 완료하지 못했습니다.' });
  }
};
