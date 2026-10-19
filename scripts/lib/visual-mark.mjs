// `dev-cycle visual mark <screen> start|end [--adhoc]` — soft time limit for
// agent-driven screens (spec R8). `end` records duration_s; above the screen
// limit → `overrun: true` (never a failure by itself); above 2× the limit →
// `result: 'timeout'`. `--adhoc` registers an unknown id (reference 'none',
// no checks); an unknown id without it is a UsageError (exit 2).

import path from 'node:path';
import { UsageError, output, parseCommandArgs, readText, resolveFeatureDir } from './core.mjs';
import {
  buildCatalog, loadVisualConfig, screenLimit, touchActivity, updateManifest,
} from './visual-core.mjs';
import { AC_ID_RE, ID_RE } from './visual-profile.mjs';

const USAGE = 'visual mark <screen> start|end [--adhoc] [--ac <ACn>]... [--breakpoint <px>] [--json] [--feature <dir>]';
export const HELP = `usage: dev-cycle ${USAGE}

start  begins a fresh attempt for the screen: its earlier check results,
       --fail reasons, screenshot, result and timing are cleared (catalog
       fields id/title/reference/acs/adhoc/target/timeout_s are kept).
end    records duration_s; above the screen limit → overrun (soft); above
       2x the limit → result timeout.
--adhoc registers an id that is not in the catalog (reference none, no checks).
--ac <ACn> (repeatable, on start) records the acceptance criteria the screen covers;
       the verdict lists them under '## AC coverage — visual'.
--breakpoint <px> (web) records the viewport width shown in the verdict head line.
`;

/** Per-attempt fields of a manifest screen; cleared when a new attempt starts. */
export const ATTEMPT_FIELDS = Object.freeze([
  'started_at', 'ended_at', 'duration_s', 'exit_code', 'timed_out', 'overrun', 'result',
  'screenshot', 'checks', 'failures',
]);

/** Start a fresh attempt: drop every per-attempt field, keep catalog fields. */
export function resetAttempt(entry) {
  for (const k of ATTEMPT_FIELDS) delete entry[k];
  if (entry.adhoc) entry.checks = [];
  return entry;
}
const SCREEN_ID_RE = ID_RE;

const round1 = (n) => Math.round(n * 10) / 10;

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{now?: () => Date|number}} [deps]  clock seam for tests
 * @returns {Promise<number>}
 */
export async function runWith(argv, ctx, { now = () => new Date() } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write(HELP);
    return 0;
  }
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      adhoc: { type: 'boolean' },
      ac: { type: 'string', multiple: true },
      breakpoint: { type: 'string' },
    },
    positionals: ['screen', 'verb'],
  });
  if (args.verb !== 'start' && args.verb !== 'end') {
    throw new UsageError(`mark verb must be 'start' or 'end' (got '${args.verb}') (usage: dev-cycle ${USAGE})`);
  }
  const id = args.screen;
  const acs = [...new Set(values.ac ?? [])];
  for (const ac of acs) if (!AC_ID_RE.test(ac)) throw new UsageError(`--ac '${ac}' must match ${AC_ID_RE} (usage: dev-cycle ${USAGE})`);
  if (values.breakpoint !== undefined && !/^[1-9]\d{1,4}$/.test(values.breakpoint)) {
    throw new UsageError(`--breakpoint '${values.breakpoint}' must be a viewport width in px (usage: dev-cycle ${USAGE})`);
  }
  if (!SCREEN_ID_RE.test(id)) throw new UsageError(`screen id '${id}' must match ${SCREEN_ID_RE}`);
  const dir = resolveFeatureDir(ctx, values);
  const { visual } = loadVisualConfig(ctx, dir);
  const specText = readText(path.join(dir, 'spec.md'), { optional: true });
  const catalog = buildCatalog(visual, specText);
  const known = catalog.find((s) => s.id === id);
  const at = new Date(now());
  const iso = at.toISOString();

  let data;
  updateManifest(dir, (m) => {
    m.screens = Object.assign(Object.create(null), m.screens && typeof m.screens === 'object' ? m.screens : {});
    let entry = Object.hasOwn(m.screens, id) ? m.screens[id] : undefined;
    if (!entry && !known) {
      if (!values.adhoc) {
        throw new UsageError(`unknown screen '${id}': not in the catalog; pass --adhoc to register it (usage: dev-cycle ${USAGE})`);
      }
      if (!SCREEN_ID_RE.test(id)) throw new UsageError(`ad-hoc screen id '${id}' must match ${SCREEN_ID_RE}`);
    }
    if (!entry) {
      entry = known
        ? { id, title: known.title ?? id, reference: known.reference ?? 'none', acs: known.acs ?? [], adhoc: false }
        : { id, title: id, reference: 'none', adhoc: true, checks: [] };
      if (known?.timeout_s !== undefined) entry.timeout_s = known.timeout_s;
      m.screens[id] = entry;
    }
    if (acs.length) entry.acs = [...new Set([...(Array.isArray(entry.acs) ? entry.acs : []), ...acs])];
    if (values.breakpoint !== undefined) entry.breakpoint = Number(values.breakpoint);
    const limit = screenLimit(known ?? entry, visual);
    entry.timeout_s = limit;

    if (args.verb === 'start') {
      resetAttempt(entry); // a new attempt: nothing from an earlier one carries over
      entry.started_at = iso;
    } else {
      if (!entry.started_at) throw new UsageError(`screen '${id}' has no start mark; run 'visual mark ${id} start' first`);
      const duration = round1((at.getTime() - new Date(entry.started_at).getTime()) / 1000);
      entry.ended_at = iso;
      entry.duration_s = duration;
      entry.overrun = duration > limit;
      if (duration > 2 * limit) entry.result = 'timeout';
      else if (entry.result === 'timeout') delete entry.result;
    }
    entry.updated_at = iso;
    touchActivity(m, iso);
    data = {
      screen: id, mark: args.verb, adhoc: Boolean(entry.adhoc), timeout_s: limit,
      ...(args.verb === 'end' ? { duration_s: entry.duration_s, overrun: entry.overrun, result: entry.result ?? null } : {}),
    };
  });

  let text = `${id}: ${args.verb} @ ${iso}`;
  if (args.verb === 'end') {
    text = `${id}: ${data.duration_s}s of ${data.timeout_s}s${data.result === 'timeout' ? ' - TIMEOUT' : data.overrun ? ' - overrun (soft)' : ''}`;
  }
  output(ctx, values, { text, data });
  return 0;
}
