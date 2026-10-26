import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sampleFeatureJson } from './helpers.mjs';
import { assertNoForbidden, installSpawnRecorder, mkGhStub, mkGitRepo, readFj } from './git-helpers.mjs';
import { run } from '../plugin/scripts/lib/cmd-ship.mjs';
import { UsageError } from '../plugin/scripts/lib/core.mjs';
import { today } from '../plugin/scripts/lib/release.mjs';

const T = { timeout: 60_000 };
const SPEC = '# Sample thing — Spec\n\n## 1. Problem & Goal\n\nThe widget is slow.\n\n## 2. Goals\n\nFast.\n';
const PLAN = '# Sample — Plan\n\n## Tasks\n- [IMPL-DONE] **Task 1** (backend): Speed up widget\n';
const PASSING = [
  { phase: 'spec', status: 'DONE' }, { phase: 'plan', status: 'DONE' }, { phase: 'implement.task=1', status: 'DONE' },
  { phase: 'static-check', status: 'PASSED' }, { phase: 'review', status: 'APPROVED' },
  { phase: 'auto-test', status: 'PASSED' }, { phase: 'security', status: 'APPROVED' },
];
const T7 = 'tokens: 0 measured / 7 estimated entries';
const T6 = 'tokens: 0 measured / 6 estimated entries';
const SHA_RE = /^[0-9a-f]{40}$/;

/** Repo on feat/sample with manifests, a CHANGELOG, a code commit and a gh stub. */
function mkRepo({ history = PASSING, manifests = { '.claude-plugin/plugin.json': '{\n  "version": "1.4.0"\n}\n', 'package.json': '{\n  "name": "x",\n  "version": "1.4.0"\n}\n' }, changelog = '## [1.4.0] - 2026-01-01\n\n- old\n' } = {}) {
  const repo = mkGitRepo({
    featureJson: sampleFeatureJson({ history, branch: 'feat/sample' }),
    files: { 'spec.md': SPEC, 'plan.md': PLAN },
  });
  for (const [rel, text] of Object.entries(manifests)) repo.write(rel, text);
  if (changelog !== null) repo.write('CHANGELOG.md', changelog);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'chore: manifests']);
  repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['checkout', '-q', '-b', 'feat/sample']);
  repo.write('src/widget.js', 'export const fast = true;\n');
  const gh = mkGhStub(repo.tmpDir());
  // The merge commit the stub reports: a commit on main (as a real squash merge would create).
  const mergeSha = () => repo.git(['rev-parse', 'main']);
  return { repo, gh, mergeSha };
}

async function ship(repo, gh, argv, env = {}) {
  const ctx = repo.ctx({ ...gh.env, CLAUDE_CODE_SESSION_ID: '', ...env });
  const rec = installSpawnRecorder();
  try {
    let code;
    try { code = await run(argv, ctx); } catch (err) {
      if (err instanceof UsageError) code = 2; else throw err;
    }
    rec.assertNoForbidden();
    return { code, out: ctx.out(), err: ctx.err(), gitCalls: rec.gitCalls() };
  } finally { rec.restore(); }
}

const lines = (out) => out.split('\n').filter((l) => l.startsWith('ship: ') || l.startsWith('tokens: '));
const readFile = (repo, rel) => fs.readFileSync(path.join(repo.root, rel), 'utf8');
const mergeRule = (sha) => ({ match: 'pr view feat/sample --json mergeCommit', stdout: JSON.stringify({ mergeCommit: { oid: sha } }) });

