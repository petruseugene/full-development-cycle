// `visual build` (R6): device guard, content-hash cache, device start order,
// detached serve. Every spawn is a stub: no device, simulator or process is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FailedError, UsageError } from '../lib/core.mjs';
import { runWith, hashInputs, matchInputs } from '../lib/visual-build.mjs';
import { readStarted, startedPath } from '../lib/visual-device.mjs';
import { mkFixture, mkCtx, sampleFeatureJson, SCRIPTS_DIR } from './helpers.mjs';

const SIM = 'A1B2C3D4-E5F6-4789-ABCD-0123456789AB';
const SIMCTL_SHUTDOWN = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/visual-device/simctl-shutdown.json', import.meta.url)), 'utf8');
const NOW = () => new Date('2026-10-19T10:00:00.000Z');

function setup(visual, platform = 'web') {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ platform, profile: { visual } }) });
  fx.write('src/a.txt', 'one');
  fx.write('src/b.txt', 'two');
  return fx;
}

/** Stub spawn; `respond(argv)` → {code, stdout, pid}. */
function stub(root, respond = () => null) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const argv = [file, ...args];
    assert.notEqual(opts.shell, true);
    const rec = fs.existsSync(startedPath(root)) ? JSON.parse(fs.readFileSync(startedPath(root), 'utf8')) : null;
    calls.push({ argv, opts, record: rec });
    const r = respond(argv) ?? { code: 0 };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.unref = () => {};
    if (r.pid !== undefined) { child.pid = r.pid; return child; }
    child.pid = 99991;
    setImmediate(() => {
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

const WEB = { build: { cmd: 'npm run build', inputs: ['src/**'] } };
const go = (fx, spawn, extra = [], deps = {}) => {
  const ctx = mkCtx({ cwd: fx.root });
  return runWith([...extra, '--feature', fx.featureDir], ctx, { spawn, now: NOW, sleep: async () => {}, ...deps })
    .then((code) => ({ code, out: ctx.out() }));
};
const cache = (fx) => JSON.parse(fx.read('.dev-cycle/cache/visual-build.json'));
const manifest = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'verification', 'manifest.json'), 'utf8'));

test('AC5: first run builds, cached run spawns nothing, changed input and --force rebuild', async (t) => {
  const fx = setup(WEB);
  t.after(() => fx.cleanup());
  const s = stub(fx.root);
  await go(fx, s.spawn);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].argv, ['npm', 'run', 'build']);
  const h1 = cache(fx).hash;
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(manifest(fx).build.status, 'built');
  assert.match(fs.readFileSync(path.join(fx.featureDir, 'verification', 'build.log'), 'utf8'), /npm run build/);

  const r2 = await go(fx, s.spawn);
  assert.equal(s.calls.length, 1, 'cached: no spawn');
  assert.match(r2.out, /build cached/);
  assert.equal(manifest(fx).build.status, 'cached');

  fx.write('src/a.txt', 'changed');
  await go(fx, s.spawn);
  assert.equal(s.calls.length, 2);
  const h2 = cache(fx).hash;
  assert.notEqual(h2, h1);

  await go(fx, s.spawn, ['--force']);
  assert.equal(s.calls.length, 3);
});

test('AC5: failing build exits 1, keeps the cached hash, records failed', async (t) => {
  const fx = setup(WEB);
  t.after(() => fx.cleanup());
  await go(fx, stub(fx.root).spawn);
  const h1 = cache(fx).hash;
  fx.write('src/a.txt', 'broken');
  const bad = stub(fx.root, () => ({ code: 1 }));
  await assert.rejects(go(fx, bad.spawn), FailedError);
  assert.equal(bad.calls.length, 1);
  assert.equal(cache(fx).hash, h1);
  assert.equal(manifest(fx).build.status, 'failed');
  // still not cached afterwards
  const again = stub(fx.root);
  await go(fx, again.spawn);
  assert.equal(again.calls.length, 1);
});

test('hash covers sorted paths plus contents', (t) => {
  const fx = setup(WEB);
  t.after(() => fx.cleanup());
  const files = matchInputs(fx.root, ['src/**']);
  assert.deepEqual(files, ['src/a.txt', 'src/b.txt']);
  const h = hashInputs(fx.root, files);
  assert.equal(hashInputs(fx.root, files), h);
  assert.notEqual(hashInputs(fx.root, ['src/a.txt']), h);
  assert.throws(() => matchInputs(fx.root, ['../x']), UsageError);
  assert.throws(() => matchInputs(fx.root, ['/etc/*']), UsageError);
});

test('AC2: device-sensitive build.cmd without {device} → UsageError, zero spawns', async (t) => {
  const fx = setup({ device: SIM, build: { cmd: 'npx expo run:ios', inputs: ['src/**'] } }, 'mobile');
  t.after(() => fx.cleanup());
  const s = stub(fx.root);
  await assert.rejects(go(fx, s.spawn), UsageError);
  assert.equal(s.calls.length, 0);
  assert.ok(!fs.existsSync(startedPath(fx.root)));
});

test('AC2: physical-device id and unset device are refused with zero spawns; serve is guarded too', async (t) => {
  for (const visual of [
    { device: '00008030-001A2B3C4D5E6F70', build: { cmd: 'npx expo run:ios --device {device}' } },
    { build: { cmd: 'npx expo run:ios --device {device}' } },
    { device: SIM, build: { cmd: 'npm run build', serve: 'maestro test flow.yaml' } },
  ]) {
    const fx = setup(visual, 'mobile');
    t.after(() => fx.cleanup());
    const s = stub(fx.root);
    await assert.rejects(go(fx, s.spawn), UsageError);
    assert.equal(s.calls.length, 0);
  }
});

