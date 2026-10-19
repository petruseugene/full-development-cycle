// Shared CLI plumbing for scripts/dev-cycle.mjs and every scripts/lib/cmd-*.mjs.
//
// Contract for command modules (`scripts/lib/cmd-<name>.mjs`):
//
//   export async function run(argv, ctx) { ... }
//
//   - `argv` is everything after the command name (e.g. for
//     `dev-cycle task 3 status DONE --json` it is ['3','status','DONE','--json']).
//   - `ctx` is a CliContext (see makeContext). Use ctx.cwd / ctx.env, never
//     process.cwd() / process.env, so commands can be tested in-process.
//   - Parse arguments with parseCommandArgs(); it adds --json and --feature.
//   - Print results with output(); warnings with warn().
//   - Throw UsageError for usage/validation/parse problems (exit 2) and
//     FailedError for FAILED outcomes (exit 1). Alternatively return 1 after
//     printing the failure yourself. Returning nothing / 0 means exit 0.
//   - Never prompt for input.

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error carrying the process exit code. */
export class CliError extends Error {
  /** @param {string} message @param {number} exitCode */
  constructor(message, exitCode) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}

/** Usage, validation or parse error. Exit 2, message on stderr. */
export class UsageError extends CliError {
  constructor(message) { super(message, 2); }
}

/**
 * A FAILED outcome (dod, gate, refused post-merge). Exit 1. A non-empty
 * message is written to stderr; pass '' when the command already printed
 * its own failure line.
 */
export class FailedError extends CliError {
  constructor(message = '') { super(message, 1); }
}

// ---------------------------------------------------------------------------
// Context + output
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CliContext
 * @property {string} cwd
 * @property {Record<string,string|undefined>} env
 * @property {{write(s: string): unknown}} stdout
 * @property {{write(s: string): unknown}} stderr
 */

/**
 * Build a context. Defaults to the real process; tests pass their own
 * cwd/env and in-memory stdout/stderr.
 * @param {Partial<CliContext>} [over]
 * @returns {CliContext}
 */
export function makeContext(over = {}) {
  return {
    cwd: over.cwd ?? process.cwd(),
    env: over.env ?? process.env,
    stdout: over.stdout ?? process.stdout,
    stderr: over.stderr ?? process.stderr,
  };
}

/**
 * Print a command result. With `--json` exactly one JSON document is written
 * (`data`, or `{ message: text }` when no data is given); otherwise `text`
 * (string or array of lines) is written as one-liners.
 * @param {CliContext} ctx
 * @param {{json?: boolean}} values  parsed values (only `json` is consulted)
 * @param {{text?: string|string[], data?: unknown}} result
 */
export function output(ctx, values, { text = '', data } = {}) {
  if (values?.json) {
    const doc = data === undefined ? { message: Array.isArray(text) ? text.join('\n') : text } : data;
    ctx.stdout.write(JSON.stringify(doc) + '\n');
    return;
  }
  const lines = Array.isArray(text) ? text : [text];
  const body = lines.filter((l) => l !== undefined && l !== null).join('\n');
  if (body !== '') ctx.stdout.write(body + '\n');
}

/** Write a warning line to stderr (does not change the exit code). */
export function warn(ctx, message) {
  ctx.stderr.write(`warning: ${message}\n`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Options every command accepts. */
export const COMMON_OPTIONS = Object.freeze({
  json: { type: 'boolean' },
  feature: { type: 'string' },
});

/**
 * Strict argument parsing on top of node:util parseArgs.
 *
 * @param {string[]} argv
 * @param {object} spec
 * @param {string} spec.usage  usage line used in error messages, e.g. 'task <n> status <S>'
 * @param {Record<string, {type:'string'|'boolean', multiple?: boolean, short?: string,
 *   default?: unknown, required?: boolean}>} [spec.options]
 *   `required: true` makes a missing (or empty-string) option a UsageError.
 * @param {string[]} [spec.positionals]  names; suffix '?' = optional, '...' = rest
 *   (e.g. ['n', 'verb', 'status?']). Extra positionals are a UsageError.
 * @returns {{values: Record<string, any>, positionals: string[], args: Record<string, any>}}
 *   `args` maps positional names (without suffix) to their values.
 */
export function parseCommandArgs(argv, { usage = '', options = {}, positionals = [] } = {}) {
  const parseOptions = { ...COMMON_OPTIONS };
  const required = [];
  for (const [name, opt] of Object.entries(options)) {
    const { required: isRequired, ...rest } = opt;
    parseOptions[name] = rest;
    if (isRequired) required.push(name);
  }
  const hint = usage ? ` (usage: dev-cycle ${usage})` : '';

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: parseOptions, strict: true, allowPositionals: true });
  } catch (err) {
    if (typeof err?.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) {
      throw new UsageError(`${err.message}${hint}`);
    }
    throw err;
  }
  const values = { ...parsed.values };

  for (const name of required) {
    const v = values[name];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      throw new UsageError(`missing required option --${name}${hint}`);
    }
  }

  const args = {};
  const pos = parsed.positionals;
  let i = 0;
  for (const raw of positionals) {
    if (raw.endsWith('...')) {
      args[raw.slice(0, -3)] = pos.slice(i);
      i = pos.length;
      break;
    }
    const optional = raw.endsWith('?');
    const name = optional ? raw.slice(0, -1) : raw;
    if (i < pos.length) {
      args[name] = pos[i++];
    } else if (!optional) {
      throw new UsageError(`missing required argument <${name}>${hint}`);
    }
  }
  if (i < pos.length) {
    throw new UsageError(`unexpected argument '${pos[i]}'${hint}`);
  }
  return { values, positionals: pos, args };
}

