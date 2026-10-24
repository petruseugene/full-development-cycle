import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UsageError, FailedError, parseCommandArgs, output, resolveFeatureDir,
  resolveProjectRoot, atomicWrite, updateText, readText,
} from '../lib/core.mjs';
import { COMMANDS, main } from '../dev-cycle.mjs';
import {
  mkFixture, runCli, mkCtx, leftoverTempFiles, SCRIPTS_DIR,
} from './helpers.mjs';

const CORE_URL = pathToFileURL(path.join(SCRIPTS_DIR, 'lib', 'core.mjs')).href;

// A throwaway command module exercising the core contract end-to-end.
const FAKE_CMD = `
import { parseCommandArgs, output, resolveFeatureDir, FailedError } from ${JSON.stringify(CORE_URL)};
export async function run(argv, ctx) {
  const { values, args } = parseCommandArgs(argv, {
    usage: 'fake <name> --phase <p> [--fail]',
    options: { phase: { type: 'string', required: true }, fail: { type: 'boolean' } },
    positionals: ['name'],
  });
  if (values.fail) throw new FailedError('it failed');
  const dir = resolveFeatureDir(ctx, values);
  output(ctx, values, { text: 'ok ' + args.name, data: { name: args.name, phase: values.phase, dir } });
}
`;

function fakeLib(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-fakelib-'));
  fs.writeFileSync(path.join(dir, 'cmd-fake.mjs'), FAKE_CMD);
  fs.writeFileSync(path.join(dir, 'cmd-norun.mjs'), 'export const x = 1;\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    commands: { fake: 'cmd-fake.mjs', norun: 'cmd-norun.mjs', missing: 'cmd-missing.mjs' },
    libUrl: pathToFileURL(dir + path.sep),
  };
}

