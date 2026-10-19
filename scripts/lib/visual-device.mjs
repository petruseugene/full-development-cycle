// Device lifecycle for `visual build` / `visual run` (spec R6 device start)
// and the started record that `visual teardown` (R13) consumes.
//
//   ensureDevice({visual, root, spawn, now, sleep}) → {kind, id, started, record?}
//   readStarted(root)                     → {devices:[…], pids:[…]}
//   addStartedDevice(root, entry)         → appended unless the id is recorded
//   addStartedPid(root, entry)            → appended unless the pgid is recorded
//   removeStarted(root, predicate)        → number of removed entries
//
// `.dev-cycle/cache/visual-started.json` (the folder self-ignores):
//
//   { "devices": [ { "kind": "simulator", "id": "<udid>", "started_at": "…" },
//                  { "kind": "emulator", "id": "emulator-5556", "pgid": 123, "started_at": "…" } ],
//     "pids":    [ { "name": "serve", "pgid": 456, "started_at": "…" } ] }
//
// Every recorded pgid also carries `ident`: the leader's start time (`ps -o
// lstart=`) taken right after the spawn. Teardown checks the leader still has
// that start time and still leads the group before any signal, so a stale
// (PID reused) record never kills someone else's group. The command line is
// not compared: npm/npx and process.title rewrite it.
//
// Safety: only a device the CLI itself booted or launched is recorded, and the
// record is written right after that boot/launch, before anything else is
// spawned. Every device id is re-validated (isValidDevice) before it becomes
// one argv element; nothing ever runs through a shell.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { FailedError, UsageError, atomicWrite, readText, resolveProjectRoot } from './core.mjs';
import { cacheDir, ensureSelfIgnore } from './visual-core.mjs';
import { AVD_RE, EMULATOR_RE, SIM_UDID_RE, isValidDevice } from './visual-profile.mjs';

export const STARTED_FILE = 'visual-started.json';
export const DEFAULT_BOOT_TIMEOUT_S = 120;
export const POLL_INTERVAL_S = 2;
/** Timeout for the short query/boot commands (simctl list/boot, adb devices). */
export const QUERY_TIMEOUT_S = 120;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPgid = (v) => Number.isInteger(v) && v > 0;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoOf(now) {
  const v = typeof now === 'function' ? now() : new Date();
  return v instanceof Date ? v.toISOString() : String(v);
}

function rootDir(root) {
  return typeof root === 'string' ? root : resolveProjectRoot(root);
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/**
 * Immutable facts about process `pid`: its start time (`lstart`) and its
 * process-group id, from `ps -o lstart=,pgid= -p <pid>` (C locale), or null
 * when there is no such process or ps fails. The command line is NOT used:
 * npm/npx and `process.title` rewrite it (lesson L7).
 * @param {number} pid
 * @returns {{lstart: string, pgid: number} | null}
 */
export function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const r = spawnSync('ps', ['-o', 'lstart=,pgid=', '-p', String(pid)], {
      encoding: 'utf8', shell: false, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    });
    const line = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim().replace(/\s+/g, ' ') : '';
    const m = /^(.+) (\d+)$/.exec(line);
    return m ? { lstart: m[1], pgid: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/**
 * Identity recorded for a process group we started: the leader's start time
 * (`lstart`), or null. Teardown signals the group only while its leader
 * still has this start time and still leads the group.
 * @param {number} pid
 * @returns {string|null}
 */
export function processIdentity(pid) {
  return processInfo(pid)?.lstart ?? null;
}

// ---------------------------------------------------------------------------
// Started record
// ---------------------------------------------------------------------------

/** Absolute path of the started record (does not create anything). */
export function startedPath(root) {
  return path.join(cacheDir(root), STARTED_FILE);
}

function parseStarted(text, file) {
  if (text === null || text.trim() === '') return { devices: [], pids: [] };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`invalid JSON in ${file}: ${err.message}`);
  }
  if (!isObj(obj)) throw new UsageError(`${file} must contain a JSON object`);
  const devices = Array.isArray(obj.devices) ? obj.devices.filter(isObj) : [];
  const pids = Array.isArray(obj.pids) ? obj.pids.filter(isObj) : [];
  return { ...obj, devices, pids };
}

/**
 * The started record. Missing file → `{devices: [], pids: []}`. Entries are
 * returned as stored (teardown re-validates every id before using it).
 * @param {string|import('./core.mjs').CliContext} root
 */
export function readStarted(root) {
  const dir = ensureSelfIgnore(cacheDir(root));
  const file = path.join(dir, STARTED_FILE);
  return parseStarted(readText(file, { optional: true }), file);
}

