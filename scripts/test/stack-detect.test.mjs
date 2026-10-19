import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCommands, detectFromDir, failsOnOutput } from '../lib/stack-detect.mjs';

const mem = (files) => ({ exists: (p) => p in files, read: (p) => files[p] });
const pkg = (o) => JSON.stringify(o);

test('pnpm + tsconfig + lint script', () => {
  const r = detectCommands(mem({
    'package.json': pkg({ scripts: { lint: 'eslint .', test: 'vitest' } }),
    'tsconfig.json': '{}', 'pnpm-lock.yaml': '',
  }));
  assert.equal(r.lint, 'pnpm run lint');
  assert.equal(r.typecheck, 'npx --no-install tsc --noEmit');
  assert.equal(r.test, 'pnpm test');
  assert.equal(r.format, undefined);
});

test('yarn, lint:ci preferred, prettier dependency', () => {
  const r = detectCommands(mem({
    'package.json': pkg({ scripts: { lint: 'a', 'lint:ci': 'b' }, devDependencies: { prettier: '3' } }),
    'yarn.lock': '',
  }));
  assert.equal(r.lint, 'yarn lint:ci');
  assert.equal(r.format, 'npx --no-install prettier --check .');
  assert.equal(r.typecheck, undefined);
});

test('npm default', () => {
  const r = detectCommands(mem({ 'package.json': pkg({ scripts: { lint: 'x' } }) }));
  assert.equal(r.lint, 'npm run lint');
});

test('go.mod', () => {
  const r = detectCommands(mem({ 'go.mod': 'module x' }));
  assert.deepEqual(r, { lint: 'go vet ./...', format: 'gofmt -l .', test: 'go test ./...' });
  assert.ok(failsOnOutput(r.format));
  assert.ok(!failsOnOutput(r.lint));
});

test('python: ruff wins over flake8; mypy, black, pytest', () => {
  const r = detectCommands(mem({
    'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.black]\n[tool.pytest.ini_options]\n',
    '.flake8': '',
  }));
  assert.deepEqual(r, { lint: 'ruff check .', typecheck: 'mypy .', format: 'black --check .', test: 'pytest' });
});

test('python: flake8 only when no ruff', () => {
  const r = detectCommands(mem({ 'requirements.txt': 'flake8\n' }));
  assert.equal(r.lint, 'flake8');
});

test('rust', () => {
  const r = detectCommands(mem({ 'Cargo.toml': '' }));
  assert.equal(r.lint, 'cargo clippy -- -D warnings');
  assert.equal(r.format, 'cargo fmt --check');
  assert.equal(r.test, 'cargo test');
});

test('empty dir yields {}', () => {
  assert.deepEqual(detectCommands(mem({})), {});
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  try { assert.deepEqual(detectFromDir(d), {}); } finally { fs.rmSync(d, { recursive: true }); }
});

test('detectFromDir reads real files', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  try {
    fs.writeFileSync(path.join(d, 'go.mod'), 'module x');
    assert.equal(detectFromDir(d).lint, 'go vet ./...');
  } finally { fs.rmSync(d, { recursive: true }); }
});

test('no command contains --fix or --write', () => {
  const all = detectCommands(mem({
    'package.json': pkg({ scripts: { lint: 'x', test: 'y' }, devDependencies: { prettier: '3' } }),
    'tsconfig.json': '', 'go.mod': '', 'Cargo.toml': '', 'pyproject.toml': '[tool.ruff]',
  }));
  for (const c of [
    ...Object.values(all),
    ...Object.values(detectCommands(mem({ 'go.mod': '' }))),
    ...Object.values(detectCommands(mem({ 'Cargo.toml': '' }))),
  ]) assert.doesNotMatch(c, /--fix|--write/);
});

test('node --test script gets the dot reporter', () => {
  const files = (pm) => ({ 'package.json': pkg({ scripts: { test: 'node --test' } }), ...pm });
  assert.equal(detectCommands(mem(files({}))).test, 'npm test -- --test-reporter=dot');
  assert.equal(detectCommands(mem(files({ 'yarn.lock': '' }))).test, 'yarn test --test-reporter=dot');
  const own = mem({ 'package.json': pkg({ scripts: { test: 'node --test --test-reporter=spec' } }) });
  assert.equal(detectCommands(own).test, 'npm test');
  assert.equal(detectCommands(mem({ 'package.json': pkg({ scripts: { test: 'vitest' } }) })).test, 'npm test');
});
