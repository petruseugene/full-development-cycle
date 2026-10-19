// Process seam for `dev-cycle git` (spec R12, R13, R14, R20).
//
//   gitRun(args, opts) / ghRun(args, opts) → {code, stdout, stderr}
//
// - Never through a shell: argv is passed to spawn() as an array.
// - Every call has a timeout (network git verbs and gh default to 120 s,
//   local git to 60 s). On timeout the whole process group is SIGKILLed and
//   the call throws GitFailure('timeout').
// - Never prompts: git runs with GIT_TERMINAL_PROMPT=0, gh with
//   GH_PROMPT_DISABLED=1.
// - gh is `$DEV_CYCLE_GH` when set (test seam), else `gh`.
// - Credential helper (R14): with `ghCredential: true` or
//   DEV_CYCLE_GIT_CREDENTIAL=gh, network git calls (fetch/push/pull) are
//   prefixed with `-c credential.helper= -c credential.helper=!gh auth git-credential`.
// - Hard guard: an argv with a force/no-verify flag (--force*, --no-verify,
//   push -f / +refspec, commit -n, branch -D, reset --hard, gh pr merge
//   --admin; see findForbiddenArg) throws ForbiddenArgError before anything
//   is spawned.
// - A non-zero exit is returned, not thrown; callers map it to a reason.

import { spawn as nodeSpawn } from 'node:child_process';
import { CliError } from './core.mjs';

/** Closed failure reason set (R12). */
export const GIT_REASONS = Object.freeze([
  'conflict', 'hook-failed', 'timeout', 'auth', 'push-rejected', 'ci-failing', 'ci-pending',
  'dod-failed', 'main-ahead', 'secret-like-file', 'not-mergeable', 'nothing-to-commit',
]);