test('AC26: ship --release minor bumps manifests, changelog, opens/merges the PR and tags the merge commit', T, async () => {
  const { repo, gh, mergeSha } = mkRepo();
  try {
    const notesDir = repo.tmpDir();
    const notes = path.join(notesDir, 'n.md');
    fs.writeFileSync(notes, '### Added\n\n- the widget\n');
    gh.setRules([mergeRule(mergeSha())]);
    const mainBefore = repo.git(['rev-parse', 'origin/main']);
    const r = await ship(repo, gh, ['--release', 'minor', '--notes-file', notes, '--subject', 'feat(x): y']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(lines(r.out), [
      'ship: tokens skipped', 'ship: dod ok', T7, 'ship: release ok', 'ship: commit ok',
      'ship: push ok', 'ship: pr ok', 'ship: merge ok', 'ship: tag ok',
    ]);
    // the feature commit carries both manifests and the changelog
    const files = repo.git(['show', '--name-only', '--format=', 'feat/sample']).split('\n');
    assert.ok(files.includes('.claude-plugin/plugin.json') && files.includes('package.json') && files.includes('CHANGELOG.md'), files.join());
    assert.match(repo.git(['show', 'feat/sample:package.json']), /"version": "1.5.0"/);
    assert.match(repo.git(['show', 'feat/sample:.claude-plugin/plugin.json']), /"version": "1.5.0"/);
    const cl = repo.git(['show', 'feat/sample:CHANGELOG.md']);
    assert.ok(cl.startsWith(`## [1.5.0] — ${today()}\n\n### Added\n\n- the widget\n`), cl);
    // no commit pushed to main; the tag points at the stub's merge commit
    assert.equal(repo.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0], mainBefore);
    const tagCommit = repo.git(['rev-parse', 'v1.5.0^{commit}']);
    assert.equal(tagCommit, mergeSha());
    assert.equal(repo.git(['cat-file', '-t', 'v1.5.0']), 'tag');
    const remoteTag = repo.git(['ls-remote', 'origin', 'refs/tags/v1.5.0^{}']).split(/\s/)[0];
    assert.equal(remoteTag, tagCommit);
    const pushes = r.gitCalls.filter((a) => a[0] === 'push');
    for (const p of pushes) assert.ok(!p.includes('--tags') && !p.includes('main'), p.join(' '));
    assert.deepEqual(pushes.at(-1), ['push', 'origin', 'refs/tags/v1.5.0']);
    // history phase release
    const fjOnBranch = JSON.parse(repo.git(['show', 'feat/sample:docs/features/2026-01-01-00h-00m-sample/feature.json']));
    const rel = fjOnBranch.history.find((h) => h.phase === 'release');
    assert.ok(rel);
    assert.equal(rel.status, 'DONE');
    assert.equal(rel.summary, '1.4.0 → 1.5.0');
    assert.equal(repo.git(['show', 'feat/sample:docs/features/2026-01-01-00h-00m-sample/feature.json']).includes('1.4.0 → 1.5.0'), true);
    assertNoForbidden(gh.calls());
    const ghCalls = gh.calls().map((c) => c.argv.join(' '));
    assert.ok(ghCalls.some((c) => c.startsWith('pr create')));
    assert.ok(ghCalls.some((c) => c.startsWith('pr merge')));
  } finally { repo.cleanup(); }
});

