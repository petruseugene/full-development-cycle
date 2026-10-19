// dev-cycle worktree start --tasks <n,..> | collect | remove --all|--task <n> | list
// (spec R7-R15). Opt-in via profile `worktrees.mode` (off | audit | auto).
//
// The manifest lives in $GIT_COMMON_DIR/dev-cycle/worktrees.json:
//   { version, feature, main_root, base, base_tree, mode, dir, isolated, created,
//     tasks: [{n, path|null, touches, links, copies, removed?}],    // isolated candidates
//     others: [{n, touches}] }                                       // tasks run in the main tree
//
// Exit codes: 0 OK, 1 FAILED (setup failure, conflict, stray), 2 usage/validation.

import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, mainWorktreeRoot, output, parseCommandArgs, resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import { appendHistory } from './history.mjs';
import { currentTree, snapshotCommit, TREE_RE } from './git-tree.mjs';
import { parsePlan, requireTasksSource } from './plan.mjs';
import { loadProfile, worktreesConfig } from './profile.mjs';
import {
  WorktreeError, clearManifest, createWorktree, decideIsolation, ensureExclude, fillWorktree,
  gitCommonDir, readManifest, removeWorktree, rollbackWorktrees, sameDir, worktreeRemovable, writeManifest,
} from './worktree.mjs';
import {
  applyTask, checkTask, diffTask, driftAudit,
} from './worktree-collect.mjs';

const USAGE = 'worktree start --tasks <n,..> | collect | remove --all|--task <n> | list [--json] [--feature <dir>]';

// --- shared helpers ---------------------------------------------------------------

function unsafeRel(p) {
  return typeof p !== 'string' || p === '' || path.isAbsolute(p) || p.startsWith('/')
    || p.split(/[\\/]+/).includes('..') || p.includes('\0');
}

function mainRootOf(ctx) {
  const root = mainWorktreeRoot(resolveProjectRoot(ctx));
  try { return fs.realpathSync(root); } catch { throw new UsageError(`project root not found: ${root}`); }
}

function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

/** Read the manifest, or exit 2. A corrupt file is exit 2 with a hint. */
function requireManifest(commonDir, { allowCorrupt = false } = {}) {
  let m;
  try { m = readManifest(commonDir); } catch (err) {
    if (allowCorrupt && err instanceof WorktreeError) return { corrupt: true };
    throw new UsageError(err.message);
  }
  if (m === null) throw new UsageError('no active worktree manifest (nothing to do; start one with `worktree start`)');
  validateManifest(m);
  return m;
}

function validateManifest(m) {
  const bad = (why) => { throw new UsageError(`invalid worktree manifest (${why}); run \`worktree remove --all\``); };
  if (m === null || typeof m !== 'object' || Array.isArray(m)) bad('not an object');
  if (typeof m.base !== 'string' || !TREE_RE.test(m.base)) bad('base');
  if (unsafeRel(m.dir)) bad('dir');
  if (!Array.isArray(m.tasks)) bad('tasks');
  for (const t of m.tasks) {
    if (t === null || typeof t !== 'object' || !Number.isInteger(t.n)) bad('task entry');
    if (t.path !== null && t.path !== undefined && typeof t.path !== 'string') bad('task path');
  }
  if (m.others !== undefined && !Array.isArray(m.others)) bad('others');
  if (m.feature !== undefined && m.feature !== null && unsafeRel(m.feature)) bad('feature');
}

const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * The worktrees dir to trust: the profile's, never the manifest's. A manifest
 * whose `dir` differs is refused (exit 2) so a tampered file cannot move the
 * removal confinement.
 */
function trustedDir(ctx, manifest) {
  const { profile } = loadProfile(ctx);
  const dir = worktreesConfig(profile).dir;
  if (!sameDir(dir, manifest.dir)) {
    throw new UsageError(
      `refusing worktree manifest: its dir ${JSON.stringify(manifest.dir)} differs from the profile worktrees.dir ${JSON.stringify(dir)}`
      + ' (restore the profile value, or delete the manifest by hand)',
    );
  }
  return dir;
}

