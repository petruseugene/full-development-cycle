import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, sampleFeatureJson, DEFAULT_FEATURE } from './helpers.mjs';
import { installSpawnRecorder, mkGitRepo, readFj } from './git-helpers.mjs';
import { run } from '../lib/cmd-git.mjs';
import { CliError } from '../lib/core.mjs';
import { COMMIT_TIMEOUT_S, commitTimeout, isSecretLike } from '../lib/git-commit.mjs';
import { GitPlumbingError, gitOk } from '../lib/git-exec.mjs';

const SPEC = [
  '---',
  'feature: foo-bar',
  'status: [IN PROGRESS]',
  'flow: feature',
  '---',
  '',
  '# Foo Bar — Spec',
  '',
  '## 1. Problem & Goal',
  '',
  'P.',
  '',
  'More text.',
  '',
  '## 2. Requirements',
  '',
  '- R1',
  '',
].join('\n');

const PLAN = [
  '---',
  'feature: foo-bar',
  'status: [TODO]',
  '---',
  '',
  '# Foo Bar — Plan',
  '',
  '## Tasks',
  '- [IMPL-DONE] **Task 1** (backend): Add the thing',
  '- [IMPL-DONE] **Task 2** (backend): Test the thing',
  '- [TODO] **Task 3** (backend, owner): Follow-ups',
  '',
  '## Execution plan',
  '',
  '### Task 1: Add the thing  `[IMPL-DONE]`',
  '**Tag:** backend',
  '**Touches:** `scripts/lib/a.mjs`, `docs/x.md`',
  '',
  '### Task 2: Test the thing  `[IMPL-DONE]`',
  '**Tag:** backend',
  '**Touches:** `scripts/test/a.test.mjs`',
  '',
  '### Task 3: Follow-ups  `[TODO]`',
  '**Tag:** backend, owner',
  '**Touches:** `zzz/a`, `zzz/b`, `zzz/c`',
  '',
].join('\n');

function mkRepo(over = {}, { branch = 'feat/foo-bar' } = {}) {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson(over), files: { 'spec.md': SPEC, 'plan.md': PLAN } });
  if (branch) repo.git(['checkout', '-q', '-b', branch]);
  return repo;
}

/** Run `git commit <argv>` in-process with a spawn recorder. */
async function gitCommit(repo, argv, extraEnv = {}) {
  const ctx = repo.ctx(extraEnv);
  const rec = installSpawnRecorder();
  try {
    let code;
    let usage = '';
    try {
      code = await run(['commit', ...argv], ctx);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      code = err.exitCode;
      usage = err.message;
    }
    rec.assertNoForbidden();
    return { code, out: ctx.out(), err: ctx.err() + usage, calls: rec.calls };
  } finally {
    rec.restore();
  }
}

const featureFiles = (repo) => ['spec.md', 'plan.md', 'feature.json'].map((f) => path.join(repo.featureDir, f));
const bytes = (files) => files.map((f) => fs.readFileSync(f));
const rel = (name) => `docs/features/${DEFAULT_FEATURE}/${name}`;

test('AC11 + AC12: feature commit message, status flips committed, clean tree', async () => {
  const repo = mkRepo();
  try {
    repo.write('scripts/lib/a.mjs', 'export const a = 1;\n');
    const r = await gitCommit(repo, ['--closes', '25,23', '--trailer', 'Co-Authored-By: X <x@y>']);
    assert.equal(r.code, 0, r.err);

    const sha = repo.git(['rev-parse', 'HEAD']);
    assert.match(r.out, new RegExp(`^commit ${sha} feat\\(scripts\\): foo bar`));
    assert.equal(repo.git(['log', '-1', '--format=%B']), [
      'feat(scripts): foo bar',
      '',
      'P.',
      '',
      'Tasks:',
      '- Task 1: Add the thing',
      '- Task 2: Test the thing',
      '',
      `Refs: docs/features/${DEFAULT_FEATURE}/spec.md`,
      'Closes #25',
      'Closes #23',
      '',
      'Co-Authored-By: X <x@y>',
    ].join('\n'));

    // AC12
    const stat = repo.git(['show', '--stat', '--format=', 'HEAD']);
    for (const f of ['spec.md', 'plan.md', 'feature.json', 'scripts/lib/a.mjs']) assert.ok(stat.includes(f.split('/').pop()), `${f} in --stat:\n${stat}`);
    const plan = repo.git(['show', `HEAD:${rel('plan.md')}`]);
    assert.match(plan, /^- \[DONE\] \*\*Task 1\*\*/m);
    assert.match(plan, /^- \[DONE\] \*\*Task 2\*\*/m);
    assert.match(plan, /^- \[TODO\] \*\*Task 3\*\*/m, 'owner task untouched');
    assert.match(plan, /^### Task 1: Add the thing {2}`\[DONE\]`$/m);
    assert.match(plan, /^status: \[DONE\]$/m);
    assert.match(repo.git(['show', `HEAD:${rel('spec.md')}`]), /^status: \[DONE\]$/m);
    const fj = JSON.parse(repo.git(['show', `HEAD:${rel('feature.json')}`]));
    const last = fj.history.at(-1);
    assert.deepEqual(
      { phase: last.phase, subagent: last.subagent, executor: last.executor, status: last.status, summary: last.summary },
      { phase: 'git', subagent: 'cli', executor: 'cli', status: 'DONE', summary: 'feature commit' },
    );
    assert.equal(repo.git(['status', '--porcelain']), '');

    // message passed via -F <tmpfile>, never inline; tmp file cleaned up
    const commitCall = r.calls.find((c) => c.cmd === 'git' && c.args.includes('commit'));
    const fi = commitCall.args.indexOf('-F');
    assert.ok(fi > 0);
    assert.equal(fs.existsSync(commitCall.args[fi + 1]), false);
    assert.ok(!commitCall.args.includes('-m'));
  } finally {
    repo.cleanup();
  }
});

test('AC13: failing pre-commit hook → hook-failed, files byte-identical, no commit', async () => {
  const repo = mkRepo();
  try {
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint says no" >&2\nexit 1\n', { mode: 0o755 });
    repo.write('scripts/lib/a.mjs', 'export const a = 1;\n');
    const files = featureFiles(repo);
    const before = bytes(files);
    const head = repo.git(['rev-parse', 'HEAD']);

    const r = await gitCommit(repo, ['--json']);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git commit: FAILED hook-failed — .*lint says no/s);
    assert.equal(JSON.parse(r.out).reason, 'hook-failed');
    assert.deepEqual(bytes(files), before);
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    // the flips are not staged either: index matches the working tree for feature files
    assert.equal(repo.git(['diff', '--name-only', '--', ...files]), '');
    assert.equal(readFj(repo).history.length, 0);
    assert.ok(!r.calls.some((c) => c.args.includes('--no-verify')));
  } finally {
    repo.cleanup();
  }
});