// ---------------------------------------------------------------------------
// AC1 — dependency-free
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('AC1: every import in scripts/**/*.mjs is node: or relative', () => {
  const files = walk(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 4);
  const re = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'))) {
        bad.push(`${path.relative(SCRIPTS_DIR, f)}: ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('AC1: no package.json with dependencies under scripts/', () => {
  const pkgs = walk(SCRIPTS_DIR).filter((f) => path.basename(f) === 'package.json');
  for (const p of pkgs) {
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.ok(!pkg[k] || Object.keys(pkg[k]).length === 0, `${p} declares ${k}`);
    }
  }
});

test('command table covers every R5–R16 command and maps to cmd-<name>.mjs', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [
    'brief', 'check', 'context', 'dod', 'feature', 'gate', 'git', 'groups', 'history', 'init', 'lessons', 'map', 'polish', 'post-merge', 'profile', 'recipe', 'report', 'review', 'ship', 'spec', 'task', 'tokens', 'visual', 'worktree',
  ]);
  for (const [name, file] of Object.entries(COMMANDS)) assert.equal(file, `cmd-${name}.mjs`);
});

// ---------------------------------------------------------------------------
// AC2 — exit codes, stderr, --json
// ---------------------------------------------------------------------------

test('AC2: unknown command exits 2 with a stderr message', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const r = runCli(['frobnicate'], { cwd: fx.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command 'frobnicate'/);
  assert.equal(r.stdout, '');
});

test('AC2: no command exits 2; --help exits 0', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const r = runCli([], { cwd: fx.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing command/);
  const h = runCli(['--help'], { cwd: fx.root });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /usage: dev-cycle/);
});

test('AC2: every registered command rejects an unknown flag with exit 2 + stderr', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  for (const cmd of Object.keys(COMMANDS)) {
    const r = runCli([cmd, '--definitely-not-a-flag'], { cwd: fx.root });
    assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', `${cmd} wrote nothing to stderr`);
  }
});

test('AC2 (in-process): unknown flag, missing option, missing positional → 2 + stderr', async (t) => {
  const opts = fakeLib(t);
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const cases = [
    ['fake', 'x', '--phase', 'p', '--bogus'],
    ['fake', 'x'], // missing --phase
    ['fake', '--phase', 'p'], // missing <name>
    ['fake', 'x', 'y', '--phase', 'p'], // extra positional
    ['fake', 'x', '--phase'], // option without value
    ['missing'],
    ['norun'],
  ];
  for (const argv of cases) {
    const ctx = mkCtx({ cwd: fx.root });
    const code = await main(argv, ctx, opts);
    assert.equal(code, 2, argv.join(' '));
    assert.notEqual(ctx.err(), '', argv.join(' '));
    assert.equal(ctx.out(), '', argv.join(' '));
  }
});

test('AC2 (in-process): --json writes a single parseable JSON document', async (t) => {
  const opts = fakeLib(t);
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const ctx = mkCtx({ cwd: fx.root });
  const code = await main(['fake', 'x', '--phase', 'p', '--json'], ctx, opts);
  assert.equal(code, 0);
  const doc = JSON.parse(ctx.out());
  assert.deepEqual(doc, { name: 'x', phase: 'p', dir: fx.featureDir });
  assert.equal(ctx.err(), '');

  const plain = mkCtx({ cwd: fx.root });
  assert.equal(await main(['fake', 'x', '--phase', 'p'], plain, opts), 0);
  assert.equal(plain.out(), 'ok x\n');
});

test('FailedError maps to exit 1 with its message on stderr', async (t) => {
  const opts = fakeLib(t);
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const ctx = mkCtx({ cwd: fx.root });
  assert.equal(await main(['fake', 'x', '--phase', 'p', '--fail'], ctx, opts), 1);
  assert.match(ctx.err(), /it failed/);
});

test('parseCommandArgs: optional and rest positionals, multiple options', () => {
  const r = parseCommandArgs(['a', 'b', 'c', '--answer', 'k=v', '--answer', 'x=y'], {
    options: { answer: { type: 'string', multiple: true } },
    positionals: ['first', 'rest...'],
  });
  assert.deepEqual(r.args, { first: 'a', rest: ['b', 'c'] });
  assert.deepEqual(r.values.answer, ['k=v', 'x=y']);
  const o = parseCommandArgs([], { positionals: ['maybe?'] });
  assert.deepEqual(o.args, {});
  assert.throws(() => parseCommandArgs(['--phase', ''], { options: { phase: { type: 'string', required: true } } }), UsageError);
  assert.throws(() => parseCommandArgs(['--nope']), (e) => e instanceof UsageError && e.exitCode === 2);
});

test('output: one-liners by default, a single JSON doc with --json', () => {
  const a = mkCtx();
  output(a, {}, { text: ['line 1', 'line 2'], data: { x: 1 } });
  assert.equal(a.out(), 'line 1\nline 2\n');
  const b = mkCtx();
  output(b, { json: true }, { text: 'hello' });
  assert.deepEqual(JSON.parse(b.out()), { message: 'hello' });
  const c = mkCtx();
  output(c, { json: true }, { text: 'x', data: [[1, 2], [3]] });
  assert.deepEqual(JSON.parse(c.out()), [[1, 2], [3]]);
  assert.equal(new FailedError().exitCode, 1);
});

// ---------------------------------------------------------------------------
// AC3 — feature folder resolution
// ---------------------------------------------------------------------------

test('AC3: --feature beats DEV_CYCLE_FEATURE beats newest folder', (t) => {
  const fx = mkFixture({ feature: '2026-01-01-00h-00m-a' });
  t.after(() => fx.cleanup());
  const A = fx.featureDir;
  const B = fx.addFeature('2026-01-02-00h-00m-b');
  const newest = fx.addFeature('2026-03-01-00h-00m-z');
  fs.mkdirSync(path.join(fx.featuresDir, '.hidden-9999'));

  const ctxBoth = mkCtx({ cwd: fx.root, env: { DEV_CYCLE_FEATURE: B } });
  assert.equal(resolveFeatureDir(ctxBoth, { feature: A }), A);

  const ctxEnv = mkCtx({ cwd: fx.root, env: { DEV_CYCLE_FEATURE: B } });
  assert.equal(resolveFeatureDir(ctxEnv, {}), B);

  const ctxNone = mkCtx({ cwd: fx.root });
  assert.equal(resolveFeatureDir(ctxNone, {}), newest);
});

test('AC3: via the CLI process (env + --feature + newest)', async (t) => {
  const opts = fakeLib(t);
  const fx = mkFixture({ feature: '2026-01-01-00h-00m-a' });
  t.after(() => fx.cleanup());
  const B = fx.addFeature('2026-01-02-00h-00m-b');
  const run = async (argv, env) => {
    const ctx = mkCtx({ cwd: fx.root, env });
    assert.equal(await main(['fake', 'x', '--phase', 'p', '--json', ...argv], ctx, opts), 0, ctx.err());
    return JSON.parse(ctx.out()).dir;
  };
  assert.equal(await run(['--feature', fx.featureDir], { DEV_CYCLE_FEATURE: B }), fx.featureDir);
  assert.equal(await run([], { DEV_CYCLE_FEATURE: B }), B);
  assert.equal(await run([], {}), B); // B is lexicographically newest
});

test('feature resolution accepts a bare folder name and a relative path; bad values exit 2', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const sub = path.join(fx.root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const ctx = mkCtx({ cwd: sub });
  assert.equal(resolveProjectRoot(ctx), fx.root);
  assert.equal(resolveFeatureDir(ctx, { feature: path.basename(fx.featureDir) }), fx.featureDir);
  assert.equal(resolveFeatureDir(mkCtx({ cwd: fx.root }), { feature: 'docs/features/' + path.basename(fx.featureDir) }), fx.featureDir);
  assert.throws(() => resolveFeatureDir(ctx, { feature: 'nope' }), UsageError);
  assert.throws(() => resolveFeatureDir(mkCtx({ cwd: fx.root, env: { DEV_CYCLE_FEATURE: 'nope' } }), {}), UsageError);
});

test('W1: --feature / DEV_CYCLE_FEATURE are confined to docs/features/<child>', async (t) => {
  const opts = fakeLib(t);
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'feature.json'), '{}\n');
  fs.mkdirSync(path.join(fx.root, 'other'));
  fs.mkdirSync(path.join(fx.featureDir, 'nested'));
  fs.symlinkSync(outside, path.join(fx.featuresDir, 'zz-link-outside'), 'dir');

  const bad = [
    path.join('docs', 'features', '..', '..', 'other'), // `..` traversal
    path.join('docs', 'features', path.basename(fx.featureDir), '..', '..'), // features root itself
    '..',
    outside, // absolute path outside the project
    path.join(fx.featuresDir, 'zz-link-outside'), // symlink pointing outside
    'zz-link-outside', // same symlink by bare name
    path.join(fx.featureDir, 'nested'), // not a direct child
  ];
  for (const value of bad) {
    assert.throws(() => resolveFeatureDir(mkCtx({ cwd: fx.root }), { feature: value }), UsageError, value);
    assert.throws(() => resolveFeatureDir(mkCtx({ cwd: fx.root, env: { DEV_CYCLE_FEATURE: value } }), {}), UsageError, value);

    const viaFlag = mkCtx({ cwd: fx.root });
    assert.equal(await main(['fake', 'x', '--phase', 'p', '--feature', value], viaFlag, opts), 2, value);
    assert.match(viaFlag.err(), /feature folder/);
    const viaEnv = mkCtx({ cwd: fx.root, env: { DEV_CYCLE_FEATURE: value } });
    assert.equal(await main(['fake', 'x', '--phase', 'p'], viaEnv, opts), 2, value);
    assert.equal(viaEnv.out(), '');
  }

  // Legit forms still work: bare name, relative path, absolute path.
  const ctx = mkCtx({ cwd: fx.root });
  const name = path.basename(fx.featureDir);
  assert.equal(resolveFeatureDir(ctx, { feature: name }), fx.featureDir);
  assert.equal(resolveFeatureDir(ctx, { feature: `docs/features/${name}/` }), fx.featureDir);
  assert.equal(resolveFeatureDir(ctx, { feature: fx.featureDir }), fx.featureDir);
});

test('W1: a CLI process with a traversal --feature exits 2', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const r = runCli(['dod', '--feature', '../../..'], { cwd: fx.featureDir });
  assert.equal(r.status, 2);
  assert.notEqual(r.stderr, '');
});

test('no feature folder at all is a UsageError', (t) => {
  const fx = mkFixture({ featureJson: null });
  t.after(() => fx.cleanup());
  fs.rmSync(fx.featureDir, { recursive: true });
  assert.throws(() => resolveFeatureDir(mkCtx({ cwd: fx.root }), {}), UsageError);
});

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

test('atomicWrite replaces content, leaves no temp file, keeps mode', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const file = path.join(fx.featureDir, 'plan.md');
  fs.writeFileSync(file, 'old\n', { mode: 0o640 });
  atomicWrite(file, 'new\n');
  assert.equal(readText(file), 'new\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(leftoverTempFiles(fx.featureDir), []);
});

test('atomicWrite with a stale `expected` refuses and cleans up', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const file = path.join(fx.featureDir, 'plan.md');
  fs.writeFileSync(file, 'changed by someone else\n');
  assert.throws(() => atomicWrite(file, 'mine\n', { expected: 'what I read\n' }), UsageError);
  assert.equal(readText(file), 'changed by someone else\n');
  assert.deepEqual(leftoverTempFiles(fx.featureDir), []);
});

test('updateText: transforms, skips unchanged writes, missing file → UsageError', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const file = path.join(fx.featureDir, 'spec.md');
  fs.writeFileSync(file, 'a\nb\n');
  const r = updateText(file, (s) => s.replace('b', 'c'));
  assert.equal(r.changed, true);
  assert.equal(readText(file), 'a\nc\n');
  const mtime = fs.statSync(file).mtimeMs;
  assert.equal(updateText(file, (s) => s).changed, false);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.throws(() => updateText(path.join(fx.featureDir, 'none.md'), (s) => s), UsageError);
  assert.equal(readText(path.join(fx.featureDir, 'none.md'), { optional: true }), null);
});
