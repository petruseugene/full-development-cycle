import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { indexSpecAcs } from '../lib/brief.mjs';
import { tasksSource } from '../lib/plan.mjs';

const HEAD = '---\nstatus: IN PROGRESS\n---\n# S\n\n## 6. Acceptance Criteria\n- [ ] AC1: a\n- [ ] AC2: b\n\n## 7. Out of Scope (v1)\n- x\n\n';
const D1 = '### D1: Which format?\n- Json (Recommended) — machine readable\n- Text — human readable\n- Both — more code\n\n';
const D2 = '### D2: Keep legacy?\n- Yes (Recommended) — compatible\n- No — breaking\n\n';
const spec = (body) => HEAD + body + '## Threat notes\n- none\n';
const GOOD = spec('## Open decisions\n\n' + D1 + D2);

function fx(specText, json = sampleFeatureJson()) {
  return mkFixture({ featureJson: json, files: specText === null ? {} : { 'spec.md': specText } });
}
const dec = (f, ...a) => runCli(['spec', 'decisions', ...a, '--feature', f.featureDir], { cwd: f.root });

test('AC1/AC3: json and text output', () => {
  const f = fx(GOOD);
  try {
    const r = dec(f, '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { decisions: [
      { id: 'D1', question: 'Which format?', recommended: 'Json', options: [
        { label: 'Json', consequence: 'machine readable', recommended: true },
        { label: 'Text', consequence: 'human readable', recommended: false },
        { label: 'Both', consequence: 'more code', recommended: false }] },
      { id: 'D2', question: 'Keep legacy?', recommended: 'Yes', options: [
        { label: 'Yes', consequence: 'compatible', recommended: true },
        { label: 'No', consequence: 'breaking', recommended: false }] },
    ] });
    const t = dec(f);
    assert.equal(t.stdout, 'D1: Which format? [Json (Recommended) | Text | Both]\nD2: Keep legacy? [Yes (Recommended) | No]\n');
  } finally { f.cleanup(); }
});

test('AC2/AC5: empty cases', () => {
  const cases = [
    spec(''),
    spec('## Open decisions\n\nnothing\n\n'),
    spec('## Decisions\n- **D1:** q → a (owner) — c\n\n'),
    spec('## Open decisions\n\n```\n### D9: example\n- a\n```\n\n'),
  ];
  for (const c of cases) {
    const f = fx(c);
    try {
      const r = dec(f, '--json');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { decisions: [] });
    } finally { f.cleanup(); }
  }
  const f = fx(spec(''));
  try { assert.equal(dec(f).stdout, 'no open decisions\n'); } finally { f.cleanup(); }
});

test('AC4: malformed decisions exit 2', () => {
  const bad = {
    'one option': ['### D1: q\n- A (Recommended) — x\n', /D1.*1 options/],
    'five options': ['### D1: q\n- A (Recommended) — x\n- B — x\n- C — x\n- D — x\n- E — x\n', /D1.*5 options/],
    'no recommended': ['### D1: q\n- A — x\n- B — y\n', /D1.*no \(Recommended\)/],
    'recommended second': ['### D1: q\n- A — x\n- B (Recommended) — y\n', /D1.*first option/],
    'two recommended': ['### D1: q\n- A (Recommended) — x\n- B (Recommended) — y\n', /D1.*more than one/],
    'duplicate': ['### D1: q\n- A (Recommended) — x\n- B — y\n### D1: r\n- A (Recommended) — x\n- B — y\n', /duplicate.*D1/],
    'no consequence': ['### D1: q\n- A (Recommended) — x\n- B\n', /D1.*option 'B'/],
    'foreign heading': ['### Foo\n- A (Recommended) — x\n', /### Foo/],
  };
  for (const [name, [body, re]] of Object.entries(bad)) {
    const f = fx(spec('## Open decisions\n\n' + body + '\n'));
    try {
      const r = dec(f, '--json');
      assert.equal(r.status, 2, name);
      assert.match(r.stderr, re, name);
    } finally { f.cleanup(); }
  }
});

test('AC6: missing spec and unknown verb', () => {
  const f = fx(null);
  try {
    const r = dec(f);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /file not found:/);
    const b = runCli(['spec', 'bogus', '--feature', f.featureDir], { cwd: f.root });
    assert.equal(b.status, 2);
    assert.match(b.stderr, /spec decisions/);
  } finally { f.cleanup(); }
});