test('AC14: staged .env → secret-like-file naming .env, nothing staged, files untouched', async () => {
  const repo = mkRepo();
  try {
    repo.write('.env', 'TOKEN=x\n');
    repo.write('.env.example', 'TOKEN=\n');
    repo.write('scripts/lib/a.mjs', 'x\n');
    const files = featureFiles(repo);
    const before = bytes(files);
    const head = repo.git(['rev-parse', 'HEAD']);

    const r = await gitCommit(repo, ['--include-untracked']);
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED secret-like-file — .*\.env\b/);
    assert.doesNotMatch(r.err, /\.env\.example/);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.deepEqual(bytes(files), before);
  } finally {
    repo.cleanup();
  }
});

test('isSecretLike patterns', () => {
  for (const p of ['.env', 'a/.env', '.env.local', 'k.pem', 'x/y.key', 'id_rsa', 'id_rsa.pub', 'c.p12', 'credentials.json', 'cfg/credentials-prod.json']) {
    assert.equal(isSecretLike(p), true, p);
  }
  for (const p of ['.env.example', 'env', 'a.env.txt', 'keys.md', 'credentials.yaml', 'my_credentials.json']) {
    assert.equal(isSecretLike(p), false, p);
  }
  // security S5: more key material, case-insensitive
  for (const p of ['~/.ssh/id_ed25519', 'id_ecdsa.pub', 'id_dsa', 'AuthKey_X.p8', 'cert.pfx', 'release.jks', 'android/app/my.keystore',
    'ios/App.mobileprovision', '.npmrc', 'home/.netrc', '.envrc', 'service-account.json', 'gcp/service-account-prod.json',
    '.ENV', 'Credentials.json', 'KEY.PEM', 'ID_RSA', 'x.P12']) {
    assert.equal(isSecretLike(p), true, p);
  }
  for (const p of ['.ENV.EXAMPLE', 'npmrc.md', 'keystore.ts', 'service-account.yaml', 'my-id_rsa-notes.md']) {
    assert.equal(isSecretLike(p), false, p);
  }
});

test('AC15: bad trailer exits 2; bugfix / quick track need --subject; nothing touched', async () => {
  const repo = mkRepo();
  try {
    repo.write('scripts/lib/a.mjs', 'x\n');
    const head = repo.git(['rev-parse', 'HEAD']);
    let r = await gitCommit(repo, ['--trailer', 'bad trailer']);
    assert.equal(r.code, 2);
    assert.match(r.err, /invalid --trailer/);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '', 'nothing staged on usage error');
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
  } finally {
    repo.cleanup();
  }
  for (const over of [{ flow: 'bugfix' }, { flow: 'feature', track: 'quick' }]) {
    const repo2 = mkRepo(over);
    try {
      repo2.write('x.txt', 'x\n');
      const r = await gitCommit(repo2, []);
      assert.equal(r.code, 2, JSON.stringify(over));
      assert.match(r.err, /--subject is required/);
    } finally {
      repo2.cleanup();
    }
  }
});