export const NETWORK_TIMEOUT_S = 120;
export const LOCAL_TIMEOUT_S = 60;
export const GH_TIMEOUT_S = 120;

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull']);
const CREDENTIAL_PREFIX = Object.freeze(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']);
const OUTPUT_CAP = 4 * 1024 * 1024;
const CLOSE_GRACE_MS = 2000;

/** A FAILED git verb outcome with a reason from GIT_REASONS (exit 1). */
export class GitFailure extends Error {
  /** @param {string} reason one of GIT_REASONS @param {string} [detail] */
  constructor(reason, detail = '') {
    if (!GIT_REASONS.includes(reason)) throw new TypeError(`unknown git failure reason '${reason}'`);
    super(`${reason} — ${detail}`);
    this.name = 'GitFailure';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * A local git plumbing call (add, rev-parse, reset, …) failed: the repo is
 * not in a usable state. Not a merge conflict, so it is not a GitFailure
 * with a routable reason — it exits 2 like a usage/internal error.
 */
export class GitPlumbingError extends CliError {
  constructor(message) { super(message, 2); this.name = 'GitPlumbingError'; }
}

/** A forbidden flag reached the exec seam: a programming error, never user input. */
export class ForbiddenArgError extends Error {
  constructor(message) { super(message); this.name = 'ForbiddenArgError'; }
}

/** Long flags refused for every git/gh subcommand. */
const FORBIDDEN_LONG = new Set(['--force', '--force-with-lease', '--force-if-includes', '--no-verify']);

/**
 * Short flags refused per git subcommand (also inside clusters like `-uf`).
 * push -f (force), commit -n (--no-verify), branch -D / -f, checkout -f, clean -f.
 */
const FORBIDDEN_SHORT = Object.freeze({
  push: 'f', commit: 'n', branch: 'Df', checkout: 'f', clean: 'f', switch: 'f',
});

/**
 * Options whose value is the next argv token. The value is skipped, so a
 * user `--title "--force"` is data, not a flag (security S4).
 */
const GIT_VALUE_OPTIONS = new Set([
  '-F', '-m', '--file', '--message', '-o', '--push-option', '-b', '-B', '--author', '--date',
  '--template', '--trailer', '--format', '--diff-filter', '--cleanup', '--abbrev-ref',
]);
const GH_VALUE_OPTIONS = new Set([
  '--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H', '--json',
  '--limit', '-L', '--state', '-s', '--repo', '-R', '--label', '-l', '--assignee', '-a',
  '--reviewer', '-r', '--milestone', '-m', '--subject', '--jq', '-q', '--hostname', '-h',
]);
/** gh top-level commands (none of them is a git subcommand). */
const GH_COMMANDS = new Set(['pr', 'release', 'auth', 'api', 'repo', 'issue', 'run', 'workflow']);

/** Index of the subcommand, skipping leading `-c k=v` / `-C dir` pairs. */
function firstSubcommand(args) {
  let i = 0;
  while (i < args.length && (args[i] === '-c' || args[i] === '-C')) i += 2;
  return i;
}

/**
 * Return a description of the first forbidden token in a git or gh argv, or
 * null. Only real flag positions are inspected: option values (see
 * GIT_VALUE_OPTIONS / GH_VALUE_OPTIONS) and everything after a `--` terminator are skipped.
 * Forbidden: --force, --force-with-lease[=...], --force-if-includes,
 * --no-verify (any subcommand); `push -f` and `+<refspec>`; `commit -n`;
 * `branch -D` / `-f`; `checkout|switch|clean -f`; `reset --hard`;
 * `gh pr merge --admin`.
 * @param {string[]} argv
 */
export function findForbiddenArg(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const at = firstSubcommand(list);
  const sub = list[at];
  const ghMerge = sub === 'pr' && list[at + 1] === 'merge';
  const valueOptions = GH_COMMANDS.has(sub) ? GH_VALUE_OPTIONS : GIT_VALUE_OPTIONS;
  const shorts = !GH_COMMANDS.has(sub) && Object.hasOwn(FORBIDDEN_SHORT, sub) ? FORBIDDEN_SHORT[sub] : '';
  for (let i = at + 1; i < list.length; i++) {
    const a = list[i];
    if (a === '--') break;
    if (valueOptions.has(a)) { i += 1; continue; }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (FORBIDDEN_LONG.has(name)) return a;
      if (sub === 'reset' && name === '--hard') return 'reset --hard';
      if (ghMerge && name === '--admin') return 'pr merge --admin';
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      const hit = [...a.slice(1)].find((ch) => shorts.includes(ch));
      if (hit) return `${sub} -${hit}`;
      continue;
    }
    if (sub === 'push' && a.startsWith('+')) return `push ${a}`;
  }
  return null;
}

/** Throw ForbiddenArgError when argv contains a forbidden flag. */
export function assertSafeArgs(cmd, argv) {
  const bad = findForbiddenArg(argv);
  if (bad) throw new ForbiddenArgError(`refusing to run ${cmd} with forbidden argument '${bad}'`);
}

// --- spawn seam ------------------------------------------------------------

let spawnImpl = nodeSpawn;

/**
 * Replace the spawn function used by gitRun/ghRun (test seam). Pass nothing
 * to restore node's spawn. Returns the previous implementation.
 * @param {typeof nodeSpawn} [fn]
 */
export function setSpawn(fn) {
  const prev = spawnImpl;
  spawnImpl = fn ?? nodeSpawn;
  return prev;
}

// --- process-group tracking: kill children if the CLI itself exits ---------

const active = new Set();
let exitHook = false;
function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
}
function track(pid) {
  if (typeof pid !== 'number') return;
  active.add(pid);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => { for (const p of active) killGroup(p); });
  }
}

const subcommandIndex = firstSubcommand;

/** True when the git argv is a network call (fetch/push/pull). */
export function isNetworkGit(args) {
  return NETWORK_SUBCOMMANDS.has(args[subcommandIndex(args)]);
}

/** Whether the gh credential helper is enabled for this call. */
export function credentialEnabled({ ghCredential, env } = {}) {
  return Boolean(ghCredential) || env?.DEV_CYCLE_GIT_CREDENTIAL === 'gh';
}

function tail(text, lines = 20) {
  return String(text ?? '').trimEnd().split('\n').slice(-lines).join('\n');
}

