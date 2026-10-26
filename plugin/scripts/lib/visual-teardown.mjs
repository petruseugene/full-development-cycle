// `dev-cycle visual teardown` (spec R13): stop only what `visual build` /
// `visual run` started, as recorded in `.dev-cycle/cache/visual-started.json`.
//
// Three phases, always all of them, each step independent of the others:
//   1. recorded process groups (`pids[]` and emulator `devices[].pgid`):
//      SIGTERM to the group, SIGKILL after a grace period (default 5 s) —
//      only after verifyGroup: the leader still leads the group with the
//      start time recorded at spawn (`ident`), or the leader exited and its
//      children remain. A pid reused by another process is refused, reported
//      and dropped; a missing ident is refused and kept; pgid <= 1 and our own
//      pid are never signalled. Accepted limitation: a server that moves to a
//      new process group (setsid/re-exec into its own group) is not tracked;
//   2. recorded devices: `xcrun simctl shutdown <udid>` /
//      `adb -s <serial> emu kill`, each id re-validated with isValidDevice;
//   3. every `visual.teardown` command through runStep (60 s timeout), after
//      the same grammar check and device guard as the profile (R2), with
//      ANDROID_SERIAL=<emulator> in its environment. When visual.device is
//      set, it is verified first (verifyDevice: listed by simctl / attached
//      in adb) before any of the three phases; when that fails, no teardown
//      command runs (each is a failed step).
//
// Entries that were stopped are removed from the record, failed ones stay.
// `verification/teardown.json` is always written ({ts, steps:[…]}) and the
// command exits 0: the verdict turns a failed step into FAILED.
//
// Safety: a device that was already running is never recorded, so it is never
// touched; no `shutdown all`, no `emu kill` without `-s`, no shell; a pgid is
// signalled only when its leader still matches the recorded identity.

import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  UsageError, atomicWrite, output, parseCommandArgs, resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import { ensureSelfIgnore, loadVisualConfig, verificationDir } from './visual-core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import {
  deviceGuardProblems, isValidDevice, SIM_UDID_RE, EMULATOR_RE, visualCmdProblems,
} from './visual-profile.mjs';
import {
  deviceEnv, processInfo, readStarted, removeStarted, verifyDevice,
} from './visual-device.mjs';
import { buildArgv } from './recipe.mjs';
import { runStep as defaultRunStep } from './runner.mjs';

export const KILL_GRACE_MS = 5000;
export const KILL_POLL_MS = 50;
export const DEVICE_CMD_TIMEOUT_S = 60;
export const STEP_TIMEOUT_S = 60;
export const TEARDOWN_FILE = 'teardown.json';

