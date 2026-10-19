import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkFixture, sampleFeatureJson, runCli } from './helpers.mjs';
import { resolveFeatureForWrite } from '../lib/core.mjs';

const OK = 'node -e "process.exit(0)"';
const CLOSED = '2026-02-02-00h-00m-closed';

function closedFixture(profile) {
  const fx = mkFixture({ feature: CLOSED, featureJson: sampleFeatureJson({ current_phase: 'done', ...(profile ? { profile } : {}) }) });
  fx.write(`docs/features/${CLOSED}/static-check-report.md`, '# committed report\n');
  fx.write('.dev-cycle/project.json', JSON.stringify({
    commands: { lint: OK },
    recipes: [{ name: 'noop', cmd: 'node -e 0' }],
    extra_gates: [{ name: 'g1', cmd: OK }, { name: 'g2', cmd: OK }],
  }));
  return fx;
}
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
};

test('AC39: closed newest feature is left untouched by check, recipe run; --record exits 2', () => {
  const fx = closedFixture();
  try {
    const before = snapshot(fx.featureDir);
    let r = runCli(['check', '--steps', 'lint'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /check: PASSED/);
    r = runCli(['recipe', 'run', 'noop'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.existsSync(path.join(fx.featureDir, 'content')), false);
    r = runCli(['check', '--steps', 'lint', '--record'], { cwd: fx.root });
    assert.equal(r.status, 2);
    assert.deepEqual(snapshot(fx.featureDir), before);
  } finally { fx.cleanup(); }
});

test('AC39: failing tree-wide check on a closed feature logs to a temp dir, no report change', () => {
  const fx = closedFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ commands: { lint: 'node -e "process.exit(1)"' } }));
  try {
    const before = snapshot(fx.featureDir);
    const r = runCli(['check', '--steps', 'lint'], { cwd: fx.root });
    assert.equal(r.status, 1);
    assert.deepEqual(snapshot(fx.featureDir), before);
  } finally { fx.cleanup(); }
});

test('AC39: explicit --feature on the closed folder keeps the old behaviour', () => {
  const fx = closedFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ commands: { lint: OK } }));
  try {
    const r = runCli(['check', '--steps', 'lint', '--feature', CLOSED], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(fx.featureDir, 'checks', 'lint.log')));
    assert.equal(fs.existsSync(path.join(fx.featureDir, 'static-check-report.md')), false); // stale report removed
    assert.equal(runCli(['check', '--steps', 'lint', '--record', '--feature', CLOSED], { cwd: fx.root }).status, 0);
  } finally { fx.cleanup(); }
});

test('resolveFeatureForWrite: null on done/empty, folder otherwise, explicit wins', () => {
  const fx = closedFixture();
  try {
    const ctx = { cwd: fx.root, env: {} };
    assert.equal(resolveFeatureForWrite(ctx, {}), null);
    assert.equal(resolveFeatureForWrite(ctx, { feature: CLOSED }), fx.featureDir);
    fx.addFeature('2026-03-03-00h-00m-live');
    assert.equal(path.basename(resolveFeatureForWrite(ctx, {})), '2026-03-03-00h-00m-live');
  } finally { fx.cleanup(); }
});

test('AC40: gate run --all source line by profile / feature snapshot / none', () => {
  const fx = closedFixture();
  try {
    const before = snapshot(fx.featureDir);
    let r = runCli(['gate', 'run', '--all'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gates from project profile \(\.dev-cycle\/project\.json\): 2/);
    assert.match(r.stdout, /gate g1: PASSED/);
    assert.match(r.stdout, /gate g2: PASSED/);
    assert.deepEqual(snapshot(fx.featureDir), before);

    fx.addFeature('2026-03-03-00h-00m-live', sampleFeatureJson({ profile: { extra_gates: [{ name: 'f1', cmd: OK }] } }));
    r = runCli(['gate', 'run', '--all'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gates from feature snapshot \(project profile: 2 gates\)/);
    assert.match(r.stdout, /gate f1: PASSED/);
  } finally { fx.cleanup(); }

  const none = mkFixture({ feature: CLOSED, featureJson: sampleFeatureJson({ current_phase: 'done' }) });
  try {
    const r = runCli(['gate', 'run', '--all'], { cwd: none.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no extra gates/);
  } finally { none.cleanup(); }
});

test('gate run without an open feature removes its temp log dir on PASS, keeps it on FAIL', () => {
  const tmpGates = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dev-cycle-gate-'));
  const fx = closedFixture();
  try {
    const before = new Set(tmpGates());
    let r = runCli(['gate', 'run', '--all'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(tmpGates().filter((n) => !before.has(n)), []);
    fx.write('.dev-cycle/project.json', JSON.stringify({ extra_gates: [{ name: 'bad', cmd: 'node -e "process.exit(1)"' }] }));
    r = runCli(['gate', 'run', '--all'], { cwd: fx.root });
    assert.equal(r.status, 1);
    const kept = tmpGates().filter((n) => !before.has(n));
    assert.equal(kept.length, 1);
    assert.ok(r.stdout.includes(path.join(os.tmpdir(), kept[0])));
    fs.rmSync(path.join(os.tmpdir(), kept[0]), { recursive: true, force: true });
  } finally { fx.cleanup(); }
});

test('#43: gate run without a feature reports discarded logs (text and JSON log: null) on PASS', () => {
  const fx = closedFixture();
  try {
    let r = runCli(['gate', 'run', '--all'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASSED \(logs discarded\)/);
    assert.ok(!r.stdout.includes(os.tmpdir()), r.stdout);
    r = runCli(['gate', 'run', '--all', '--json'], { cwd: fx.root });
    const gates = JSON.parse(r.stdout).gates;
    assert.ok(gates.length > 0 && gates.every((g) => g.log === null), r.stdout);
  } finally { fx.cleanup(); }
});
