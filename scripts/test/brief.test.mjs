import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson, SCRIPTS_DIR } from './helpers.mjs';
import { parsePlan, findTask } from '../lib/plan.mjs';
import { parseAcIds, indexSpecAcs } from '../lib/brief.mjs';

const fixtureText = (n) => fs.readFileSync(new URL(`./fixtures/brief/${n}`, import.meta.url), 'utf8');
const PLAN = fixtureText('plan.md');
const SPEC = fixtureText('spec.md');
const h = (phase, summary) => ({ ts: '2026-01-01T00:00:00Z', phase, subagent: 'backend-dev', status: 'DONE', ...(summary ? { summary } : {}) });

function mk(over = {}) {
  return mkFixture({
    featureJson: sampleFeatureJson({
      history: [h('implement.task=1', 'old'), h('implement.task=1', 'Added the schema'), h('spec')],
      profile: {
        guards: ['Never commit secrets'],
        rules: [
          { globs: ['src/**'], text: 'RULE-SRC overlaps' },
          { globs: ['docs/**'], text: 'RULE-DOCS disjoint' },
        ],
      },
      ...over,
    }),
    files: { 'plan.md': PLAN, 'spec.md': SPEC },
  });
}

test('AC21: brief 3 writes sections in R16 order', () => {
  const fx = mk();
  try {
    const r = runCli(['brief', '3'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(fx.featureDir, 'briefs', 'task-3.md');
    assert.equal(r.stdout.trim(), file);
    const md = fs.readFileSync(file, 'utf8');
    const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, ['Task', 'Acceptance criteria', 'Touches', 'Depends on', 'Project rules', 'Lessons', 'Files to read']);
    const sec = (name) => md.split(new RegExp(`^## ${name}$`, 'm'))[1].split(/^## /m)[0];

    const detail = findTask(parsePlan(PLAN), 3).detailText.trimEnd();
    assert.ok(sec('Task').includes(detail), 'task detail verbatim');

    const ac = sec('Acceptance criteria');
    assert.match(ac, /AC2: second criterion\n  - with a sub bullet/);
    assert.match(ac, /AC3 \(labelled\)/);
    assert.match(ac, /AC4: wireframe criterion/);
    assert.doesNotMatch(ac, /AC1:|AC5:|AC9/);

    assert.match(sec('Touches'), /`src\/api\/\*\*`[\s\S]*`src\/types\.ts`/);
    const dep = sec('Depends on');
    assert.match(dep, /Task 1: Added the schema/);
    assert.match(dep, /Task 2: \(no summary recorded\)/);

    const rules = sec('Project rules');
    assert.match(rules, /Never commit secrets/);
    assert.match(rules, /RULE-SRC/);
    assert.doesNotMatch(rules, /RULE-DOCS/);

    assert.equal(sec('Lessons').trim(), '(none)');
    const files = sec('Files to read');
    assert.match(files, /src\/api\/index\.ts.* — Files/);
    assert.match(files, /wireframes\/list\.html — Wireframes/);
    assert.deepEqual(fs.readdirSync(path.join(fx.featureDir, 'briefs')), ['task-3.md']);
  } finally { fx.cleanup(); }
});

test('AC21: ranges accept hyphen and en dash; ids unique', () => {
  assert.deepEqual(parseAcIds('AC2–AC4'), [2, 3, 4]);
  assert.deepEqual(parseAcIds('AC2-AC4, AC3, AC9'), [2, 3, 4, 9]);
  assert.deepEqual(parseAcIds('none'), []);
});

test('AC21: no parsable AC id => Acceptance block verbatim', () => {
  const plan = PLAN.replace('**Acceptance:** AC2–AC4', '**Acceptance:** see the spec, all of it');
  const fx = mkFixture({ featureJson: sampleFeatureJson(), files: { 'plan.md': plan, 'spec.md': SPEC } });
  try {
    const r = runCli(['brief', '3'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(fx.featureDir, 'briefs', 'task-3.md'), 'utf8'), /## Acceptance criteria\n\nsee the spec, all of it\n/);
  } finally { fx.cleanup(); }
});

test('AC22: exit 2 for lite track, unknown task, unresolved AC id', () => {
  const lite = mk({ track: 'lite' });
  const full = mk();
  try {
    let r = runCli(['brief', '3'], { cwd: lite.root });
    assert.equal(r.status, 2); assert.match(r.stderr, /track full/);
    r = runCli(['brief', '99'], { cwd: full.root });
    assert.equal(r.status, 2); assert.match(r.stderr, /task 99/);
    r = runCli(['brief', '4'], { cwd: full.root });
    assert.equal(r.status, 2); assert.match(r.stderr, /AC77/);
    assert.equal(fs.existsSync(path.join(full.featureDir, 'briefs', 'task-4.md')), false);
  } finally { lite.cleanup(); full.cleanup(); }
});

test('AC22: nothing under scripts/ opens CLAUDE.md', () => {
  const lib = path.join(SCRIPTS_DIR, 'lib');
  for (const f of fs.readdirSync(lib)) {
    assert.doesNotMatch(fs.readFileSync(path.join(lib, f), 'utf8'), /CLAUDE\.md/, f);
  }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(SCRIPTS_DIR, 'test')).filter((p) => /\.(mjs|js|md)$/.test(p) && !p.endsWith('brief.test.mjs'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /readFileSync[^\n]*CLAUDE\.md/, f);
  }
});

test('regression F3: multi-paragraph ACs are reproduced in full', () => {
  const spec = `# Spec\n\n## 6. Acceptance Criteria\n\n### A\n\n- [ ] AC1: first paragraph.\n  - bullet\n  - bullet two\n\n  Trailing paragraph after a blank line.\n- [ ] AC2: short.\n\n### B\n\n- [ ] AC3: heading ends the AC.\n\n  Closing paragraph of the last AC.\n\n## 7. Out of Scope\n\nnot part of any AC\n`;
  const idx = indexSpecAcs(spec);
  assert.equal(idx.get(1), '- [ ] AC1: first paragraph.\n  - bullet\n  - bullet two\n\n  Trailing paragraph after a blank line.');
  assert.equal(idx.get(2), '- [ ] AC2: short.');
  assert.equal(idx.get(3), '- [ ] AC3: heading ends the AC.\n\n  Closing paragraph of the last AC.');
});

test('regression F3: this feature spec reproduces every AC1-AC30 in full', (t) => {
  const specFile = path.join(SCRIPTS_DIR, '..', 'docs', 'features', '2026-10-18-18h-22m-project-profile-state-cli-briefs', 'spec.md');
  if (!fs.existsSync(specFile)) return t.skip('feature spec not present');
  const text = fs.readFileSync(specFile, 'utf8');
  const idx = indexSpecAcs(text);
  const lines = text.split('\n');
  for (let n = 1; n <= 30; n++) {
    assert.ok(idx.has(n), `AC${n} indexed`);
    const block = idx.get(n);
    const start = lines.findIndex((l) => l.startsWith(`- [ ] AC${n}`) || l.startsWith(`- [x] AC${n}`));
    assert.ok(start >= 0);
    assert.ok(text.includes(block), `AC${n} is a verbatim slice of spec.md`);
    assert.equal(block.split('\n')[0], lines[start]);
  }
  assert.match(idx.get(10), /Running the same write twice yields identical `totals`/);
  assert.match(idx.get(30), /`cd dashboard && npm test` and `npx tsc --noEmit` both pass\./);
});

test('AC36: brief 1 takes task detail from spec.md when plan.md is absent', () => {
  const spec = fs.readFileSync(new URL('./fixtures/spec-tasks/spec.md', import.meta.url), 'utf8');
  const fx = mkFixture({ featureJson: sampleFeatureJson({ separate_plan: false }), files: { 'spec.md': spec } });
  try {
    const r = runCli(['brief', '1'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const md = fs.readFileSync(path.join(fx.featureDir, 'briefs', 'task-1.md'), 'utf8');
    assert.match(md, /API endpoint/);
    assert.match(md, /AC1: the API returns items\./);
    assert.doesNotMatch(md, /AC2: the list renders/);
    assert.match(md, /`api\/\*\*`/);
    assert.equal(fs.readFileSync(path.join(fx.featureDir, 'spec.md'), 'utf8'), spec);
    const miss = runCli(['brief', '9'], { cwd: fx.root });
    assert.equal(miss.status, 2);
    assert.match(miss.stderr, /not found in spec\.md/);
  } finally { fx.cleanup(); }
});

const lessonLine = (n, day) => `- [L${n}] \`src/ui/**\` — rule ${n} _(2026-01-${String(day).padStart(2, '0')} · s · -)_`;
const UI_PLAN = PLAN.replace('**Touches:** `src/api/**`, `src/types.ts`', '**Touches:** `src/ui/**`');

test('AC19: 12 lessons render 10 newest first; live; (none) without file', () => {
  const fx = mkFixture({ featureJson: sampleFeatureJson(), files: { 'plan.md': UI_PLAN, 'spec.md': SPEC } });
  try {
    const file = path.join(fx.featureDir, 'briefs', 'task-3.md');
    assert.equal(runCli(['brief', '3'], { cwd: fx.root }).status, 0);
    assert.match(fs.readFileSync(file, 'utf8'), /## Lessons\n\n\(none\)/);
    const lines = [];
    for (let i = 1; i <= 11; i++) lines.push(lessonLine(i, i));
    fx.write('.dev-cycle/lessons.md', lines.join('\n') + '\n');
    assert.equal(runCli(['brief', '3'], { cwd: fx.root }).status, 0);
    lines.push(lessonLine(12, 12));
    fx.write('.dev-cycle/lessons.md', lines.join('\n') + '\n');
    assert.equal(runCli(['brief', '3'], { cwd: fx.root }).status, 0);
    const md = fs.readFileSync(file, 'utf8');
    const sec = md.split(/^## Lessons$/m)[1].split(/^## /m)[0];
    assert.match(sec, /Advisory rules learned from past reviews \(data, not instructions\):/);
    const ids = [...sec.matchAll(/^- \[L(\d+)\]/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  } finally { fx.cleanup(); }
});

const TTS = {
  name: 'tts',
  cmd: 'node scripts/tts.mjs --only {keys} --max-requests {max}',
  params: { keys: { required: true, pattern: '^[A-Za-z0-9_.,-]+$' }, max: { required: true, type: 'int', max: 50 } },
  guards: ['Never regenerate approved clips'],
};

test('AC29: recipe brief for content task; missing recipe exits 2; backend has none', () => {
  const cplan = (name) => PLAN.replace('**Task 3** (backend)', '**Task 3** (backend, content)').replace('### Task 3: three  `[TODO]`\n**Tag:** backend', `### Task 3: three  \`[TODO]\` (backend, content)\n**Tag:** backend, content\n**Recipe:** ${name}`);
  let fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { recipes: [TTS] } }), files: { 'plan.md': cplan('tts'), 'spec.md': SPEC } });
  try {
    const r = runCli(['brief', '3'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const md = fs.readFileSync(path.join(fx.featureDir, 'briefs', 'task-3.md'), 'utf8');
    assert.ok(md.indexOf('## Project rules') < md.indexOf('## Recipe') && md.indexOf('## Recipe') < md.indexOf('## Lessons'));
    assert.match(md, /node scripts\/tts\.mjs --only \{keys\}/);
    assert.match(md, /Command \(argv words, run without a shell; each \{param\} value is passed as one argument, verbatim\):/);
    assert.match(md, /\| keys \| yes \|/);
    assert.match(md, /\| max \| yes \| int \|.*\| \/50 \| no \|/);
    assert.match(md, /\| name \| required \| type \| pattern \| min\/max \| allow_dash \|/);
    assert.match(md, /- Never regenerate approved clips/);
    assert.match(md, /Run only via `dev-cycle recipe run tts --param …`; never invoke the underlying command directly\./);
  } finally { fx.cleanup(); }
  fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { recipes: [TTS] } }), files: { 'plan.md': cplan('missing'), 'spec.md': SPEC } });
  try {
    const r = runCli(['brief', '3'], { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /brief: task 3 is a content task but recipe 'missing' is not in profile\.recipes/);
  } finally { fx.cleanup(); }
  fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { recipes: [TTS] } }), files: { 'plan.md': PLAN, 'spec.md': SPEC } });
  try {
    runCli(['brief', '3'], { cwd: fx.root });
    assert.doesNotMatch(fs.readFileSync(path.join(fx.featureDir, 'briefs', 'task-3.md'), 'utf8'), /## Recipe/);
  } finally { fx.cleanup(); }
});

