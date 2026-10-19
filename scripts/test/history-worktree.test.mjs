import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture } from './helpers.mjs';
import { isValidPhase, appendHistory } from '../lib/history.mjs';
import { computeTotals } from '../lib/totals.mjs';

const readFj = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));

test('worktree is a valid phase', () => {
  assert.equal(isValidPhase('worktree'), true);
});

test('AC21: worktree task and group entries round-trip and leave totals unchanged', () => {
  const fx = mkFixture();
  try {
    appendHistory(fx.featureDir, { phase: 'implement.task=1', subagent: 'backend-dev', status: 'DONE', duration_s: 10, tokens_k: 2 });
    const before = computeTotals(readFj(fx).history);
    const task = appendHistory(fx.featureDir, {
      phase: 'worktree', subagent: 'cli', status: 'CONFLICT', task: 2,
      touches_expanded: ['a.js'], files: ['a.js', 'b.js'], conflicts: [{ path: 'b.js', reason: 'symlink' }], mode: 'collect',
    });
    const group = appendHistory(fx.featureDir, { phase: 'worktree', subagent: 'cli', status: 'ISOLATED', tasks: [1, 2], stray: ['x.txt'] });
    appendHistory(fx.featureDir, { phase: 'worktree', subagent: 'cli', status: 'AUDIT', tasks: [1], stray: [] });
    const fj = readFj(fx);
    assert.deepEqual(fj.history[1], task);
    assert.deepEqual(fj.history[2], group);
    assert.deepEqual(fj.history[1].conflicts, [{ path: 'b.js', reason: 'symlink' }]);
    assert.deepEqual(fj.history[2].tasks, [1, 2]);
    assert.deepEqual(fj.totals.by_subagent, before.by_subagent);
    assert.deepEqual(fj.totals.by_model, before.by_model);
    assert.deepEqual(fj.totals.measured, before.measured);
  } finally { fx.cleanup(); }
});
