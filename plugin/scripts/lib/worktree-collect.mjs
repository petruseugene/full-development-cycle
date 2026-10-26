// Collect library for isolated worktrees: classify a task's diff, check
// preconditions against the main tree, apply all-or-nothing, audit drift.
//
//   diffTrees(env, cwd, base, tree)      -> raw tree diff entries (NUL-parsed, unsafe paths flagged)
//   diffTask(task, base, opts)           -> {n, entries, touches_expanded}
//   checkTask(diff, opts)                -> {n, actions, conflicts}   (no writes)
//   applyTask(check, opts)               -> {applied, paths, conflicts}  (all-or-nothing)
//   collectTasks(opts)                   -> {applied, conflicts, touches_expanded, stray}
//   driftAudit(opts)                     -> sorted string[] of stray paths in the main tree
//
// A manifest task is `{n, path, touches: string[], linked?: string[], copied?: string[]}`
// (`link`/`copy` are accepted as aliases). `base` is the snapshot commit (or tree) id
// recorded at `start`. Options carry `{env, mainRoot, dir, ...}`; `env` is the git env.
//
// Safety: the worktree diff comes from a temp-index snapshot; every path is
// validated (no absolute, no `..`); manifest links/copies, the worktrees `dir`,
// `docs/features/**` and `.git` are excluded; changed symlinks are conflicts
// (`symlink`) and are never followed or written; every write target is checked to
// resolve inside the main root; main blobs are re-read right before writing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentTree } from './git-tree.mjs';
import { gitOk, gitRun } from './git-exec.mjs';

const FEATURES_PREFIX = 'docs/features';
const ZERO_RE = /^0+$/;

// --- path helpers ---------------------------------------------------------------

function unsafeRel(p) {
  return typeof p !== 'string' || p === '' || p.startsWith('/') || path.isAbsolute(p)
    || p.includes('\0') || p.split(/[\\/]+/).includes('..');
}

function normRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function underPrefix(p, prefix) {
  return p === prefix || p.startsWith(`${prefix}/`);
}

function matchesAny(p, globs) {
  for (const raw of globs ?? []) {
    const g = normRel(raw);
    if (g === '') continue;
    if (underPrefix(p, g)) return true;
    try { if (path.posix.matchesGlob(p, g)) return true; } catch { /* undecidable => no match */ }
  }
  return false;
}

/** Paths never diffed or applied: .git, the feature folders, the worktrees dir, manifest links/copies. */
function excluder({ dir, linked = [], copied = [] }) {
  const own = [dir, ...linked, ...copied].filter(Boolean).map(normRel);
  return (p) => p.split('/').includes('.git') || underPrefix(p, FEATURES_PREFIX) || own.some((e) => underPrefix(p, e));
}

function nearestRealAncestor(abs) {
  let cur = abs;
  for (;;) {
    try { return fs.realpathSync(cur); } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const up = path.dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

// --- tree diff ------------------------------------------------------------------

/**
 * `git diff-tree -r --no-renames -z --raw base tree`, parsed.
 * @returns {Promise<Array<{path:string, status:string, oldMode:string, newMode:string, oldSha:string|null, newSha:string|null, unsafe:boolean}>>}
 */
export async function diffTrees(env, cwd, base, tree) {
  const r = await gitRun(['diff-tree', '-r', '--no-renames', '--no-abbrev', '-z', '--raw', base, tree], { cwd, env });
  if (r.code !== 0) throw new Error(`git diff-tree failed: ${r.stderr.trim()}`);
  const toks = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith(':')) continue;
    const [oldMode, newMode, oldSha, newSha, status] = t.slice(1).split(/\s+/);
    const p = toks[++i];
    if (p === undefined) break;
    out.push({
      path: p,
      status: status?.[0] ?? '?',
      oldMode,
      newMode,
      oldSha: ZERO_RE.test(oldSha) ? null : oldSha,
      newSha: ZERO_RE.test(newSha) ? null : newSha,
      unsafe: unsafeRel(p),
    });
  }
  return out;
}

/**
 * Diff one isolated task's worktree against the base and classify each path
 * against the task's Touches. Out-of-Touches paths are exactly `touches_expanded`.
 * @param {{n:number, path:string, touches?:string[], linked?:string[], copied?:string[]}} task
 * @param {string} base
 * @param {{env?: object, mainRoot: string, dir: string}} opts
 */
export async function diffTask(task, base, { env, mainRoot, dir }) {
  const wt = fs.realpathSync(task.path);
  const skip = excluder({ dir, linked: task.linked ?? task.link, copied: task.copied ?? task.copy });
  const tree = await currentTree({ env }, wt, { dropPrefix: [FEATURES_PREFIX, normRel(dir)] });
  const raw = await diffTrees(env, fs.realpathSync(mainRoot), base, tree);
  const entries = [];
  for (const e of raw) {
    if (!e.unsafe && skip(e.path)) continue;
    entries.push({ ...e, inTouches: !e.unsafe && matchesAny(e.path, task.touches) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    n: task.n,
    wt,
    entries,
    touches_expanded: entries.filter((e) => !e.unsafe && !e.inTouches).map((e) => e.path),
  };
}

// --- preconditions ---------------------------------------------------------------

/** Blob id of a main-tree path: sha, null (absent), or a marker string that never equals a blob id. */
async function mainBlob(root, rel, env) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { sha: null };
    throw err;
  }
  if (st.isSymbolicLink()) return { sha: 'symlink', reason: 'symlink' };
  if (!st.isFile()) return { sha: 'not-a-file', reason: 'not-a-file' };
  const sha = await gitOk(['hash-object', `--path=${rel}`, '--', abs], { cwd: root, env });
  return { sha };
}

