// recipe run|list (spec R25, AC27, AC28) + pure helpers in lib/recipe.mjs and
// the no-shell cmd grammar in lib/recipe-safety.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { buildArgv, parseParamArgs, validateParams } from '../plugin/scripts/lib/recipe.mjs';
import {
  cmdProblems, hasNestedQuantifier, parseRecipeCmd, patternProblem,
} from '../plugin/scripts/lib/recipe-safety.mjs';
import { formatArgv, runStep } from '../plugin/scripts/lib/runner.mjs';

// Helper programs written into every fixture (recipes cannot use node -e).
const SCRIPTS = {
  'scripts/tts.mjs': `const a = process.argv.slice(2);
const get = (f) => a[a.indexOf(f) + 1];
console.log(get('--only') + '|' + get('--max-requests'));
`,
  'argv.mjs': 'console.log(JSON.stringify(process.argv.slice(2)));\n',
  'fail.mjs': 'process.exit(3);\n',
  'marker.mjs': "import fs from 'node:fs'; fs.writeFileSync('RAN', 'x');\n",
  'slow.mjs': 'setTimeout(() => {}, 10000);\n',
};

const TTS = {
  name: 'tts',
  cmd: 'node scripts/tts.mjs --only {keys} --max-requests {max}',
  params: {
    keys: { required: true, pattern: '[A-Za-z0-9_.,-]+' },
    max: { required: true, type: 'int', min: 1, max: 50 },
  },
  guards: ['Never regenerate approved clips'],
  timeout_s: 60,
};
const ECHO = { name: 'echo', cmd: 'node argv.mjs {v}', params: { v: {} } };
const FAIL = { name: 'fail', cmd: 'node fail.mjs' };
const MARKER = { name: 'marker', cmd: 'node marker.mjs {n}', params: { n: { required: true, type: 'int', max: 5 } } };

function fixture(t, recipes = [TTS, ECHO, FAIL, MARKER]) {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { recipes } }) });
  t.after(() => fx.cleanup());
  for (const [rel, text] of Object.entries(SCRIPTS)) fx.write(rel, text);
  return fx;
}
const argvLine = (stdout) => JSON.parse(stdout.split('\n').find((l) => l.startsWith('[')));
const pwned = (fx) => ['PWNED', 'PWNED2', 'PWNED3'].filter((f) => fs.existsSync(path.join(fx.root, f)));

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('parseParamArgs rejects a repeated key and a missing =', () => {
  assert.match(parseParamArgs(['a=1', 'a=2']).error, /more than once/);
  assert.match(parseParamArgs(['a']).error, /k=v/);
  assert.match(parseParamArgs(['=x']).error, /k=v/);
  assert.equal(parseParamArgs(['a=b=c']).params.get('a'), 'b=c');
});

test('validateParams: anchored pattern, int bounds, absent optional → empty', () => {
  const spec = { k: { pattern: 'ab|cd' }, n: { type: 'int', min: 2, max: 4 }, o: {} };
  assert.deepEqual(validateParams(spec, new Map([['k', 'ab'], ['n', '3']])), { errors: [], values: { k: 'ab', n: '3', o: '' } });
  // the alternation must be anchored as a whole: 'abX' and 'Xcd' fail
  assert.equal(validateParams(spec, new Map([['k', 'abX']])).errors.length, 1);
  assert.equal(validateParams(spec, new Map([['k', 'Xcd']])).errors.length, 1);
  assert.equal(validateParams(spec, new Map([['n', '1']])).errors.length, 1);
  assert.equal(validateParams(spec, new Map([['n', '5']])).errors.length, 1);
  assert.equal(validateParams(spec, new Map([['n', '3.0']])).errors.length, 1);
  assert.equal(validateParams(spec, new Map([['zz', '1']])).errors.length, 1);
  assert.match(validateParams({ k: {} }, new Map([['k', 'a\0b']])).errors[0], /NUL/);
});

