// GitHub #7 edge cases: staging scope for git commit + git-guard variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sampleFeatureJson } from './helpers.mjs';
import { installSpawnRecorder, mkGitRepo } from './git-helpers.mjs';
import { run as gitRunCmd } from '../lib/cmd-git.mjs';
import { CliError } from '../lib/core.mjs';

const T = { timeout: 60_000 };
const plan = (touches) => `---\nfeature: s\nstatus: [TODO]\n---\n\n# S — Plan\n\n## Tasks\n- [IMPL-DONE] **Task 1** (backend): Do it\n\n## Execution plan\n\n### Task 1: Do it  \`[IMPL-DONE]\`\n**Tag:** backend\n**Touches:** ${touches}\n`;

function mkRepo({ touches, seed = {} } = {}) {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ flow: 'bugfix' }), files: touches ? { 'plan.md': plan(touches) } : {} });
  repo.write('src/keep.js', 'old\n');
  for (const [f, c] of Object.entries(seed)) repo.write(f, c);
  repo.git(['add', '-A']); repo.git(['commit', '-q', '-m', 'seed']);
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
const committed = (repo) => repo.git(['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', '--no-renames', 'HEAD']).split('\n').filter(Boolean);
const snapshot = (root) => {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (n === '.git') continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(root, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
};

test('untracked file with spaces / unicode in name: staged inside Touches, left out outside', T, async () => {
  const repo = mkRepo({ touches: '`src/**`' });
  try {
    repo.write('src/my file é日本.js', 'a\n');
    repo.write('other dir/naïve файл.txt', 'b\n');
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    assert.ok(files.some((f) => f.includes('my file') && f.includes('日本')), files.join());
    assert.ok(!files.some((f) => f.includes('other dir') || f.includes('naïve')), files.join());
    assert.match(r.err, /1 untracked files outside Touches/);
    assert.match(repo.git(['-c', 'core.quotePath=false', 'status', '--porcelain']), /\?\? "?other dir\//);
  } finally { repo.cleanup(); }
});

test('Touches glob containing a space matches an untracked file', T, async () => {
  const repo = mkRepo({ touches: '`my dir/**`' });
  try {
    repo.write('my dir/ünï.js', 'a\n');
    repo.write('raw/x.png', 'b\n');
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    assert.ok(files.some((f) => f.includes('my dir')), files.join());
    assert.ok(!files.some((f) => f.startsWith('raw/')), files.join());
  } finally { repo.cleanup(); }
});

test('tracked file deleted outside Touches is staged as a deletion', T, async () => {
  const repo = mkRepo({ touches: '`src/**`', seed: { 'docs/old.md': 'x\n' } });
  try {
    fs.rmSync(path.join(repo.root, 'docs', 'old.md'));
    repo.write('src/new.js', 'n\n');
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    assert.ok(committed(repo).includes('docs/old.md'));
    assert.equal(repo.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('docs/old.md'), false);
  } finally { repo.cleanup(); }
});

test('rename: both sides staged inside Touches; rename into an outside path stages the deletion only', T, async () => {
  const repo = mkRepo({ touches: '`src/**`' });
  try {
    fs.renameSync(path.join(repo.root, 'src', 'keep.js'), path.join(repo.root, 'src', 'moved.js'));
    let r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    let files = committed(repo);
    assert.ok(files.includes('src/keep.js') && files.includes('src/moved.js'), files.join());

    fs.renameSync(path.join(repo.root, 'src', 'moved.js'), path.join(repo.root, 'outside.js'));
    repo.write('src/other.js', 'o\n');
    r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    files = committed(repo);
    assert.ok(files.includes('src/moved.js') && files.includes('src/other.js') && !files.includes('outside.js'), files.join());
    assert.match(repo.git(['status', '--porcelain']), /\?\? outside\.js/);
  } finally { repo.cleanup(); }
});

test('never_stage glob matching a tracked-modified file blocks it even when inside Touches; others still staged', T, async () => {
  const repo = mkRepo({ touches: '`src/**`' });
  try {
    repo.write('.dev-cycle/project.json', JSON.stringify({ git: { never_stage: ['src/*.js'] } }));
    repo.write('src/keep.js', 'changed\n');
    repo.write('src/sub/ok.ts', 'ok\n');
    const r = await commit(repo);
    assert.equal(r.code, 0, r.err);
    const files = committed(repo);
    assert.ok(!files.includes('src/keep.js') && files.includes('src/sub/ok.ts'), files.join());
    assert.match(repo.git(['status', '--porcelain']), /M src\/keep\.js/);
  } finally { repo.cleanup(); }
});

test('boundary: exactly 10 MB total passes, 10 MB + 1 byte is untracked-large (no Touches)', T, async () => {
  const MB10 = 10 * 1024 * 1024;
  const ok = mkRepo();
  try {
    ok.write('media/a.bin', 'x'); fs.writeFileSync(path.join(ok.root, 'media', 'a.bin'), Buffer.alloc(MB10));
    const r = await commit(ok);
    assert.equal(r.code, 0, r.err);
    assert.ok(committed(ok).includes('media/a.bin'));
  } finally { ok.cleanup(); }
  const big = mkRepo();
  try {
    fs.mkdirSync(path.join(big.root, 'media'));
    fs.writeFileSync(path.join(big.root, 'media', 'a.bin'), Buffer.alloc(MB10 - 5));
    fs.writeFileSync(path.join(big.root, 'media', 'b.bin'), Buffer.alloc(6));
    const r = await commit(big);
    assert.equal(r.code, 1);
    assert.match(r.err, /untracked-large/);
  } finally { big.cleanup(); }
});

test('exactly 20 files across many dirs passes; 21 with a tracked change refuses and tracked change is NOT staged', T, async () => {
  const repo = mkRepo();
  try {
    for (let i = 0; i < 21; i++) repo.write(`d${i % 3}/f${i}.txt`, 'x\n');
    repo.write('src/keep.js', 'changed\n');
    const r = await commit(repo);
    assert.equal(r.code, 1);
    assert.match(r.err, /untracked-large/);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
  } finally { repo.cleanup(); }
});

test('untracked-large leaves the working tree byte-identical and index untouched', T, async () => {
  const repo = mkRepo();
  try {
    for (let i = 0; i < 25; i++) repo.write(`gen/f${i}.txt`, `${i}\n`);
    repo.write('src/keep.js', 'modified\n');
    const before = snapshot(repo.root);
    const status = repo.git(['status', '--porcelain', '-uall']);
    const head = repo.git(['rev-parse', 'HEAD']);
    const r = await commit(repo);
    assert.equal(r.code, 1);
    assert.match(r.err, /untracked-large/);
    assert.deepEqual(snapshot(repo.root), before);
    assert.equal(repo.git(['status', '--porcelain', '-uall']), status);
    assert.equal(repo.git(['rev-parse', 'HEAD']), head);
  } finally { repo.cleanup(); }
});

test('git-guard denies subagent git add/commit variants', () => {
  const guard = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'git-guard.mjs');
  const runGuard = (command, agent = 'a') => spawnSync('node', [guard], {
    input: JSON.stringify({ ...(agent ? { agent_id: agent } : {}), tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
  });
  for (const c of [
    'git -C dir add .', 'git -C ../dir add -A', 'git commit -am "x"', 'git commit -a -m x', 'cd x && git add .',
    'cd x; git add .', 'true || git add .', 'git -c user.name=x add .', 'git --no-pager add -A', 'git stage -A',
    'git rm --cached -r dir', 'git rm -r --cached dir', 'echo hi | git add -A', '(git add .)', 'sh -c "git add ."',
  ]) assert.match(runGuard(c).stdout, /deny/, c);
  for (const c of ['git rm f', 'git rm -r dir', 'git status', 'git diff --cached', 'git -C dir status', 'git log --oneline', 'echo "git add ."']) {
    assert.equal(runGuard(c).stdout, '', c);
  }
  assert.equal(runGuard('git -C dir add .', null).stdout, '');
});
