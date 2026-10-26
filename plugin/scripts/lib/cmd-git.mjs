// dev-cycle git <verb> [args] [--json] [--feature <dir>] [--gh-credential]
//
// Verb dispatcher (spec R12). Each verb lives in its own module and exports
// an async function named after the verb:
//
//   export async function <verb>(argv, ctx) → {text?: string|string[], data?: object}
//
//   - argv is everything after the verb; parse it with parseCommandArgs()
//     (spread GIT_COMMON_OPTIONS from git-exec.mjs into the options).
//   - Throw GitFailure(reason, detail) for FAILED outcomes (exit 1) and
//     UsageError for usage problems (exit 2). Never write the failure line
//     yourself: this dispatcher prints `git <verb>: FAILED <reason> — <detail>`
//     on stderr and, with --json, `{ok:false, reason, detail}` on stdout.
//   - On success return {text, data}; --json prints `{ok:true, ...data}`.
//
// Modules are imported lazily, so a verb whose module does not exist yet
// reports "not implemented yet" (exit 2).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UsageError, output } from './core.mjs';
import { GitFailure } from './git-exec.mjs';

/** verb → [module under ./lib/, export name] */
export const GIT_VERBS = Object.freeze({
  branch: ['git-branch.mjs', 'branch'],
  commit: ['git-commit.mjs', 'commit'],
  push: ['git-remote.mjs', 'push'],
  pr: ['git-remote.mjs', 'pr'],
  merge: ['git-remote.mjs', 'merge'],
});

const USAGE = `git ${Object.keys(GIT_VERBS).join('|')} [args] [--json] [--feature <dir>] [--gh-credential]`;

/** True when --json appears before a `--` terminator. */
function wantsJson(argv) {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

export async function run(argv, ctx, { libUrl = new URL('./', import.meta.url) } = {}) {
  const [verb, ...rest] = argv;
  if (!verb) throw new UsageError(`missing verb (usage: dev-cycle ${USAGE})`);
  if (!Object.hasOwn(GIT_VERBS, verb)) throw new UsageError(`unknown git verb '${verb}' (usage: dev-cycle ${USAGE})`);

  const [file, exportName] = GIT_VERBS[verb];
  const moduleUrl = new URL(file, libUrl);
  if (!fs.existsSync(fileURLToPath(moduleUrl))) throw new UsageError(`git ${verb} is not implemented yet`);
  const mod = await import(moduleUrl.href);
  const fn = mod[exportName];
  if (typeof fn !== 'function') throw new UsageError(`git ${verb} is not implemented yet`);

  const json = wantsJson(rest);
  try {
    const result = (await fn(rest, ctx)) ?? {};
    output(ctx, { json }, { text: result.text ?? '', data: { ok: true, ...(result.data ?? {}) } });
    return 0;
  } catch (err) {
    if (!(err instanceof GitFailure)) throw err;
    ctx.stderr.write(`git ${verb}: FAILED ${err.reason} — ${err.detail}\n`);
    if (json) ctx.stdout.write(JSON.stringify({ ok: false, reason: err.reason, detail: err.detail }) + '\n');
    return 1;
  }
}