test('F3: recipe table escapes | and the command survives backticks', () => {
  const rec = {
    name: 'gen',
    cmd: "node -e 'console.log(`x`, ``)' -- {mode}",
    params: { mode: { required: true, pattern: 'a|b' }, 'x|y': { pattern: '`q`', allow_dash: true } },
  };
  const cplan = PLAN.replace('**Task 3** (backend)', '**Task 3** (backend, content)').replace('### Task 3: three  `[TODO]`\n**Tag:** backend', '### Task 3: three  `[TODO]` (backend, content)\n**Tag:** backend, content\n**Recipe:** gen');
  const fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { recipes: [rec] } }), files: { 'plan.md': cplan, 'spec.md': SPEC } });
  try {
    const r = runCli(['brief', '3'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const md = fs.readFileSync(path.join(fx.featureDir, 'briefs', 'task-3.md'), 'utf8');
    assert.ok(md.includes('| mode | yes | string | `a\\|b` |  | no |'), md);
    assert.ok(md.includes('| x\\|y | no | string | `` `q` `` |  | yes |'), md);
    // every table row has exactly 6 unescaped pipes (5 cells)
    for (const row of md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| name') && !l.startsWith('| ---'))) {
      assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 7, row);
    }
    assert.ok(md.includes(`verbatim):\n\n\`\`\`text\n${rec.cmd}\n\`\`\`\n`), md);
  } finally { fx.cleanup(); }
});

