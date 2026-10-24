import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkCtx, runCli, sampleFeatureJson } from './helpers.mjs';
import { installSpawnRecorder, mkGhStub, mkGitRepo, readFj } from './git-helpers.mjs';
import { run } from '../lib/cmd-git.mjs';
import { UsageError } from '../lib/core.mjs';
import {
  ForbiddenArgError, GIT_REASONS, GitFailure, findForbiddenArg, ghAuthPreflight, ghRun, gitRun,
} from '../lib/git-exec.mjs';

const CRED = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

/** Run `git <argv>` in-process with a spawn recorder; returns code/out/err/calls. */
async function gitCmd(repo, argv, extraEnv = {}) {
  const ctx = repo.ctx(extraEnv);
  const rec = installSpawnRecorder();
  try {
    let code;
    try {
      code = await run(argv, ctx);
    } catch (err) {
      if (err instanceof UsageError) code = 2;
      else throw err;
    }
    rec.assertNoForbidden();
    return { code, out: ctx.out(), err: ctx.err(), calls: rec.calls };
  } finally {
    rec.restore();
  }
}

test('AC9: git branch creates feat/<slug> from the default branch, sets branch, logs cli history', async () => {
  const repo = mkGitRepo();
  try {
    // working-tree changes must survive the checkout
    repo.write('untracked.txt', 'u\n');
    fs.appendFileSync(path.join(repo.featureDir, 'notes.md'), 'n\n');
    const mainSha = repo.git(['rev-parse', 'main']);

    const r = await gitCmd(repo, ['branch']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /branch feat\/sample \(from origin\/main\)/);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/sample');
    assert.equal(repo.git(['rev-parse', 'HEAD']), mainSha);
    assert.equal(repo.read('untracked.txt'), 'u\n');
    assert.ok(fs.existsSync(path.join(repo.featureDir, 'notes.md')));
    // no upstream tracking of origin/main
    assert.throws(() => repo.git(['rev-parse', '--abbrev-ref', 'feat/sample@{upstream}']));

    const fj = readFj(repo);
    assert.equal(fj.branch, 'feat/sample');
    const last = fj.history.at(-1);
    assert.equal(last.phase, 'git');
    assert.equal(last.subagent, 'cli');
    assert.equal(last.executor, 'cli');
    assert.equal(last.status, 'DONE');
    assert.equal(last.summary, 'branch feat/sample');

    // R20: every git call ran with GIT_TERMINAL_PROMPT=0
    assert.ok(r.calls.length > 0);
    for (const c of r.calls) assert.equal(c.env.GIT_TERMINAL_PROMPT, '0', c.args.join(' '));
  } finally { repo.cleanup(); }
});

test('AC9: --json success, bugfix prefix, explicit name and --base', async () => {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'bugfix' }) });
  try {
    let r = await gitCmd(repo, ['branch', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { ok: true, branch: 'fix/sample', base: 'origin/main' });

    repo.git(['checkout', '-q', 'main']);
    r = await gitCmd(repo, ['branch', 'chore/other', '--base', 'main']);
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'chore/other');
    assert.equal(readFj(repo).branch, 'chore/other');
  } finally { repo.cleanup(); }
});

test('AC10: unpushed commit on local main → exit 1 main-ahead, no branch', async () => {
  const repo = mkGitRepo();
  try {
    repo.write('extra.txt', 'x\n');
    repo.git(['add', 'extra.txt']);
    repo.git(['commit', '-q', '-m', 'local only']);
    const fjBefore = fs.readFileSync(path.join(repo.featureDir, 'feature.json'), 'utf8');

    const r = await gitCmd(repo, ['branch', '--json']);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git branch: FAILED main-ahead — local main has 1 commit\(s\)/);
    const doc = JSON.parse(r.out);
    assert.equal(doc.ok, false);
    assert.equal(doc.reason, 'main-ahead');
    assert.match(doc.detail, /local main/);
    assert.equal(repo.git(['branch', '--list', 'feat/sample']), '');
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(fs.readFileSync(path.join(repo.featureDir, 'feature.json'), 'utf8'), fjBefore);
  } finally { repo.cleanup(); }
});

test('git branch without a remote branches from local main', async () => {
  const repo = mkGitRepo({ remote: false });
  try {
    const r = await gitCmd(repo, ['branch']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /from main\)/);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/sample');
  } finally { repo.cleanup(); }
});

