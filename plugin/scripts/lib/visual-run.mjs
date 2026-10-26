// `dev-cycle visual run <screen-or-flow>` — run a flow with a hard per-flow
// time limit (spec R7). The argument is a screen id or the exact flow command;
// it resolves to the flow and every catalog screen produced by it. A `route`
// screen is agent-driven (exit 2, use `visual mark`). The device guard runs
// before anything is spawned (exit 2), then `ensureDevice` for device-
// sensitive flows. The flow is checked with the single visual-profile
// validator (every argv word, lesson L4) right before the spawn. It runs as
// argv without a shell through runStep with `{out}` = the ABSOLUTE path of the
// feature's verification/ folder, `{screen}` = the screen id, `{device}` =
// visual.device, and cwd = that verification/ folder, so a relative artefact
// path (e.g. Maestro `takeScreenshot: home`) lands inside the self-ignored
// folder. Literal argv words that name an existing project-root-relative path
// (`flows/home.yaml`) are passed as absolute paths. Output goes to
// verification/run-<id>.log. On timeout the process group is
// killed; every screen of the flow gets timed_out + result 'timeout'.
// Exit 1 on a timeout or a non-zero exit.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  FailedError, UsageError, output, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import { runStep } from './runner.mjs';
import { parseRecipeCmd } from './recipe-safety.mjs';
import {
  buildCatalog, loadVisualConfig, resolveInside, screenLimit, touchActivity, updateManifest, verificationDir,
  ensureSelfIgnore,
} from './visual-core.mjs';
import {
  deviceGuardProblems, isDeviceSensitive, isValidDevice, visualCmdProblems,
} from './visual-profile.mjs';
import { deviceEnv, ensureDevice } from './visual-device.mjs';
import { resetAttempt } from './visual-mark.mjs';

const USAGE = 'visual run <screen-or-flow> [--json] [--feature <dir>]';
export const HELP = `usage: dev-cycle ${USAGE}

Runs the flow of a catalog screen (or the exact flow command) as argv, without
a shell, with a hard time limit (screen timeout_s / visual.screen_timeout_s).

Placeholders in the flow:
  {out}     absolute path of <feature>/verification/ (self-ignored by git);
            write every artefact there, e.g. maestro test -e OUT={out} ...
            with takeScreenshot: \${OUT}/home
  {screen}  the screen id
  {device}  visual.device (simulator UDID or emulator-<n>); a device-sensitive
            flow must pass it right after its device flag (--device {device})

Before the spawn, visual.device (when set) is booted/launched if needed and
verified (listed by xcrun simctl / attached in adb devices), else exit 2.
With an emulator the flow runs with ANDROID_SERIAL=<visual.device>.
The flow runs with cwd = <feature>/verification/, so a relative artefact path
lands inside it. Literal words that name an existing project-root-relative
path (flows/home.yaml) are passed as absolute paths.
Each run starts a fresh attempt for every screen of the flow: earlier check
results, --fail reasons, screenshot, result and timing are cleared.
Output: <feature>/verification/run-<screen>.log
`;
const round1 = (n) => Math.round(n * 10) / 10;

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * Substitute placeholders into argv words. Values are single argv elements.
 * @returns {string[]}
 */
function buildArgv(words, values) {
  return words.map((w) => {
    if ('lit' in w) return w.lit;
    const v = values[w.ph];
    if (typeof v !== 'string' || v === '') throw new UsageError(`no value for placeholder {${w.ph}}`);
    return `${w.prefix}${v}`;
  });
}

const SUBCOMMAND_WORDS = new Set(['test', 'run', 'build', 'start', 'record', 'studio', 'cloud', 'install', 'launch', 'shell', 'devices']);

/**
 * Literal words (not options; argv[0] only when it has a `/`; bare names such as
 * `flows` included) that name an existing path relative to the
 * project root become absolute, because the flow runs with cwd =
 * verification/. A word that would leave the root is left alone.
 * @param {Array<{lit: string}|{ph: string, prefix: string}>} words
 * @param {string} root
 */
export function anchorPaths(words, root) {
  // The subcommand slot: the first word after the binary once leading options
  // (and the one value word each `--opt value` takes) are skipped.
  let sub = 1;
  while (sub < words.length && 'lit' in words[sub] && words[sub].lit.startsWith('-')) sub += words[sub].lit.includes('=') ? 1 : 2;
  return words.map((w, i) => {
    if (!('lit' in w) || w.lit.startsWith('-') || path.isAbsolute(w.lit)) return w;
    // `maestro test flows`: the subcommand word (right after the binary and its leading options) is never a path,
    // even if a `test/` dir exists; the same name elsewhere is a real project path
    if (i === sub && SUBCOMMAND_WORDS.has(w.lit)) return w;
    if (i === 0 && !w.lit.includes('/')) return w; // a program looked up on PATH
    if (!fs.existsSync(path.join(root, w.lit))) return w;
    try {
      return { lit: resolveInside(root, w.lit) };
    } catch {
      return w;
    }
  });
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{spawn?: Function, now?: () => Date|number, ensureDevice?: Function}} [deps]  test seams
 * @returns {Promise<number>}
 */
