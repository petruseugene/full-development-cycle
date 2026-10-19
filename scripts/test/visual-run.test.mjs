import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWith } from '../lib/visual-run.mjs';
import { makeContext, UsageError, FailedError } from '../lib/core.mjs';
import { mkFixture, sampleFeatureJson, DEFAULT_FEATURE } from './helpers.mjs';

const SLEEP = fileURLToPath(new URL('./fixtures/visual-run/sleep.mjs', import.meta.url));

function setup(t, visual) {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { visual } }) });
  t.after(() => fx.cleanup());
  const ctx = makeContext({ cwd: fx.root, env: {}, stdout: { write() {} }, stderr: { write() {} } });
  const manifest = () => JSON.parse(fx.read(`docs/features/${DEFAULT_FEATURE}/verification/manifest.json`));
  return { fx, ctx, manifest };
}

test('timeout kills the group, exit 1 fast, every flow screen is timeout', async (t) => {
  const flow = `node ${SLEEP} 10`;
  const { ctx, manifest } = setup(t, {
    screens: [{ id: 'a', flow, timeout_s: 1 }, { id: 'b', flow, timeout_s: 1 }, { id: 'r', route: '/' }],
  });
  const pids = [];
  const spawn = (...a) => { const c = realSpawn(...a); pids.push(c.pid); return c; };
  const t0 = Date.now();
  await assert.rejects(runWith(['a'], ctx, { spawn }), FailedError);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(pids[0], 0));
  for (const id of ['a', 'b']) {
    const s = manifest().screens[id];
    assert.equal(s.timed_out, true);
    assert.equal(s.result, 'timeout');
    assert.equal(typeof s.duration_s, 'number');
  }
  assert.equal(manifest().screens.r, undefined);
  assert.ok(manifest().last_activity);
});

test('a route screen exits 2 (agent-driven)', async (t) => {
  const { ctx } = setup(t, { screens: [{ id: 'r', route: '/' }] });
  await assert.rejects(runWith(['r'], ctx, { spawn: () => assert.fail('spawned') }), (e) => e instanceof UsageError && /visual mark/.test(e.message));
});

test('device guard: exit 2 before any spawn', async (t) => {
  const { ctx } = setup(t, { device: 'emulator-5554', screens: [{ id: 'm', flow: 'maestro test flow.yaml' }] });
  let calls = 0;
  await assert.rejects(runWith(['m'], ctx, { spawn: () => { calls++; throw new Error('no'); } }), UsageError);
  assert.equal(calls, 0);
});

test('success records exit_code 0 and passes {screen} and {out}', async (t) => {
  const { ctx, manifest, fx } = setup(t, { screens: [{ id: 'ok', flow: `node ${SLEEP} 0 {screen} {out}` }] });
  const code = await runWith(['ok'], ctx);
  assert.equal(code, 0);
  const s = manifest().screens.ok;
  assert.equal(s.exit_code, 0);
  assert.equal(s.timed_out, false);
  assert.match(fx.read(`docs/features/${DEFAULT_FEATURE}/verification/run-ok.log`), /\$ node /);
});

test('unknown target is a usage error', async (t) => {
  const { ctx } = setup(t, { screens: [] });
  await assert.rejects(runWith(['zzz'], ctx), UsageError);
});

test('L4: a spec ## Screens flow with a shell after a wrapper is rejected with zero spawns', async (t) => {
  const { ctx, fx } = setup(t, { screens: [] });
  fx.write(`docs/features/${DEFAULT_FEATURE}/spec.md`, '# S\n\n## Screens\n\n| id | target | reference | touches | acs |\n|---|---|---|---|---|\n| x | caffeinate bash -c id | | | |\n');
  let calls = 0;
  const spawn = () => { calls++; throw new Error('spawned'); };
  await assert.rejects(runWith(['x'], ctx, { spawn }), (e) => e instanceof UsageError && /'bash' is a shell/.test(e.message));
  await assert.rejects(runWith(['caffeinate bash -c id'], ctx, { spawn }), UsageError);
  assert.equal(calls, 0);
});

