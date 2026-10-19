import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const OLD = ['static-checker', 'git-agent', 'dependency-auditor', 'a11y-auditor', 'db-migrator', 'release-manager'];

test('AC21: CHANGELOG capability map covers every old skill with a new place', () => {
  const log = read('CHANGELOG.md');
  const rows = log.split('\n').filter((l) => /^\|/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  for (const old of OLD) {
    const mine = rows.filter((r) => r[0] === old);
    assert.ok(mine.length > 0, `no row for ${old}`);
    assert.ok(mine.every((r) => r[2]), `empty new place for ${old}`);
  }
});

test('AC36: README has no kill-port and explains recorded process groups', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('kill-port'));
  assert.ok(readme.includes('process groups recorded'));
});

test('AC36: old visual spec AC2 shows the passing maestro form', (t) => {
  // docs/features/ is git-ignored (local only): the real spec is absent in a fresh clone
  const rel = 'docs/features/2026-10-19-01h-26m-visual-tester-dashboard-insights/spec.md';
  if (!fs.existsSync(path.join(root, rel))) { t.skip('local spec not present'); return; }
  assert.ok(read(rel).includes('maestro --device {device} test flow.yaml'));
});

test('AC8: README says the git guard is not a security boundary', () => {
  assert.match(read('README.md'), /not a security boundary/);
});

test('README has no removed skills/<old>/ paths', () => {
  const readme = read('README.md');
  for (const old of OLD) assert.ok(!readme.includes(`skills/${old}/`), old);
});