/** Null when `p` is a linked worktree that is a direct child of the trusted `<main>/<dir>`; else the reason. */
function pathProblem(mainRoot, dir, manifestDir, p, commonDir) {
  const r = worktreeRemovable({ mainRoot, dir, manifestDir, wtPath: p, commonDir });
  if (r.missing) return 'worktree directory is missing';
  return r.problem;
}

function featureDirFor(ctx, values, manifest, mainRoot) {
  if (!values.feature && typeof manifest?.feature === 'string' && !unsafeRel(manifest.feature)) {
    try { return resolveFeatureDir(ctx, { feature: path.join(mainRoot, manifest.feature) }); } catch { /* fall back */ }
  }
  return resolveFeatureDir(ctx, values);
}

// --- start --------------------------------------------------------------------------

function parseTaskList(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+(\s*,\s*\d+)*$/.test(s)) throw new UsageError(`--tasks must be a comma-separated list of task numbers (got '${raw}')`);
  return [...new Set(s.split(',').map((x) => Number(x.trim())))];
}

async function start(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE, options: { tasks: { type: 'string' } },
  });
  if (values.tasks === undefined) throw new UsageError(`worktree start requires --tasks <n,..> (usage: dev-cycle ${USAGE})`);
  const wanted = parseTaskList(values.tasks);

  const { profile } = loadProfile(ctx);
  const cfg = worktreesConfig(profile);
  if (cfg.mode !== 'off' && !['audit', 'auto'].includes(cfg.mode)) throw new UsageError(`invalid worktrees.mode '${cfg.mode}'`);
  if (cfg.mode === 'off') {
    throw new UsageError('worktree isolation is off (set worktrees.mode to "audit" or "auto" in .dev-cycle/project.json)');
  }

  const featureDir = resolveFeatureDir(ctx, values);
  const plan = parsePlan(requireTasksSource(featureDir).text);
  const group = wanted.map((n) => {
    const t = plan.find((x) => x.n === n);
    if (!t) throw new UsageError(`unknown task ${n}`);
    if (t.status === 'DONE') throw new UsageError(`task ${n} is [DONE]; cannot start a worktree for it`);
    return t;
  });

  const mainRoot = mainRootOf(ctx);
  const env = ctx.env;
  const commonDir = await gitCommonDir(mainRoot, env);
  if (requireActive(commonDir)) {
    throw new UsageError('a worktree manifest is already active; run `worktree collect` to apply it or `worktree remove --all` to drop it');
  }

  const featureRel = relPosix(mainRoot, fs.realpathSync(featureDir));
  const decision = decideIsolation(cfg, group);
  const isolate = new Map(decision.tasks.map((r) => [r.n, r.isolate]));

  const tree = await currentTree({ env }, mainRoot, { dropPrefix: featureRel });
  const base = await snapshotCommit(tree, 'HEAD', { cwd: mainRoot, env });

  const created = [];
  const entries = [];
  const fail = async (n, step, err) => {
    const left = await rollbackWorktrees({ mainRoot, dir: cfg.dir, paths: created, env });
    const extra = left.length ? `; rollback left: ${left.join('; ')}` : '';
    throw new WorktreeError(`worktree start failed at task ${n}, step ${step}: ${err.message ?? err}${extra}`);
  };

  if (decision.isolated) {
    try { ensureExclude(commonDir, cfg.dir); } catch (err) { await fail(group[0].n, 'exclude', err); }
  }
  for (const t of group) {
    if (!isolate.get(t.n)) { entries.push({ n: t.n, path: null, touches: strs(t.touches), links: [], copies: [] }); continue; }
    let wt;
    try {
      wt = await createWorktree({ mainRoot, dir: cfg.dir, n: t.n, base, env });
    } catch (err) { await fail(t.n, 'worktree add', err); }
    created.push(wt);
    let filled;
    try {
      filled = await fillWorktree({
        mainRoot, wtPath: wt, link: cfg.link, copy: cfg.copy, setup: cfg.setup, env,
      });
    } catch (err) { await fail(t.n, 'fill/setup', err); }
    entries.push({ n: t.n, path: wt, touches: strs(t.touches), links: filled.linked, copies: filled.copied });
  }

  const manifest = {
    version: 1,
    feature: featureRel,
    main_root: mainRoot,
    base,
    base_tree: tree,
    mode: cfg.mode,
    dir: cfg.dir,
    isolated: decision.isolated,
    created: new Date().toISOString(),
    tasks: entries.filter((e) => e.path !== null),
    others: entries.filter((e) => e.path === null).map((e) => ({ n: e.n, touches: e.touches })),
  };
  try { writeManifest(commonDir, manifest); } catch (err) { await fail(group[0].n, 'manifest', err); }

  const data = { base, isolated: decision.isolated, tasks: entries.map((e) => ({ n: e.n, path: e.path })) };
  output(ctx, values, {
    text: [`base ${base}`, decision.isolated ? 'isolated: yes' : 'isolated: no',
      ...data.tasks.map((t) => `task ${t.n}: ${t.path ?? '(main tree)'}`)],
    data,
  });
  return 0;
}

