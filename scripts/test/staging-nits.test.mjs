// Review nits from the #7 fix: staged never_stage files are unstaged; dot-aware glob matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sampleFeatureJson } from './helpers.mjs';
import { installSpawnRecorder, mkGitRepo } from './git-helpers.mjs';
import { run as gitRunCmd } from '../lib/cmd-git.mjs';
import { CliError } from '../lib/core.mjs';

const T = { timeout: 60_000 };
const plan = (touches) => `---\nfeature: s\nstatus: [TODO]\n---\n\n# S — Plan\n\n## Tasks\n- [IMPL-DONE] **Task 1** (backend): Do it\n\n## Execution plan\n\n### Task 1: Do it  \`[IMPL-DONE]\`\n**Tag:** backend\n**Touches:** ${touches}\n`;

function mkRepo(never) {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'bugfix' }), files: { 'plan.md': plan('`src/**`') } });
  repo.write('.dev-cycle/project.json', JSON.stringify({ git: { never_stage: never } }));
  repo.write('src/keep.js', 'old\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'seed']);
  repo.git(['checkout', '-q', '-b', 'fix/x']);
  return repo;
}
async function commit(repo, argv = []) {
  const ctx = repo.ctx();
  const rec = installSpawnRecorder();
  try {
    let code; let extra = '';
    try { code = await gitRunCmd(['commit', '--subject', 'fix(x): y', ...argv], ctx); } catch (e) {
      if (!(e instanceof CliError)) throw e;
      code = e.exitCode; extra = e.message;
    }
    return { code, err: ctx.err() + extra };
  } finally { rec.restore(); }
}
const committed = (repo) => repo.git(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
const read = (repo, p) => fs.readFileSync(path.join(repo.root, p), 'utf8');

for (const argv of [[], ['--include-untracked']]) {
  test(`staged never_stage files are unstaged, worktree intact (${argv.join('') || 'default'})`, T, async () => {
    const repo = mkRepo(['src/keep.js', 'src/wip/**']);
    try {
      repo.write('src/keep.js', 'changed\n');
      repo.write('src/wip/new.js', 'wip\n');
      repo.write('src/ok.js', 'ok\n');
      repo.git(['add', 'src/keep.js', 'src/wip/new.js']);
      const r = await commit(repo, argv);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(committed(repo).filter((f) => f.startsWith('src/')), ['src/ok.js']);
      assert.match(r.err, /2 staged files matching git\.never_stage were unstaged/);
      assert.equal(read(repo, 'src/keep.js'), 'changed\n');
      assert.equal(read(repo, 'src/wip/new.js'), 'wip\n');
    } finally { repo.cleanup(); }
  });
}

test('maskDots false match: glob src/_x does not match src/.x', T, async () => {
  const repo = mkRepo(['src/_x']);
  try {
    repo.write('src/.x', 'dot\n');
    repo.write('src/_x', 'under\n');
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(committed(repo).filter((f) => f.startsWith('src/')), ['src/.x']);
  } finally { repo.cleanup(); }
});

test('Touches src/_x does not cover untracked src/.x', T, async () => {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'bugfix' }), files: { 'plan.md': plan('`src/_x`') } });
  try {
    repo.git(['checkout', '-q', '-b', 'fix/x']);
    repo.write('src/.x', 'dot\n');
    repo.write('src/_x', 'under\n');
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    assert.ok(committed(repo).includes('src/_x') && !committed(repo).includes('src/.x'), committed(repo).join());
  } finally { repo.cleanup(); }
});

// ---- auto-tester additions: coverage gaps ----
const srcFiles = (repo) => committed(repo).filter((f) => !f.startsWith('docs/') && !f.startsWith('.dev-cycle/'));
const staged = (repo) => repo.git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);

test('unborn HEAD: staged new never_stage file is unstaged, worktree intact', T, async () => {
  const repo = mkRepo(['src/wip/**']);
  try {
    repo.git(['checkout', '-q', '--orphan', 'fix/unborn']);
    repo.git(['rm', '-rq', '--cached', '.']);
    assert.throws(() => repo.git(['rev-parse', '--verify', '-q', 'HEAD']));
    repo.write('src/wip/new.js', 'wip\n');
    repo.write('src/ok.js', 'ok\n');
    repo.git(['add', 'src/wip/new.js']);
    const r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /1 staged files matching git\.never_stage were unstaged/);
    assert.ok(srcFiles(repo).includes('src/ok.js'), srcFiles(repo).join());
    assert.ok(!srcFiles(repo).includes('src/wip/new.js'));
    assert.equal(read(repo, 'src/wip/new.js'), 'wip\n');
  } finally { repo.cleanup(); }
});

