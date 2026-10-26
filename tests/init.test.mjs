import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../plugin/scripts/dev-cycle.mjs';

async function cli(cwd, args) {
  const out = [];
  const err = [];
  const code = await main(args, {
    cwd, env: { ...process.env },
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

test('AC30: init detects commands, refuses overwrite, --force --preset expo', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-init-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'node --test' },
  }));
  const file = path.join(dir, '.dev-cycle', 'project.json');

  const r1 = await cli(dir, ['init']);
  assert.equal(r1.code, 0, r1.stderr);
  const p1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(p1.commands.lint, 'npm run lint');
  assert.match(p1.commands.test, /--test-reporter=dot/);
  assert.equal((await cli(dir, ['profile', 'validate'])).code, 0);

  const bytes = fs.readFileSync(file);
  const r2 = await cli(dir, ['init']);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /init: \.dev-cycle\/project\.json exists \(use --force\)/);
  assert.ok(bytes.equals(fs.readFileSync(file)));

  const r3 = await cli(dir, ['init', '--force', '--preset', 'expo']);
  assert.equal(r3.code, 0, r3.stderr);
  const p3 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(p3.interview_defaults.platform, 'mobile');
  assert.ok(p3.visual && typeof p3.visual === 'object');
  assert.equal((await cli(dir, ['profile', 'validate'])).code, 0);

  const r4 = await cli(dir, ['init', '--force', '--preset', 'web']);
  assert.equal(r4.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).interview_defaults.platform, 'web');
});

test('init: unknown preset and flag exit 2; empty project writes a valid profile', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-init-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await cli(dir, ['init', '--preset', 'nope'])).code, 2);
  assert.equal((await cli(dir, ['init', '--bogus'])).code, 2);
  assert.equal((await cli(dir, ['init'])).code, 0);
  assert.equal((await cli(dir, ['profile', 'validate'])).code, 0);
});

test('F5: init prints the path and one key=value line per detected command', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-init-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc' } }));
  const r = await cli(dir, ['init']);
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout.split('\n');
  assert.equal(out[0], 'init: wrote .dev-cycle/project.json');
  assert.ok(out.includes('lint=npm run lint'), r.stdout);
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.dev-cycle', 'project.json'), 'utf8'));
  for (const [k, v] of Object.entries(written.commands)) assert.ok(out.includes(`${k}=${v}`), r.stdout);
});
