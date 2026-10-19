// visual teardown (AC15). Every spawn and kill is a stub except the one test
// that kills a real sleeping process group it started itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { run as runTeardown } from '../lib/visual-teardown.mjs';
import {
  readStarted, startedPath, addStartedPid, processIdentity, processInfo,
} from '../lib/visual-device.mjs';
import { mkCtx, sampleFeatureJson, SCRIPTS_DIR } from './helpers.mjs';

const FX = path.join(SCRIPTS_DIR, 'test', 'fixtures', 'visual-teardown');
const FEATURE = '2026-01-01-00h-00m-td';
const SIM = 'A1B2C3D4-E5F6-4789-ABCD-0123456789AB';
const EMU = 'emulator-5556';
const noSleep = async () => {};
const IDENTS = {
  424242: 'Mon Oct 19 10:00:01 2026',
  434343: 'Mon Oct 19 10:00:02 2026',
};

function project(t, { platform = 'ios', visual = {}, started = 'started-mixed.json' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visual-teardown-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featureDir = path.join(root, 'docs', 'features', FEATURE);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'feature.json'), JSON.stringify(
    sampleFeatureJson({ platform, has_ui: true, visual_tests: true, profile: { visual: { device: SIM, ...visual } } }),
  ));
  if (started) {
    fs.mkdirSync(path.dirname(startedPath(root)), { recursive: true });
    fs.copyFileSync(path.join(FX, started), startedPath(root));
  }
  return { root, featureDir, td: path.join(featureDir, 'verification', 'teardown.json') };
}

const DEV_FX = path.join(SCRIPTS_DIR, 'test', 'fixtures', 'visual-device');
const SIMCTL_LIST = fs.readFileSync(path.join(DEV_FX, 'simctl-booted.json'), 'utf8');
const ADB_ATTACHED = fs.readFileSync(path.join(DEV_FX, 'adb-attached.txt'), 'utf8');

/** Stub spawn: records argv (device queries separately); `fail(argv)` → exit code. */
function stubSpawn(fail = () => 0, { simctl = SIMCTL_LIST, adb = ADB_ATTACHED } = {}) {
  const calls = [];
  const queries = [];
  const spawn = (file, args, opts) => {
    const argv = [file, ...args];
    assert.notEqual(opts.shell, true);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const isQuery = (argv[1] === 'simctl' && argv[2] === 'list') || (argv[0] === 'adb' && argv[1] === 'devices');
    (isQuery ? queries : calls).push(argv);
    setImmediate(() => {
      if (isQuery) child.stdout.emit('data', Buffer.from(argv[0] === 'adb' ? adb : simctl));
      child.emit('close', isQuery ? 0 : fail(argv));
    });
    return child;
  };
  return { spawn, calls, queries };
}

/** Stub kill: a group dies on SIGTERM unless listed in `stubborn` (dies on SIGKILL). */
function stubKill(stubborn = []) {
  const alive = new Set([424242, 434343]);
  const sent = [];
  const identify = (pgid) => (alive.has(pgid) && IDENTS[pgid] ? { lstart: IDENTS[pgid], pgid } : null);
  const kill = (pid, sig) => {
    const g = -pid;
    if (!alive.has(g)) { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; }
    if (sig === 0) return true;
    sent.push([g, sig]);
    if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !stubborn.includes(g))) alive.delete(g);
    return true;
  };
  return { kill, sent, identify, alive };
}

const noRunSteps = async ({ argv }) => ({ status: 'PASSED', exitCode: 0, timedOut: false, output: '', argv });

async function go(p, deps) {
  const ctx = mkCtx({ cwd: p.root });
  const code = await runTeardown(['--feature', FEATURE], ctx, {
    sleep: noSleep, graceMs: 0, identify: () => null, spawn: stubSpawn().spawn, ...deps,
  });
  assert.equal(code, 0, ctx.err());
  return { ctx, doc: JSON.parse(fs.readFileSync(p.td, 'utf8')) };
}

function assertSafe(calls) {
  for (const argv of calls) {
    assert.ok(!(argv.includes('shutdown') && argv.includes('all')), `shutdown all: ${argv.join(' ')}`);
    if (argv.includes('emu') && argv.includes('kill')) {
      assert.deepEqual(argv.slice(0, 2), ['adb', '-s'], `emu kill without -s: ${argv.join(' ')}`);
    }
  }
}

