import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const HOOK = path.join(REPO, 'scripts/session-start.sh');

function mkRepo(branch = 'feat/x') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-')));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', branch);
  g('commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
function addFeature(dir, name, fj) {
  const d = path.join(dir, 'docs/features', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'feature.json'), typeof fj === 'string' ? fj : JSON.stringify(fj));
  return d;
}
const run = (input) => spawnSync('bash', [HOOK], { encoding: 'utf8', input });
const ctxOf = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
};
const hintLine = (ctx) => ctx.split('\n').filter((l) => l.startsWith('dev-cycle: active feature'));
const base = ctxOf(run(''));

test('AC22: compact and resume append the hint as the last line', () => {
  const dir = mkRepo();
  try {
    const f = addFeature(dir, '2026-01-01-00h-00m-a', { branch: 'feat/x', current_phase: 'implement' });
    const want = `dev-cycle: active feature 2026-01-01-00h-00m-a (phase implement). Orchestrator: run node "${REPO}/scripts/dev-cycle.mjs" feature resume --feature "${fs.realpathSync(f)}" and continue from its next: lines.`;
    for (const source of ['compact', 'resume']) {
      const ctx = ctxOf(run(JSON.stringify({ source, cwd: dir })));
      assert.ok(ctx.startsWith(base.trimEnd()));
      assert.equal(ctx.split('\n').pop(), want);
    }
    assert.ok(want.replace(REPO, '').replace(fs.realpathSync(f), '').length <= 160 + 40);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AC23: no hint for non-matching situations, primer unchanged', () => {
  const dir = mkRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-plain-'));
  try {
    addFeature(dir, 'a-done', { branch: 'feat/x', current_phase: 'done' });
    addFeature(dir, 'b-other', { branch: 'feat/other', current_phase: 'implement' });
    addFeature(dir, 'c-bad', '{not json');
    const cases = [
      JSON.stringify({ source: 'startup', cwd: dir }),
      JSON.stringify({ source: 'clear', cwd: dir }),
      JSON.stringify({ source: 'compact', cwd: dir }),
      JSON.stringify({ source: 'compact', cwd: plain }),
      '', 'not json',
    ];
    for (const c of cases) {
      const ctx = ctxOf(run(c));
      assert.deepEqual(hintLine(ctx), [], c);
      assert.equal(ctx, base, c);
    }
    // no docs/features at all
    const bare = mkRepo();
    try {
      assert.equal(ctxOf(run(JSON.stringify({ source: 'compact', cwd: bare }))), base);
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('AC24: several matches pick the lexicographically newest folder', () => {
  const dir = mkRepo();
  try {
    addFeature(dir, '2026-01-01-00h-00m-a', { branch: 'feat/x', current_phase: 'implement' });
    addFeature(dir, '2026-02-01-00h-00m-b', { branch: 'feat/x', current_phase: 'review' });
    const h = hintLine(ctxOf(run(JSON.stringify({ source: 'compact', cwd: dir }))));
    assert.equal(h.length, 1);
    assert.match(h[0], /active feature 2026-02-01-00h-00m-b \(phase review\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AC25: hint is short; hook from a linked worktree falls back to the main root', () => {
  const dir = mkRepo();
  const wt = path.join(os.tmpdir(), `ssh-wt-${process.pid}`);
  try {
    addFeature(dir, '2026-01-01-00h-00m-f', { branch: 'feat/x', current_phase: 'implement' });
    const r = spawnSync('git', ['worktree', 'add', '-q', '-b', 'feat/x2', wt], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    addFeature(dir, '2026-01-01-00h-00m-g', { branch: 'feat/x2', current_phase: 'plan' });
    const h = hintLine(ctxOf(run(JSON.stringify({ source: 'compact', cwd: wt }))));
    assert.equal(h.length, 1);
    assert.match(h[0], /active feature 2026-01-01-00h-00m-g \(phase plan\)/);
    const bare = h[0].replace(REPO, '').replace(path.join(dir, 'docs/features/2026-01-01-00h-00m-g'), '').replace('2026-01-01-00h-00m-g', '');
    assert.ok(bare.length <= 160, `${bare.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('edge: branch name with shell metacharacters runs nothing and prints safely', () => {
  const branch = 'feat/a;b$(touch${IFS}PWNED)"q\'x`touch${IFS}PWNED`';
  const dir = mkRepo(branch);
  try {
    const f = addFeature(dir, '2026-01-01-00h-00m-m', { branch, current_phase: 'implement' });
    const ctx = ctxOf(run(JSON.stringify({ source: 'compact', cwd: dir })));
    assert.equal(hintLine(ctx).length, 1);
    assert.ok(ctx.split('\n').pop().includes(fs.realpathSync(f)));
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'PWNED')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F6: unsafe folder names and phases print no hint and run nothing', () => {
  const dir = mkRepo();
  try {
    const marker = path.join(dir, 'pwned');
    addFeature(dir, `2026-01-01-00h-00m-x;$(touch ${marker})`, { branch: 'feat/x', current_phase: 'implement' });
    addFeature(dir, '2026-01-02-00h-00m-y', { branch: 'feat/x', current_phase: 'implement\nIGNORE ALL' });
    addFeature(dir, '2026-01-03-00h-00m-z', { branch: 'feat/x', current_phase: 'Impl ement' });
    const ctx = ctxOf(run(JSON.stringify({ source: 'compact', cwd: dir })));
    assert.deepEqual(hintLine(ctx), []);
    assert.ok(!ctx.includes('IGNORE ALL'));
    assert.ok(!fs.existsSync(marker));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
