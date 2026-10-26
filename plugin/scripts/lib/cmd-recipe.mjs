// recipe run <name> [--param k=v]... [--task <n>] [--timeout <s>] | recipe list   (spec R25)
//
// Recipes come from the feature snapshot profile.recipes when a feature
// resolves, else from .dev-cycle/project.json. Every param is validated
// before anything runs (exit 2); the cmd is split into argv words, each value
// becomes one argv element verbatim, and the program is spawned WITHOUT a
// shell from the project root through runner.mjs. When a feature
// resolves, the output is logged to <feature>/content/<name>[-task-<n>].log.
// A closed (done) auto-detected folder does not resolve: nothing is written to it.

import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, output, parseCommandArgs, resolveFeatureForWrite, resolveProjectRoot,
} from './core.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { loadProfile, validateProfile } from './profile.mjs';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, runStep as defaultRunStep } from './runner.mjs';
import { buildArgv, describeParams, parseParamArgs, validateParams } from './recipe.mjs';
import { FORBIDDEN_CHARS, MAX_PATTERN_LEN, MAX_VALUE_LEN } from './recipe-safety.mjs';

const USAGE = 'recipe run <name> [--param k=v]... [--task <n>] [--timeout <s>] | recipe list [--json] [--feature <dir>] | recipe --help';

export const HELP = `usage: dev-cycle ${USAGE}

Runs a profile recipe (profile.recipes) WITHOUT a shell: the cmd is split into
argv words and each validated param value is passed as exactly one argument,
verbatim (no quoting, expansion, globbing, pipes or redirection ever happen).
Exit 0 PASSED, 1 FAILED, 2 invalid recipe/params (nothing runs).

Trust model: the recipe cmd is trusted, owner-authored code (a change to it is
no different from a change to the script it calls). The CLI guarantees that
param VALUES are validated and passed verbatim as single argv elements to a
program started without a shell; they are never parsed by the CLI or by a
shell it starts. The cmd grammar below is a best-effort lint against obvious
footguns, not a sandbox: a program that treats its own arguments as code, a
program path or a package to install is the recipe author's responsibility.

Param rules (checked before anything runs):
  - unknown, repeated or missing required params are rejected;
  - values longer than ${MAX_VALUE_LEN} chars or containing NUL are rejected;
  - a value starting with '-' is rejected unless the param declares
    "allow_dash": true (blocks option injection such as --version);
  - type int: an integer within min/max; pattern: a string regex (max ${MAX_PATTERN_LEN}
    chars, no nested quantifiers such as (a+)+ and no overlapping alternatives
    under a quantifier such as (a|aa)+), anchored as ^(?:pattern)$.

cmd grammar (also enforced by \`profile validate\`):
  - printable ASCII words separated by spaces/tabs; one command, no newline,
    control, non-ASCII or Unicode space/format characters;
  - none of  ${FORBIDDEN_CHARS}  anywhere, except {param} placeholders;
  - a placeholder is a whole word {p} or the value of a --flag={p} word;
    nothing else may be glued to it (x{p}, {a}{b}, -f{p} are rejected);
  - the first word (the program) is a literal, never a placeholder, an option
    or NAME=value, and not a shell (sh, bash, rbash, bash5, zsh-5.9, fish, …),
    a command runner (env, command, exec, eval, xargs, sudo, nohup, time,
    nice, timeout, watch, find, ssh, …) or a shell builtin name (read,
    export, printf, test, cd, …); names match by basename, case-insensitively,
    ignoring .exe and version suffixes. Run a script with a shebang instead
    (./scripts/gen.sh {p});
  - with placeholders, the later words of a plain program are checked for
    shells and runners too (wrappers such as caffeinate, arch or xcrun
    forward their args; ., source, exec and eval count only as the program,
    so git add . {p} is fine), up to the first interpreter word (node,
    python3, ruby, perl, php, deno, bun, npx, uv, pipx, sed, awk, expect,
    tclsh, swift, dc, osascript, pwsh, …). Between an interpreter and its
    script (first literal non-option word): no placeholder, no single-dash
    option containing e, c, p or r in either case (-e, -c, -p, -r, -pe,
    -Command, …) and no --eval/--print/--require/--import. The script word
    must not be eval/exec/x/dlx/install/i/add/ci/tool/task, a shell or a
    runner; for uv, uvx, pipx, bun and deno, run must be followed by a
    literal script path (uv run scripts/gen.py {p}); a script word that is
    itself an interpreter (npx tsx scripts/x.ts {p}) is checked again. Words
    after the script are its own args (python3 tools/gen.py -p {k} is fine);
  - npm, pnpm and yarn take no placeholders: they hand extra script args to
    a shell (npm run build -- {p} would re-parse the value);
  - not detected (author's responsibility): programs with their own code or
    program-path arguments, e.g. git -c {p}, make --eval={p}, vim -c {p},
    rsync -e {p}, tar --to-command={p}, npx tsx {p}.
  Example: node scripts/tts.mjs --only {keys} --max-requests {n}
  Params and output are logged to <feature>/content/<name>.log: never pass secrets.
`;

