// Polish track: PR title/body (AC21), rebase merge (AC22), ship end to end (AC23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sampleFeatureJson } from './helpers.mjs';
import { installSpawnRecorder, mkGhStub, mkGitRepo } from './git-helpers.mjs';
import { run as gitRun } from '../lib/cmd-git.mjs';
import { run as shipRun } from '../lib/cmd-ship.mjs';
import { UsageError } from '../lib/core.mjs';
import { buildPrBody } from '../lib/git-message.mjs';
import { parseItems } from '../lib/polish.mjs';

const T = { timeout: 60_000 };

function polishMd({ deferLast = false } = {}) {
  const items = [
    ['Home title clipped', 'src/home.ts'], ['Settings colour', 'src/settings.ts'], ['Profile save', 'src/profile.ts'],
  ];
  const out = ['---', 'feature: sample', 'created: 2026-01-01 00:00', 'status: [TODO]', 'flow: feature', 'track: polish', '---', '',
    '# Polish batch — sample', '', '## Tasks'];
  items.forEach(([t], k) => out.push(`- [${deferLast && k === 2 ? 'TODO' : 'IMPL-DONE'}] **Task ${k + 1}** (backend${deferLast && k === 2 ? ', deferred' : ''}): ${t}`));
  items.forEach(([, touch], k) => {
    out.push('', `### Task ${k + 1}`, `**Item:** P${k + 1}`, '**Area:** a', `**Touches:** \`${touch}\``);
    if (deferLast && k === 2) out.push('**Deferred:** needs new API');
  });
  return `${out.join('\n')}\n`;
}

const HISTORY = [
  { phase: 'implement.area=a', status: 'DONE' }, { phase: 'static-check', status: 'PASSED' },
  { phase: 'review', status: 'APPROVED' }, { phase: 'auto-test', status: 'PASSED' }, { phase: 'security', status: 'APPROVED' },
];
const MANIFESTS = { 'package.json': '{\n  "name": "x",\n  "version": "1.4.0"\n}\n' };

