import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import fs from 'node:fs';
import { requiredGates, taskNumbers } from '../lib/dod.mjs';

const PLAN = `---\nstatus: IN PROGRESS\n---\n# Plan\n\n## Tasks\n- [DONE] **Task 1** (backend): a\n- [TODO] **Task 2** (backend) (owner): b
- [TODO] **Task 4** (owner): c
- [TODO] **Task 5** (backend, owner): d
- [TODO] **Task 6** (backend): ownership review\n- [IMPL-DONE] **Task 3** (frontend): c\n\n## Task details\n`;

const h = (phase, status) => ({ ts: '2026-01-01T00:00:00Z', phase, subagent: 'x', status });
const happy = () => [
  h('spec', 'DONE'), h('plan', 'DONE'),
  h('implement.task=1', 'DONE'), h('implement.task=3', 'DONE'), h('implement.task=6', 'DONE'),
  h('static-check', 'PASSED'), h('review', 'APPROVED'),
];

function fixture(over = {}) {
  return mkFixture({
    featureJson: sampleFeatureJson({ auto_tests: false, history: happy(), ...over }),
    files: { 'plan.md': PLAN },
  });
}

test('AC14: passes when all required gates end in pass set', () => {
  const fx = fixture();
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^DOD-GATE PASSED$/m);
    assert.equal(r.stdout, 'DOD-GATE PASSED\ntokens: 0 measured / 7 estimated entries\n');
  } finally { fx.cleanup(); }
});

test('AC14: DONE_WITH_CONCERNS fails with exact line; last entry wins', () => {
  const fx = fixture({ history: [...happy(), h('review', 'DONE_WITH_CONCERNS')] });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '! DOD-GATE FAILED: review last status = DONE_WITH_CONCERNS; aborting before push.\ntokens: 0 measured / 8 estimated entries\n');
  } finally { fx.cleanup(); }
  const fx2 = fixture({ history: [h('review', 'CHANGES_REQUIRED'), ...happy()] });
  try { assert.equal(runCli(['dod'], { cwd: fx2.root }).status, 0); } finally { fx2.cleanup(); }
});

test('missing task gate fails with MISSING; first failing gate only', () => {
  const hist = happy().filter((e) => e.phase !== 'implement.task=3' && e.phase !== 'review');
  const fx = fixture({ history: hist });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.split('\n')[0], '! DOD-GATE FAILED: implement.task=3 last status = MISSING; aborting before push.');
  } finally { fx.cleanup(); }
});

test('AC15: extra_gates adds gate.<name> requirement', () => {
  const profile = { extra_gates: [{ name: 'content', cmd: 'true' }] };
  const fx = fixture({ profile });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.split('\n')[0], '! DOD-GATE FAILED: gate.content last status = MISSING; aborting before push.');
  } finally { fx.cleanup(); }
  const fx2 = fixture({ profile, history: [...happy(), h('gate.content', 'PASSED')] });
  try { assert.equal(runCli(['dod'], { cwd: fx2.root }).status, 0); } finally { fx2.cleanup(); }
});

test('AC15: no profile => required set equals dod-gate.md formula', () => {
  assert.deepEqual(taskNumbers(PLAN), [1, 6, 3]); // owner tasks 2, 4, 5 excluded
  const all = { track: 'full', auto_tests: true, visual_tests: true, a11y_audit: true, dependency_audit: true, security_review: true };
  assert.deepEqual(requiredGates(all, [1, 2, 3, 4]), [
    'spec', 'plan', 'implement.task=1', 'implement.task=2', 'implement.task=3', 'implement.task=4',
    'static-check', 'review', 'auto-test', 'visual-test', 'a11y', 'deps-audit', 'security',
  ]);
  assert.deepEqual(requiredGates({ track: 'full' }, [1]), ['spec', 'plan', 'implement.task=1', 'static-check', 'review']);
  assert.deepEqual(requiredGates({}, []), ['spec', 'plan', 'static-check', 'review']);
  assert.deepEqual(requiredGates({ track: 'lite', areas: [{ name: 'skills' }, { name: 'dashboard' }] }),
    ['spec', 'implement.area=skills', 'implement.area=dashboard', 'static-check', 'review']);
  assert.deepEqual(requiredGates({ track: 'lite' }), ['spec', 'implement.area=<none>', 'static-check', 'review']);
  assert.deepEqual(requiredGates({ track: 'quick' }), ['implement', 'static-check', 'review']);
  assert.deepEqual(requiredGates({ track: 'quick', profile: { extra_gates: [] } }), ['implement', 'static-check', 'review']);
});

test('lite with no areas fails with implement.area=<none>; quick passes; --json', () => {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ track: 'lite', auto_tests: false, history: [h('spec', 'DONE')] }) });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.split('\n')[0], '! DOD-GATE FAILED: implement.area=<none> last status = MISSING; aborting before push.');
  } finally { fx.cleanup(); }
  const fx2 = mkFixture({ featureJson: sampleFeatureJson({ track: 'quick', auto_tests: false,
    history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED')] }) });
  try {
    const r = runCli(['dod', '--json'], { cwd: fx2.root });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).passed, true);
  } finally { fx2.cleanup(); }
});