test('L4: a snapshot flow with a shell after a wrapper is rejected with zero spawns', async (t) => {
  const { ctx } = setup(t, { screens: [{ id: 'x', flow: 'caffeinate bash -c id' }] });
  let calls = 0;
  await assert.rejects(runWith(['x'], ctx, { spawn: () => { calls++; throw new Error('spawned'); } }), UsageError);
  assert.equal(calls, 0);
});

test('R2: hard-coded or missing device selectors are refused with zero spawns', async (t) => {
  for (const flow of ['adb uninstall com.x', 'adb shell pm clear com.x', 'adb reboot', 'adb -s R58M123ABC install app.apk {device}',
    'maestro --device X test f {device}', 'flutter run']) {
    const { ctx } = setup(t, { device: 'emulator-5554' });
    // spec row: bypasses the snapshot validator, so the spawn-time guard must catch it
    const spec = `# S\n\n## Screens\n\n| id | target | reference | touches | acs |\n|---|---|---|---|---|\n| m | ${flow} | | | |\n`;
    fs.writeFileSync(path.join(ctx.cwd, 'docs', 'features', DEFAULT_FEATURE, 'spec.md'), spec);
    let calls = 0;
    await assert.rejects(runWith(['m'], ctx, { spawn: () => { calls++; throw new Error('no'); }, ensureDevice: () => assert.fail('device') }),
      (e) => e instanceof UsageError && /device/.test(e.message), flow);
    assert.equal(calls, 0, flow);
  }
});

test('B3: {out} is the absolute verification/ path, cwd is verification/, root-relative paths are anchored', async (t) => {
  const { ctx, fx } = setup(t, { screens: [{ id: 'ok', flow: 'node flows/x.mjs {out} test' }] });
  fx.write('flows/x.mjs', '');
  const seen = [];
  const spawn = (file, args, opts) => {
    seen.push({ argv: [file, ...args], cwd: opts.cwd });
    return realSpawn(process.execPath, ['-e', ''], opts);
  };
  assert.equal(await runWith(['ok'], ctx, { spawn }), 0);
  const ver = fs.realpathSync(path.join(fx.featureDir, 'verification'));
  assert.equal(seen.length, 1);
  const [{ argv, cwd }] = seen;
  assert.ok(path.isAbsolute(argv[2]));
  assert.equal(fs.realpathSync(argv[2]), ver);
  assert.equal(fs.realpathSync(cwd), ver);
  assert.equal(argv[1], path.join(fs.realpathSync(fx.root), 'flows', 'x.mjs'));
  assert.equal(argv[3], 'test'); // not a path: left alone
  assert.equal(argv[0], 'node');
});