test('buildArgv: literal words, whole-word and --flag= placeholders, values verbatim', () => {
  const evil = `x'y $(touch PWNED) "z"\n;|&`;
  assert.deepEqual(buildArgv('run {a} --out={b} lit', { a: evil, b: '' }), ['run', evil, '--out=', 'lit']);
  assert.deepEqual(buildArgv('node  scripts/tts.mjs\t--only {k}', { k: 'a,b' }), ['node', 'scripts/tts.mjs', '--only', 'a,b']);
  assert.throws(() => buildArgv('run {zz}', {}), /not declared/);
  assert.throws(() => buildArgv('run "{a}"', { a: 'x' }), /invalid recipe cmd/);
  assert.throws(() => buildArgv('run x{a}', { a: 'x' }), /glued/);
});

test('parseRecipeCmd: word shapes', () => {
  assert.deepEqual(parseRecipeCmd('node s.mjs {a} --k={b}'), {
    words: [{ lit: 'node' }, { lit: 's.mjs' }, { ph: 'a', prefix: '' }, { ph: 'b', prefix: '--k=' }],
    problems: [],
  });
  assert.deepEqual(cmdProblems(''), ['cmd must be a non-empty string']);
  assert.deepEqual(cmdProblems(5), ['cmd must be a non-empty string']);
});

test('formatArgv shows plain words as-is and JSON-quotes the rest', () => {
  assert.equal(formatArgv(['node', 'a.mjs', '--k=v', 'a b', '$(x)', '']), 'node a.mjs --k=v "a b" "$(x)" ""');
});

// ---------------------------------------------------------------------------
// the grammar: accepted cmds
// ---------------------------------------------------------------------------

const GOOD_CMDS = [
  TTS.cmd,
  'node scripts/tts.mjs --only {keys} --max-requests {n}',
  'node argv.mjs {v}',
  './scripts/gen.sh {v}',
  'run --out={v}',
  'npm run build', // no placeholder: npm/pnpm/yarn are fine without values
  'npm run test',
  'node --max-old-space-size=4096 a.mjs {v}',
  'python3 tool.py x {v}',
  'echo {v}',
  'git log --format=%H -n {v}',
  'node -e x', // eval flag without placeholders is not a value sink
  'cmd-with.dots_and-dashes/sub {v}',
  // review cycle 2 (F8-F10): real recipes must not be over-blocked
  'uv run scripts/gen.py {v}',
  'uvx run tools/gen.py {v}',
  'deno run --allow-read scripts/x.ts {v}',
  'bun run scripts/x.ts {v}',
  'npx tsx scripts/x.ts {v}',
  'git add . {v}',
  'rg -n TODO . {v}',
  'python3 tools/gen.py -p {v}',
  'python3 tools/gen.py --print {v}',
  'node scripts/x.mjs -C dir {v}',
  'node scripts/x.mjs --mode find {v}',
  'node scripts/x.mjs --shell bash {v}',
];

test('grammar: valid cmds have no problems', () => {
  for (const cmd of GOOD_CMDS) assert.deepEqual(cmdProblems(cmd), [], cmd);
});

// ---------------------------------------------------------------------------
// the grammar: every bypass of the old shell denylist is rejected
// ---------------------------------------------------------------------------

