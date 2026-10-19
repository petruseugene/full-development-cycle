import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, sampleFeatureJson, runCli, mkCtx, DEFAULT_FEATURE } from './helpers.mjs';
import { run, shellQuote, normalizeFiles, resolveCommands, substituteFiles, assertUnquotedPlaceholder } from '../lib/cmd-check.mjs';
import { evaluateDod } from '../lib/dod.mjs';
import { loadProfile } from '../lib/profile.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OK = 'node -e "process.exit(0)"';
const say = (line, code) => `node -e "console.log('${line}'); process.exit(${code})"`;

function fixture(commands, over = {}) {
  return mkFixture({ featureJson: sampleFeatureJson({ profile: { commands }, ...over }) });
}
const cli = (fx, args) => runCli(['check', ...args, '--feature', DEFAULT_FEATURE], { cwd: fx.root });
const readFj = (fx) => JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8'));

/** Fake runStep: records commands, answers from `answers[step-cmd]` or PASSED. */
function fakeRunner(answers = {}) {
  const calls = [];
  const runStep = async ({ cmd, logPath }) => {
    calls.push({ cmd, logPath });
    const a = answers[cmd] ?? {};
    return { status: a.status ?? 'PASSED', exitCode: a.exitCode ?? 0, timedOut: false, duration_s: 0, output: a.output ?? '' };
  };
  return { runStep, calls };
}

test('AC1: feature profile commands win over detection; failing step prints FAIL + tail', () => {
  const fx = fixture({ lint: OK, typecheck: say('src/a.ts: bad', 1) });
  fx.write('package.json', JSON.stringify({ scripts: { lint: 'exit 9' } })); // detection would differ
  try {
    const r = cli(fx, ['--scope', 'tree-wide', '--steps', 'lint,typecheck']);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^FAIL typecheck \(exit 1\): node -e/);
    assert.equal(lines[1], 'src/a.ts: bad');
    assert.ok(!r.stdout.includes('lint'), r.stdout);
    assert.equal(lines.at(-1), 'check: FAILED typecheck');
    // R5: per-step logs under <feature>/checks/
    assert.ok(fs.existsSync(path.join(fx.featureDir, 'checks', 'lint.log')));
    assert.match(fs.readFileSync(path.join(fx.featureDir, 'checks', 'typecheck.log'), 'utf8'), /src\/a\.ts: bad/);
  } finally { fx.cleanup(); }
});

test('AC2: all steps passing prints only the PASSED line; --json passed:true', () => {
  const fx = fixture({ lint: OK, typecheck: OK });
  try {
    const r = cli(fx, ['--steps', 'lint,typecheck']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'check: PASSED (2 steps)\n');
    const j = cli(fx, ['--steps', 'lint,typecheck', '--json']);
    assert.equal(j.status, 0);
    const doc = JSON.parse(j.stdout);
    assert.equal(doc.passed, true);
    assert.deepEqual(doc.steps.map((s) => [s.step, s.passed, s.exit, s.timed_out]), [['lint', true, 0, false], ['typecheck', true, 0, false]]);
  } finally { fx.cleanup(); }
});

test('AC4: touched filtering ignores failures outside touched files', () => {
  const fx = fixture({ lint: say('other/file.ts: err', 1) });
  try {
    const r = cli(fx, ['--scope', 'touched', '--files', 'src/a.ts', '--steps', 'lint']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^lint: failures outside touched files \(1 lines\) — ignored for touched scope$/m);
    assert.match(r.stdout, /check: PASSED \(1 steps\)/);
  } finally { fx.cleanup(); }
});

