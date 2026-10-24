// GitHub #7: git commit / ship stage only what belongs to the feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkCtx, sampleFeatureJson, DEFAULT_FEATURE } from './helpers.mjs';
import { gitSync, gitTestEnv, installSpawnRecorder, mkGhStub, mkGitRepo } from './git-helpers.mjs';
import { run as gitRunCmd } from '../lib/cmd-git.mjs';
import { run as shipRun } from '../lib/cmd-ship.mjs';
import { CliError } from '../lib/core.mjs';
import { validateProfile } from '../lib/profile.mjs';
import { insertChangelog, unreleasedHasEntries } from '../lib/release.mjs';

const T = { timeout: 60_000 };
const plan = (touches) => `---\nfeature: s\nstatus: [TODO]\n---\n\n# S — Plan\n\n## Tasks\n- [IMPL-DONE] **Task 1** (backend): Do it\n\n## Execution plan\n\n### Task 1: Do it  \`[IMPL-DONE]\`\n**Tag:** backend\n**Touches:** ${touches}\n`;

function mkRepo({ touches = '`src/**`', over = {}, profile = null, withPlan = true } = {}) {
  const files = withPlan ? { 'plan.md': plan(touches) } : {};
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'bugfix', ...over }), files });
  if (profile) repo.write('.dev-cycle/project.json', JSON.stringify(profile));
  repo.write('src/keep.js', 'old\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'seed']);
  repo.git(['checkout', '-q', '-b', 'fix/x']);
  return repo;
}

async function commit(repo, argv) {
  const ctx = repo.ctx();
  const rec = installSpawnRecorder();
  try {
    let code;
    let extra = '';
    try { code = await gitRunCmd(['commit', '--subject', 'fix(x): y', ...argv], ctx); } catch (e) {
      if (!(e instanceof CliError)) throw e;
      code = e.exitCode; extra = e.message;
    }
    return { code, err: ctx.err() + extra };
  } finally { rec.restore(); }
}
const staged = (repo) => repo.git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const committed = (repo) => repo.git(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);

test('profile git.never_stage is validated', () => {
  const v = (g) => validateProfile({ git: g }, { skills: [] }).errors;
  assert.deepEqual(v({ never_stage: ['raw/**', 'app.json'] }), []);
  assert.match(v({ never_stage: 'x' }).join(), /array of strings/);
  assert.match(v({ never_stage: ['../x'] }).join(), /never_stage\[0\]/);
  assert.match(v({ never_stage: ['/abs'] }).join(), /never_stage\[0\]/);
  assert.match(v({ nope: 1 }).join(), /unknown key 'nope'/);
  assert.match(v([]).join(), /git must be an object/);
});

