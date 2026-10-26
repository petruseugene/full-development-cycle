import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkFixture, runCli } from './helpers.mjs';
import { worktreesConfig } from '../plugin/scripts/lib/profile.mjs';

function validateWith(profile) {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify(profile));
  const r = runCli(['profile', 'validate'], { cwd: fx.root });
  fx.cleanup();
  return r;
}

test('AC3: invalid worktrees profiles exit 2 naming the key', () => {
  const cases = {
    'mode on': { mode: 'on' },
    'min_group 1': { min_group: 1 },
    'min_group float': { min_group: 2.5 },
    'dir ../x': { dir: '../x' },
    'dir nested ..': { dir: 'a/../../x' },
    'dir /abs': { dir: '/abs' },
    'link traversal': { link: ['../../etc'] },
    'copy absolute': { copy: ['/etc/passwd'] },
    'link not array': { link: '**/node_modules' },
    'copy non-string': { copy: [1] },
    'setup number': { setup: 5 },
  };
  for (const [label, w] of Object.entries(cases)) {
    const r = validateWith({ worktrees: w });
    assert.equal(r.status, 2, label);
    assert.match(r.stderr + r.stdout, /worktrees\./, label);
  }
  assert.equal(validateWith({ worktrees: 'x' }).status, 2);
});

test('AC3: valid worktrees profiles exit 0', () => {
  assert.equal(validateWith({ worktrees: { mode: 'audit' } }).status, 0);
  assert.equal(validateWith({
    worktrees: { mode: 'auto', min_group: 3, dir: '.dev-cycle/worktrees', link: ['**/node_modules'], copy: ['.env', '.env.*'], setup: 'npm ci' },
  }).status, 0);
});

test('worktreesConfig resolves defaults', () => {
  const d = worktreesConfig({});
  assert.deepEqual(d, { mode: 'off', min_group: 3, dir: '.dev-cycle/worktrees', link: ['**/node_modules'], copy: ['.env', '.env.*'], setup: undefined });
  const c = worktreesConfig({ worktrees: { mode: 'audit', min_group: 4 } });
  assert.equal(c.mode, 'audit');
  assert.equal(c.min_group, 4);
  assert.equal(c.dir, '.dev-cycle/worktrees');
});

test('init presets do not emit worktrees mode other than off', () => {
  for (const preset of ['web', 'expo']) {
    const fx = mkFixture();
    const r = runCli(['init', '--preset', preset], { cwd: fx.root });
    assert.equal(r.status, 0, preset);
    const p = JSON.parse(fx.read('.dev-cycle/project.json'));
    assert.ok(!p.worktrees || p.worktrees.mode === 'off', preset);
    fx.cleanup();
  }
});
