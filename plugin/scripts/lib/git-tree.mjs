// Git tree helpers shared by `review` and the worktree lifecycle.
//
//   currentTree(ctx, top, {dropPrefix?}) -> tree id of the working tree
//   snapshotCommit(tree, parent, {cwd, env}) -> dangling commit id
//
// A tree is computed with a TEMPORARY index (tracked + untracked, minus
// .gitignore), so the real index, HEAD, stash and working tree are never
// touched. All git calls go through git-exec.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './core.mjs';
import { gitOk, gitRun } from './git-exec.mjs';

export const TREE_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Fixed identity for snapshot commits: no user config, hook or signing is involved. */
export const SNAPSHOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'dev-cycle',
  GIT_AUTHOR_EMAIL: 'dev-cycle@localhost',
  GIT_COMMITTER_NAME: 'dev-cycle',
  GIT_COMMITTER_EMAIL: 'dev-cycle@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
});

function normPrefix(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (s === '' || s.startsWith('/') || s.split('/').includes('..')) {
    throw new UsageError(`invalid path prefix to drop: ${JSON.stringify(p)}`);
  }
  return s;
}

/**
 * Tree id of the current working tree via a throw-away index seeded from HEAD.
 * @param {{env?: Record<string,string|undefined>}} ctx
 * @param {string} top  repo (or worktree) top-level directory
 * @param {{dropPrefix?: string|string[]}} [opts]  repo-relative path prefixes
 *   (e.g. the feature folder) removed from the temp index before write-tree
 */
export async function currentTree(ctx, top, { dropPrefix } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-index-'));
  try {
    const opts = { cwd: top, env: { ...ctx.env, GIT_INDEX_FILE: path.join(dir, 'index') } };
    const head = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: top, env: ctx.env });
    if (head.code === 0) await gitOk(['read-tree', 'HEAD'], opts);
    await gitOk(['add', '-A'], opts);
    const prefixes = dropPrefix === undefined ? [] : [].concat(dropPrefix).map(normPrefix);
    for (const p of prefixes) {
      await gitOk(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', p], opts);
    }
    const tree = await gitOk(['write-tree'], opts);
    if (!TREE_RE.test(tree)) throw new UsageError(`git write-tree returned an unexpected value: ${tree}`);
    return tree;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create a (dangling) commit for `tree` with `parent` as its parent, using a
 * fixed author/committer identity and no signing.
 * @param {string} tree
 * @param {string} [parent]  commit-ish; default HEAD
 * @param {{cwd?: string, env?: Record<string,string|undefined>, message?: string}} [opts]
 * @returns {Promise<string>} commit id
 */
export async function snapshotCommit(tree, parent = 'HEAD', { cwd, env, message = 'dev-cycle snapshot' } = {}) {
  if (!TREE_RE.test(String(tree))) throw new UsageError(`invalid tree id: ${tree}`);
  const sha = await gitOk(['rev-parse', '--verify', `${parent}^{commit}`], { cwd, env });
  const out = await gitOk(
    ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', sha, '-m', message],
    { cwd, env: { ...(env ?? process.env), ...SNAPSHOT_IDENTITY } },
  );
  if (!TREE_RE.test(out)) throw new UsageError(`git commit-tree returned an unexpected value: ${out}`);
  return out;
}
