// dev-cycle git commit [--subject <s>] [--body <b>] [--scope <s>]
//                      [--trailer "Key: value"]... [--closes <n,m>] [--gh-credential]
//                                                                   (spec R16, R17)
//
// 1. Build + validate the message first (usage errors exit 2, nothing touched).
//    Refuses the default branch / a detached HEAD (exit 2), like push/pr/merge.
// 2. `git add -A`; a staged secret-like path → unstage everything, FAILED
//    `secret-like-file`. Nothing staged → FAILED `nothing-to-commit`.
// 3. Flow `feature`: snapshot spec.md, the tasks file and feature.json bytes,
//    then flip IMPL-DONE → DONE (non-owner tasks), spec (and plan) frontmatter
//    → DONE, append the `git` "feature commit" history entry, and re-stage.
// 4. `git commit -F <tmpfile>` (never through a shell). On any failure every
//    snapshot is restored byte-for-byte and re-staged (the flips are unstaged):
//    hook failure → `hook-failed` with the output tail.
// 5. On success print the new HEAD SHA.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot } from './core.mjs';
import { featureJsonPath, readFeatureJson } from './feature-json.mjs';
import { appendHistory } from './history.mjs';
import { buildCommitMessage, buildPolishMessages } from './git-message.mjs';
import { globsOverlap } from './glob-overlap.mjs';
import { isDeferred, parseItems, readPolish } from './polish.mjs';
import { currentBranch } from './git-branch.mjs';
import { GIT_COMMON_OPTIONS, GitFailure, GitPlumbingError, execOpts, gitOk, gitRun, outputTail } from './git-exec.mjs';
import { isOwnerTask, parsePlan, setFrontmatterStatus, setTaskStatus, tasksSource } from './plan.mjs';

/**
 * `git commit` runs pre-commit hooks (lint, tests…): allow the step default.
 * DEV_CYCLE_GIT_COMMIT_TIMEOUT_S (positive integer seconds) overrides it.
 */
export const COMMIT_TIMEOUT_S = 600;

export function commitTimeout(env) {
  const raw = env?.DEV_CYCLE_GIT_COMMIT_TIMEOUT_S;
  if (raw === undefined || raw === '') return COMMIT_TIMEOUT_S;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new UsageError(`DEV_CYCLE_GIT_COMMIT_TIMEOUT_S must be a positive integer (got '${raw}')`);
  }
  return Number(raw);
}

const USAGE = 'git commit [--subject <s>] [--body <b>] [--scope <s>] [--trailer "Key: value"]... [--closes <n,m>] [--gh-credential]';

/**
 * True when a repo path's basename looks like a secret (R16.1, security S5).
 * Case-insensitive: `.env`, `.env.*` (not `.env.example`), `.envrc`, `*.pem`,
 * `*.key`, `*.p8`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`,
 * `*.mobileprovision`, `id_rsa*` / `id_ed25519*` / `id_ecdsa*` / `id_dsa*`,
 * `.npmrc`, `.netrc`, `credentials*.json`, `service-account*.json`.
 * @param {string} p
 */
export function isSecretLike(p) {
  const base = path.posix.basename(String(p).replace(/\\/g, '/')).toLowerCase();
  if (base === '.env' || base === '.envrc' || base === '.npmrc' || base === '.netrc') return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  if (/\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision)$/.test(base)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(base)) return true;
  if (/^(credentials|service-account).*\.json$/.test(base)) return true;
  return false;
}