/** Read-modify-write with a re-read before rename; retried on a concurrent change. */
function mutateStarted(root, mutator) {
  const dir = ensureSelfIgnore(cacheDir(root));
  const file = path.join(dir, STARTED_FILE);
  for (let attempt = 0; ; attempt++) {
    const before = readText(file, { optional: true });
    const rec = parseStarted(before, file);
    const result = mutator(rec);
    if (result === false) return rec; // nothing changed
    try {
      atomicWrite(file, JSON.stringify(rec, null, 2) + '\n', { expected: before });
      return rec;
    } catch (err) {
      if (!(err instanceof UsageError) || attempt >= 4) throw err;
    }
  }
}

/**
 * Append a device entry unless one with the same id is already recorded.
 * @param {string|object} root
 * @param {{kind: 'simulator'|'emulator', id: string, pgid?: number, ident?: string, started_at: string}} entry
 * @returns {boolean} true when appended
 */
export function addStartedDevice(root, entry) {
  if (!isObj(entry) || !isValidDevice(entry.id)) {
    throw new UsageError(`refusing to record device ${JSON.stringify(entry?.id)}: not a simulator UDID or emulator-<n>`);
  }
  const kind = SIM_UDID_RE.test(entry.id) ? 'simulator' : 'emulator';
  if (entry.kind !== kind) throw new UsageError(`device ${entry.id} must be recorded with kind '${kind}'`);
  if (entry.pgid !== undefined && !isPgid(entry.pgid)) throw new UsageError(`invalid pgid ${JSON.stringify(entry.pgid)}`);
  let added = false;
  mutateStarted(root, (rec) => {
    if (rec.devices.some((d) => d.id === entry.id)) return false;
    rec.devices.push({ ...entry });
    added = true;
    return true;
  });
  return added;
}

/**
 * Append a process-group entry unless the same pgid is already recorded.
 * @param {string|object} root
 * @param {{name: string, pgid: number, ident?: string|null, started_at: string}} entry
 * @returns {boolean} true when appended
 */
export function addStartedPid(root, entry) {
  if (!isObj(entry) || !isPgid(entry.pgid)) throw new UsageError(`invalid pgid ${JSON.stringify(entry?.pgid)}`);
  if (typeof entry.name !== 'string' || entry.name === '') throw new UsageError('a started pid needs a name');
  let added = false;
  mutateStarted(root, (rec) => {
    if (rec.pids.some((p) => p.pgid === entry.pgid)) return false;
    rec.pids.push({ ...entry });
    added = true;
    return true;
  });
  return added;
}

/**
 * Remove every entry for which `predicate(entry, kind)` is true, where kind is
 * 'device' or 'pid'. Returns the number removed (nothing written when 0).
 * @param {string|object} root
 * @param {(entry: object, kind: 'device'|'pid') => boolean} predicate
 */
export function removeStarted(root, predicate) {
  let removed = 0;
  mutateStarted(root, (rec) => {
    removed = 0;
    const devices = rec.devices.filter((d) => !predicate(d, 'device'));
    const pids = rec.pids.filter((p) => !predicate(p, 'pid'));
    removed = rec.devices.length - devices.length + rec.pids.length - pids.length;
    if (removed === 0) return false;
    rec.devices = devices;
    rec.pids = pids;
    return true;
  });
  return removed;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * Run argv (no shell) and capture stdout. Never rejects.
 * @returns {Promise<{code: number|null, stdout: string, error?: string}>}
 */
function capture(spawn, argv, cwd, timeout_s = QUERY_TIMEOUT_S) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', error: err.message });
      return;
    }
    let out = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill?.('SIGKILL'); } catch { /* gone */ }
      finish({ code: null, stdout: out, error: `timed out after ${timeout_s}s` });
    }, timeout_s * 1000);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', () => {});
    child.on('error', (err) => finish({ code: null, stdout: out, error: err.message }));
    child.on('close', (code) => finish({ code, stdout: out }));
  });
}

const argvText = (argv) => argv.join(' ');

/** Throw unless `id` is a valid device id (re-validation before argv use). */
function checkedId(id) {
  if (!isValidDevice(id)) throw new UsageError(`refusing device id ${JSON.stringify(id)}: not a simulator UDID or emulator-<n>`);
  return id;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/** State of `udid` in `xcrun simctl list devices -j` output, or null when absent. */
export function simulatorState(json, udid) {
  let obj;
  try {
    obj = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new FailedError('xcrun simctl list devices -j returned invalid JSON');
  }
  const runtimes = isObj(obj?.devices) ? Object.values(obj.devices) : [];
  for (const list of runtimes) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((d) => isObj(d) && typeof d.udid === 'string' && d.udid.toUpperCase() === udid.toUpperCase());
    if (hit) return typeof hit.state === 'string' ? hit.state : null;
  }
  return null;
}

