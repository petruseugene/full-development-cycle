// dev-cycle ship [--release major|minor|patch|auto] [--subject <s>] [--body <b>]
//                [--notes-file <f>] [--manifest <path>]... [--scope <s>] [--trailer "Key: value"]...
//                [--closes <n,m>] [--body-footer <text>] [--ci-timeout <s>] [--gh-credential]
//
// One command for the end of a feature. Steps run in order, each printing
// `ship: <step> ok|skipped`:
//
//   tokens → dod → release → commit → push → pr → merge → tag
//
// `release` and `tag` only act with --release. The first failure prints the
// composed verb's own line (`git <verb>: FAILED <reason> — <detail>`, the
// `! DOD-GATE FAILED` line, or `ship <step>: FAILED <reason> — <detail>`) on
// stderr and exits 1. Re-running skips what is already done (R28): release
// when feature.json history records it for the current manifest version,
// commit on a clean tree, push when origin/<branch> equals HEAD, pr when one
// is open, and everything but the tag once back on a clean default branch.
//
// git and gh are only ever reached through the existing verbs and the
// gitRun/ghRun argv wrappers (never a shell). Pushes: the feature branch and
// the single `v<x.y.z>` tag ref, never --force, --tags or the base branch.

import path from 'node:path';
import { CliError, UsageError, atomicWrite, output, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot } from './core.mjs';
import { evaluateDod } from './dod.mjs';
import { readFeatureJson } from './feature-json.mjs';
import { appendHistory } from './history.mjs';
import { currentBranch, defaultBranch } from './git-branch.mjs';
import { commit } from './git-commit.mjs';
import {
  GIT_COMMON_OPTIONS, GitFailure, execOpts, ghRun, gitOk, gitRun, outputTail,
} from './git-exec.mjs';
import { merge, pr, push } from './git-remote.mjs';
import { tokenCoverage, tokenCoverageLine } from './token-coverage.mjs';
import { run as tokensRun } from './cmd-tokens.mjs';
import {
  LEVELS, ReleaseError, VERSION_RE, agreedVersion, bumpVersion, inferLevel, insertChangelog,
  loadManifests, readNotesFile, setManifestVersion, subjectNotes, today,
} from './release.mjs';

const USAGE = 'ship [--release major|minor|patch|auto] [--subject <s>] [--body <b>] [--notes-file <f>] [--manifest <path>]... [--scope <s>] [--trailer "Key: value"]... [--closes <n,m>] [--body-footer <text>] [--ci-timeout <s>] [--gh-credential]\n  with --release a non-conventional --subject is prefixed with feat (minor/major) or fix (patch) plus (--scope)';
const CONVENTIONAL_RE = /^[a-z]+(\([^)\n]*\))?!?: \S/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ARROW_RE = /^(\d+\.\d+\.\d+) → (\d+\.\d+\.\d+)$/;

/** A failure of a ship-owned step: printed as `ship <step>: FAILED <reason> — <detail>`. */
class StepFailure extends Error {
  constructor(step, reason, detail = '') {
    super(`${step}: ${reason} — ${detail}`);
    this.step = step;
    this.reason = reason;
    this.detail = detail;
  }
}

/** New version recorded by the last `release` history entry, or null. */
function lastReleased(fj) {
  const h = Array.isArray(fj.history) ? fj.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]?.phase !== 'release') continue;
    const m = ARROW_RE.exec(String(h[i].summary ?? ''));
    if (m) return m[2];
  }
  return null;
}

async function commitMessages(def, opts) {
  const r = await gitRun(['log', '--format=%B%x1e', `${def}..HEAD`], opts);
  if (r.code !== 0) return [];
  return r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean);
}

/**
 * With --release, a subject that is not a conventional-commit subject gets
 * `feat` (minor/major) or `fix` (patch) plus `(--scope)` prefixed.
 * `auto` takes its level from the raw subject/body.
 */
