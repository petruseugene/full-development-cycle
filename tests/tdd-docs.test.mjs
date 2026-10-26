import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAcCoverage } from '../plugin/scripts/lib/report-ac.mjs';
import { PLUGIN_ROOT } from './helpers.mjs';

// Pins the tdd-mode skill text (AC10-AC16). Read-only over the repo tree.
const ROOT = PLUGIN_ROOT;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BUDGET = 'Test budget: 1 happy-path + at most 2 error-path tests per AC.';
const IMPL = ['skills/backend-dev/SKILL.md', 'skills/frontend-dev/SKILL.md'];
const tddSection = (t) => t.split(/^## /m).find((s) => s.startsWith('TDD mode')) ?? '';

test('AC10: implementer skills carry the TDD mode literals', () => {
  for (const f of IMPL) {
    const t = rd(f);
    assert.match(t, /^## TDD mode$/m, f);
    const s = tddSection(t);
    for (const k of ['RED', 'GREEN', '--steps test', BUDGET, 'TDD <g>/<n> AC red→green']) assert.ok(t.includes(k) && (k === 'TDD <g>/<n> AC red→green' || s.includes(k)), `${f}: ${k}`);
  }
});

test('AC11: TDD mode section names the unit for each track', () => {
  for (const f of IMPL) {
    const s = tddSection(rd(f));
    assert.match(s, /`lite` = the area's AC ids/, f);
    assert.match(s, /`quick` = each requested behaviour/, f);
    assert.match(s, /`bugfix` = one failing regression test that reproduces/, f);
  }
});

test('AC12: Output contract documents the optional tdd key', () => {
  for (const f of IMPL) {
    const t = rd(f);
    const c = t.slice(t.indexOf('## Output contract'));
    assert.match(c, /In TDD mode only/, f);
    assert.match(c, /tdd: \{red: .*green: .*tests: .*skipped: /, f);
  }
});

test('AC13: coverage-targets has a Test budget section', () => {
  const t = rd('skills/auto-tester/references/coverage-targets.md');
  assert.match(t, /^## Test budget$/m);
  assert.ok(t.includes(BUDGET));
});

test('AC14: auto-tester documents audit mode', () => {
  const t = rd('skills/auto-tester/SKILL.md');
  const req = t.split('## The job')[0];
  assert.match(req, /feature\.json/);
  for (const k of ['tdd == true', '## Task <N> auto-tests (audit) — <ISO ts> —', '- note: over budget AC<n>', 'handled error paths']) assert.ok(t.includes(k), k);
  assert.match(t, /write new tests only for ACs that would otherwise be `none`/);
});

test('AC15: the over-budget note is neither a dashboard case nor an AC entry', () => {
  const line = '- note: over budget AC3 — 5 tests';
  const re = /^[-*]\s*\[?\s*(pass|fail|running|✓|✗|x)\s*\]?\s*(.+?)(?:\s+[—\-]\s+(.+))?$/i; // dashboard/lib/parsers.ts
  assert.equal(re.exec(line), null);
  const r = parseAcCoverage(`## AC coverage — auto\n${line}\n`);
  assert.equal(r.entries.length, 0);
});

test('AC16: review checklist has the tdd evidence and over-budget checks', () => {
  const t = rd('skills/code-reviewer/references/review-checklist.md');
  const s = t.split(/^## /m).find((x) => x.startsWith('Tests'));
  assert.match(s, /`feature\.json\.tdd == true`/);
  assert.match(s, /RED→GREEN/);
  assert.match(s, /More than 3 tests for one AC/);
  assert.match(s, /`nit`/);
});
