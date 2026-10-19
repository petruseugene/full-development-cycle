import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sampleFeatureJson } from './helpers.mjs';
import { assertNoForbidden, installSpawnRecorder, mkGhStub, mkGitRepo } from './git-helpers.mjs';
import { run } from '../lib/cmd-git.mjs';
import { UsageError } from '../lib/core.mjs';
import { classifyChecks } from '../lib/git-remote.mjs';

const CRED = 'credential.helper=!gh auth git-credential';

const SPEC = '# Sample thing — Spec\n\n## 1. Problem & Goal\n\nThe widget is slow.\nIt hurts.\n\n## 2. Goals\n\nFast.\n';
const PLAN = [
  '# Sample — Plan', '', '## Tasks',
  '- [IMPL-DONE] **Task 1** (backend): Speed up widget',
  '- [IMPL-DONE] **Task 2** (backend, owner): Flip the flag',
  '',
].join('\n');

/** History that satisfies dod for sampleFeatureJson (full track, auto_tests, task 1). */
const PASSING_HISTORY = [
  { phase: 'spec', status: 'DONE' },
  { phase: 'plan', status: 'DONE' },
  { phase: 'implement.task=1', status: 'DONE' },
  { phase: 'static-check', status: 'PASSED' },
  { phase: 'review', status: 'APPROVED', summary: 'all good' },
  { phase: 'auto-test', status: 'PASSED', summary: '12 tests' },
  { phase: 'security', status: 'APPROVED', summary: 'no findings' },
];

/**
 * Repo on branch feat/sample with one code commit. feature.json, spec and
 * plan are committed on main, so checking out main leaves them untouched.
 */
function mkRepo({ history = PASSING_HISTORY, push = false } = {}) {
  const repo = mkGitRepo({
    featureJson: sampleFeatureJson({ history, branch: 'feat/sample' }),
    files: { 'spec.md': SPEC, 'plan.md': PLAN },
  });
  repo.git(['checkout', '-q', '-b', 'feat/sample']);
  repo.write('src/widget.js', 'export const fast = true;\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'feat(src): speed up widget\n\nCloses #42']);
  if (push) repo.git(['push', '-q', '-u', 'origin', 'feat/sample']);
  return repo;
}

/** Run `git <argv>` in-process with a spawn recorder (forbidden flags asserted on every spawn). */
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
    return { code, out: ctx.out(), err: ctx.err(), calls: rec.calls, gitCalls: rec.gitCalls() };
  } finally {
    rec.restore();
  }
}

const fjBytes = (repo) => fs.readFileSync(path.join(repo.featureDir, 'feature.json'));
const ghArgv = (gh) => gh.calls().map((c) => c.argv.join(' '));

// --- push -------------------------------------------------------------------

test('AC16: git push pushes the branch to the bare remote with upstream set', { timeout: 60_000 }, async () => {
  const repo = mkRepo();
  try {
    const r = await gitCmd(repo, ['push', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { ok: true, branch: 'feat/sample', remote: 'origin' });
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'feat/sample@{upstream}']), 'origin/feat/sample');
    const remoteSha = repo.git(['ls-remote', 'origin', 'refs/heads/feat/sample']).split(/\s/)[0];
    assert.equal(remoteSha, repo.git(['rev-parse', 'HEAD']));
    const pushCall = r.gitCalls.find((a) => a.includes('push'));
    assert.deepEqual(pushCall, ['push', '-u', 'origin', 'feat/sample']);
    for (const c of r.calls) assert.equal(c.env.GIT_TERMINAL_PROMPT, '0');
  } finally { repo.cleanup(); }
});

test('AC16: DEV_CYCLE_GIT_CREDENTIAL=gh puts the gh credential helper on the push argv', { timeout: 60_000 }, async () => {
  const repo = mkRepo();
  try {
    const r = await gitCmd(repo, ['push'], { DEV_CYCLE_GIT_CREDENTIAL: 'gh' });
    assert.equal(r.code, 0, r.err);
    const pushCall = r.gitCalls.find((a) => a.includes('push'));
    assert.deepEqual(pushCall, ['-c', 'credential.helper=', '-c', CRED, 'push', '-u', 'origin', 'feat/sample']);
    // local plumbing calls are not prefixed
    for (const a of r.gitCalls.filter((x) => !x.includes('push'))) assert.ok(!a.includes(CRED), a.join(' '));
  } finally { repo.cleanup(); }
});