/** True when a manifest file exists (corrupt counts as active). */
function requireActive(commonDir) {
  try { return readManifest(commonDir) !== null; } catch { return true; }
}

// --- collect ------------------------------------------------------------------------

async function collect(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: USAGE });
  const mainRoot = mainRootOf(ctx);
  const env = ctx.env;
  const commonDir = await gitCommonDir(mainRoot, env);
  const manifest = requireManifest(commonDir);
  const featureDir = featureDirFor(ctx, values, manifest, mainRoot);
  const dir = trustedDir(ctx, manifest);

  const errors = [];
  const live = [];
  const refused = [];
  const others = [];
  for (const o of manifest.others ?? []) others.push(...strs(o?.touches));
  for (const t of manifest.tasks) {
    if (t.path === null || t.path === undefined) { others.push(...strs(t.touches)); continue; }
    const problem = pathProblem(mainRoot, dir, manifest.dir, t.path, commonDir);
    if (problem) {
      errors.push(`task ${t.n}: skipped, refusing worktree path ${JSON.stringify(t.path)} (${problem})`);
      refused.push({ n: t.n, reason: problem });
      continue;
    }
    live.push({
      n: t.n, path: t.path, touches: strs(t.touches),
      linked: strs(t.links ?? t.linked ?? t.link), copied: strs(t.copies ?? t.copied ?? t.copy),
    });
  }

  // Same steps as collectTasks, but tracks progress so an internal failure
  // cannot discard the work of tasks that were not applied yet.
  const applied = [];
  const conflicts = [];
  const touches_expanded = {};
  const expandedAll = {};
  const claimed = [];
  const processed = new Set();
  let stray = [];
  let failure = null;
  for (const task of [...live].sort((a, b) => a.n - b.n)) {
    try {
      const diff = await diffTask(task, manifest.base, { env, mainRoot, dir });
      const res = await applyTask(await checkTask(diff, { env, mainRoot }), { env, mainRoot });
      expandedAll[String(task.n)] = diff.touches_expanded;
      if (res.applied) {
        applied.push({ n: task.n, paths: res.paths });
        claimed.push(...res.paths);
        if (diff.touches_expanded.length) touches_expanded[String(task.n)] = diff.touches_expanded;
      } else {
        conflicts.push({ n: task.n, paths: res.conflicts });
      }
      processed.add(task.n);
    } catch (err) {
      failure = `task ${task.n}: collect failed: ${err.message}`;
      break;
    }
  }
  if (failure === null) {
    try {
      stray = await driftAudit({
        env, mainRoot, dir, base: manifest.base, applied: claimed, touches: others,
        featureRel: manifest.feature ?? relPosix(mainRoot, featureDir),
      });
    } catch (err) { failure = `drift audit failed: ${err.message}`; }
  }

  // Remove the worktrees that were collected (applied or conflicted); keep the rest on failure.
  const removedNs = [];
  for (const t of live) {
    if (!processed.has(t.n)) continue;
    try { await removeWorktree({ mainRoot, dir, manifestDir: manifest.dir, wtPath: t.path, env }); removedNs.push(t.n); } catch (err) {
      errors.push(`task ${t.n}: could not remove worktree: ${err.message}`);
    }
  }

  const history = (entry) => appendHistory(featureDir, { phase: 'worktree', subagent: 'cli', executor: 'cli', ...entry });
  const recordTasks = () => {
    const appliedBy = new Map(applied.map((a) => [a.n, a.paths]));
    const conflictBy = new Map(conflicts.map((c) => [c.n, c.paths]));
    for (const n of [...processed].sort((a, b) => a - b)) {
      if (appliedBy.has(n)) {
        history({ status: 'APPLIED', task: n, files: appliedBy.get(n).length, touches_expanded: expandedAll[String(n)] ?? [] });
      } else if (conflictBy.has(n)) {
        history({
          status: 'CONFLICT', task: n, files: 0, touches_expanded: expandedAll[String(n)] ?? [], conflicts: conflictBy.get(n),
        });
      }
    }
    for (const r of refused) history({ status: 'REFUSED', task: r.n, files: 0, touches_expanded: [], summary: r.reason });
  };

  const results = {
    applied, conflicts, touches_expanded, stray, refused,
  };
  const render = () => [
    ...applied.map((a) => `task ${a.n}: applied ${a.paths.length} path(s)`),
    ...conflicts.map((c) => `task ${c.n}: CONFLICT ${c.paths.map((p) => `${p.path || '(task)'} [${p.reason}]`).join(', ')}`),
    ...Object.entries(touches_expanded).map(([n, p]) => `task ${n}: touches_expanded ${p.join(', ')}`),
    ...(stray.length ? [`stray: ${stray.join(', ')}`] : []),
  ];

  if (failure !== null) {
    errors.push(failure);
    try {
      recordTasks();
      // Keep the manifest: unapplied tasks still hold their worktrees; `remove --all` is the recovery.
      for (const t of manifest.tasks) if (removedNs.includes(t.n)) { t.path = null; t.removed = true; }
      writeManifest(commonDir, manifest);
    } catch (err) { errors.push(`could not record partial progress: ${err.message}`); }
    for (const e of errors) ctx.stderr.write(`error: ${e}\n`);
    const kept = live.filter((t) => !processed.has(t.n)).map((t) => t.n);
    output(ctx, values, {
      text: [...render(), `collect aborted; manifest kept; worktrees kept for task(s): ${kept.join(', ') || '(none)'}; recover with \`worktree remove --all\``],
      data: { ...results, aborted: true, kept },
    });
    return 1;
  }

  try {
    recordTasks();
    history({
      status: manifest.isolated === true || (manifest.isolated === undefined && live.length > 0) ? 'ISOLATED' : 'AUDIT',
      tasks: [...manifest.tasks.map((t) => t.n), ...(manifest.others ?? []).map((o) => o.n)].sort((a, b) => a - b),
      stray,
    });
  } finally {
    clearManifest(commonDir);
  }

  for (const e of errors) ctx.stderr.write(`error: ${e}\n`);
  const text = render();
  if (!text.length) text.push('nothing to collect');
  output(ctx, values, { text, data: results });
  return conflicts.length > 0 || stray.length > 0 || errors.length > 0 ? 1 : 0;
}