function mkRepo({ deferLast = false } = {}) {
  const repo = mkGitRepo({
    featureJson: sampleFeatureJson({ track: 'polish', branch: 'feat/sample', areas: [{ name: 'a', touches: ['src/**'] }], history: HISTORY }),
    files: { 'polish.md': polishMd({ deferLast }) },
  });
  for (const [rel, text] of Object.entries(MANIFESTS)) repo.write(rel, text);
  repo.write('CHANGELOG.md', '## [1.4.0] - 2026-01-01\n\n- old\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'chore: manifests']);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['checkout', '-q', '-b', 'feat/sample']);
  return repo;
}

async function call(fn, repo, argv, env = {}) {
  const ctx = repo.ctx({ CLAUDE_CODE_SESSION_ID: '', ...env });
  const rec = installSpawnRecorder();
  try {
    let code;
    try { code = await fn(argv, ctx); } catch (err) {
      if (err instanceof UsageError) code = 2; else throw err;
    }
    rec.assertNoForbidden();
    return { code, out: ctx.out(), err: ctx.err() };
  } finally { rec.restore(); }
}

const git = (repo, argv, env) => call(gitRun, repo, argv, env);
const ghArgv = (gh) => gh.calls().map((c) => c.argv);

test('AC21: git pr on polish uses the batch title and Items/Deferred blocks; lite body keeps Tasks', T, async () => {
  const repo = mkRepo({ deferLast: true });
  try {
    repo.write('src/home.ts', 'h\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'fix(src): P1 Home title clipped']);
    const gh = mkGhStub(repo.tmpDir(), [{ match: 'pr list', stdout: '[]' }, { match: 'pr create', stdout: 'https://github.com/o/r/pull/9\n' }]);
    const r = await git(repo, ['pr'], gh.env);
    assert.equal(r.code, 0, r.err);
    const create = ghArgv(gh).find((a) => a[0] === 'pr' && a[1] === 'create');
    assert.equal(create[create.indexOf('--title') + 1], 'fix(src): polish batch P1–P3 (3 items)');
    const items = parseItems(polishMd({ deferLast: true }));
    const body = buildPrBody({ polishItems: items });
    assert.match(body, /Items:\n- P1: Home title clipped\n- P2: Settings colour\n\nDeferred:\n- P3: Profile save — needs new API/);
    assert.ok(!/Tasks:/.test(body));
  } finally { repo.cleanup(); }

  const lite = mkGitRepo({
    featureJson: sampleFeatureJson({ track: 'lite', branch: 'feat/sample', history: HISTORY }),
    files: { 'spec.md': '# S — Spec\n\n## Tasks\n- [DONE] **Task 1** (backend): Do it\n' },
  });
  try {
    lite.git(['checkout', '-q', '-b', 'feat/sample']);
    lite.write('src/a.js', 'a\n');
    lite.git(['add', '-A']);
    lite.git(['commit', '-q', '-m', 'feat(src): lite thing']);
    const gh = mkGhStub(lite.tmpDir(), [{ match: 'pr list', stdout: '[]' }, { match: 'pr create', stdout: 'https://github.com/o/r/pull/8\n' }]);
    const r = await git(lite, ['pr'], gh.env);
    assert.equal(r.code, 0, r.err);
    const create = ghArgv(gh).find((a) => a[1] === 'create');
    assert.equal(create[create.indexOf('--title') + 1], 'feat(src): lite thing');
  } finally { lite.cleanup(); }
});

test('AC22: git merge on polish rebases; a refused rebase fails not-mergeable without a squash retry', T, async () => {
  const repo = mkRepo();
  try {
    repo.git(['push', '-q', '-u', 'origin', 'feat/sample']);
    const ok = mkGhStub(repo.tmpDir(), [{ match: 'pr checks', exit: 1, stderr: 'no checks reported\n' }]);
    let r = await git(repo, ['merge'], ok.env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(ghArgv(ok).filter((a) => a[1] === 'merge'), [['pr', 'merge', 'feat/sample', '--rebase', '--delete-branch']]);
  } finally { repo.cleanup(); }

  const refused = mkRepo();
  try {
    refused.git(['push', '-q', '-u', 'origin', 'feat/sample']);
    const gh = mkGhStub(refused.tmpDir(), [
      { match: 'pr checks', exit: 1, stderr: 'no checks reported\n' },
      { match: 'pr merge', exit: 1, stderr: 'Rebase merges are not allowed on this repository.\n' },
    ]);
    const r = await git(refused, ['merge'], gh.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /git merge: FAILED not-mergeable — gh pr merge: Rebase merges are not allowed/);
    const merges = ghArgv(gh).filter((a) => a[1] === 'merge');
    assert.equal(merges.length, 1);
    assert.ok(!merges.flat().includes('--squash'));
  } finally { refused.cleanup(); }
});

test('AC23: ship on polish releases, commits per item plus a batch commit, and skips commit on re-run', T, async () => {
  const repo = mkRepo();
  try {
    repo.write('src/home.ts', 'h\n');
    repo.write('src/settings.ts', 's\n');
    repo.write('src/profile.ts', 'p\n');
    const gh = mkGhStub(repo.tmpDir(), [{ match: 'pr checks', exit: 1, stderr: 'no checks reported\n' }]);
    const sha = () => repo.git(['rev-parse', 'main']);
    // ship ends on main (merge checks it out); the feature branch keeps the commits
    gh.setRules([
      { match: 'pr checks', exit: 1, stderr: 'no checks reported\n' },
      { match: 'pr view feat/sample --json mergeCommit', stdout: JSON.stringify({ mergeCommit: { oid: sha() } }) },
    ]);
    let r = await call(shipRun, repo, ['--release', 'patch', '--subject', 'polish batch'], gh.env);
    assert.equal(r.code, 0, r.err);
    const steps = r.out.split('\n').filter((l) => l.startsWith('ship: '));
    assert.deepEqual(steps.slice(0, 4), ['ship: tokens skipped', 'ship: dod ok', 'ship: release ok', 'ship: commit ok']);
    const subs = repo.git(['log', '--reverse', '--format=%s', 'main..feat/sample']).split('\n');
    assert.deepEqual(subs.slice(0, 3), ['fix(src): P1 Home title clipped', 'fix(src): P2 Settings colour', 'fix(src): P3 Profile save']);
    assert.equal(subs.length, 4);
    assert.equal(subs[3], 'fix: polish batch');
    const batchFiles = repo.git(['show', '--name-only', '--format=', 'feat/sample']);
    assert.ok(batchFiles.includes('CHANGELOG.md') && batchFiles.includes('package.json'), batchFiles);
    assert.ok(ghArgv(gh).some((a) => a.join(' ').includes('pr merge feat/sample --rebase --delete-branch')));

    // Re-run with an unrelated baseline untracked file present: commit is skipped.
    repo.git(['checkout', '-q', 'feat/sample']);
    repo.write('scratch.txt', 'mine\n');
    const fjFile = `${repo.featureDir}/feature.json`;
    const fj = JSON.parse(fs.readFileSync(fjFile, 'utf8'));
    fj.untracked_baseline = ['scratch.txt'];
    fs.writeFileSync(fjFile, JSON.stringify(fj, null, 2));
    repo.git(['add', '--', 'docs']);
    repo.git(['commit', '-q', '-m', 'chore: baseline']);
    r = await call(shipRun, repo, ['--release', 'patch', '--subject', 'polish batch'], gh.env);
    assert.match(r.out, /ship: commit skipped/);
  } finally { repo.cleanup(); }
});
