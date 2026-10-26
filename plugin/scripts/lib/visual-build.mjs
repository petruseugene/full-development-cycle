// `dev-cycle visual build [--force]` — build once, serve detached (spec R6, AC2, AC5, AC15).
//
//   1. Device guard: deviceGuardProblems on build.cmd and build.serve; a
//      problem (or a {device} placeholder without a valid visual.device) is a
//      UsageError (exit 2) before anything is spawned.
//   2. Device start + runtime check: whenever visual.device is set (or a
//      command is device-sensitive), ensureDevice boots or launches it first
//      (recorded in visual-started.json before the next spawn) and refuses a
//      device that simctl does not list / adb does not attach (exit 2), so a
//      real phone id never reaches a spawn. Every spawn gets
//      ANDROID_SERIAL=<visual.device> when it is an emulator.
//   3. Build: SHA-256 over the sorted paths matched by build.inputs plus their
//      contents. build.cmd runs (argv, no shell) when the hash differs from
//      .dev-cycle/cache/visual-build.json, on --force, or when there is no
//      cache (also when build.inputs is empty: nothing to hash). The hash is
//      stored only on exit 0; a failure sets manifest.build.status 'failed'
//      and exits 1.
//   4. Serve: build.serve is spawned detached (own process group) with
//      stdout/stderr to verification/serve.log, then {name:'serve', pgid, ident}
//      is recorded for teardown (ident = the leader's ps start time + command,
//      which teardown re-checks before any signal).
//
// `{out}` is the absolute path of the feature's verification/ folder, which is
// self-ignored before anything is written to it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  FailedError, UsageError, atomicWrite, output, parseCommandArgs, readText,
  resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import { buildArgv } from './recipe.mjs';
import { parseRecipeCmd } from './recipe-safety.mjs';
import { runStep } from './runner.mjs';
import {
  cacheDir, ensureSelfIgnore, loadVisualConfig, updateManifest, verificationDir,
} from './visual-core.mjs';
import {
  deviceEnv, ensureDevice, addStartedPid, processIdentity, readStarted,
} from './visual-device.mjs';
import {
  deviceGuardProblems, isDeviceSensitive, isValidDevice, visualCmdProblems,
} from './visual-profile.mjs';

const USAGE = 'visual build [--force] [--json] [--feature <dir>]';
export const HELP = `usage: dev-cycle ${USAGE}

Builds once (build.cmd, content-hash cache over build.inputs; --force rebuilds)
and starts build.serve detached, recording its process group for teardown.
Before any spawn, visual.device (when set) is booted/launched if needed and
verified: a simulator listed by xcrun simctl or an attached emulator-<n>;
anything else is refused (exit 2). With an emulator, every command runs with
ANDROID_SERIAL=<visual.device>. {out} is the absolute path of the feature's
verification/ folder.
Limitation: teardown tracks the serve process group by its leader's start
time; a server that re-execs itself into a new process group after start
may not be tracked by teardown.
`;
export const CACHE_FILE = 'visual-build.json';
export const BUILD_TIMEOUT_S = 1800;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/** Files matched by `inputs` (inside root, regular files), sorted, as posix relative paths. */
export function matchInputs(root, inputs) {
  const found = new Set();
  for (const pattern of inputs) {
    if (typeof pattern !== 'string' || pattern === '' || path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
      throw new UsageError(`visual.build.inputs: '${pattern}' must be a relative glob without '..'`);
    }
    for (const rel of fs.globSync(pattern, { cwd: root })) {
      let st;
      try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
      if (st.isFile()) found.add(rel.split(path.sep).join('/'));
    }
  }
  return [...found].sort();
}

/** SHA-256 over the sorted matched paths plus their contents. */
export function hashInputs(root, files) {
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function readCache(root) {
  const text = readText(path.join(cacheDir(root), CACHE_FILE), { optional: true });
  if (text === null) return null;
  try {
    const obj = JSON.parse(text);
    return isObj(obj) && typeof obj.hash === 'string' ? obj : null;
  } catch { return null; }
}

function writeCache(root, hash, iso) {
  const dir = ensureSelfIgnore(cacheDir(root));
  atomicWrite(path.join(dir, CACHE_FILE), JSON.stringify({ hash, ts: iso }, null, 2) + '\n');
}

/** Spawn `argv` detached into `logPath`; returns the process-group id. */
function spawnDetached({ argv, root, featureDir, logPath, spawn, env = {} }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...env, DEV_CYCLE_FEATURE_DIR: featureDir },
    });
  } catch (err) {
    throw new FailedError(`failed to start build.serve: ${err.message}`);
  } finally {
    fs.closeSync(fd);
  }
  child?.on?.('error', () => {}); // reported via the missing pid
  const pgid = child?.pid;
  if (!Number.isInteger(pgid) || pgid <= 0) throw new FailedError('failed to start build.serve (no pid)');
  child.unref?.();
  return pgid;
}

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{spawn?: Function, now?: () => Date, sleep?: Function, identify?: Function}} [deps]
 */