export function releaseSubject(subject, level, scope, body = '', current = '0.0.0') {
  if (typeof subject !== 'string' || CONVENTIONAL_RE.test(subject.split('\n')[0])) return subject;
  const lv = level === 'auto' ? inferLevel([[subject, body].filter(Boolean).join('\n\n')], current) : level;
  return `${lv === 'patch' ? 'fix' : 'feat'}${scope ? `(${scope})` : ''}: ${subject}`;
}

/** The release step. Returns 'ok' or 'skipped'. */
function releaseStep({ ctx, root, featureDir, values, fj, notesText, messages, resume }) {
  const manifests = loadManifests(root, values.manifest ?? []);
  const current = agreedVersion(manifests);
  if (resume || lastReleased(fj) === current) return { status: 'skipped', version: lastReleased(fj) ?? current };

  const subject = values.subject ?? '';
  const asked = values.release;
  const level = asked === 'auto' ? inferLevel([[subject, values.body ?? ''].filter(Boolean).join('\n\n'), ...messages].filter(Boolean), current) : asked;
  const next = bumpVersion(current, level);
  if (!VERSION_RE.test(next)) throw new ReleaseError('invalid-version', next);

  const notes = notesText ?? subjectNotes(subject);
  const changelog = path.join(root, 'CHANGELOG.md');
  const before = readText(changelog, { optional: true });
  const after = insertChangelog(before, next, today(), notes);

  for (const m of manifests) atomicWrite(m.abs, setManifestVersion(m.abs, m.text, next));
  atomicWrite(changelog, after);
  appendHistory(featureDir, {
    phase: 'release', subagent: 'cli', executor: 'cli', status: 'DONE', summary: `${current} → ${next}`,
  });
  return { status: 'ok', version: next };
}