// --- remove -------------------------------------------------------------------------

async function remove(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE, options: { all: { type: 'boolean' }, task: { type: 'string' } },
  });
  if (Boolean(values.all) === (values.task !== undefined)) {
    throw new UsageError(`worktree remove needs exactly one of --all or --task <n> (usage: dev-cycle ${USAGE})`);
  }
  let only;
  if (values.task !== undefined) {
    if (!/^\d+$/.test(values.task)) throw new UsageError(`--task must be a task number (got '${values.task}')`);
    only = Number(values.task);
  }
  const mainRoot = mainRootOf(ctx);
  const env = ctx.env;
  const commonDir = await gitCommonDir(mainRoot, env);
  const manifest = requireManifest(commonDir, { allowCorrupt: Boolean(values.all) });

  if (manifest.corrupt) {
    clearManifest(commonDir);
    output(ctx, values, { text: 'removed a corrupt worktree manifest', data: { removed: [], active: false } });
    return 0;
  }

  const dir = trustedDir(ctx, manifest);
  const targets = only === undefined ? manifest.tasks : manifest.tasks.filter((t) => t.n === only);
  if (only !== undefined && targets.length === 0) throw new UsageError(`task ${only} is not in the active worktree manifest`);

  const removed = [];
  const refused = [];
  for (const t of targets) {
    if (t.path === null || t.path === undefined) continue;
    try {
      await removeWorktree({ mainRoot, dir, manifestDir: manifest.dir, wtPath: t.path, env });
      removed.push(t.n);
      if (only !== undefined) { t.path = null; t.removed = true; }
    } catch (err) {
      refused.push(`task ${t.n}: ${err.message}`);
    }
  }
  for (const r of refused) ctx.stderr.write(`error: ${r}\n`);

  let active;
  if (only === undefined) {
    clearManifest(commonDir);
    active = false;
  } else if (refused.length === 0) {
    writeManifest(commonDir, manifest);
    active = true;
  } else {
    active = true;
  }
  output(ctx, values, {
    text: [removed.length ? `removed worktree(s) for task(s): ${removed.join(', ')}` : 'no worktrees to remove',
      active ? 'manifest still active' : 'manifest cleared'],
    data: { removed, active },
  });
  return refused.length > 0 ? 2 : 0;
}