const h = (phase, status) => ({ ts: '2026-01-01T00:00:00Z', phase, subagent: 'x', status });
const liteJson = (over = {}) => sampleFeatureJson({
  track: 'lite', auto_tests: false, areas: [{ name: 'cli' }],
  history: [h('spec', 'DONE'), h('implement.area=cli', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED')], ...over,
});
const OPEN_LINE = '! DOD-GATE FAILED: decisions last status = OPEN; aborting before push.';

test('AC7: dod fails on open decisions (lite, malformed, full)', () => {
  const lite = fx(spec('## Open decisions\n\n### D1: q\n- only one\n\n'), liteJson());
  try {
    const r = runCli(['dod', '--feature', lite.featureDir], { cwd: lite.root });
    assert.equal(r.status, 1);
    assert.ok((r.stdout + r.stderr).includes(OPEN_LINE));
    const j = JSON.parse(runCli(['dod', '--json', '--feature', lite.featureDir], { cwd: lite.root }).stdout);
    assert.deepEqual(j.failed, { gate: 'decisions', status: 'OPEN' });
    assert.ok(!j.required.includes('decisions'));
  } finally { lite.cleanup(); }
  const full = mkFixture({
    featureJson: sampleFeatureJson({ auto_tests: false, history: [h('spec', 'DONE'), h('plan', 'DONE'), h('implement.task=1', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED')] }),
    files: { 'spec.md': GOOD, 'plan.md': '---\nstatus: IN PROGRESS\n---\n# Plan\n\n## Tasks\n- [DONE] **Task 1** (backend): a\n\n## Task details\n' },
  });
  try {
    const r = runCli(['dod', '--feature', full.featureDir], { cwd: full.root });
    assert.equal(r.status, 1);
    assert.ok((r.stdout + r.stderr).includes(OPEN_LINE));
  } finally { full.cleanup(); }
});

test('AC8: dod passes without open decisions, on quick and bugfix', () => {
  for (const s of [spec(''), spec('## Decisions\n- **D1:** q → a (owner) — c\n\n')]) {
    const f = fx(s, liteJson());
    try { assert.equal(runCli(['dod', '--feature', f.featureDir], { cwd: f.root }).status, 0); } finally { f.cleanup(); }
  }
  const q = fx(GOOD, sampleFeatureJson({ track: 'quick', auto_tests: false, history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED')] }));
  try { assert.equal(runCli(['dod', '--feature', q.featureDir], { cwd: q.root }).status, 0); } finally { q.cleanup(); }
  const b = fx(null, sampleFeatureJson({ flow: 'bugfix', track: 'quick', auto_tests: false, history: [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED')] }));
  try { assert.equal(runCli(['dod', '--feature', b.featureDir], { cwd: b.root }).status, 0); } finally { b.cleanup(); }
});

test('AC9: read-only and parser-neutral', () => {
  const f = fx(GOOD, liteJson({ history: [] }));
  try {
    const file = path.join(f.featureDir, 'spec.md');
    const before = fs.statSync(file);
    dec(f, '--json');
    runCli(['dod', '--feature', f.featureDir], { cwd: f.root });
    const after = fs.statSync(file);
    assert.equal(fs.readFileSync(file, 'utf8'), GOOD);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { f.cleanup(); }
  const withT = (body) => spec(body) + '\n## Tasks\n- [TODO] **Task 1** (backend): a\n';
  const a = withT(''), b = withT('## Open decisions\n\n' + D1 + D2);
  assert.deepEqual([...indexSpecAcs(a)], [...indexSpecAcs(b)]);
  const g = (t) => { const x = mkFixture({ files: { 'spec.md': t } }); try { return tasksSource(x.featureDir)?.text.replace(/^[\s\S]*?## Tasks/, '## Tasks'); } finally { x.cleanup(); } };
  assert.equal(g(a), g(b));
});

test('edge: dod with open block never blocks bugfix, hotfix, quick', () => {
  const hist = [h('implement', 'DONE'), h('static-check', 'PASSED'), h('review', 'APPROVED')];
  for (const over of [{ flow: 'bugfix', track: 'quick' }, { flow: 'hotfix', track: 'quick' }, { flow: 'bugfix' }, { flow: 'hotfix' }, { track: 'quick' }]) {
    const f = fx(GOOD, sampleFeatureJson({ auto_tests: false, history: hist, ...over }));
    try { assert.equal(runCli(['dod', '--feature', f.featureDir], { cwd: f.root }).status, 0, JSON.stringify(over)); } finally { f.cleanup(); }
  }
});

test('edge: malformed block gives a clean failure, no stack trace', () => {
  for (const body of ['## Open decisions\n\n### Foo\n- a — b\n\n', '## Open decisions\n\n### D1:\n\n', '## Open decisions\n\n### D1: q\n- a (Recommended) - no em dash\n- b — c\n\n']) {
    const f = fx(spec(body), liteJson());
    try {
      const d = dec(f, '--json');
      assert.equal(d.status, 2);
      assert.ok(!/\n\s+at .*\.mjs/.test(d.stderr), d.stderr);
      const r = runCli(['dod', '--feature', f.featureDir], { cwd: f.root });
      // lenient gate: only a `### D<n>:` heading counts as open; `### Foo` is a parser error but not a dod block
      assert.equal(r.status, body.includes('### Foo') ? 0 : 1);
      assert.ok(!/\n\s+at .*\.mjs/.test(r.stdout + r.stderr));
    } finally { f.cleanup(); }
  }
});

test('edge: spec with only resolved decisions passes dod and lists none', () => {
  const f = fx(spec('## Decisions\n- **D1:** q → a (owner: defaults OK) — c\n\n'), liteJson());
  try {
    assert.equal(JSON.parse(dec(f, '--json').stdout).decisions.length, 0);
    assert.equal(runCli(['dod', '--feature', f.featureDir], { cwd: f.root }).status, 0);
  } finally { f.cleanup(); }
});

test('AC16: README row and CHANGELOG entry (release-proof)', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /\| `spec decisions \[--json\]` \|/);
  assert.match(readme, /`decisions` check/);
  const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heads = cl.split('\n').filter((l) => l.startsWith('## '));
  assert.match(heads[0], /^## \[(Unreleased|\d+\.\d+\.\d+)\]/);
  const sections = cl.split(/^## /m).slice(1).filter((x) => /^\[(Unreleased|\d+\.\d+\.\d+)\]/.test(x));
  assert.ok(sections.some((x) => x.includes('spec decisions')), 'no release section mentions spec decisions');
});
