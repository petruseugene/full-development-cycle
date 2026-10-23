import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { parseSpecAcs } from '../lib/spec-acs.mjs';

const BASE = `---
status: [IN PROGRESS]
---
# S

## 6. Acceptance Criteria
- [ ] AC1: one
- [ ] AC2: two
  more
- [ ] AC3: three
- [ ] AC4: (removed — D1) gone
- [ ] AC12: **[superseded → AC2]** twelve
`;
const TASKS = '\n## Tasks\n- [TODO] **Task 1** (backend): t\n\n## Task details\n### Task 1: t\n- **Acceptance:** AC1\n';

function setup(spec, files = {}) {
  const fx = mkFixture({ featureJson: sampleFeatureJson(), files: { 'spec.md': spec, ...files } });
  const spf = path.join(fx.featureDir, 'spec.md');
  const run = (...a) => runCli(['spec', 'amend', '--feature', fx.featureDir, ...a], { cwd: fx.root });
  return { fx, spf, run, read: () => fs.readFileSync(spf, 'utf8') };
}

test('AC12: --title inserts before ## Tasks, idempotent, new heading is an AC scope', () => {
  const { fx, run, read } = setup(BASE + TASKS);
  const before = read();
  const r = run('--title', 'design v2', '--date', '2026-10-24');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'next AC: AC13');
  const after = read();
  const head = '## Amendment 2026-10-24 — design v2\n\n### Acceptance Criteria (amendment 2026-10-24)\n\n';
  assert.equal(after, before.replace('\n## Tasks', '\n' + head + '## Tasks'));
  assert.ok(after.indexOf(head) < after.indexOf('## Tasks'));
  const again = run('--title', 'design v2', '--date', '2026-10-24', '--json');
  assert.deepEqual(JSON.parse(again.stdout), { heading: '## Amendment 2026-10-24 — design v2', next_ac: 'AC13', inserted: false });
  assert.equal(read(), after);
  fs.writeFileSync(path.join(fx.featureDir, 'spec.md'), after.replace('\n## Tasks', '- [ ] AC13: new\n\n## Tasks'));
  assert.ok(parseSpecAcs(read()).acs.has(13));
  fx.cleanup();
});

test('AC12: appends at end without ## Tasks; --json inserted:true; default date', () => {
  const { fx, run, read } = setup(BASE);
  const r = run('--title', 't', '--json');
  const j = JSON.parse(r.stdout);
  assert.equal(j.inserted, true);
  assert.equal(j.next_ac, 'AC13');
  assert.match(j.heading, /^## Amendment \d{4}-\d{2}-\d{2} — t$/);
  const after = read();
  assert.ok(after.startsWith(BASE + '\n## Amendment '));
  fx.cleanup();
});

test('AC12: heading inside a fence is not an existing amendment; ## Area is a placement anchor', () => {
  const spec = BASE + '\n```\n## Amendment 2026-10-24 — x\n```\n\n## Area a\n- touches: x\n';
  const { fx, run, read } = setup(spec);
  const r = run('--title', 'x', '--date', '2026-10-24', '--json');
  assert.equal(JSON.parse(r.stdout).inserted, true);
  const after = read();
  assert.ok(after.indexOf('### Acceptance Criteria (amendment') < after.indexOf('## Area a'));
  fx.cleanup();
});

test('AC13: --supersede rewrites only the first line; two flags apply together', () => {
  const { fx, run, read } = setup(BASE);
  const before = read();
  const r = run('--supersede', 'AC3=AC13,AC14');
  assert.equal(r.status, 2, 'targets not defined yet');
  assert.equal(read(), before);
  const withNew = before + '- [ ] AC13: a\n- [ ] AC14: b\n- [ ] AC15: c\n';
  fs.writeFileSync(path.join(fx.featureDir, 'spec.md'), withNew);
  const ok = run('--supersede', 'AC3=AC13,AC14', '--supersede', 'AC1=AC15');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), ['AC3 superseded → AC13, AC14', 'AC1 superseded → AC15']);
  const after = read();
  assert.equal(after, withNew
    .replace('- [ ] AC3: three', '- [ ] AC3: **[superseded → AC13, AC14]** three')
    .replace('- [ ] AC1: one', '- [ ] AC1: **[superseded → AC15]** one'));
  const { acs } = parseSpecAcs(after);
  assert.deepEqual(acs.get(3).superseded.by, [13, 14]);
  assert.match(JSON.stringify(JSON.parse(run('--supersede', 'AC13=AC15', '--json').stdout)), /"superseded":\[\{"ac":"AC13","by":\["AC15"\]\}\]/);
  fx.cleanup();
});