async function ensureSimulator({ id, cwd, spawn, now }) {
  const listArgv = ['xcrun', 'simctl', 'list', 'devices', '-j'];
  const list = await capture(spawn, listArgv, cwd);
  if (list.code !== 0) throw new FailedError(`${argvText(listArgv)} failed${list.error ? `: ${list.error}` : ` (exit ${list.code})`}`);
  const state = simulatorState(list.stdout, id);
  if (state === null) throw new UsageError(`simulator ${id} not found in simctl list: refusing (a physical device id is never listed there)`);
  if (state === 'Booted' || state === 'Booting') return { kind: 'simulator', id, started: false, state };
  if (state !== 'Shutdown') throw new FailedError(`simulator ${id} is '${state}'; retry when it is Booted or Shutdown`);

  const bootArgv = ['xcrun', 'simctl', 'boot', checkedId(id)];
  const boot = await capture(spawn, bootArgv, cwd);
  if (boot.code !== 0) throw new FailedError(`${argvText(bootArgv)} failed${boot.error ? `: ${boot.error}` : ` (exit ${boot.code})`}`);
  const record = { kind: 'simulator', id, started_at: isoOf(now) };
  addStartedDevice(cwd, record); // immediately: before any other spawn
  return { kind: 'simulator', id, started: true, record };
}

// ---------------------------------------------------------------------------
// Emulator
// ---------------------------------------------------------------------------

/** State of `serial` in `adb devices` output ('device', 'offline', …), or null. */
export function adbState(text, serial) {
  for (const line of String(text).split(/\r?\n/)) {
    const [name, state] = line.trim().split(/\s+/);
    if (name === serial) return state ?? '';
  }
  return null;
}

async function adbDevices(spawn, cwd) {
  const argv = ['adb', 'devices'];
  const r = await capture(spawn, argv, cwd);
  if (r.code !== 0) throw new FailedError(`${argvText(argv)} failed${r.error ? `: ${r.error}` : ` (exit ${r.code})`}`);
  return r.stdout;
}

async function waitAttached({ id, cwd, spawn, sleep, timeout_s, first }) {
  const attempts = Math.max(1, Math.ceil(timeout_s / POLL_INTERVAL_S));
  let state = first;
  for (let i = 0; i < attempts; i++) {
    if (state === 'device') return true;
    await sleep(POLL_INTERVAL_S * 1000);
    state = adbState(await adbDevices(spawn, cwd), id);
  }
  return state === 'device';
}

async function ensureEmulator({ id, visual, cwd, spawn, now, sleep, identify }) {
  const timeout_s = visual.boot_timeout_s ?? DEFAULT_BOOT_TIMEOUT_S;
  if (!(Number.isFinite(timeout_s) && timeout_s > 0)) throw new UsageError(`visual.boot_timeout_s must be a positive number (got ${JSON.stringify(timeout_s)})`);
  const state = adbState(await adbDevices(spawn, cwd), id);
  if (state !== null) {
    // Already there (maybe still coming up): not ours, so never recorded.
    if (!(await waitAttached({ id, cwd, spawn, sleep, timeout_s, first: state }))) {
      throw new FailedError(`emulator ${id} is listed by adb but not ready after ${timeout_s}s`);
    }
    return { kind: 'emulator', id, started: false, state: 'device' };
  }
  const avd = visual.avd;
  if (avd === undefined || avd === null || avd === '') throw new FailedError(`emulator not running: ${id} (set visual.avd to launch it)`);
  if (typeof avd !== 'string' || !AVD_RE.test(avd)) throw new UsageError(`visual.avd ${JSON.stringify(avd)} must match ${AVD_RE}`);
  const port = checkedId(id).slice('emulator-'.length);

  const argv = ['emulator', '-avd', avd, '-port', port];
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { shell: false, cwd, detached: true, stdio: 'ignore' });
  } catch (err) {
    throw new FailedError(`failed to launch ${argvText(argv)}: ${err.message}`);
  }
  child?.on?.('error', () => {}); // reported via the missing pid / attach timeout
  const pgid = child?.pid;
  if (!isPgid(pgid)) throw new FailedError(`failed to launch ${argvText(argv)}`);
  child.unref?.();
  const ident = identify(pgid);
  const record = { kind: 'emulator', id, pgid, ...(ident ? { ident } : {}), started_at: isoOf(now) };
  addStartedDevice(cwd, record); // immediately: before polling adb
  if (!(await waitAttached({ id, cwd, spawn, sleep, timeout_s, first: null }))) {
    throw new FailedError(`emulator ${id} did not attach within ${timeout_s}s (recorded for teardown)`);
  }
  return { kind: 'emulator', id, started: true, record };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Environment for every visual spawn (build, serve, run, teardown): when
 * visual.device is an emulator, ANDROID_SERIAL pins gradle/adb/cap/cordova/
 * detox to it (overriding an inherited value), whatever the tool list knows.
 * @param {Record<string, any>|null|undefined} visual
 * @returns {Record<string, string>}
 */