test('AC27: subject bullet sections, auto levels, mismatch, no-manifest, app.json expo.version', T, async () => {
  // fix subject -> ### Fixed
  let { repo, gh, mergeSha } = mkRepo();
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'patch', '--subject', 'fix(x): y']);
    assert.equal(r.code, 0, r.err);
    const cl = repo.git(['show', 'feat/sample:CHANGELOG.md']);
    assert.ok(cl.startsWith(`## [1.4.1] — ${today()}\n\n### Fixed\n\n- fix(x): y\n`), cl);
  } finally { repo.cleanup(); }

  // auto: breaking -> 2.0.0, and the version rides in the tag
  ({ repo, gh, mergeSha } = mkRepo());
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'auto', '--subject', 'feat!: z']);
    assert.equal(r.code, 0, r.err);
    assert.match(repo.git(['show', 'feat/sample:package.json']), /"version": "2.0.0"/);
    assert.equal(repo.git(['rev-parse', 'v2.0.0^{commit}']), mergeSha());
  } finally { repo.cleanup(); }

  // auto on 0.x: feat -> patch
  ({ repo, gh, mergeSha } = mkRepo({ manifests: { 'package.json': '{"version":"0.3.1"}' } }));
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'auto', '--subject', 'feat: z']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(repo.git(['show', 'feat/sample:package.json'])).version, '0.3.2');
  } finally { repo.cleanup(); }

  // version mismatch
  ({ repo, gh } = mkRepo({ manifests: { '.claude-plugin/plugin.json': '{"version":"1.4.0"}', 'package.json': '{"version":"1.3.0"}' } }));
  try {
    const r = await ship(repo, gh, ['--release', 'minor', '--subject', 'feat: z']);
    assert.equal(r.code, 1);
    assert.match(r.err, /ship release: FAILED version-mismatch/);
    assert.equal(repo.git(['status', '--porcelain']).includes('package.json'), false);
    assert.deepEqual(lines(r.out), ['ship: tokens skipped', 'ship: dod ok', T7]);
  } finally { repo.cleanup(); }

  // no manifest
  ({ repo, gh } = mkRepo({ manifests: { 'README.md': 'x\n' } }));
  try {
    const r = await ship(repo, gh, ['--release', 'minor', '--subject', 'feat: z']);
    assert.equal(r.code, 1);
    assert.match(r.err, /ship release: FAILED no-manifest/);
  } finally { repo.cleanup(); }

  // app.json expo.version; absent CHANGELOG is created
  ({ repo, gh, mergeSha } = mkRepo({ manifests: { 'app.json': '{\n  "expo": {\n    "name": "a",\n    "version": "1.4.0"\n  }\n}\n' }, changelog: null }));
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'minor', '--subject', 'feat: z']);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(repo.git(['show', 'feat/sample:app.json'])).expo.version, '1.5.0');
    assert.ok(repo.git(['show', 'feat/sample:CHANGELOG.md']).startsWith(`# Changelog\n\n## [1.5.0] — ${today()}`));
  } finally { repo.cleanup(); }
});

test('AC28: resume after a push failure, third run all skipped, tag-exists on another commit', T, async () => {
  const { repo, gh, mergeSha } = mkRepo();
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\necho rejected-by-test >&2\nexit 1\n', { mode: 0o755 });
    const args = ['--release', 'minor', '--subject', 'feat(x): y'];

    const r1 = await ship(repo, gh, args);
    assert.equal(r1.code, 1);
    assert.match(r1.err, /git push: FAILED (?:hook-failed|push-rejected) — /);
    assert.deepEqual(lines(r1.out), ['ship: tokens skipped', 'ship: dod ok', T7, 'ship: release ok', 'ship: commit ok']);
    assert.equal(gh.calls().filter((c) => c.argv[0] === 'pr' && c.argv[1] !== 'list').length, 0);
    assert.throws(() => repo.git(['rev-parse', '--verify', '-q', 'v1.5.0']));

    fs.rmSync(hook);
    const r2 = await ship(repo, gh, args);
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(lines(r2.out), [
      'ship: tokens skipped', 'ship: dod ok', T7, 'ship: release skipped', 'ship: commit skipped',
      'ship: push ok', 'ship: pr ok', 'ship: merge ok', 'ship: tag ok',
    ]);
    // one release bump only
    assert.match(repo.git(['show', 'feat/sample:package.json']), /"version": "1.5.0"/);
    assert.equal(JSON.parse(repo.git(['show', 'feat/sample:docs/features/2026-01-01-00h-00m-sample/feature.json'])).history.filter((h) => h.phase === 'release').length, 1);

    // the real squash merge happens on the remote; we are back on main (merge checked it out)
    assert.equal(repo.git(['symbolic-ref', '--short', 'HEAD']), 'main');
    repo.git(['merge', '-q', '--ff-only', 'feat/sample']);
    repo.git(['push', '-q', 'origin', 'main']);
    gh.setRules([mergeRule(repo.git(['rev-parse', 'main'])), { match: 'pr list', stdout: '[]' }]);
    // the tag is on the old stub commit: moved merge commit => tag-exists
    const r3a = await ship(repo, gh, args);
    assert.equal(r3a.code, 1, r3a.out + r3a.err);
    assert.match(r3a.err, /ship tag: FAILED tag-exists/);

    // delete the wrong tag locally+remotely, then the third run is all skipped except nothing left to do
    repo.git(['tag', '-d', 'v1.5.0']);
    repo.git(['push', '-q', 'origin', ':refs/tags/v1.5.0']);
    const r3b = await ship(repo, gh, args);
    assert.equal(r3b.code, 0, r3b.err);
    assert.deepEqual(lines(r3b.out), [
      'ship: tokens skipped', 'ship: dod skipped', 'ship: release skipped', 'ship: commit skipped',
      'ship: push skipped', 'ship: pr skipped', 'ship: merge skipped', 'ship: tag ok',
    ]);
    const r4 = await ship(repo, gh, args);
    assert.equal(r4.code, 0, r4.err);
    assert.deepEqual(lines(r4.out), [
      'ship: tokens skipped', 'ship: dod skipped', 'ship: release skipped', 'ship: commit skipped',
      'ship: push skipped', 'ship: pr skipped', 'ship: merge skipped', 'ship: tag skipped',
    ]);
    assert.equal(repo.git(['rev-parse', 'v1.5.0^{commit}']), repo.git(['rev-parse', 'main']));
  } finally { repo.cleanup(); }
});

