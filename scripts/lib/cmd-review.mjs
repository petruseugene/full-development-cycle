// dev-cycle review snapshot [--cycle n] | review diff [--since-cycle n] [--name-only]
// (spec R11, R12)
//
// A snapshot is a git tree id of the working tree (tracked + untracked, minus
// .gitignore), computed with a TEMPORARY index so the real index, HEAD, stash
// and working tree are never touched. `diff` compares the current tree with a
// recorded snapshot, leaving the feature folder out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError, output, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { readFeatureJson, updateFeatureJson } from './feature-json.mjs';
import { gitOk, gitRun } from './git-exec.mjs';

const TREE_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const USAGE = 'review snapshot [--cycle n] | review diff [--since-cycle n] [--name-only]';

function parseCycle(raw, flag) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} must be an integer (got '${raw}')`);
  return Number(raw);
}

/** Tree id of the current working tree via a throw-away index seeded from HEAD. */
async function currentTree(ctx, top) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-index-'));
  try {
    const opts = { cwd: top, env: { ...ctx.env, GIT_INDEX_FILE: path.join(dir, 'index') } };
    const head = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: top, env: ctx.env });
    if (head.code === 0) await gitOk(['read-tree', 'HEAD'], opts);
    await gitOk(['add', '-A'], opts);
    const tree = await gitOk(['write-tree'], opts);
    if (!TREE_RE.test(tree)) throw new UsageError(`git write-tree returned an unexpected value: ${tree}`);
    return tree;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function repoTop(ctx) {
  const r = await gitRun(['rev-parse', '--show-toplevel'], { cwd: ctx.cwd, env: ctx.env });
  if (r.code !== 0) throw new UsageError('not inside a git repository');
  return r.stdout.trim();
}

async function snapshot(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE, options: { cycle: { type: 'string' } },
  });
  const explicit = parseCycle(values.cycle, '--cycle');
  const featureDir = resolveFeatureDir(ctx, values);
  readFeatureJson(featureDir);
  const top = await repoTop(ctx);
  const tree = await currentTree(ctx, top);
  let cycle;
  updateFeatureJson(featureDir, (fj) => {
    const list = Array.isArray(fj.review_snapshots) ? fj.review_snapshots : [];
    cycle = explicit ?? list.reduce((m, s) => Math.max(m, Number(s?.cycle) || 0), 0) + 1;
    fj.review_snapshots = [...list, { cycle, tree, ts: new Date().toISOString() }];
  });
  output(ctx, values, { text: tree, data: { cycle, tree } });
  return 0;
}

async function diff(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: { 'since-cycle': { type: 'string' }, 'name-only': { type: 'boolean' } },
  });
  const since = parseCycle(values['since-cycle'], '--since-cycle');
  const featureDir = resolveFeatureDir(ctx, values);
  const list = readFeatureJson(featureDir).review_snapshots;
  const snaps = Array.isArray(list) ? list.filter((s) => s && typeof s.tree === 'string') : [];
  if (snaps.length === 0) throw new UsageError('no review snapshot recorded (run `review snapshot` first)');
  let base;
  if (since === undefined) base = snaps[snaps.length - 1];
  else base = [...snaps].reverse().find((s) => Number(s.cycle) === since);
  if (!base) throw new UsageError(`no review snapshot for cycle ${since}`);
  if (!TREE_RE.test(base.tree)) throw new UsageError(`invalid tree id in review_snapshots: ${base.tree}`);

  const top = await repoTop(ctx);
  const tree = await currentTree(ctx, top);
  const rel = path.relative(top, featureDir).split(path.sep).join('/');
  const args = ['diff', ...(values['name-only'] ? ['--name-only'] : []), base.tree, tree, '--', `:(exclude)${rel}/**`];
  const r = await gitRun(args, { cwd: top, env: ctx.env });
  if (r.code !== 0) throw new UsageError(`git diff failed: ${(r.stderr || r.stdout).trim()}`);
  if (values.json) {
    output(ctx, values, { data: { from: base.tree, to: tree, cycle: base.cycle, diff: r.stdout } });
  } else if (r.stdout !== '') {
    ctx.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n');
  }
  return 0;
}

export async function run(argv, ctx) {
  const [verb, ...rest] = argv;
  if (verb === 'snapshot') return snapshot(rest, ctx);
  if (verb === 'diff') return diff(rest, ctx);
  throw new UsageError(verb ? `unknown review subcommand '${verb}' (usage: dev-cycle ${USAGE})` : `missing subcommand (usage: dev-cycle ${USAGE})`);
}
