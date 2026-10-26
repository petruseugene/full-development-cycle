import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { requiredGates, taskNumbers } from '../plugin/scripts/lib/dod.mjs';

const FIXTURE = new URL('./fixtures/plans/owner-content.md', import.meta.url);
const h = (phase, status) => ({ ts: '2026-01-01T00:00:00Z', phase, subagent: 'x', status });

function planWith(status) {
  return `# Plan\n\n## Tasks\n- [DONE] **Task 1** (backend): a\n- [${status}] **Task 2** (owner): b\n`;
}
const happy = () => [h('spec', 'DONE'), h('plan', 'DONE'), h('implement.task=1', 'DONE'),
  h('static-check', 'PASSED'), h('review', 'APPROVED')];

test('AC24: requiredGates owner.task keys only with owner_blocking', () => {
  assert.deepEqual(requiredGates({ track: 'full' }, [1], [2]).filter((g) => g.startsWith('owner.')), []);
  assert.deepEqual(requiredGates({ track: 'full', owner_blocking: false }, [1], [2]).filter((g) => g.startsWith('owner.')), []);
  const g = requiredGates({ track: 'full', owner_blocking: true }, [1], [2]);
  assert.equal(g[g.indexOf('implement.task=1') + 1], 'owner.task=2');
});

test('AC24: dod with owner_blocking', () => {
  const run = (over, status) => {
    const fx = mkFixture({
      featureJson: sampleFeatureJson({ auto_tests: false, history: happy(), ...over }),
      files: { 'plan.md': planWith(status) },
    });
    try { return runCli(['dod'], { cwd: fx.root }); } finally { fx.cleanup(); }
  };
  assert.equal(run({}, 'TODO').status, 0);
  assert.equal(run({ owner_blocking: false }, 'TODO').status, 0);
  const r = run({ owner_blocking: true }, 'TODO');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /owner\.task=2/);
  assert.equal(run({ owner_blocking: true }, 'DONE').status, 0);
  // history cannot satisfy the owner gate
  const r2 = run({ owner_blocking: true, history: [...happy(), h('owner.task=2', 'DONE')] }, 'TODO');
  assert.equal(r2.status, 1);
});

test('AC30: groups schedules content task, excludes owner task', () => {
  const todo = fs.readFileSync(FIXTURE, 'utf8').replace(/\[IMPL-DONE\]/g, '[TODO]');
  const fx = mkFixture({ files: { 'plan.md': todo } });
  try {
    const r = runCli(['groups', '--json'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const flat = JSON.parse(r.stdout).flat();
    assert.ok(flat.includes(3));
    assert.ok(!flat.includes(2));
  } finally { fx.cleanup(); }
});

test('AC30: requiredGates includes content task; --all-from leaves owner task', () => {
  const fx = mkFixture({ files: { 'plan.md': fs.readFileSync(FIXTURE, 'utf8') } });
  try {
    const nums = taskNumbers(fs.readFileSync(FIXTURE, 'utf8'));
    assert.deepEqual(nums, [1, 3]);
    assert.ok(requiredGates({ track: 'full' }, nums).includes('implement.task=3'));
    const r = runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const text = fx.read(`docs/features/2026-01-01-00h-00m-sample/plan.md`);
    assert.match(text, /\[DONE\] \*\*Task 3\*\*/);
    assert.match(text, /\[IMPL-DONE\] \*\*Task 2\*\*/);
  } finally { fx.cleanup(); }
});
