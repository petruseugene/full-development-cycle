import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { parsePlan, setTaskStatus, normalizeStatus, setFrontmatterStatus, findTask, isOwnerTask, tasksSource, hasTagToken, isContentTask } from '../plugin/scripts/lib/plan.mjs';

const fx = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/plans/${name}`, import.meta.url)), 'utf8');

export function changedLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  assert.equal(x.length, y.length, 'line count must not change');
  return x.map((l, i) => (l === y[i] ? -1 : i)).filter((i) => i >= 0);
}

test('normalizeStatus', () => {
  assert.equal(normalizeStatus('IN-PROGRESS'), 'IN PROGRESS');
  assert.equal(normalizeStatus('in-review'), 'IN REVIEW');
  assert.equal(normalizeStatus('[done]'), 'DONE');
  assert.equal(normalizeStatus('IMPL-DONE'), 'IMPL-DONE');
  assert.equal(normalizeStatus('FOO'), null);
});

test('parsePlan: status-mix fixture', () => {
  const tasks = parsePlan(fx('status-mix.md'));
  assert.equal(tasks.length, 7);
  const t1 = findTask(tasks, 1);
  assert.deepEqual(
    { tag: t1.tag, status: t1.status, title: t1.title, touches: t1.touches, dependsOn: t1.dependsOn, files: t1.files, size: t1.size, acceptanceRaw: t1.acceptanceRaw },
    { tag: 'backend', status: 'IMPL-DONE', title: 'Parser', touches: ['a/**', 'b.ts'], dependsOn: [], files: ['a/x.ts'], size: 'S', acceptanceRaw: 'AC1' },
  );
  assert.equal(findTask(tasks, 2).tag, 'owner');
  assert.deepEqual(findTask(tasks, 2).dependsOn, []);
  const t3 = findTask(tasks, 3);
  assert.deepEqual(t3.dependsOn, [1, 2]);
  assert.deepEqual(t3.wireframes, ['wireframes/widget.html', 'wireframes/widget-empty.html']);
  assert.equal(findTask(tasks, 4).headingIdx, undefined);
  assert.equal(findTask(tasks, 4).detailText, undefined);
  assert.equal(findTask(tasks, 5).headingIdx !== undefined, true); // leading space before heading marker
  assert.equal(findTask(tasks, 5).status, 'BLOCKED');
  assert.deepEqual(findTask(tasks, 6).dependsOn, [1, 3]);
  assert.deepEqual(findTask(tasks, 7).dependsOn, [6]);
});

test('parsePlan: real plans', () => {
  const cli = parsePlan(fx('cli-briefs.md'));
  assert.equal(cli.length, 12);
  const t2 = findTask(cli, 2);
  assert.equal(t2.tag, 'backend');
  assert.deepEqual(t2.dependsOn, [1]);
  assert.equal(t2.size, 'M');
  assert.equal(t2.touches.length, 6);
  assert.equal(findTask(cli, 12).tag, 'frontend');

  const tf = parsePlan(fx('toolbar-filters-sort.md'));
  assert.deepEqual(findTask(tf, 1).dependsOn, []);
  assert.deepEqual(findTask(tf, 3).dependsOn, [1, 2]);
  assert.deepEqual(findTask(tf, 4).dependsOn, [1, 2, 3]);

  const qa = parsePlan(fx('quick-add-task.md'));
  assert.equal(qa.length, 3);
  assert.equal(findTask(qa, 1).tag, 'backend');
  assert.equal(findTask(qa, 1).status, 'DONE');

  const wh = parsePlan(fx('workflow-hardening.md'));
  assert.equal(wh.length, 5);
  assert.ok(wh.every((t) => t.status === 'DONE'));
});

test('parsePlan: ignores code fences and tolerates empty text', () => {
  assert.deepEqual(parsePlan(''), []);
  const text = '## Tasks\n- [TODO] **Task 1** (backend): a\n\n```\n### Task 9: fake  `[TODO]`\n```\n';
  assert.deepEqual(parsePlan(text).map((t) => t.n), [1]);
});

test('parsePlan: trailing (tag) on heading', () => {
  const text = '### Task 4: Thing  `[TODO]` (owner)\n**Depends on:** none\n';
  const [t] = parsePlan(text);
  assert.equal(t.tag, 'owner');
  assert.equal(t.status, 'TODO');
  assert.equal(t.title, 'Thing');
});

