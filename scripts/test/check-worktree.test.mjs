import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from './helpers.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

const blk = "console.log('not ok 1 - fails in b.mjs');console.log('  ---');console.log('  location: b.mjs:1:1');console.log('  ...');";
const testCmd = `node -e "${blk}process.exit(1)"`;

test('AC20: elsewhere label differs in a linked worktree vs the main tree', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-check-wt-')));
  const main = path.join(tmp, 'main');
  const wt = path.join(tmp, 'wt');
  try {
    fs.mkdirSync(path.join(main, '.dev-cycle'), { recursive: true });
    fs.writeFileSync(path.join(main, '.dev-cycle', 'project.json'), JSON.stringify({ commands: { test: testCmd } }));
    git(main, 'init', '-q');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);

    const args = ['check', '--scope', 'touched', '--files', 'a.mjs', '--steps', 'test'];
    const inMain = runCli(args, { cwd: main });
    assert.equal(inMain.status, 1, inMain.stdout + inMain.stderr);
    assert.match(inMain.stdout, /failures elsewhere — possibly in-flight sibling edits \(1\)/);

    const inWt = runCli(args, { cwd: wt });
    assert.equal(inWt.status, 1, inWt.stdout + inWt.stderr);
    assert.match(inWt.stdout, /failures elsewhere \(not a sibling: isolated worktree\) \(1\)/);
    assert.ok(!inWt.stdout.includes('in-flight sibling'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