test('AC29: ship without --release leaves manifests and changelog alone and creates no tag; failing dod stops before commit', T, async () => {
  let { repo, gh } = mkRepo();
  try {
    const r = await ship(repo, gh, ['--subject', 'feat(x): y']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(lines(r.out), [
      'ship: tokens skipped', 'ship: dod ok', T7, 'ship: release skipped', 'ship: commit ok',
      'ship: push ok', 'ship: pr ok', 'ship: merge ok', 'ship: tag skipped',
    ]);
    assert.match(repo.git(['show', 'feat/sample:package.json']), /"version": "1.4.0"/);
    assert.equal(repo.git(['show', 'feat/sample:CHANGELOG.md']), '## [1.4.0] - 2026-01-01\n\n- old');
    assert.equal(repo.git(['tag', '--list']), '');
    assert.equal(readFj(repo).history.some((h) => h.phase === 'release'), false);
  } finally { repo.cleanup(); }

  ({ repo, gh } = mkRepo({ history: PASSING.filter((h) => h.phase !== 'review') }));
  try {
    const headBefore = repo.git(['rev-parse', 'HEAD']);
    const r = await ship(repo, gh, ['--release', 'minor', '--subject', 'feat: z']);
    assert.equal(r.code, 1);
    assert.match(r.err, /! DOD-GATE FAILED: review last status = MISSING/);
    assert.equal(repo.git(['rev-parse', 'HEAD']), headBefore);
    assert.equal(readFile(repo, 'package.json').includes('1.4.0'), true);
    assert.deepEqual(lines(r.out), ['ship: tokens skipped', T6]);
    assert.equal(gh.calls().length, 0);
  } finally { repo.cleanup(); }
});

test('usage errors exit 2 before any step; notes-file inside neither repo nor temp is refused', T, async () => {
  const { repo, gh } = mkRepo();
  try {
    for (const argv of [
      ['--release', 'huge', '--subject', 'x'],
      ['--release', 'minor'],
      ['--notes-file', 'n.md'],
      ['--release', 'minor', '--notes-file', '/etc/hosts'],
    ]) {
      const r = await ship(repo, gh, argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.equal(lines(r.out).length, 0);
    }
    assert.equal(repo.git(['status', '--porcelain']).includes('package.json'), false);
  } finally { repo.cleanup(); }
});

test('F9: --release auto reads the --body BREAKING CHANGE footer and branch commit bodies; needs --subject', T, async () => {
  let { repo, gh, mergeSha } = mkRepo();
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'auto', '--subject', 'feat(x): y', '--body', 'why\n\nBREAKING CHANGE: api removed']);
    assert.equal(r.code, 0, r.err);
    assert.match(repo.git(['show', 'feat/sample:package.json']), /"version": "2.0.0"/);
  } finally { repo.cleanup(); }

  // a breaking footer in an earlier branch commit body
  ({ repo, gh, mergeSha } = mkRepo());
  try {
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'feat(x): early', '-m', 'BREAKING CHANGE: gone']);
    repo.write('src/more.js', 'export const more = 1;\n');
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'auto', '--subject', 'fix(x): later']);
    assert.equal(r.code, 0, r.err);
    assert.match(repo.git(['show', 'feat/sample:package.json']), /"version": "2.0.0"/);
  } finally { repo.cleanup(); }

  ({ repo, gh } = mkRepo());
  try {
    const notes = path.join(repo.tmpDir(), 'n.md');
    fs.writeFileSync(notes, '- thing\n');
    const r = await ship(repo, gh, ['--release', 'auto', '--notes-file', notes]);
    assert.equal(r.code, 2);
  } finally { repo.cleanup(); }
});