/** Local and remote commit of a tag (null when absent). */
async function tagCommits(tag, opts) {
  const local = await gitRun(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], opts);
  const remote = await gitRun(['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], opts);
  let direct = null;
  let peeled = null;
  if (remote.code === 0) {
    for (const line of remote.stdout.split('\n')) {
      const [oid, ref] = line.trim().split(/\s+/);
      if (ref === `refs/tags/${tag}^{}`) peeled = oid;
      else if (ref === `refs/tags/${tag}`) direct = oid;
    }
  }
  return { local: local.code === 0 ? local.stdout.trim() : null, remote: peeled ?? direct };
}

/** The tag step. Returns 'ok' or 'skipped'. */
async function tagStep({ version, branch, opts }) {
  if (!version || !VERSION_RE.test(version)) {
    throw new StepFailure('tag', 'no-release', 'no release recorded in feature.json history; run ship --release first');
  }
  const tag = `v${version}`;
  const view = await ghRun(['pr', 'view', branch, '--json', 'mergeCommit'], opts);
  let sha = '';
  if (view.code === 0) {
    try { sha = JSON.parse(view.stdout)?.mergeCommit?.oid ?? ''; } catch { sha = ''; }
  }
  if (!SHA_RE.test(sha)) {
    throw new StepFailure('tag', 'no-merge-commit', `gh pr view ${branch}: no merge commit${view.code === 0 ? '' : ` (${outputTail(view.stderr, 3)})`}`);
  }
  const { local, remote } = await tagCommits(tag, opts);
  if ((local && local !== sha) || (remote && remote !== sha)) {
    throw new StepFailure('tag', 'tag-exists', `${tag} already exists on ${local && local !== sha ? local : remote}, not on merge commit ${sha}`);
  }
  if (local === sha && remote === sha) return 'skipped';
  if (!local && remote === sha) return 'skipped';
  if (!local) {
    const have = await gitRun(['cat-file', '-e', `${sha}^{commit}`], opts);
    if (have.code !== 0) throw new StepFailure('tag', 'no-merge-commit', `merge commit ${sha} is not in the local repository`);
    const t = await gitRun(['tag', '-a', tag, sha, '-m', `release ${version}`], opts);
    if (t.code !== 0) throw new StepFailure('tag', 'tag-failed', outputTail(t.stderr || t.stdout, 5) || `git tag exited ${t.code}`);
  }
  if (remote !== sha) {
    const p = await gitRun(['push', 'origin', `refs/tags/${tag}`], opts);
    if (p.code !== 0) throw new StepFailure('tag', 'push-rejected', `git push origin refs/tags/${tag}: ${outputTail(p.stderr || p.stdout, 5) || `exit ${p.code}`}`);
  }
  return 'ok';
}

/**
 * @param {string[]} argv
 * @param {import('./core.mjs').CliContext} ctx
 */
export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, {
    usage: USAGE,
    options: {
      release: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      'notes-file': { type: 'string' },
      manifest: { type: 'string', multiple: true },
      scope: { type: 'string' },
      trailer: { type: 'string', multiple: true },
      closes: { type: 'string' },
      'body-footer': { type: 'string' },
      'ci-timeout': { type: 'string' },
      ...GIT_COMMON_OPTIONS,
    },
  });
  if (values.release !== undefined && !LEVELS.includes(values.release)) {
    throw new UsageError(`--release must be one of ${LEVELS.join('|')} (usage: dev-cycle ${USAGE})`);
  }
  if (values.release === undefined && (values['notes-file'] !== undefined || values.manifest)) {
    throw new UsageError(`--notes-file and --manifest need --release (usage: dev-cycle ${USAGE})`);
  }
  if (values.release !== undefined && values.subject === undefined && values['notes-file'] === undefined) {
    throw new UsageError(`--release needs --subject or --notes-file (usage: dev-cycle ${USAGE})`);
  }

  if (values.release === 'auto' && values.subject === undefined) {
    throw new UsageError(`--release auto needs --subject to infer the level from (usage: dev-cycle ${USAGE})`);
  }

  const featureDir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  if (values.release !== undefined && values.subject !== undefined) {
    let current = '0.0.0';
    try { current = agreedVersion(loadManifests(root, values.manifest ?? [])); } catch { /* the release step reports it */ }
    values.subject = releaseSubject(values.subject, values.release, values.scope, values.body ?? '', current);
  }
  const opts = execOpts(ctx, values);
  const releasing = values.release !== undefined;
  const notesText = values['notes-file'] === undefined
    ? null
    : readNotesFile(values['notes-file'], { root, cwd: ctx.cwd, env: ctx.env });

  const json = Boolean(values.json);
  const steps = [];
  const mark = (step, status) => {
    steps.push({ step, status });
    if (!json) ctx.stdout.write(`ship: ${step} ${status}\n`);
  };
  let tokensInfo = null;
  const fail = (line, extra) => {
    ctx.stderr.write(`${line}\n`);
    if (json) ctx.stdout.write(`${JSON.stringify({ ok: false, steps, ...(tokensInfo ? { tokens: tokensInfo } : {}), ...extra })}\n`);
    return 1;
  };

  const branch = await currentBranch('ship', opts, { allowDefault: true });
  const def = await defaultBranch(opts);
  const clean = (await gitOk(['status', '--porcelain'], opts)) === '';
  const onDefault = branch === def;
  if (onDefault && !clean) {
    throw new UsageError(`ship: on the default branch '${def}' with uncommitted changes; check out the feature branch first`);
  }
  const resume = onDefault && clean; // already merged: only the tag may be left

  const fj = readFeatureJson(featureDir);
  let version = lastReleased(fj);

  try {
    // 1. tokens
    const measured = Array.isArray(fj.history) && fj.history.some((e) => e?.phase === 'orchestrator');
    const hasSession = Boolean(ctx.env?.CLAUDE_CODE_SESSION_ID) || (Array.isArray(fj.sessions) && fj.sessions.length > 0);
    if (resume || !hasSession || (clean && measured)) {
      mark('tokens', 'skipped');
    } else {
      try {
        await tokensRun(['orchestrator', '--feature', featureDir], { ...ctx, stdout: { write() { return true; } } });
        mark('tokens', 'ok');
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        ctx.stderr.write(`warning: ship tokens: ${err.message}\n`);
        mark('tokens', 'skipped');
      }
    }

    // 2. dod
    if (resume) {
      mark('dod', 'skipped');
    } else {
      const dod = evaluateDod(featureDir);
      const hist = readFeatureJson(featureDir).history;
      tokensInfo = tokenCoverage(hist);
      const tline = tokenCoverageLine(hist);
      if (!dod.passed) {
        if (!json) ctx.stdout.write(`${tline}\n`);
        return fail(`! DOD-GATE FAILED: ${dod.failed.gate} last status = ${dod.failed.status}; aborting before push.`, { reason: 'dod-failed', failed: dod.failed });
      }
      mark('dod', 'ok');
      if (!json) ctx.stdout.write(`${tline}\n`);
    }

    // 3. release
    if (!releasing) {
      mark('release', 'skipped');
    } else {
      const messages = values.release === 'auto' && !resume ? await commitMessages(def, opts) : [];
      let res;
      try {
        res = releaseStep({ ctx, root, featureDir, values, fj, notesText, messages, resume });
      } catch (err) {
        if (err instanceof ReleaseError) throw new StepFailure('release', err.reason, err.detail);
        throw err;
      }
      version = res.status === 'ok' ? res.version : (lastReleased(readFeatureJson(featureDir)) ?? version);
      mark('release', res.status);
    }

    // 4. commit
    if (resume || (await gitOk(['status', '--porcelain'], opts)) === '') {
      mark('commit', 'skipped');
    } else {
      const args = [];
      if (values.subject !== undefined) args.push('--subject', values.subject);
      if (values.body !== undefined) args.push('--body', values.body);
      if (values.scope !== undefined) args.push('--scope', values.scope);
      if (values.closes !== undefined) args.push('--closes', values.closes);
      for (const t of values.trailer ?? []) args.push('--trailer', t);
      if (values['gh-credential']) args.push('--gh-credential');
      await commit([...args, '--feature', featureDir], ctx);
      mark('commit', 'ok');
    }

    // 5. push
    const head = await gitRun(['rev-parse', 'HEAD'], opts);
    const remoteRef = await gitRun(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], opts);
    if (resume || (remoteRef.code === 0 && remoteRef.stdout.trim() === head.stdout.trim())) {
      mark('push', 'skipped');
    } else {
      await push(values['gh-credential'] ? ['--gh-credential'] : [], ctx);
      mark('push', 'ok');
    }

    // 6. pr
    if (resume) {
      mark('pr', 'skipped');
    } else {
      const args = ['--feature', featureDir];
      if (values.subject !== undefined) args.push('--title', values.subject);
      if (values['body-footer'] !== undefined) args.push('--body-footer', values['body-footer']);
      if (values['gh-credential']) args.push('--gh-credential');
      const res = await pr(args, ctx);
      mark('pr', res?.data?.created === false ? 'skipped' : 'ok');
    }

    // 7. merge
    if (resume) {
      mark('merge', 'skipped');
    } else {
      const args = ['--feature', featureDir];
      if (values['ci-timeout'] !== undefined) args.push('--ci-timeout', values['ci-timeout']);
      if (values['gh-credential']) args.push('--gh-credential');
      await merge(args, ctx);
      mark('merge', 'ok');
    }

    // 8. tag
    if (!releasing) {
      mark('tag', 'skipped');
    } else {
      const tagBranch = onDefault ? fj.branch : branch;
      if (typeof tagBranch !== 'string' || tagBranch === '') {
        throw new StepFailure('tag', 'no-merge-commit', 'feature.json has no branch to look the pull request up by');
      }
      mark('tag', await tagStep({ version, branch: tagBranch, opts }));
    }
  } catch (err) {
    if (err instanceof GitFailure) {
      // The verb that threw is the last step not marked yet.
      const done = new Set(steps.map((s) => s.step));
      const verb = ['commit', 'push', 'pr', 'merge'].find((v) => !done.has(v)) ?? 'git';
      return fail(`git ${verb}: FAILED ${err.reason} — ${err.detail}`, { reason: err.reason, detail: err.detail });
    }
    if (err instanceof StepFailure) {
      return fail(`ship ${err.step}: FAILED ${err.reason} — ${err.detail}`, { reason: err.reason, detail: err.detail });
    }
    throw err;
  }

  if (json) output(ctx, values, { data: { ok: true, steps, ...(tokensInfo ? { tokens: tokensInfo } : {}), ...(version ? { version } : {}) } });
  return 0;
}
