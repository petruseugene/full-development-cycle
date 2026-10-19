// Shared helpers for the `dev-cycle git` test suites (git-branch, git-commit,
// git-remote). Every repo lives in a temp dir; nothing touches the real
// working tree's git state.
//
//   mkGitRepo()            temp project (docs/features/<f>/feature.json) as a git
//                          repo on `main`, pushed to a local bare `origin`.
//   mkGhStub(dir, rules)   stub gh (fixtures/gh-stub) + env for DEV_CYCLE_GH.
//   installSpawnRecorder() records every spawn made through git-exec.mjs and
//                          asserts no forbidden flag (--force, --no-verify, ...).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FEATURE, mkCtx, mkFixture, sampleFeatureJson } from './helpers.mjs';
import { findForbiddenArg, setSpawn } from '../lib/git-exec.mjs';

export const GH_STUB_SCRIPT = fileURLToPath(new URL('./fixtures/gh-stub/gh-stub.mjs', import.meta.url));

/**
 * Environment for git in tests: inherited env minus DEV_CYCLE_*, with the
 * user's global/system git config ignored (no keychain helper, no hooks path,
 * no signing) and a fixed identity.
 * @param {Record<string,string>} [extra]
 */
export function gitTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DEV_CYCLE_') || k.startsWith('GIT_')) delete env[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  };
}

/** Run git synchronously in `cwd`; throws on a non-zero exit. Returns trimmed stdout. */
export function gitSync(cwd, args, env = gitTestEnv()) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Temp project that is a git repo on `main` with one commit, pushed to a
 * local bare remote `origin` (origin/HEAD → origin/main).
 * @param {object} [opts]
 * @param {string} [opts.feature]
 * @param {object} [opts.featureJson]
 * @param {Record<string,string>} [opts.files]  extra files relative to the feature dir
 * @param {boolean} [opts.remote=true]  create and push to the bare remote
 */
export function mkGitRepo({ feature = DEFAULT_FEATURE, featureJson = sampleFeatureJson(), files = {}, remote = true } = {}) {
  const fx = mkFixture({ feature, featureJson, files });
  const env = gitTestEnv();
  const remoteDir = remote ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-remote-'))) : null;
  const git = (args) => gitSync(fx.root, args, env);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  if (remote) {
    gitSync(remoteDir, ['init', '-q', '--bare', '-b', 'main'], env);
    git(['remote', 'add', 'origin', remoteDir]);
    git(['push', '-q', '-u', 'origin', 'main']);
    git(['remote', 'set-head', 'origin', 'main']);
  }
  const extraDirs = [];
  return {
    ...fx,
    remoteDir,
    env,
    git,
    /** in-process CliContext rooted at the repo; `extraEnv` merged over the git env */
    ctx(extraEnv = {}) {
      return mkCtx({ cwd: fx.root, env: { ...env, ...extraEnv } });
    },
    /** make a scratch dir that cleanup() removes */
    tmpDir(prefix = 'dev-cycle-scratch-') {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
      extraDirs.push(d);
      return d;
    },
    cleanup() {
      fx.cleanup();
      if (remoteDir) fs.rmSync(remoteDir, { recursive: true, force: true });
      for (const d of extraDirs) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

/**
 * Stub gh in `dir`: an executable wrapper running fixtures/gh-stub/gh-stub.mjs.
 * @param {string} dir  scratch directory (e.g. repo.tmpDir())
 * @param {Array<{match: string, exit?: number, stdout?: string, stderr?: string,
 *   sequence?: Array<{exit?: number, stdout?: string, stderr?: string}>}>} [rules]
 * @returns {{bin: string, env: Record<string,string>, setRules(r: any[]): void,
 *   calls(): Array<{argv: string[], env: {GH_PROMPT_DISABLED: string|null}}>}}
 */
export function mkGhStub(dir, rules = []) {
  const bin = path.join(dir, 'gh');
  const log = path.join(dir, 'gh-calls.jsonl');
  const script = path.join(dir, 'gh-rules.json');
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${q(process.execPath)} ${q(GH_STUB_SCRIPT)} "$@"\n`, { mode: 0o755 });
  const setRules = (r) => {
    fs.writeFileSync(script, JSON.stringify(r));
    fs.rmSync(`${script}.state.json`, { force: true });
  };
  setRules(rules);
  return {
    bin,
    env: { DEV_CYCLE_GH: bin, GH_STUB_LOG: log, GH_STUB_SCRIPT: script },
    setRules,
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

/**
 * Assert that no argv in `calls` carries a forbidden flag.
 * @param {Array<{cmd?: string, args?: string[], argv?: string[]}>} calls
 */
export function assertNoForbidden(calls) {
  for (const c of calls) {
    const argv = c.args ?? c.argv ?? [];
    const bad = findForbiddenArg(argv);
    assert.equal(bad, null, `forbidden argument '${bad}' in ${c.cmd ?? 'gh'} ${argv.join(' ')}`);
  }
}

/**
 * Route git-exec.mjs spawns through a recorder. Each call is asserted for
 * forbidden flags as it happens and kept in `calls` ({cmd, args, env}).
 * Always call restore() (e.g. in a finally block or t.after).
 */
export function installSpawnRecorder() {
  const calls = [];
  const prev = setSpawn((cmd, args, opts) => {
    calls.push({ cmd, args: [...args], env: opts?.env ?? {} });
    assertNoForbidden([{ cmd, args }]);
    return nodeSpawn(cmd, args, opts);
  });
  return {
    calls,
    /** argv lists of recorded git calls */
    gitCalls: () => calls.filter((c) => c.cmd === 'git').map((c) => c.args),
    assertNoForbidden: () => assertNoForbidden(calls),
    restore: () => { setSpawn(prev); },
  };
}

/** Parsed feature.json of a repo fixture. */
export function readFj(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo.featureDir, 'feature.json'), 'utf8'));
}