test('setTaskStatus touches only list line + heading', () => {
  const text = fx('status-mix.md');
  const out = setTaskStatus(text, 3, 'IMPL-DONE');
  const idx = changedLines(text, out);
  assert.equal(idx.length, 2);
  assert.match(out.split('\n')[idx[0]], /^- \[IMPL-DONE\] \*\*Task 3\*\*/);
  assert.match(out.split('\n')[idx[1]], /^### Task 3: Widget  `\[IMPL-DONE\]`$/);
});

test('setTaskStatus preserves CRLF and rejects unknowns', () => {
  const text = fx('status-mix.md').replace(/\n/g, '\r\n');
  const out = setTaskStatus(text, 4, 'in-progress');
  assert.equal(out.replace(/\r\n/g, '\n'), setTaskStatus(fx('status-mix.md'), 4, 'IN PROGRESS'));
  assert.ok(out.includes('- [IN PROGRESS] **Task 4** (backend): No detail section\r\n'));
  assert.throws(() => setTaskStatus(text, 99, 'DONE'), /not found/);
  assert.throws(() => setTaskStatus(text, 1, 'FOO'), /unknown status/);
});

test('setFrontmatterStatus', () => {
  const spec = fx('spec-status.md');
  const out = setFrontmatterStatus(spec, 'DONE');
  assert.deepEqual(changedLines(spec, out), [3]);
  assert.equal(out.split('\n')[3], 'status: [DONE]');
  assert.equal(setFrontmatterStatus('# no frontmatter\nstatus: x\n', 'DONE'), null);
  assert.equal(setFrontmatterStatus('---\nfoo: 1\n---\nstatus: x\n', 'DONE'), null);
});

test('AC40: isOwnerTask over (owner), (backend, owner), **Tag:** owner; not (backend) / (owner-ish)', () => {
  const tasks = parsePlan(fx('owner-tags.md'));
  assert.equal(findTask(tasks, 3).tag, 'backend, owner');
  assert.equal(findTask(tasks, 4).tag, 'owner'); // from **Tag:**
  assert.deepEqual(tasks.filter(isOwnerTask).map((t) => t.n), [2, 3, 4]);
  assert.equal(isOwnerTask({ tag: 'backend' }), false);
  assert.equal(isOwnerTask({ tag: 'owner-ish' }), false);
  assert.equal(isOwnerTask({ tag: 'Backend OWNER' }), true);
  assert.equal(isOwnerTask({}), false);
  // consecutive list groups are joined; heading tag still honoured
  assert.equal(parsePlan('- [TODO] **Task 1** (backend) (owner): x\n')[0].tag, 'backend, owner');
  assert.equal(isOwnerTask(parsePlan('### Task 2: y  `[TODO]` (owner)\n')[0]), true);
});

test('AC36: tasksSource prefers plan.md, else spec.md with ## Tasks, else null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(tasksSource(dir), null);
  fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n\n## Task details\n');
  assert.equal(tasksSource(dir), null);
  const spec = fs.readFileSync(fileURLToPath(new URL('./fixtures/spec-tasks/spec.md', import.meta.url)), 'utf8');
  fs.writeFileSync(path.join(dir, 'spec.md'), spec);
  assert.deepEqual(tasksSource(dir), { file: path.join(dir, 'spec.md'), text: spec });
  assert.deepEqual(parsePlan(spec).map((x) => [x.n, x.tag, x.status]),
    [[1, 'backend', 'TODO'], [2, 'frontend', 'IMPL-DONE'], [3, 'backend, owner', 'IMPL-DONE']]);
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n');
  assert.equal(tasksSource(dir).file, path.join(dir, 'plan.md'));
});

test('AC23: hasTagToken and Recipe field', () => {
  assert.equal(hasTagToken({ tag: 'backend, content' }, 'content'), true);
  assert.equal(isContentTask(parsePlan('- [TODO] **Task 1** (backend, content): x\n')[0]), true);
  assert.equal(hasTagToken(parsePlan('### Task 1: x  `[TODO]`\n\n**Tag:** owner\n')[0], 'owner'), true);
  assert.equal(hasTagToken({ tag: 'contentful' }, 'content'), false);
  const [a, b] = parsePlan('### Task 1: x  `[TODO]` (backend)\n\n**Recipe:** tts\n\n### Task 2: y  `[TODO]` (backend)\n');
  assert.equal(a.recipe, 'tts');
  assert.equal(b.recipe, '');
});
