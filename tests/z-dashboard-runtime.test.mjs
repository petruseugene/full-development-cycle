import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const DASH = path.join(PLUGIN_ROOT, 'dashboard');
const read = (p) => fs.readFileSync(p, 'utf8');
const pkg = JSON.parse(read(path.join(DASH, 'package.json')));
const lock = JSON.parse(read(path.join(DASH, 'package-lock.json')));
const isRuntime = (n) => n === 'typescript' || n.startsWith('@types/') || ['tailwindcss', 'postcss', 'autoprefixer'].includes(n);

test('AC20: run-dashboard.sh installs with npm ci --omit=dev and never npm install', () => {
  const sh = read(path.join(PLUGIN_ROOT, 'scripts/run-dashboard.sh'));
  assert.ok(sh.includes('npm ci --omit=dev --no-audit --no-fund'));
  assert.ok(!sh.includes('npm install'));
});

test('AC20: build-time tooling lives in dependencies, test tooling in devDependencies', () => {
  const dev = Object.keys(pkg.devDependencies);
  const deps = Object.keys(pkg.dependencies);
  for (const n of ['typescript', 'tailwindcss', 'postcss', 'autoprefixer']) assert.ok(deps.includes(n), n);
  assert.ok(deps.some((n) => n.startsWith('@types/')));
  assert.deepEqual(dev.filter(isRuntime), []);
  for (const n of ['vitest', 'jsdom']) assert.ok(dev.includes(n), n);
});

test('AC20: package-lock root entry matches package.json', () => {
  const root = lock.packages[''];
  assert.deepEqual(root.dependencies, pkg.dependencies);
  assert.deepEqual(root.devDependencies, pkg.devDependencies);
});