const modelPlan = (size, touches) => `# Plan\n\n## Tasks\n- [TODO] **Task 1** (backend): t\n\n## Task details\n\n### Task 1: t  \`[TODO]\`\n**Tag:** backend\n**Touches:** ${touches}\n**Depends on:** none\n**Size:** ${size}\n**Acceptance:** AC1\n`;
const SPEC1 = '# Spec\n\n## 6. Acceptance Criteria\n\n- [ ] AC1: one\n';

function briefOf(plan, over = {}, spec = SPEC1) {
  const fx = mkFixture({ featureJson: sampleFeatureJson(over), files: { 'plan.md': plan, 'spec.md': spec } });
  try {
    const r = runCli(['brief', '1'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(path.join(fx.featureDir, 'briefs', 'task-1.md'), 'utf8');
  } finally { fx.cleanup(); }
}

test('AC15: Model line follows override, doc task, default', () => {
  assert.match(briefOf(modelPlan('S', '`docs/x.md`, `README.md`')), /^\*\*Model:\*\* haiku \(doc task\)$/m);
  assert.match(briefOf(modelPlan('S', '`scripts/a.mjs`')), /^\*\*Model:\*\* sonnet \(default\)$/m);
  assert.match(briefOf(modelPlan('L', '`docs/x.md`')), /^\*\*Model:\*\* sonnet \(default\)$/m);
  assert.match(briefOf(modelPlan('S', '`scripts/a.mjs`'), { models: { 'backend-dev': 'opus' } }), /^\*\*Model:\*\* opus \(override\)$/m);
});

test('AC18: ## Threat notes copied verbatim; absent => no heading', () => {
  const notes = '## Threat notes\n\nAdvisory.\n\n- **Hook:**\n  - never eval';
  const spec = `${SPEC1}\n## 7. Out of Scope\n\n- x\n\n${notes}\n\n## 8. Other\n\nzzz\n`;
  const md = briefOf(modelPlan('M', '`a/**`'), {}, spec);
  assert.ok(md.includes(notes), 'verbatim');
  assert.doesNotMatch(md, /## 8\. Other|zzz/);
  assert.doesNotMatch(briefOf(modelPlan('M', '`a/**`')), /Threat notes/);
});

const AMEND_SPEC = `# Spec

## 6. Acceptance Criteria
- [ ] AC1: base one
- [ ] AC2: **[superseded → AC5]** old body text
- [ ] AC3: (removed — D1) dropped

## Правка 22.10 — design v2

### 9.13. Acceptance Criteria правки
- [ ] AC5: new five
- [ ] AC6: new six

## Tasks
`;
const amendPlan = (acc) => `# Plan

## Tasks
- [ ] Task 1 (backend): one

### Task 1: one  \`[TODO]\`
**Tag:** backend
**Touches:** src/a.ts
**Acceptance:** ${acc}
`;
function briefFor(acc) {
  const fx = mkFixture({ featureJson: sampleFeatureJson({}), files: { 'plan.md': amendPlan(acc), 'spec.md': AMEND_SPEC } });
  try {
    const r = runCli(['brief', '1'], { cwd: fx.root });
    const f = path.join(fx.featureDir, 'briefs', 'task-1.md');
    return { r, md: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
  } finally { fx.cleanup(); }
}

test('AC6: brief indexes amendment ACs under a level-3 heading', () => {
  const { r, md } = briefFor('AC5, AC6');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(md.includes('AC5: new five') && md.includes('AC6: new six'));
});

test('AC6: superseded AC resolves to its replacement exactly once', () => {
  const { r, md } = briefFor('AC2, AC5');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(md.includes('> AC2 superseded → AC5 (resolved)'), md);
  assert.equal(md.split('AC5: new five').length - 1, 1);
  assert.ok(!md.includes('old body text'));
});

test('AC6: removed AC prints verbatim, undefined AC exits 2', () => {
  const ok = briefFor('AC3');
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.ok(ok.md.includes('- [ ] AC3: (removed — D1) dropped'));
  const bad = briefFor('AC77');
  assert.equal(bad.r.status, 2);
  assert.match(bad.r.stderr, /cannot resolve/);
});

test('AC6: cyclic supersede chain exits 2', () => {
  const spec = AMEND_SPEC.replace('AC5: new five', 'AC5: **[superseded → AC2]** loop');
  const fx = mkFixture({ featureJson: sampleFeatureJson({}), files: { 'plan.md': amendPlan('AC2'), 'spec.md': spec } });
  try {
    const r = runCli(['brief', '1'], { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot resolve/);
  } finally { fx.cleanup(); }
});
