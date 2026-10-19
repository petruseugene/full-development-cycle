import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(new URL('../run-dashboard.sh', import.meta.url).pathname);
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-bin-'));
fs.writeFileSync(
  path.join(BIN, 'npm'),
  '#!/bin/sh\necho "TELEMETRY=${NEXT_TELEMETRY_DISABLED-<unset>}"\necho "AGENT=${DASHBOARD_AGENT-<unset>}"\necho "FEATURES=$DASHBOARD_FEATURES_DIR"\n',
  { mode: 0o755 },
);

function run(args, env = {}) {
  const base = { ...process.env, PATH: `${BIN}:${process.env.PATH}` };
  delete base.DASHBOARD_AGENT;
  return spawnSync('bash', [SCRIPT, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
}
const agent = (r) => /^AGENT=(.*)$/m.exec(r.stdout)?.[1];

test('--agent=off exports off', () => {
  const r = run(['--agent=off']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(agent(r), 'off');
});

test('--no-agent is an alias for off', () => {
  assert.equal(agent(run(['--no-agent'])), 'off');
});

test('project root plus --agent=on in any position', () => {
  const r = run(['/tmp/x', '--agent=on']);
  assert.equal(agent(r), 'on');
  assert.match(r.stdout, /^FEATURES=\/tmp\/x\/docs\/features$/m);
  const r2 = run(['--agent=on', '/tmp/x']);
  assert.match(r2.stdout, /^FEATURES=\/tmp\/x\/docs\/features$/m);
});

test('--agent=bogus exits 2 and names the value', () => {
  const r = run(['--agent=bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bogus/);
});

test('no flag passes DASHBOARD_AGENT through unchanged', () => {
  assert.equal(agent(run([], { DASHBOARD_AGENT: 'On' })), 'On');
  assert.equal(agent(run([])), '<unset>');
});

test('last positional project path wins', () => {
  const r = run(['/tmp/a', '--agent=on', '/tmp/b']);
  assert.match(r.stdout, /^FEATURES=\/tmp\/b\/docs\/features$/m);
});

test('positional path overrides cwd default', () => {
  const r = run(['/tmp/proj']);
  assert.match(r.stdout, /^FEATURES=\/tmp\/proj\/docs\/features$/m);
});

test('-- ends flag parsing', () => {
  const r = run(['--', '--weird']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^FEATURES=--weird\/docs\/features$/m);
});

test('unknown option exits 2', () => {
  const r = run(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option/);
});

test('metacharacters in a path are data, not executed', () => {
  const marker = path.join(BIN, 'pwned');
  const r = run([`/tmp/x;touch ${marker}`, '$(touch ' + marker + ')']);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(r.status, 0, r.stderr);
});

test('command doc reads $ARGUMENTS via quoted heredoc', () => {
  const doc = fs.readFileSync(new URL('../../commands/dashboard.md', import.meta.url), 'utf8');
  assert.match(doc, /<<'DEV_CYCLE_ARGS_EOF'/);
  assert.doesNotMatch(doc, /run-dashboard\.sh" "\$\(pwd\)"/);
});