export function deviceEnv(visual) {
  const id = isObj(visual) ? visual.device : undefined;
  return typeof id === 'string' && EMULATOR_RE.test(id) ? { ANDROID_SERIAL: id } : {};
}

/**
 * Runtime check that `visual.device` is a simulator listed by
 * `xcrun simctl list devices -j` or an emulator attached in `adb devices`
 * (state 'device'). Nothing is booted or launched. A real phone whose id
 * happens to match the UDID format is never listed by simctl, so it is
 * refused. Throws UsageError (exit 2).
 * @returns {Promise<{kind: 'simulator'|'emulator', id: string, state: string}>}
 */
export async function verifyDevice({ visual, root, spawn = nodeSpawn } = {}) {
  const id = isObj(visual) ? visual.device : undefined;
  if (!isValidDevice(id)) {
    throw new UsageError(`visual.device ${JSON.stringify(id)} is not a simulator UDID (8-4-4-4-12 hex) or emulator-<n>`);
  }
  const cwd = rootDir(root);
  if (SIM_UDID_RE.test(id)) {
    const listArgv = ['xcrun', 'simctl', 'list', 'devices', '-j'];
    const list = await capture(spawn, listArgv, cwd);
    if (list.code !== 0) throw new UsageError(`cannot verify visual.device: ${argvText(listArgv)} failed${list.error ? `: ${list.error}` : ` (exit ${list.code})`}`);
    let state;
    try { state = simulatorState(list.stdout, id); } catch (err) { throw new UsageError(`cannot verify visual.device: ${err.message}`); }
    if (state === null) throw new UsageError(`simulator ${id} not found in simctl list: refusing (a physical device id is never listed there)`);
    return { kind: 'simulator', id, state };
  }
  let text;
  try { text = await adbDevices(spawn, cwd); } catch (err) { throw new UsageError(`cannot verify visual.device: ${err.message}`); }
  const state = adbState(text, id);
  if (state !== 'device') throw new UsageError(`emulator ${id} is not attached in adb devices (state ${JSON.stringify(state)}): refusing`);
  return { kind: 'emulator', id, state };
}

/**
 * Make sure `visual.device` is running (R6 device start). A device that is
 * already booted/attached is left alone and not recorded. A shut-down
 * simulator is booted, a missing emulator is launched from `visual.avd`;
 * either is recorded in visual-started.json before anything else is spawned.
 *
 * Throws UsageError (exit 2) for an invalid device/avd and FailedError (exit 1)
 * when the device cannot be started ("emulator not running" without avd).
 *
 * @param {object} p
 * @param {Record<string, any>} p.visual   the profile.visual block
 * @param {string|object} p.root           project root (or CliContext)
 * @param {Function} [p.spawn]             child_process.spawn-compatible test seam
 * @param {() => Date|string} [p.now]
 * @param {(ms: number) => Promise<void>} [p.sleep]  test seam for the attach poll
 * @param {(pid: number) => string|null} [p.identify]  test seam for processIdentity
 * @returns {Promise<{kind: 'simulator'|'emulator', id: string, started: boolean, record?: object, state?: string}>}
 */
export async function ensureDevice({
  visual, root, spawn = nodeSpawn, now, sleep = defaultSleep, identify = processIdentity,
} = {}) {
  if (!isObj(visual)) throw new UsageError('visual config is missing');
  const id = visual.device;
  if (!isValidDevice(id)) {
    throw new UsageError(`visual.device ${JSON.stringify(id)} is not a simulator UDID (8-4-4-4-12 hex) or emulator-<n>`);
  }
  const cwd = rootDir(root);
  if (!fs.existsSync(cwd)) throw new UsageError(`project root not found: ${cwd}`);
  if (SIM_UDID_RE.test(id)) return ensureSimulator({ id, cwd, spawn, now });
  if (EMULATOR_RE.test(id)) return ensureEmulator({ id, visual, cwd, spawn, now, sleep, identify });
  throw new UsageError(`unsupported device ${JSON.stringify(id)}`);
}
