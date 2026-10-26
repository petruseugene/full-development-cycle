// Layout guards for the plugin-subfolder move: marketplace source, shipped-tree budget, no stale root dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, PLUGIN_ROOT } from './helpers.mjs';

function shipped() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'plugin'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
}

test('AC1: marketplace source is ./plugin', () => {
  const mp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(mp.plugins.length, 1);
  assert.equal(mp.plugins[0].source, './plugin');
});

test('AC30: shipped tree stays within budget (<= 450, hard cap < 512)', () => {
  const n = shipped().length;
  assert.ok(n <= 450, `plugin/ ships ${n} files`);
  assert.ok(n < 512);
});

test('AC31: only icon.png is binary under plugin/', () => {
  const bin = shipped().filter((f) => fs.readFileSync(path.join(REPO_ROOT, f)).includes(0));
  assert.deepEqual(bin, ['plugin/.claude-plugin/icon.png']);
});

test('AC2: no scripts/ or skills/ (or other runtime dirs) left at the repo root', () => {
  // Judge by git (tracked or untracked non-ignored) so ignored leftovers such as a stale dashboard/.next do not count.
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'scripts', 'skills', 'commands', 'hooks', 'dashboard'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const left = r.stdout.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  assert.deepEqual(left, []);
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'skills')));
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts/dev-cycle.mjs')));
});
