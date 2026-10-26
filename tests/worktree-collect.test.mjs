import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkGitRepo } from './git-helpers.mjs';
import { currentTree, snapshotCommit } from '../plugin/scripts/lib/git-tree.mjs';
import { createWorktree, ensureExclude, gitCommonDir } from '../plugin/scripts/lib/worktree.mjs';
import {
  applyTask, checkTask, collectTasks, diffTask, driftAudit,
} from '../plugin/scripts/lib/worktree-collect.mjs';

const DIR = '.dev-cycle/worktrees';

function setup(t) {
  const repo = mkGitRepo({ remote: false });
  t.after(() => repo.cleanup());
  repo.write = (rel, text, mode) => {
    const abs = path.join(repo.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    if (mode) fs.chmodSync(abs, mode);
  };
  repo.write('.gitignore', 'node_modules/\n');
  repo.write('a.txt', 'a0\n');
  repo.write('b.txt', 'b0\n');
  repo.write('src/one.mjs', 'one0\n');
  repo.write('src/two.mjs', 'two0\n');
  repo.write('gone.txt', 'gone\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'files']);
  return repo;
}

async function start(repo, ns) {
  const root = fs.realpathSync(repo.root);
  const common = await gitCommonDir(root, repo.env);
  ensureExclude(common, DIR);
  const ctx = { env: repo.env };
  const feature = path.relative(root, repo.featureDir).split(path.sep).join('/');
  const tree = await currentTree(ctx, root, { dropPrefix: feature });
  const base = await snapshotCommit(tree, 'HEAD', { cwd: root, env: repo.env });
  const tasks = [];
  for (const [n, touches] of Object.entries(ns)) {
    const wt = await createWorktree({ mainRoot: root, dir: DIR, n: Number(n), base, env: repo.env });
    tasks.push({ n: Number(n), path: wt, touches });
  }
  return { root, base, tasks, opts: { env: repo.env, mainRoot: root, dir: DIR, featureRel: feature } };
}

const put = (task, rel, text, mode) => {
  const abs = path.join(task.path, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  if (mode) fs.chmodSync(abs, mode);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function worktreesOf(repo) {
  return repo.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
}

test('AC11: in-Touches and out-of-Touches changes apply with bytes and exec bit', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['src/one.mjs'], 2: ['src/two.mjs'] });
  put(s.tasks[0], 'src/one.mjs', 'one1\n');
  put(s.tasks[1], 'src/two.mjs', 'two1\n');
  put(s.tasks[1], 'tools/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  const diff = await diffTask(s.tasks[1], s.base, s.opts);
  assert.deepEqual(diff.touches_expanded, ['tools/run.sh']);
  const res = await collectTasks({ ...s.opts, base: s.base, tasks: s.tasks });
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(res.stray, []);
  assert.deepEqual(res.applied.map((a) => a.n), [1, 2]);
  assert.deepEqual(res.touches_expanded, { 2: ['tools/run.sh'] });
  assert.equal(read(s.root, 'src/one.mjs'), 'one1\n');
  assert.equal(read(s.root, 'src/two.mjs'), 'two1\n');
  assert.equal(read(s.root, 'tools/run.sh'), '#!/bin/sh\necho hi\n');
  assert.ok(fs.statSync(path.join(s.root, 'tools/run.sh')).mode & 0o100, 'exec bit kept');
  assert.equal(fs.statSync(path.join(s.root, 'src/one.mjs')).mode & 0o111, 0);
});

test('AC12: same-path sibling conflict in plan order; later task applies nothing', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['a.txt'], 2: ['a.txt', 'b.txt'] });
  put(s.tasks[0], 'a.txt', 'a-from-1\n');
  put(s.tasks[1], 'a.txt', 'a-from-2\n');
  put(s.tasks[1], 'b.txt', 'b-from-2\n');
  const res = await collectTasks({ ...s.opts, base: s.base, tasks: [...s.tasks].reverse() });
  assert.deepEqual(res.applied, [{ n: 1, paths: ['a.txt'] }]);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].n, 2);
  assert.deepEqual(res.conflicts[0].paths, [{ path: 'a.txt', reason: 'main-changed' }]);
  assert.equal(read(s.root, 'a.txt'), 'a-from-1\n');
  assert.equal(read(s.root, 'b.txt'), 'b0\n');
});

test('AC13: main edit after start conflicts; identical edit is a no-op', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['a.txt'], 2: ['b.txt'] });
  put(s.tasks[0], 'a.txt', 'wt-a\n');
  put(s.tasks[1], 'b.txt', 'wt-b\n');
  repo.write('a.txt', 'main-edit\n'); // differs from both B and W
  repo.write('b.txt', 'wt-b\n'); // identical to W
  const res = await collectTasks({ ...s.opts, base: s.base, tasks: s.tasks });
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].n, 1);
  assert.equal(read(s.root, 'a.txt'), 'main-edit\n');
  assert.deepEqual(res.applied, [{ n: 2, paths: ['b.txt'] }]);
  assert.equal(read(s.root, 'b.txt'), 'wt-b\n');
  // The conflicted task's file was changed in main by someone else and is claimed by no applied task.
  assert.deepEqual(res.stray, ['a.txt']);
});

