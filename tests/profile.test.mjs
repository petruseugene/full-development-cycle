import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkFixture, runCli } from './helpers.mjs';

function withProfile(obj) {
  const fx = mkFixture();
  if (obj !== undefined) fx.write('.dev-cycle/project.json', typeof obj === 'string' ? obj : JSON.stringify(obj));
  return fx;
}
const validate = (fx) => runCli(['profile', 'validate'], { cwd: fx.root });

test('AC17: invalid profiles exit 2', () => {
  const cases = {
    'extra_gates not array': { extra_gates: {} },
    'duplicate gate': { extra_gates: [{ name: 'a', cmd: 'x' }, { name: 'a', cmd: 'y' }] },
    'bad name': { extra_gates: [{ name: 'Bad Name', cmd: 'x' }] },
    'platform desktop': { platform: 'desktop' },
    'unknown skill': { enabled_skills: ['nope'] },
    'bad rules': { rules: [{ globs: 'x', text: 't' }] },
    'invalid json': '{oops',
  };
  for (const [label, p] of Object.entries(cases)) {
    const fx = withProfile(p);
    const r = validate(fx);
    assert.equal(r.status, 2, label);
    fx.cleanup();
  }
});

test('AC17: unknown top-level key warns, exit 0', () => {
  const fx = withProfile({ foo: 1 });
  const r = validate(fx);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning:.*foo/);
  fx.cleanup();
});

test('AC17: missing profile is valid; show reports empty', () => {
  const fx = withProfile(undefined);
  assert.equal(validate(fx).status, 0);
  const r = runCli(['profile', 'show', '--json'], { cwd: fx.root });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(r.stdout));
  assert.equal(JSON.parse(r.stdout).exists, false);
  fx.cleanup();
});

test('valid full profile passes and show prints it', () => {
  const p = {
    platform: 'mobile',
    interview_defaults: { has_backend: false, discovery: 'internal' },
    commands: { lint: 'pnpm lint' },
    extra_gates: [{ name: 'content', cmd: 'pnpm v', timeout_s: 5 }],
    post_merge: [{ name: 'dev', cmd: 'x.sh', confirm: true }],
    enabled_skills: ['frontend-dev', 'backend-dev'],
    guards: ['g'],
    rules: [{ globs: ['a/**'], text: 't' }],
  };
  const fx = withProfile(p);
  assert.equal(validate(fx).status, 0);
  const r = runCli(['profile', 'show', '--json'], { cwd: fx.root });
  assert.deepEqual(JSON.parse(r.stdout).profile, p);
  fx.cleanup();
});

test('timeout_s upper bound (<= 86400) for extra_gates and post_merge', () => {
  const ok = withProfile({ extra_gates: [{ name: 'a', cmd: 'x', timeout_s: 86400 }], post_merge: [{ name: 'b', cmd: 'y', timeout_s: 10 }] });
  assert.equal(validate(ok).status, 0);
  ok.cleanup();
  for (const p of [
    { extra_gates: [{ name: 'a', cmd: 'x', timeout_s: 86401 }] },
    { post_merge: [{ name: 'b', cmd: 'y', timeout_s: 999999 }] },
    { extra_gates: [{ name: 'a', cmd: 'x', timeout_s: 0 }] },
  ]) {
    const fx = withProfile(p);
    assert.equal(validate(fx).status, 2);
    fx.cleanup();
  }
});

test('AC33: protected skills omitted from enabled_skills warn, exit 0', async () => {
  const { mkFixture, runCli } = await import('./helpers.mjs');
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ enabled_skills: ['auto-tester'] }));
  const r = runCli(['profile', 'validate'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /protected skill 'playbook' is always enabled/);
  fx.cleanup();
});

