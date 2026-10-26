import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkFixture, sampleFeatureJson, runCli, DEFAULT_FEATURE, CLI_PATH } from './helpers.mjs';
import { EventEmitter } from 'node:events';
import { runStep, MAX_TIMEOUT_S } from '../plugin/scripts/lib/runner.mjs';

function fixture(profile) {
  return mkFixture({ featureJson: sampleFeatureJson({ profile }) });
}
const gate = (cmd, extra = {}) => ({ extra_gates: [{ name: 'content', cmd, ...extra }] });
const cli = (fx, args) => runCli([...args, '--feature', DEFAULT_FEATURE], { cwd: fx.root });
const history = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8')).history;

test('AC18: gate exit 0 -> PASSED, log + history, exit 0', () => {
  const fx = fixture(gate('exit 0'));
  try {
    const r = cli(fx, ['gate', 'run', 'content']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(fx.featureDir, 'gates', 'content.log')));
    const h = history(fx);
    assert.equal(h.length, 1);
    assert.equal(h[0].phase, 'gate.content');
    assert.equal(h[0].subagent, 'gate');
    assert.equal(h[0].status, 'PASSED');
  } finally { fx.cleanup(); }
});

test('AC18: gate exit 3 -> FAILED, exit 1', () => {
  const fx = fixture(gate('exit 3'));
  try {
    const r = cli(fx, ['gate', 'run', '--all']);
    assert.equal(r.status, 1);
    assert.equal(history(fx)[0].status, 'FAILED');
  } finally { fx.cleanup(); }
});

test('AC18: timeout kills the process group within 3s', () => {
  const fx = fixture(gate('sleep 30 & echo $! > gc.pid; sleep 30', { timeout_s: 1 }));
  try {
    const t0 = Date.now();
    const r = cli(fx, ['gate', 'run', 'content']);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
    assert.equal(r.status, 1);
    assert.equal(history(fx)[0].status, 'FAILED');
    assert.match(fs.readFileSync(path.join(fx.featureDir, 'gates', 'content.log'), 'utf8'), /timed out/);
    // deterministic: the CLI only returns once the group is verified dead
    const gc = Number(fs.readFileSync(path.join(fx.root, 'gc.pid'), 'utf8').trim());
    assert.throws(() => process.kill(gc, 0), { code: 'ESRCH' });
  } finally { fx.cleanup(); }
});

test('runStep: rejects timeout_s above the maximum or non-positive', () => {
  for (const bad of [MAX_TIMEOUT_S + 1, 0, -5, Number.NaN]) {
    assert.throws(
      () => runStep({ cmd: 'exit 0', timeout_s: bad, logPath: '/nonexistent/x.log', featureDir: '/', root: '/' }),
      { exitCode: 2 },
    );
  }
});

