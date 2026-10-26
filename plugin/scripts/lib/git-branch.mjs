// dev-cycle git branch [<name>] [--base <ref>] [--gh-credential]   (spec R15)
//
// - Name: <feat|fix|hotfix>/<feature_slug> unless given.
// - Base: --base; for hotfix the latest release tag (`gh release view --json
//   tagName`, after `gh auth status`); else the default branch
//   (origin/HEAD → origin/<default> when it exists, else local `main`).
// - Preflight: the local default branch must have no commits that are not on
//   its upstream (reason `main-ahead`). `origin` is fetched first when present.
// - `git checkout --no-track -b <name> <base>` keeps modified/untracked files.
// - Sets feature.json.branch and appends a `git` history entry (executor cli).

import { UsageError, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { readFeatureJson, updateFeatureJson } from './feature-json.mjs';
import { appendHistory } from './history.mjs';
import {
  GIT_COMMON_OPTIONS, GitFailure, execOpts, ghAuthPreflight, ghRun, gitOk, gitRun, outputTail,
} from './git-exec.mjs';

const USAGE = 'git branch [<name>] [--base <ref>] [--gh-credential]';
const PREFIX = { feature: 'feat', bugfix: 'fix', hotfix: 'hotfix' };

async function hasRef(ref, opts) {
  const r = await gitRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], opts);
  return r.code === 0;
}

/** Default branch name: origin/HEAD's target, else `main`. */
export async function defaultBranch(opts) {
  const r = await gitRun(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], opts);
  const ref = r.code === 0 ? r.stdout.trim() : '';
  return ref.startsWith('origin/') && ref.length > 'origin/'.length ? ref.slice('origin/'.length) : 'main';
}

/** Current branch name; UsageError on detached HEAD or the default branch. */
export async function currentBranch(verb, opts, { allowDefault = false } = {}) {
  const r = await gitRun(['symbolic-ref', '--quiet', '--short', 'HEAD'], opts);
  const name = r.code === 0 ? r.stdout.trim() : '';
  if (!name) throw new UsageError(`git ${verb}: HEAD is detached; check out the feature branch first`);
  if (!allowDefault) {
    const def = await defaultBranch(opts);
    if (name === def) throw new UsageError(`git ${verb}: on the default branch '${def}'; check out the feature branch first`);
  }
  return name;
}

async function hasOrigin(opts) {
  const r = await gitRun(['remote'], opts);
  return r.code === 0 && r.stdout.split('\n').map((s) => s.trim()).includes('origin');
}

/** Commits on local <branch> not on its upstream (or origin/<branch>). 0 when either is missing. */
async function aheadCount(branch, opts) {
  if (!(await hasRef(`refs/heads/${branch}`, opts))) return 0;
  const up = await gitRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], opts);
  let upstream = up.code === 0 ? up.stdout.trim() : '';
  if (!upstream && (await hasRef(`refs/remotes/origin/${branch}`, opts))) upstream = `origin/${branch}`;
  if (!upstream) return 0;
  const n = await gitOk(['rev-list', '--count', `${upstream}..refs/heads/${branch}`], opts);
  return Number(n) || 0;
}

async function latestReleaseTag(opts) {
  await ghAuthPreflight(opts);
  const r = await ghRun(['release', 'view', '--json', 'tagName'], opts);
  let tag = '';
  if (r.code === 0) {
    try { tag = JSON.parse(r.stdout).tagName ?? ''; } catch { tag = ''; }
  }
  if (typeof tag !== 'string' || tag === '') {
    throw new UsageError(`git branch: no release tag found via gh release view (${outputTail(r.stderr, 3) || 'empty'}); pass --base <ref>`);
  }
  return tag;
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 */
export async function branch(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: USAGE,
    positionals: ['name?'],
    options: { base: { type: 'string' }, ...GIT_COMMON_OPTIONS },
  });
  if (values.base === '') throw new UsageError(`--base must not be empty (usage: dev-cycle ${USAGE})`);
  const featureDir = resolveFeatureDir(ctx, values);
  const fj = readFeatureJson(featureDir);
  const flow = fj.flow ?? 'feature';
  const prefix = PREFIX[flow];
  if (!prefix) throw new UsageError(`git branch: unknown flow '${flow}' in feature.json`);

  let name = args.name;
  if (!name) {
    if (typeof fj.feature_slug !== 'string' || fj.feature_slug === '') {
      throw new UsageError('git branch: feature.json has no feature_slug; pass <name>');
    }
    name = `${prefix}/${fj.feature_slug}`;
  }
  const opts = execOpts(ctx, values);

  const valid = await gitRun(['check-ref-format', '--branch', name], opts);
  if (valid.code !== 0 || name.startsWith('-')) throw new UsageError(`git branch: invalid branch name '${name}'`);
  if (await hasRef(`refs/heads/${name}`, opts)) throw new UsageError(`git branch: branch '${name}' already exists`);

  // Refresh remote-tracking refs so the main-ahead check and the base are current.
  if (await hasOrigin(opts)) {
    const f = await gitRun(['fetch', '--quiet', 'origin'], opts);
    if (f.code !== 0) ctx.stderr.write(`warning: git fetch origin failed: ${outputTail(f.stderr, 3)}\n`);
  }

  const def = await defaultBranch(opts);
  const ahead = await aheadCount(def, opts);
  if (ahead > 0) {
    throw new GitFailure('main-ahead', `local ${def} has ${ahead} commit(s) not on its upstream; push or reconcile them first`);
  }

  let base = values.base;
  if (!base && flow === 'hotfix') base = await latestReleaseTag(opts);
  if (!base) base = (await hasRef(`refs/remotes/origin/${def}`, opts)) ? `origin/${def}` : def;
  if (!(await hasRef(base, opts))) throw new UsageError(`git branch: base '${base}' does not resolve to a commit`);

  const co = await gitRun(['checkout', '--no-track', '-b', name, base], opts);
  if (co.code !== 0) {
    throw new GitFailure('conflict', `git checkout -b ${name} ${base}: ${outputTail(co.stderr || co.stdout, 10)}`);
  }

  updateFeatureJson(featureDir, (j) => { j.branch = name; });
  appendHistory(featureDir, {
    phase: 'git', subagent: 'cli', executor: 'cli', status: 'DONE', summary: `branch ${name}`,
  });
  return { text: `branch ${name} (from ${base})`, data: { branch: name, base } };
}
