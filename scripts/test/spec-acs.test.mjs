import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSpecAcs, resolveAc, parseAcIds, AC_LINE_RE } from '../lib/spec-acs.mjs';
import { indexSpecAcs, parseAcIds as briefParseAcIds } from '../lib/brief.mjs';
import { UsageError } from '../lib/core.mjs';
import { SCRIPTS_DIR } from './helpers.mjs';

const LAYOUT6 = `# Spec

## 6. Acceptance Criteria
- [ ] AC1: one
- [ ] AC2: two
  continued

  paragraph
- [ ] AC3: three

## Wireframe acceptance criteria
- [ ] AC4: wire

## Правка 22.10 — design v2

### Notes
AC9: stray note

### 9.13. Acceptance Criteria правки
- [ ] AC5: five
- [ ] AC6: six

## Tasks
`;

test('AC1: bug #6 layout indexes AC1-AC6 verbatim, stray AC9 is unscoped', () => {
  const r = parseSpecAcs(LAYOUT6);
  assert.deepEqual([...r.acs.keys()], [1, 2, 3, 4, 5, 6]);
  assert.equal(r.acs.get(2).text, '- [ ] AC2: two\n  continued\n\n  paragraph');
  assert.equal(r.acs.get(5).text, '- [ ] AC5: five');
  assert.equal(r.acs.get(1).line, 4);
  assert.deepEqual(r.unscoped.map((u) => u.n), [9]);
  assert.equal(r.unscoped[0].line, 17);
  assert.equal(r.maxId, 9);
  assert.equal(r.acs.has(9), false);
});

test('AC1: maxId is 6 without the stray note', () => {
  assert.equal(parseSpecAcs(LAYOUT6.replace('AC9: stray note', 'plain')).maxId, 6);
  assert.equal(parseSpecAcs('# nothing\n').maxId, 0);
});

test('AC2: scope closes at same/higher level and survives deeper headings', () => {
  const t = '## Doc\n\n### Acceptance Criteria\nAC1: a\n#### Sub\nAC2: b\n### Other\nAC3: out\n## Next\nAC4: out\n';
  const r = parseSpecAcs(t);
  assert.deepEqual([...r.acs.keys()], [1, 2]);
  assert.deepEqual(r.unscoped.map((u) => u.n), [3, 4]);
});

test('AC2: regression F3 multi-paragraph ACs stay whole', () => {
  const spec = `# Spec\n\n## 6. Acceptance Criteria\n\n### A\n\n- [ ] AC1: first paragraph.\n  - bullet\n\n  Trailing paragraph after a blank line.\n- [ ] AC2: short.\n\n### B\n\n- [ ] AC3: heading ends the AC.\n\n  Closing paragraph.\n\n## 7. Out\n\nnope\n`;
  const r = parseSpecAcs(spec);
  assert.equal(r.acs.get(1).text, '- [ ] AC1: first paragraph.\n  - bullet\n\n  Trailing paragraph after a blank line.');
  assert.equal(r.acs.get(3).text, '- [ ] AC3: heading ends the AC.\n\n  Closing paragraph.');
});

test('AC2: fences hide AC lines and headings (incl ~~~ containing ```)', () => {
  const t = '## Acceptance Criteria\nAC1: a\n```\nAC7: in fence\n## Heading\n```\n~~~\n```\nAC8: still fenced\n~~~\n\n## Out\n```\nAC9: x\n```\n';
  const r = parseSpecAcs(t);
  assert.deepEqual([...r.acs.keys()], [1]);
  assert.deepEqual(r.unscoped, []);
  assert.equal(r.maxId, 1);
  assert.ok(r.acs.get(1).text.includes('AC7: in fence'));
});

test('AC3: supersede markers in all shapes', () => {
  const t = `## Acceptance Criteria
AC57: **[заменён 22.10 → AC82]** old
- [ ] AC58: [superseded -> AC83, AC84] old
AC59: **[Superseded → AC85 and AC86]**
AC60: [superseded] text
AC61: (removed — D2) gone
AC62: (removed - D3) gone
AC63: live
`;
  const { acs, markerErrors } = parseSpecAcs(t);
  assert.deepEqual(acs.get(57).superseded, { by: [82] });
  assert.deepEqual(acs.get(58).superseded, { by: [83, 84] });
  assert.deepEqual(acs.get(59).superseded, { by: [85, 86] });
  assert.equal(acs.get(60).superseded, null);
  assert.deepEqual(markerErrors.map((e) => e.n), [60]);
  assert.equal(acs.get(61).removed, true);
  assert.equal(acs.get(61).superseded, null);
  assert.equal(acs.get(62).removed, true);
  assert.equal(acs.get(63).removed, false);
});

