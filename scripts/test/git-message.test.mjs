import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitMessage, buildPrBody, validateTrailer } from '../lib/git-message.mjs';
import { UsageError } from '../lib/core.mjs';

const spec = '# Foo Bar — Spec\n\n## 1. Problem & Goal\n\nP.\nsecond line\n\nMore.\n\n## 2. Other\n';
const tasks = [
  { n: 1, tag: 'backend', title: 'One', touches: ['scripts/lib/a.mjs', 'docs/x.md'] },
  { n: 2, tag: 'backend', title: 'Two', touches: ['scripts/test/a.test.mjs'] },
  { n: 3, tag: 'backend, owner', title: 'Own', touches: ['zzz/**', 'zzz/b', 'zzz/c'] },
];
const fj = { flow: 'feature', track: 'full', feature_slug: 'foo-bar' };

test('AC11 message byte-exact', () => {
  const m = buildCommitMessage({ fj, specText: spec, tasks, folder: 'F', closes: '25,23', trailers: ['Co-Authored-By: X <x@y>'] });
  assert.equal(m, 'feat(scripts): foo bar\n\nP. second line\n\nTasks:\n- Task 1: One\n- Task 2: Two\n\nRefs: docs/features/F/spec.md\nCloses #25\nCloses #23\n\nCo-Authored-By: X <x@y>\n');
});

test('Problem heading without number; scope override; slug fallback; no tasks', () => {
  const m = buildCommitMessage({ fj, specText: '# Hello World. — Spec\n\n## Problem\n\nP.\n', tasks: [], folder: 'F' });
  assert.equal(m, 'feat(foo): hello world\n\nP.\n\nRefs: docs/features/F/spec.md\n');
  assert.match(buildCommitMessage({ fj, specText: spec, tasks, folder: 'F', scope: 'zed' }), /^feat\(zed\): /);
});

test('scope ties alphabetical', () => {
  const t = [{ n: 1, tag: 'backend', title: 'a', touches: ['b/x', 'a/y'] }];
  assert.match(buildCommitMessage({ fj, specText: spec, tasks: t, folder: 'F' }), /^feat\(a\)/);
});

test('AC15 trailers and subject rules', () => {
  assert.equal(validateTrailer('Key: v'), true);
  for (const bad of ['bad trailer', 'Key:v', 'Key: v\nX: y', '1Key: v']) assert.equal(validateTrailer(bad), false);
  assert.throws(() => buildCommitMessage({ fj, specText: spec, tasks, folder: 'F', trailers: ['bad trailer'] }), UsageError);
  assert.throws(() => buildCommitMessage({ fj: { flow: 'bugfix' }, folder: 'F' }), UsageError);
  assert.throws(() => buildCommitMessage({ fj: { flow: 'feature', track: 'quick' }, folder: 'F' }), UsageError);
  const m = buildCommitMessage({ fj: { flow: 'bugfix' }, subject: 'fix(x): y', body: 'why', closes: [7], trailers: ['A-B: c'] });
  assert.equal(m, 'fix(x): y\n\nwhy\n\nCloses #7\n\nA-B: c\n');
});

test('AC17 PR body sections', () => {
  const history = [
    { phase: 'auto-test', status: 'FAILED', summary: 'old' },
    { phase: 'auto-test', status: 'PASSED', summary: '10 tests' },
    { phase: 'review', status: 'APPROVED', summary: 'ok' },
    { phase: 'security', status: 'APPROVED', summary: 'clean' },
  ];
  const b = buildPrBody({ specText: spec, tasks, history, headMessage: 'feat: x\n\nCloses #25\nCloses #23\n', footer: 'FOOT' });
  assert.match(b, /^P\. second line/);
  assert.match(b, /- Task 2: Two/);
  assert.doesNotMatch(b, /Task 3/);
  assert.match(b, /Tests: PASSED — 10 tests/);
  assert.match(b, /Review: APPROVED — ok/);
  assert.match(b, /Security: APPROVED — clean/);
  assert.match(b, /Closes #25\nCloses #23/);
  assert.ok(b.trimEnd().endsWith('FOOT'));
  assert.match(buildPrBody({ specText: spec, tasks: [], history: [] }), /Tests: not run/);
});
