import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli } from './helpers.mjs';
import { requiredGates } from '../plugin/scripts/lib/dod.mjs';

test('AC29: no .dev-cycle/ => init, dod, groups, gate run --all behave as before', () => {
  const fx = mkFixture({ feature: '2000-01-01-00h-00m-seed', featureJson: null });
  try {
    assert.equal(fs.existsSync(path.join(fx.root, '.dev-cycle')), false);
    let r = runCli(['feature', 'init', 'np', '--flow', 'feature', '--track', 'full'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    const dir = r.stdout.trim();
    const fjFile = path.join(dir, 'feature.json');
    const fj = JSON.parse(fs.readFileSync(fjFile, 'utf8'));
    assert.equal('profile' in fj, false);
    assert.equal(fj.discovery, 'full');
    const q = runCli(['feature', 'init', 'np2', '--flow', 'feature'], { cwd: fx.root });
    assert.equal(q.status, 0, q.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(q.stdout.trim(), 'feature.json'), 'utf8')).track, 'quick');

    fs.writeFileSync(path.join(dir, 'plan.md'),
      '# Plan\n\n## Tasks\n- [TODO] **Task 1** (backend): a\n- [TODO] **Task 2** (backend): b\n\n## Task details\n\n### Task 1: a\n**Touches:** `a/**`\n**Depends on:** none\n\n### Task 2: b\n**Touches:** `b/**`\n**Depends on:** Task 1\n');

    r = runCli(['dod', '--json', '--feature', dir], { cwd: fx.root });
    assert.equal(r.status, 1);
    const dod = JSON.parse(r.stdout);
    assert.deepEqual(dod.required, requiredGates({ ...fj }, [1, 2]));
    assert.deepEqual(dod.required, [
      'spec', 'plan', 'implement.task=1', 'implement.task=2', 'static-check', 'review',
      ...(fj.auto_tests ? ['auto-test'] : []),
      ...(fj.visual_tests ? ['visual-test'] : []),
    ]);
    assert.ok(!dod.required.some((g) => g.startsWith('gate.')));

    r = runCli(['groups', '--all', '--json', '--feature', dir], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [[1], [2]]);

    const before = fs.readFileSync(fjFile, 'utf8');
    r = runCli(['gate', 'run', '--all', '--feature', dir], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no extra gates/);
    const after = fs.readFileSync(fjFile, 'utf8');
    assert.equal(after, before);
    assert.deepEqual(JSON.parse(after).history, []);
    assert.equal('profile' in JSON.parse(after), false);
  } finally { fx.cleanup(); }
});