test('AC4: duplicates keep the first block and report both lines', () => {
  const t = '## Acceptance Criteria\nAC3: first\n\n## Amendment\n### Acceptance Criteria (amendment)\nAC3: second\nAC4: x\n';
  const r = parseSpecAcs(t);
  assert.deepEqual(r.duplicates, [{ n: 3, lines: [2, 6] }]);
  assert.equal(r.acs.get(3).text, 'AC3: first');
  assert.equal(r.acs.get(3).line, 2);
  assert.ok(r.acs.has(4));
});

test('AC4: resolveAc follows chains, throws on cycle and missing target', () => {
  const mk = (o) => new Map(Object.entries(o).map(([k, by]) => [Number(k), { superseded: by ? { by } : null, removed: false }]));
  assert.deepEqual(resolveAc(mk({ 1: [5], 5: [9], 9: null }), 1), { live: [9], chain: [1, 5, 9] });
  assert.deepEqual(resolveAc(mk({ 1: [2, 3], 2: [3], 3: null }), 1), { live: [3], chain: [1, 2, 3] });
  assert.throws(() => resolveAc(mk({ 1: [2], 2: [1] }), 1), UsageError);
  assert.throws(() => resolveAc(mk({ 1: [1] }), 1), UsageError);
  assert.throws(() => resolveAc(mk({ 1: [7] }), 1), UsageError);
  assert.throws(() => resolveAc(mk({ 1: null }), 4), UsageError);
  const rem = new Map([[4, { superseded: null, removed: true }]]);
  assert.deepEqual(resolveAc(rem, 4), { live: [4], chain: [4] });
});

test('AC5: brief.mjs still exports indexSpecAcs and parseAcIds', () => {
  assert.equal(briefParseAcIds, parseAcIds);
  assert.throws(() => parseAcIds('AC5-AC2'), UsageError);
  assert.deepEqual(parseAcIds('AC1-AC3, AC5'), [1, 2, 3, 5]);
  assert.ok(AC_LINE_RE.test('- [ ] AC1: x'));
});

test('AC5: indexSpecAcs matches the legacy key set on tracked-era feature specs', (t) => {
  const dir = path.join(SCRIPTS_DIR, '..', 'docs', 'features');
  const f = path.join(dir, '2026-10-23-22h-46m-open-decisions', 'spec.md');
  if (!fs.existsSync(f)) return t.skip('feature spec not present');
  const text = fs.readFileSync(f, 'utf8');
  // legacy algorithm: only ## sections mentioning acceptance criteria
  const legacy = new Set();
  let scope = false; let fence = false;
  for (const l of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^#{1,2}\s/.test(l)) { scope = /acceptance criteria/i.test(l); continue; }
    if (!fence && scope) { const m = AC_LINE_RE.exec(l); if (m) legacy.add(Number(m[1])); }
  }
  assert.ok(legacy.size > 0);
  assert.deepEqual([...indexSpecAcs(text).keys()].sort((a, b) => a - b), [...legacy].sort((a, b) => a - b));
});

test('F1: sub-numbered ids (AC1.1) are not duplicates of AC1 and keep legacy block boundaries', () => {
  const t = '## Acceptance Criteria\n- AC1: parent\n- **AC1.1** sub one\n- **AC1.2** sub two\n- AC2: two\n';
  const r = parseSpecAcs(t);
  assert.deepEqual(r.duplicates, []);
  assert.deepEqual([...r.acs.keys()], [1, 2]);
  assert.equal(r.acs.get(1).text, '- AC1: parent');
  const only = parseSpecAcs('## Acceptance Criteria\n**AC3.1** a\n**AC3.2** b\n');
  assert.deepEqual(only.duplicates, []);
  assert.equal(only.acs.get(3).text, '**AC3.1** a');
  assert.equal(parseSpecAcs('## Acceptance Criteria\nAC1: a\nAC1: b\n').duplicates.length, 1);
});