test('staged rename into a never_stage path is not committed', T, async () => {
  const repo = mkRepo(['secret/**']);
  try {
    repo.write('secret/.keep', ''); // ensure dir exists on disk
    repo.git(['mv', 'src/keep.js', 'secret/keep.js']);
    repo.write('src/ok.js', 'ok\n');
    const r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!committed(repo).includes('secret/keep.js'), committed(repo).join());
    assert.ok(!committed(repo).includes('secret/.keep'));
    assert.equal(read(repo, 'secret/keep.js'), 'old\n');
  } finally { repo.cleanup(); }
});

test('never_stage path with spaces and a leading dash is unstaged (literal pathspec)', T, async () => {
  const repo = mkRepo(['src/-my secret.txt', 'src/sp ace/**']);
  try {
    repo.write('src/-my secret.txt', 's\n');
    repo.write('src/sp ace/a.txt', 's\n');
    repo.write('src/ok.js', 'ok\n');
    repo.git(['add', '--', 'src/-my secret.txt', 'src/sp ace/a.txt']);
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(srcFiles(repo).filter((f) => f.startsWith('src/')), ['src/ok.js']);
    assert.equal(read(repo, 'src/-my secret.txt'), 's\n');
    assert.deepEqual(staged(repo), []);
  } finally { repo.cleanup(); }
});

// regex metacharacters in globs: each case is [glob, tracked-and-matching file, file that must NOT match]
for (const [glob, hit, miss] of [
  ['a+b/**', 'a+b/f.js', 'aab/f.js'],
  ['x(1).txt', 'src/x(1).txt'.replace('src/', ''), 'x1.txt'],
  ['[ab]', 'a', 'ab'],
  ['src/f.js', 'src/f.js', 'src/fxjs'],
  ['src/a|b', 'src/a|b', 'src/a'],
  ['src/v$1', 'src/v$1', 'src/v'],
  ['src/a^b', 'src/a^b', 'src/ab'],
]) {
  test(`glob metacharacters are literal / glob-semantic: ${glob}`, T, async () => {
    const repo = mkRepo([glob]);
    try {
      repo.write(hit, 'h\n');
      repo.write(miss, 'm\n');
      const r = await commit(repo, ['--include-untracked']);
      assert.equal(r.code, 0, r.err);
      const files = committed(repo);
      assert.ok(!files.includes(hit), `${hit} should be blocked; committed: ${files.join()}`);
      assert.ok(files.includes(miss), `${miss} should be committed; committed: ${files.join()}`);
    } finally { repo.cleanup(); }
  });
}

test('plain paths without dots behave as before (exact, dir/, dir/**, no partial match)', T, async () => {
  const repo = mkRepo(['src/secret', 'priv/', 'out/**']);
  try {
    for (const f of ['src/secret', 'src/secret2', 'priv/a/b', 'out/x/y', 'outer/z', 'src/ok.js']) repo.write(f, 'x\n');
    const r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    for (const f of ['src/secret', 'priv/a/b', 'out/x/y']) assert.ok(!files.includes(f), `${f} blocked: ${files.join()}`);
    for (const f of ['src/secret2', 'outer/z', 'src/ok.js']) assert.ok(files.includes(f), `${f} committed: ${files.join()}`);
  } finally { repo.cleanup(); }
});

test('secret/**, cfg/ and src/** still match dot-files', T, async () => {
  const repo = mkRepo(['secret/**', 'cfg/', '.env*']);
  try {
    for (const f of ['secret/.k', 'secret/.d/.e', 'cfg/.hidden', '.env.local', 'src/.ok']) repo.write(f, 'x\n');
    const r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    for (const f of ['secret/.k', 'secret/.d/.e', 'cfg/.hidden', '.env.local']) assert.ok(!files.includes(f), `${f} blocked: ${files.join()}`);
    assert.ok(files.includes('src/.ok'), files.join());
  } finally { repo.cleanup(); }
});

// ---- review cycle 1 fixes ----
import { globMatch } from '../lib/git-commit.mjs';

test('F1: unborn HEAD, staged then edited never_stage file (AM) is unstaged without aborting', T, async () => {
  const repo = mkRepo(['src/wip/**']);
  try {
    repo.git(['checkout', '-q', '--orphan', 'fix/unborn2']);
    repo.git(['rm', '-rq', '--cached', '.']);
    repo.write('src/wip/é b.js', 'v1\n');
    repo.git(['add', '--', 'src/wip/é b.js']);
    repo.write('src/wip/é b.js', 'v2\n');
    repo.write('src/ok.js', 'ok\n');
    const r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 0, r.err);
    assert.ok(!srcFiles(repo).some((f) => f.includes('wip')), srcFiles(repo).join());
    assert.equal(read(repo, 'src/wip/é b.js'), 'v2\n');
  } finally { repo.cleanup(); }
});