export async function runWith(argv, ctx, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write(HELP);
    return 0;
  }
  const now = deps.now ?? (() => new Date());
  const identify = deps.identify ?? processIdentity;
  const { values } = parseCommandArgs(argv, { usage: USAGE, options: { force: { type: 'boolean' } } });
  const featureDir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  const { visual } = loadVisualConfig(ctx, featureDir);
  if (!isObj(visual)) throw new UsageError('visual build: no profile.visual config');
  const build = isObj(visual.build) ? visual.build : {};
  const cmds = [['build.cmd', build.cmd], ['build.serve', build.serve]].filter(([, c]) => c !== undefined);
  if (cmds.length === 0) {
    output(ctx, values, { text: 'visual build: nothing to do (no build.cmd or build.serve)', data: { status: 'none' } });
    return 0;
  }

  // 1. Device guard — before any spawn (AC2).
  const problems = [];
  let sensitive = false;
  for (const [name, cmd] of cmds) {
    for (const p of visualCmdProblems(cmd)) problems.push(`visual.${name}: ${p}`);
    if (typeof cmd !== 'string') continue;
    for (const p of deviceGuardProblems(cmd, visual)) problems.push(`visual.${name} ${p}`);
    const { words } = parseRecipeCmd(cmd);
    if (isDeviceSensitive(words)) sensitive = true;
    if (words.some((w) => w.ph === 'device') && !isValidDevice(visual.device)) {
      problems.push(`visual.${name} uses {device} but visual.device is not a simulator UDID or emulator-<n>`);
    }
  }
  if (problems.length) throw new UsageError(`visual build refused:\n  ${[...new Set(problems)].join('\n  ')}`);

  const vdir = path.resolve(verificationDir(featureDir));
  const subst = { device: typeof visual.device === 'string' ? visual.device : '', out: vdir, screen: '' };
  const buildCmdArgv = build.cmd !== undefined ? buildArgv(build.cmd, subst) : null;
  const serveArgv = build.serve !== undefined ? buildArgv(build.serve, subst) : null;

  ensureSelfIgnore(vdir); // before build.log / serve.log land there

  // 2. Device start.
  const lines = [];
  const hasDevice = visual.device !== undefined && visual.device !== null && visual.device !== '';
  if (sensitive || hasDevice) {
    const dev = await ensureDevice({ visual, root, spawn, now, sleep: deps.sleep, identify });
    lines.push(`device ${dev.id}: ${dev.started ? 'started' : 'already running'}`);
  }

  // 3. Build with content-hash cache.
  let status = 'none';
  let hash;
  const logRel = 'build.log';
  if (buildCmdArgv) {
    const inputs = Array.isArray(build.inputs) ? build.inputs : [];
    hash = inputs.length ? hashInputs(root, matchInputs(root, inputs)) : null;
    const cached = readCache(root);
    if (!values.force && hash !== null && cached?.hash === hash) {
      status = 'cached';
      lines.push('build cached');
    } else {
      const res = await runStep({
        argv: buildCmdArgv, timeout_s: BUILD_TIMEOUT_S, logPath: path.join(vdir, logRel),
        featureDir, root, spawn, stdout: ctx.stdout, env: deviceEnv(visual),
      });
      const iso = now().toISOString();
      if (res.status !== 'PASSED') {
        updateManifest(featureDir, (m) => { m.build = { status: 'failed', ...(hash ? { hash } : {}), ts: iso, log: logRel }; });
        throw new FailedError(`visual build: build.cmd failed (${res.timedOut ? 'timed out' : `exit ${res.exitCode}`}); see verification/${logRel}`);
      }
      if (hash !== null) writeCache(root, hash, iso);
      status = 'built';
      lines.push('build ok');
    }
    const iso = now().toISOString();
    updateManifest(featureDir, (m) => { m.build = { status, ...(hash ? { hash } : {}), ts: iso, log: logRel }; });
  }

  // 4. Serve, detached.
  let pgid = null;
  if (serveArgv) {
    const running = readStarted(root).pids.find((p) => p.name === 'serve' && groupAlive(p.pgid));
    if (running) {
      pgid = running.pgid;
      lines.push(`serve already running (pgid ${pgid})`);
    } else {
      pgid = spawnDetached({ argv: serveArgv, root, featureDir, logPath: path.join(vdir, 'serve.log'), spawn, env: deviceEnv(visual) });
      const ident = identify(pgid);
      addStartedPid(root, { name: 'serve', pgid, ...(ident ? { ident } : {}), started_at: now().toISOString() });
      lines.push(`serve started (pgid ${pgid}); log verification/serve.log`);
    }
  }

  output(ctx, values, { text: lines, data: { status, hash: hash ?? null, serve_pgid: pgid } });
  return 0;
}
