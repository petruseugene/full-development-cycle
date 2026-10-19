// dev-cycle git push | pr | merge   (spec R18, R19, R13, R14, R20)
//
// None of these verbs writes feature.json (R18): they only read it (pr body,
// dod), so the working tree stays clean after merge.
//
// - push  [--gh-credential]
//     `git push -u origin <current branch>`. Rejection → push-rejected,
//     credential failure → auth, hang → timeout.
// - pr    [--base <b>] [--title <t>] [--body-footer <text>] [--gh-credential]
//     `gh auth status` preflight; an open PR for the branch → print its URL,
//     exit 0; else `gh pr create --head <branch> --base <b|default>
//     --title <t|HEAD subject> --body-file <tmp>` with buildPrBody().
//     Hotfix: pass `--base <release branch>` (R19).
// - merge [--ci-timeout <s>=900] [--gh-credential]
//     1. dod (evaluateDod) → dod-failed, nothing merged;
//     2. `gh auth status`, PR mergeability (CONFLICTING → conflict);
//     3. `gh pr checks`: fail → ci-failing; pending → poll until done or the
//        timeout → ci-pending; none → proceed;
//     4. `gh pr merge <branch> --squash --delete-branch`, then
//        `git checkout <default>` and `git pull --ff-only`.
//   The poll interval is 10 s (DEV_CYCLE_CI_POLL_S overrides it; test seam).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError, parseCommandArgs, resolveFeatureDir } from './core.mjs';
import { evaluateDod } from './dod.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { currentBranch, defaultBranch } from './git-branch.mjs';
import {
  GIT_COMMON_OPTIONS, GitFailure, execOpts, ghAuthPreflight, ghRun, gitOk, gitRun, outputTail,
} from './git-exec.mjs';
import { buildPrBody } from './git-message.mjs';
import { parsePlan, tasksSource } from './plan.mjs';

export const DEFAULT_CI_TIMEOUT_S = 900;
const DEFAULT_POLL_S = 10;

const AUTH_RE = /authentication failed|could not read username|permission denied|terminal prompts disabled|\b403\b|invalid username or password/i;
const CONFLICT_RE = /conflict/i;

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err?.code === 'ENOENT') return ''; throw err; }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// --- push -------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 */
export async function push(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'git push [--gh-credential]', options: { ...GIT_COMMON_OPTIONS } });
  const opts = execOpts(ctx, values);
  const branch = await currentBranch('push', opts);
  const r = await gitRun(['push', '-u', 'origin', branch], opts);
  if (r.code !== 0) {
    const out = r.stderr || r.stdout;
    const detail = `git push -u origin ${branch}: ${outputTail(out, 10) || `exit ${r.code}`}`;
    if (AUTH_RE.test(out)) throw new GitFailure('auth', detail);
    if (/hook declined|pre-push hook/i.test(out)) throw new GitFailure('hook-failed', detail);
    throw new GitFailure('push-rejected', detail);
  }
  return { text: `pushed ${branch} → origin/${branch}`, data: { branch, remote: 'origin' } };
}

// --- pr ---------------------------------------------------------------------

