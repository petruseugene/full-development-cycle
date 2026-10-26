import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../plugin/scripts/dev-cycle.mjs';
import { mkGitRepo } from './git-helpers.mjs';
import { DEFAULT_FEATURE } from './helpers.mjs';

async function cli(repo, args) {
  const out = [];
  const err = [];
  const ctx = { ...repo.ctx(), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  const code = await main(args, ctx);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function state(repo) {
  return {
    status: repo.git(['status', '--porcelain']).split('\n').filter((l) => !l.includes('docs/features')).join('\n'), // feature.json itself is rewritten
    head: repo.git(['rev-parse', 'HEAD']),
    stash: repo.git(['stash', 'list']),
    index: fs.readFileSync(path.join(repo.root, '.git', 'index')),
  };
}

function setup(t) {
  const repo = mkGitRepo({ remote: false });
  t.after(() => repo.cleanup());
  repo.write('a.mjs', 'a1\n');
  repo.write('c.mjs', 'c1\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'files']);
  repo.write('a.mjs', 'a2\n'); // modified tracked
  repo.write('b.mjs', 'b1\n'); // untracked
  return repo;
}

test('AC12: review snapshot records a tree and leaves git state untouched', async (t) => {
  const repo = setup(t);
  const before = state(repo);
  const r = await cli(repo, ['review', 'snapshot']);
  assert.equal(r.code, 0, r.stderr);
  const tree = r.stdout.trim();
  assert.match(tree, /^[0-9a-f]{40}$/);
  const after = state(repo);
  assert.equal(after.status, before.status);
  assert.equal(after.head, before.head);
  assert.equal(after.stash, before.stash);
  assert.ok(before.index.equals(after.index), '.git/index changed');
  const fj = JSON.parse(repo.read(`docs/features/${DEFAULT_FEATURE}/feature.json`));
  assert.equal(fj.review_snapshots.length, 1);
  assert.equal(fj.review_snapshots[0].cycle, 1);
  assert.equal(fj.review_snapshots[0].tree, tree);
  assert.ok(fj.review_snapshots[0].ts);
  // the snapshot contains the untracked file
  assert.match(repo.git(['ls-tree', '-r', '--name-only', tree]), /^b\.mjs$/m);
});

test('review snapshot --cycle must be an integer', async (t) => {
  const repo = setup(t);
  assert.equal((await cli(repo, ['review', 'snapshot', '--cycle', 'x'])).code, 2);
  const r = await cli(repo, ['review', 'snapshot', '--cycle', '4']);
  assert.equal(r.code, 0);
  const fj = JSON.parse(repo.read(`docs/features/${DEFAULT_FEATURE}/feature.json`));
  assert.equal(fj.review_snapshots[0].cycle, 4);
});

test('AC13: review diff lists only changes since the snapshot, never the feature folder', async (t) => {
  const repo = setup(t);
  assert.equal((await cli(repo, ['review', 'diff'])).code, 2); // no snapshot yet
  assert.equal((await cli(repo, ['review', 'snapshot'])).code, 0);
  repo.write('c.mjs', 'c2\n');
  repo.write(`docs/features/${DEFAULT_FEATURE}/notes.md`, 'x\n');
  const named = await cli(repo, ['review', 'diff', '--since-cycle', '1', '--name-only']);
  assert.equal(named.code, 0, named.stderr);
  assert.equal(named.stdout, 'c.mjs\n');
  const plain = await cli(repo, ['review', 'diff']);
  assert.equal(plain.code, 0);
  assert.match(plain.stdout, /^diff --git a\/c\.mjs b\/c\.mjs/m);
  assert.doesNotMatch(plain.stdout, /docs\/features/);
  const bad = await cli(repo, ['review', 'diff', '--since-cycle', '9']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /cycle 9/);
});

test('review: unknown subcommand and flags exit 2', async (t) => {
  const repo = setup(t);
  assert.equal((await cli(repo, ['review'])).code, 2);
  assert.equal((await cli(repo, ['review', 'nope'])).code, 2);
  assert.equal((await cli(repo, ['review', 'diff', '--bogus'])).code, 2);
});