test('AC14: invalid input exits 2 and leaves spec.md untouched', () => {
  const spec = BASE + '- [ ] AC13: a\n- [ ] AC14: **[superseded → AC13]** b\n- [ ] AC15: c\n';
  const { fx, run, read } = setup(spec);
  const cases = [
    ['--supersede', 'AC99=AC13'],
    ['--supersede', 'AC1=AC99'],
    ['--supersede', 'AC12=AC13'],
    ['--supersede', 'AC4=AC13'],
    ['--supersede', 'AC1=AC4'],
    ['--supersede', 'AC1=AC1'],
    ['--supersede', 'AC13=AC14'],
    ['--supersede', 'AC1=AC13', '--supersede', 'AC2=AC99'],
    ['--supersede', 'AC1=AC13', '--supersede', 'AC1=AC15'],
    ['--supersede', 'bogus'],
    ['--title', 'x', '--supersede', 'AC1=AC13'],
    [],
    ['--title', '  '],
    ['--title', 'a\nb'],
    ['--title', '# h'],
    ['--title', 'ok', '--date', '24.10.2026'],
  ];
  for (const args of cases) {
    const r = run(...args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(read(), spec, JSON.stringify(args));
  }
  fx.cleanup();
});

test('AC15: existing spec status / decisions unchanged', () => {
  const { fx } = setup(BASE);
  const r = runCli(['spec', 'decisions', '--feature', fx.featureDir], { cwd: fx.root });
  assert.equal(r.stdout.trim(), 'no open decisions');
  assert.equal(runCli(['spec', 'status', 'DONE', '--feature', fx.featureDir], { cwd: fx.root }).status, 0);
  fx.cleanup();
});

// L9: every `spec amend` / `spec analyze` example in the docs runs for real.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DOC_FILES = ['README.md', 'skills/spec-writer/SKILL.md', 'skills/orchestrator/references/spec-analyze.md', 'skills/orchestrator/references/dod-gate.md'];

function docExamples() {
  const out = [];
  for (const f of DOC_FILES) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/`([^`\n]*\bspec (?:amend|analyze)\b[^`\n]*)`/g)) {
      const raw = m[1];
      if (/[|]/.test(raw) && !/--title "/.test(raw)) continue;
      out.push({ file: f, raw });
    }
  }
  return out;
}

test('L9: documented spec amend / spec analyze invocations run against a fixture', () => {
  const examples = docExamples();
  assert.ok(examples.length >= 4, `found ${examples.length}`);
  const cmdRe = /spec (?:amend|analyze)\b(?:\s+(?:--[a-z-]+(?:\s+(?:"[^"]*"|\[[^\]]*\]|\S+))?|\[[^\]]*\]))*/;
  let ran = 0;
  for (const { file, raw } of examples) {
    const m = cmdRe.exec(raw);
    if (!m) continue;
    // Substitute placeholders with concrete values; skip shapes that are prose.
    let cmd = m[0]
      .replace(/\[--json\]/g, '--json')
      .replace(/\[--date YYYY-MM-DD\]/g, '--date 2026-10-24')
      .replace(/\[--date d\]/g, '--date 2026-10-24')
      .replace(/<(?:t|short title)>/g, '"doc title"')
      .replace(/AC<(?:x|old)>=AC<(?:y|new)>(?:\[,AC<(?:z|new2)>\])?/g, 'AC1=AC13')
      .replace(/\s\[[^\]]*\]/g, '');
    if (/[<>]/.test(cmd) || /^spec amend\s*$/.test(cmd)) continue; // bare verb in prose
    const args = [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((x) => x[1] ?? x[2]);
    const spec = BASE + '- [ ] AC13: new\n' + TASKS;
    const { fx } = setup(spec);
    const r = runCli([...args, '--feature', fx.featureDir], { cwd: fx.root });
    assert.ok([0, 1].includes(r.status), `${file}: ${raw} -> ${r.status} ${r.stderr}`);
    fx.cleanup();
    ran++;
  }
  assert.ok(ran >= 4, `ran ${ran}`);
});