test('F10: ship forwards --trailer, --closes, --scope to the commit and --body-footer to the PR', T, async () => {
  const { repo, gh, mergeSha } = mkRepo();
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const capture = path.join(repo.tmpDir(), 'body-copy.md');
    const wrapper = path.join(repo.tmpDir(), 'gh-capture');
    fs.writeFileSync(wrapper, [
      '#!/bin/sh', 'prev=""',
      'for a in "$@"; do if [ "$prev" = "--body-file" ]; then cp "$a" ' + JSON.stringify(capture) + '; fi; prev="$a"; done',
      `exec ${JSON.stringify(gh.bin)} "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    const r = await ship(repo, gh, ['--subject', 'fix: y', '--scope', 'api', '--closes', '12,13',
      '--trailer', 'Co-Authored-By: A <a@x.io>', '--trailer', 'Reviewed-by: B <b@x.io>', '--body-footer', 'FOOTER-TEXT'], { DEV_CYCLE_GH: wrapper });
    assert.equal(r.code, 0, r.err);
    const msg = repo.git(['log', '-1', '--format=%B', 'feat/sample']);
    assert.match(msg, /^fix: y/); // --scope is forwarded (an explicit subject is kept as given)
    assert.match(msg, /Co-Authored-By: A <a@x\.io>/);
    assert.match(msg, /Reviewed-by: B <b@x\.io>/);
    assert.match(msg, /Closes #12\nCloses #13/);
    assert.match(fs.readFileSync(capture, 'utf8'), /FOOTER-TEXT/);
  } finally { repo.cleanup(); }
});

test('#43: --release prefixes a non-conventional subject with feat/fix and (--scope)', T, async () => {
  const { releaseSubject } = await import('../plugin/scripts/lib/cmd-ship.mjs');
  assert.equal(releaseSubject('add widget', 'minor', 'scripts'), 'feat(scripts): add widget');
  assert.equal(releaseSubject('add widget', 'major', undefined), 'feat: add widget');
  assert.equal(releaseSubject('tidy', 'patch', 'cli'), 'fix(cli): tidy');
  assert.equal(releaseSubject('tidy', 'auto', undefined, '', '1.4.0'), 'fix: tidy');
  assert.equal(releaseSubject('feat(x)!: y', 'patch', 'z'), 'feat(x)!: y');
  assert.equal(releaseSubject('docs: y', 'minor', 'z'), 'docs: y');

  const { repo, gh, mergeSha } = mkRepo();
  try {
    gh.setRules([mergeRule(mergeSha())]);
    const r = await ship(repo, gh, ['--release', 'minor', '--subject', 'add widget', '--scope', 'scripts']);
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.git(['log', '-1', '--format=%s', 'feat/sample']), 'feat(scripts): add widget');
    assert.ok(repo.git(['show', 'feat/sample:CHANGELOG.md']).includes('### Added\n\n- feat(scripts): add widget'));
  } finally { repo.cleanup(); }
});

test('AC8: ship --json carries tokens when dod ran, success or failure', T, async () => {
  let { repo, gh } = mkRepo();
  try {
    const r = await ship(repo, gh, ['--json', '--subject', 'feat: z']);
    assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()).tokens, { measured: 0, estimated: 7 });
  } finally { repo.cleanup(); }
  ({ repo, gh } = mkRepo({ history: PASSING.filter((h) => h.phase !== 'review') }));
  try {
    const r = await ship(repo, gh, ['--json', '--subject', 'feat: z']);
    assert.equal(r.code, 1);
    assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()).tokens, { measured: 0, estimated: 6 });
  } finally { repo.cleanup(); }
});