/** Blob id git would assign to `bytes` at `rel` (same filters as mainBlob). */
async function bytesBlob(root, rel, bytes, env) {
  const dirp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-hash-'));
  try {
    const f = path.join(dirp, 'blob');
    fs.writeFileSync(f, bytes);
    return await gitOk(['hash-object', `--path=${rel}`, '--', f], { cwd: root, env });
  } finally {
    fs.rmSync(dirp, { recursive: true, force: true });
  }
}

function parentConfined(root, rel) {
  return isInside(root, nearestRealAncestor(path.dirname(path.join(root, rel))));
}

/**
 * Decide, per path, whether the change applies (M == B), is already there
 * (M == W) or conflicts. Performs no writes.
 * @param {{n:number, wt:string, entries:object[]}} diff  from diffTask
 * @param {{env?: object, mainRoot: string}} opts
 * @returns {Promise<{n:number, wt:string, actions:Array<{path:string, kind:'write'|'delete'|'noop', exec:boolean, inTouches:boolean, w:string|null}>, conflicts:Array<{path:string, reason:string}>}>}
 */
export async function checkTask(diff, { env, mainRoot }) {
  const root = fs.realpathSync(mainRoot);
  const actions = [];
  const conflicts = [];
  for (const e of diff.entries) {
    if (e.unsafe) { conflicts.push({ path: e.path, reason: 'unsafe-path' }); continue; }
    const wAbs = path.join(diff.wt, e.path);
    if (e.newSha !== null) {
      let st = null;
      try { st = fs.lstatSync(wAbs); } catch { /* handled below */ }
      if (e.newMode === '120000' || st?.isSymbolicLink()) { conflicts.push({ path: e.path, reason: 'symlink' }); continue; }
      if (e.newMode === '160000' || !st?.isFile()) { conflicts.push({ path: e.path, reason: 'unsupported' }); continue; }
      if (!isInside(diff.wt, nearestRealAncestor(path.dirname(wAbs)))) { conflicts.push({ path: e.path, reason: 'symlink' }); continue; }
    }
    if (e.oldMode === '120000') { conflicts.push({ path: e.path, reason: 'symlink' }); continue; }
    if (!parentConfined(root, e.path)) { conflicts.push({ path: e.path, reason: 'symlink' }); continue; }
    const m = await mainBlob(root, e.path, env);
    if (m.reason) { conflicts.push({ path: e.path, reason: m.reason }); continue; }
    const base = { path: e.path, inTouches: e.inTouches, b: e.oldSha, w: e.newSha, exec: e.newMode === '100755' };
    if (m.sha === e.newSha) actions.push({ ...base, kind: 'noop' });
    else if (m.sha === e.oldSha) actions.push({ ...base, kind: e.newSha === null ? 'delete' : 'write' });
    else conflicts.push({ path: e.path, reason: 'main-changed' });
  }
  return { n: diff.n, wt: diff.wt, actions, conflicts };
}

// --- apply -----------------------------------------------------------------------

