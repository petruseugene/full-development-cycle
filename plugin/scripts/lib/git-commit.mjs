// dev-cycle git commit [--subject <s>] [--body <b>] [--scope <s>]
//                      [--trailer "Key: value"]... [--closes <n,m>] [--include-untracked] [--gh-credential]
//                                                                   (spec R16, R17)
//
// 1. Build + validate the message first (usage errors exit 2, nothing touched).
//    Refuses the default branch / a detached HEAD (exit 2), like push/pr/merge.
// 2. Stage per `planStaging` (tracked changes always; untracked files outside the
//    feature's Touches are left out; `git.never_stage` globs never; see
//    --include-untracked); a staged secret-like path → unstage everything, FAILED
//    `secret-like-file`. Nothing staged → FAILED `nothing-to-commit`.
// 3. Flow `feature`: snapshot spec.md, the tasks file and feature.json bytes,
//    then flip IMPL-DONE → DONE (non-owner tasks), spec (and plan) frontmatter
//    → DONE, append the `git` "feature commit" history entry, and re-stage.
// 4. `git commit -F <tmpfile>` (never through a shell). On any failure the never_stage paths
//    unstaged in step 2 get their original index entries back, and every
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
import { loadProfile } from './profile.mjs';
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

const USAGE = 'git commit [--subject <s>] [--body <b>] [--scope <s>] [--trailer "Key: value"]... [--closes <n,m>] [--include-untracked] [--gh-credential]';

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

// --- staging plan: Touches scope, git.never_stage, untracked guard ----------------

export const UNTRACKED_MAX_FILES = 20;
export const UNTRACKED_MAX_BYTES = 10 * 1024 * 1024;
const STAGE_CHUNK = 200;

/** Index of the `]` closing the bracket class opened at `i`, or -1 (a leading `]` is a literal member). */
function classEnd(glob, i) {
  let k = i + 1;
  if (glob[k] === '!' || glob[k] === '^') k++;
  if (glob[k] === ']') k++;
  return glob.indexOf(']', k);
}

/**
 * Compile a glob to a RegExp where `*`, `?` and `**` also match segments that start
 * with `.` (path.matchesGlob never does). The path is matched as-is, never rewritten.
 * Supports `**`, `*`, `?`, `[...]` and `{a,b}`.
 */
function compileGlob(rawGlob) {
  // Runs of `**/` are equivalent to one; collapsing them bounds regex backtracking.
  const glob = rawGlob.replace(/(?:(?<=^|\/)\*\*\/)+/g, '**/');
  // Only balanced braces are alternations; an unbalanced `{`, `}` or `,` is literal.
  const opens = new Set();
  const closes = new Set();
  const stack = [];
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '\\') { i++; continue; }
    if (glob[i] === '[') { const j = classEnd(glob, i); if (j > 0) i = j; continue; }
    if (glob[i] === '{') stack.push(i);
    else if (glob[i] === '}' && stack.length) { opens.add(stack.pop()); closes.add(i); }
  }
  const esc = (ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const segStart = i === 0 || glob[i - 1] === '/';
        let j = i;
        while (glob[j + 1] === '*') j++;
        if (segStart && glob[j + 1] === '/') { re += '(?:[^/]+/)*'; i = j + 1; } else if (segStart && j + 1 === glob.length) { re += '.*'; i = j; } else { re += '[^/]*'; i = j; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const neg = glob[i + 1] === '!' || glob[i + 1] === '^';
      const j = classEnd(glob, i);
      if (j < 0) re += '\\[';
      else {
        let body = glob.slice(i + 1 + (neg ? 1 : 0), j);
        if (body[0] === ']') body = `\\]${body.slice(1)}`;
        body = body.replace(/\\(?!\])/g, '\\\\');
        re += `(?!/)[${neg ? '^' : ''}${body}]`; i = j;
      }
    } else if (c === '{' && opens.has(i)) { depth++; re += '(?:'; } else if (c === '}' && closes.has(i)) { depth--; re += ')'; } else if (c === ',' && depth > 0) re += '|';
    else if (c === '\\' && i + 1 < glob.length) re += esc(glob[++i]);
    else re += esc(c);
  }
  return new RegExp(`^${re}$`);
}