test('AC15: exact argv for the simulator and the emulator, pgids killed, record emptied', async (t) => {
  const p = project(t);
  const { spawn, calls } = stubSpawn();
  const { kill, sent, identify } = stubKill();
  const { doc } = await go(p, { spawn, kill, identify, runStep: noRunSteps });
  assert.deepEqual(calls, [
    ['xcrun', 'simctl', 'shutdown', SIM],
    ['adb', '-s', EMU, 'emu', 'kill'],
  ]);
  assertSafe(calls);
  assert.deepEqual(sent, [[434343, 'SIGTERM'], [424242, 'SIGTERM']]);
  assert.ok(doc.steps.every((s) => s.ok), JSON.stringify(doc));
  assert.ok(doc.ts);
  assert.deepEqual(readStarted(p.root), { devices: [], pids: [] });
});

test('AC15: nothing recorded means nothing spawned, and teardown.json has no steps', async (t) => {
  const p = project(t, { started: null });
  const { spawn, calls } = stubSpawn();
  const { kill, sent } = stubKill();
  const { doc } = await go(p, { spawn, kill, runStep: noRunSteps });
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(doc.steps, []);
});

test('AC15: on web no xcrun or adb is spawned', async (t) => {
  const p = project(t, { platform: 'web' });
  const { spawn, calls } = stubSpawn();
  const { kill } = stubKill();
  await go(p, { spawn, kill, runStep: noRunSteps });
  assert.deepEqual(calls, []);
});

test('AC15: a tampered id is rejected, not spawned, and stays recorded', async (t) => {
  const p = project(t, { started: null });
  fs.mkdirSync(path.dirname(startedPath(p.root)), { recursive: true });
  fs.writeFileSync(startedPath(p.root), JSON.stringify({
    devices: [
      { kind: 'simulator', id: 'all', started_at: 'x' },
      { kind: 'emulator', id: '; rm -rf /', started_at: 'x' },
      { kind: 'simulator', id: SIM, started_at: 'x' },
    ],
    pids: [],
  }));
  const { spawn, calls } = stubSpawn();
  const { doc } = await go(p, { spawn, kill: stubKill().kill, runStep: noRunSteps });
  assert.deepEqual(calls, [['xcrun', 'simctl', 'shutdown', SIM]]);
  assert.equal(doc.steps.filter((s) => !s.ok).length, 2);
  assert.deepEqual(readStarted(p.root).devices.map((d) => d.id), ['all', '; rm -rf /']);
});

test('AC15: partial removal keeps the entries that failed', async (t) => {
  const p = project(t);
  const { spawn, calls } = stubSpawn((argv) => (argv[0] === 'xcrun' ? 1 : 0));
  const { kill, identify } = stubKill();
  const { doc } = await go(p, { spawn, kill, identify, runStep: noRunSteps });
  assert.equal(doc.steps.find((s) => s.name === 'simctl shutdown').ok, false);
  const left = readStarted(p.root);
  assert.deepEqual(left.devices.map((d) => d.id), [SIM]);
  assert.deepEqual(left.pids, []);
  assertSafe(calls);
});

test('AC15: a process that survives SIGTERM gets SIGKILL', async (t) => {
  const p = project(t);
  const { kill, sent, identify } = stubKill([434343]);
  await go(p, { spawn: stubSpawn().spawn, kill, identify, runStep: noRunSteps });
  assert.deepEqual(sent.filter(([g]) => g === 434343), [[434343, 'SIGTERM'], [434343, 'SIGKILL']]);
  assert.deepEqual(readStarted(p.root).pids, []);
});

test('AC15: a failing emu kill keeps the emulator when its group was not killed', async (t) => {
  const p = project(t);
  const { spawn } = stubSpawn((argv) => (argv[0] === 'adb' ? 1 : 0));
  // group 424242 cannot be signalled: kill throws a non-ESRCH error
  const { kill: real, identify } = stubKill();
  const kill = (pid, sig) => {
    if (pid === -424242) { const e = new Error('nope'); e.code = 'EPERM'; throw e; }
    return real(pid, sig);
  };
  const { doc } = await go(p, { spawn, kill, identify, runStep: noRunSteps, graceMs: 0 });
  assert.equal(doc.steps.find((s) => s.name === 'adb emu kill').ok, false);
  assert.deepEqual(readStarted(p.root).devices.map((d) => d.id), [EMU]);
});

test('AC15: kills a real sleeping process group', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  const child = nodeSpawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise((r) => child.on('close', r));
  addStartedPid(p.root, { name: 'serve', pgid: child.pid, ident: processIdentity(child.pid), started_at: 'x' });
  const { doc } = await go(p, {
    graceMs: 2000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), runStep: noRunSteps, identify: processInfo,
  });
  await exited;
  assert.ok(doc.steps[0].ok);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(readStarted(p.root).pids, []);
});

