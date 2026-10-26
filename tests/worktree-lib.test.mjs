import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkGitRepo } from './git-helpers.mjs';
import { currentTree, snapshotCommit } from '../plugin/scripts/lib/git-tree.mjs';
import {
  clearManifest, createWorktree, decideIsolation, ensureExclude, fillWorktree, gitCommonDir,
  globToRegExp, readManifest, removeWorktree, rollbackWorktrees, writeManifest, WorktreeRefusal,
} from '../plugin/scripts/lib/worktree.mjs';

const DIR = '.dev-cycle/worktrees';

function setup(t) {
  const repo = mkGitRepo({ remote: false });
  t.after(() => repo.cleanup());
  repo.write('.gitignore', 'node_modules/\n.env\n');
  repo.write('a.mjs', 'a1\n');
  repo.write('src/x.mjs', 'x\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'files']);
  repo.write('a.mjs', 'a2\n'); // modified
  repo.write('b.mjs', 'b1\n'); // untracked
  repo.write('node_modules/pkg/index.js', 'module\n');
  repo.write('.env', 'SECRET=1\n');
  return repo;
}

function mainState(repo) {
  return {
    status: repo.git(['status', '--porcelain']),
    head: repo.git(['rev-parse', 'HEAD']),
    staged: repo.git(['diff', '--cached', '--stat']),
    refs: repo.git(['for-each-ref']),
  };
}

function ctxOf(repo) { return { env: repo.env }; }

async function makeWorktree(repo, n = 1) {
  const root = fs.realpathSync(repo.root);
  const common = await gitCommonDir(root, repo.env);
  ensureExclude(common, DIR);
  const feature = path.relative(root, repo.featureDir ?? path.join(root, 'docs/features')).split(path.sep).join('/');
  const tree = await currentTree(ctxOf(repo), root, { dropPrefix: feature });
  const commit = await snapshotCommit(tree, 'HEAD', { cwd: root, env: repo.env });
  const wt = await createWorktree({ mainRoot: root, dir: DIR, n, base: commit, env: repo.env });
  return { root, common, wt };
}

test('create + fill: main untouched, worktree has uncommitted files, not the feature folder', async (t) => {
  const repo = setup(t);
  const before = mainState(repo);
  const { root, wt } = await makeWorktree(repo);
  const res = await fillWorktree({
    mainRoot: root, wtPath: wt, link: ['**/node_modules'], copy: ['.env', '.env.*'], env: repo.env,
  });
  assert.deepEqual(mainState(repo), { ...before, status: before.status });
  assert.equal(repo.git(['status', '--porcelain']), before.status);
  assert.equal(fs.readFileSync(path.join(wt, 'a.mjs'), 'utf8'), 'a2\n');
  assert.equal(fs.readFileSync(path.join(wt, 'b.mjs'), 'utf8'), 'b1\n');
  assert.equal(fs.existsSync(path.join(wt, 'docs', 'features')), false);
  assert.ok(wt.startsWith(path.join(root, DIR)));
  assert.deepEqual(res.linked, ['node_modules']);
  assert.deepEqual(res.copied, ['.env']);
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(wt, '.env')).isFile());
  assert.equal(fs.lstatSync(path.join(wt, '.env')).isSymbolicLink(), false);
  // the dangling snapshot commit is not reachable from any ref
  assert.equal(repo.git(['for-each-ref']), before.refs);
});

test('snapshotCommit: parent is HEAD with fixed identity', async (t) => {
  const repo = setup(t);
  const root = fs.realpathSync(repo.root);
  const tree = await currentTree(ctxOf(repo), root);
  const c = await snapshotCommit(tree, 'HEAD', { cwd: root, env: repo.env });
  assert.equal(repo.git(['rev-parse', `${c}^`]), repo.git(['rev-parse', 'HEAD']));
  assert.equal(repo.git(['log', '-1', '--format=%an <%ae>', c]), 'dev-cycle <dev-cycle@localhost>');
});

test('currentTree dropPrefix removes the prefix only', async (t) => {
  const repo = setup(t);
  const root = fs.realpathSync(repo.root);
  const full = await currentTree(ctxOf(repo), root);
  const dropped = await currentTree(ctxOf(repo), root, { dropPrefix: 'docs/features' });
  assert.notEqual(full, dropped);
  assert.match(repo.git(['ls-tree', '-r', '--name-only', full]), /docs\/features/);
  const names = repo.git(['ls-tree', '-r', '--name-only', dropped]);
  assert.doesNotMatch(names, /docs\/features/);
  assert.match(names, /b\.mjs/);
});

