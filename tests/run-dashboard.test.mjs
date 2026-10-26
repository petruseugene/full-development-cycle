import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(new URL('../plugin/scripts/run-dashboard.sh', import.meta.url).pathname);
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-bin-'));
fs.writeFileSync(
  path.join(BIN, 'npm'),
  '#!/bin/sh\necho "TELEMETRY=${NEXT_TELEMETRY_DISABLED-<unset>}"\necho "AGENT=${DASHBOARD_AGENT-<unset>}"\necho "FEATURES=$DASHBOARD_FEATURES_DIR"\n',
  { mode: 0o755 },
);

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-proj-')));
}

function run(args, env = {}, cwd = undefined) {
  const base = { ...process.env, PATH: `${BIN}:${process.env.PATH}` };
  delete base.DASHBOARD_AGENT;
  return spawnSync('bash', [SCRIPT, ...args], { env: { ...base, ...env }, encoding: 'utf8', cwd });
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
  const x = tmpDir();
  const r = run([x, '--agent=on']);
  assert.equal(agent(r), 'on');
  assert.match(r.stdout, new RegExp(`^FEATURES=${x}/docs/features$`, 'm'));
  const r2 = run(['--agent=on', x]);
  assert.match(r2.stdout, new RegExp(`^FEATURES=${x}/docs/features$`, 'm'));
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
  const a = tmpDir();
  const b = tmpDir();
  const r = run([a, '--agent=on', b]);
  assert.match(r.stdout, new RegExp(`^FEATURES=${b}/docs/features$`, 'm'));
});

test('positional path overrides cwd default', () => {
  const proj = tmpDir();
  const r = run([proj], {}, tmpDir());
  assert.match(r.stdout, new RegExp(`^FEATURES=${proj}/docs/features$`, 'm'));
});

test('-- ends flag parsing', () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, '--weird'));
  const r = run(['--', '--weird'], {}, cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^FEATURES=${cwd}/--weird/docs/features$`, 'm'));
});

test('unknown option exits 2', () => {
  const r = run(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option/);
});

test('metacharacters in a path are data, not executed', () => {
  const marker = path.join(BIN, 'pwned');
  const cwd = tmpDir();
  const first = path.join(cwd, `x;touch ${marker}`);
  const last = `$(touch ${marker})`;
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(path.join(cwd, last), { recursive: true });
  const r = run([first, last], {}, cwd);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`FEATURES=${path.join(cwd, last)}/docs/features`), r.stdout);
});

test('command doc reads $ARGUMENTS via quoted heredoc', () => {
  const doc = fs.readFileSync(new URL('../plugin/commands/dashboard.md', import.meta.url), 'utf8');
  assert.match(doc, /<<'DEV_CYCLE_ARGS_EOF'/);
  assert.doesNotMatch(doc, /run-dashboard\.sh" "\$\(pwd\)"/);
});
