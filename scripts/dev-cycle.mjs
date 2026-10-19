#!/usr/bin/env node
// dev-cycle state CLI. Dependency-free, Node >= 22.
//
//   node scripts/dev-cycle.mjs <command> [args] [--json] [--feature <dir>]
//
// Exit codes: 0 OK/PASSED, 1 FAILED, 2 usage/validation/parse error.
// Each command lives in ./lib/cmd-<name>.mjs and exports `run(argv, ctx)`
// (see ./lib/core.mjs for the contract). This table is the only place
// commands are registered.

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** command name → module file under ./lib/ */
export const COMMANDS = Object.freeze({
  feature: 'cmd-feature.mjs',       // feature init <slug> --flow --track [--answer k=v]...
  task: 'cmd-task.mjs',             // task <n> status <S> | task --all-from IMPL-DONE --to DONE
  spec: 'cmd-spec.mjs',             // spec status <S>
  history: 'cmd-history.mjs',       // history add --phase --subagent --status ...
  groups: 'cmd-groups.mjs',         // groups [--all]
  dod: 'cmd-dod.mjs',               // dod
  gate: 'cmd-gate.mjs',             // gate run <name>|--all
  'post-merge': 'cmd-post-merge.mjs', // post-merge run <name>|--all [--confirmed]
  profile: 'cmd-profile.mjs',       // profile validate | profile show [--json]
  brief: 'cmd-brief.mjs',           // brief <n>
  check: 'cmd-check.mjs',           // check [--scope touched|tree-wide] [--files …] [--steps …] [--record] (--help)
  git: 'cmd-git.mjs',               // git <subcommand> (deterministic git/gh wrappers)
  lessons: 'cmd-lessons.mjs',       // lessons add|list|prune (project lessons memory)
  recipe: 'cmd-recipe.mjs',         // recipe run <name> [--param k=v]... [--task n] | recipe list
  tokens: 'cmd-tokens.mjs',         // tokens agent <id> | tokens orchestrator [--session s] (measured usage)
  visual: 'cmd-visual.mjs',         // visual plan|build|run|mark|check|verdict|gallery|teardown (verification/)
  review: 'cmd-review.mjs',         // review snapshot [--cycle n] | review diff [--since-cycle n] [--name-only]
  init: 'cmd-init.mjs',             // init [--preset web|expo] [--force] (write .dev-cycle/project.json)
  ship: 'cmd-ship.mjs',             // ship [--release major|minor|patch|auto] [--subject <s>] [--body <b>] [--notes-file <f>] [--manifest <path>]... [--scope <s>] [--trailer "Key: value"]... [--closes <n,m>] [--body-footer <text>] [--ci-timeout <s>] [--gh-credential]
  report: 'cmd-report.mjs',         // report [--feature <dir> | --all] [--out <dir>] [--json] [--no-network]
});

const MIN_NODE_MAJOR = 22;

function usage(commands = COMMANDS) {
  return `usage: dev-cycle <command> [args] [--json] [--feature <dir>]\ncommands: ${Object.keys(commands).join(', ')}\n`;
}

/**
 * Run one CLI invocation. Returns the exit code; never calls process.exit.
 * @param {string[]} argv  arguments after the script path
 * @param {Partial<import('./lib/core.mjs').CliContext>} [ctxOverride]
 * @param {{commands?: Record<string,string>, libUrl?: URL}} [opts]
 *   test seam: alternative command table / module directory.
 */
export async function main(argv, ctxOverride, { commands = COMMANDS, libUrl = new URL('./lib/', import.meta.url) } = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  const stderr = ctxOverride?.stderr ?? process.stderr;
  if (major < MIN_NODE_MAJOR) {
    stderr.write(`dev-cycle: Node >= ${MIN_NODE_MAJOR} required (found ${process.versions.node})\n`);
    return 2;
  }
  const { makeContext, CliError } = await import('./lib/core.mjs');
  const ctx = makeContext(ctxOverride);

  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    ctx.stdout.write(usage(commands));
    return 0;
  }
  if (!command) {
    ctx.stderr.write(`dev-cycle: missing command\n${usage(commands)}`);
    return 2;
  }
  if (!Object.hasOwn(commands, command)) {
    ctx.stderr.write(`dev-cycle: unknown command '${command}'\n${usage(commands)}`);
    return 2;
  }

  const moduleUrl = new URL(commands[command], libUrl);
  if (!fs.existsSync(fileURLToPath(moduleUrl))) {
    ctx.stderr.write(`dev-cycle: command '${command}' is not implemented yet\n`);
    return 2;
  }

  try {
    const mod = await import(moduleUrl.href);
    if (typeof mod.run !== 'function') {
      ctx.stderr.write(`dev-cycle: command '${command}' has no run() export\n`);
      return 2;
    }
    const code = await mod.run(rest, ctx);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    if (err instanceof CliError) {
      if (err.message) ctx.stderr.write(`dev-cycle ${command}: ${err.message}\n`);
      return err.exitCode;
    }
    ctx.stderr.write(`dev-cycle ${command}: ${err?.stack ?? err}\n`);
    return 2;
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