/** True when `p` matches a project-root-relative glob (`dir/` means everything under it), dot-files included. */
export function globMatch(p, glob) {
  const g = glob.endsWith('/') ? `${glob}**` : glob;
  try { return compileGlob(g).test(p); } catch { return false; }
}

/** True when `p` falls under (or equals) a Touches glob, dot-files included. */
const inTouches = (p, touches) => touches.some((t) => globsOverlap(p, t) || globMatch(p, t));

const humanSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Group root-relative paths by top-level dir: lines `dir/ (N files, size)`, at most `max` groups. */
function groupLines(paths, sizes, max = 10) {
  const groups = new Map();
  for (const p of paths) {
    const i = p.indexOf('/');
    const key = i < 0 ? '.' : `${p.slice(0, i)}/`;
    const g = groups.get(key) ?? { n: 0, bytes: 0 };
    g.n++; g.bytes += sizes.get(p) ?? 0;
    groups.set(key, g);
  }
  const lines = [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, max)
    .map(([k, g]) => `  ${k} (${g.n} file${g.n === 1 ? '' : 's'}, ${humanSize(g.bytes)})`);
  if (groups.size > max) lines.push(`  … and ${groups.size - max} more dir(s)`);
  return lines;
}

/** Touches globs of the feature: task `**Touches:**` lines (plan/spec) plus `areas[].touches`. */
function featureTouches(featureDir, fj) {
  const src = tasksSource(featureDir);
  const out = new Set((src ? parsePlan(src.text) : []).flatMap((t) => t.touches ?? []));
  for (const a of Array.isArray(fj.areas) ? fj.areas : []) for (const t of a?.touches ?? []) out.add(t);
  return [...out].filter((t) => typeof t === 'string' && t !== '');
}

/**
 * What `git commit` / `ship` would stage, read-only. Paths are project-root-relative
 * (the root may be a subdir of the git top-level; `../x` marks a path outside it).
 *  - tracked changes: staged unless `git.never_stage` matches;
 *  - untracked: always staged under the feature folder / `.dev-cycle/`; elsewhere left out
 *    when the feature has Touches and the path is outside them (unless includeUntracked);
 *    never when `git.never_stage` matches.
 * @param {string} featureDir
 * @param {object} opts  gitRun opts
 * @param {{includeUntracked?: boolean}} [o]
 */
