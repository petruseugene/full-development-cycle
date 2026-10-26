// `dev-cycle visual <sub> [args]` — subcommand dispatcher (spec R5–R13).
//
// Each subcommand lives in ./visual-<sub>.mjs and exports `run(argv, ctx)`
// (plus `runWith(argv, ctx, deps)` for its own test seams). This table is the
// only place subcommands are registered; subcommand tasks never edit it.
// A missing module exits 2 with `visual <sub>: not implemented yet`.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Subcommands in lifecycle order. */
export const SUBCOMMANDS = Object.freeze([
  'plan', 'build', 'run', 'mark', 'check', 'verdict', 'gallery', 'teardown',
]);

const USAGE = `usage: dev-cycle visual <subcommand> [args] [--json] [--feature <dir>]
subcommands:
  plan [--all]                         select screens + budget (verification/manifest.json)
  build [--force]                      build/serve the app (content-hash cache)
  run <screen-or-flow>                 run a flow with a hard time limit
  mark <screen> start|end [--adhoc]    soft time limit for agent-driven screens
  check <screen> --screenshot <png> …  geometry, measures and colour checks
  verdict                              numeric verdict + test-report.md section
  gallery                              write verification/index.html
  teardown                             stop what build/run started
`;

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  return runWith(argv, ctx);
}

/**
 * Dispatch with a test seam.
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{libUrl?: URL}} [deps]  directory holding the visual-<sub>.mjs modules
 * @returns {Promise<number>}
 */
export async function runWith(argv, ctx, { libUrl = new URL('./', import.meta.url) } = {}) {
  const [sub, ...rest] = argv;
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    ctx.stdout.write(USAGE);
    return 0;
  }
  if (!sub) {
    ctx.stderr.write(`dev-cycle visual: missing subcommand\n${USAGE}`);
    return 2;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    ctx.stderr.write(`dev-cycle visual: unknown subcommand '${sub}'\n${USAGE}`);
    return 2;
  }
  const moduleUrl = new URL(`visual-${sub}.mjs`, libUrl);
  if (!fs.existsSync(fileURLToPath(moduleUrl))) {
    ctx.stderr.write(`visual ${sub}: not implemented yet\n`);
    return 2;
  }
  const mod = await import(moduleUrl.href);
  if (typeof mod.run !== 'function') {
    ctx.stderr.write(`visual ${sub}: module has no run() export\n`);
    return 2;
  }
  const code = await mod.run(rest, ctx);
  return typeof code === 'number' ? code : 0;
}