/** Staged paths (NUL-separated output), optionally filtered by --diff-filter. */
async function stagedPaths(opts, filter) {
  const args = ['diff', '--cached', '--name-only', '-z', '--no-renames'];
  if (filter) args.push(`--diff-filter=${filter}`);
  const r = await gitRun(args, opts);
  if (r.code !== 0) throw new GitPlumbingError(`git plumbing failed — git diff --cached: ${outputTail(r.stderr || r.stdout, 10) || `exit ${r.code}`}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** Unstage everything (mixed reset; on an unborn branch, drop the index entries). */
async function unstageAll(opts) {
  const head = await gitRun(['rev-parse', '--verify', '--quiet', 'HEAD'], opts);
  if (head.code === 0) await gitOk(['reset', '-q'], opts);
  else await gitOk(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.'], opts);
}

/** Read a file's bytes, or null when it does not exist. */
function snapshot(file) {
  try { return fs.readFileSync(file); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
}

function restore(snaps) {
  for (const [file, bytes] of snaps) {
    if (bytes === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, bytes);
  }
}

/**
 * Apply the R17 flips in the feature folder. Returns the files that changed.
 * @param {string} featureDir
 */
function applyFlips(featureDir, { polish = false } = {}) {
  const changed = new Set();
  // Polish: polish.md items (owner and deferred ones stay) and its frontmatter.
  const src = polish ? readPolish(featureDir) : tasksSource(featureDir);
  if (src) {
    const before = src.text;
    let text = before;
    const flippable = polish
      ? parseItems(before).filter((x) => x.status === 'IMPL-DONE' && !isOwnerTask(x) && !isDeferred(x))
      : parsePlan(before).filter((x) => x.status === 'IMPL-DONE' && !isOwnerTask(x));
    for (const t of flippable) {
      text = setTaskStatus(text, t.n, 'DONE', { source: path.basename(src.file) });
    }
    if (text !== before) { fs.writeFileSync(src.file, text); changed.add(src.file); }
  }
  // `spec status DONE`: spec.md frontmatter, plus plan.md frontmatter when present.
  for (const name of polish ? ['polish.md'] : ['spec.md', 'plan.md']) {
    const file = path.join(featureDir, name);
    const text = readText(file, { optional: true });
    if (text === null) continue;
    const next = setFrontmatterStatus(text, 'DONE');
    if (next !== null && next !== text) { fs.writeFileSync(file, next); changed.add(file); }
  }
  appendHistory(featureDir, {
    phase: 'git', subagent: 'cli', executor: 'cli', status: 'DONE', summary: 'feature commit',
  });
  changed.add(featureJsonPath(featureDir));
  return [...changed];
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 */
export async function commit(argv, ctx, internal = {}) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      subject: { type: 'string' },
      body: { type: 'string' },
      scope: { type: 'string' },
      trailer: { type: 'string', multiple: true },
      closes: { type: 'string' },
      ...GIT_COMMON_OPTIONS,
    },
  });
  const featureDir = resolveFeatureDir(ctx, values);
  const fj = readFeatureJson(featureDir);
  const flow = fj.flow ?? 'feature';
  if (flow === 'feature' && fj.track === 'polish') {
    return commitPolish({ values, ctx, featureDir, fj, releasePaths: internal?.releasePaths ?? [] });
  }
  const specFile = path.join(featureDir, 'spec.md');
  const specText = readText(specFile, { optional: true }) ?? '';
  const src = tasksSource(featureDir);
  const tasks = src ? parsePlan(src.text) : [];

  // Validates trailers, --closes and the --subject requirement (UsageError → exit 2).
  const message = buildCommitMessage({
    fj, specText, tasks, folder: path.basename(featureDir),
    scope: values.scope, subject: values.subject, body: values.body,
    closes: values.closes, trailers: values.trailer ?? [],
  });

  const opts = execOpts(ctx, values);
  const commitTimeoutS = commitTimeout(ctx.env);
  // Same guard as push/pr/merge: never land the feature commit on the
  // default branch or a detached HEAD (exit 2).
  await currentBranch('commit', opts);
  await gitOk(['add', '-A'], opts);
  // `docs/features/` may be git-ignored (a repo that keeps its feature folders local):
  // the status flips still happen on disk but are never staged.
  const ignored = (await gitRun(['check-ignore', '-q', '--', featureDir], opts)).code === 0;
  if (ignored) ctx.stderr.write('git commit: feature folder is git-ignored; not staged\n');

  const secrets = (await stagedPaths(opts, 'd')).filter(isSecretLike);
  if (secrets.length) {
    await unstageAll(opts);
    throw new GitFailure('secret-like-file', `refusing to commit secret-like file(s): ${secrets.join(', ')}; unstaged everything`);
  }
  if ((await stagedPaths(opts)).length === 0) {
    throw new GitFailure('nothing-to-commit', 'no changes to commit');
  }

  /** @type {Array<[string, Buffer|null]>} */
  const snaps = [];
  if (flow === 'feature') {
    const files = new Set([specFile, featureJsonPath(featureDir), path.join(featureDir, 'plan.md')]);
    if (src) files.add(src.file);
    for (const f of files) snaps.push([f, snapshot(f)]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-commit-'));
  let committed = false;
  try {
    if (flow === 'feature') {
      const changed = applyFlips(featureDir);
      if (!ignored) await gitOk(['add', '--', ...changed], opts);
    }
    const msgFile = path.join(tmpDir, 'COMMIT_MSG');
    fs.writeFileSync(msgFile, message);
    const r = await gitRun(['commit', '-q', '--cleanup=whitespace', '-F', msgFile], { ...opts, timeout_s: commitTimeoutS });
    if (r.code !== 0) {
      const out = `${r.stdout}\n${r.stderr}`;
      if (/nothing (added )?to commit|no changes added to commit/i.test(out)) {
        throw new GitFailure('nothing-to-commit', outputTail(out, 5) || 'no changes to commit');
      }
      throw new GitFailure('hook-failed', outputTail(out, 20) || `git commit exited ${r.code}`);
    }
    committed = true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!committed && snaps.length) {
      restore(snaps);
      const present = ignored ? [] : snaps.filter(([, b]) => b !== null).map(([f]) => f);
      // Re-stage the restored bytes so the index no longer carries the flips.
      if (present.length) await gitRun(['add', '--', ...present], opts);
    }
  }

  const sha = await gitOk(['rev-parse', 'HEAD'], opts);
  const subject = message.split('\n')[0];
  return { text: `commit ${sha} ${subject}`, data: { sha, subject } };
}

// --- polish track: one commit per item (R8) -----------------------------------

/** Parse `git status --porcelain=v1 -z --no-renames` into { path, deleted }. */
function parseStatus(out) {
  const res = [];
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    res.push({ path: entry.slice(3), xy, deleted: xy.includes('D') });
  }
  return res;
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * The polish change set (R8 steps 1-4), read-only. Used by `commit()` and by
 * ship's skip check. Paths are relative to the repo root.
 * @param {string} featureDir
 * @param {object} opts  gitRun opts (cwd, env)
 * @param {{releasePaths?: string[]}} [extra]  paths ship's release step wrote (go to the batch commit)
 */
export async function polishChangeSet(featureDir, opts, { releasePaths = [] } = {}) {
  const fj = readFeatureJson(featureDir);
  const polish = readPolish(featureDir);
  const items = polish?.items ?? [];
  // One path root: the dev-cycle project root (where touches and untracked_baseline are
  // recorded). git status paths are repo-top-relative, so convert them; ls-files runs here.
  const root = fs.realpathSync(resolveProjectRoot({ cwd: opts.cwd ?? process.cwd() }));
  const gitTop = fs.realpathSync(await gitOk(['rev-parse', '--show-toplevel'], { ...opts, cwd: root }));
  const top = root;
  const o = { ...opts, cwd: root };
  const fromTop = (p) => toPosix(path.relative(root, path.join(gitTop, p)));
  const rel = toPosix(path.relative(root, fs.realpathSync(featureDir)));
  const inFolder = (p) => rel !== '' && !rel.startsWith('..') && (p === rel || p.startsWith(`${rel}/`));
  const ignored = (await gitRun(['check-ignore', '-q', '--', featureDir], o)).code === 0;

  const st = await gitRun(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no'], o);
  if (st.code !== 0) throw new GitPlumbingError(`git plumbing failed — git status: ${outputTail(st.stderr || st.stdout, 10) || `exit ${st.code}`}`);
  const ut = await gitRun(['ls-files', '--others', '--exclude-standard', '-z'], o);
  if (ut.code !== 0) throw new GitPlumbingError(`git plumbing failed — git ls-files: ${outputTail(ut.stderr || ut.stdout, 10) || `exit ${ut.code}`}`);
  const baseline = new Set(Array.isArray(fj.untracked_baseline) ? fj.untracked_baseline : []);
  const deleted = new Set();
  const all = new Set();
  const skippedBaseline = [];
  for (const e of parseStatus(st.stdout)) {
    // Staged-then-deleted (AD): gone from the index and the worktree once unstaged.
    if (e.xy === 'AD') continue;
    const p = fromTop(e.path);
    all.add(p);
    if (e.deleted) deleted.add(p);
  }
  for (const p of ut.stdout.split('\0').filter(Boolean)) {
    if (baseline.has(p)) skippedBaseline.push(p); else all.add(p);
  }

  const release = new Set();
  for (const r of releasePaths) {
    let abs = path.isAbsolute(r) ? r : path.join(root, r);
    try { abs = fs.realpathSync(abs); } catch { /* not on disk */ }
    const p = toPosix(path.relative(root, abs));
    if (all.has(p)) release.add(p);
  }
  const bookkeeping = [];
  const changed = [];
  for (const p of all) {
    if (inFolder(p)) { if (!ignored) bookkeeping.push(p); } else if (!release.has(p)) changed.push(p);
  }

  // Assignment + grouping (union-find over items sharing a path).
  const active = items.filter((i) => !isDeferred(i));
  const assigned = new Map(active.map((i) => [i.n, changed.filter((p) => (i.touches ?? []).some((t) => globsOverlap(p, t)))]));
  const parent = new Map(active.map((i) => [i.n, i.n]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const owner = new Map();
  for (const i of active) {
    for (const p of assigned.get(i.n)) {
      if (owner.has(p)) parent.set(find(i.n), find(owner.get(p)));
      else owner.set(p, i.n);
    }
  }
  const byRoot = new Map();
  const noPath = [];
  for (const i of active) {
    if (assigned.get(i.n).length === 0) { noPath.push(i); continue; }
    const r = find(i.n);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  }
  const groups = [...byRoot.values()].map((its) => {
    its.sort((a, b) => a.n - b.n);
    const count = new Map();
    for (const i of its) for (const p of assigned.get(i.n)) count.set(p, (count.get(p) ?? 0) + 1);
    const paths = [...count.keys()];
    return { items: its, paths, shared: paths.filter((p) => count.get(p) > 1) };
  }).sort((a, b) => a.items[0].n - b.items[0].n);
  const skips = [];
  for (const i of active) {
    for (const p of skippedBaseline) if ((i.touches ?? []).some((t) => globsOverlap(p, t))) skips.push({ id: i.id, path: p });
  }
  const taken = new Set(groups.flatMap((g) => g.paths));
  const leftovers = changed.filter((p) => !taken.has(p));

  return {
    fj, polish, items, ignored, top, rel, deleted, groups, noPath, leftovers, skips,
    release: [...release], bookkeeping,
    empty: groups.length === 0 && leftovers.length === 0 && release.size === 0 && bookkeeping.length === 0,
  };
}

async function commitPolish({ values, ctx, featureDir, fj, releasePaths }) {
  const opts = execOpts(ctx, values);
  const commitTimeoutS = commitTimeout(ctx.env);
  await currentBranch('commit', opts);
  const cs = await polishChangeSet(featureDir, opts, { releasePaths });
  if (!cs.polish) throw new UsageError(`file not found: ${path.join(featureDir, 'polish.md')}`);
  const o = { ...opts, cwd: cs.top };
  // Paths like app/[id]/page.tsx are literal names, not pathspec globs/magic.
  const literal = { ...o, env: { ...(opts.env ?? process.env), GIT_LITERAL_PATHSPECS: '1' } };

  const batchPaths = [...cs.leftovers, ...cs.release, ...cs.bookkeeping];
  // The flips always dirty feature.json, so a non-ignored folder always gets a batch commit.
  const hasBatch = batchPaths.length > 0 || !cs.ignored;
  const messages = buildPolishMessages({
    fj, items: cs.items, groups: cs.groups,
    batch: hasBatch ? { leftovers: [...cs.leftovers, ...cs.release] } : null,
    folder: path.basename(featureDir), scope: values.scope, subject: values.subject, body: values.body,
    closes: values.closes, trailers: values.trailer ?? [],
  });

  if (cs.ignored) ctx.stderr.write('git commit: feature folder is git-ignored; not staged\n');
  for (const k of cs.skips) ctx.stderr.write(`git commit: ${k.id} skips baseline untracked ${k.path}\n`);
  for (const i of cs.noPath) ctx.stderr.write(`git commit: ${i.id} has no changed paths\n`);
  if (cs.leftovers.length) ctx.stderr.write(`git commit: unassigned → batch commit: ${cs.leftovers.join(', ')}\n`);

  const toStage = [...cs.groups.flatMap((g) => g.paths), ...batchPaths].filter((p) => !cs.deleted.has(p));
  const secrets = toStage.filter(isSecretLike);
  if (secrets.length) {
    throw new GitFailure('secret-like-file', `refusing to commit secret-like file(s): ${secrets.join(', ')}; nothing staged`);
  }
  if (cs.groups.length === 0 && batchPaths.length === 0) {
    throw new GitFailure('nothing-to-commit', 'no changes to commit');
  }

  // Anything already staged would leak into the first commit: start from an empty index.
  if ((await stagedPaths(o)).length) {
    ctx.stderr.write('git commit: unstaging previously staged paths; polish stages explicit paths only\n');
    await unstageAll(o);
  }

  const start = await gitOk(['rev-parse', 'HEAD'], o);
  const folderAbs = featureDir;
  const snaps = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-commit-'));
  const created = [];
  let current = '';
  try {
    for (let k = 0; k < messages.length; k++) {
      const m = messages[k];
      current = m.kind === 'batch' ? 'batch' : m.items.join('+');
      let paths;
      if (m.kind === 'item') {
        paths = cs.groups[k].paths;
      } else {
        for (const f of [path.join(folderAbs, 'polish.md'), featureJsonPath(featureDir)]) snaps.push([f, snapshot(f)]);
        const flipped = applyFlips(featureDir, { polish: true })
          .map((f) => toPosix(path.relative(cs.top, fs.realpathSync(f)))).filter(() => !cs.ignored);
        paths = [...new Set([...cs.leftovers, ...cs.release, ...cs.bookkeeping, ...flipped])];
      }
      const add = await gitRun(['add', '-A', '--', ...paths], literal);
      if (add.code !== 0) throw new GitFailure('hook-failed', `${current}: git add: ${outputTail(add.stderr || add.stdout, 10) || `exit ${add.code}`}`);
      const msgFile = path.join(tmpDir, `COMMIT_MSG_${k}`);
      fs.writeFileSync(msgFile, m.message);
      const r = await gitRun(['commit', '-q', '--cleanup=whitespace', '-F', msgFile], { ...o, timeout_s: commitTimeoutS });
      if (r.code !== 0) {
        const out = `${r.stdout}\n${r.stderr}`;
        if (/nothing (added )?to commit|no changes added to commit/i.test(out)) {
          throw new GitFailure('nothing-to-commit', `${current}: ${outputTail(out, 5) || 'no changes to commit'}`);
        }
        throw new GitFailure('hook-failed', `${current}: ${outputTail(out, 20) || `git commit exited ${r.code}`}`);
      }
      created.push({ sha: await gitOk(['rev-parse', 'HEAD'], o), subject: m.subject, items: m.items });
    }
    // Ignored feature folder and no batch commit: the flips still land on disk.
    if (!messages.some((m) => m.kind === 'batch')) {
      for (const f of [path.join(folderAbs, 'polish.md'), featureJsonPath(featureDir)]) snaps.push([f, snapshot(f)]);
      applyFlips(featureDir, { polish: true });
    }
  } catch (err) {
    // All-or-nothing: mixed reset to this run's start SHA keeps the working tree.
    await gitRun(['reset', '-q', start], o).catch(() => {});
    restore(snaps);
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const sha = await gitOk(['rev-parse', 'HEAD'], o);
  const last = created.at(-1);
  return {
    text: created.map((c) => `commit ${c.sha} ${c.subject}`).join('\n'),
    data: { sha, subject: last.subject, commits: created },
  };
}