export async function planStaging(featureDir, opts, { includeUntracked = false } = {}) {
  const fj = readFeatureJson(featureDir);
  const root = fs.realpathSync(resolveProjectRoot({ cwd: opts.cwd ?? process.cwd() }));
  const gitTop = fs.realpathSync(await gitOk(['rev-parse', '--show-toplevel'], { ...opts, cwd: root }));
  const never = loadProfile({ cwd: root, env: opts.env ?? process.env, stderr: { write() {} } }, { quiet: true }).profile?.git?.never_stage ?? [];
  const touches = featureTouches(featureDir, fj);
  const rel = toPosix(path.relative(root, fs.realpathSync(featureDir)));
  const inFolder = (p) => (rel !== '' && !rel.startsWith('..') && (p === rel || p.startsWith(`${rel}/`)))
    || p === '.dev-cycle' || p.startsWith('.dev-cycle/');

  const st = await gitRun(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { ...opts, cwd: root });
  if (st.code !== 0) throw new GitPlumbingError(`git plumbing failed — git status: ${outputTail(st.stderr || st.stdout, 10) || `exit ${st.code}`}`);
  const stage = [];
  const changed = []; // every tracked change, including already-staged ones
  const untracked = [];
  const leftOut = [];
  let blocked = 0;
  const unstage = []; // already-staged paths matching git.never_stage
  const sizes = new Map();
  for (const e of parseStatus(st.stdout)) {
    if (e.xy === 'AD') continue; // staged-then-deleted: nothing left to stage
    const p = toPosix(path.relative(root, path.join(gitTop, e.path)));
    if (never.some((g) => globMatch(p, g))) {
      blocked++;
      if (e.xy !== '??' && e.xy[0] !== ' ') unstage.push(p);
      continue;
    }
    if (e.xy !== '??') {
      changed.push(p);
      // Worktree side clean (`git rm`, `git mv` results): already staged, `git add` would fail on it.
      if (e.xy[1] !== ' ') stage.push(p);
      continue;
    }
    if (inFolder(p)) { changed.push(p); stage.push(p); continue; }
    if (touches.length && !includeUntracked && !inTouches(p, touches)) {
      leftOut.push(p);
      try { sizes.set(p, fs.lstatSync(path.join(gitTop, e.path)).size); } catch { /* size is informational */ }
      continue;
    }
    untracked.push(p);
    try { sizes.set(p, fs.lstatSync(path.join(gitTop, e.path)).size); } catch { sizes.set(p, 0); }
  }
  stage.push(...untracked);
  changed.push(...untracked);
  const bytes = untracked.reduce((a, p) => a + (sizes.get(p) ?? 0), 0);
  const large = touches.length === 0 && !includeUntracked
    && (untracked.length > UNTRACKED_MAX_FILES || bytes > UNTRACKED_MAX_BYTES);
  return { root, stage, changed, untracked, leftOut, blocked, unstage, sizes, bytes, large, touches: touches.length > 0 };
}

/** Stage explicit root-relative paths (literal pathspecs, chunked). */
async function stagePaths(paths, opts, root) {
  const o = { ...opts, cwd: root, env: { ...(opts.env ?? process.env), GIT_LITERAL_PATHSPECS: '1' } };
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    const r = await gitRun(['add', '-A', '--', ...paths.slice(i, i + STAGE_CHUNK)], o);
    if (r.code !== 0) throw new GitPlumbingError(`git plumbing failed — git add: ${outputTail(r.stderr || r.stdout, 10) || `exit ${r.code}`}`);
  }
}

/** Notes for what a plan left out; written to ctx.stderr. */
function stagingNotes(plan, ctx) {
  if (plan.blocked) ctx.stderr.write(`git commit: ${plan.blocked} path(s) matching git.never_stage were not staged\n`);
  if (plan.leftOut.length) {
    ctx.stderr.write(`git commit: ${plan.leftOut.length} untracked files outside Touches were left out (use --include-untracked to add)\n`);
    const shown = plan.leftOut.slice(0, 10);
    for (const l of groupLines(plan.leftOut, plan.sizes)) ctx.stderr.write(`${l}\n`);
    ctx.stderr.write(`  e.g. ${shown.join(', ')}${plan.leftOut.length > shown.length ? ', …' : ''}\n`);
  }
}

/**
 * Unstage explicit root-relative paths, leaving the working tree untouched:
 * `git reset -q -- <paths>`, or `git rm --cached` when HEAD does not exist yet.
 */
async function unstagePaths(paths, opts, root) {
  const o = { ...opts, cwd: root, env: { ...(opts.env ?? process.env), GIT_LITERAL_PATHSPECS: '1' } };
  const head = await gitRun(['rev-parse', '--verify', '--quiet', 'HEAD'], o);
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    const chunk = paths.slice(i, i + STAGE_CHUNK);
    const r = head.code === 0
      ? await gitRun(['reset', '-q', '--', ...chunk], o)
      : await gitRun(['rm', '-q', '--cached', '-f', '--ignore-unmatch', '--', ...chunk], o);
    if (r.code !== 0) throw new GitPlumbingError(`git plumbing failed — git ${head.code === 0 ? 'reset' : 'rm --cached'}: ${outputTail(r.stderr || r.stdout, 10) || `exit ${r.code}`}`);
  }
}