test('AC15: teardown commands run via runStep; a step that exits 1 gives exit 0 and ok:false', async (t) => {
  const p = project(t, { platform: 'web', started: null, visual: { teardown: ['docker compose down', 'echo done'] } });
  const seen = [];
  const runStep = async ({ argv, timeout_s }) => {
    seen.push({ argv, timeout_s });
    return argv[0] === 'docker'
      ? { status: 'FAILED', exitCode: 1, timedOut: false, output: '' }
      : { status: 'PASSED', exitCode: 0, timedOut: false, output: '' };
  };
  const { ctx, doc } = await go(p, { runStep });
  assert.deepEqual(seen, [
    { argv: ['docker', 'compose', 'down'], timeout_s: 60 },
    { argv: ['echo', 'done'], timeout_s: 60 },
  ]);
  assert.deepEqual(doc.steps.map((s) => [s.name, s.exit_code, s.ok]), [['teardown[0]', 1, false], ['teardown[1]', 0, true]]);
  assert.match(ctx.out(), /1 of 2 steps failed/);
});

test('AC15: a teardown command with shell syntax is refused and not run (invalid snapshot still tears down records)', async (t) => {
  const p = project(t, { platform: 'ios', visual: { teardown: ['echo hi; rm -rf /'] } });
  const seen = [];
  const { spawn, calls } = stubSpawn();
  const { kill, identify } = stubKill();
  const { doc } = await go(p, { spawn, kill, identify, runStep: async (a) => { seen.push(a); return { status: 'PASSED', exitCode: 0 }; } });
  assert.deepEqual(seen, []);
  assert.equal(doc.steps[0].name, 'visual config');
  assert.equal(doc.steps[0].ok, false);
  assert.deepEqual(calls, [['xcrun', 'simctl', 'shutdown', SIM], ['adb', '-s', EMU, 'emu', 'kill']]);
  assert.deepEqual(readStarted(p.root), { devices: [], pids: [] });
});

test('L7: a reused pid (other start time / not a group leader), self and pgid 1 are never signalled', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  fs.mkdirSync(path.dirname(startedPath(p.root)), { recursive: true });
  fs.writeFileSync(startedPath(p.root), JSON.stringify({
    devices: [],
    pids: [
      { name: 'serve', pgid: 434343, ident: 'Sun Jan  1 00:00:00 2026', started_at: 'x' }, // pid reused: other start time
      { name: 'other', pgid: 424242, ident: IDENTS[424242], started_at: 'x' }, // pid reused by a non-leader
      { name: 'legacy', pgid: 454545, started_at: 'x' }, // no ident: cannot verify
      { name: 'self', pgid: process.pid, ident: 'x', started_at: 'x' },
      { name: 'init', pgid: 1, ident: 'x', started_at: 'x' },
    ],
  }));
  const { kill, sent } = stubKill();
  const identify = (pgid) => (pgid === 434343 ? { lstart: IDENTS[434343], pgid } : pgid === 424242 ? { lstart: IDENTS[424242], pgid: 999 } : null);
  const { doc } = await go(p, { kill, identify, runStep: noRunSteps });
  assert.deepEqual(sent, [], 'no signal sent');
  assert.equal(doc.steps.length, 5);
  assert.ok(doc.steps.every((s) => !s.ok && /refused/.test(s.detail)), JSON.stringify(doc.steps));
  assert.match(doc.steps[0].detail, /another start time/);
  assert.match(doc.steps[1].detail, /does not lead the group/);
  assert.match(doc.steps[2].detail, /no recorded start time/);
  assert.deepEqual(readStarted(p.root).pids.map((x) => x.name), ['legacy'], 'reused pids dropped; unverifiable kept');
});

test('L7: a real group whose leader changes process.title is still killed', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  const child = nodeSpawn(process.execPath, ['-e', "process.title = 'npm exec renamed-server'; setTimeout(() => {}, 30000)"], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const exited = new Promise((r) => child.on('close', r));
  await new Promise((r) => setTimeout(r, 10));
  addStartedPid(p.root, { name: 'serve', pgid: child.pid, ident: processIdentity(child.pid), started_at: 'x' });
  await new Promise((r) => setTimeout(r, 300)); // the title rename has happened
  const { doc } = await go(p, { identify: processInfo, graceMs: 2000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), runStep: noRunSteps });
  await exited;
  assert.ok(doc.steps[0].ok, JSON.stringify(doc.steps));
  assert.deepEqual(readStarted(p.root).pids, []);
});