test('ensureExclude is idempotent and does not touch tracked files', async (t) => {
  const repo = setup(t);
  const common = await gitCommonDir(repo.root, repo.env);
  assert.equal(ensureExclude(common, DIR), true);
  assert.equal(ensureExclude(common, DIR), false);
  const lines = fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === `/${DIR}/`).length, 1);
  assert.equal(repo.git(['status', '--porcelain']).includes('.gitignore'), false);
  assert.equal(fs.readFileSync(path.join(repo.root, '.gitignore'), 'utf8'), 'node_modules/\n.env\n');
});

test('manifest read/write/clear under the common dir', async (t) => {
  const repo = setup(t);
  const common = await gitCommonDir(repo.root, repo.env);
  assert.equal(readManifest(common), null);
  writeManifest(common, { tasks: { 1: '/x' } });
  assert.deepEqual(readManifest(common), { tasks: { 1: '/x' } });
  assert.ok(fs.existsSync(path.join(common, 'dev-cycle', 'worktrees.json')));
  clearManifest(common);
  assert.equal(readManifest(common), null);
});

test('removal keeps main node_modules and .env intact; worktree gone and pruned', async (t) => {
  const repo = setup(t);
  const { root, wt } = await makeWorktree(repo);
  await fillWorktree({ mainRoot: root, wtPath: wt, link: ['**/node_modules'], copy: ['.env'], env: repo.env });
  const out = await removeWorktree({ mainRoot: root, dir: DIR, wtPath: wt, env: repo.env });
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/pkg/index.js'), 'utf8'), 'module\n');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(repo.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  // already gone: no throw
  assert.equal((await removeWorktree({ mainRoot: root, dir: DIR, wtPath: wt, env: repo.env })).removed, false);
});

test('failing setup throws; rollback leaves no dir and only main in worktree list', async (t) => {
  const repo = setup(t);
  const { root, wt } = await makeWorktree(repo);
  await assert.rejects(
    fillWorktree({ mainRoot: root, wtPath: wt, link: [], copy: [], setup: 'node -e', env: repo.env }),
    /setup/,
  );
  await assert.rejects(
    fillWorktree({ mainRoot: root, wtPath: wt, setup: 'false', env: repo.env }),
    /setup failed/,
  );
  const errs = await rollbackWorktrees({ mainRoot: root, dir: DIR, paths: [wt], env: repo.env });
  assert.deepEqual(errs, []);
  assert.equal(fs.existsSync(wt), false);
  const listed = repo.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(listed.length, 1);
});

test('setup runs without a shell, cwd = worktree', async (t) => {
  const repo = setup(t);
  const { root, wt } = await makeWorktree(repo);
  await fillWorktree({ mainRoot: root, wtPath: wt, setup: 'touch setup-ran', env: repo.env });
  assert.ok(fs.existsSync(path.join(wt, 'setup-ran')));
  await assert.rejects(
    fillWorktree({ mainRoot: root, wtPath: wt, setup: 'touch a; touch b', env: repo.env }),
    /not a valid command/,
  );
  await removeWorktree({ mainRoot: root, dir: DIR, wtPath: wt, env: repo.env });
});

test('removal refuses paths outside <main>/<dir> and leaves them intact', async (t) => {
  const repo = setup(t);
  const { root, wt } = await makeWorktree(repo);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'keep'), 'k');
  const link = path.join(root, DIR, 'task-9');
  fs.symlinkSync(outside, link);
  const bad = [outside, path.join(root, 'src'), path.join(root, DIR, '..', '..', 'src'), root, path.join(root, DIR), link, ''];
  for (const p of bad) {
    await assert.rejects(removeWorktree({ mainRoot: root, dir: DIR, wtPath: p, env: repo.env }), WorktreeRefusal, `refuse ${p}`);
  }
  assert.ok(fs.existsSync(path.join(outside, 'keep')));
  assert.ok(fs.existsSync(path.join(root, 'src', 'x.mjs')));
  assert.ok(fs.existsSync(wt));
  // a traversal dir value is refused too
  await assert.rejects(removeWorktree({ mainRoot: root, dir: '../x', wtPath: wt, env: repo.env }), WorktreeRefusal);
  fs.unlinkSync(link);
  await removeWorktree({ mainRoot: root, dir: DIR, wtPath: wt, env: repo.env });
});

