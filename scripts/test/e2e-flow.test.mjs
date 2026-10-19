import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, leftoverTempFiles } from './helpers.mjs';

const SPEC = `---
status: [TODO]
---
# Spec

## Acceptance criteria
- [ ] AC1: first criterion
- [ ] AC2: second criterion
- [ ] AC3: third criterion
`;

const PLAN = `---
status: [TODO]
---
# Plan

## Tasks
- [TODO] **Task 1** (backend): schema
- [TODO] **Task 2** (backend): api
- [TODO] **Task 3** (frontend): ui

## Task details

### Task 1: schema \`[TODO]\`
**Acceptance:** AC1
**Touches:** \`db/**\`
**Depends on:** none

### Task 2: api \`[TODO]\`
**Acceptance:** AC2
**Touches:** \`api/**\`
**Depends on:** Task 1

### Task 3: ui \`[TODO]\`
**Acceptance:** AC2-AC3
**Touches:** \`ui/**\`
**Depends on:** Task 1
`;

const hist = (fj, phase, subagent, status, extra = []) =>
  runCli(['history', 'add', '--phase', phase, '--subagent', subagent, '--status', status, ...extra], { cwd: fj.root });

test('e2e: feature init -> task/spec status -> history -> groups -> brief -> dod (profile with extra gate)', () => {
  const fx = mkFixture({ feature: '2000-01-01-00h-00m-seed', featureJson: null });
  try {
    fx.write('.dev-cycle/project.json', JSON.stringify({
      platform: 'web',
      guards: ['No secrets'],
      rules: [{ globs: ['api/**'], text: 'API-RULE' }],
      extra_gates: [{ name: 'content', cmd: 'echo ok' }],
    }));
    let r = runCli(['feature', 'init', 'e2e', '--flow', 'feature', '--track', 'full',
      '--answer', 'auto_tests=false', '--answer', 'visual_tests=false'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const dir = r.stdout.trim();
    fs.writeFileSync(path.join(dir, 'spec.md'), SPEC);
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN);
    const F = ['--feature', dir];

    // groups
    r = runCli(['groups', '--all', '--json', ...F], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [[1], [2, 3]]);

    // task statuses
    for (const n of [1, 2, 3]) {
      r = runCli(['task', String(n), 'status', 'IN-PROGRESS', ...F], { cwd: fx.root });
      assert.equal(r.status, 0, r.stderr);
    }
    for (const n of [1, 2, 3]) {
      assert.equal(runCli(['task', String(n), 'status', 'IMPL-DONE', ...F], { cwd: fx.root }).status, 0);
    }
    r = runCli(['groups', '--json', ...F], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);
    assert.match(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), /- \[IMPL-DONE\] \*\*Task 3\*\*/);

    // brief
    r = runCli(['brief', '2', ...F], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const brief = fs.readFileSync(path.join(dir, 'briefs', 'task-2.md'), 'utf8');
    assert.match(brief, /AC2: second criterion/);
    assert.doesNotMatch(brief, /AC3: third/);
    assert.match(brief, /API-RULE/);
    assert.match(brief, /No secrets/);

    // dod fails before history, names first missing gate
    r = runCli(['dod', ...F], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /! DOD-GATE FAILED: spec last status = MISSING; aborting before push\./);

    // history
    const fj0 = { root: fx.root };
    const withF = (x) => [...x, ...F];
    for (const [p, s, st] of [
      ['spec', 'spec-writer', 'DONE'], ['plan', 'plan-writer', 'DONE'],
      ['implement.task=1', 'backend-dev', 'DONE'], ['implement.task=2', 'backend-dev', 'DONE'],
      ['implement.task=3', 'frontend-dev', 'DONE'], ['static-check', 'static-checker', 'PASSED'],
      ['review', 'code-reviewer', 'APPROVED'],
    ]) {
      r = hist(fj0, p, s, st, withF(['--duration', '1m 2s', '--tokens', '~2k']));
      assert.equal(r.status, 0, r.stderr);
    }
    // extra gate still missing
    r = runCli(['dod', ...F], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /! DOD-GATE FAILED: gate\.content last status = MISSING; aborting before push\./);

    // run the extra gate -> writes history -> dod passes
    r = runCli(['gate', 'run', '--all', ...F], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    r = runCli(['dod', ...F], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /DOD-GATE PASSED/);

    // finish: spec/task DONE
    assert.equal(runCli(['task', '--all-from', 'IMPL-DONE', '--to', 'DONE', ...F], { cwd: fx.root }).status, 0);
    assert.equal(runCli(['spec', 'status', 'DONE', ...F], { cwd: fx.root }).status, 0);
    assert.match(fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'), /^status: \[DONE\]$/m);
    assert.match(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), /^status: \[DONE\]$/m);

    // totals consistent with history, no temp leftovers
    const fj = JSON.parse(fs.readFileSync(path.join(dir, 'feature.json'), 'utf8'));
    assert.equal(fj.history.length, 8);
    assert.equal(fj.history[7].phase, 'gate.content');
    assert.equal(fj.totals.by_subagent['backend-dev'].calls, 2);
    assert.equal(fj.totals.by_model.inherit.calls, 7); // gate entries are not dispatches
    assert.deepEqual(leftoverTempFiles(dir), []);
  } finally { fx.cleanup(); }
});