const TTS = {
  name: 'tts',
  cmd: 'node scripts/tts.mjs --generate --only {keys} --max-requests {max}',
  params: {
    keys: { required: true, pattern: '^[A-Za-z0-9_.,-]+$' },
    max: { required: true, type: 'int', max: 50 },
  },
  guards: ['Never regenerate approved clips: pass explicit --only keys'],
  timeout_s: 900,
};

test('AC26: valid tts recipe passes; each invalid case errors', () => {
  let fx = withProfile({ recipes: [TTS] });
  let r = validate(fx);
  assert.equal(r.status, 0, r.stderr);
  fx.cleanup();
  const bad = {
    'bad name': { ...TTS, name: 'Bad Name' },
    'empty cmd': { ...TTS, cmd: '' },
    'undeclared placeholder': { ...TTS, cmd: 'x {keys} {max} {zzz}' },
    'param not object': { ...TTS, params: { keys: 'x', max: TTS.params.max } },
    'bad type': { ...TTS, params: { ...TTS.params, max: { type: 'float' } } },
    'bad regex': { ...TTS, params: { ...TTS.params, keys: { pattern: '(' } } },
    'numeric pattern': { ...TTS, params: { ...TTS.params, keys: { pattern: 5 } } },
    'array pattern': { ...TTS, params: { ...TTS.params, keys: { pattern: ['^a$'] } } },
    'nested quantifier pattern': { ...TTS, params: { ...TTS.params, keys: { pattern: '(a+)+' } } },
    'too long pattern': { ...TTS, params: { ...TTS.params, keys: { pattern: 'a'.repeat(257) } } },
    'allow_dash not boolean': { ...TTS, params: { ...TTS.params, keys: { allow_dash: 'yes' } } },
    'heredoc placeholder': { ...TTS, cmd: 'cat <<EOF\n{keys} {max}\nEOF' },
    'backslash placeholder': { ...TTS, cmd: 'echo \\{keys} {max}' },
    'comment placeholder': { ...TTS, cmd: 'echo {max} # {keys}' },
    'backtick placeholder': { ...TTS, cmd: 'echo `echo {keys}` {max}' },
    'quoted placeholder': { ...TTS, cmd: 'echo "{keys}" {max}' },
    'quoted command word': { ...TTS, cmd: '"e"val {keys} {max}' },
    'escaped command word': { ...TTS, cmd: 'e\\val {keys} {max}' },
    'pipe without placeholder use': { ...TTS, cmd: 'node a.mjs {keys} {max} | tee x' },
    'glued placeholder': { ...TTS, cmd: 'node a.mjs x{keys} {max}' },
    'arithmetic placeholder': { ...TTS, cmd: 'echo {keys} $(( {max} + 1 ))' },
    'eval placeholder': { ...TTS, cmd: 'eval echo {keys} {max}' },
    'bash -x -c placeholder': { ...TTS, cmd: 'bash -x -c {keys} {max}' },
    'time prefix': { ...TTS, cmd: 'time {keys} {max}' },
    'env prefix': { ...TTS, cmd: 'env node a.mjs {keys} {max}' },
    'read builtin': { ...TTS, cmd: 'read {keys} {max}' },
    'node -e placeholder': { ...TTS, cmd: 'node -e x {keys} {max}' },
    'node script position': { ...TTS, cmd: 'node {keys} {max}' },
    'command-position placeholder': { ...TTS, cmd: '{keys} {max}' },
    'wrapper placeholder': { ...TTS, cmd: 'caffeinate -i sh -c {keys} {max}' },
    'shell variant placeholder': { ...TTS, cmd: 'bash5 -c {keys} {max}' },
    'npm script placeholder': { ...TTS, cmd: 'npm run build -- {keys} {max}' },
    'non-ASCII word': { ...TTS, cmd: 'node\u00a0a.mjs {keys} {max}' },
    'overlapping alternation pattern': { ...TTS, params: { ...TTS.params, keys: { pattern: '(a|aa)+' } } },
    'max on string': { ...TTS, params: { ...TTS.params, keys: { max: 3 } } },
    'non-integer min': { ...TTS, params: { ...TTS.params, max: { type: 'int', min: 1.5 } } },
    'required not boolean': { ...TTS, params: { ...TTS.params, max: { type: 'int', required: 'yes' } } },
    'guards not strings': { ...TTS, guards: [1] },
    'timeout zero': { ...TTS, timeout_s: 0 },
    'timeout too big': { ...TTS, timeout_s: 86401 },
  };
  for (const [label, rec] of Object.entries(bad)) {
    fx = withProfile({ recipes: [rec] });
    r = validate(fx);
    assert.notEqual(r.status, 0, label);
    assert.match(r.stderr + r.stdout, /recipes\[0\]/, label);
    if (/placeholder|word|prefix|builtin|position|pipe/.test(label) && label !== 'undeclared placeholder') assert.match(r.stderr + r.stdout, /recipes\[0\]\.cmd .*without a shell/, label);
    fx.cleanup();
  }
  fx = withProfile({ recipes: [TTS, TTS] });
  assert.notEqual(validate(fx).status, 0, 'duplicate');
  fx.cleanup();
});