function ensureParent(root, abs) {
  if (!isInside(root, nearestRealAncestor(path.dirname(abs)))) throw new Error(`refusing to write outside ${root}: ${abs}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
}

function readOriginal(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return undefined;
    return { bytes: fs.readFileSync(abs), mode: st.mode & 0o777 };
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function pruneEmptyDirs(root, abs) {
  let cur = path.dirname(abs);
  while (cur !== root && isInside(root, cur)) {
    try { fs.rmdirSync(cur); } catch { return; }
    cur = path.dirname(cur);
  }
}

/**
 * Apply a checked task to the main tree, all-or-nothing. Every main blob is
 * re-read first; any change since the check turns the task into a conflict
 * with nothing written. A failure while writing restores the originals.
 * @param {{n:number, wt:string, actions:object[], conflicts:object[]}} check  from checkTask
 * @param {{env?: object, mainRoot: string}} opts
 * @returns {Promise<{applied: boolean, paths: string[], conflicts: Array<{path:string, reason:string}>}>}
 */
export async function applyTask(check, { env, mainRoot }) {
  if (check.conflicts.length) return { applied: false, paths: [], conflicts: check.conflicts };
  const root = fs.realpathSync(mainRoot);
  const todo = check.actions.filter((a) => a.kind !== 'noop');
  const claimed = check.actions.map((a) => a.path);
  // Re-read M just before writing, and load the new bytes.
  const stale = [];
  const staged = [];
  for (const a of todo) {
    const m = await mainBlob(root, a.path, env);
    if (m.reason || !parentConfined(root, a.path)) { stale.push({ path: a.path, reason: m.reason ?? 'symlink' }); continue; }
    if (m.sha !== a.b) { stale.push({ path: a.path, reason: 'main-changed' }); continue; }
    let bytes = null;
    if (a.kind === 'write') {
      const wAbs = path.join(check.wt, a.path);
      const st = fs.lstatSync(wAbs);
      if (!st.isFile()) { stale.push({ path: a.path, reason: 'symlink' }); continue; }
      bytes = fs.readFileSync(wAbs);
      // Apply exactly what was checked: hash the bytes about to be written.
      if ((await bytesBlob(root, a.path, bytes, env)) !== a.w) { stale.push({ path: a.path, reason: 'worktree-changed' }); continue; }
    }
    staged.push({ a, bytes, abs: path.join(root, a.path) });
  }
  if (stale.length) return { applied: false, paths: [], conflicts: stale };

  const originals = new Map();
  try {
    for (const s of staged) originals.set(s.abs, readOriginal(s.abs));
    for (const s of staged) {
      if (s.a.kind === 'delete') {
        fs.rmSync(s.abs, { force: true });
        pruneEmptyDirs(root, s.abs);
      } else {
        ensureParent(root, s.abs);
        const tmp = `${s.abs}.dev-cycle-${process.pid}.tmp`;
        fs.writeFileSync(tmp, s.bytes, { mode: s.a.exec ? 0o755 : 0o644 });
        fs.chmodSync(tmp, s.a.exec ? 0o755 : 0o644);
        fs.renameSync(tmp, s.abs);
      }
    }
  } catch (err) {
    for (const [abs, orig] of originals) {
      try {
        if (orig === null) fs.rmSync(abs, { force: true });
        else if (orig) { ensureParent(root, abs); fs.writeFileSync(abs, orig.bytes, { mode: orig.mode }); fs.chmodSync(abs, orig.mode); }
      } catch { /* best effort */ }
    }
    return { applied: false, paths: [], conflicts: [{ path: '', reason: `write-failed: ${err.message}` }] };
  }
  return { applied: true, paths: claimed, conflicts: [] };
}

// --- drift audit -----------------------------------------------------------------

/**
 * Paths changed in the main tree since `base` that no task claims: not in
 * `applied`, not matching any of `touches`. Excludes the feature folder, the
 * worktrees dir and `.git`.
 * @param {{env?: object, mainRoot: string, dir: string, base: string, applied?: string[], touches?: string[], featureRel?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function driftAudit({ env, mainRoot, dir, base, applied = [], touches = [], featureRel }) {
  const root = fs.realpathSync(mainRoot);
  const drop = [FEATURES_PREFIX, normRel(dir)];
  if (featureRel) drop.push(normRel(featureRel));
  const tree = await currentTree({ env }, root, { dropPrefix: drop });
  const skip = excluder({ dir });
  const claimed = new Set(applied);
  const stray = [];
  for (const e of await diffTrees(env, root, base, tree)) {
    if (!e.unsafe && skip(e.path)) continue;
    if (claimed.has(e.path) || matchesAny(e.path, touches)) continue;
    stray.push(e.path);
  }
  return stray.sort();
}

// --- whole-group collect ---------------------------------------------------------

/**
 * Collect isolated tasks in plan order (ascending `n`): each task is diffed,
 * checked and applied before the next is checked, so a sibling that touches an
 * already applied path becomes a conflict. Does not remove worktrees or touch
 * the manifest; the caller does. `stray` is computed after all tasks.
 * @param {{env?: object, mainRoot: string, dir: string, base: string, tasks: object[],
 *   nonIsolatedTouches?: string[], featureRel?: string, audit?: boolean}} opts
 *   tasks: manifest tasks (ignored in `audit`, where `nonIsolatedTouches` holds every task's globs)
 * @returns {Promise<{applied: Array<{n:number, paths:string[]}>, conflicts: Array<{n:number, paths:Array<{path:string, reason:string}>}>,
 *   touches_expanded: Record<string,string[]>, stray: string[]}>}
 */
export async function collectTasks({ env, mainRoot, dir, base, tasks = [], nonIsolatedTouches = [], featureRel, audit = false }) {
  const applied = [];
  const conflicts = [];
  const touches_expanded = {};
  const claimed = [];
  if (!audit) {
    for (const task of [...tasks].sort((a, b) => a.n - b.n)) {
      const diff = await diffTask(task, base, { env, mainRoot, dir });
      const check = await checkTask(diff, { env, mainRoot });
      const res = await applyTask(check, { env, mainRoot });
      if (res.applied) {
        applied.push({ n: task.n, paths: res.paths });
        claimed.push(...res.paths);
        if (diff.touches_expanded.length) touches_expanded[String(task.n)] = diff.touches_expanded;
      } else {
        conflicts.push({ n: task.n, paths: res.conflicts });
      }
    }
  }
  const stray = await driftAudit({ env, mainRoot, dir, base, applied: claimed, touches: nonIsolatedTouches, featureRel });
  return { applied, conflicts, touches_expanded, stray };
}