/**
 * Spawn `cmd args` with a timeout and process-group kill.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runProcess(cmd, args, { cwd, env, timeout_s, spawn = spawnImpl, label }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const pid = child.pid;
    track(pid);
    let out = '';
    let errText = '';
    let settled = false;
    let graceTimer;
    const collect = (which) => (chunk) => {
      const s = chunk.toString('utf8');
      if (which === 'out') { if (out.length < OUTPUT_CAP) out += s; } else if (errText.length < OUTPUT_CAP) errText += s;
    };
    child.stdout?.on('data', collect('out'));
    child.stderr?.on('data', collect('err'));

    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      active.delete(pid);
      fn();
    };
    const timer = setTimeout(() => {
      if (typeof pid === 'number') killGroup(pid);
      else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      child.stdout?.destroy();
      child.stderr?.destroy();
      done(() => reject(new GitFailure('timeout', `${label} did not finish within ${timeout_s}s; process group killed`)));
    }, timeout_s * 1000);

    child.on('error', (err) => done(() => reject(err)));
    child.on('exit', (code) => {
      // A leaked grandchild may keep the pipes open; do not wait on it forever.
      graceTimer = setTimeout(() => {
        if (typeof pid === 'number') killGroup(pid);
        done(() => resolve({ code, stdout: out, stderr: errText }));
      }, CLOSE_GRACE_MS);
    });
    child.on('close', (code) => done(() => resolve({ code, stdout: out, stderr: errText })));
  });
}

/**
 * Run git.
 * @param {string[]} args  git argv (without `git`)
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Record<string,string|undefined>} [opts.env]  base env (ctx.env)
 * @param {number} [opts.timeout_s]  default 120 for fetch/push/pull, else 60
 * @param {boolean} [opts.ghCredential]  force the gh credential helper (R14)
 * @param {Function} [opts.spawn]  per-call spawn override
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
export async function gitRun(args, opts = {}) {
  const network = isNetworkGit(args);
  const argv = network && credentialEnabled(opts) ? [...CREDENTIAL_PREFIX, ...args] : [...args];
  assertSafeArgs('git', argv);
  const env = { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  const timeout_s = opts.timeout_s ?? (network ? NETWORK_TIMEOUT_S : LOCAL_TIMEOUT_S);
  return runProcess('git', argv, {
    cwd: opts.cwd, env, timeout_s, spawn: opts.spawn ?? spawnImpl,
    label: `git ${args[subcommandIndex(args)] ?? ''}`.trim(),
  });
}

/** gh binary: $DEV_CYCLE_GH else `gh`. */
export function ghBinary(env) {
  return env?.DEV_CYCLE_GH || 'gh';
}

/**
 * Run gh with GH_PROMPT_DISABLED=1.
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string|undefined>, timeout_s?: number, spawn?: Function}} [opts]
 */
export async function ghRun(args, opts = {}) {
  assertSafeArgs('gh', args);
  const base = opts.env ?? process.env;
  const env = { ...base, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
  return runProcess(ghBinary(base), [...args], {
    cwd: opts.cwd, env, timeout_s: opts.timeout_s ?? GH_TIMEOUT_S, spawn: opts.spawn ?? spawnImpl,
    label: `gh ${args.slice(0, 2).join(' ')}`,
  });
}

/**
 * Run git and throw when it exits non-zero. Use for local plumbing calls
 * whose failure means the repo is not in a usable state.
 * Without `reason` a failure throws GitPlumbingError (exit 2); pass a
 * GIT_REASONS value only when the failure really is that outcome (e.g. a
 * checkout blocked by conflicting local changes → 'conflict').
 * @param {string[]} args
 * @param {object} opts  as gitRun, plus optional `reason`
 * @returns {Promise<string>} trimmed stdout
 */
export async function gitOk(args, opts = {}) {
  const r = await gitRun(args, opts);
  if (r.code !== 0) {
    const detail = `git ${args.join(' ')}: ${tail(r.stderr || r.stdout) || `exit ${r.code}`}`;
    if (opts.reason) throw new GitFailure(opts.reason, detail);
    throw new GitPlumbingError(`git plumbing failed — ${detail}`);
  }
  return r.stdout.trim();
}

/**
 * `gh auth status` preflight (R13). Throws GitFailure('auth') when gh is
 * missing, times out or reports not logged in.
 * @param {{cwd?: string, env?: Record<string,string|undefined>, spawn?: Function}} [opts]
 */
export async function ghAuthPreflight(opts = {}) {
  let r;
  try {
    r = await ghRun(['auth', 'status'], { ...opts, timeout_s: opts.timeout_s ?? 30 });
  } catch (err) {
    if (err instanceof GitFailure) throw new GitFailure('auth', `gh auth status: ${err.detail}`);
    throw new GitFailure('auth', `gh auth status: cannot run ${ghBinary(opts.env ?? process.env)} (${err?.code ?? err?.message ?? err})`);
  }
  if (r.code !== 0) {
    throw new GitFailure('auth', `gh auth status failed: ${tail(r.stderr || r.stdout, 5) || `exit ${r.code}`}`);
  }
}

/** Options every git verb accepts (merge into parseCommandArgs options). */
export const GIT_COMMON_OPTIONS = Object.freeze({
  'gh-credential': { type: 'boolean' },
});

/** Build gitRun/ghRun opts from a CLI ctx and parsed values. */
export function execOpts(ctx, values = {}) {
  return { cwd: ctx.cwd, env: ctx.env, ghCredential: Boolean(values['gh-credential']) };
}

export { tail as outputTail };
