// Device lifecycle (R6 device start, R13 record format). Every spawn is a
// stub: no simulator, emulator or device is ever touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FailedError, UsageError } from '../lib/core.mjs';
import {
  ensureDevice, readStarted, addStartedDevice, addStartedPid, removeStarted, startedPath,
  simulatorState, adbState, processIdentity, processInfo, verifyDevice, deviceEnv,
} from '../lib/visual-device.mjs';

const FX = fileURLToPath(new URL('./fixtures/visual-device/', import.meta.url));
const fx = (name) => fs.readFileSync(path.join(FX, name), 'utf8');
const SIM = 'A1B2C3D4-E5F6-4789-ABCD-0123456789AB';
const EMU = 'emulator-5556';
const NOW = () => '2026-10-19T10:00:00.000Z';
const noSleep = async () => {};

function mkRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-visual-device-')));
}

/**
 * Stub spawn: `respond(argv)` → {code, stdout} or {pid} (detached launch).
 * Each call records argv and the record as it was on disk at that moment.
 */
function stubSpawn(root, respond) {
  const calls = [];
  const spawn = (file, args, opts) => {
    const argv = [file, ...args];
    const recText = fs.existsSync(startedPath(root)) ? fs.readFileSync(startedPath(root), 'utf8') : null;
    calls.push({ argv, opts, record: recText ? JSON.parse(recText) : null });
    assert.notEqual(opts.shell, true, 'never spawn through a shell');
    const r = respond(argv) ?? { code: 0, stdout: '' };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.unref = () => {};
    if (r.pid !== undefined) {
      child.pid = r.pid;
      return child;
    }
    child.pid = 99999;
    setImmediate(() => {
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

const noAll = (calls) => {
  for (const c of calls) assert.ok(!c.argv.includes('all'), `argv contains 'all': ${c.argv.join(' ')}`);
};

test('AC15: simulator already Booted → no boot, nothing recorded', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, (a) => (a[2] === 'list' ? { code: 0, stdout: fx('simctl-booted.json') } : null));
  const r = await ensureDevice({ visual: { device: SIM }, root, spawn, now: NOW });
  assert.equal(r.started, false);
  assert.deepEqual(calls.map((c) => c.argv), [['xcrun', 'simctl', 'list', 'devices', '-j']]);
  assert.deepEqual(readStarted(root), { devices: [], pids: [] });
  noAll(calls);
  fs.rmSync(root, { recursive: true, force: true });
});

test('AC15: simulator Shutdown → exact boot argv, record written before the next spawn', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, (a) => (a[2] === 'list' ? { code: 0, stdout: fx('simctl-shutdown.json') } : { code: 0 }));
  const r = await ensureDevice({ visual: { device: SIM }, root, spawn, now: NOW });
  assert.equal(r.started, true);
  assert.deepEqual(calls[1].argv, ['xcrun', 'simctl', 'boot', SIM]);
  assert.equal(calls.length, 2);
  const rec = readStarted(root);
  assert.deepEqual(rec.devices, [{ kind: 'simulator', id: SIM, started_at: NOW() }]);
  // a following spawn (e.g. build.cmd) sees the record already on disk
  spawn('echo', ['build'], { shell: false });
  assert.deepEqual(calls[2].record.devices, [{ kind: 'simulator', id: SIM, started_at: NOW() }]);
  // the cache folder self-ignores
  assert.match(fs.readFileSync(path.join(root, '.dev-cycle', 'cache', '.gitignore'), 'utf8'), /^\*$/m);
  noAll(calls);
  fs.rmSync(root, { recursive: true, force: true });
});

