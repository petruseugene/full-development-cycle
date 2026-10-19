// Shared test helpers for scripts/test/*.test.mjs (node:test, no deps).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Absolute path to scripts/dev-cycle.mjs */
export const CLI_PATH = fileURLToPath(new URL('../dev-cycle.mjs', import.meta.url));

/** Absolute path to scripts/ */
export const SCRIPTS_DIR = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_FEATURE = '2026-01-01-00h-00m-sample';

/** A minimal, valid feature.json object (fresh copy each call). */
export function sampleFeatureJson(over = {}) {
  return {
    feature_slug: 'sample',
    created: '2026-01-01 00:00',
    flow: 'feature',
    track: 'full',
    platform: 'web',
    has_ui: false,
    has_backend: true,
    auto_tests: true,
    visual_tests: false,
    current_phase: 'implement',
    history: [],
    totals: { by_subagent: {}, by_model: {} },
    ...over,
  };
}

/**
 * Create a temp project root containing docs/features/<feature>/.
 *
 * @param {object} [opts]
 * @param {string} [opts.feature]  feature folder name
 * @param {object|null} [opts.featureJson]  written as feature.json; null = no file
 * @param {Record<string,string>} [opts.files]  extra files, paths relative to the feature dir
 * @returns {{root: string, featuresDir: string, featureDir: string,
 *   addFeature(name: string, json?: object|null): string,
 *   write(rel: string, text: string): string, read(rel: string): string,
 *   cleanup(): void}}
 *   `write`/`read` paths are relative to the project root.
 */
export function mkFixture({ feature = DEFAULT_FEATURE, featureJson = sampleFeatureJson(), files = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-test-')));
  const featuresDir = path.join(root, 'docs', 'features');
  fs.mkdirSync(featuresDir, { recursive: true });

  const addFeature = (name, json = sampleFeatureJson()) => {
    const dir = path.join(featuresDir, name);
    fs.mkdirSync(dir, { recursive: true });
    if (json !== null) fs.writeFileSync(path.join(dir, 'feature.json'), JSON.stringify(json, null, 2) + '\n');
    return dir;
  };
  const featureDir = addFeature(feature, featureJson);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(featureDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }

  return {
    root,
    featuresDir,
    featureDir,
    addFeature,
    write(rel, text) {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
      return p;
    },
    read(rel) {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** process.env without any inherited DEV_CYCLE_* variables. */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DEV_CYCLE_')) delete env[k];
  return env;
}

/**
 * Run the CLI as a child process.
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, input?: string}} [opts]
 *   `env` is merged over process.env (inherited DEV_CYCLE_* vars are dropped).
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function runCli(args, { cwd = process.cwd(), env = {}, input } = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...cleanEnv(), ...env },
    encoding: 'utf8',
    input,
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * In-process context for calling `run(argv, ctx)` of a cmd module directly.
 * @param {{cwd?: string, env?: Record<string,string>}} [opts]
 * @returns {import('../lib/core.mjs').CliContext & {out(): string, err(): string}}
 */
export function mkCtx({ cwd = process.cwd(), env = {} } = {}) {
  let out = '';
  let err = '';
  return {
    cwd,
    env,
    stdout: { write: (s) => { out += s; return true; } },
    stderr: { write: (s) => { err += s; return true; } },
    out: () => out,
    err: () => err,
  };
}

/** Names in `dir` that look like CLI temp files (dot-prefixed `.tmp`). */
export function leftoverTempFiles(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith('.') && n.endsWith('.tmp'));
}