test('git push: --gh-credential flag enables the helper too', { timeout: 60_000 }, async () => {
  const repo = mkRepo();
  try {
    const r = await gitCmd(repo, ['push', '--gh-credential']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.gitCalls.find((a) => a.includes('push')).includes(CRED));
  } finally { repo.cleanup(); }
});

test('git push: a non-fast-forward rejection → push-rejected', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    repo.git(['commit', '-q', '--amend', '-m', 'rewritten']);
    const r = await gitCmd(repo, ['push', '--json']);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git push: FAILED push-rejected — /);
    assert.equal(JSON.parse(r.out).reason, 'push-rejected');
  } finally { repo.cleanup(); }
});

test('git push/pr/merge on the default branch or detached HEAD → exit 2', { timeout: 60_000 }, async () => {
  const repo = mkRepo();
  try {
    repo.git(['checkout', '-q', 'main']);
    for (const verb of ['push', 'pr', 'merge']) {
      const r = await gitCmd(repo, [verb]);
      assert.equal(r.code, 2, verb);
    }
    repo.git(['checkout', '-q', '--detach', 'HEAD']);
    assert.equal((await gitCmd(repo, ['push'])).code, 2);
  } finally { repo.cleanup(); }
});

// --- pr ---------------------------------------------------------------------

test('AC17: git pr creates the PR with --body-file holding summary, tasks, Tests, Review, footer', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const dir = repo.tmpDir();
    // the stub copies nothing, so capture the body via a wrapper script
    const gh = mkGhStub(dir, [
      { match: 'pr list', stdout: '[]\n' },
      { match: 'pr create', stdout: 'https://github.com/o/r/pull/7\n' },
    ]);
    const capture = path.join(dir, 'body-copy.md');
    const wrapper = path.join(dir, 'gh-capture');
    fs.writeFileSync(wrapper, [
      '#!/bin/sh',
      'prev=""',
      'for a in "$@"; do if [ "$prev" = "--body-file" ]; then cp "$a" ' + JSON.stringify(capture) + '; fi; prev="$a"; done',
      `exec ${JSON.stringify(gh.bin)} "$@"`, '',
    ].join('\n'), { mode: 0o755 });

    const before = fjBytes(repo);
    const r = await gitCmd(repo, ['pr', '--body-footer', 'FOOTER: generated', '--json'], { ...gh.env, DEV_CYCLE_GH: wrapper });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), {
      ok: true, url: 'https://github.com/o/r/pull/7', created: true, branch: 'feat/sample', base: 'main',
    });

    const calls = ghArgv(gh);
    assert.equal(calls[0], 'auth status');
    const create = gh.calls().find((c) => c.argv[0] === 'pr' && c.argv[1] === 'create').argv;
    const opt = (k) => create[create.indexOf(k) + 1];
    assert.equal(opt('--head'), 'feat/sample');
    assert.equal(opt('--base'), 'main');
    assert.equal(opt('--title'), 'feat(src): speed up widget');
    assert.ok(create.includes('--body-file'));
    assert.ok(!fs.existsSync(opt('--body-file')), 'temp body file removed');

    const body = fs.readFileSync(capture, 'utf8');
    assert.match(body, /The widget is slow\. It hurts\./);
    assert.match(body, /Tasks:\n- Task 1: Speed up widget\n/);
    assert.doesNotMatch(body, /Flip the flag/);
    assert.match(body, /Tests: PASSED — 12 tests/);
    assert.match(body, /Review: APPROVED — all good/);
    assert.match(body, /Closes #42/);
    assert.match(body, /FOOTER: generated\n$/);
    for (const c of gh.calls()) assert.equal(c.env.GH_PROMPT_DISABLED, '1');
    assertNoForbidden(gh.calls());
    assert.deepEqual(fjBytes(repo), before, 'feature.json untouched by pr');
  } finally { repo.cleanup(); }
});

test('AC17: an existing PR for the branch → prints its URL, exit 0, no pr create', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr list', stdout: '[{"url":"https://github.com/o/r/pull/3"}]\n' },
    ]);
    const r = await gitCmd(repo, ['pr'], gh.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'https://github.com/o/r/pull/3');
    assert.ok(!ghArgv(gh).some((a) => a.startsWith('pr create')));
  } finally { repo.cleanup(); }
});