test('simulator boot failure → FailedError, nothing recorded', async () => {
  const root = mkRoot();
  const { spawn } = stubSpawn(root, (a) => (a[2] === 'list' ? { code: 0, stdout: fx('simctl-shutdown.json') } : { code: 149 }));
  await assert.rejects(ensureDevice({ visual: { device: SIM }, root, spawn, now: NOW }), FailedError);
  assert.deepEqual(readStarted(root).devices, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('unknown simulator UDID (e.g. a real phone id) → UsageError (exit 2), no boot', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, () => ({ code: 0, stdout: fx('simctl-shutdown.json') }));
  await assert.rejects(
    ensureDevice({ visual: { device: 'FFFFFFFF-E5F6-4789-ABCD-0123456789AB' }, root, spawn }),
    (e) => e instanceof UsageError && /not found/.test(e.message),
  );
  assert.equal(calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('AC15: emulator not attached + avd → launch argv detached, record before adb poll', async () => {
  const root = mkRoot();
  let polls = 0;
  const { spawn, calls } = stubSpawn(root, (a) => {
    if (a[0] === 'emulator') return { pid: 4242 };
    if (a[0] === 'adb') return { code: 0, stdout: polls++ < 2 ? fx('adb-other.txt') : fx('adb-attached.txt') };
    return null;
  });
  const identify = (pid) => (pid === 4242 ? 'Mon Oct 19 10:00:00 2026 emulator -avd Pixel_8_API_35 -port 5556' : null);
  const r = await ensureDevice({ visual: { device: EMU, avd: 'Pixel_8_API_35' }, root, spawn, now: NOW, sleep: noSleep, identify });
  assert.equal(r.started, true);
  const launch = calls.findIndex((c) => c.argv[0] === 'emulator');
  assert.deepEqual(calls[launch].argv, ['emulator', '-avd', 'Pixel_8_API_35', '-port', '5556']);
  assert.equal(calls[launch].opts.detached, true);
  assert.equal(calls[launch].record, null, 'nothing recorded before launch');
  const entry = { kind: 'emulator', id: EMU, pgid: 4242, ident: identify(4242), started_at: NOW() };
  assert.deepEqual(calls[launch + 1].record.devices, [entry], 'record exists before the next spawn');
  assert.deepEqual(readStarted(root).devices, [entry]);
  noAll(calls);
  fs.rmSync(root, { recursive: true, force: true });
});

test('AC15: emulator already attached → no launch, nothing recorded', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, () => ({ code: 0, stdout: fx('adb-attached.txt') }));
  const r = await ensureDevice({ visual: { device: EMU, avd: 'Pixel' }, root, spawn, sleep: noSleep });
  assert.equal(r.started, false);
  assert.deepEqual(calls.map((c) => c.argv), [['adb', 'devices']]);
  assert.deepEqual(readStarted(root).devices, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('AC15: emulator not running and no avd → exit 1 "emulator not running", no launch', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, () => ({ code: 0, stdout: fx('adb-other.txt') }));
  await assert.rejects(
    ensureDevice({ visual: { device: EMU }, root, spawn, sleep: noSleep }),
    (e) => e instanceof FailedError && e.exitCode === 1 && /emulator not running/.test(e.message),
  );
  assert.ok(!calls.some((c) => c.argv[0] === 'emulator'));
  assert.deepEqual(readStarted(root).devices, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('emulator never attaches → FailedError after boot_timeout_s polls, record kept for teardown', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, (a) => (a[0] === 'emulator' ? { pid: 77 } : { code: 0, stdout: fx('adb-other.txt') }));
  await assert.rejects(
    ensureDevice({ visual: { device: EMU, avd: 'Pixel', boot_timeout_s: 6 }, root, spawn, now: NOW, sleep: noSleep, identify: () => null }),
    FailedError,
  );
  // 1 initial adb check + 1 launch + ceil(6/2)=3 polls
  assert.equal(calls.length, 5);
  assert.equal(readStarted(root).devices[0].pgid, 77);
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid avd / device ids are rejected before any spawn', async () => {
  const root = mkRoot();
  const { spawn, calls } = stubSpawn(root, () => ({ code: 0, stdout: fx('adb-other.txt') }));
  await assert.rejects(ensureDevice({ visual: { device: EMU, avd: '-wipe-data' }, root, spawn }), UsageError);
  await assert.rejects(ensureDevice({ visual: { device: EMU, avd: 'a;rm -rf /' }, root, spawn }), UsageError);
  assert.ok(!calls.some((c) => c.argv[0] === 'emulator'));
  const before = calls.length;
  for (const device of ['all', '; rm -rf /', '00008030-001A2B3C4D5E6F70', undefined]) {
    await assert.rejects(ensureDevice({ visual: { device }, root, spawn }), UsageError);
  }
  assert.equal(calls.length, before);
  noAll(calls);
  fs.rmSync(root, { recursive: true, force: true });
});

test('record API: no duplicates by id/pgid, removeStarted by predicate', () => {
  const root = mkRoot();
  assert.deepEqual(readStarted(root), { devices: [], pids: [] });
  assert.equal(addStartedDevice(root, { kind: 'simulator', id: SIM, started_at: 't1' }), true);
  assert.equal(addStartedDevice(root, { kind: 'simulator', id: SIM, started_at: 't2' }), false);
  assert.equal(addStartedDevice(root, { kind: 'emulator', id: EMU, pgid: 5, started_at: 't' }), true);
  assert.equal(addStartedPid(root, { name: 'serve', pgid: 10, started_at: 't' }), true);
  assert.equal(addStartedPid(root, { name: 'serve-again', pgid: 10, started_at: 't' }), false);
  assert.equal(addStartedPid(root, { name: 'metro', pgid: 11, started_at: 't' }), true);
  let rec = readStarted(root);
  assert.equal(rec.devices.length, 2);
  assert.deepEqual(rec.pids.map((p) => p.pgid), [10, 11]);
  assert.equal(removeStarted(root, (e, kind) => (kind === 'device' && e.id === SIM) || (kind === 'pid' && e.pgid === 10)), 2);
  rec = readStarted(root);
  assert.deepEqual(rec.devices.map((d) => d.id), [EMU]);
  assert.deepEqual(rec.pids.map((p) => p.pgid), [11]);
  assert.equal(removeStarted(root, () => false), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('record API refuses invalid entries', () => {
  const root = mkRoot();
  assert.throws(() => addStartedDevice(root, { kind: 'simulator', id: 'all', started_at: 't' }), UsageError);
  assert.throws(() => addStartedDevice(root, { kind: 'emulator', id: SIM, started_at: 't' }), UsageError);
  assert.throws(() => addStartedPid(root, { name: 'x', pgid: -1, started_at: 't' }), UsageError);
  assert.throws(() => addStartedPid(root, { name: 'x', pgid: 0, started_at: 't' }), UsageError);
  assert.deepEqual(readStarted(root), { devices: [], pids: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

test('readStarted: invalid JSON is a UsageError', () => {
  const root = mkRoot();
  fs.mkdirSync(path.dirname(startedPath(root)), { recursive: true });
  fs.writeFileSync(startedPath(root), '{nope');
  assert.throws(() => readStarted(root), UsageError);
  fs.rmSync(root, { recursive: true, force: true });
});

test('parsers: simulatorState and adbState', () => {
  assert.equal(simulatorState(fx('simctl-shutdown.json'), SIM.toLowerCase()), 'Shutdown');
  assert.equal(simulatorState(fx('simctl-booted.json'), SIM), 'Booted');
  assert.equal(simulatorState('{}', SIM), null);
  assert.throws(() => simulatorState('not json', SIM), FailedError);
  assert.equal(adbState(fx('adb-attached.txt'), EMU), 'device');
  assert.equal(adbState(fx('adb-other.txt'), EMU), null);
  assert.equal(adbState('List of devices attached\nemulator-5556\toffline\n', EMU), 'offline');
});

test('L7: processInfo/processIdentity: start time + pgid only, stable across a process.title rename', async () => {
  const { spawn: realSpawn } = await import('node:child_process');
  const child = realSpawn(process.execPath, ['-e', "setTimeout(() => { process.title = 'renamed-server'; }, 50); setTimeout(() => {}, 20000)"], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    const before = processInfo(child.pid);
    assert.equal(before.pgid, child.pid);
    assert.equal(processIdentity(child.pid), before.lstart);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(processInfo(child.pid), before, 'unchanged after the rename');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const bad of [0, 1, -5, 1.5, '12', 2147483000]) assert.equal(processInfo(bad), null, String(bad));
});

const SIM_ID = 'A1B2C3D4-E5F6-4789-ABCD-0123456789AB';
test('A: verifyDevice: listed simulator / attached emulator pass; unlisted UDID or absent emulator → UsageError; nothing booted', async () => {
  const root = mkRoot();
  const sim = stubSpawn(root, () => ({ code: 0, stdout: fx('simctl-shutdown.json') }));
  assert.equal((await verifyDevice({ visual: { device: SIM_ID }, root, spawn: sim.spawn })).kind, 'simulator');
  assert.deepEqual(sim.calls.map((c) => c.argv), [['xcrun', 'simctl', 'list', 'devices', '-j']]);
  await assert.rejects(verifyDevice({ visual: { device: 'FFFFFFFF-E5F6-4789-ABCD-0123456789AB' }, root, spawn: sim.spawn }), UsageError);
  const att = stubSpawn(root, () => ({ code: 0, stdout: fx('adb-attached.txt') }));
  assert.equal((await verifyDevice({ visual: { device: EMU }, root, spawn: att.spawn })).kind, 'emulator');
  const other = stubSpawn(root, () => ({ code: 0, stdout: fx('adb-other.txt') }));
  await assert.rejects(verifyDevice({ visual: { device: EMU }, root, spawn: other.spawn }), UsageError);
  await assert.rejects(verifyDevice({ visual: { device: '00008030-001A2B3C4D5E6F70' }, root, spawn: other.spawn }), UsageError);
  fs.rmSync(root, { recursive: true, force: true });
});

test('B: deviceEnv pins ANDROID_SERIAL to an emulator only', () => {
  assert.deepEqual(deviceEnv({ device: 'emulator-5554' }), { ANDROID_SERIAL: 'emulator-5554' });
  assert.deepEqual(deviceEnv({ device: SIM_ID }), {});
  assert.deepEqual(deviceEnv(null), {});
});