/** Recipes from the feature snapshot, else the project profile. */
export function loadRecipes(ctx, featureDir) {
  if (featureDir && fs.existsSync(path.join(featureDir, 'feature.json'))) {
    const snap = readFeatureJson(featureDir)?.profile;
    if (snap && typeof snap === 'object' && 'recipes' in snap) {
      const { errors } = validateProfile({ recipes: snap.recipes }, { skills: [] });
      if (errors.length) throw new UsageError(`invalid recipes in feature.json profile:\n  - ${errors.join('\n  - ')}`);
      return { recipes: snap.recipes, source: 'feature' };
    }
  }
  const { profile } = loadProfile(ctx, { quiet: true });
  return { recipes: Array.isArray(profile.recipes) ? profile.recipes : [], source: 'project' };
}

function intOption(name, raw, { min, max }) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < min || Number(raw) > max) {
    throw new UsageError(`--${name} must be an integer in ${min}..${max} (got '${raw}')`);
  }
  return Number(raw);
}

function list(values, ctx, featureDir) {
  const { recipes, source } = loadRecipes(ctx, featureDir);
  const data = recipes.map((r) => ({ name: r.name, params: r.params ?? {} }));
  const text = recipes.length ? recipes.map((r) => `${r.name}: ${describeParams(r.params)}`) : 'no recipes';
  output(ctx, values, { text, data: { source, recipes: data } });
  return 0;
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 * @param {{runStep?: typeof defaultRunStep}} [seams]
 */
export async function run(argv, ctx, { runStep = defaultRunStep } = {}) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      param: { type: 'string', multiple: true },
      task: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    positionals: ['sub?', 'name?'],
  });
  if (values.help) {
    ctx.stdout.write(HELP);
    return 0;
  }
  if (!args.sub) throw new UsageError(`missing required argument <sub> (usage: dev-cycle ${USAGE})`);
  const featureDir = resolveFeatureForWrite(ctx, values);

  if (args.sub === 'list') {
    if (args.name || values.param || values.task !== undefined || values.timeout !== undefined) {
      throw new UsageError(`recipe list takes no name or run options (usage: dev-cycle ${USAGE})`);
    }
    return list(values, ctx, featureDir);
  }
  if (args.sub !== 'run') throw new UsageError(`unknown subcommand '${args.sub}' (usage: dev-cycle ${USAGE})`);
  if (!args.name) throw new UsageError(`give a recipe name (usage: dev-cycle ${USAGE})`);

  const task = intOption('task', values.task, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const timeoutOpt = intOption('timeout', values.timeout, { min: 1, max: MAX_TIMEOUT_S });

  const { recipes } = loadRecipes(ctx, featureDir);
  const recipe = recipes.find((r) => r?.name === args.name);
  if (!recipe) throw new UsageError(`unknown recipe '${args.name}'`);

  const parsed = parseParamArgs(values.param ?? []);
  if (parsed.error) throw new UsageError(`recipe ${recipe.name}: ${parsed.error}`);
  const { errors, values: params } = validateParams(recipe.params ?? {}, parsed.params);
  if (errors.length) throw new UsageError(`recipe ${recipe.name}: ${errors.join('; ')}`);

  let recipeArgv;
  try { recipeArgv = buildArgv(recipe.cmd, params); } catch (err) {
    throw new UsageError(`recipe ${recipe.name}: ${err.message}`);
  }

  const root = resolveProjectRoot(ctx);
  const timeout_s = Math.min(timeoutOpt ?? recipe.timeout_s ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
  const logName = `${recipe.name}${task !== undefined ? `-task-${task}` : ''}.log`;
  const logPath = featureDir ? path.join(featureDir, 'content', logName) : undefined;

  const res = await runStep({
    argv: recipeArgv, timeout_s, logPath, featureDir: featureDir ?? '', root,
    stdout: values.json ? undefined : ctx.stdout,
  });

  const reason = res.timedOut ? `(timed out after ${timeout_s}s)` : `(exit ${res.exitCode ?? 'none'})`;
  const logRel = logPath ? path.relative(root, logPath) : null;
  if (values.json) {
    output(ctx, values, {
      data: {
        recipe: recipe.name, status: res.status, exitCode: res.exitCode, timedOut: res.timedOut,
        duration_s: res.duration_s, log: logRel, output: res.output,
      },
    });
  } else if (res.output !== '') {
    ctx.stdout.write(res.output.endsWith('\n') ? res.output : `${res.output}\n`);
  }
  if (res.status !== 'PASSED') {
    ctx.stderr.write(`recipe ${recipe.name}: FAILED ${reason}${logRel ? ` (log: ${logRel})` : ''}\n`);
    return 1;
  }
  if (!values.json) output(ctx, values, { text: `recipe ${recipe.name}: PASSED${logRel ? ` (log: ${logRel})` : ''}` });
  return 0;
}