test('R19: git pr --base <release branch> and --title override', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr list', stdout: '[]' },
      { match: 'pr create', stdout: 'https://github.com/o/r/pull/9\n' },
    ]);
    const r = await gitCmd(repo, ['pr', '--base', 'release/1.2', '--title', 'hotfix: x'], gh.env);
    assert.equal(r.code, 0, r.err);
    const create = gh.calls().find((c) => c.argv[1] === 'create').argv;
    assert.equal(create[create.indexOf('--base') + 1], 'release/1.2');
    assert.equal(create[create.indexOf('--title') + 1], 'hotfix: x');
  } finally { repo.cleanup(); }
});

test('AC21: gh auth status failing → git pr exits 1 with reason auth, nothing created', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [{ match: 'auth status', exit: 1, stderr: 'You are not logged into any GitHub hosts.\n' }]);
    const r = await gitCmd(repo, ['pr', '--json'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git pr: FAILED auth — /);
    assert.equal(JSON.parse(r.out).reason, 'auth');
    assert.deepEqual(ghArgv(gh), ['auth status']);
  } finally { repo.cleanup(); }
});

// --- merge ------------------------------------------------------------------

test('AC18: git merge with dod FAILED → dod-failed, no gh merge call', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ history: PASSING_HISTORY.filter((e) => e.phase !== 'review'), push: true });
  try {
    const gh = mkGhStub(repo.tmpDir());
    const r = await gitCmd(repo, ['merge', '--json'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git merge: FAILED dod-failed — DOD-GATE FAILED: review last status = MISSING/);
    assert.equal(JSON.parse(r.out).reason, 'dod-failed');
    assert.ok(!ghArgv(gh).some((a) => a.startsWith('pr merge')));
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/sample');
  } finally { repo.cleanup(); }
});

test('AC19: dod PASSED + green checks → squash merge, checkout default, pull --ff-only; feature.json unchanged by push/pr/merge', { timeout: 60_000 }, async () => {
  const repo = mkRepo();
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr list', stdout: '[]' },
      { match: 'pr create', stdout: 'https://github.com/o/r/pull/7\n' },
      { match: 'pr view', stdout: '{"url":"https://github.com/o/r/pull/7","state":"OPEN","mergeable":"MERGEABLE"}' },
      { match: 'pr checks', stdout: '[{"name":"ci","bucket":"pass"},{"name":"lint","bucket":"skipping"}]' },
    ]);
    const before = fjBytes(repo);

    let r = await gitCmd(repo, ['push'], gh.env);
    assert.equal(r.code, 0, r.err);
    r = await gitCmd(repo, ['pr'], gh.env);
    assert.equal(r.code, 0, r.err);
    r = await gitCmd(repo, ['merge', '--json'], gh.env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), {
      ok: true, branch: 'feat/sample', default: 'main', checks: 'pass', url: 'https://github.com/o/r/pull/7',
    });

    const merges = gh.calls().filter((c) => c.argv[0] === 'pr' && c.argv[1] === 'merge').map((c) => c.argv);
    assert.deepEqual(merges, [['pr', 'merge', 'feat/sample', '--squash', '--delete-branch']]);
    const ghOrder = ghArgv(gh).filter((a) => /^pr (checks|merge)/.test(a));
    assert.ok(ghOrder.indexOf(ghOrder.find((a) => a.startsWith('pr checks'))) < ghOrder.findIndex((a) => a.startsWith('pr merge')));

    const ci = r.gitCalls.findIndex((a) => a[0] === 'checkout' && a[1] === 'main');
    const pi = r.gitCalls.findIndex((a) => a[0] === 'pull' && a[1] === '--ff-only');
    assert.ok(ci >= 0 && pi > ci, JSON.stringify(r.gitCalls));
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');

    assert.deepEqual(fjBytes(repo), before, 'feature.json bytes unchanged');
    assert.equal(repo.git(['status', '--porcelain']), '');
    assertNoForbidden(gh.calls());
  } finally { repo.cleanup(); }
});

test('git merge: no checks reported → proceeds to merge', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr checks', exit: 1, stderr: "no checks reported on the 'feat/sample' branch\n" },
    ]);
    const r = await gitCmd(repo, ['merge'], gh.env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no checks/);
    assert.ok(ghArgv(gh).some((a) => a.startsWith('pr merge feat/sample --squash --delete-branch')));
  } finally { repo.cleanup(); }
});

