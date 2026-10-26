import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals } from '../plugin/scripts/lib/totals.mjs';
import { mkFixture, runCli, DEFAULT_FEATURE } from './helpers.mjs';

const FJ = `docs/features/${DEFAULT_FEATURE}/feature.json`;
const prof = (lint) => JSON.stringify({ commands: { lint, test: 'npm test' } });

function setup(profile) {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', profile);
  return fx;
}
const snap = (fx) => runCli(['profile', 'snapshot', '--feature', DEFAULT_FEATURE], { cwd: fx.root });

test('profile snapshot replaces feature.json.profile after project.json changes', () => {
  const fx = setup(prof('bash old.sh'));
  try {
    assert.equal(snap(fx).status, 0);
    assert.equal(JSON.parse(fx.read(FJ)).profile.commands.lint, 'bash old.sh');
    fx.write('.dev-cycle/project.json', prof('bash tests/lint.sh'));
    const r = snap(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^profile: snapshot refreshed \(commands\)/);
    assert.equal(JSON.parse(fx.read(FJ)).profile.commands.lint, 'bash tests/lint.sh');
    const again = snap(fx);
    assert.match(again.stdout, /snapshot refreshed \(no changes\)/);
  } finally { fx.cleanup(); }
});

test('profile snapshot with an invalid or missing profile exits 2 and leaves feature.json unchanged', () => {
  const fx = setup('{"commands": {"lint": 5}}');
  try {
    const before = fx.read(FJ);
    assert.equal(snap(fx).status, 2);
    fx.write('.dev-cycle/project.json', '{nope');
    assert.equal(snap(fx).status, 2);
    assert.equal(fx.read(FJ), before);
    const fx2 = mkFixture();
    try {
      const b2 = fx2.read(FJ);
      assert.equal(snap(fx2).status, 2);
      assert.equal(fx2.read(FJ), b2);
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

test('profile snapshot appends a cli history entry that does not count in totals', () => {
  const fx = setup(prof('bash a.sh'));
  try {
    const before = JSON.parse(fx.read(FJ));
    assert.equal(snap(fx).status, 0);
    const after = JSON.parse(fx.read(FJ));
    const e = after.history.at(-1);
    assert.equal(after.history.length, before.history.length + 1);
    assert.deepEqual([e.phase, e.subagent, e.executor, e.status], ['profile', 'cli', 'cli', 'DONE']);
    assert.match(e.summary, /commands/);
    assert.deepEqual(after.totals, computeTotals(before.history));
  } finally { fx.cleanup(); }
});
