import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, runCli, leftoverTempFiles } from './helpers.mjs';
import { changedLines } from './plan.test.mjs';

const fx = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/plans/${name}`, import.meta.url)), 'utf8');

function setup(t, files) {
  const f = mkFixture({ files });
  t.after(() => f.cleanup());
  return f;
}
const readPlan = (f) => fs.readFileSync(path.join(f.featureDir, 'plan.md'), 'utf8');
const readSpec = (f) => fs.readFileSync(path.join(f.featureDir, 'spec.md'), 'utf8');

test('AC5: task status changes exactly list line + heading', (t) => {
  const f = setup(t, { 'plan.md': fx('status-mix.md') });
  const before = readPlan(f);
  const r = runCli(['task', '3', 'status', 'IMPL-DONE'], { cwd: f.root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(changedLines(before, readPlan(f)).length, 2);

  const mid = readPlan(f);
  const r2 = runCli(['task', '4', 'status', 'IN-PROGRESS'], { cwd: f.root });
  assert.equal(r2.status, 0, r2.stderr);
  const idx = changedLines(mid, readPlan(f));
  assert.equal(idx.length, 1);
  assert.equal(readPlan(f).split('\n')[idx[0]], '- [IN PROGRESS] **Task 4** (backend): No detail section');
  assert.deepEqual(leftoverTempFiles(f.featureDir), []);
});

test('AC6: unknown task or status exits 2, plan unchanged', (t) => {
  const f = setup(t, { 'plan.md': fx('status-mix.md') });
  const before = readPlan(f);
  for (const args of [['task', '99', 'status', 'DONE'], ['task', '1', 'status', 'FOO'], ['task', 'x', 'status', 'DONE'], ['task', '1', 'status']]) {
    const r = runCli(args, { cwd: f.root });
    assert.equal(r.status, 2, args.join(' '));
    assert.notEqual(r.stderr, '');
    assert.equal(readPlan(f), before);
  }
});

test('AC7: --all-from IMPL-DONE --to DONE skips owner and BLOCKED', (t) => {
  const f = setup(t, { 'plan.md': fx('status-mix.md') });
  const before = readPlan(f);
  const r = runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE', '--json'], { cwd: f.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).changed, [1, 6]);
  const after = readPlan(f);
  assert.equal(changedLines(before, after).length, 4); // 2 tasks x (list + heading)
  assert.match(after, /- \[IMPL-DONE\] \*\*Task 2\*\* \(owner\)/);
  assert.match(after, /- \[BLOCKED\] \*\*Task 5\*\*/);
  assert.match(after, /- \[TODO\] \*\*Task 7\*\*/);

  const human = runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE'], { cwd: f.root });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /no tasks flipped/);

  const bad = runCli(['task', '--all-from', 'TODO', '--to', 'DONE'], { cwd: f.root });
  assert.equal(bad.status, 2);
  assert.equal(readPlan(f), after);
  assert.equal(runCli(['task', '--all-from', 'IMPL-DONE'], { cwd: f.root }).status, 2);
});

test('AC8: spec status rewrites only frontmatter; DONE also plan frontmatter', (t) => {
  const f = setup(t, { 'plan.md': fx('status-mix.md'), 'spec.md': fx('spec-status.md') });
  const planBefore = readPlan(f);
  const specBefore = readSpec(f);

  const r0 = runCli(['spec', 'status', 'IN-PROGRESS'], { cwd: f.root });
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(readPlan(f), planBefore);
  assert.deepEqual(changedLines(specBefore, readSpec(f)), [3]);
  assert.equal(readSpec(f).split('\n')[3], 'status: [IN PROGRESS]');

  const r = runCli(['spec', 'status', 'DONE'], { cwd: f.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(changedLines(specBefore, readSpec(f)), [3]);
  assert.equal(readSpec(f).split('\n')[3], 'status: [DONE]');
  assert.ok(readSpec(f).endsWith('status: foo\n'));
  assert.deepEqual(changedLines(planBefore, readPlan(f)), [3]);
  assert.equal(readPlan(f).split('\n')[3], 'status: [DONE]');
  assert.deepEqual(leftoverTempFiles(f.featureDir), []);
});

test('spec status: bad input exits 2; missing plan.md is tolerated', (t) => {
  const f = setup(t, { 'spec.md': fx('spec-status.md') });
  assert.equal(runCli(['spec', 'status', 'FOO'], { cwd: f.root }).status, 2);
  assert.equal(runCli(['spec', 'bogus', 'DONE'], { cwd: f.root }).status, 2);
  assert.equal(runCli(['spec', 'status', 'DONE'], { cwd: f.root }).status, 0);
  const g = setup(t, { 'spec.md': '# no frontmatter\n' });
  assert.equal(runCli(['spec', 'status', 'DONE'], { cwd: g.root }).status, 2);
});

test('AC40: --all-from skips (owner), (backend, owner) and **Tag:** owner tasks (shared fixture)', (t) => {
  const f = setup(t, { 'plan.md': fx('owner-tags.md') });
  const r = runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE', '--json'], { cwd: f.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).changed, [1, 5]);
});

test('AC36: task status and --all-from write spec.md tasks; frontmatter byte-unchanged', (t) => {
  const spec = fs.readFileSync(fileURLToPath(new URL('./fixtures/spec-tasks/spec.md', import.meta.url)), 'utf8');
  const f = setup(t, { 'spec.md': spec });
  const fm = (s) => s.split('\n').slice(0, 3).join('\n');
  const r = runCli(['task', '1', 'status', 'IN-PROGRESS'], { cwd: f.root });
  assert.equal(r.status, 0, r.stderr);
  const mid = readSpec(f);
  assert.equal(changedLines(spec, mid).length, 2);
  assert.match(mid, /^- \[IN PROGRESS\] \*\*Task 1\*\* \(backend\): API endpoint$/m);
  assert.match(mid, /^### Task 1: API endpoint {2}`\[IN PROGRESS\]`$/m);

  const r2 = runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE', '--json'], { cwd: f.root });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(JSON.parse(r2.stdout).changed, [2]); // task 3 is (backend, owner)
  const after = readSpec(f);
  assert.equal(fm(after), fm(spec));
  assert.equal(after.split('\n')[1], 'status: IN PROGRESS');
  assert.equal(changedLines(mid, after).length, 2);
  assert.equal(fs.existsSync(path.join(f.featureDir, 'plan.md')), false);
  assert.deepEqual(leftoverTempFiles(f.featureDir), []);
});

test('task commands exit 2 when neither plan.md nor spec.md ## Tasks exists', (t) => {
  const f = setup(t, { 'spec.md': fx('spec-status.md') });
  const before = readSpec(f);
  const r = runCli(['task', '1', 'status', 'DONE'], { cwd: f.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /plan\.md/);
  assert.equal(runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE'], { cwd: f.root }).status, 2);
  assert.equal(readSpec(f), before);
});