test('untracked files outside Touches are left out; tracked changes and never_stage honoured', T, async () => {
  const repo = mkRepo({ profile: { git: { never_stage: ['src/secret-wip/**', 'src/keep.js'] } } });
  try {
    repo.write('src/new.js', 'n\n');                 // untracked in Touches: staged
    repo.write('raw/gen1.png', 'p\n');               // untracked outside Touches: left out
    repo.write('app.json', '{}\n');                  // untracked outside Touches: left out
    repo.write('src/secret-wip/a.txt', 'a\n');       // never_stage
    repo.write('src/keep.js', 'changed\n');          // tracked-modified but never_stage
    repo.write('README.md', 'tracked outside touches\n');
    repo.git(['add', 'README.md']); repo.git(['commit', '-q', '-m', 'readme']);
    repo.write('README.md', 'modified\n');           // tracked modification outside Touches: staged
    const r = await commit(repo, []);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    assert.ok(files.includes('src/new.js') && files.includes('README.md'), files.join());
    assert.ok(!files.some((f) => f.startsWith('raw/') || f === 'app.json' || f.includes('secret-wip') || f === 'src/keep.js'), files.join());
    assert.match(r.err, /2 untracked files outside Touches were left out \(use --include-untracked to add\)/);
    assert.match(r.err, /raw\/ \(1 file/);
    assert.match(r.err, /2 path\(s\) matching git\.never_stage were not staged/);
    assert.match(repo.git(['status', '--porcelain']), /\?\? raw\//);
  } finally { repo.cleanup(); }
});

test('areas[].touches count as Touches; --include-untracked restores old behaviour minus never_stage + secret guard', T, async () => {
  const repo = mkRepo({ withPlan: false, over: { areas: [{ name: 'a', touches: ['lib/**'] }] }, profile: { git: { never_stage: ['big/**'] } } });
  try {
    repo.write('lib/x.js', 'x\n'); repo.write('other/y.txt', 'y\n'); repo.write('big/z.bin', 'z\n');
    let r = await commit(repo, []);
    assert.equal(r.code, 0, r.err);
    assert.ok(committed(repo).includes('lib/x.js') && !committed(repo).includes('other/y.txt'));
    repo.write('later/w.txt', 'w\n');
    repo.write('.env', 'K=1\n');
    r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 1);
    assert.match(r.err, /secret-like-file/);
    assert.deepEqual(staged(repo), []);
    fs.rmSync(path.join(repo.root, '.env'));
    r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    assert.ok(files.includes('later/w.txt') && files.includes('other/y.txt') && !files.includes('big/z.bin'), files.join());
  } finally { repo.cleanup(); }
});

test('no Touches: more than 20 new untracked files → untracked-large, nothing staged or changed; <=20 are staged', T, async () => {
  const repo = mkRepo({ withPlan: false });
  try {
    for (let i = 0; i < 21; i++) repo.write(`gen/f${i}.txt`, `${i}\n`);
    repo.write('src/real.js', 'r\n');
    const fjBefore = fs.readFileSync(path.join(repo.featureDir, 'feature.json'));
    const head = repo.git(['rev-parse', 'HEAD']);
    let r = await commit(repo, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED untracked-large/);
    assert.match(r.err, /gen\/ \(21 files/);
    assert.deepEqual(staged(repo), []);
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
    assert.deepEqual(fs.readFileSync(path.join(repo.featureDir, 'feature.json')), fjBefore);
    r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    assert.equal(committed(repo).filter((f) => f.startsWith('gen/')).length, 21);
  } finally { repo.cleanup(); }
  const small = mkRepo({ withPlan: false });
  try {
    for (let i = 0; i < 20; i++) small.write(`gen/f${i}.txt`, 'x\n');
    const r = await commit(small, []);
    assert.equal(r.code, 0, r.err);
    assert.equal(committed(small).length, 20);
  } finally { small.cleanup(); }
});

test('no Touches: more than 10 MB of new untracked files → untracked-large', T, async () => {
  const repo = mkRepo({ withPlan: false });
  try {
    fs.mkdirSync(path.join(repo.root, 'media'));
    fs.writeFileSync(path.join(repo.root, 'media', 'big.bin'), Buffer.alloc(11 * 1024 * 1024));
    const r = await commit(repo, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /untracked-large/);
    assert.match(r.err, /media\/ \(1 file, 11\.0 MB\)/);
    assert.deepEqual(staged(repo), []);
  } finally { repo.cleanup(); }
});

test('project root below the git root: paths are normalised (L23)', T, async () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-sub-')));
  try {
    const env = gitTestEnv();
    const app = path.join(top, 'app');
    const fdir = path.join(app, 'docs', 'features', DEFAULT_FEATURE);
    fs.mkdirSync(fdir, { recursive: true });
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fdir, 'feature.json'), JSON.stringify(sampleFeatureJson({ flow: 'bugfix' })));
    fs.writeFileSync(path.join(fdir, 'plan.md'), plan('`src/**`'));
    fs.mkdirSync(path.join(app, '.dev-cycle'));
    fs.writeFileSync(path.join(app, '.dev-cycle', 'project.json'), JSON.stringify({ git: { never_stage: ['src/nope.js'] } }));
    fs.writeFileSync(path.join(app, 'src', 'nope.js'), 'old\n');
    const g = (a) => gitSync(top, a, env);
    g(['init', '-q', '-b', 'main']); g(['config', 'commit.gpgsign', 'false']); g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
    g(['checkout', '-q', '-b', 'fix/x']);
    fs.writeFileSync(path.join(app, 'src', 'in.js'), 'i\n');
    fs.writeFileSync(path.join(app, 'src', 'nope.js'), 'changed\n');
    fs.mkdirSync(path.join(app, 'raw'));
    fs.writeFileSync(path.join(app, 'raw', 'o.png'), 'o\n');
    fs.writeFileSync(path.join(top, 'outside.txt'), 'o\n');
    const ctx = mkCtx({ cwd: app, env });
    assert.equal(await gitRunCmd(['commit', '--subject', 'fix(x): y'], ctx), 0, ctx.err());
    const files = g(['show', '--name-only', '--format=', 'HEAD']).split('\n');
    assert.ok(files.includes('app/src/in.js'), files.join());
    assert.ok(!files.includes('app/raw/o.png') && !files.includes('outside.txt') && !files.includes('app/src/nope.js'), files.join());
    assert.match(ctx.err(), /2 untracked files outside Touches/);
    assert.match(ctx.err(), /1 path\(s\) matching git\.never_stage/);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

// --- ship: --include-untracked, CHANGELOG duplicate ----------------------------

const PASSING = [
  { phase: 'spec', status: 'DONE' }, { phase: 'plan', status: 'DONE' }, { phase: 'implement.task=1', status: 'DONE' },
  { phase: 'static-check', status: 'PASSED' }, { phase: 'review', status: 'APPROVED' },
  { phase: 'auto-test', status: 'PASSED' }, { phase: 'security', status: 'APPROVED' },
];

function mkShipRepo(changelog) {
  const repo = mkGitRepo({
    featureJson: sampleFeatureJson({ history: PASSING, branch: 'feat/sample' }),
    files: { 'spec.md': '# S — Spec\n\n## 1. Problem & Goal\n\nP.\n', 'plan.md': plan('`src/**`') },
  });
  repo.write('package.json', '{\n  "name": "x",\n  "version": "1.4.0"\n}\n');
  repo.write('CHANGELOG.md', changelog);
  repo.git(['add', '-A']); repo.git(['commit', '-q', '-m', 'chore: manifests']); repo.git(['push', '-q', 'origin', 'main']);
  repo.git(['checkout', '-q', '-b', 'feat/sample']);
  repo.write('src/widget.js', 'export const fast = true;\n');
  repo.write('owner/raw.bin', 'wip\n');
  const gh = mkGhStub(repo.tmpDir(), []);
  gh.setRules([{ match: 'pr view feat/sample --json mergeCommit', stdout: JSON.stringify({ mergeCommit: { oid: repo.git(['rev-parse', 'main']) } }) }]);
  return { repo, gh };
}

async function ship(repo, gh, argv) {
  const ctx = repo.ctx({ ...gh.env, CLAUDE_CODE_SESSION_ID: '' });
  const rec = installSpawnRecorder();
  try {
    const code = await shipRun(argv, ctx);
    return { code, out: ctx.out(), err: ctx.err() };
  } finally { rec.restore(); }
}

test('ship leaves untracked owner files out and still completes; Unreleased entries are promoted without a duplicate bullet', T, async () => {
  const { repo, gh } = mkShipRepo('# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- the detailed bullet (#7)\n\n## [1.4.0] - 2026-01-01\n\n- old\n');
  try {
    const r = await ship(repo, gh, ['--release', 'patch', '--subject', 'fix(x): short subject']);
    assert.equal(r.code, 0, r.err);
    const files = repo.git(['show', '--name-only', '--format=', 'feat/sample']).split('\n');
    assert.ok(files.includes('src/widget.js') && !files.includes('owner/raw.bin'), files.join());
    const cl = repo.git(['show', 'feat/sample:CHANGELOG.md']);
    assert.ok(cl.includes('## [1.4.1]') && cl.includes('- the detailed bullet (#7)'), cl);
    assert.ok(!cl.includes('short subject'), cl);
    assert.equal((cl.match(/### Fixed/g) ?? []).length, 1);
    assert.equal(fs.readFileSync(path.join(repo.root, 'owner', 'raw.bin'), 'utf8'), 'wip\n');
  } finally { repo.cleanup(); }
});

test('ship with an empty Unreleased still adds the subject bullet; --include-untracked adds owner files', T, async () => {
  const { repo, gh } = mkShipRepo('# Changelog\n\n## [Unreleased]\n\n## [1.4.0] - 2026-01-01\n\n- old\n');
  try {
    const r = await ship(repo, gh, ['--release', 'patch', '--subject', 'fix(x): short subject', '--include-untracked']);
    assert.equal(r.code, 0, r.err);
    assert.ok(repo.git(['show', '--name-only', '--format=', 'feat/sample']).split('\n').includes('owner/raw.bin'));
    const cl = repo.git(['show', 'feat/sample:CHANGELOG.md']);
    assert.match(cl, /## \[1\.4\.1\][^\n]*\n\n### Fixed\n\n- fix\(x\): short subject\n/);
  } finally { repo.cleanup(); }
});

test('unreleasedHasEntries / insertChangelog with empty notes', () => {
  assert.equal(unreleasedHasEntries('## [Unreleased]\n\n### Fixed\n\n- a\n\n## [1.0.0]\n'), true);
  assert.equal(unreleasedHasEntries('## [Unreleased]\n\n## [1.0.0]\n- a\n'), false);
  assert.equal(unreleasedHasEntries('## [1.0.0]\n- a\n'), false);
  assert.equal(unreleasedHasEntries(null), false);
  const out = insertChangelog('## [Unreleased]\n\n### Fixed\n\n- a\n\n## [1.0.0]\n\n- o\n', '1.0.1', '2026-01-01', '');
  assert.equal(out, '## [1.0.1] — 2026-01-01\n\n### Fixed\n\n- a\n\n## [1.0.0]\n\n- o\n');
});

// --- git-guard ------------------------------------------------------------------

test('git-guard denies subagent index-changing git (add, stage, rm --cached); orchestrator unaffected', () => {
  const guard = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'git-guard.mjs');
  const runGuard = (command, agent = 'a') => spawnSync('node', [guard], {
    input: JSON.stringify({ ...(agent ? { agent_id: agent } : {}), tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
  });
  for (const c of ['git add -A', 'git add src/x.js', 'git stage .', 'git rm --cached f', 'cd x && git add .', 'git -C /r add -u']) {
    assert.match(runGuard(c).stdout, /deny/, c);
  }
  for (const c of ['git rm f', 'git status', 'git diff --cached']) assert.equal(runGuard(c).stdout, '', c);
  assert.equal(runGuard('git add -A', null).stdout, '', 'orchestrator (no agent_id) is unaffected');
});

test('F1: already-staged deletions (git rm / git mv) do not break staging and still count as changes', T, async () => {
  const repo = mkRepo();
  try {
    repo.write('src/a.js', 'a\n'); repo.write('src/b.js', 'b\n');
    repo.git(['add', '-A']); repo.git(['commit', '-q', '-m', 'more']);
    repo.git(['rm', '-q', 'src/a.js']);
    repo.git(['mv', 'src/b.js', 'src/c.js']);
    const r = await commit(repo, []);
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.git(['ls-tree', '-r', '--name-only', 'HEAD', 'src']).split('\n').sort().join(), 'src/c.js,src/keep.js');
  } finally { repo.cleanup(); }
});

test('F2/F4: never_stage and Touches match dot-files; left-out note shows sizes', T, async () => {
  const repo = mkRepo({ profile: { git: { never_stage: ['secret/**', 'cfg/'] } } });
  try {
    repo.write('secret/.tok', 't\n'); repo.write('secret/ok.txt', 'o\n'); repo.write('cfg/.local', 'l\n');
    repo.write('src/.eslintrc.json', '{}\n');
    repo.write('raw/x.bin', 'x'.repeat(2048));
    const r = await commit(repo, []);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(committed(repo), ['src/.eslintrc.json']);
    assert.match(r.err, /3 path\(s\) matching git\.never_stage/);
    assert.match(r.err, /raw\/ \(1 file, 2 KB\)/);
  } finally { repo.cleanup(); }
});

test('F7: a secret-like file inside Touches still fails secret-like-file on the default path', T, async () => {
  const repo = mkRepo({ touches: '`src/**`' });
  try {
    repo.write('src/server.pem', 'k\n');
    const r = await commit(repo, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /secret-like-file/);
    assert.deepEqual(staged(repo), []);
  } finally { repo.cleanup(); }
});