const isPgid = (v) => Number.isInteger(v) && v > 1 && v !== process.pid;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groupAlive(kill, pgid) {
  try { kill(-pgid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/**
 * Whether recorded group `entry.pgid` is still the one we started (lesson L7).
 * Only immutable facts are compared: the leader (pid == pgid) must still
 * lead the group and have the recorded start time (`ident`). The command line
 * is not compared (npm/npx/process.title rewrite it).
 *   - leader alive, same start time, pgid == pid → ours: kill;
 *   - leader alive, other start time or no longer a group leader → the pid
 *     was reused, so our group is gone (a pgid is never reused while its
 *     group exists): refused, reported, dropped;
 *   - no leader, group alive → the leader exited but its children remain in
 *     our group (the pgid cannot have been reused while they exist): kill;
 *   - no leader, no group → already gone;
 *   - no recorded ident → cannot verify: refused, reported and KEPT.
 * @returns {{ok: true} | {ok: false, gone?: boolean, foreign?: boolean, detail: string}}
 */
function verifyGroup(entry, { kill, identify }) {
  const { pgid } = entry;
  if (!isPgid(pgid)) return { ok: false, foreign: true, detail: `refused: invalid pgid ${JSON.stringify(pgid)}` };
  if (typeof entry.ident !== 'string' || entry.ident === '') {
    return { ok: false, detail: 'refused: no recorded start time, so the group cannot be verified as ours (entry kept)' };
  }
  const info = identify(pgid);
  if (info === null) {
    return groupAlive(kill, pgid) ? { ok: true } : { ok: false, gone: true, detail: 'already gone' };
  }
  if (info.pgid !== pgid) {
    return { ok: false, foreign: true, detail: 'refused: pid now belongs to a process that does not lead the group (pid reused; ours is gone)' };
  }
  if (info.lstart !== entry.ident) {
    return { ok: false, foreign: true, detail: 'refused: the group leader has another start time (pid reused; ours is gone)' };
  }
  return { ok: true };
}

/**
 * Verify, then SIGTERM a process group, SIGKILL it when it is still there after `graceMs`.
 * @returns {Promise<{ok: boolean, drop?: boolean, detail?: string}>}
 */
async function killGroup({ entry, kill, identify, sleep, graceMs, pollMs }) {
  const pgid = entry.pgid;
  const v = verifyGroup(entry, { kill, identify });
  if (v.gone) return { ok: true, detail: v.detail };
  if (!v.ok) return { ok: false, drop: Boolean(v.foreign), detail: v.detail };
  try {
    kill(-pgid, 'SIGTERM');
  } catch (err) {
    if (err?.code !== 'ESRCH') return { ok: false, detail: `SIGTERM failed: ${err?.message}` };
  }
  for (let waited = 0; waited < graceMs && groupAlive(kill, pgid); waited += pollMs) await sleep(pollMs);
  if (groupAlive(kill, pgid)) {
    try {
      kill(-pgid, 'SIGKILL');
    } catch (err) {
      if (err?.code !== 'ESRCH') return { ok: false, detail: `SIGKILL failed: ${err?.message}` };
    }
    for (let i = 0; i < 40 && groupAlive(kill, pgid); i++) await sleep(pollMs);
    if (groupAlive(kill, pgid)) return { ok: false, detail: 'process group still alive after SIGKILL' };
  }
  return { ok: true };
}

/** Run argv without a shell; never rejects. */
function runArgv(spawn, argv, cwd, timeout_s = DEVICE_CMD_TIMEOUT_S) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, cwd, stdio: 'ignore' });
    } catch (err) {
      resolve({ code: null, error: err.message });
      return;
    }
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill?.('SIGKILL'); } catch { /* gone */ }
      finish({ code: null, error: `timed out after ${timeout_s}s` });
    }, timeout_s * 1000);
    child.on('error', (err) => finish({ code: null, error: err.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * Tear down everything recorded for the project. Never throws for a failing
 * step; the steps array says what happened.
 * @param {object} p
 * @param {string} p.root
 * @param {string} p.featureDir
 * @param {Record<string, any>|null} p.visual
 * @param {string} [p.platform]
 * @param {string} [p.configError]  why the visual config was refused (a failed step; no teardown commands run)
 * @param {object} [p.deps]  test seams: spawn, kill, sleep, runStep, graceMs, pollMs, now, identify
 * @returns {Promise<{ts: string, steps: Array<{name: string, exit_code: number|null, ok: boolean, detail?: string}>}>}
 */
export async function teardown({ root, featureDir, visual, platform = 'web', configError, deps = {} }) {
  const {
    spawn = nodeSpawn, kill = process.kill.bind(process), sleep = defaultSleep,
    runStep = defaultRunStep, graceMs = KILL_GRACE_MS, pollMs = KILL_POLL_MS,
    now = () => new Date(), identify = processInfo,
  } = deps;
  const verDir = ensureSelfIgnore(path.resolve(verificationDir(featureDir)));
  const steps = [];
  const add = (name, ok, exit_code = null, detail) => {
    steps.push({ name, exit_code, ok, ...(detail ? { detail } : {}) });
    return ok;
  };
  if (configError) add('visual config', false, null, `refused: ${configError}`);
  const cmds = Array.isArray(visual?.teardown) ? visual.teardown : [];
  // Runtime device check before anything is spawned (only needed for commands).
  let deviceRefusal = null;
  if (cmds.length && visual?.device !== undefined) {
    try {
      await verifyDevice({ visual, root, spawn });
    } catch (err) {
      deviceRefusal = err.message;
    }
  }
  const env = deviceEnv(visual);
  const rec = readStarted(root);
  const okPids = new Set(); // pgids stopped (or not ours: dropped)
  const okDevices = new Set(); // device ids fully stopped
  const pgidOk = new Map(); // device id → its pgid kill succeeded
  const pgidLabel = (v) => (Number.isInteger(v) ? v : JSON.stringify(v));

  // Phase 1: process groups (verified as ours first).
  for (const p of rec.pids) {
    const r = await killGroup({ entry: p, kill, identify, sleep, graceMs, pollMs });
    const label = typeof p.name === 'string' && /^[\w.-]{1,64}$/.test(p.name) ? p.name : 'process';
    if (add(`kill ${label} (pgid ${pgidLabel(p.pgid)})`, r.ok, null, r.detail) || r.drop) okPids.add(p.pgid);
  }
  for (const d of rec.devices) {
    if (d.pgid === undefined) continue;
    const r = await killGroup({ entry: d, kill, identify, sleep, graceMs, pollMs });
    // a pgid that is not ours (r.drop) leaves nothing of ours to kill in that group
    pgidOk.set(d.id, add(`kill emulator group (pgid ${pgidLabel(d.pgid)})`, r.ok, null, r.detail) || Boolean(r.drop));
  }

  // Phase 2: devices (never on web, never an unrecorded device).
  for (const d of platform === 'web' ? [] : rec.devices) {
    const id = d.id;
    if (!isValidDevice(id)) {
      add(`device ${JSON.stringify(String(id)).slice(0, 40)}`, false, null, 'refused: not a simulator UDID or emulator-<n>');
      continue;
    }
    let argv;
    let name;
    if (SIM_UDID_RE.test(id)) {
      argv = ['xcrun', 'simctl', 'shutdown', id];
      name = 'simctl shutdown';
    } else if (EMULATOR_RE.test(id)) {
      argv = ['adb', '-s', id, 'emu', 'kill'];
      name = 'adb emu kill';
    } else {
      add(`device ${id}`, false, null, 'unsupported device id');
      continue;
    }
    const r = await runArgv(spawn, argv, root);
    let ok = r.code === 0;
    let detail = r.error;
    if (!ok && argv[0] === 'adb' && pgidOk.get(id) === true) {
      ok = true; // the emulator process group is already gone, so adb has nothing to kill
      detail = 'emulator already stopped';
    }
    if (add(name, ok, r.code, detail) && (d.pgid === undefined || pgidOk.get(id) === true)) okDevices.add(id);
  }

  // Phase 3: user teardown commands.
  for (let i = 0; i < cmds.length; i++) {
    const name = `teardown[${i}]`;
    let argv;
    try {
      if (deviceRefusal) throw new Error(`device check: ${deviceRefusal}`);
      const problems = visualCmdProblems(cmds[i]);
      if (problems.length) throw new Error(problems[0]);
      const guard = deviceGuardProblems(cmds[i], visual);
      if (guard.length) throw new Error(`device guard: ${guard.join('; ')}`);
      const values = { out: verDir };
      if (visual?.device !== undefined) {
        if (!isValidDevice(visual.device)) throw new Error('visual.device is not a simulator UDID or emulator-<n>');
        values.device = visual.device;
      }
      argv = buildArgv(cmds[i], values);
    } catch (err) {
      add(name, false, null, `refused: ${err.message}`);
      continue;
    }
    let res;
    try {
      res = await runStep({ argv, timeout_s: STEP_TIMEOUT_S, featureDir, root, env });
    } catch (err) {
      add(name, false, null, err.message);
      continue;
    }
    add(name, res.status === 'PASSED', res.exitCode, res.timedOut ? `timed out after ${STEP_TIMEOUT_S}s` : undefined);
  }

  // Keep failed entries, drop the stopped ones.
  if (okPids.size || okDevices.size) {
    removeStarted(root, (e, kind) => (kind === 'pid' ? okPids.has(e.pgid) : okDevices.has(e.id)));
  }
  const ts = (() => { const v = now(); return v instanceof Date ? v.toISOString() : String(v); })();
  const result = { ts, steps };
  atomicWrite(path.join(ensureSelfIgnore(verDir), TEARDOWN_FILE), JSON.stringify(result, null, 2) + '\n');
  return result;
}

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export const HELP = `usage: dev-cycle visual teardown [--json] [--feature <dir>]

Stops only what visual build/run started (.dev-cycle/cache/visual-started.json):
  1. recorded process groups, after checking the leader still leads the group
     with the start time recorded at spawn (a reused pid is never signalled);
  2. recorded simulators/emulators (xcrun simctl shutdown / adb -s <id> emu kill);
  3. visual.teardown commands (argv, no shell, device guard; visual.device is
     verified first; ANDROID_SERIAL=<emulator> in their environment).
Writes verification/teardown.json and exits 0; failed steps fail the verdict.
Limitation: a server that re-execs itself into a new process group after
start may not be tracked by teardown.
`;

export async function run(argv, ctx, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write(HELP);
    return 0;
  }
  const { values } = parseCommandArgs(argv, { usage: 'visual teardown' });
  const featureDir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  let visual = null;
  let platform;
  let configError;
  try {
    ({ visual, platform } = loadVisualConfig(ctx, featureDir));
  } catch (err) {
    // An invalid visual config must not block stopping what we recorded:
    // phases 1-2 still run, no teardown command does, and the step fails.
    if (!(err instanceof UsageError)) throw err;
    configError = err.message.split('\n')[0];
    try { platform = readFeatureJson(featureDir).platform; } catch { platform = undefined; }
    if (typeof platform !== 'string') platform = 'unknown';
  }
  const res = await teardown({ root, featureDir, visual, platform, configError, deps });
  const failed = res.steps.filter((s) => !s.ok);
  const lines = res.steps.map((s) => `${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  lines.push(failed.length
    ? `teardown: ${failed.length} of ${res.steps.length} steps failed`
    : `teardown: ${res.steps.length} steps done`);
  output(ctx, values, { text: lines, data: res });
  return 0;
}
