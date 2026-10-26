import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson, SCRIPTS_DIR } from './helpers.mjs';
import { analyzeSpec } from '../plugin/scripts/lib/spec-analyze.mjs';

const SPEC = (acs, extra = '') => `---\nstatus: [IN PROGRESS]\n---\n# S\n\n## 6. Acceptance Criteria\n${acs}\n${extra}`;
const PLAN = (tasks) => `---\nstatus: [IN PROGRESS]\n---\n# Plan\n\n## Tasks\n${tasks.map(([n, st, ac, tag = 'backend']) => `- [${st}] **Task ${n}** (${tag}): t${n}`).join('\n')}\n\n## Task details\n${tasks.map(([n, , ac]) => `### Task ${n}: t${n}\n- **Acceptance:** ${ac}\n`).join('\n')}`;

function setup(files, fj = {}) {
  const fx = mkFixture({ featureJson: sampleFeatureJson(fj), files });
  const run = (...a) => runCli(['spec', 'analyze', '--feature', fx.featureDir, ...a], { cwd: fx.root });
  return { fx, run, json: (...a) => JSON.parse(run('--json', ...a).stdout) };
}
const codes = (list) => list.map((f) => f.code);

test('AC7: clean full-track fixture exits 0', () => {
  const { fx, run } = setup({ 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC2: b'), 'plan.md': PLAN([[1, 'TODO', 'AC1, AC2']]) });
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /spec analyze: 0 error\(s\), 0 warning\(s\)/);
  assert.deepEqual(JSON.parse(run('--json').stdout), { errors: [], warnings: [], checked: { tasks: true, coverage: false } });
  fx.cleanup();
});

test('AC8: each error code exits 1 with ac and task', () => {
  const cases = {
    'duplicate-ac': [SPEC('- [ ] AC1: a\n- [ ] AC1: again'), PLAN([[1, 'TODO', 'AC1']])],
    'bad-marker': [SPEC('- [ ] AC1: [superseded] a'), PLAN([[1, 'DONE', 'AC1']])],
    'missing-target': [SPEC('- [ ] AC1: **[superseded → AC9]** a'), PLAN([[1, 'DONE', 'AC1']])],
    'supersede-cycle': [SPEC('- [ ] AC1: **[superseded → AC2]** a\n- [ ] AC2: **[superseded → AC1]** b'), PLAN([[1, 'DONE', 'AC1']])],
    'unknown-ac': [SPEC('- [ ] AC1: a'), PLAN([[1, 'TODO', 'AC1'], [2, 'TODO', 'AC40']])],
    'superseded-ref': [SPEC('- [ ] AC1: **[superseded → AC2]** a\n- [ ] AC2: b'), PLAN([[1, 'TODO', 'AC1, AC2']])],
  };
  for (const [code, [spec, plan]] of Object.entries(cases)) {
    const { fx, run, json } = setup({ 'spec.md': spec, 'plan.md': plan });
    assert.equal(run().status, 1, code);
    const hit = json().errors.find((e) => e.code === code);
    assert.ok(hit, code);
    assert.ok(hit.ac, `${code} has ac`);
    if (code === 'unknown-ac') assert.deepEqual([hit.ac, hit.task], ['AC40', 2]);
    if (code === 'superseded-ref') assert.deepEqual([hit.ac, hit.task], ['AC1', 1]);
    assert.match(run().stdout, new RegExp(`^error ${code}: `, 'm'));
    fx.cleanup();
  }
});

test('AC8: self-reference is a cycle; errors print before warnings', () => {
  const r = analyzeSpec({ specText: SPEC('- [ ] AC1: **[superseded → AC1]** a\n- [ ] AC2: b'), tasksText: PLAN([[1, 'DONE', 'AC1']]) });
  assert.deepEqual(codes(r.errors), ['supersede-cycle']);
  const { fx, run } = setup({ 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC1: b\n- [ ] AC2: c'), 'plan.md': PLAN([[1, 'TODO', 'AC1']]) });
  const lines = run().stdout.split('\n');
  assert.ok(lines.findIndex((l) => l.startsWith('error ')) < lines.findIndex((l) => l.startsWith('warn ')));
  fx.cleanup();
});

test('AC9: warnings only exit 0', () => {
  const cases = {
    'ac-no-task': [SPEC('- [ ] AC1: a\n- [ ] AC2: b'), PLAN([[1, 'TODO', 'AC1']])],
    'task-no-ac': [SPEC('- [ ] AC1: a'), PLAN([[1, 'TODO', 'AC1'], [2, 'TODO', 'none']])],
    'superseded-ref-done': [SPEC('- [ ] AC1: **[superseded → AC2]** a\n- [ ] AC2: b'), PLAN([[1, 'IMPL-DONE', 'AC1, AC2']])],
    'ac-unscoped': [SPEC('- [ ] AC1: a', '\n## Notes\nAC8: stray\n'), PLAN([[1, 'TODO', 'AC1']])],
  };
  for (const [code, [spec, plan]] of Object.entries(cases)) {
    const { fx, run, json } = setup({ 'spec.md': spec, 'plan.md': plan });
    assert.equal(run().status, 0, code);
    assert.ok(codes(json().warnings).includes(code), code);
    assert.match(run().stdout, new RegExp(`^warn ${code}: `, 'm'));
    fx.cleanup();
  }
});

test('AC9: ac-no-test from a non-legacy coverage section', () => {
  const spec = SPEC('- [ ] AC1: a\n- [ ] AC2: b\n- [ ] AC3: c');
  const plan = PLAN([[1, 'DONE', 'AC1, AC2, AC3']]);
  const report = '# Test report\n\n## AC coverage — auto\n- [pass] AC1 — ok\n- [none] AC2\n';
  const { fx, json } = setup({ 'spec.md': spec, 'plan.md': plan, 'test-report.md': report });
  const j = json();
  assert.equal(j.checked.coverage, true);
  assert.deepEqual(j.warnings.filter((w) => w.code === 'ac-no-test').map((w) => w.ac), ['AC2', 'AC3']);
  fx.cleanup();
  const b = setup({ 'spec.md': spec, 'plan.md': plan });
  const jb = b.json();
  assert.equal(jb.checked.coverage, false);
  assert.ok(!codes(jb.warnings).includes('ac-no-test'));
  b.fx.cleanup();
});

test('AC10: removed ACs produce no findings', () => {
  const spec = SPEC('- [ ] AC1: a\n- [ ] AC4: (removed — D1) gone');
  const plan = PLAN([[1, 'TODO', 'AC1'], [2, 'TODO', 'AC4']]);
  const report = '## AC coverage — auto\n- [pass] AC1\n';
  const { fx, run, json } = setup({ 'spec.md': spec, 'plan.md': plan, 'test-report.md': report });
  assert.equal(run().status, 0);
  const j = json();
  assert.deepEqual([...j.errors, ...j.warnings].filter((f) => /AC4/.test(JSON.stringify(f))), []);
  fx.cleanup();
});

test('AC11: no tasks file, missing spec, extra arg, read-only', () => {
  const spec = SPEC('- [ ] AC1: a\n- [ ] AC1: dup');
  const { fx, run, json } = setup({ 'spec.md': spec, 'test-report.md': '# r\n' }, { track: 'lite' });
  const before = ['spec.md', 'test-report.md'].map((f) => [fs.readFileSync(path.join(fx.featureDir, f), 'utf8'), fs.statSync(path.join(fx.featureDir, f)).mtimeMs]);
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /tasks: n\/a \(no tasks file\)/);
  const j = json();
  assert.equal(j.checked.tasks, false);
  assert.deepEqual(codes(j.errors), ['duplicate-ac']);
  assert.equal(run('extra').status, 2);
  const after = ['spec.md', 'test-report.md'].map((f) => [fs.readFileSync(path.join(fx.featureDir, f), 'utf8'), fs.statSync(path.join(fx.featureDir, f)).mtimeMs]);
  assert.deepEqual(after, before);
  assert.ok(!fs.existsSync(path.join(fx.featureDir, 'plan.md')));
  fx.cleanup();
  const m = setup({});
  const mr = m.run();
  assert.equal(mr.status, 2);
  assert.match(mr.stderr, /file not found:/);
  m.fx.cleanup();
});

test('AC15: unknown spec subcommand lists the verbs', () => {
  const { fx } = setup({ 'spec.md': SPEC('- [ ] AC1: a') });
  const r = runCli(['spec', 'bogus', '--feature', fx.featureDir], { cwd: fx.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /spec analyze/);
  assert.match(r.stderr, /spec amend/);
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'dev-cycle.mjs'), 'utf8');
  const line = src.split('\n').find((l) => l.trim().startsWith('spec:'));
  for (const v of ['spec status', 'spec decisions', 'spec amend --title', 'spec amend --supersede', 'spec analyze']) assert.ok(line.includes(v), v);
  fx.cleanup();
});

// ---- dod ----
const PASSING = (extra = {}) => sampleFeatureJson({
  auto_tests: false,
  history: ['spec', 'plan', 'implement.task=1', 'static-check', 'review'].map((phase) => ({ phase, subagent: 'x', status: 'DONE' })),
  ...extra,
});
const LITE = (extra = {}) => sampleFeatureJson({
  track: 'lite', auto_tests: false, areas: [{ name: 'a' }],
  history: ['spec', 'implement.area=a', 'static-check', 'review'].map((phase) => ({ phase, subagent: 'x', status: 'DONE' })),
  ...extra,
});
const DOD_LINE = '! DOD-GATE FAILED: spec-analyze last status = ERRORS; aborting before push.';

test('AC16: dod blocks on analyze errors (full and lite)', () => {
  for (const [fj, files] of [
    [PASSING(), { 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC1: b'), 'plan.md': PLAN([[1, 'DONE', 'AC1']]) }],
    [LITE(), { 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC1: b') }],
  ]) {
    const fx = mkFixture({ featureJson: fj, files });
    const r = runCli(['dod', '--feature', fx.featureDir], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.ok((r.stdout + r.stderr).includes(DOD_LINE));
    const j = JSON.parse(runCli(['dod', '--json', '--feature', fx.featureDir], { cwd: fx.root }).stdout);
    assert.deepEqual(j.failed, { gate: 'spec-analyze', status: 'ERRORS' });
    assert.ok(!j.required.includes('spec-analyze'));
    fx.cleanup();
  }
});

test('AC16: open decision is reported before spec-analyze', () => {
  const spec = SPEC('- [ ] AC1: a\n- [ ] AC1: b', '\n## Open decisions\n\n### D1: Which?\n- Option A (Recommended) — fast\n- Option B — slow\n\n');
  const fx = mkFixture({ featureJson: LITE(), files: { 'spec.md': spec } });
  const j = JSON.parse(runCli(['dod', '--json', '--feature', fx.featureDir], { cwd: fx.root }).stdout);
  fx.cleanup();
  assert.equal(j.failed.gate, 'decisions');
});

test('AC17: dod passes with warnings, removed AC, quick track, bugfix', () => {
  const warnOnly = { 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC2: b'), 'plan.md': PLAN([[1, 'DONE', 'AC1']]) };
  const removed = { 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC2: (removed — D1) x'), 'plan.md': PLAN([[1, 'DONE', 'AC1, AC2']]) };
  const dup = { 'spec.md': SPEC('- [ ] AC1: a\n- [ ] AC1: b'), 'plan.md': PLAN([[1, 'DONE', 'AC1']]) };
  const quickHist = [{ phase: 'implement', subagent: 'x', status: 'DONE' }, { phase: 'static-check', subagent: 'x', status: 'DONE' }, { phase: 'review', subagent: 'x', status: 'DONE' }];
  const cases = [
    [PASSING(), warnOnly],
    [PASSING(), removed],
    [sampleFeatureJson({ track: 'quick', auto_tests: false, history: quickHist }), dup],
    [sampleFeatureJson({ flow: 'bugfix', auto_tests: false, history: quickHist }), {}],
  ];
  for (const [fj, files] of cases) {
    const fx = mkFixture({ featureJson: fj, files });
    const r = runCli(['dod', '--feature', fx.featureDir], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    fx.cleanup();
  }
});