/** URL of an open PR whose head is `branch`, or null. */
async function existingPrUrl(branch, opts) {
  const r = await ghRun(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1'], opts);
  if (r.code !== 0) return null;
  const list = parseJson(r.stdout);
  const url = Array.isArray(list) ? list[0]?.url : undefined;
  return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 */
export async function pr(argv, ctx) {
  const usage = 'git pr [--base <b>] [--title <t>] [--body-footer <text>] [--gh-credential]';
  const { values } = parseCommandArgs(argv, {
    usage,
    options: {
      base: { type: 'string' }, title: { type: 'string' }, 'body-footer': { type: 'string' }, ...GIT_COMMON_OPTIONS,
    },
  });
  for (const k of ['base', 'title']) {
    if (values[k] !== undefined && values[k].trim() === '') throw new UsageError(`--${k} must not be empty (usage: dev-cycle ${usage})`);
  }
  const featureDir = resolveFeatureDir(ctx, values);
  const fj = readFeatureJson(featureDir);
  const opts = execOpts(ctx, values);
  const branch = await currentBranch('pr', opts);

  await ghAuthPreflight(opts);

  const existing = await existingPrUrl(branch, opts);
  if (existing) return { text: existing, data: { url: existing, created: false, branch } };

  const base = values.base ?? (await defaultBranch(opts));
  const title = values.title ?? (await gitOk(['log', '-1', '--format=%s'], opts));
  const headMessage = await gitOk(['log', '-1', '--format=%B'], opts);
  const src = tasksSource(featureDir);
  const body = buildPrBody({
    specText: readOptional(path.join(featureDir, 'spec.md')),
    tasks: src ? parsePlan(src.text) : [],
    history: fj.history,
    headMessage,
    footer: values['body-footer'] ?? '',
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-pr-'));
  try {
    const bodyFile = path.join(tmp, 'body.md');
    fs.writeFileSync(bodyFile, body);
    const r = await ghRun(['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body-file', bodyFile], opts);
    if (r.code !== 0) {
      const out = r.stderr || r.stdout;
      // A PR created concurrently (or not visible to `pr list`): report it.
      const m = out.match(/already exists[^\n]*\n?\s*(https?:\/\/\S+)/i);
      if (m) return { text: m[1], data: { url: m[1], created: false, branch } };
      const detail = `gh pr create: ${outputTail(out, 10) || `exit ${r.code}`}`;
      if (AUTH_RE.test(out)) throw new GitFailure('auth', detail);
      throw new GitFailure('not-mergeable', detail);
    }
    const url = r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    return { text: url, data: { url, created: true, branch, base } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- merge ------------------------------------------------------------------

/**
 * Classify `gh pr checks --json name,bucket` output.
 * @returns {{state: 'none'|'pass'|'fail'|'pending', names: string[]}}
 */
export function classifyChecks({ code, stdout, stderr }) {
  const list = parseJson(stdout);
  if (Array.isArray(list)) {
    if (list.length === 0) return { state: 'none', names: [] };
    const by = (b) => list.filter((c) => c?.bucket === b).map((c) => String(c?.name ?? '?'));
    const failing = [...by('fail'), ...by('cancel')];
    if (failing.length) return { state: 'fail', names: failing };
    const pending = by('pending');
    if (pending.length) return { state: 'pending', names: pending };
    return { state: 'pass', names: [] };
  }
  if (/no checks reported/i.test(`${stderr}\n${stdout}`)) return { state: 'none', names: [] };
  if (code === 0 && String(stdout).trim() === '') return { state: 'none', names: [] };
  return { state: 'fail', names: [`gh pr checks: ${outputTail(stderr || stdout, 3) || `exit ${code}`}`] };
}

/** Wait for the PR's checks: throws ci-failing / ci-pending; resolves on pass or none. */
async function waitForChecks(branch, timeout_s, poll_s, opts) {
  const deadline = Date.now() + timeout_s * 1000;
  for (;;) {
    const res = classifyChecks(await ghRun(['pr', 'checks', branch, '--json', 'name,bucket'], opts));
    if (res.state === 'fail') throw new GitFailure('ci-failing', `failing checks: ${res.names.join(', ')}`);
    if (res.state !== 'pending') return res.state;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new GitFailure('ci-pending', `checks still pending after ${timeout_s}s: ${res.names.join(', ')}`);
    }
    await sleep(Math.min(poll_s * 1000, left));
  }
}

/** Non-negative integer seconds from a CLI/env string, or undefined. */
function seconds(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 */
export async function merge(argv, ctx) {
  const usage = 'git merge [--ci-timeout <s>] [--gh-credential]';
  const { values } = parseCommandArgs(argv, {
    usage, options: { 'ci-timeout': { type: 'string' }, ...GIT_COMMON_OPTIONS },
  });
  const timeout_s = seconds(values['ci-timeout']) ?? DEFAULT_CI_TIMEOUT_S;
  if (Number.isNaN(timeout_s)) throw new UsageError(`--ci-timeout must be a non-negative integer (usage: dev-cycle ${usage})`);
  const pollEnv = seconds(ctx.env?.DEV_CYCLE_CI_POLL_S);
  const poll_s = pollEnv === undefined || Number.isNaN(pollEnv) || pollEnv === 0 ? DEFAULT_POLL_S : pollEnv;

  const featureDir = resolveFeatureDir(ctx, values);
  const opts = execOpts(ctx, values);
  const branch = await currentBranch('merge', opts);

  // 1. dod is the guard: nothing reaches gh when it fails.
  const dod = evaluateDod(featureDir);
  if (!dod.passed) {
    throw new GitFailure('dod-failed', `DOD-GATE FAILED: ${dod.failed.gate} last status = ${dod.failed.status}`);
  }

  await ghAuthPreflight(opts);

  // 2. Mergeability (best effort: unknown states fall through to gh pr merge).
  const view = await ghRun(['pr', 'view', branch, '--json', 'url,state,mergeable'], opts);
  const info = view.code === 0 ? parseJson(view.stdout) : undefined;
  if (view.code !== 0 && /no pull requests? found/i.test(view.stderr)) {
    throw new GitFailure('not-mergeable', `no pull request for ${branch}; run git pr first`);
  }
  if (info && typeof info === 'object') {
    if (info.state && info.state !== 'OPEN') throw new GitFailure('not-mergeable', `PR for ${branch} is ${info.state}`);
    if (info.mergeable === 'CONFLICTING') throw new GitFailure('conflict', `PR for ${branch} has merge conflicts with its base`);
  }

  // 3. CI.
  const checks = await waitForChecks(branch, timeout_s, poll_s, opts);

  // 4. Merge, then return to an up-to-date default branch.
  const m = await ghRun(['pr', 'merge', branch, '--squash', '--delete-branch'], opts);
  if (m.code !== 0) {
    const out = m.stderr || m.stdout;
    const detail = `gh pr merge: ${outputTail(out, 10) || `exit ${m.code}`}`;
    throw new GitFailure(CONFLICT_RE.test(out) ? 'conflict' : 'not-mergeable', detail);
  }
  const def = await defaultBranch(opts);
  const head = await gitRun(['symbolic-ref', '--quiet', '--short', 'HEAD'], opts);
  if (head.code !== 0 || head.stdout.trim() !== def) await gitOk(['checkout', def], { ...opts, reason: 'conflict' });
  const pull = await gitRun(['pull', '--ff-only'], opts);
  if (pull.code !== 0) {
    const out = pull.stderr || pull.stdout;
    const detail = `merged, but git pull --ff-only on ${def} failed: ${outputTail(out, 10) || `exit ${pull.code}`}`;
    throw new GitFailure(AUTH_RE.test(out) ? 'auth' : 'conflict', detail);
  }
  const url = typeof info?.url === 'string' ? info.url : undefined;
  return {
    text: `merged ${branch} (squash${checks === 'none' ? ', no checks' : ''}); on ${def}, up to date`,
    data: { branch, default: def, checks, ...(url ? { url } : {}) },
  };
}