test('AC4: touched failure in a touched file exits 1 and keeps only matching lines', () => {
  const cmd = `node -e "console.log('other/file.ts: x'); console.log('src/a.ts: y'); process.exit(1)"`;
  const fx = fixture({ lint: cmd });
  try {
    const r = cli(fx, ['--scope', 'touched', '--files', 'src/a.ts', '--steps', 'lint', '--json']);
    assert.equal(r.status, 1);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.passed, false);
    assert.equal(doc.steps[0].tail, 'src/a.ts: y');
    // absolute paths match too
    const abs = `node -e "console.log(process.cwd() + '/src/a.ts: z'); process.exit(1)"`;
    const fx2 = fixture({ lint: abs });
    try {
      const r2 = cli(fx2, ['--scope', 'touched', '--files', 'src/a.ts', '--steps', 'lint', '--json']);
      assert.equal(r2.status, 1);
      assert.ok(JSON.parse(r2.stdout).steps[0].tail.endsWith('/src/a.ts: z'));
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

test('AC5: {files} is replaced by shell-quoted files, `.` on tree-wide; newline exits 2', () => {
  const fx = fixture({ lint: 'echo {files}' });
  try {
    const t = cli(fx, ['--scope', 'touched', '--files', 'a b.ts,c.ts', '--steps', 'lint', '--json']);
    assert.equal(t.status, 0, t.stderr);
    assert.equal(JSON.parse(t.stdout).steps[0].cmd, "echo 'a b.ts' 'c.ts'");
    // review F4: touched scope never writes feature-folder logs
    assert.ok(!fs.existsSync(path.join(fx.featureDir, 'checks', 'lint.log')));

    const w = cli(fx, ['--steps', 'lint', '--json']);
    assert.equal(w.status, 0);
    assert.equal(JSON.parse(w.stdout).steps[0].cmd, 'echo .');

    assert.equal(cli(fx, ['--scope', 'touched', '--files', 'a\nb.ts', '--steps', 'lint']).status, 2);
    assert.equal(cli(fx, ['--scope', 'touched', '--files', 'a\0b.ts', '--steps', 'lint']).status, 2);
  } catch (err) {
    // spawnSync refuses NUL in argv on some platforms; the unit check below covers it
    if (err?.code !== 'ERR_INVALID_ARG_VALUE') throw err;
  } finally { fx.cleanup(); }
  assert.throws(() => normalizeFiles(['a\0b'], '/r'), { exitCode: 2 });
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('R10: files outside the repo root are rejected with exit 2', () => {
  const fx = fixture({ lint: 'echo {files}' });
  try {
    assert.equal(cli(fx, ['--scope', 'touched', '--files', '../x.ts', '--steps', 'lint']).status, 2);
    assert.equal(cli(fx, ['--scope', 'touched', '--files', '/etc/passwd', '--steps', 'lint']).status, 2);
    assert.equal(cli(fx, ['--scope', 'touched', '--steps', 'lint']).status, 2); // --files required
  } finally { fx.cleanup(); }
});

test('AC6: --record appends a cli static-check entry excluded from totals; dod accepts it', () => {
  const history = [
    { ts: 't', phase: 'implement', subagent: 'backend-dev', status: 'DONE', model: 'sonnet', duration_s: 10, tokens_k: 2 },
    { ts: 't', phase: 'review', subagent: 'code-reviewer', status: 'APPROVED', model: 'opus', duration_s: 5, tokens_k: 1 },
  ];
  const fx = fixture({ lint: OK }, { track: 'quick', auto_tests: false, history });
  try {
    // seed totals through a CLI write, then compare after --record
    const before = readFj(fx).totals;
    const r = cli(fx, ['--steps', 'lint', '--record']);
    assert.equal(r.status, 0, r.stderr);
    const fj = readFj(fx);
    const e = fj.history.at(-1);
    assert.equal(e.phase, 'static-check');
    assert.equal(e.subagent, 'cli');
    assert.equal(e.executor, 'cli');
    assert.equal(e.status, 'PASSED');
    assert.equal(typeof e.duration_s, 'number');
    assert.match(e.summary, /PASSED/);
    assert.ok(!('cli' in fj.totals.by_subagent));
    const calls = (t) => Object.values(t?.by_subagent ?? {}).reduce((n, s) => n + s.calls, 0);
    assert.equal(calls(fj.totals), 2);
    if (before?.by_subagent && Object.keys(before.by_subagent).length) assert.equal(calls(before), 2);
    assert.equal(evaluateDod(fx.featureDir).passed, true);

    const fx2 = fixture({ lint: say('x', 1) });
    try {
      assert.equal(cli(fx2, ['--steps', 'lint', '--record']).status, 1);
      assert.equal(readFj(fx2).history.at(-1).status, 'FAILED');
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

test('AC7: FAILED tree-wide run writes static-check-report.md naming steps and commands', () => {
  const fail = say('src/a.ts: bad', 2);
  const fx = fixture({ lint: fail, typecheck: OK, format: say('fmt', 1) });
  try {
    const r = cli(fx, ['--steps', 'lint,typecheck,format']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /check: FAILED lint, format$/m);
    const report = fs.readFileSync(path.join(fx.featureDir, 'static-check-report.md'), 'utf8');
    assert.match(report, /^## lint$/m);
    assert.match(report, /^## format$/m);
    assert.ok(!/^## typecheck$/m.test(report));
    assert.ok(report.includes(fail));
    assert.ok(report.includes('src/a.ts: bad'));
  } finally { fx.cleanup(); }
  // touched scope never writes the report
  const fx2 = fixture({ lint: say('src/a.ts: bad', 1) });
  try {
    assert.equal(cli(fx2, ['--scope', 'touched', '--files', 'src/a.ts', '--steps', 'lint']).status, 1);
    assert.ok(!fs.existsSync(path.join(fx2.featureDir, 'static-check-report.md')));
  } finally { fx2.cleanup(); }
});

test('AC8: tree-wide default steps include test only when auto_tests === false', async () => {
  const commands = { lint: 'L', typecheck: 'T', format: 'F', test: 'X' };
  for (const [autoTests, expected] of [[false, ['L', 'T', 'F', 'X']], [true, ['L', 'T', 'F']]]) {
    const fx = fixture(commands, { auto_tests: autoTests });
    try {
      const { runStep, calls } = fakeRunner();
      const ctx = mkCtx({ cwd: fx.root });
      const code = await run(['--feature', DEFAULT_FEATURE], ctx, { runStep, detect: () => ({}) });
      assert.equal(code, 0, ctx.err());
      assert.deepEqual(calls.map((c) => c.cmd), expected);
      assert.equal(ctx.out(), `check: PASSED (${expected.length} steps)\n`);
    } finally { fx.cleanup(); }
  }
  // touched never adds test
  const fx = fixture(commands, { auto_tests: false });
  try {
    const { runStep, calls } = fakeRunner();
    await run(['--scope', 'touched', '--files', 'a.ts', '--feature', DEFAULT_FEATURE], mkCtx({ cwd: fx.root }), { runStep });
    assert.deepEqual(calls.map((c) => c.cmd), ['L', 'T', 'F']);
  } finally { fx.cleanup(); }
});

test('R2: resolution order feature snapshot → project profile → detection', () => {
  const got = resolveCommands(['lint', 'typecheck', 'format', 'test'], {
    featureCommands: { lint: 'feat-lint' },
    projectCommands: { lint: 'proj-lint', typecheck: 'proj-tc' },
    detect: () => ({ typecheck: 'det-tc', format: 'det-fmt' }),
  });
  assert.deepEqual(got.map((r) => [r.step, r.cmd, r.source]), [
    ['lint', 'feat-lint', 'feature'], ['typecheck', 'proj-tc', 'project'], ['format', 'det-fmt', 'detect'],
  ]);
});

test('R2: project profile used without feature commands; detection as fallback', async () => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ commands: { lint: 'PL' } }));
  fx.write('tsconfig.json', '{}');
  fx.write('package.json', '{}');
  try {
    const { runStep, calls } = fakeRunner();
    const code = await run(['--steps', 'lint,typecheck', '--feature', DEFAULT_FEATURE], mkCtx({ cwd: fx.root }), { runStep });
    assert.equal(code, 0);
    assert.deepEqual(calls.map((c) => c.cmd), ['PL', 'npx --no-install tsc --noEmit']);
  } finally { fx.cleanup(); }
});

test('R4: no command for any step → message and exit 2', () => {
  const fx = mkFixture();
  try {
    const r = cli(fx, ['--scope', 'tree-wide']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /check: no check commands found \(scope tree-wide\)/);
  } finally { fx.cleanup(); }
});

test('R1: usage errors exit 2', () => {
  const fx = fixture({ lint: OK });
  try {
    assert.equal(cli(fx, ['--scope', 'all']).status, 2);
    assert.equal(cli(fx, ['--steps', 'lint,nope']).status, 2);
    assert.equal(cli(fx, ['--tail', '-1']).status, 2);
    assert.equal(cli(fx, ['--timeout', '0']).status, 2);
  } finally { fx.cleanup(); }
});

test('R1: --files is repeatable and comma-split; --tail bounds the printed tail', async () => {
  const fx = fixture({ lint: 'echo {files}', typecheck: 'many' });
  try {
    const out = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { runStep, calls } = fakeRunner({ many: { status: 'FAILED', exitCode: 1, output: out } });
    const ctx = mkCtx({ cwd: fx.root });
    const code = await run(['--scope', 'touched', '--files', 'a.ts,b.ts', '--files', 'c.ts', '--steps', 'lint',
      '--feature', DEFAULT_FEATURE], ctx, { runStep });
    assert.equal(code, 0);
    assert.equal(calls[0].cmd, "echo 'a.ts' 'b.ts' 'c.ts'");

    const ctx2 = mkCtx({ cwd: fx.root });
    assert.equal(await run(['--steps', 'typecheck', '--tail', '3', '--feature', DEFAULT_FEATURE], ctx2, { runStep }), 1);
    assert.equal(ctx2.out(), 'FAIL typecheck (exit 1): many\nline 7\nline 8\nline 9\ncheck: FAILED typecheck\n');
  } finally { fx.cleanup(); }
});

test('R3: gofmt -l with non-empty output counts as failure', async () => {
  const fx = fixture({ format: 'gofmt -l .' });
  try {
    const { runStep } = fakeRunner({ 'gofmt -l .': { output: 'main.go\n' } });
    const ctx = mkCtx({ cwd: fx.root });
    assert.equal(await run(['--steps', 'format', '--feature', DEFAULT_FEATURE], ctx, { runStep }), 1);
    assert.match(ctx.out(), /FAIL format \(exit 0\): gofmt -l \.\nmain\.go\ncheck: FAILED format/);
  } finally { fx.cleanup(); }
});

test('R5: without a feature folder logs go to a temp dir; --record needs a feature', async () => {
  const fx = mkFixture({ featureJson: null });
  fs.rmSync(fx.featuresDir, { recursive: true });
  fx.write('.dev-cycle/project.json', JSON.stringify({ commands: { lint: 'L' } }));
  try {
    const { runStep, calls } = fakeRunner();
    assert.equal(await run(['--steps', 'lint'], mkCtx({ cwd: fx.root }), { runStep }), 0);
    assert.ok(calls[0].logPath.startsWith(os.tmpdir()), calls[0].logPath);
    await assert.rejects(run(['--steps', 'lint', '--record'], mkCtx({ cwd: fx.root }), { runStep }), { exitCode: 2 });
  } finally { fx.cleanup(); }
});

test('AC45: repo .dev-cycle/project.json has only commands and resolves the three R44 commands', async () => {
  const file = path.join(REPO_ROOT, '.dev-cycle', 'project.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(profile), ['commands']);
  const expected = {
    lint: 'bash scripts/lint-skills.sh',
    typecheck: 'cd dashboard && npx tsc --noEmit',
    test: 'node --test --test-reporter=dot scripts/test/',
  };
  assert.deepEqual(profile.commands, expected);

  const ctx = mkCtx({ cwd: REPO_ROOT });
  assert.deepEqual(loadProfile(ctx).profile.commands, expected); // validates (throws on errors)
  const v = runCli(['profile', 'validate'], { cwd: REPO_ROOT });
  assert.equal(v.status, 0, v.stderr);

  // resolution only (a live feature snapshot in this repo would otherwise win)
  const resolved = resolveCommands(['lint', 'typecheck', 'test'], { projectCommands: expected, detect: () => ({}) });
  assert.deepEqual(resolved.map((c) => c.cmd), [expected.lint, expected.typecheck, expected.test]);
});

test('review F4: parallel touched runs use no shared log; tree-wide still logs', async () => {
  const fx = fixture({ lint: OK });
  try {
    const { runStep, calls } = fakeRunner();
    const ctx = { cwd: fx.root, env: {}, stdout: { write() {} }, stderr: { write() {} } };
    await Promise.all([
      run(['--scope', 'touched', '--files', 'a.ts', '--steps', 'lint', '--feature', DEFAULT_FEATURE], ctx, { runStep }),
      run(['--scope', 'touched', '--files', 'b.ts', '--steps', 'lint', '--feature', DEFAULT_FEATURE], ctx, { runStep }),
    ]);
    assert.deepEqual(calls.map((c) => c.logPath), [undefined, undefined]);
    await run(['--steps', 'lint', '--feature', DEFAULT_FEATURE], ctx, { runStep });
    assert.equal(calls[2].logPath, path.join(fx.featureDir, 'checks', 'lint.log'));
  } finally { fx.cleanup(); }
});

test('review F5: passing tree-wide run removes a stale static-check-report.md', () => {
  const fx = fixture({ lint: say('src/a.ts: bad', 1) });
  try {
    assert.equal(cli(fx, ['--steps', 'lint']).status, 1);
    const report = path.join(fx.featureDir, 'static-check-report.md');
    assert.ok(fs.existsSync(report));
    // touched pass leaves it alone; tree-wide pass removes it
    const p = path.join(fx.featureDir, 'feature.json');
    const fj = JSON.parse(fs.readFileSync(p, 'utf8'));
    fj.profile.commands.lint = OK;
    fs.writeFileSync(p, JSON.stringify(fj));
    assert.equal(cli(fx, ['--scope', 'touched', '--files', 'src/a.ts', '--steps', 'lint']).status, 0);
    assert.ok(fs.existsSync(report));
    assert.equal(cli(fx, ['--steps', 'lint', '--record']).status, 0);
    assert.ok(!fs.existsSync(report));
  } finally { fx.cleanup(); }
});

test('review F6: check --help documents the tree-wide test step rule', () => {
  const fx = fixture({ lint: OK });
  try {
    const r = cli(fx, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /auto_tests is false/);
    assert.match(r.stdout, /--steps lint,typecheck,test/);
  } finally { fx.cleanup(); }
});

test('security S1: a quoted {files} placeholder is rejected with exit 2', () => {
  for (const bad of ['eslint "{files}"', "eslint '{files}'", 'eslint `{files}`']) {
    assert.throws(() => assertUnquotedPlaceholder(bad, 'lint'), { exitCode: 2 });
    assert.throws(() => substituteFiles(bad, 'touched', ['a.ts']), { exitCode: 2 });
  }
  assert.doesNotThrow(() => assertUnquotedPlaceholder('eslint {files}'));
  const fx = fixture({ lint: 'echo "{files}"' });
  try {
    const r = cli(fx, ['--scope', 'touched', '--files', 'a.ts', '--steps', 'lint']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\{files\} placeholder must not be quoted/);
  } finally { fx.cleanup(); }
});

test('security S2: touched paths starting with - are prefixed with ./', () => {
  const root = '/r';
  assert.deepEqual(normalizeFiles(['--plugin=x.mjs,src/-a.ts,b.ts'], root), [`.${path.sep}--plugin=x.mjs`, 'src/-a.ts', 'b.ts']);
  assert.equal(substituteFiles('prettier --check {files}', 'touched', normalizeFiles(['-x.ts'], root)), "prettier --check './-x.ts'");
});

const tapFixture = (extra = []) => `node -e "for(let i=1;i<=50;i++)console.log('ok '+i+' - t'+i);${extra.join('')}process.exit(1)"`;

test('AC9: failing test step prints only the not ok block, none of the 50 ok lines; log keeps all', () => {
  const fail = "console.log('not ok 51 - broken in a.mjs');console.log('  ---');console.log('  error: boom');console.log('  ...');";
  const fx = fixture({ test: tapFixture([fail]) });
  try {
    const r = cli(fx, ['--steps', 'test']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /not ok 51 - broken in a\.mjs/);
    assert.match(r.stdout, /error: boom/);
    assert.match(r.stdout, /check: FAILED test \(1 failing; log: .+\)/);
    assert.ok(!/^ok \d+/m.test(r.stdout), r.stdout);
    const log = fs.readFileSync(path.join(fx.featureDir, 'checks', 'test.log'), 'utf8');
    assert.equal((log.match(/^ok \d+/gm) ?? []).length, 50);
    assert.match(log, /not ok 51/);
  } finally { fx.cleanup(); }
});

test('AC10: touched scope splits failures into touched / elsewhere and exits 1', () => {
  const blk = (n, f) => `console.log('not ok ${n} - fails in ${f}');console.log('  ---');console.log('  location: ${f}:1:1');console.log('  ...');`;
  const both = fixture({ test: tapFixture([blk(1, 'a.mjs'), blk(2, 'b.mjs')]) });
  const onlyB = fixture({ test: tapFixture([blk(1, 'b.mjs')]) });
  const none = fixture({ test: 'node -e "console.log(\'weird output\');process.exit(3)"' });
  try {
    let r = cli(both, ['--scope', 'touched', '--files', 'a.mjs', '--steps', 'test']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /failures in touched files \(1\)/);
    assert.match(r.stdout, /failures elsewhere — possibly in-flight sibling edits \(1\)/);
    r = cli(onlyB, ['--scope', 'touched', '--files', 'a.mjs', '--steps', 'test']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /failures in touched files \(0\)/);
    assert.match(r.stdout, /failures elsewhere — possibly in-flight sibling edits \(1\)/);
    assert.ok(!r.stdout.includes('check: PASSED'));
    r = cli(none, ['--scope', 'touched', '--files', 'a.mjs', '--steps', 'test']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /weird output/);
    assert.match(r.stdout, /check: FAILED test/);
  } finally { both.cleanup(); onlyB.cleanup(); none.cleanup(); }
});
