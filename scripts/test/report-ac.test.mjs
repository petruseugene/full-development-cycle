import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcCoverage, buildAcMap } from '../lib/report-ac.mjs';

const SPEC = `# Spec

## 6. Acceptance criteria

- [ ] AC1: first ${'x'.repeat(200)}
- [ ] AC2: second
- [ ] AC3: third
- [ ] AC4: fourth
- [ ] AC5: fifth
`;
const PLAN = `# Plan

## Task details

### Task 1: one  \`[TODO]\`
**Tag:** backend
**Touches:** \`a/**\`
**Acceptance:** AC1–AC2
`;
const REPORT = `# Test report

## AC coverage — auto
- [pass] AC1 — a.test.mjs › "x"
- [fail] AC2 — b.test.mjs › "y"
- [pass] ACx — junk
- garbage line

## AC coverage — visual
- [pass] AC3 — verification/manifest.json › "lis-m2"
`;

test('AC map fixture: auto, failing, visual, none', () => {
  const { ac_map, counts } = buildAcMap({ specText: SPEC, planText: PLAN, reportText: REPORT });
  const cls = Object.fromEntries(ac_map.map((r) => [r.ac, r.class]));
  assert.deepEqual(cls, { 1: 'auto', 2: 'failing', 3: 'visual', 4: 'none', 5: 'none' });
  assert.equal(ac_map[0].task, 1);
  assert.deepEqual(ac_map[1].tasks, [1]);
  assert.equal(ac_map[2].task, null);
  assert.equal(ac_map[0].text.length, 160);
  assert.deepEqual(counts, { failing: 1, auto: 1, visual: 1, manual: 0, none: 2, unknown: 0 });
});

test('legacy report bullets map to auto with source legacy', () => {
  const report = '## AC to test mapping\n- [pass] AC4, AC5 — f "n"\n';
  const { entries } = parseAcCoverage(report);
  assert.deepEqual(entries.map((e) => [e.ac, e.source]), [[4, 'legacy'], [5, 'legacy']]);
  const { ac_map } = buildAcMap({ specText: SPEC, reportText: report });
  assert.deepEqual(ac_map.filter((r) => r.class === 'auto').map((r) => r.ac), [4, 5]);
  assert.equal(ac_map[3].source, 'legacy');
  assert.deepEqual(ac_map[0].tasks, []);
});

test('report without bullets yields all unknown', () => {
  const { ac_map, counts } = buildAcMap({ specText: SPEC, planText: PLAN, reportText: '# Report\nnothing here\n' });
  assert.ok(ac_map.every((r) => r.class === 'unknown'));
  assert.equal(counts.unknown, 5);
});

test('junk and malformed lines are skipped without throwing', () => {
  const { entries } = parseAcCoverage('## AC coverage\n- [pass] ACx — junk\n- [pass] AC1 junk\n- [pass] AC1-AC999999 — big\n- [pass] AC2 — ok\n');
  assert.deepEqual(entries.map((e) => [e.ac, e.source]), [[2, 'auto']]);
  assert.doesNotThrow(() => parseAcCoverage(undefined));
  assert.doesNotThrow(() => buildAcMap({}));
});

test('ranges expand and manual class applies', () => {
  const { ac_map } = buildAcMap({ specText: SPEC, reportText: '## AC coverage\n- [pass] AC1–AC2 — t\n- [manual] AC3 — look\n' });
  assert.deepEqual(ac_map.map((r) => r.class), ['auto', 'auto', 'manual', 'none', 'none']);
});