const fixture2 = (rel) => fs.readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8');
const ok = (...phases) => phases.map((p) => h(p, 'DONE'));
const tail = () => [h('static-check', 'PASSED'), h('review', 'APPROVED')];

test('AC40: dod skips (owner), (backend, owner) and **Tag:** owner tasks (shared fixture)', () => {
  assert.deepEqual(taskNumbers(fixture2('plans/owner-tags.md')), [1, 5, 6]);
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ auto_tests: false,
      history: [...ok('spec', 'plan', 'implement.task=1', 'implement.task=5', 'implement.task=6'), ...tail()] }),
    files: { 'plan.md': fixture2('plans/owner-tags.md') },
  });
  try {
    const r = runCli(['dod', '--json'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!JSON.parse(r.stdout).required.some((g) => /task=(2|3|4)$/.test(g)));
  } finally { fx.cleanup(); }
});

test('AC37: separate_plan false drops plan gate and passes on spec tasks', () => {
  assert.deepEqual(requiredGates({ track: 'full', separate_plan: false }, [1, 2]),
    ['spec', 'implement.task=1', 'implement.task=2', 'static-check', 'review']);
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ auto_tests: false, separate_plan: false,
      history: [...ok('spec', 'implement.task=1', 'implement.task=2'), ...tail()] }),
    files: { 'spec.md': fixture2('spec-tasks/spec.md') },
  });
  try {
    const r = runCli(['dod', '--json'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.passed, true);
    assert.deepEqual(out.required, ['spec', 'implement.task=1', 'implement.task=2', 'static-check', 'review']);
  } finally { fx.cleanup(); }
});

test('AC37: separate_plan false with no ## Tasks fails with gate tasks MISSING', () => {
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ auto_tests: false, separate_plan: false, history: [...ok('spec'), ...tail()] }),
    files: { 'spec.md': '---\nstatus: IN PROGRESS\n---\n# Spec\n' },
  });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.split('\n')[0], '! DOD-GATE FAILED: tasks last status = MISSING; aborting before push.');
  } finally { fx.cleanup(); }
});

test('AC37: separate_plan absent still requires plan (legacy)', () => {
  assert.deepEqual(requiredGates({ track: 'full' }, [1]), ['spec', 'plan', 'implement.task=1', 'static-check', 'review']);
  assert.deepEqual(requiredGates({ track: 'full', separate_plan: true }, []), ['spec', 'plan', 'static-check', 'review']);
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ auto_tests: false,
      history: [...ok('spec', 'implement.task=1', 'implement.task=2'), ...tail()] }),
    files: { 'spec.md': fixture2('spec-tasks/spec.md') },
  });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.equal(r.stdout.split('\n')[0], '! DOD-GATE FAILED: plan last status = MISSING; aborting before push.');
  } finally { fx.cleanup(); }
});

test('AC42: bugfix/hotfix use the quick set whatever track says', () => {
  assert.deepEqual(requiredGates({ flow: 'bugfix', track: 'full', auto_tests: true }, [1, 2]),
    ['implement', 'static-check', 'review', 'auto-test']);
  assert.deepEqual(requiredGates({ flow: 'hotfix', track: 'lite', security_review: true, profile: { extra_gates: [{ name: 'x' }] } }),
    ['implement', 'static-check', 'review', 'security', 'gate.x']);
  const g = requiredGates({ flow: 'bugfix', track: 'full' }, [1]);
  assert.ok(!g.includes('spec') && !g.includes('plan'));
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ flow: 'bugfix', track: 'full', auto_tests: false, history: [...ok('implement'), ...tail()] }),
    files: { 'plan.md': fixture2('plans/owner-tags.md') },
  });
  try { assert.equal(runCli(['dod'], { cwd: fx.root }).status, 0); } finally { fx.cleanup(); }
});

test('AC24: a11y and deps-audit match by phase for old and new subagents', () => {
  for (const sub of ['dev-cycle:visual-tester', 'dev-cycle:a11y-auditor']) {
    const hist = [...happy(), { ts: 'x', phase: 'a11y', subagent: sub, status: 'PASSED' },
      { ts: 'x', phase: 'deps-audit', subagent: sub.replace(/visual-tester|a11y-auditor/, 'security-reviewer'), status: 'PASSED' }];
    const fx = fixture({ a11y_audit: true, dependency_audit: true, history: hist });
    try {
      const r = runCli(['dod'], { cwd: fx.root });
      assert.equal(r.status, 0, `${sub}: ${r.stderr}${r.stdout}`);
    } finally { fx.cleanup(); }
  }
  const fx = fixture({ a11y_audit: true, dependency_audit: true });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /a11y/);
  } finally { fx.cleanup(); }
});