export async function runWith(argv, ctx, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write(HELP);
    return 0;
  }
  const spawn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? (() => new Date());
  const ensure = deps.ensureDevice ?? ensureDevice;
  const { values, args } = parseCommandArgs(argv, { usage: USAGE, positionals: ['target'] });
  const dir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  const { visual } = loadVisualConfig(ctx, dir);
  const specText = readText(path.join(dir, 'spec.md'), { optional: true });
  const catalog = buildCatalog(visual, specText);

  const byId = catalog.find((s) => s.id === args.target);
  const target = byId ?? catalog.find((s) => s.flow === args.target);
  if (!target) throw new UsageError(`unknown screen or flow '${args.target}': not in the catalog (usage: dev-cycle ${USAGE})`);
  if (typeof target.flow !== 'string' || target.flow === '') {
    throw new UsageError(`screen '${target.id}' is a route screen: agent-driven: use visual mark ${target.id} start|end`);
  }
  const flow = target.flow;
  const screens = catalog.filter((s) => s.flow === flow);

  const problems = [...visualCmdProblems(flow), ...deviceGuardProblems(flow, visual)];
  if (problems.length) throw new UsageError(`flow '${flow}' cannot run: ${problems.join('; ')}`);
  const { words } = parseRecipeCmd(flow);
  if (words.some((w) => 'ph' in w && w.ph === 'device') && !isValidDevice(visual?.device)) {
    throw new UsageError(`flow uses {device} but visual.device ${JSON.stringify(visual?.device)} is not a simulator UDID or emulator-<n>`);
  }

  // Runtime device check before the spawn: boots/launches visual.device when
  // needed and refuses one simctl does not list / adb does not attach (exit 2).
  const hasDevice = visual?.device !== undefined && visual?.device !== null && visual?.device !== '';
  if (isDeviceSensitive(words) || hasDevice) await ensure({ visual, root, spawn, now: () => new Date(now()) });

  const verDir = ensureSelfIgnore(path.resolve(verificationDir(dir)));
  const limit = screenLimit(target, visual);
  const argvOut = buildArgv(anchorPaths(words, root), { device: visual?.device, out: verDir, screen: target.id });
  const logPath = path.join(verDir, `run-${target.id}.log`);

  const startedAt = new Date(now());
  // cwd = verification/: relative artefact paths cannot land outside it.
  const res = await runStep({
    argv: argvOut, timeout_s: limit, logPath, featureDir: dir, root: verDir, spawn, env: deviceEnv(visual),
  });
  const endedAt = new Date(now());
  const duration = round1((endedAt.getTime() - startedAt.getTime()) / 1000);
  const iso = endedAt.toISOString();

  updateManifest(dir, (m) => {
    m.screens = Object.assign(Object.create(null), m.screens && typeof m.screens === 'object' ? m.screens : {});
    for (const s of screens) {
      const entry = (Object.hasOwn(m.screens, s.id) ? m.screens[s.id] : undefined) ?? { id: s.id, title: s.title ?? s.id, reference: s.reference ?? 'none', acs: s.acs ?? [], adhoc: false };
      resetAttempt(entry); // each run is a fresh attempt for every screen of the flow
      entry.target = entry.target ?? (visual?.device ?? 'web');
      entry.timeout_s = screenLimit(s, visual);
      entry.started_at = startedAt.toISOString();
      entry.ended_at = iso;
      entry.duration_s = duration;
      entry.exit_code = res.exitCode;
      entry.timed_out = res.timedOut;
      entry.overrun = duration > entry.timeout_s;
      if (res.timedOut) entry.result = 'timeout';
      entry.updated_at = iso;
      m.screens[s.id] = entry;
    }
    touchActivity(m, iso);
  });

  const ok = res.status === 'PASSED';
  const data = {
    flow, screens: screens.map((s) => s.id), timeout_s: limit, duration_s: duration,
    exit_code: res.exitCode, timed_out: res.timedOut, log: path.relative(dir, logPath),
  };
  const text = res.timedOut
    ? `${flow}: TIMEOUT after ${limit}s; process group killed (${screens.length} screen(s))`
    : `${flow}: ${ok ? 'ok' : `exit ${res.exitCode}`} in ${duration}s (${screens.length} screen(s))`;
  output(ctx, values, { text, data });
  if (!ok) throw new FailedError(res.timedOut ? `flow timed out after ${limit}s` : `flow exited ${res.exitCode}`);
  return 0;
}
