import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli } from './helpers.mjs';
import { isValidPhase } from '../plugin/scripts/lib/history.mjs';
import { computeTotals } from '../plugin/scripts/lib/totals.mjs';

const PLAN = '# Plan\n\n## Tasks\n- [TODO] **Task 4** (owner): o\n- [TODO] **Task 5** (backend): b\n';
const mk = () => mkFixture({ files: { 'plan.md': PLAN } });
const readFj = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));

test('AC19: isValidPhase owner.task', () => {
  assert.equal(isValidPhase('owner.task=4'), true);
  assert.equal(isValidPhase('owner.task=x'), false);
});

test('AC19: owner task DONE appends exactly one entry; repeat appends none', () => {
  const fx = mk();
  try {
    assert.equal(runCli(['task', '4', 'status', 'DONE'], { cwd: fx.root }).status, 0);
    assert.equal(runCli(['task', '4', 'status', 'DONE'], { cwd: fx.root }).status, 0);
    const h = readFj(fx).history;
    assert.equal(h.length, 1);
    assert.equal(h[0].phase, 'owner.task=4');
    assert.equal(h[0].subagent, 'owner');
    assert.equal(h[0].status, 'DONE');
    assert.equal(h[0].model, 'n/a');
    assert.equal(h[0].executor, 'cli');
    assert.ok(h[0].ts);
    assert.deepEqual(computeTotals(h), computeTotals([]));
  } finally { fx.cleanup(); }
});

test('AC19: non-owner task and other statuses append nothing', () => {
  const fx = mk();
  try {
    runCli(['task', '5', 'status', 'DONE'], { cwd: fx.root });
    runCli(['task', '4', 'status', 'IN PROGRESS'], { cwd: fx.root });
    assert.equal(readFj(fx).history.length, 0);
  } finally { fx.cleanup(); }
});