test('AC14: deletion propagates when main still has the base blob', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['gone.txt', 'src/**'] });
  fs.rmSync(path.join(s.tasks[0].path, 'gone.txt'));
  fs.rmSync(path.join(s.tasks[0].path, 'src/one.mjs'));
  fs.rmSync(path.join(s.tasks[0].path, 'src/two.mjs'));
  const res = await collectTasks({ ...s.opts, base: s.base, tasks: s.tasks });
  assert.deepEqual(res.conflicts, []);
  assert.equal(fs.existsSync(path.join(s.root, 'gone.txt')), false);
  assert.equal(fs.existsSync(path.join(s.root, 'src')), false, 'empty dir pruned');
});

test('AC15: stray write in main is reported (auto) and audit ignores in-Touches writes', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['src/one.mjs'], 2: ['src/two.mjs'] });
  put(s.tasks[0], 'src/one.mjs', 'one1\n');
  repo.write('rogue.txt', 'x\n');
  const res = await collectTasks({ ...s.opts, base: s.base, tasks: s.tasks });
  assert.deepEqual(res.stray, ['rogue.txt']);
  assert.deepEqual(res.applied, [{ n: 1, paths: ['src/one.mjs'] }, { n: 2, paths: [] }]);

});

test('AC15 audit: writes outside every Touches are stray; inside and feature folder are not', async (t) => {
  const repo = setup(t);
  const s = await start(repo, {}); // audit mode: base only, no worktrees
  repo.write('src/inside.mjs', 'in\n');
  repo.write('outside.txt', 'out\n');
  fs.writeFileSync(path.join(repo.featureDir, 'note.md'), 'feature folder write\n');
  const touches = ['src/**', 'docs/api/**'];
  assert.deepEqual(await driftAudit({ ...s.opts, base: s.base, touches }), ['outside.txt']);
  const res = await collectTasks({ ...s.opts, base: s.base, audit: true, nonIsolatedTouches: touches });
  assert.deepEqual(res, { applied: [], conflicts: [], touches_expanded: {}, stray: ['outside.txt'] });
});

test('AC18: a symlink pointing outside the repo is a conflict and nothing is applied', async (t) => {
  const repo = setup(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const s = await start(repo, { 1: ['src/**', 'link.txt'] });
  put(s.tasks[0], 'src/one.mjs', 'one-changed\n');
  fs.symlinkSync(outside, path.join(s.tasks[0].path, 'link.txt'));
  const res = await collectTasks({ ...s.opts, base: s.base, tasks: s.tasks });
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.conflicts, [{ n: 1, paths: [{ path: 'link.txt', reason: 'symlink' }] }]);
  assert.equal(fs.existsSync(path.join(s.root, 'link.txt')), false);
  assert.equal(fs.lstatSync(outside).isDirectory(), true);
  assert.equal(read(s.root, 'src/one.mjs'), 'one0\n');
});

test('manifest links, copies, feature folder and dir are excluded from the diff', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['a.txt'] });
  const task = { ...s.tasks[0], linked: ['node_modules'], copied: ['.env'] };
  fs.symlinkSync(os.tmpdir(), path.join(task.path, 'node_modules'));
  put(task, '.env', 'SECRET=1\n');
  put(task, `${s.opts.featureRel}/feature.json`, '{}\n');
  put(task, 'a.txt', 'a1\n');
  const diff = await diffTask(task, s.base, s.opts);
  assert.deepEqual(diff.entries.map((e) => e.path), ['a.txt']);
});

test('applyTask re-reads main just before writing and rolls back nothing on a stale check', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['a.txt', 'b.txt'] });
  put(s.tasks[0], 'a.txt', 'wt-a\n');
  put(s.tasks[0], 'b.txt', 'wt-b\n');
  const check = await checkTask(await diffTask(s.tasks[0], s.base, s.opts), s.opts);
  assert.deepEqual(check.conflicts, []);
  repo.write('b.txt', 'raced\n'); // after the check, before the write
  const res = await applyTask(check, s.opts);
  assert.equal(res.applied, false);
  assert.deepEqual(res.conflicts, [{ path: 'b.txt', reason: 'main-changed' }]);
  assert.equal(read(s.root, 'a.txt'), 'a0\n');
});

test('applyTask refuses a worktree file modified after the check (nothing written)', async (t) => {
  const repo = setup(t);
  const s = await start(repo, { 1: ['a.txt', 'b.txt'] });
  put(s.tasks[0], 'a.txt', 'wt-a\n');
  put(s.tasks[0], 'b.txt', 'wt-b\n');
  const check = await checkTask(await diffTask(s.tasks[0], s.base, s.opts), s.opts);
  assert.deepEqual(check.conflicts, []);
  put(s.tasks[0], 'b.txt', 'tampered\n'); // after the check, before the write
  const res = await applyTask(check, s.opts);
  assert.equal(res.applied, false);
  assert.deepEqual(res.conflicts, [{ path: 'b.txt', reason: 'worktree-changed' }]);
  assert.equal(read(s.root, 'a.txt'), 'a0\n');
  assert.equal(read(s.root, 'b.txt'), 'b0\n');
});

test('the fixture repo has main plus one worktree', async (t) => {
  const repo = setup(t);
  await start(repo, { 1: ['a.txt'] });
  assert.equal(worktreesOf(repo).length, 2);
});