test('--help documents {out} and the cwd', async (t) => {
  let out = '';
  const ctx = makeContext({ cwd: process.cwd(), env: {}, stdout: { write(s) { out += s; } }, stderr: { write() {} } });
  assert.equal(await runWith(['--help'], ctx), 0);
  assert.match(out, /\{out\}\s+absolute path of <feature>\/verification\//);
  assert.match(out, /cwd = <feature>\/verification\//);
});

test('re-run: visual run starts a fresh attempt per screen (earlier fail reasons/results cleared)', async (t) => {
  const { ctx, manifest, fx } = setup(t, { screens: [{ id: 'ok', flow: `node ${SLEEP} 0`, reference: 'r.png' }] });
  fx.write(`docs/features/${DEFAULT_FEATURE}/verification/manifest.json`, JSON.stringify({
    version: 1,
    screens: { ok: { id: 'ok', title: 'ok', reference: 'r.png', acs: [], adhoc: false, result: 'timeout', timed_out: true,
      failures: ['console error: old'], checks: [{ type: 'tap', subject: 'x', result: 'fail' }], screenshot: 'old.png' } },
  }));
  assert.equal(await runWith(['ok'], ctx), 0);
  const s = manifest().screens.ok;
  assert.equal(s.failures, undefined);
  assert.equal(s.checks, undefined);
  assert.equal(s.screenshot, undefined);
  assert.equal(s.result, undefined);
  assert.equal(s.timed_out, false);
  assert.equal(s.exit_code, 0);
  assert.equal(s.reference, 'r.png');
});

test('visual mark --help documents the fresh attempt', async () => {
  const { runWith: mark } = await import('../lib/visual-mark.mjs');
  let out = '';
  const ctx = makeContext({ cwd: process.cwd(), env: {}, stdout: { write(s) { out += s; } }, stderr: { write() {} } });
  assert.equal(await mark(['--help'], ctx), 0);
  assert.match(out, /start\s+begins a fresh attempt/);
});

test('A/B: with visual.device set, the device is verified before ANY flow spawn; emulator flows get ANDROID_SERIAL', async (t) => {
  const { ctx } = setup(t, { device: 'emulator-5554', screens: [{ id: 'a', flow: `node ${SLEEP} 0` }] });
  const seen = [];
  const spawn = (file, args, opts) => { seen.push(opts.env); return realSpawn(process.execPath, ['-e', ''], opts); };
  let ensured = 0;
  assert.equal(await runWith(['a'], ctx, { spawn, ensureDevice: async () => { ensured++; } }), 0);
  assert.equal(ensured, 1, 'verified even though the flow is not device-sensitive');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ANDROID_SERIAL, 'emulator-5554');
  // a device that cannot be verified (e.g. not attached / a phone id) → exit 2, zero spawns
  let calls = 0;
  await assert.rejects(
    runWith(['a'], ctx, { spawn: () => { calls++; throw new Error('spawned'); }, ensureDevice: async () => { throw new UsageError('emulator emulator-5554 is not attached'); } }),
    UsageError,
  );
  assert.equal(calls, 0);
});

test('AC35: bare existing names are anchored; options and a bare argv[0] are not', async (t) => {
  const { ctx, fx } = setup(t, { screens: [{ id: 'm', flow: 'maestro --device {device} test flows' }], device: 'emulator-5554' });
  fs.mkdirSync(path.join(fx.root, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(fx.root, 'test'), { recursive: true }); // a `test/` dir must not capture the subcommand
  const seen = [];
  const spawn = (file, args, opts) => {
    seen.push([file, ...args]);
    return realSpawn(process.execPath, ['-e', ''], opts);
  };
  assert.equal(await runWith(['m'], ctx, { spawn, ensureDevice: async () => {} }), 0);
  assert.deepEqual(seen[0].slice(0, 2), ['maestro', '--device']);
  assert.equal(seen[0][2], 'emulator-5554');
  assert.equal(seen[0][3], 'test');
  assert.equal(seen[0][4], path.join(fs.realpathSync(fx.root), 'flows'));
});

test('#43: anchorPaths skips the subcommand word only right after the binary', async (t) => {
  const { anchorPaths } = await import('../lib/visual-run.mjs');
  const fx = mkFixture({});
  t.after(() => fx.cleanup());
  fs.mkdirSync(path.join(fx.root, 'test'));
  fs.mkdirSync(path.join(fx.root, 'build'));
  const lit = (...ws) => ws.map((x) => ({ lit: x }));
  const out = anchorPaths(lit('tools/maestro', 'test', 'build', '--x', 'test'), fx.root).map((w) => w.lit);
  assert.equal(out[1], 'test');
  assert.equal(out[2], path.join(fs.realpathSync(fx.root), 'build'));
  assert.equal(out[4], path.join(fs.realpathSync(fx.root), 'test'));
  const opt = anchorPaths([...lit('maestro', '--device'), { ph: 'device', prefix: '' }, ...lit('test', 'build')], fx.root).map((w) => w.lit);
  assert.equal(opt[3], 'test');
  assert.equal(opt[4], path.join(fs.realpathSync(fx.root), 'build'));
});
