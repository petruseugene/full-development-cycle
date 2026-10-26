import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFailures, classify } from '../plugin/scripts/lib/test-failures.mjs';

test('TAP: not ok with yaml diagnostics, ok lines dropped', () => {
  const text = ['ok 1 - a', 'not ok 2 - b in x.mjs', '  ---', '  error: boom', '  stack: |-', '    at f (x.mjs:1:1)', '  ...', 'ok 3 - c', '1..3'].join('\n');
  const b = extractFailures(text);
  assert.equal(b.length, 1);
  assert.match(b[0].text, /error: boom/);
  assert.match(b[0].text, /at f \(x\.mjs/);
  assert.ok(!b[0].text.includes('ok 3'));
});

test('TAP: parent of failing subtests is dropped; SKIP ignored', () => {
  const text = ['    not ok 1 - child', '      ---', "      error: bad", '      ...', "not ok 1 - parent", "  ---", "  failureType: 'subtestsFailed'", '  ...', 'not ok 2 - s # SKIP'].join('\n');
  const b = extractFailures(text);
  assert.deepEqual(b.map((x) => x.title), ['1 - child']);
});

test('cross-mark and FAIL blocks, deduplicated', () => {
  const cross = ['✖ failing tests:', '', 'test at a.test.mjs:3:1', '✖ it breaks (1ms)', '  AssertionError: x', '      at a.test.mjs:4:1', '', '✖ it breaks (1ms)'].join('\n');
  assert.equal(extractFailures(cross).length, 2); // second has no body → distinct text
  const fail = ['PASS ok.test.js', 'FAIL src/a.test.js', '  ● thing', '    expected 1', '', 'FAIL src/b.test.js', '  ● other', '', 'Tests: 2 failed'].join('\n');
  const b = extractFailures(fail);
  assert.equal(b.length, 2);
  assert.match(b[0].text, /expected 1/);
  assert.ok(!b[1].text.includes('Tests:'));
});

test('tail caps lines per block', () => {
  const text = ['not ok 1 - x', '  ---', ...Array.from({ length: 50 }, (_, i) => `  line${i}`), '  ...'].join('\n');
  assert.ok(extractFailures(text, { tail: 5 })[0].text.split('\n').length <= 6);
});

test('classify: touched path, boundary-safe, test file of a touched source, globs', () => {
  const mk = (t) => ({ kind: 'tap', title: t, text: t });
  const blocks = [mk('not ok 1 - in /r/lib/a.mjs:3:1'), mk('not ok 2 - in data.mjs'), mk('not ok 3 - test/a.test.mjs:1:1'), mk('not ok 4 - src/x/y.js')];
  const g = classify(blocks, ['lib/a.mjs']);
  assert.equal(g.touched.length, 2);
  assert.ok(g.elsewhere.some((b) => b.text.includes('data.mjs')));
  assert.equal(classify(blocks, ['src/**/*.js']).touched.length, 1);
});

test('spec reporter: "✖ parent" whose only body is "<n> subtests failed" is dropped (F3)', () => {
  const text = ['✖ child one (1ms)', '  Error: boom', '✖ suite (3ms)', "  '1 subtest failed'", '✖ child two (1ms)', '  Error: bang'].join('\n');
  const b = extractFailures(text);
  assert.equal(b.length, 2);
  assert.ok(b.every((x) => !/suite/.test(x.title)));
});