test('R13/AC21: hotfix branch without --base fails with auth when gh auth status fails', async () => {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'hotfix' }) });
  try {
    const gh = mkGhStub(repo.tmpDir(), [{ match: 'auth status', exit: 1, stderr: 'You are not logged into any GitHub hosts.\n' }]);
    const r = await gitCmd(repo, ['branch'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git branch: FAILED auth — gh auth status failed: You are not logged/);
    const calls = gh.calls();
    assert.deepEqual(calls.map((c) => c.argv), [['auth', 'status']]);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  } finally { repo.cleanup(); }
});

test('R15: hotfix branch defaults to the latest release tag via gh', async () => {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'hotfix' }) });
  try {
    repo.git(['tag', 'v1.0.0']);
    const tagSha = repo.git(['rev-parse', 'v1.0.0^{commit}']);
    repo.write('later.txt', 'l\n');
    repo.git(['add', 'later.txt']);
    repo.git(['commit', '-q', '-m', 'later']);
    repo.git(['push', '-q', 'origin', 'main']);

    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'release view', stdout: JSON.stringify({ tagName: 'v1.0.0' }) },
    ]);
    const r = await gitCmd(repo, ['branch'], gh.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'hotfix/sample');
    assert.equal(repo.git(['rev-parse', 'HEAD']), tagSha);
    const calls = gh.calls();
    assert.deepEqual(calls.map((c) => c.argv), [['auth', 'status'], ['release', 'view', '--json', 'tagName']]);
    for (const c of calls) assert.equal(c.env.GH_PROMPT_DISABLED, '1');
  } finally { repo.cleanup(); }
});

test('git branch: existing branch, bad name, bad base → exit 2', async () => {
  const repo = mkGitRepo();
  try {
    repo.git(['branch', 'feat/sample']);
    assert.equal((await gitCmd(repo, ['branch'])).code, 2);
    assert.equal((await gitCmd(repo, ['branch', 'bad..name'])).code, 2);
    assert.equal((await gitCmd(repo, ['branch', 'feat/x', '--base', 'nope'])).code, 2);
    assert.equal((await gitCmd(repo, ['branch', 'a', 'b'])).code, 2);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  } finally { repo.cleanup(); }
});

test('cmd-git usage errors exit 2 (CLI)', () => {
  const repo = mkGitRepo({ remote: false });
  try {
    for (const args of [['git'], ['git', 'bogus'], ['git', 'branch', '--bogus']]) {
      const r = runCli(args, { cwd: repo.root, env: repo.env });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    }
  } finally { repo.cleanup(); }
});

