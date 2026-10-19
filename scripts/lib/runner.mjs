// Command runner shared by `gate run`, `post-merge run`, `check` and `recipe run`.
//
// Security notes:
//   - Shell mode (`cmd`): the command string is the profile string, passed
//     verbatim to the shell. No-shell mode (`argv`, used by `recipe run`): the
//     program is spawned with shell: false and every element is passed as one
//     argument, verbatim — nothing is parsed, expanded or quoted.
//     The feature dir travels only in env DEV_CYCLE_FEATURE_DIR.
//   - Combined stdout+stderr goes straight to a log file descriptor (no pipes),
//     so a leaked grandchild can never keep us waiting after a kill.
//   - On timeout the whole process group is killed (the child is detached).
//   - Nothing here reads or prints the environment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { UsageError, parseCommandArgs, resolveFeatureDir, resolveFeatureForWrite, resolveProjectRoot } from './core.mjs';

export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 86400;
export const STEP_NAME_RE = /^[a-z0-9-]+$/;
/** Upper bound (bytes) of the output tail runStep reads back after a run. */
export const OUTPUT_TAIL_BYTES = 1024 * 1024;

const KILL_POLL_MS = 25;
const KILL_DEADLINE_MS = 5000;

// --- active process groups: killed if the CLI is interrupted or exits -------
const active = new Set();
let handlersInstalled = false;

function killGroup(pid, sig = 'SIGKILL') {
  try { process.kill(-pid, sig); return true; } catch { return false; }
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}
function killAllActive() {
  for (const pid of active) killGroup(pid);
}
const onExit = () => killAllActive();
const onSignal = (sig) => {
  killAllActive();
  uninstallHandlers();
  process.kill(process.pid, sig); // re-raise with default disposition
};
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', onExit);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
}
function uninstallHandlers() {
  if (!handlersInstalled) return;
  handlersInstalled = false;
  process.off('exit', onExit);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}
function track(pid) {
  if (typeof pid !== 'number') return;
  active.add(pid);
  installHandlers();
}
function untrack(pid) {
  active.delete(pid);
  if (active.size === 0) uninstallHandlers();
}

