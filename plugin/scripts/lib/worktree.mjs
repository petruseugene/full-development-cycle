// Worktree lifecycle library (isolated parallel tasks).
//
//   gitCommonDir(root, env)                      -> abs real path of $GIT_COMMON_DIR
//   readManifest / writeManifest / clearManifest -> $GIT_COMMON_DIR/dev-cycle/worktrees.json
//   ensureExclude(commonDir, dir)                -> idempotent `/<dir>/` in info/exclude
//   decideIsolation({mode, min_group}, tasks)    -> which tasks get a worktree
//   createWorktree / fillWorktree / removeWorktree / rollbackWorktrees
//
// Safety rules: all git calls go through git-exec.mjs; `git worktree remove
// --force` is never used; removal only touches a realpath that is a direct
// child of `<main root>/<dir>`; `setup` runs argv-safe (no shell) with
// cwd = the worktree; link/copy sources must stay inside the main root.

import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './core.mjs';
import { gitOk, gitRun } from './git-exec.mjs';
import { hasTagToken, isContentTask, isOwnerTask } from './plan.mjs';
import { parseRecipeCmd } from './recipe-safety.mjs';
import { DEFAULT_TIMEOUT_S, runStep } from './runner.mjs';

export const ELIGIBLE_TAGS = Object.freeze(['frontend', 'backend', 'mixed']);

/** A worktree lifecycle failure (exit 1). */
export class WorktreeError extends CliError {
  constructor(message, code = 1) { super(message, code); this.name = 'WorktreeError'; }
}

/** A path outside the allowed confinement (exit 2). */
export class WorktreeRefusal extends WorktreeError {
  constructor(message) { super(message, 2); this.name = 'WorktreeRefusal'; }
}

function unsafeRel(p) {
  return typeof p !== 'string' || p === '' || path.isAbsolute(p) || p.startsWith('/')
    || p.split(/[\\/]+/).includes('..') || p.includes('\0');
}