test('L7: an npm-exec-like rename (command line rewritten) is still killed (stub identity)', async (t) => {
  const p = project(t, { platform: 'web' });
  const { kill, sent, identify } = stubKill();
  const { doc } = await go(p, { kill, identify, runStep: noRunSteps });
  assert.deepEqual(sent.filter(([g]) => g === 434343), [[434343, 'SIGTERM']]);
  assert.ok(doc.steps[0].ok);
});

test('L7: a real group with a different start time survives teardown', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  const child = nodeSpawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  addStartedPid(p.root, { name: 'serve', pgid: child.pid, ident: 'Thu Jan  1 00:00:00 1970', started_at: 'x' });
  const { doc } = await go(p, { identify: processInfo, runStep: noRunSteps });
  assert.equal(doc.steps[0].ok, false);
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'still alive');
});

test('L7: a leaderless live group (leader exited, children remain) is killed', async (t) => {
  const p = project(t, { platform: 'web' });
  const { kill, sent } = stubKill();
  const { doc } = await go(p, { kill, identify: () => null, runStep: noRunSteps });
  assert.deepEqual(sent.filter(([g]) => g === 434343), [[434343, 'SIGTERM']]);
  assert.ok(doc.steps[0].ok);
  assert.deepEqual(readStarted(p.root).pids, []);
});

test('R2: a teardown command that is device-sensitive without {device} as its selector is refused and not run', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  const { teardown } = await import('../lib/visual-teardown.mjs');
  const seen = [];
  const visual = { device: EMU, teardown: ['adb uninstall com.x', 'adb -s R58M123ABC uninstall com.x', 'adb uninstall com.x -s {device}', 'adb -s {device} uninstall com.x'] };
  const res = await teardown({
    root: p.root, featureDir: p.featureDir, visual, platform: 'web',
    deps: { spawn: stubSpawn().spawn, runStep: async (a) => { seen.push(a); return { status: 'PASSED', exitCode: 0 }; }, identify: () => null },
  });
  assert.deepEqual(seen.map((a) => a.argv), [['adb', '-s', EMU, 'uninstall', 'com.x']], JSON.stringify(res.steps));
  assert.deepEqual(seen[0].env, { ANDROID_SERIAL: EMU }, 'B: ANDROID_SERIAL pins the emulator');
  assert.deepEqual(res.steps.map((s) => s.ok), [false, false, false, true]);
  assert.match(res.steps[0].detail, /device guard/);
});

test('A: teardown commands are refused when visual.device is not listed/attached (real phone UDID), zero command spawns', async (t) => {
  const p = project(t, { platform: 'ios', started: null });
  const { teardown } = await import('../lib/visual-teardown.mjs');
  const seen = [];
  const phone = 'FFFFFFFF-E5F6-4789-ABCD-0123456789AB'; // UDID format, not in simctl list
  const s = stubSpawn();
  const res = await teardown({
    root: p.root, featureDir: p.featureDir, platform: 'ios',
    visual: { device: phone, teardown: ['xcrun simctl uninstall {device} com.x', 'docker compose down'] },
    deps: { spawn: s.spawn, runStep: async (a) => { seen.push(a); return { status: 'PASSED', exitCode: 0 }; }, identify: () => null },
  });
  assert.deepEqual(seen, []);
  assert.deepEqual(s.calls, []);
  assert.ok(res.steps.every((x) => !x.ok && /device check/.test(x.detail)), JSON.stringify(res.steps));
  // the same commands run when the simulator is listed
  const ok = await teardown({
    root: p.root, featureDir: p.featureDir, platform: 'ios',
    visual: { device: SIM, teardown: ['xcrun simctl uninstall {device} com.x'] },
    deps: { spawn: stubSpawn().spawn, runStep: async (a) => { seen.push(a); return { status: 'PASSED', exitCode: 0 }; }, identify: () => null },
  });
  assert.deepEqual(seen.map((a) => a.argv), [['xcrun', 'simctl', 'uninstall', SIM, 'com.x']]);
  assert.deepEqual(seen[0].env, {});
  assert.ok(ok.steps.every((x) => x.ok));
});

test('E: --help documents the re-exec limitation', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  const ctx = mkCtx({ cwd: p.root });
  assert.equal(await runTeardown(['--help'], ctx), 0);
  assert.match(ctx.out(), /re-execs itself/);
});

test('nit: teardown self-ignores verification/ before writing teardown.json', async (t) => {
  const p = project(t, { platform: 'web', started: null });
  await go(p, { runStep: noRunSteps });
  assert.equal(fs.readFileSync(path.join(p.featureDir, 'verification', '.gitignore'), 'utf8'), '*\n');
});

