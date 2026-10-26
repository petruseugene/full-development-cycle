import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainWorktreeRoot, resolveFeatureDir, featuresRoot, UsageError } from '../plugin/scripts/lib/core.mjs';
import { mkCtx, DEFAULT_FEATURE } from './helpers.mjs';
import { mkGitRepo } from './git-helpers.mjs';

function withWorktree(fn) {
  const repo = mkGitRepo({ remote: false });
  const wt = path.join(repo.tmpDir(), 'wt');
  repo.git(['worktree', 'add', '-q', '--detach', wt]);
  const wtReal = fs.realpathSync(wt);
  try { return fn(repo, wtReal); } finally { repo.cleanup(); }
}

test('mainWorktreeRoot: linked worktree resolves to main root', () => {
  withWorktree((repo, wt) => {
    assert.equal(mainWorktreeRoot(wt), fs.realpathSync(repo.root));
  });
});

test('mainWorktreeRoot: main tree and non-git dir unchanged', () => {
  const repo = mkGitRepo({ remote: false });
  try {
    assert.equal(mainWorktreeRoot(repo.root), repo.root);
  } finally { repo.cleanup(); }
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-plain-'));
  try {
    assert.equal(mainWorktreeRoot(plain), plain);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

test('--feature <abs main dir> from worktree cwd resolves to main', () => {
  withWorktree((repo, wt) => {
    const mainFeature = path.join(fs.realpathSync(repo.root), 'docs', 'features', DEFAULT_FEATURE);
    const ctx = mkCtx({ cwd: wt, env: repo.env });
    assert.equal(resolveFeatureDir(ctx, { feature: mainFeature }), mainFeature);
    assert.equal(resolveFeatureDir(ctx, { feature: DEFAULT_FEATURE }), mainFeature);
  });
});

test('DEV_CYCLE_FEATURE from worktree cwd resolves to main', () => {
  withWorktree((repo, wt) => {
    const mainFeature = path.join(fs.realpathSync(repo.root), 'docs', 'features', DEFAULT_FEATURE);
    const ctx = mkCtx({ cwd: wt, env: { ...repo.env, DEV_CYCLE_FEATURE: mainFeature } });
    assert.equal(resolveFeatureDir(ctx, {}), mainFeature);
  });
});

test('auto-detect from worktree resolves to main path, not the committed copy', () => {
  withWorktree((repo, wt) => {
    const mainRoot = fs.realpathSync(repo.root);
    // main's working copy differs from the committed one in the worktree
    const extra = path.join(mainRoot, 'docs', 'features', '2099-01-01-00h-00m-newer');
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, 'feature.json'), '{}');
    assert.ok(fs.existsSync(path.join(wt, 'docs', 'features', DEFAULT_FEATURE)));
    assert.ok(!fs.existsSync(path.join(wt, 'docs', 'features', '2099-01-01-00h-00m-newer')));
    const ctx = mkCtx({ cwd: wt, env: repo.env });
    assert.equal(featuresRoot(ctx), path.join(mainRoot, 'docs', 'features'));
    assert.equal(resolveFeatureDir(ctx, {}), extra);
  });
});

test('worktree copy of a feature is rejected as outside the main features root', () => {
  withWorktree((repo, wt) => {
    const wtFeature = path.join(wt, 'docs', 'features', DEFAULT_FEATURE);
    const ctx = mkCtx({ cwd: wt, env: repo.env });
    assert.throws(() => resolveFeatureDir(ctx, { feature: wtFeature }), UsageError);
  });
});

test('main tree behaviour unchanged', () => {
  const repo = mkGitRepo({ remote: false });
  try {
    const ctx = mkCtx({ cwd: repo.root, env: repo.env });
    assert.equal(resolveFeatureDir(ctx, {}), path.join(fs.realpathSync(repo.root), 'docs', 'features', DEFAULT_FEATURE));
  } finally { repo.cleanup(); }
});