test('AC20: failing checks → ci-failing, no merge', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr checks', exit: 1, stdout: '[{"name":"ci","bucket":"fail"},{"name":"lint","bucket":"pass"}]' },
    ]);
    const r = await gitCmd(repo, ['merge', '--json'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git merge: FAILED ci-failing — failing checks: ci/);
    assert.ok(!ghArgv(gh).some((a) => a.startsWith('pr merge')));
  } finally { repo.cleanup(); }
});

test('AC20: pending checks with --ci-timeout 1 → ci-pending, no merge', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr checks', exit: 8, stdout: '[{"name":"ci","bucket":"pending"}]' },
    ]);
    const t0 = Date.now();
    const r = await gitCmd(repo, ['merge', '--ci-timeout', '1', '--json'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /^git merge: FAILED ci-pending — checks still pending after 1s: ci/);
    assert.ok(Date.now() - t0 >= 900, 'waited for the timeout');
    assert.ok(ghArgv(gh).filter((a) => a.startsWith('pr checks')).length >= 2, 'polled more than once');
    assert.ok(!ghArgv(gh).some((a) => a.startsWith('pr merge')));
  } finally { repo.cleanup(); }
});

test('git merge: pending then green → polls and merges', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr checks', sequence: [
        { exit: 8, stdout: '[{"name":"ci","bucket":"pending"}]' },
        { exit: 0, stdout: '[{"name":"ci","bucket":"pass"}]' },
      ] },
    ]);
    const r = await gitCmd(repo, ['merge', '--ci-timeout', '30'], { ...gh.env, DEV_CYCLE_CI_POLL_S: '1' });
    assert.equal(r.code, 0, r.err);
    assert.equal(ghArgv(gh).filter((a) => a.startsWith('pr checks')).length, 2);
    assert.ok(ghArgv(gh).some((a) => a.startsWith('pr merge')));
  } finally { repo.cleanup(); }
});

test('git merge: conflicting PR → conflict; gh merge refusal → not-mergeable', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [
      { match: 'pr view', stdout: '{"url":"u","state":"OPEN","mergeable":"CONFLICTING"}' },
    ]);
    let r = await gitCmd(repo, ['merge'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED conflict — /);
    assert.ok(!ghArgv(gh).some((a) => a.startsWith('pr merge')));

    gh.setRules([{ match: 'pr merge', exit: 1, stderr: 'Pull request is not mergeable: the base branch policy prohibits the merge.\n' }]);
    r = await gitCmd(repo, ['merge'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED not-mergeable — gh pr merge: /);
    assert.equal(repo.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/sample');

    gh.setRules([{ match: 'pr merge', exit: 1, stderr: 'Pull request has merge conflicts\n' }]);
    r = await gitCmd(repo, ['merge'], gh.env);
    assert.match(r.err, /FAILED conflict — gh pr merge: /);

    gh.setRules([{ match: 'pr view', exit: 1, stderr: 'no pull requests found for branch "feat/sample"\n' }]);
    r = await gitCmd(repo, ['merge'], gh.env);
    assert.match(r.err, /FAILED not-mergeable — no pull request/);
  } finally { repo.cleanup(); }
});

test('git merge: auth failure → auth; bad --ci-timeout → exit 2', { timeout: 60_000 }, async () => {
  const repo = mkRepo({ push: true });
  try {
    const gh = mkGhStub(repo.tmpDir(), [{ match: 'auth status', exit: 1, stderr: 'not logged in\n' }]);
    let r = await gitCmd(repo, ['merge'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED auth — /);
    r = await gitCmd(repo, ['merge', '--ci-timeout', 'soon'], gh.env);
    assert.equal(r.code, 2);
  } finally { repo.cleanup(); }
});

test('classifyChecks', () => {
  assert.deepEqual(classifyChecks({ code: 0, stdout: '[]', stderr: '' }), { state: 'none', names: [] });
  assert.equal(classifyChecks({ code: 1, stdout: '[{"name":"a","bucket":"cancel"}]', stderr: '' }).state, 'fail');
  assert.equal(classifyChecks({ code: 8, stdout: '[{"name":"a","bucket":"pending"},{"name":"b","bucket":"pass"}]', stderr: '' }).state, 'pending');
  assert.equal(classifyChecks({ code: 1, stdout: '', stderr: 'HTTP 502' }).state, 'fail');
});