/** Index entries (stage 0) of `paths`: Map path → "mode,sha"; used to restore staging on failure. */
async function indexEntries(paths, opts, root) {
  const o = { ...opts, cwd: root, env: { ...(opts.env ?? process.env), GIT_LITERAL_PATHSPECS: '1' } };
  const entries = new Map();
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    const r = await gitRun(['ls-files', '-s', '-z', '--', ...paths.slice(i, i + STAGE_CHUNK)], o);
    if (r.code !== 0) throw new GitPlumbingError(`git plumbing failed — git ls-files: ${outputTail(r.stderr || r.stdout, 10) || `exit ${r.code}`}`);
    for (const rec of r.stdout.split('\0').filter(Boolean)) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec);
      if (m && m[3] === '0') entries.set(m[4], `${m[1]},${m[2]}`);
    }
  }
  return entries;
}

/** Put the captured index entries back (paths absent from `entries` were staged deletions). Best effort. */
async function restoreIndex(paths, entries, opts, root) {
  const o = { ...opts, cwd: root, env: { ...(opts.env ?? process.env), GIT_LITERAL_PATHSPECS: '1' } };
  for (const p of paths) {
    const e = entries.get(p);
    if (e) await gitRun(['update-index', '--add', '--cacheinfo', `${e},${p}`], o);
    else await gitRun(['rm', '-q', '--cached', '-f', '--ignore-unmatch', '--', p], o);
  }
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
  const undo = { restore: null };
  try {
    return await commitInner(argv, ctx, internal, undo);
  } catch (err) {
    // The commit failed after never_stage paths were unstaged: put the user's staging back.
    if (undo.restore) await undo.restore().catch(() => {});
    throw err;
  }
}

async function commitInner(argv, ctx, internal, undo) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      subject: { type: 'string' },
      body: { type: 'string' },
      scope: { type: 'string' },
      trailer: { type: 'string', multiple: true },
      closes: { type: 'string' },
      'include-untracked': { type: 'boolean' },
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
  const plan = await planStaging(featureDir, opts, { includeUntracked: Boolean(values['include-untracked']) });
  stagingNotes(plan, ctx);
  if (plan.large) {
    throw new GitFailure('untracked-large', `${plan.untracked.length} new untracked files, ${humanSize(plan.bytes)} (limit ${UNTRACKED_MAX_FILES} files / ${humanSize(UNTRACKED_MAX_BYTES)}); nothing staged. Untracked additions:\n${groupLines(plan.untracked, plan.sizes).join('\n')}\nMove them out, add them to git.never_stage, or pass --include-untracked`);
  }
  if (plan.unstage.length) {
    const entries = await indexEntries(plan.unstage, opts, plan.root);
    // Armed first: a failure on a later chunk must still restore the earlier ones (restore is idempotent).
    undo.restore = () => restoreIndex(plan.unstage, entries, opts, plan.root);
    await unstagePaths(plan.unstage, opts, plan.root);
    ctx.stderr.write(`git commit: ${plan.unstage.length} staged files matching git.never_stage were unstaged\n`);
  }
  await stagePaths(plan.stage, opts, plan.root);
  // `docs/features/` may be git-ignored (a repo that keeps its feature folders local):
  // the status flips still happen on disk but are never staged.
  const ignored = (await gitRun(['check-ignore', '-q', '--', featureDir], opts)).code === 0;
  if (ignored) ctx.stderr.write('git commit: feature folder is git-ignored; not staged\n');

  const secrets = (await stagedPaths(opts, 'd')).filter(isSecretLike);
  if (secrets.length) {
    undo.restore = null; // everything is unstaged here by design
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