test('F9: a tampered dir together with path cannot delete tracked main directories', async (t) => {
  const repo = setup(t);
  const { root, wt } = await makeWorktree(repo);
  repo.write('src/components/c.mjs', 'c\n');
  const victim = path.join(root, 'src', 'components');
  // manifest-controlled dir: 'src' (differs from the trusted dir) -> refused
  await assert.rejects(
    removeWorktree({ mainRoot: root, dir: DIR, manifestDir: 'src', wtPath: victim, env: repo.env }), WorktreeRefusal,
  );
  // even when the caller passes the tampered dir as the trusted one, the target is no linked worktree
  await assert.rejects(removeWorktree({ mainRoot: root, dir: 'src', wtPath: victim, env: repo.env }), /not a linked worktree/);
  assert.ok(fs.existsSync(path.join(victim, 'c.mjs')));
  // a forged `.git` file does not make a plain directory removable
  const fake = path.join(root, DIR, 'task-77');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, '.git'), `gitdir: ${path.join(root, '.git')}\n`);
  await assert.rejects(removeWorktree({ mainRoot: root, dir: DIR, wtPath: fake, env: repo.env }), /not a linked worktree/);
  assert.ok(fs.existsSync(fake));
  assert.ok(fs.existsSync(wt));
  await removeWorktree({ mainRoot: root, dir: DIR, manifestDir: `./${DIR}/`, wtPath: wt, env: repo.env });
  assert.equal(fs.existsSync(wt), false);
});

test('F9: a symlinked worktrees dir is refused and its target left intact', async (t) => {
  const repo = setup(t);
  const root = fs.realpathSync(repo.root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'task-1'));
  fs.writeFileSync(path.join(outside, 'task-1', 'keep'), 'k');
  fs.symlinkSync(outside, path.join(root, 'wtlink'));
  await assert.rejects(
    removeWorktree({ mainRoot: root, dir: 'wtlink', wtPath: path.join(root, 'wtlink', 'task-1'), env: repo.env }), /symlink/,
  );
  await assert.rejects(
    removeWorktree({ mainRoot: root, dir: 'wtlink', wtPath: path.join(outside, 'task-1'), env: repo.env }), WorktreeRefusal,
  );
  assert.ok(fs.existsSync(path.join(outside, 'task-1', 'keep')));
  // a symlinked intermediate component is refused as well
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(outside, path.join(root, 'real', 'sub'));
  await assert.rejects(
    removeWorktree({ mainRoot: root, dir: 'real/sub', wtPath: path.join(outside, 'task-1'), env: repo.env }), WorktreeRefusal,
  );
  assert.ok(fs.existsSync(path.join(outside, 'task-1', 'keep')));
});

test('security: fillWorktree refuses destinations that resolve outside the worktree', async (t) => {
  const repo = setup(t);
  repo.write('.gitignore', 'node_modules/\n.env\n*.secret\n');
  repo.write('sub/x.secret', 's\n');
  const { root, wt } = await makeWorktree(repo);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(wt, 'sub'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(wt, 'sub'));
  await assert.rejects(
    fillWorktree({ mainRoot: root, wtPath: wt, copy: ['**/*.secret'], env: repo.env }), WorktreeRefusal,
  );
  await assert.rejects(
    fillWorktree({ mainRoot: root, wtPath: wt, link: ['**/*.secret'], env: repo.env }), WorktreeRefusal,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('decideIsolation: threshold, content and owner tasks', () => {
  const two = [{ n: 1, tag: 'backend' }, { n: 2, tag: 'frontend' }];
  assert.equal(decideIsolation({ mode: 'auto', min_group: 2 }, two).isolated, true);
  const small = decideIsolation({ mode: 'auto', min_group: 3 }, two);
  assert.equal(small.isolated, false);
  assert.ok(small.tasks.every((r) => r.isolate === false));
  assert.equal(decideIsolation({ mode: 'audit', min_group: 2 }, two).isolated, false);
  assert.equal(decideIsolation({ mode: 'off', min_group: 2 }, two).isolated, false);
  const mixed = decideIsolation({ mode: 'auto', min_group: 2 }, [
    { n: 1, tag: 'backend' }, { n: 2, tag: 'content' }, { n: 3, tag: 'mixed' }, { n: 4, tag: 'owner' },
  ]);
  assert.equal(mixed.isolated, true);
  assert.deepEqual(mixed.tasks.map((r) => r.isolate), [true, false, true, false]);
  // content tasks do not count toward the threshold
  assert.equal(decideIsolation({ mode: 'auto', min_group: 2 }, [{ n: 1, tag: 'backend' }, { n: 2, tag: 'content' }]).isolated, false);
});

test('globToRegExp basics', () => {
  assert.ok(globToRegExp('**/node_modules').test('node_modules'));
  assert.ok(globToRegExp('**/node_modules').test('packages/a/node_modules'));
  assert.ok(globToRegExp('.env.*').test('.env.local'));
  assert.equal(globToRegExp('.env').test('sub/.env'), false);
});