const BAD_CMDS = {
  // quoted / escaped command words
  'quoted command word': '"e"val {v}',
  'single-quoted command word': "'e'val {v}",
  'escaped command word': 'e\\val {v}',
  // shells, also with split option clusters
  'bash -x -c': 'bash -x -c {v}',
  'sh -e -c': 'sh -e -c {v}',
  '/bin/sh -c': '/bin/sh -c {v}',
  'bash script': 'bash scripts/gen.sh {v}',
  zsh: 'zsh -c {v}',
  'busybox sh': 'busybox sh -c {v}',
  // prefix commands that make the value a command
  time: 'time {v}',
  command: 'command {v}',
  env: 'env {v}',
  '/usr/bin/env node': '/usr/bin/env node a.mjs {v}',
  exec: 'exec {v}',
  eval: 'eval {v}',
  nohup: 'nohup {v}',
  nice: 'nice {v}',
  timeout: 'timeout 5 {v}',
  watch: 'watch {v}',
  sudo: 'sudo {v}',
  doas: 'doas {v}',
  xargs: 'xargs {v}',
  'find -exec': 'find . -exec {v} +',
  find: 'find . -name {v}',
  // wrappers that forward their args to a shell or interpreter (review F1)
  'caffeinate sh -c': 'caffeinate -i sh -c {v}',
  'xcrun sh -c': 'xcrun sh -c {v}',
  'arch bash -c': 'arch -arm64 bash -c {v}',
  'sandbox-exec sh -c': 'sandbox-exec -n no-network sh -c {v}',
  'taskpolicy sh -c': 'taskpolicy -b sh -c {v}',
  'caffeinate node -e': 'caffeinate node -e {v}',
  'wrapper env': 'caffeinate env {v}',
  // shell name variants (review F2)
  rbash: 'rbash -c {v}',
  bash5: 'bash5 -c {v}',
  'zsh-5.9': 'zsh-5.9 -c {v}',
  rzsh: 'rzsh -c {v}',
  yash: 'yash -c {v}',
  'BASH upper case': '/bin/BASH -c {v}',
  // more evaluators (review F3)
  'expect -c': 'expect -c {v}',
  'tclsh script position': 'tclsh {v}',
  'swift -e': 'swift -e x {v}',
  'dc -e': 'dc -e x {v}',
  'osascript -e': 'osascript -e x {v}',
  'pwsh -Command': 'pwsh -Command x {v}',
  // runners that run a value-chosen file, program or package (review F4)
  'uv run': 'uv run {v}',
  'pipx run': 'pipx run {v}',
  'bun run': 'bun run {v}',
  'deno run': 'deno run {v}',
  'npm install': 'npm install {v}',
  'pip install': 'pip3 install {v}',
  'uv run non-path script': 'uv run gen {v}',
  'uv run --with value': 'uv run --with {v} scripts/gen.py',
  'deno run no script': 'deno run -A {v}',
  'python -m pip install': 'python3 -m pip install {v}',
  'uv pip install': 'uv pip install {v}',
  'uv tool run': 'uv tool run ruff {v}',
  'deno task': 'deno task build {v}',
  'npx tsx script slot': 'npx tsx {v}',
  'npx sh': 'npx sh -c {v}',
  'source as argv0': '. {v}',
  'wrapper xcrun python3 -c': 'xcrun python3 -c x {v}',
  'nested wrappers': 'caffeinate xcrun zsh -c {v}',
  // package-manager script args go through a shell (review F5)
  'npm run --': 'npm run build -- {v}',
  'yarn script': 'yarn build {v}',
  'pnpm script': 'pnpm run build {v}',
  // non-ASCII / Unicode whitespace and format chars (review F7)
  NBSP: 'node\u00a0-e x {v}',
  'zero-width space': 'node a.mjs\u200b {v}',
  'line separator': 'node a.mjs\u2028{v}',
  'non-ASCII word': 'node scripts/tts\u00e9.mjs {v}',
  // evaluators the old denylist missed; macOS ships several builtins as
  // /bin/sh wrappers (/usr/bin/read: `read 'a[$(touch X)]'` ran touch)
  'printf -v': 'printf -v {v}',
  read: 'read {v}',
  'READ (case-insensitive filesystem)': 'READ {v}',
  '/usr/bin/read': '/usr/bin/read {v}',
  export: 'export {v}',
  local: 'local {v}',
  mapfile: 'mapfile {v}',
  'test -v': 'test -v {v}',
  fc: 'fc -e {v}',
  getopts: 'getopts {v} x',
  // interpreters evaluating code
  'node -e': 'node -e x {v}',
  'node --eval=': 'node --eval={v}',
  'node -p': 'node -p x {v}',
  'node -r': 'node -r {v} a.mjs',
  'node --import flag': 'node --import {v} a.mjs',
  'node script position': 'node {v}',
  'python3 -c': 'python3 -c x {v}',
  'python3.11 -c': '/usr/bin/python3.11 -c x {v}',
  'python -m': 'python -m {v}',
  'perl -pe': 'perl -pe x {v}',
  'ruby -e': 'ruby -e x {v}',
  'php -r': 'php -r x {v}',
  'deno eval': 'deno eval {v}',
  'bun -e': 'bun -e x {v}',
  'npx value': 'npx {v}',
  'npm exec': 'npm exec {v}',
  'sed -e': 'sed -e x {v}',
  'awk program': 'awk {v}',
  // placeholder shapes
  'command position': '{v} --flag',
  'flag placeholder as program': '--x={v}',
  'glued prefix': 'echo x{v}',
  'glued suffix': 'echo {v}x',
  'two glued': 'echo {v}{w}',
  'short flag glued': 'echo -f{v}',
  'flag value with suffix': 'echo --a={v}x',
  'single-dash flag=': 'echo -a={v}',
  'env assignment': 'FOO=1 node a.mjs {v}',
  'option as program': '-x {v}',
  // shell syntax anywhere
  semicolon: 'echo hi; {v}',
  pipe: 'echo {v} | sh',
  and: 'echo {v} && echo y',
  'command substitution': 'echo $({v})',
  'parameter expansion': 'echo ${v}',
  heredoc: 'cat <<EOF\n{v}\nEOF',
  newline: 'echo a\necho {v}',
  'carriage return': 'echo a\recho {v}',
  comment: 'echo hi # {v}',
  backtick: 'echo `{v}`',
  'double quoted': 'echo "{v}"',
  'single quoted': "echo '{v}'",
  redirect: 'echo {v} > out',
  'input redirect': 'echo {v} < in',
  tilde: 'echo ~ {v}',
  glob: 'echo * {v}',
  question: 'echo a? {v}',
  brackets: 'echo [ab] {v}',
  subshell: '(echo {v})',
  'stray brace': 'echo {} {v}',
  'invalid placeholder name': 'echo {a b} {v}',
};