function relDir(dir) {
  if (unsafeRel(dir)) throw new WorktreeRefusal(`worktrees dir must be repo-relative without '..' (got ${JSON.stringify(dir)})`);
  const s = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (s === '' || s === '.') throw new WorktreeRefusal('worktrees dir must not be the repo root');
  return s;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// --- git common dir + manifest ----------------------------------------------

/** Absolute real path of the repository's common git dir (shared by all worktrees). */
export async function gitCommonDir(root, env) {
  const out = await gitOk(['rev-parse', '--git-common-dir'], { cwd: root, env });
  return fs.realpathSync(path.resolve(root, out));
}

export function manifestPath(commonDir) {
  return path.join(commonDir, 'dev-cycle', 'worktrees.json');
}

/** @returns {object|null} parsed manifest, or null when absent. Throws on corrupt JSON. */
export function readManifest(commonDir) {
  let text;
  try { text = fs.readFileSync(manifestPath(commonDir), 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try { return JSON.parse(text); } catch {
    throw new WorktreeError(`worktree manifest is not valid JSON: ${manifestPath(commonDir)} (run \`remove --all\` or delete it)`);
  }
}

/** Atomic write (tmp + rename). */
export function writeManifest(commonDir, manifest) {
  const file = manifestPath(commonDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function clearManifest(commonDir) {
  fs.rmSync(manifestPath(commonDir), { force: true });
}

/**
 * Add `/<dir>/` to `$GIT_COMMON_DIR/info/exclude` once. Never touches a
 * tracked .gitignore.
 * @returns {boolean} true when the line was added
 */
export function ensureExclude(commonDir, dir) {
  const line = `/${relDir(dir)}/`;
  const file = path.join(commonDir, 'info', 'exclude');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  if (text.split(/\r?\n/).includes(line)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
  return true;
}

// --- isolation decision ------------------------------------------------------

/**
 * Decide which tasks of a parallel group get a worktree. Pure.
 * Eligible = tag frontend|backend|mixed and not content/owner. Isolation
 * applies only in `auto` mode with at least `min_group` eligible tasks.
 * @param {{mode?: string, min_group?: number}} cfg
 * @param {Array<{n:number, tag?:string}>} tasks
 * @returns {{isolated: boolean, tasks: Array<{n:number, eligible:boolean, isolate:boolean}>}}
 */
export function decideIsolation(cfg, tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const rows = list.map((t) => ({
    n: t.n,
    eligible: ELIGIBLE_TAGS.some((tok) => hasTagToken(t, tok)) && !isContentTask(t) && !isOwnerTask(t),
  }));
  const min = Number.isInteger(cfg?.min_group) ? cfg.min_group : 3;
  const isolated = cfg?.mode === 'auto' && rows.filter((r) => r.eligible).length >= min;
  return { isolated, tasks: rows.map((r) => ({ ...r, isolate: isolated && r.eligible })) };
}

// --- create ------------------------------------------------------------------

function taskNumber(n) {
  if (!Number.isInteger(n) || n < 0) throw new WorktreeRefusal(`invalid task number: ${n}`);
  return n;
}

/**
 * `git worktree add --detach <main>/<dir>/task-<n> <base>` with hooks disabled.
 * @returns {Promise<string>} absolute worktree path
 */
export async function createWorktree({ mainRoot, dir, n, base, env }) {
  const rel = relDir(dir);
  const root = fs.realpathSync(mainRoot);
  const parent = path.join(root, rel);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync(parent);
  if (!isInside(root, realParent)) throw new WorktreeRefusal(`worktrees dir resolves outside the repo: ${realParent}`);
  const target = path.join(realParent, `task-${taskNumber(n)}`);
  if (fs.existsSync(target)) throw new WorktreeError(`worktree path already exists: ${target}`);
  await gitOk(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', target, base], { cwd: root, env });
  return target;
}

// --- fill --------------------------------------------------------------------

/** Glob to RegExp: `**` any depth, `*` and `?` within a segment. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Ignored entries of the main tree: directories carry a trailing '/'. */
async function ignoredEntries(root, env) {
  const r = await gitRun(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    { cwd: root, env },
  );
  if (r.code !== 0) throw new WorktreeError(`git ls-files failed: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter(Boolean).filter((e) => !unsafeRel(e));
}

/**
 * Populate a fresh worktree: symlink ignored `link` matches, copy ignored
 * `copy` matches as regular files, then run `setup` (argv-safe, cwd = worktree).
 * Throws on a failing setup; the caller rolls back.
 * @returns {Promise<{linked: string[], copied: string[]}>}
 */
export async function fillWorktree({ mainRoot, wtPath, link = [], copy = [], setup, env, timeout_s = DEFAULT_TIMEOUT_S }) {
  const root = fs.realpathSync(mainRoot);
  const wt = fs.realpathSync(wtPath);
  const linkRes = link.map(globToRegExp);
  const copyRes = copy.map(globToRegExp);
  const linked = [];
  const copied = [];
  if (linkRes.length || copyRes.length) {
    for (const entry of await ignoredEntries(root, env)) {
      const isDir = entry.endsWith('/');
      const rel = isDir ? entry.slice(0, -1) : entry;
      const src = path.join(root, rel);
      const dst = path.join(wt, rel);
      let st;
      try { st = fs.lstatSync(src); } catch { continue; }
      if (linkRes.some((re) => re.test(rel))) {
        if (st.isSymbolicLink() || !isInside(root, fs.realpathSync(src))) continue;
        if (fs.existsSync(dst) || isLink(dst)) continue;
        confineDest(wt, dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        confineDest(wt, dst);
        fs.symlinkSync(src, dst);
        linked.push(rel);
      } else if (!isDir && copyRes.some((re) => re.test(rel)) && st.isFile()) {
        if (!isInside(root, fs.realpathSync(src))) continue;
        confineDest(wt, dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        confineDest(wt, dst);
        if (isLink(dst)) throw new WorktreeRefusal(`refusing to copy over a symlink in the worktree: ${rel}`);
        fs.copyFileSync(src, dst);
        copied.push(rel);
      }
    }
  }
  if (typeof setup === 'string' && setup.trim() !== '') {
    const { words, problems } = parseRecipeCmd(setup);
    if (problems.length) throw new WorktreeError(`worktrees.setup is not a valid command (${problems[0]})`);
    if (words.some((w) => 'ph' in w)) throw new WorktreeError('worktrees.setup must not contain {placeholders}');
    const res = await runStep({
      argv: words.map((w) => w.lit), timeout_s, featureDir: '', root: wt, env,
    });
    if (res.status !== 'PASSED') {
      const why = res.timedOut ? `timed out after ${timeout_s}s` : `exit ${res.exitCode ?? 'none'}`;
      throw new WorktreeError(`worktrees.setup failed (${why}): ${res.output.trim().split('\n').slice(-10).join('\n')}`);
    }
  }
  return { linked, copied };
}

/** Defense in depth: the nearest existing ancestor of `dst` must resolve inside the worktree. */
function confineDest(wt, dst) {
  let p = path.dirname(dst);
  for (;;) {
    try {
      const real = fs.realpathSync(p);
      if (real !== wt && !isInside(wt, real)) throw new WorktreeRefusal(`refusing fill destination outside the worktree: ${dst}`);
      return;
    } catch (err) {
      if (err instanceof WorktreeError) throw err;
      const up = path.dirname(p);
      if (up === p) throw new WorktreeRefusal(`refusing fill destination outside the worktree: ${dst}`);
      p = up;
    }
  }
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// --- remove ------------------------------------------------------------------

/** True when two worktrees `dir` values name the same repo-relative directory. */
export function sameDir(a, b) {
  try { return relDir(a) === relDir(b); } catch { return false; }
}

/** True when `<target>/.git` is a real linked-worktree pointer of this repo (gitdir under `<commonDir>/worktrees/`). */
function isLinkedWorktreeOf(commonDir, real) {
  try {
    const gitFile = path.join(real, '.git');
    if (!fs.lstatSync(gitFile).isFile()) return false;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!m) return false;
    const gitdir = fs.realpathSync(path.resolve(real, m[1]));
    if (!isInside(path.join(commonDir, 'worktrees'), gitdir)) return false;
    // the admin dir must point back at this very checkout
    const back = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    return fs.realpathSync(path.resolve(gitdir, back)) === path.join(real, '.git');
  } catch { return false; }
}

/**
 * Decide whether `wtPath` may be removed (sync, no writes). `dir` must come
 * from the trusted profile; `manifestDir` (the manifest's own value) must equal
 * it. `<main>/<dir>` must be a real directory inside the main root (no symlink
 * component) and the target a direct child that is a linked worktree of this repo.
 * @returns {{problem: string|null, base?: string, real?: string, missing?: boolean}}
 */
export function worktreeRemovable({ mainRoot, dir, manifestDir, wtPath, commonDir }) {
  const root = fs.realpathSync(mainRoot);
  let rel;
  try { rel = relDir(dir); } catch (err) { return { problem: err.message }; }
  if (manifestDir !== undefined && !sameDir(dir, manifestDir)) {
    return { problem: `manifest dir ${JSON.stringify(manifestDir)} differs from the profile worktrees.dir ${JSON.stringify(dir)}` };
  }
  const candidate = path.join(root, rel);
  let base;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return { problem: `worktrees dir is a symlink: ${rel}` };
    base = fs.realpathSync(candidate);
  } catch { return { problem: `worktrees dir does not exist: ${rel}` }; }
  if (!isInside(root, base) || base !== candidate) return { problem: `worktrees dir resolves outside the repo: ${base}` };
  if (typeof wtPath !== 'string' || wtPath === '' || wtPath.includes('\0')) return { problem: `invalid worktree path ${JSON.stringify(wtPath)}` };
  const abs = path.resolve(wtPath);
  let st;
  try { st = fs.lstatSync(abs); } catch (err) {
    if (err?.code === 'ENOENT') {
      return path.dirname(abs) === base ? { problem: null, base, missing: true } : { problem: `path is outside ${base}` };
    }
    return { problem: `cannot stat worktree path: ${err.message}` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { problem: 'not a plain worktree directory' };
  let real;
  try { real = fs.realpathSync(abs); } catch { return { problem: 'unresolvable' }; }
  if (path.dirname(real) !== base) return { problem: `not a direct child of ${base}` };
  if (!isLinkedWorktreeOf(commonDir, real)) return { problem: 'not a linked worktree of this repository' };
  return { problem: null, base, real };
}

/**
 * Remove one recorded worktree. `dir` is the trusted profile value (pass the
 * manifest's own as `manifestDir`; a mismatch is refused). The target must be a
 * real linked worktree of this repo, a real directory (not a symlink) that is a
 * direct child of `<main root>/<dir>`; anything else is refused
 * (WorktreeRefusal, exit 2) and left intact. Never `--force`.
 * @returns {Promise<{removed: boolean}>} removed=false when the path was already gone
 */
export async function removeWorktree({ mainRoot, dir, manifestDir, wtPath, env }) {
  const root = fs.realpathSync(mainRoot);
  const commonDir = await gitCommonDir(root, env);
  const r = worktreeRemovable({ mainRoot: root, dir, manifestDir, wtPath, commonDir });
  if (r.problem) throw new WorktreeRefusal(`refusing to remove ${JSON.stringify(wtPath)}: ${r.problem}`);
  if (r.missing) {
    await gitRun(['worktree', 'prune'], { cwd: root, env });
    return { removed: false };
  }
  fs.rmSync(r.real, { recursive: true });
  await gitRun(['worktree', 'prune'], { cwd: root, env });
  return { removed: true };
}

/**
 * Remove every worktree created by a failed start. Never throws; returns the
 * error lines of paths that could not be removed.
 * @returns {Promise<string[]>}
 */
export async function rollbackWorktrees({ mainRoot, dir, paths, env }) {
  const errors = [];
  for (const p of paths ?? []) {
    if (!p) continue;
    try { await removeWorktree({ mainRoot, dir, wtPath: p, env }); } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  try { await gitRun(['worktree', 'prune'], { cwd: mainRoot, env }); } catch { /* best effort */ }
  return errors;
}