/** Readable one-line form of an argv for the echo line: plain words as-is, others JSON-quoted. */
export function formatArgv(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_./:,+@%=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

/**
 * Run one command with a timeout and log its combined output.
 * Give either `cmd` (run through the shell) or `argv` (spawned without a shell).
 * The combined output always goes to a file descriptor (never a pipe): the
 * given `logPath`, or a private temp file removed after the run when no log
 * is wanted. The last OUTPUT_TAIL_BYTES of that output (without the echoed
 * command line) are returned as `output`.
 * On timeout the whole process group is SIGKILLed and re-killed until the
 * group is verifiably gone, so no background grandchild survives.
 * @param {object} p
 * @param {string} [p.cmd]  profile command, verbatim, run through the shell
 * @param {string[]} [p.argv]  [program, ...args], spawned with shell: false
 * @param {number} [p.timeout_s]  1..MAX_TIMEOUT_S, default 600
 * @param {string} [p.logPath]  absolute log file (parent dirs are created); omitted = not logged
 * @param {string} p.featureDir  absolute feature folder
 * @param {string} p.root  project root (cwd of the command)
 * @param {Record<string, string>} [p.env]  extra environment (overrides the inherited values)
 * @param {Function} [p.spawn]  test seam: called as spawn(cmd, opts) in shell mode, spawn(file, args, opts) in argv mode
 * @param {{write(s: string): unknown}} [p.stdout]  receives the echoed command line
 * @returns {Promise<{status: 'PASSED'|'FAILED', exitCode: number|null, timedOut: boolean, duration_s: number, output: string}>}
 */
export function runStep({ cmd, argv, timeout_s = DEFAULT_TIMEOUT_S, logPath, featureDir, root, spawn = nodeSpawn, stdout, env }) {
  if (argv !== undefined) {
    if (cmd !== undefined) throw new UsageError('give either a step command or an argv, not both');
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || argv[0] === '') {
      throw new UsageError('step argv must be a non-empty array of strings without NUL');
    }
  } else if (typeof cmd !== 'string' || cmd.trim() === '') throw new UsageError('step command must be a non-empty string');
  if (!Number.isFinite(timeout_s) || timeout_s <= 0 || timeout_s > MAX_TIMEOUT_S) {
    throw new UsageError(`timeout_s must be a number between 1 and ${MAX_TIMEOUT_S} (got ${timeout_s})`);
  }
  let tmpDir = null;
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } else {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-step-'));
  }
  const outPath = logPath || path.join(tmpDir, 'output.log');
  const fd = fs.openSync(outPath, 'w+', logPath ? 0o666 : 0o600);
  const started = Date.now();
  const echo = `$ ${argv ? formatArgv(argv) : cmd}\n`;
  const outStart = fs.writeSync(fd, echo);
  stdout?.write(echo);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let pid;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) untrack(pid);
      const output = readTail(fd, outStart);
      if (timedOut) fs.writeSync(fd, `\n[dev-cycle] timed out after ${timeout_s}s; process group killed\n`);
      fs.closeSync(fd);
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      resolve({
        status: !timedOut && exitCode === 0 ? 'PASSED' : 'FAILED',
        exitCode,
        timedOut,
        duration_s: Math.round((Date.now() - started) / 1000),
        output,
      });
    };

    let child;
    try {
      const opts = {
        shell: !argv,
        cwd: root,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ...(env ?? {}), DEV_CYCLE_FEATURE_DIR: featureDir },
      };
      child = argv ? spawn(argv[0], argv.slice(1), opts) : spawn(cmd, opts);
    } catch (err) {
      fs.writeSync(fd, `[dev-cycle] failed to start: ${err.message}\n`);
      finish(null);
      return;
    }
    pid = child.pid;
    track(pid);
    let exitCode = null;
    let closed = false;
    child.on('error', (err) => {
      try { fs.writeSync(fd, `[dev-cycle] failed to start: ${err.message}\n`); } catch { /* closed */ }
      closed = true;
      if (!timedOut) finish(null);
    });
    child.on('close', (code) => {
      exitCode = code;
      closed = true;
      if (!timedOut) finish(code);
    });

    timer = setTimeout(() => {
      timedOut = true;
      const deadline = Date.now() + KILL_DEADLINE_MS;
      // Kill, then poll until the group is gone, killing again each round
      // (a fork racing the first signal can otherwise escape it).
      const sweep = () => {
        if (typeof pid !== 'number') { try { child.kill('SIGKILL'); } catch { /* gone */ } }
        else killGroup(pid);
        const dead = typeof pid !== 'number' || !groupAlive(pid);
        if ((dead && closed) || Date.now() >= deadline) { finish(exitCode); return; }
        if (dead && !closed) { setTimeout(sweep, KILL_POLL_MS); return; }
        setTimeout(sweep, KILL_POLL_MS);
      };
      sweep();
    }, timeout_s * 1000);
  });
}

/** Read at most OUTPUT_TAIL_BYTES of `fd` from `start` to its end. */
function readTail(fd, start) {
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(start, size - OUTPUT_TAIL_BYTES);
    const len = size - from;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, from);
    let text = buf.subarray(0, n).toString('utf8');
    // a cut in the middle of the stream drops the partial first line
    if (from > start) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  }
}

/**
 * Shared driver for `gate run` / `post-merge run`.
 * `closedAsNull` (gate run): featureDir is null when no usable feature folder
 * resolves (none, or an auto-detected closed one).
 * @returns {{values: any, name?: string, featureDir: string|null, root: string}}
 */
export function selectSteps(argv, ctx, { usage, key, label, extraOptions = {}, closedAsNull = false }) {
  const { values, args } = parseCommandArgs(argv, {
    usage,
    options: { all: { type: 'boolean' }, ...extraOptions },
    positionals: ['sub', 'name?'],
  });
  if (args.sub !== 'run') throw new UsageError(`unknown subcommand '${args.sub}' (usage: dev-cycle ${usage})`);
  if (!values.all && !args.name) throw new UsageError(`give a ${label} name or --all (usage: dev-cycle ${usage})`);
  if (values.all && args.name) throw new UsageError(`give either a ${label} name or --all, not both (usage: dev-cycle ${usage})`);

  const featureDir = closedAsNull ? resolveFeatureForWrite(ctx, values) : resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  return { values, name: args.name, featureDir, root, key };
}

/** Validate and pick steps from a profile list. */
export function pickSteps(list, name, all, label) {
  const steps = Array.isArray(list) ? list : [];
  for (const s of steps) {
    if (!s || typeof s.name !== 'string' || !STEP_NAME_RE.test(s.name)) {
      throw new UsageError(`invalid ${label} name in feature.json profile (must match [a-z0-9-]+)`);
    }
  }
  if (all) return steps;
  const hit = steps.find((s) => s.name === name);
  if (!hit) throw new UsageError(`unknown ${label} '${name}'`);
  return [hit];
}