test('grammar: every bypass shape is rejected', () => {
  for (const [label, cmd] of Object.entries(BAD_CMDS)) {
    assert.notDeepEqual(cmdProblems(cmd), [], label);
    assert.throws(() => buildArgv(cmd, { v: 'x', w: 'y' }), /invalid recipe cmd|not declared/, label);
  }
});

const PAYLOADS = [
  '$(touch PWNED)',
  '`touch PWNED`',
  ';touch PWNED',
  "'; touch PWNED; '",
  '\ntouch PWNED\n',
  'a[$(touch PWNED)]',
];

test('recipe run and profile validate reject every bypass cmd with $(touch X) payloads; nothing runs', (t) => {
  for (const [label, cmd] of Object.entries(BAD_CMDS)) {
    const params = { v: {}, w: {} };
    const fx = fixture(t, [{ name: 'bad', cmd, params }]);
    for (const v of [PAYLOADS[0], PAYLOADS[1], PAYLOADS[5]]) {
      const r = runCli(['recipe', 'run', 'bad', '--param', `v=${v}`], { cwd: fx.root });
      assert.equal(r.status, 2, `${label} ${JSON.stringify(v)}: ${r.stderr}`);
      assert.match(r.stderr, /invalid recipes in feature\.json profile/, label);
      assert.deepEqual(pwned(fx), [], `${label} ${JSON.stringify(v)} executed`);
    }
    fx.write('.dev-cycle/project.json', JSON.stringify({ recipes: [{ name: 'bad', cmd, params }] }));
    const pv = runCli(['profile', 'validate'], { cwd: fx.root });
    assert.equal(pv.status, 2, `${label}: profile validate`);
    assert.match(pv.stderr + pv.stdout, /recipes\[0\]\.cmd .*without a shell/, label);
  }
});

// ---------------------------------------------------------------------------
// AC27
// ---------------------------------------------------------------------------