test('AC15: shutdown simulator is booted and recorded before the build.cmd spawn', async (t) => {
  const fx = setup({ device: SIM, build: { cmd: 'npx expo run:ios --device {device}', inputs: ['src/**'] } }, 'mobile');
  t.after(() => fx.cleanup());
  const s = stub(fx.root, (a) => (a[2] === 'list' ? { code: 0, stdout: SIMCTL_SHUTDOWN } : null));
  await go(fx, s.spawn);
  const argvs = s.calls.map((c) => c.argv);
  assert.deepEqual(argvs, [
    ['xcrun', 'simctl', 'list', 'devices', '-j'],
    ['xcrun', 'simctl', 'boot', SIM],
    ['npx', 'expo', 'run:ios', '--device', SIM],
  ]);
  assert.equal(s.calls[2].record.devices[0].id, SIM, 'recorded before build.cmd spawned');
  assert.deepEqual(readStarted(fx.root).devices.map((d) => d.id), [SIM]);
});

test('serve is spawned detached to serve.log and its pgid recorded', async (t) => {
  const fx = setup({ build: { cmd: 'npm run build', inputs: ['src/**'], serve: 'npm run dev' } });
  t.after(() => fx.cleanup());
  const s = stub(fx.root, (a) => (a[2] === 'dev' ? { pid: 2147483000 } : null));
  await go(fx, s.spawn);
  const serve = s.calls.find((c) => c.argv[2] === 'dev');
  assert.equal(serve.opts.detached, true);
  assert.equal(serve.opts.shell, false);
  assert.ok(Array.isArray(serve.opts.stdio) && typeof serve.opts.stdio[1] === 'number');
  assert.ok(fs.existsSync(path.join(fx.featureDir, 'verification', 'serve.log')));
  const rec = readStarted(fx.root);
  assert.equal(rec.pids.length, 1);
  assert.equal(rec.pids[0].name, 'serve');
  assert.equal(rec.pids[0].pgid, 2147483000);
});

test('failed build does not start serve', async (t) => {
  const fx = setup({ build: { cmd: 'npm run build', inputs: ['src/**'], serve: 'npm run dev' } });
  t.after(() => fx.cleanup());
  const s = stub(fx.root, (a) => (a[2] === 'build' ? { code: 1 } : { pid: 2147483000 }));
  await assert.rejects(go(fx, s.spawn), FailedError);
  assert.equal(s.calls.length, 1);
});

test('W3/B3: serve records its process identity; {out} is absolute; verification/ self-ignored first', async (t) => {
  const fx = setup({ build: { cmd: 'vite build --outDir={out}', inputs: ['src/**'], serve: 'npm run dev' } });
  t.after(() => fx.cleanup());
  const s = stub(fx.root, (a) => (a[2] === 'dev' ? { pid: 2147483000 } : null));
  await go(fx, s.spawn, [], { identify: (pid) => (pid === 2147483000 ? 'Mon Oct 19 10:00:00 2026 npm run dev' : null) });
  assert.equal(readStarted(fx.root).pids[0].ident, 'Mon Oct 19 10:00:00 2026 npm run dev');
  const build = s.calls.find((c) => c.argv[0] === 'vite');
  const out = build.argv.find((a) => a.startsWith('--outDir=')).slice('--outDir='.length);
  assert.ok(path.isAbsolute(out), out);
  assert.equal(fs.realpathSync(out), fs.realpathSync(path.join(fx.featureDir, 'verification')));
  assert.equal(fs.readFileSync(path.join(fx.featureDir, 'verification', '.gitignore'), 'utf8'), '*\n');
});

test('A: a simulator id that simctl does not list (real phone) is refused before any build spawn (exit 2)', async (t) => {
  const fx = setup({ device: 'FFFFFFFF-E5F6-4789-ABCD-0123456789AB', build: { cmd: 'vite build', inputs: ['src/**'] } });
  t.after(() => fx.cleanup());
  const listing = fs.readFileSync(path.join(SCRIPTS_DIR, 'test', 'fixtures', 'visual-device', 'simctl-booted.json'), 'utf8');
  const s = stub(fx.root, (a) => (a[2] === 'list' ? { code: 0, stdout: listing } : null));
  await assert.rejects(go(fx, s.spawn), UsageError);
  assert.deepEqual(s.calls.map((c) => c.argv), [['xcrun', 'simctl', 'list', 'devices', '-j']]);
});

test('B: with an emulator, build.cmd and serve get ANDROID_SERIAL; gradle is allowed only that way', async (t) => {
  const fx = setup({ device: 'emulator-5554', build: { cmd: './gradlew installDebug', inputs: ['src/**'], serve: 'npx expo start' } });
  t.after(() => fx.cleanup());
  const adb = fs.readFileSync(path.join(SCRIPTS_DIR, 'test', 'fixtures', 'visual-device', 'adb-attached.txt'), 'utf8');
  const s = stub(fx.root, (a) => (a[0] === 'adb' ? { code: 0, stdout: adb } : a[1] === 'expo' ? { pid: 2147483000 } : null));
  await go(fx, s.spawn, [], { identify: () => null });
  const build = s.calls.find((c) => c.argv[0] === './gradlew');
  const serve = s.calls.find((c) => c.argv[1] === 'expo');
  assert.equal(build.opts.env.ANDROID_SERIAL, 'emulator-5554');
  assert.equal(serve.opts.env.ANDROID_SERIAL, 'emulator-5554');
  assert.ok(s.calls.findIndex((c) => c.argv[0] === 'adb') < s.calls.indexOf(build), 'device verified first');
});