test('F2: no "unstaged" note when the commit fails before unstaging (untracked-large)', T, async () => {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'bugfix' }) });
  try {
    repo.write('.dev-cycle/project.json', JSON.stringify({ git: { never_stage: ['src/keep.js'] } }));
    repo.write('src/keep.js', 'old\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'seed']);
    repo.git(['checkout', '-q', '-b', 'fix/x']);
    repo.write('src/keep.js', 'changed\n');
    repo.git(['add', 'src/keep.js']);
    for (let i = 0; i < 25; i++) repo.write(`media/f${i}.bin`, 'x\n');
    const r = await commit(repo);
    assert.equal(r.code, 1);
    assert.match(r.err, /untracked-large/);
    assert.doesNotMatch(r.err, /were unstaged/);
    assert.deepEqual(staged(repo), ['src/keep.js']);
  } finally { repo.cleanup(); }
});

test('F3: a hook failure restores the original staging of unstaged never_stage paths', T, async () => {
  const repo = mkRepo(['src/keep.js']);
  try {
    repo.write('src/keep.js', 'staged-v1\n');
    repo.git(['add', 'src/keep.js']);
    repo.write('src/keep.js', 'worktree-v2\n');
    repo.write('src/ok.js', 'ok\n');
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = await commit(repo, ['--include-untracked']);
    assert.equal(r.code, 1);
    assert.match(r.err, /hook-failed/);
    assert.ok(staged(repo).includes('src/keep.js'));
    assert.equal(repo.git(['show', ':src/keep.js']), 'staged-v1');
    assert.equal(read(repo, 'src/keep.js'), 'worktree-v2\n');
  } finally { repo.cleanup(); }
});

test('F4: glob edge cases', () => {
  assert.equal(globMatch('a]b', 'a[]]b'), true);
  assert.equal(globMatch('a/b', 'a[!b]b'), false);
  assert.equal(globMatch('a/b', 'a[x/]b'), false);
  assert.equal(globMatch('acb', 'a[!b]b'), true);
  assert.equal(globMatch('a{b', 'a{b'), true);
  assert.equal(globMatch('a}b', 'a}b'), true);
  assert.equal(globMatch('a,b', 'a,b'), true);
  assert.equal(globMatch('x/y.ts', 'x/{y,z}.{ts,js}'), true);
  assert.equal(globMatch('src/.x', 'src/_x'), false);
});

test('F5: many consecutive ** do not backtrack catastrophically', () => {
  const t0 = Date.now();
  const glob = `${'**/'.repeat(14)}zzz`;
  assert.equal(globMatch(Array.from({ length: 30 }, (_, i) => `d${i}`).join('/') + '/nope', glob), false);
  assert.equal(globMatch('a/b/zzz', glob), true);
  assert.ok(Date.now() - t0 < 2000);
});

test('F6: rename out of a never_stage path: new side committed, old side stays tracked', T, async () => {
  const repo = mkRepo(['src/keep.js']);
  try {
    repo.git(['mv', 'src/keep.js', 'src/moved.js']);
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    assert.ok(committed(repo).includes('src/moved.js') && !committed(repo).includes('src/keep.js'), committed(repo).join());
    assert.equal(repo.git(['ls-tree', '--name-only', 'HEAD', 'src/keep.js']), 'src/keep.js');
    assert.equal(read(repo, 'src/moved.js'), 'old\n');
  } finally { repo.cleanup(); }
});

// ---- review cycle 2 fixes ----
import { setSpawn } from '../lib/git-exec.mjs';
import { spawn as nodeSpawn } from 'node:child_process';

test('c2-F2: braces inside a bracket class are literal members', () => {
  assert.equal(globMatch('a{', 'a[{]'), true);
  assert.equal(globMatch('a}', 'a[{]}'), false);
  assert.equal(globMatch('a{}', 'a[{]}'), true);
  assert.equal(globMatch('x/y.ts', 'x/{y,z}.[tj]s'), true);
});

test('c2-F1: a failing later unstage chunk still restores the earlier chunks', T, async () => {
  const repo = mkRepo(['wip/**']);
  try {
    const names = Array.from({ length: 201 }, (_, i) => `wip/f${String(i).padStart(3, '0')}.txt`);
    for (const n of names) repo.write(n, 'x\n');
    repo.git(['add', '--', 'wip']);
    repo.write('src/ok.js', 'ok\n');
    const ctx = repo.ctx();
    const prev = setSpawn((cmd, args, o) => (cmd === 'git' && args[0] === 'reset' && args.includes(names[200])
      ? nodeSpawn('git', ['reset', '--no-such-flag'], o)
      : nodeSpawn(cmd, args, o)));
    let failed = false;
    try { await gitRunCmd(['commit', '--subject', 'fix(x): y', '--include-untracked'], ctx); } catch { failed = true; } finally { setSpawn(prev); }
    assert.ok(failed);
    assert.equal(staged(repo).filter((f) => f.startsWith('wip/')).length, 201);
  } finally { repo.cleanup(); }
});
