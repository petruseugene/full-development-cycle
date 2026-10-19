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
import { UsageError, parseCommandArgs, readText, resolveFeatureDir } from './core.mjs';
import { featureJsonPath, readFeatureJson } from './feature-json.mjs';
import { appendHistory } from './history.mjs';
import { buildCommitMessage } from './git-message.mjs';
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
function applyFlips(featureDir) {
  const changed = new Set();
  const src = tasksSource(featureDir);
  if (src) {
    const before = src.text;
    let text = before;
    for (const t of parsePlan(before).filter((x) => x.status === 'IMPL-DONE' && !isOwnerTask(x))) {
      text = setTaskStatus(text, t.n, 'DONE', { source: path.basename(src.file) });
    }
    if (text !== before) { fs.writeFileSync(src.file, text); changed.add(src.file); }
  }
  // `spec status DONE`: spec.md frontmatter, plus plan.md frontmatter when present.
  for (const name of ['spec.md', 'plan.md']) {
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
export async function commit(argv, ctx) {
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
