import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson, CLI_PATH } from './helpers.mjs';
import { dodReport, evaluateDod } from '../plugin/scripts/lib/dod.mjs';
import { budgetCheck } from '../plugin/scripts/lib/budget.mjs';
import { tokenCoverageLine } from '../plugin/scripts/lib/token-coverage.mjs';

const h = (phase, status, extra = {}) => ({ ts: '2026-01-01T00:00:00Z', phase, subagent: 'x', status, ...extra });
const SPEC = (extra = '') => `---\nstatus: IN PROGRESS\n---\n# S\n\n## Acceptance Criteria\n- [ ] AC1: a\n${extra}`;
const task = (n, st, title, tag = 'backend') => `- [${st}] **Task ${n}** (${tag}): ${title}\n`;
const plan = (lines) => `---\nstatus: IN PROGRESS\n---\n# Plan\n\n## Tasks\n${lines}\n## Task details\n`;
const resume = (fx, ...a) => runCli(['feature', 'resume', '--feature', fx.featureDir, ...a], { cwd: fx.root });
const lines = (r) => r.stdout.trimEnd().split('\n');

function lite(over = {}, files = { 'spec.md': SPEC('- AC1 covered\n') }) {
  return mkFixture({
    featureJson: sampleFeatureJson({
      track: 'lite', branch: 'feat/x',
      areas: [{ name: 'api', touches: ['src/api/**', 'a/b.js'] }, { name: 'ui', touches: ['src/ui/**'] }],
      history: [h('spec', 'DONE'), h('implement.area=ui', 'DONE')], ...over,
    }),
    files,
  });
}

test('AC9/AC13/AC17b: lite fixture lists areas, gates and lessons next line', () => {
  const fx = lite();
  try {
    const r = resume(fx);
    assert.equal(r.status, 0, r.stderr);
    const l = lines(r);
    assert.ok(l[0].startsWith(`feature: ${path.basename(fx.featureDir)} · flow feature · track lite · phase `), l[0]);
    assert.ok(l.includes('areas:') && l.includes('  api MISSING') && l.includes('  ui DONE'));
    assert.ok(l.includes('gates: spec=DONE static-check=MISSING review=MISSING auto-test=MISSING'));
    assert.ok(l.some((x) => x.startsWith(`  node ${CLI_PATH} context --touches "src/api/**,a/b.js"`) && x.includes(`--feature ${fx.featureDir}`)));
    assert.ok(l.includes('  dispatch implementer: Area api'));
  } finally { fx.cleanup(); }
});

test('AC17b: unsafe touches omit the lessons line', () => {
  const fx = lite({ areas: [{ name: 'api', touches: ['a"; rm -rf'] }], history: [h('spec', 'DONE')] });
  try {
    const out = resume(fx).stdout;
    assert.ok(!out.includes('lessons list') && !out.includes('context --touches'));
    assert.ok(out.includes('dispatch implementer: Area api'));
  } finally { fx.cleanup(); }
});