test('cmd-git: a verb whose module is missing reports not implemented yet', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-empty-'));
  try {
    const libUrl = pathToFileURL(empty + path.sep);
    await assert.rejects(run(['commit'], mkCtx(), { libUrl }), (err) => err instanceof UsageError && /not implemented yet/.test(err.message));
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test('R12: forbidden flags are refused before anything is spawned', async () => {
  assert.equal(findForbiddenArg(['push', '--force']), '--force');
  assert.equal(findForbiddenArg(['push', '--force-with-lease=main']), '--force-with-lease=main');
  assert.equal(findForbiddenArg(['commit', '--no-verify']), '--no-verify');
  assert.equal(findForbiddenArg(['reset', '--hard', 'HEAD']), 'reset --hard');
  assert.equal(findForbiddenArg(['reset', '--soft', 'HEAD']), null);
  assert.equal(findForbiddenArg(['push', '-u', 'origin', 'x']), null);

  // security S4: short forms, +refspec, branch -D, gh pr merge --admin
  assert.equal(findForbiddenArg(['push', '-f', 'origin', 'x']), 'push -f');
  assert.equal(findForbiddenArg(['push', '-uf', 'origin', 'x']), 'push -f');
  assert.equal(findForbiddenArg(['push', 'origin', '+x']), 'push +x');
  assert.equal(findForbiddenArg(['push', 'origin', '+refs/heads/x:refs/heads/x']), 'push +refs/heads/x:refs/heads/x');
  assert.equal(findForbiddenArg(['-c', 'credential.helper=', 'push', '-f']), 'push -f');
  assert.equal(findForbiddenArg(['push', '--force-if-includes']), '--force-if-includes');
  assert.equal(findForbiddenArg(['commit', '-qn', '-F', 'm']), 'commit -n');
  assert.equal(findForbiddenArg(['branch', '-D', 'x']), 'branch -D');
  assert.equal(findForbiddenArg(['branch', '-f', 'x', 'y']), 'branch -f');
  assert.equal(findForbiddenArg(['checkout', '-f', 'main']), 'checkout -f');
  assert.equal(findForbiddenArg(['pr', 'merge', 'b', '--squash', '--admin']), 'pr merge --admin');
  // only real flag positions: option values and post-`--` args are data
  assert.equal(findForbiddenArg(['pr', 'create', '--title', '--force', '--body-file', '--no-verify']), null);
  assert.equal(findForbiddenArg(['commit', '-q', '-F', '-n']), null);
  assert.equal(findForbiddenArg(['add', '--', '--force', '-f']), null);
  assert.equal(findForbiddenArg(['checkout', '-b', 'feat/x', 'main']), null);
  assert.equal(findForbiddenArg(['branch', '-d', 'x']), null);
  assert.equal(findForbiddenArg(['log', '-1', '--format=%s']), null);
  assert.equal(findForbiddenArg(['pr', 'merge', 'b', '--squash', '--delete-branch']), null);
  assert.equal(findForbiddenArg(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.']), null);

  let spawned = 0;
  const spawn = () => { spawned += 1; throw new Error('must not spawn'); };
  for (const args of [['push', '--force'], ['push', '--force-with-lease'], ['commit', '--no-verify', '-m', 'x'], ['reset', '--hard']]) {
    await assert.rejects(gitRun(args, { spawn }), ForbiddenArgError);
  }
  await assert.rejects(ghRun(['pr', 'merge', '--force'], { spawn }), ForbiddenArgError);
  await assert.rejects(ghRun(['pr', 'merge', 'b', '--admin'], { spawn }), ForbiddenArgError);
  await assert.rejects(gitRun(['push', '-f', 'origin', 'b'], { spawn }), ForbiddenArgError);
  await assert.rejects(gitRun(['branch', '-D', 'b'], { spawn }), ForbiddenArgError);
  assert.equal(spawned, 0);
});

test('R14: credential helper prefix only on network git calls when enabled', async () => {
  const seen = [];
  const spawn = (cmd, args, opts) => { seen.push(args); return nodeSpawn(process.execPath, ['-e', ''], opts); };
  await gitRun(['fetch', 'origin'], { spawn, ghCredential: true });
  await gitRun(['push', '-u', 'origin', 'b'], { spawn, env: { ...process.env, DEV_CYCLE_GIT_CREDENTIAL: 'gh' } });
  await gitRun(['status'], { spawn, ghCredential: true });
  await gitRun(['pull', '--ff-only'], { spawn, env: { ...process.env, DEV_CYCLE_GIT_CREDENTIAL: '' } });
  assert.deepEqual(seen[0], [...CRED, 'fetch', 'origin']);
  assert.deepEqual(seen[1], [...CRED, 'push', '-u', 'origin', 'b']);
  assert.deepEqual(seen[2], ['status']);
  assert.deepEqual(seen[3], ['pull', '--ff-only']);
});

test('R12: a hanging call ends with GitFailure timeout and its process group is killed', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-to-')), 'pid');
  // child spawns a long-lived grandchild in the same group, records its pid, then hangs
  const code = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(g.pid));setTimeout(()=>{},60000);`;
  const spawn = (cmd, args, opts) => nodeSpawn(process.execPath, ['-e', code], opts);
  const started = Date.now();
  await assert.rejects(gitRun(['push', 'origin', 'x'], { spawn, timeout_s: 0.5 }),
    (err) => err instanceof GitFailure && err.reason === 'timeout' && /git push did not finish within 0.5s/.test(err.detail));
  assert.ok(Date.now() - started < 5000);
  const gpid = Number(fs.readFileSync(marker, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(gpid, 0); await new Promise((r) => setTimeout(r, 25)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'grandchild survived the timeout');
  fs.rmSync(path.dirname(marker), { recursive: true, force: true });
});

test('ghAuthPreflight: missing gh binary → auth; GitFailure rejects unknown reasons', async () => {
  await assert.rejects(ghAuthPreflight({ env: { ...process.env, DEV_CYCLE_GH: '/nonexistent/gh-binary' } }),
    (err) => err instanceof GitFailure && err.reason === 'auth');
  assert.throws(() => new GitFailure('oops', 'x'), TypeError);
  assert.equal(GIT_REASONS.length, 13);
});