test('AC27: recipe run tts prints a,b|10 and exits 0', (t) => {
  const fx = fixture(t);
  const r = runCli(['recipe', 'run', 'tts', '--param', 'keys=a,b', '--param', 'max=10'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\$ node scripts\/tts\.mjs --only a,b --max-requests 10$/m);
  assert.match(r.stdout, /^a,b\|10$/m);
  assert.match(r.stdout, /recipe tts: PASSED/);
});

test('AC27: every invalid invocation exits 2 and executes nothing', (t) => {
  const fx = fixture(t);
  const cases = [
    ['marker'], // missing required n
    ['marker', '--param', 'n=6'],
    ['marker', '--param', 'n=x'],
    ['marker', '--param', 'n=1', '--param', 'foo=1'],
    ['marker', '--param', 'n=1', '--param', 'n=2'],
    ['nope', '--param', 'n=1'],
  ];
  for (const c of cases) {
    const r = runCli(['recipe', 'run', ...c], { cwd: fx.root });
    assert.equal(r.status, 2, `${c.join(' ')}: ${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '');
    assert.equal(fs.existsSync(path.join(fx.root, 'RAN')), false, `${c.join(' ')} ran the command`);
  }
  // sanity: the valid call does run it
  const ok = runCli(['recipe', 'run', 'marker', '--param', 'n=1'], { cwd: fx.root });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.existsSync(path.join(fx.root, 'RAN')), true);
});

test('AC27: the tts exit-2 cases (no keys, max=51, max=x, pattern mismatch, unknown param, unknown recipe)', (t) => {
  const fx = fixture(t);
  const cases = [
    [['tts', '--param', 'max=10'], /missing required param 'keys'/],
    [['tts', '--param', 'keys=a', '--param', 'max=51'], /<= 50/],
    [['tts', '--param', 'keys=a', '--param', 'max=x'], /must be an integer/],
    [['tts', '--param', 'keys=a;rm -rf /', '--param', 'max=1'], /does not match pattern/],
    [['tts', '--param', 'keys=a', '--param', 'max=1', '--param', 'foo=1'], /unknown param 'foo'/],
    [['tts2', '--param', 'keys=a'], /unknown recipe 'tts2'/],
  ];
  for (const [args, re] of cases) {
    const r = runCli(['recipe', 'run', ...args], { cwd: fx.root });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(r.stdout, '', `${args.join(' ')} printed output`);
  }
  assert.equal(fs.existsSync(path.join(fx.featureDir, 'content')), false);
});

// ---------------------------------------------------------------------------
// AC28
// ---------------------------------------------------------------------------

test('AC28: shell-injection values arrive as one literal argv element and create no file', (t) => {
  const fx = fixture(t);
  const values = [
    `$(touch PWNED); x \`touch PWNED2\` '"; touch PWNED3`,
    ...PAYLOADS,
    'a | touch PWNED',
    'a && touch PWNED',
    '> PWNED',
    '* ~ ? [x] #',
  ];
  for (const v of values) {
    const r = runCli(['recipe', 'run', 'echo', '--param', `v=${v}`], { cwd: fx.root });
    assert.equal(r.status, 0, `${JSON.stringify(v)}: ${r.stderr}`);
    assert.deepEqual(argvLine(r.stdout), [v], JSON.stringify(v));
    assert.deepEqual(pwned(fx), [], JSON.stringify(v));
  }
});

test('AC28: --flag={p} passes the value verbatim inside the flag word', (t) => {
  const fx = fixture(t, [{ name: 'flag', cmd: 'node argv.mjs --out={v} tail', params: { v: {} } }]);
  const v = '$(touch PWNED) b';
  const r = runCli(['recipe', 'run', 'flag', '--param', `v=${v}`], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(argvLine(r.stdout), [`--out=${v}`, 'tail']);
  assert.deepEqual(pwned(fx), []);
});

test('AC28: absent optional param becomes an empty argument', (t) => {
  const fx = fixture(t);
  const r = runCli(['recipe', 'run', 'echo'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(argvLine(r.stdout), ['']);
});

test('AC28: logs to <feature>/content/tts.log and tts-task-3.log', (t) => {
  const fx = fixture(t);
  const a = runCli(['recipe', 'run', 'tts', '--param', 'keys=a', '--param', 'max=1'], { cwd: fx.root });
  assert.equal(a.status, 0, a.stderr);
  const log = fs.readFileSync(path.join(fx.featureDir, 'content', 'tts.log'), 'utf8');
  assert.match(log, /^\$ node scripts\/tts\.mjs --only a --max-requests 1$/m);
  assert.match(log, /a\|1/);
  const b = runCli(['recipe', 'run', 'tts', '--param', 'keys=b', '--param', 'max=2', '--task', '3'], { cwd: fx.root });
  assert.equal(b.status, 0, b.stderr);
  assert.match(fs.readFileSync(path.join(fx.featureDir, 'content', 'tts-task-3.log'), 'utf8'), /b\|2/);
});

test('AC28: a failing command exits 1 with "recipe <name>: FAILED"', (t) => {
  const fx = fixture(t);
  const r = runCli(['recipe', 'run', 'fail'], { cwd: fx.root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recipe fail: FAILED \(exit 3\)/);
});

test('a missing program exits 1 with FAILED and logs the spawn error', (t) => {
  const fx = fixture(t, [{ name: 'nope', cmd: 'dev-cycle-no-such-program-xyz {v}', params: { v: {} } }]);
  const r = runCli(['recipe', 'run', 'nope', '--param', 'v=1'], { cwd: fx.root });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /recipe nope: FAILED \(exit none\)/);
  assert.match(fs.readFileSync(path.join(fx.featureDir, 'content', 'nope.log'), 'utf8'), /failed to start: .*ENOENT/);
});

test('a timeout exits 1 with FAILED', (t) => {
  const fx = fixture(t, [{ name: 'slow', cmd: 'node slow.mjs' }]);
  const r = runCli(['recipe', 'run', 'slow', '--timeout', '1'], { cwd: fx.root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recipe slow: FAILED \(timed out after 1s\)/);
});

test('--timeout and --task are validated', (t) => {
  const fx = fixture(t);
  for (const extra of [['--timeout', '0'], ['--timeout', '86401'], ['--task', 'x'], ['--task', '0']]) {
    const r = runCli(['recipe', 'run', 'fail', ...extra], { cwd: fx.root });
    assert.equal(r.status, 2, extra.join(' '));
  }
});

test('argv mode: a timeout kills the whole process group, grandchildren included', (t) => {
  const fx = fixture(t, [{ name: 'grand', cmd: 'node grand.mjs {pidfile}', params: { pidfile: {} }, timeout_s: 1 }]);
  fx.write('grand.mjs', `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(gc.pid));
setTimeout(() => {}, 30000);
`);
  const t0 = Date.now();
  const r = runCli(['recipe', 'run', 'grand', '--param', 'pidfile=gc.pid'], { cwd: fx.root });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /recipe grand: FAILED \(timed out after 1s\)/);
  const gc = Number(fs.readFileSync(path.join(fx.root, 'gc.pid'), 'utf8').trim());
  assert.ok(gc > 0);
  // the CLI only returns once the group is verified dead
  assert.throws(() => process.kill(gc, 0), { code: 'ESRCH' });
});

test('runStep argv mode spawns the program with shell: false and the args verbatim', async (t) => {
  const fx = fixture(t);
  const calls = [];
  const fake = (...a) => {
    calls.push(a);
    const child = new EventEmitter();
    child.pid = undefined;
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const res = await runStep({ argv: ['node', 'a.mjs', '$(x) y'], featureDir: fx.featureDir, root: fx.root, spawn: fake });
  assert.equal(res.status, 'PASSED');
  assert.equal(calls.length, 1);
  const [file, args, opts] = calls[0];
  assert.equal(file, 'node');
  assert.deepEqual(args, ['a.mjs', '$(x) y']);
  assert.equal(opts.shell, false);
  assert.equal(opts.detached, true);
  assert.throws(() => runStep({ argv: [], featureDir: fx.featureDir, root: fx.root }), /argv/);
  assert.throws(() => runStep({ argv: ['a\0'], featureDir: fx.featureDir, root: fx.root }), /argv/);
  assert.throws(() => runStep({ argv: ['a'], cmd: 'a', featureDir: fx.featureDir, root: fx.root }), /not both/);
});

// ---------------------------------------------------------------------------
// lookup + list
// ---------------------------------------------------------------------------

test('falls back to .dev-cycle/project.json when no feature resolves', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  fs.rmSync(fx.featuresDir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(SCRIPTS)) fx.write(rel, text);
  fx.write('.dev-cycle/project.json', JSON.stringify({ recipes: [TTS] }));
  const r = runCli(['recipe', 'run', 'tts', '--param', 'keys=z', '--param', 'max=2'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^z\|2$/m);
});

test('the feature snapshot wins over the project profile', (t) => {
  const fx = fixture(t, [ECHO]);
  fx.write('.dev-cycle/project.json', JSON.stringify({ recipes: [TTS] }));
  const r = runCli(['recipe', 'run', 'tts', '--param', 'keys=z', '--param', 'max=2'], { cwd: fx.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown recipe 'tts'/);
});

test('recipe list prints names with params; --json gives data', (t) => {
  const fx = fixture(t);
  const r = runCli(['recipe', 'list'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tts: keys \(string, required, pattern=.*\); max \(int, required, min=1, max=50\)$/m);
  assert.match(r.stdout, /^fail: \(no params\)$/m);
  const j = JSON.parse(runCli(['recipe', 'list', '--json'], { cwd: fx.root }).stdout);
  assert.equal(j.source, 'feature');
  assert.deepEqual(j.recipes.map((x) => x.name), ['tts', 'echo', 'fail', 'marker']);
});

test('unknown subcommand exits 2', (t) => {
  const fx = fixture(t);
  assert.equal(runCli(['recipe', 'frob'], { cwd: fx.root }).status, 2);
  assert.equal(runCli(['recipe', 'run'], { cwd: fx.root }).status, 2);
});

// ---------------------------------------------------------------------------
// param value validation (kept from the shell era)
// ---------------------------------------------------------------------------

test('F2: non-string or unusable pattern errors at run time, never silently skips', () => {
  for (const pattern of [5, true, ['^a$'], null, '', '(', '(a+)+', 'x'.repeat(257)]) {
    const r = validateParams({ k: { pattern } }, new Map([['k', 'zzz;rm']]));
    assert.equal(r.errors.length, 1, JSON.stringify(pattern));
    assert.match(r.errors[0], /unusable pattern/);
  }
});

test('ReDoS: nested quantifiers are detected; values are length-capped before matching', () => {
  for (const p of ['(a+)+', '(a*)*', '(?:a|b+)*', '((ab)*c)+', '(a+){2,}', '(\\w+\\s?)*']) assert.equal(hasNestedQuantifier(p), true, p);
  for (const p of ['[A-Za-z0-9_.,-]+', 'ab|cd', '(ab)+', '(a+)?', '\\(a+\\)+', '[(a+)]+', 'a{1,3}b+']) assert.equal(hasNestedQuantifier(p), false, p);
  assert.match(patternProblem('(a+)+'), /nested quantifier/);
  assert.equal(patternProblem('[a-z]+'), null);
  const long = 'a'.repeat(1025);
  const r = validateParams({ k: { pattern: '[a-z]+' } }, new Map([['k', long]]));
  assert.match(r.errors[0], /max 1024/);
  assert.deepEqual(validateParams({ k: {} }, new Map([['k', 'a'.repeat(1024)]])).errors, []);
});

test('ReDoS: overlapping alternation under a quantifier is rejected; disjoint alternation is fine', () => {
  for (const p of ['(a|aa)+', '(a|a)+', '(?:x|xy)*', '(.|x)+', '(\\w|_)+', '(a|)+', '((a|aa))+', '(?<n>a|aa){2,}']) {
    assert.match(patternProblem(p) ?? '', /overlapping alternatives/, p);
  }
  for (const p of ['(a|b)+', '(?:mp3|wav)', '(foo|bar)+', 'ab|cd', '(x|y){2}', '(a|aa)']) assert.equal(patternProblem(p), null, p);
  assert.match(patternProblem('(a+)+'), /nested quantifier/);
  // rejected before matching: no slow regex ever runs
  const t0 = Date.now();
  const r = validateParams({ k: { pattern: '(a|aa)+' } }, new Map([['k', `${'a'.repeat(40)}!`]]));
  assert.match(r.errors[0], /unusable pattern/);
  assert.ok(Date.now() - t0 < 200);
});

test('values starting with - are rejected unless the param sets allow_dash: true', (t) => {
  assert.match(validateParams({ k: {} }, new Map([['k', '--version']])).errors[0], /allow_dash/);
  assert.match(validateParams({ n: { type: 'int' } }, new Map([['n', '-1']])).errors[0], /allow_dash/);
  assert.deepEqual(validateParams({ k: { allow_dash: true } }, new Map([['k', '--version']])).errors, []);
  const fx = fixture(t, [ECHO, { ...ECHO, name: 'dash', params: { v: { allow_dash: true } } }]);
  const bad = runCli(['recipe', 'run', 'echo', '--param', 'v=--version'], { cwd: fx.root });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must not start with '-'/);
  const ok = runCli(['recipe', 'run', 'dash', '--param', 'v=--version'], { cwd: fx.root });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(argvLine(ok.stdout), ['--version']);
  // after the script word, even an eval-looking dash value is just a script argument
  const ev = `--eval=require('fs').writeFileSync('PWNED','')`;
  const r = runCli(['recipe', 'run', 'dash', '--param', `v=${ev}`], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(argvLine(r.stdout), [ev]);
  assert.deepEqual(pwned(fx), []);
});

test('recipe --help documents the no-shell grammar, allow_dash and limits', () => {
  const r = runCli(['recipe', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WITHOUT a shell/);
  assert.match(r.stdout, /Trust model: the recipe cmd is trusted, owner-authored code/);
  assert.match(r.stdout, /not a sandbox/);
  assert.match(r.stdout, /--flag=\{p\}/);
  assert.match(r.stdout, /allow_dash/);
  assert.match(r.stdout, /1024/);
  assert.match(r.stdout, /node scripts\/tts\.mjs --only \{keys\} --max-requests \{n\}/);
});

test('grammar: env assignment NAME={p} only right after a literal -e / --env, one argv element', async () => {
  const { cmdProblems: probs } = await import('../plugin/scripts/lib/recipe-safety.mjs');
  assert.deepEqual(probs('maestro --device {d} test -e OUT={out} flows/x.yaml'), []);
  assert.deepEqual(probs('docker compose run --env APP_DIR={dir} web'), []);
  assert.deepEqual(buildArgv('maestro test -e OUT={out} f.yaml', { out: '/a b/$(x);c' }), ['maestro', 'test', '-e', 'OUT=/a b/$(x);c', 'f.yaml']);
  for (const bad of ['maestro test OUT={out} f.yaml', 'maestro test -e out={out} f.yaml', 'maestro test -x OUT={out}',
    'node -e X={p}', 'xcrun node -e X={p}', 'perl -e A={p} x.pl', 'caffeinate ruby -e X={p} a.rb', 'maestro test -e OUT=a{out}']) {
    assert.ok(probs(bad).length > 0, bad);
  }
});

test('AC34: env-loading wrappers are command runners', () => {
  for (const bad of ['cross-env A=1 node x.mjs', 'dotenv -- node x.mjs', 'env-cmd node x.mjs', 'direnv exec . node x.mjs']) {
    assert.ok(cmdProblems(bad).length > 0, bad);
  }
});