test('AC10: full track caps task lines, cuts titles, hides owner and DONE', () => {
  const long = 'x'.repeat(90);
  let body = task(1, 'DONE', 'done one') + task(2, 'TODO', long) + task(3, 'TODO', 'own', 'backend, owner');
  for (let n = 4; n <= 16; n++) body += task(n, 'TODO', `t${n}`);
  const fx = mkFixture({ featureJson: sampleFeatureJson({ history: [h('spec', 'DONE'), h('plan', 'DONE')] }), files: { 'spec.md': SPEC(), 'plan.md': plan(body) } });
  try {
    const l = lines(resume(fx));
    assert.equal(l[1], 'tasks: 1/15 DONE');
    const taskLines = l.filter((x) => /^  \d+ \[/.test(x));
    assert.equal(taskLines.length, 10);
    assert.equal(taskLines[0], `  2 [TODO] ${'x'.repeat(59)}…`);
    assert.ok(!taskLines.some((x) => x.includes('own') || x.includes('done one')));
    assert.ok(l.includes('  … +4 more'));
    assert.ok(l.includes('owner: Task 3 — own (waiting)'));
  } finally { fx.cleanup(); }
});

test('AC11/AC12: dod line matches dodReport/evaluateDod on full, lite, quick, bugfix', () => {
  const fixtures = [
    mkFixture({ featureJson: sampleFeatureJson({ history: [h('spec', 'DONE'), h('plan', 'DONE')] }), files: { 'spec.md': SPEC(), 'plan.md': plan(task(1, 'TODO', 'a')) } }),
    lite(),
    mkFixture({ featureJson: sampleFeatureJson({ track: 'quick', history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED'), h('auto-test', 'PASSED')] }) }),
    mkFixture({ featureJson: sampleFeatureJson({ flow: 'bugfix', track: undefined, history: [h('implement', 'DONE')] }) }),
  ];
  try {
    for (const fx of fixtures) {
      const rep = dodReport(fx.featureDir);
      const ev = evaluateDod(fx.featureDir);
      assert.equal(rep.passed, ev.passed);
      assert.deepEqual(rep.required, ev.required);
      assert.deepEqual(rep.needs[0], ev.failed);
      const l = lines(resume(fx));
      const d = l.find((x) => x.startsWith('dod:'));
      assert.equal(d, ev.passed ? 'dod: PASSED' : `dod: needs ${rep.needs.map((n) => `${n.gate}=${n.status}`).join(', ')}`);
    }
  } finally { fixtures.forEach((f) => f.cleanup()); }
});

test('AC13: gates line shows recorded statuses', () => {
  const fx = lite({ history: [h('spec', 'DONE'), h('static-check', 'PASSED'), h('review', 'CHANGES_REQUIRED')] });
  try {
    assert.ok(lines(resume(fx)).includes('gates: spec=DONE static-check=PASSED review=CHANGES_REQUIRED auto-test=MISSING'));
  } finally { fx.cleanup(); }
});

const OPEN = (n) => '\n## Open decisions\n' + Array.from({ length: n }, (_, i) => `### D${i + 1}: q${i + 1}?\n- A (Recommended) — x\n- B — y\n`).join('\n');

test('AC14: decisions and spec analyze lines', () => {
  const two = lite({}, { 'spec.md': SPEC(OPEN(2)) });
  const none = lite();
  const bad = lite({}, { 'spec.md': SPEC('\n## Open decisions\n### D1: q?\n- only one\n') });
  const quick = mkFixture({ featureJson: sampleFeatureJson({ track: 'quick' }), files: { 'spec.md': SPEC() } });
  try {
    assert.ok(lines(resume(two)).includes('decisions: 2 open (D1, D2)'));
    assert.ok(lines(resume(none)).includes('decisions: none'));
    assert.ok(lines(resume(bad)).includes('decisions: malformed (run spec decisions)'));
    const l = lines(resume(none));
    const sa = JSON.parse(runCli(['spec', 'analyze', '--json', '--feature', none.featureDir], { cwd: none.root }).stdout);
    assert.ok(l.includes(`spec analyze: ${sa.errors.length} errors, ${sa.warnings.length} warnings`));
    const q = resume(quick).stdout;
    assert.ok(!q.includes('decisions:') && !q.includes('spec analyze:'));
  } finally { [two, none, bad, quick].forEach((f) => f.cleanup()); }
});

test('AC15: owner tasks waiting, none when DONE', () => {
  const p = (st) => plan(task(1, 'DONE', 'a') + task(2, st, 'ship it', 'owner'));
  const open = mkFixture({ featureJson: sampleFeatureJson({ history: [] }), files: { 'spec.md': SPEC(), 'plan.md': p('TODO') } });
  const done = mkFixture({ featureJson: sampleFeatureJson({ history: [] }), files: { 'spec.md': SPEC(), 'plan.md': p('DONE') } });
  try {
    assert.ok(lines(resume(open)).includes('owner: Task 2 — ship it (waiting)'));
    assert.ok(!resume(done).stdout.includes('owner:'));
  } finally { open.cleanup(); done.cleanup(); }
});

test('AC16: tokens line and budget scenarios', () => {
  const usd = (n) => h('review', 'APPROVED', { tokens: { input: 1 }, usd_est: n });
  const f1 = lite({ history: [usd(60)] });
  const f2 = lite({ history: [usd(12), h('x', 'DONE', { duration_s: 300 })] });
  const f4 = lite({ budget: { tokens_k: 50, time_s: 3600 }, history: [h('x', 'DONE', { tokens_k: 60 })] });
  const f5 = lite({ history: [h('x', 'DONE', { tokens_k: 1 })] });
  try {
    const l1 = lines(resume(f1));
    const i = l1.indexOf('budget: usd_est=60 of 50, time_s=0 of 7200');
    assert.ok(i > 0);
    assert.equal(l1[i + 1], '! BUDGET: usd_est=60 exceeds 50; budget usd=50, time_s=7200');
    assert.ok(l1.includes(tokenCoverageLine(JSON.parse(fs.readFileSync(path.join(f1.featureDir, 'feature.json'), 'utf8')).history)));
    assert.ok(!resume(f2).stdout.includes('! BUDGET'));
    assert.ok(lines(resume(f4)).includes('! BUDGET: tokens_k=60 exceeds 50; budget tokens_k=50, time_s=3600'));
    assert.ok(lines(resume(f5)).some((x) => x.startsWith('budget: usd_est=n/a of 50')));
    assert.equal(budgetCheck({ history: [] }).warning, null);
  } finally { [f1, f2, f4, f5].forEach((f) => f.cleanup()); }
});

test('AC17: next lines for decisions, end gates, passing dod, closed, blocked', () => {
  const abs = (f) => `--feature ${f.featureDir}`;
  const dec = lite({}, { 'spec.md': SPEC(OPEN(1)) });
  const gates = lite({ history: [h('spec', 'DONE'), h('implement.area=api', 'DONE'), h('implement.area=ui', 'DONE')] });
  const pass = mkFixture({ featureJson: sampleFeatureJson({ track: 'quick', history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED'), h('auto-test', 'PASSED')] }) });
  const closed = lite({ current_phase: 'done' });
  const blocked = lite({ status: 'blocked' });
  try {
    const n = (fx) => lines(resume(fx)).slice(lines(resume(fx)).indexOf('next:') + 1).map((x) => x.trim());
    assert.equal(n(dec)[0], `node ${CLI_PATH} spec decisions --json ${abs(dec)}`);
    const g = n(gates);
    assert.deepEqual(g, [
      `node ${CLI_PATH} check --scope tree-wide --record ${abs(gates)}`,
      `node ${CLI_PATH} review snapshot ${abs(gates)}`,
      'dispatch dev-cycle:code-reviewer',
      'dispatch dev-cycle:auto-tester',
    ]);
    assert.deepEqual(n(pass), [`node ${CLI_PATH} dod ${abs(pass)}`, `node ${CLI_PATH} ship ${abs(pass)} --subject "<subject>"`]);
    assert.deepEqual(n(closed), ['none (feature closed)']);
    assert.ok(n(blocked)[0].startsWith('escalate: feature is blocked'));
    assert.ok(n(blocked)[0].includes(`${CLI_PATH} feature set status active ${abs(blocked)}`));
  } finally { [dec, gates, pass, closed, blocked].forEach((f) => f.cleanup()); }
});

test('AC18/AC19: worst case stays small; json has every key', () => {
  let body = '';
  for (let n = 1; n <= 5; n++) body += task(n, 'DONE', 'done');
  for (let n = 6; n <= 30; n++) body += task(n, 'TODO', `long title ${'y'.repeat(80)}`);
  for (let n = 31; n <= 33; n++) body += task(n, 'TODO', `owner thing ${'z'.repeat(80)}`, 'owner');
  const extra = Array.from({ length: 6 }, (_, i) => ({ name: ['bundle-size', 'migrations', 'openapi-lint', 'license-check', 'e2e-smoke', 'perf-budget'][i], cmd: 'true' }));
  const fx = mkFixture({
    featureJson: sampleFeatureJson({
      branch: 'feat/some-long-branch-name', auto_tests: true, visual_tests: true, profile: { extra_gates: extra },
      history: [h('spec', 'DONE'), h('plan', 'DONE'), h('x', 'DONE', { duration_s: 9000, tokens_k: 5 })],
    }),
    files: { 'spec.md': SPEC(OPEN(4)), 'plan.md': plan(body) },
  });
  try {
    const t = resume(fx);
    assert.equal(t.status, 0, t.stderr);
    assert.ok(lines(t).length <= 60, `${lines(t).length} lines`);
    assert.ok(Buffer.byteLength(t.stdout) <= 3072, `${Buffer.byteLength(t.stdout)} bytes`);
    assert.ok(t.stdout.includes('! BUDGET: time_s=9000 exceeds 7200'));
    const j = JSON.parse(resume(fx, '--json').stdout);
    for (const k of ['feature', 'dir', 'flow', 'track', 'phase', 'branch', 'status', 'tasks', 'areas', 'implement', 'gates', 'dod', 'decisions', 'spec_analyze', 'owner', 'tokens', 'budget', 'next']) assert.ok(k in j, k);
    assert.equal(j.tasks.open.length, 25);
    assert.equal(j.areas, null);
    assert.equal(j.owner.length, 3);
    assert.ok(t.stdout.includes(`dod: needs ${j.dod.needs.slice(0, 6).map((n) => `${n.gate}=${n.status}`).join(', ')}, … +${j.dod.needs.length - 6} more`));
  } finally { fx.cleanup(); }
});

test('worst case with a long project path stays within 3072 bytes', () => {
  let body = '';
  for (let n = 1; n <= 30; n++) body += task(n, 'TODO', `long title ${'y'.repeat(80)}`);
  for (let n = 31; n <= 33; n++) body += task(n, 'TODO', `owner thing ${'z'.repeat(80)}`, 'owner');
  const names = ['bundle-size', 'migrations', 'openapi-lint', 'license-check', 'e2e-smoke', 'perf-budget'];
  const fx = mkFixture({
    feature: '2026-10-24-09h-38m-' + 'a-realistically-long-feature-slug-name'.padEnd(60, 'x'),
    featureJson: sampleFeatureJson({ branch: 'feat/x', visual_tests: true, profile: { extra_gates: names.map((name) => ({ name, cmd: 'true' })) }, history: [h('x', 'DONE', { duration_s: 9000 })] }),
    files: { 'spec.md': SPEC(OPEN(4)), 'plan.md': plan(body) },
  });
  try {
    const t = resume(fx);
    assert.ok(Buffer.byteLength(t.stdout) <= 3072, `${Buffer.byteLength(t.stdout)} bytes (dir ${fx.featureDir.length} chars)`);
  } finally { fx.cleanup(); }
});

test('F4: next lines shell-quote paths with spaces and quotes', () => {
  const fx = mkFixture({ feature: "2026-10-24-09h-38m-it's a space", featureJson: sampleFeatureJson({ track: 'quick', history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED'), h('auto-test', 'PASSED')] }) });
  try {
    const out = resume(fx).stdout;
    const q = `'${fx.featureDir.replace(/'/g, "'\\''")}'`;
    assert.ok(out.includes(`--feature ${q}`), out);
  } finally { fx.cleanup(); }
});

test('F5: release_manage adds --subject and --release auto to the ship line', () => {
  const mk = (rm) => mkFixture({ featureJson: sampleFeatureJson({ track: 'quick', release_manage: rm, history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED'), h('auto-test', 'PASSED')] }) });
  const on = mk(true); const off = mk(false);
  try {
    assert.ok(lines(resume(on)).some((x) => / ship .*--subject "<subject>" --release auto$/.test(x)));
    assert.ok(!resume(off).stdout.includes('--release'));
  } finally { on.cleanup(); off.cleanup(); }
});

test('AC20: resume writes nothing', () => {
  const fx = lite();
  const snap = () => Object.fromEntries(fs.readdirSync(fx.featureDir).map((f) => [f, fs.readFileSync(path.join(fx.featureDir, f), 'utf8')]));
  try {
    const before = snap();
    resume(fx); resume(fx, '--json');
    assert.deepEqual(snap(), before);
  } finally { fx.cleanup(); }
});

test('AC21: usage errors exit 2; quick and bugfix print implement', () => {
  const none = mkFixture({ featureJson: null });
  const bad = mkFixture({ featureJson: null, files: { 'feature.json': '{nope' } });
  const q = mkFixture({ featureJson: sampleFeatureJson({ track: 'quick' }) });
  const b = mkFixture({ featureJson: sampleFeatureJson({ flow: 'bugfix', track: undefined }) });
  try {
    assert.equal(runCli(['feature', 'resume'], { cwd: fs.mkdtempSync(path.join(none.root, 'empty-')) }).status, 2);
    assert.equal(resume(bad).status, 2);
    assert.equal(resume(q, '--bogus').status, 2);
    for (const fx of [q, b]) {
      const r = resume(fx);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(lines(r).includes('implement: MISSING'));
    }
  } finally { [none, bad, q, b].forEach((f) => f.cleanup()); }
});
