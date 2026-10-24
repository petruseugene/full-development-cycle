import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkFixture, sampleFeatureJson, DEFAULT_FEATURE } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../dev-cycle.mjs', import.meta.url));
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const runCli = (args, cwd) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(), encoding: 'utf8', timeout: 60_000 }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };

// TDD probe (spec R5b/R6): `check --scope touched --files <test file> --steps test`
// is RED (exit 1) while the new test fails and GREEN (exit 0) once it passes.
// A nested `node --test` inherits NODE_TEST_CONTEXT from this runner and would exit 0 on failure; drop it.
const FAILING = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('new behaviour', () => { assert.equal(1 + 1, 3); });\n";
const PASSING = FAILING.replace('3)', '2)');

test('tdd probe: failing touched test is RED (exit 1), passing is GREEN (exit 0)', () => {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ tdd: true, profile: { commands: { test: 'node --test {files}' } } }) });
  try {
    fx.write('src/feature.test.mjs', FAILING);
    const probe = () => runCli(['check', '--scope', 'touched', '--files', 'src/feature.test.mjs', '--steps', 'test', '--feature', DEFAULT_FEATURE], fx.root);
    const red = probe();
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /FAIL test/);
    fx.write('src/feature.test.mjs', PASSING);
    const green = probe();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /check: PASSED/);
  } finally { fx.cleanup(); }
});