test('review F8-F10: real recipe shapes pass profile validate', () => {
  for (const cmd of [
    'uv run scripts/gen.py {keys} {max}',
    'deno run --allow-read scripts/x.ts {keys} {max}',
    'git add . {keys} {max}',
    'rg -n TODO . {keys} {max}',
    'python3 tools/gen.py -p {keys} --print {max}',
    'node scripts/x.mjs -C dir {keys} {max}',
  ]) {
    const fx = withProfile({ recipes: [{ ...TTS, cmd }] });
    const r = validate(fx);
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    fx.cleanup();
  }
});

test('AC26: unused declared param warns, exit 0', () => {
  const fx = withProfile({ recipes: [{ ...TTS, cmd: 'echo {keys}' }] });
  const r = validate(fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /declared but not used/);
  fx.cleanup();
});

test('AC25: interview_defaults.owner_blocking validates', () => {
  const fx = withProfile({ interview_defaults: { owner_blocking: true } });
  assert.equal(validate(fx).status, 0);
  fx.cleanup();
  const bad = withProfile({ interview_defaults: { owner_blocking: 'x' } });
  assert.notEqual(validate(bad).status, 0);
  bad.cleanup();
});

test('AC22: validate accepts old skill names with one warning line each', () => {
  const fx = withProfile({ enabled_skills: ['a11y-auditor', 'static-checker', 'release-manager', 'db-migrator'] });
  const r = validate(fx);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.split('\n');
  assert.equal(lines.filter((l) => l === "warning: skill 'a11y-auditor' was merged into 'visual-tester'").length, 1);
  assert.equal(lines.filter((l) => l === "warning: skill 'static-checker' was merged into 'cli-fallback'").length, 1);
  assert.equal(lines.filter((l) => /skill 'release-manager' was merged/.test(l)).length, 1);
  assert.doesNotMatch(r.stderr, /protected skill 'cli-fallback'/);
  const show = runCli(['profile', 'show'], { cwd: fx.root });
  assert.equal(show.status, 0);
  assert.equal(show.stderr.split('\n').filter((l) => /a11y-auditor/.test(l)).length, 1);
  fx.cleanup();
});

test('tdd AC1: interview_defaults.tdd accepts booleans, rejects other types', async () => {
  const { validateProfile } = await import('../plugin/scripts/lib/profile.mjs');
  assert.deepEqual(validateProfile({ interview_defaults: { tdd: true } }).errors, []);
  assert.deepEqual(validateProfile({ interview_defaults: { tdd: false } }).errors, []);
  const bad = validateProfile({ interview_defaults: { tdd: 'yes' } }).errors;
  assert.ok(bad.some((e) => e.includes('interview_defaults.tdd')), bad.join('\n'));
});
