import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkFixture, runCli } from './helpers.mjs';
import { globsOverlap } from '../plugin/scripts/lib/glob-overlap.mjs';

function plan(tasks) {
  const list = tasks.map((t) => `- [${t.status ?? 'TODO'}] **Task ${t.n}** (${t.tag ?? 'backend'}): T${t.n}`).join('\n');
  const detail = tasks.map((t) => [
    `### Task ${t.n}: T${t.n}`,
    t.touches ? `**Touches:** ${t.touches.map((x) => `\`${x}\``).join(', ')}` : '',
    `**Depends on:** ${t.deps ? t.deps.map((d) => `Task ${d}`).join(', ') : 'none'}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return `# Plan\n\n## Tasks\n\n${list}\n\n${detail}\n`;
}

function groups(tasks, args = ['--all']) {
  const fx = mkFixture({ files: { 'plan.md': plan(tasks) } });
  try {
    return runCli(['groups', ...args, '--json'], { cwd: fx.root });
  } finally {
    fx.cleanup();
  }
}

const example = (t3 = ['api/posts/**', 'api/types.ts']) => [
  { n: 1, touches: ['db/migrations/**', 'db/schema.sql'] },
  { n: 2, touches: ['api/types.ts'] },
  { n: 3, touches: t3, deps: [1, 2] },
  { n: 4, touches: ['api/users/**'], deps: [1, 2] },
  { n: 5, touches: ['web/components/PostList/**'], deps: [3] },
];

test('AC11 worked example', () => {
  const r = groups(example());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [[1, 2], [3, 4], [5]]);
});

test('AC11 variant: task 3 touching api/users serializes tier B', () => {
  const r = groups(example(['api/posts/**', 'api/users/types.ts']));
  assert.deepEqual(JSON.parse(r.stdout), [[1, 2], [3], [4], [5]]);
});

test('AC12 excludes finished/blocked/owner and treats IMPL-DONE/DONE deps satisfied', () => {
  const tasks = [
    { n: 1, status: 'DONE', touches: ['a/**'] },
    { n: 2, status: 'IMPL-DONE', touches: ['b/**'] },
    { n: 3, status: 'BLOCKED', touches: ['c/**'] },
    { n: 4, tag: 'owner', touches: ['d/**'] },
    { n: 5, touches: ['e/**'], deps: [1, 2] },
    { n: 6, touches: ['f/**'], deps: [5] },
  ];
  assert.deepEqual(JSON.parse(groups(tasks, []).stdout), [[5], [6]]);
  assert.deepEqual(JSON.parse(groups(tasks, ['--all']).stdout), [[1, 2, 3, 4], [5], [6]]);
});

test('AC13 task without Touches is a singleton', () => {
  const r = groups([{ n: 1, touches: ['a/**'] }, { n: 2 }, { n: 3, touches: ['b/**'] }]);
  assert.deepEqual(JSON.parse(r.stdout), [[1, 3], [2]]);
});

test('AC13 src/** overlaps a not-yet-existing file', () => {
  assert.equal(globsOverlap('src/**', 'src/a/new-file.ts'), true);
  assert.equal(globsOverlap('src/a/new-file.ts', 'src/**'), true);
  assert.equal(globsOverlap('src/a/*.ts', 'src/b/*.ts'), false);
  assert.equal(globsOverlap('src/a/x.ts', 'src/a/y.ts'), false);
  assert.equal(globsOverlap('src/*.ts', 'src/**/*.js'), true); // undecidable
  assert.equal(globsOverlap('src/a', 'src/a/b.ts'), true);
  const r = groups([{ n: 1, touches: ['src/**'] }, { n: 2, touches: ['src/a/new-file.ts'] }]);
  assert.deepEqual(JSON.parse(r.stdout), [[1], [2]]);
});

test('AC13 cycle and missing dependency exit 2', () => {
  const cyc = groups([{ n: 1, touches: ['a'], deps: [2] }, { n: 2, touches: ['b'], deps: [1] }]);
  assert.equal(cyc.status, 2);
  assert.match(cyc.stderr, /cycle/);
  const miss = groups([{ n: 1, touches: ['a'], deps: [9] }]);
  assert.equal(miss.status, 2);
  assert.match(miss.stderr, /missing task 9/);
});

test('human-readable output', () => {
  const fx = mkFixture({ files: { 'plan.md': plan(example()) } });
  try {
    const r = runCli(['groups', '--all'], { cwd: fx.root });
    assert.match(r.stdout, /group 1 \(parallel\): task 1, task 2/);
  } finally { fx.cleanup(); }
});

const fixtureText = (rel) => fs.readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8');

test('AC40: groups skips (owner), (backend, owner) and **Tag:** owner tasks (shared fixture)', () => {
  const plan = fixtureText('plans/owner-tags.md').replace(/\[IMPL-DONE\]/g, '[TODO]');
  const fx = mkFixture({ files: { 'plan.md': plan } });
  try {
    const r = runCli(['groups', '--json'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [[1, 5, 6]]);
  } finally { fx.cleanup(); }
});

test('AC36: groups reads tasks from spec.md when plan.md is absent', () => {
  const fx = mkFixture({ files: { 'spec.md': fixtureText('spec-tasks/spec.md') } });
  try {
    const r = runCli(['groups', '--json'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [[1]]); // 2 is IMPL-DONE, 3 is owner
    assert.deepEqual(JSON.parse(runCli(['groups', '--all', '--json'], { cwd: fx.root }).stdout), [[1, 3], [2]]);
  } finally { fx.cleanup(); }
  const none = mkFixture({ files: { 'spec.md': '# Spec\n' } });
  try { assert.equal(runCli(['groups'], { cwd: none.root }).status, 2); } finally { none.cleanup(); }
});