// ---------------------------------------------------------------------------
// Project root + feature folder resolution
// ---------------------------------------------------------------------------

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Project root: the nearest directory at or above ctx.cwd that contains
 * `.dev-cycle/`, `docs/features/` or `.git`; falls back to ctx.cwd.
 * @param {CliContext} ctx
 */
export function resolveProjectRoot(ctx) {
  const start = path.resolve(ctx.cwd);
  let dir = start;
  for (;;) {
    if (isDir(path.join(dir, '.dev-cycle')) || isDir(path.join(dir, 'docs', 'features'))
      || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** `<root>/docs/features` */
export function featuresRoot(ctx) {
  return path.join(resolveProjectRoot(ctx), 'docs', 'features');
}

function realDir(p) {
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a --feature / DEV_CYCLE_FEATURE value and confine it: the real
 * path (symlinks resolved) must be an existing direct child of
 * `<projectRoot>/docs/features/`. Anything else (`..` traversal, absolute
 * paths elsewhere, symlinks pointing outside) is a UsageError, so commands
 * such as gate/post-merge can never act on another folder's state.
 * A bare name (no path separator) is looked up under docs/features/.
 */
function locateFeature(ctx, value, source) {
  const root = featuresRoot(ctx);
  const isBareName = !/[\\/]/.test(value) && value !== '.' && value !== '..';
  const candidate = isBareName ? path.join(root, value) : path.resolve(ctx.cwd, value);
  const real = realDir(candidate);
  if (!real) throw new UsageError(`feature folder not found (${source}): ${value}`);
  const realRoot = realDir(root);
  if (!realRoot || path.dirname(real) !== realRoot) {
    throw new UsageError(`feature folder must be a direct child of ${root} (${source}): ${value}`);
  }
  return real;
}

/**
 * Resolve the feature folder (spec R3):
 *   1. `--feature <dir>` (path, or folder name under docs/features/)
 *   2. env DEV_CYCLE_FEATURE (same forms)
 *   Both must resolve (realpath) to a direct child of <root>/docs/features/.
 *   3. lexicographically newest folder under <root>/docs/features/
 * Returns an absolute path. Throws UsageError when nothing resolves.
 * @param {CliContext} ctx
 * @param {{feature?: string}} [values]
 */
export function resolveFeatureDir(ctx, values = {}) {
  if (values.feature) return locateFeature(ctx, values.feature, '--feature');
  const fromEnv = ctx.env?.DEV_CYCLE_FEATURE;
  if (fromEnv) return locateFeature(ctx, fromEnv, 'DEV_CYCLE_FEATURE');

  const root = featuresRoot(ctx);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    // fall through to the error below
  }
  if (names.length === 0) {
    throw new UsageError(`no feature folder: pass --feature, set DEV_CYCLE_FEATURE, or create one under ${root}`);
  }
  names.sort();
  return path.join(root, names[names.length - 1]);
}

/**
 * Feature folder for commands that WRITE into it (check, recipe run, gate run).
 * An explicit --feature / DEV_CYCLE_FEATURE resolves as in resolveFeatureDir.
 * An auto-detected (newest) folder resolves to null when nothing is found or
 * when it is closed (feature.json current_phase == "done"): a finished
 * feature's committed reports and logs must not be touched.
 * @returns {string|null}
 */
export function resolveFeatureForWrite(ctx, values = {}) {
  if (values.feature || ctx.env?.DEV_CYCLE_FEATURE) return resolveFeatureDir(ctx, values);
  let dir;
  try { dir = resolveFeatureDir(ctx, values); } catch (err) {
    if (err instanceof UsageError) return null;
    throw err;
  }
  try {
    const fj = JSON.parse(fs.readFileSync(path.join(dir, 'feature.json'), 'utf8'));
    if (fj && fj.current_phase === 'done') return null;
  } catch { /* no or unreadable feature.json: keep the folder */ }
  return dir;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read a UTF-8 text file. Missing file → UsageError, or `null` when
 * `optional` is set.
 * @param {string} file
 * @param {{optional?: boolean}} [opts]
 * @returns {string|null}
 */
export function readText(file, { optional = false } = {}) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (optional) return null;
      throw new UsageError(`file not found: ${file}`);
    }
    throw err;
  }
}

/**
 * Atomically replace `file` with `text`: write a dot-prefixed temp file in
 * the same directory, then rename it over the target. The temp file is
 * removed on any failure, so no leftover is ever left behind.
 *
 * When `expected` is given (the content the caller based its edit on, or
 * null for "file did not exist"), the target is re-read immediately before
 * the rename and a UsageError is thrown if it changed in the meantime.
 *
 * @param {string} file
 * @param {string} text
 * @param {{expected?: string|null}} [opts]
 */
export function atomicWrite(file, text, opts = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let mode;
  try { mode = fs.statSync(file).mode & 0o777; } catch { mode = undefined; }
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
    if ('expected' in opts) {
      const current = readText(file, { optional: true });
      if (current !== opts.expected) {
        throw new UsageError(`${file} changed on disk while it was being updated; re-run the command`);
      }
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Read-modify-write a text file atomically. `transform(before)` returns the
 * new text. Nothing is written when the text is unchanged (byte-preserving).
 * The file is re-read right before the write (see atomicWrite `expected`).
 * @param {string} file
 * @param {(before: string) => string} transform
 * @returns {{before: string, after: string, changed: boolean}}
 */
export function updateText(file, transform) {
  const before = readText(file);
  const after = transform(before);
  if (typeof after !== 'string') throw new TypeError('updateText transform must return a string');
  const changed = after !== before;
  if (changed) atomicWrite(file, after, { expected: before });
  return { before, after, changed };
}