// --- list ---------------------------------------------------------------------------

async function list(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: USAGE });
  const mainRoot = mainRootOf(ctx);
  const commonDir = await gitCommonDir(mainRoot, ctx.env);
  let manifest = null;
  if (requireActive(commonDir)) {
    try { manifest = requireManifest(commonDir, { allowCorrupt: true }); } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      manifest = { corrupt: true }; // parses but fails validation: still read-only, exit 0
    }
  }
  if (manifest === null) {
    output(ctx, values, { text: 'no active worktrees', data: { active: false } });
    return 0;
  }
  if (manifest.corrupt) {
    output(ctx, values, {
      text: 'active worktree manifest is corrupt; run `worktree remove --all` to clear it',
      data: { active: true, corrupt: true, hint: 'run `worktree remove --all` to clear it' },
    });
    return 0;
  }
  output(ctx, values, {
    text: [`active (${manifest.mode}) base ${manifest.base}`,
      ...manifest.tasks.map((t) => `task ${t.n}: ${t.path ?? (t.removed ? '(removed)' : '(main tree)')}`),
      ...(manifest.others ?? []).map((o) => `task ${o.n}: (main tree)`)],
    data: { active: true, ...manifest },
  });
  return 0;
}

// --- entry --------------------------------------------------------------------------

export async function run(argv, ctx) {
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'start': return start(rest, ctx);
    case 'collect': return collect(rest, ctx);
    case 'remove': return remove(rest, ctx);
    case 'list': return list(rest, ctx);
    default:
      throw new UsageError(`unknown or missing worktree verb '${verb ?? ''}' (usage: dev-cycle ${USAGE})`);
  }
}