test('bugfix with --subject: verbatim header, no status flips', async () => {
  const repo = mkRepo({ flow: 'bugfix' });
  try {
    repo.write('scripts/lib/a.mjs', 'x\n');
    const r = await gitCommit(repo, ['--subject', 'fix(x): handle y', '--body', 'Because.', '--closes', '7']);
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.git(['log', '-1', '--format=%B']), 'fix(x): handle y\n\nBecause.\n\nCloses #7');
    assert.match(repo.git(['show', `HEAD:${rel('plan.md')}`]), /^- \[IMPL-DONE\] \*\*Task 1\*\*/m);
    assert.equal(readFj(repo).history.length, 0);
    assert.equal(repo.git(['status', '--porcelain']), '');
  } finally {
    repo.cleanup();
  }
});

test('clean tree → nothing-to-commit, feature files untouched', async () => {
  const repo = mkRepo();
  try {
    assert.equal(repo.git(['status', '--porcelain']), '');
    const files = featureFiles(repo);
    const before = bytes(files);
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git commit: FAILED nothing-to-commit/);
    assert.deepEqual(bytes(files), before);
  } finally {
    repo.cleanup();
  }
});

test('CLI end-to-end: dev-cycle git commit prints the SHA', () => {
  const repo = mkRepo();
  try {
    repo.write('scripts/lib/a.mjs', 'x\n');
    const r = runCli(['git', 'commit', '--json'], { cwd: repo.root, env: repo.env });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.sha, repo.git(['rev-parse', 'HEAD']));
    assert.equal(data.subject, 'feat(scripts): foo bar');
  } finally {
    repo.cleanup();
  }
});

test('review F7: git commit refuses the default branch and a detached HEAD (exit 2), nothing staged', async () => {
  const repo = mkRepo({}, { branch: null });
  try {
    repo.write('scripts/lib/a.mjs', 'x\n');
    const head = repo.git(['rev-parse', 'HEAD']);
    let r = await gitCommit(repo, []);
    assert.equal(r.code, 2);
    assert.match(r.err, /on the default branch 'main'/);
    repo.git(['checkout', '-q', '--detach', 'HEAD']);
    r = await gitCommit(repo, []);
    assert.equal(r.code, 2);
    assert.match(r.err, /HEAD is detached/);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.equal(readFj(repo).history.length, 0);
  } finally {
    repo.cleanup();
  }
});

test('review F8: the commit call (with hooks) uses COMMIT_TIMEOUT_S, overridable by env', async () => {
  assert.equal(COMMIT_TIMEOUT_S, 600);
  assert.equal(commitTimeout({}), 600);
  assert.equal(commitTimeout({ DEV_CYCLE_GIT_COMMIT_TIMEOUT_S: '900' }), 900);
  assert.throws(() => commitTimeout({ DEV_CYCLE_GIT_COMMIT_TIMEOUT_S: '0' }), { exitCode: 2 });
  const repo = mkRepo();
  try {
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    repo.write('scripts/lib/a.mjs', 'x\n');
    const files = featureFiles(repo);
    const before = bytes(files);
    const r = await gitCommit(repo, [], { DEV_CYCLE_GIT_COMMIT_TIMEOUT_S: '1' });
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED timeout/);
    assert.deepEqual(bytes(files), before, 'flips restored after timeout');
  } finally {
    repo.cleanup();
  }
});

test('review F3: a failing plumbing call is GitPlumbingError (exit 2), not conflict; explicit reason still maps', async () => {
  const repo = mkRepo();
  try {
    const opts = { cwd: repo.root, env: repo.env };
    await assert.rejects(gitOk(['rev-parse', '--verify', 'no-such-ref'], opts), (err) => {
      assert.ok(err instanceof GitPlumbingError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /git plumbing failed — git rev-parse/);
      return true;
    });
    await assert.rejects(gitOk(['rev-parse', '--verify', 'no-such-ref'], { ...opts, reason: 'conflict' }), { reason: 'conflict' });
    // through the CLI: exit 2, no `FAILED conflict` line
    fs.writeFileSync(path.join(repo.root, '.git', 'index.lock'), '');
    repo.write('scripts/lib/a.mjs', 'x\n');
    const r = runCli(['git', 'commit'], { cwd: repo.root, env: repo.env });
    assert.equal(r.status, 2, r.stderr);
    assert.doesNotMatch(r.stderr, /FAILED conflict/);
    assert.match(r.stderr, /git plumbing failed/);
  } finally {
    repo.cleanup();
  }
});

test('#43: an ignored feature folder is not staged; code is still committed, flips happen on disk', async () => {
  const repo = mkRepo();
  try {
    repo.write('.gitignore', 'docs/features/\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'ignore features']);
    repo.git(['rm', '-r', '-q', '--cached', 'docs/features']);
    repo.git(['commit', '-q', '-m', 'untrack features']);
    repo.write('scripts/lib/a.mjs', 'export const a = 1;\n');
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /git commit: feature folder is git-ignored; not staged/);
    const files = repo.git(['show', '--name-only', '--format=', 'HEAD']).split('\n');
    assert.deepEqual(files, ['scripts/lib/a.mjs']);
    assert.match(fs.readFileSync(path.join(repo.featureDir, 'spec.md'), 'utf8'), /^status: \[DONE\]$/m);
  } finally { repo.cleanup(); }
});