test('W3: SIGTERM to the CLI kills the running step group', async () => {
  const fx = fixture(gate('sleep 30 & echo $! > gc.pid; sleep 30'));
  try {
    const child = spawn(process.execPath, [CLI_PATH, 'gate', 'run', 'content', '--feature', DEFAULT_FEATURE], {
      cwd: fx.root, stdio: 'ignore',
    });
    const pidFile = path.join(fx.root, 'gc.pid');
    for (let i = 0; i < 200 && !(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const gc = Number(fs.readFileSync(pidFile, 'utf8').trim());
    process.kill(gc, 0); // alive
    await new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); });
    for (let i = 0; i < 100; i++) {
      try { process.kill(gc, 0); } catch { return; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail('grandchild survived CLI SIGTERM');
  } finally { fx.cleanup(); }
});

test('no extra gates: message, no history, exit 0', () => {
  const fx = mkFixture();
  try {
    const r = cli(fx, ['gate', 'run', '--all']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no extra gates/);
    assert.deepEqual(history(fx), []);
  } finally { fx.cleanup(); }
});

test('usage errors: unknown gate, no target, bad name', () => {
  const fx = fixture(gate('exit 0'));
  try {
    assert.equal(cli(fx, ['gate', 'run', 'nope']).status, 2);
    assert.equal(cli(fx, ['gate', 'run']).status, 2);
  } finally { fx.cleanup(); }
  const bad = fixture({ extra_gates: [{ name: '../x', cmd: 'exit 0' }] });
  try { assert.equal(cli(bad, ['gate', 'run', '--all']).status, 2); } finally { bad.cleanup(); }
});

test('AC19: env var carries feature dir; spawn gets the verbatim command', async () => {
  const fx = fixture(gate('echo "$DEV_CYCLE_FEATURE_DIR"'));
  try {
    const r = cli(fx, ['gate', 'run', 'content']);
    assert.equal(r.status, 0, r.stderr);
    const log = fs.readFileSync(path.join(fx.featureDir, 'gates', 'content.log'), 'utf8');
    assert.ok(log.includes(fx.featureDir));

    // unit: spawn receives exactly the profile string, env carries the dir
    const cmd = 'echo "$DEV_CYCLE_FEATURE_DIR"';
    let seen;
    const fake = (c, o) => {
      seen = { c, o };
      const ee = new EventEmitter();
      ee.pid = 1;
      setImmediate(() => ee.emit('close', 0));
      return ee;
    };
    const res = await runStep({
      cmd, logPath: path.join(fx.root, 'l.log'), featureDir: fx.featureDir, root: fx.root, spawn: fake,
    });
    assert.equal(res.status, 'PASSED');
    assert.equal(seen.c, cmd);
    assert.ok(!seen.c.includes(fx.featureDir) && !seen.c.includes('sample'));
    assert.equal(seen.o.env.DEV_CYCLE_FEATURE_DIR, fx.featureDir);
    assert.equal(seen.o.shell, true);
    assert.equal(seen.o.detached, true);
    assert.equal(seen.o.cwd, fx.root);
  } finally { fx.cleanup(); }
});

test('AC20: confirm step is refused without --confirmed, runs with it', () => {
  const profile = { post_merge: [{ name: 'deploy', cmd: 'touch ran.marker', confirm: true }] };
  const fx = fixture(profile);
  try {
    const r = cli(fx, ['post-merge', 'run', '--all']);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('touch ran.marker'));
    assert.equal(fs.existsSync(path.join(fx.root, 'ran.marker')), false);
    assert.equal(fs.existsSync(path.join(fx.featureDir, 'post-merge', 'deploy.log')), false);

    const ok = cli(fx, ['post-merge', 'run', '--all', '--confirmed']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(fs.existsSync(path.join(fx.root, 'ran.marker')));
    assert.ok(fs.existsSync(path.join(fx.featureDir, 'post-merge', 'deploy.log')));
    assert.deepEqual(history(fx), []);
  } finally { fx.cleanup(); }
});

test('runStep: returns the output tail without a log file and leaves no temp file', async () => {
  const os = await import('node:os');
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dev-cycle-step-'));
  const res = await runStep({ cmd: 'echo out; echo err 1>&2; exit 3', root: os.tmpdir(), featureDir: '' });
  assert.equal(res.status, 'FAILED');
  assert.equal(res.exitCode, 3);
  assert.equal(res.output, 'out\nerr\n');
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dev-cycle-step-'));
  assert.deepEqual(after.sort(), before.sort());
});

test('runStep: with a log file the log keeps the echo line, output excludes it', async () => {
  const fx = mkFixture();
  try {
    const logPath = path.join(fx.featureDir, 'checks', 'x.log');
    const res = await runStep({ cmd: 'echo hello', logPath, root: fx.root, featureDir: fx.featureDir });
    assert.equal(res.status, 'PASSED');
    assert.equal(res.output, 'hello\n');
    assert.equal(fs.readFileSync(logPath, 'utf8'), '$ echo hello\nhello\n');
  } finally { fx.cleanup(); }
});

test('runStep: output tail is bounded to OUTPUT_TAIL_BYTES and starts on a full line', async () => {
  const { OUTPUT_TAIL_BYTES } = await import('../plugin/scripts/lib/runner.mjs');
  const fx = mkFixture();
  try {
    const n = Math.ceil((OUTPUT_TAIL_BYTES * 1.5) / 10);
    const res = await runStep({
      cmd: `node -e "for (let i = 0; i < ${n}; i++) console.log(String(i).padStart(9, '0'))"`,
      logPath: path.join(fx.featureDir, 'big.log'), root: fx.root, featureDir: fx.featureDir,
    });
    assert.equal(res.status, 'PASSED');
    assert.ok(Buffer.byteLength(res.output) <= OUTPUT_TAIL_BYTES);
    const lines = res.output.trimEnd().split('\n');
    assert.ok(lines.every((l) => /^\d{9}$/.test(l)));
    assert.equal(lines.at(-1), String(n - 1).padStart(9, '0'));
  } finally { fx.cleanup(); }
});

test('selectSteps: closedAsNull gives featureDir null for a closed auto-detected folder', async () => {
  const { selectSteps } = await import('../plugin/scripts/lib/runner.mjs');
  const { mkFixture, sampleFeatureJson, mkCtx } = await import('./helpers.mjs');
  const fx = mkFixture({ featureJson: sampleFeatureJson({ current_phase: 'done' }) });
  try {
    const ctx = mkCtx({ cwd: fx.root });
    const opt = { usage: 'gate run', label: 'gate' };
    assert.equal(selectSteps(['run', '--all'], ctx, { ...opt, closedAsNull: true }).featureDir, null);
    assert.equal(selectSteps(['run', '--all'], ctx, opt).featureDir, fx.featureDir);
  } finally { fx.cleanup(); }
});
