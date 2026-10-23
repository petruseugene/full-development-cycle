import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Doc checks for the open-decisions feature (AC10-AC14). Read-only over the repo tree.
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const size = (p) => fs.statSync(path.join(ROOT, p)).size;

test('AC10: spec template shows open and resolved decision forms between section 7 and Threat notes', () => {
  const t = rd('skills/spec-writer/references/spec-template.md');
  const i7 = t.indexOf('## 7. Out of Scope (v1)');
  const iOpen = t.indexOf('## Open decisions');
  const iThreat = t.indexOf('## Threat notes');
  assert.ok(i7 >= 0 && i7 < iOpen && iOpen < iThreat);
  assert.match(t, /### D1: /);
  assert.match(t, /- <label> \(Recommended\) — <one-line consequence>/);
  assert.match(t, /\n## Decisions\n- \*\*D1:\*\*/);
  for (const k of ['`owner`', '`owner: defaults OK`', '`owner: other`']) assert.ok(t.includes(k), k);
});

test('AC11: spec-writer carries the product-fork rules and fold mode', () => {
  const s = rd('skills/spec-writer/SKILL.md');
  for (const k of ['## Open decisions', 'product', 'profile', '2-4 options', '(Recommended)', 'one-line consequence', 'Zero decisions',
    'silently', 'Decisions (owner answers):', 'Never renumber', '(removed — D<n>)', 'spec decisions', 'at most 5 words']) {
    assert.ok(s.includes(k), k);
  }
});

test('AC12: open-decisions.md is within budget and holds the orchestrator rules', () => {
  const p = 'skills/orchestrator/references/open-decisions.md';
  assert.ok(size(p) <= 4096);
  const o = rd(p);
  for (const k of ['spec decisions --json', 'AskUserQuestion', '(Recommended)', 'at most 4', 'Decisions (owner answers):',
    '> DECISIONS:', 'defaults OK', 'never hand-edit', '3 rounds', 'Quick track', 'bugfix', 'hotfix']) {
    assert.ok(o.toLowerCase().includes(k.toLowerCase()), k);
  }
});

test('AC13: orchestrator points at the reference within its size cap; lifecycle within cap', () => {
  const o = rd('skills/orchestrator/SKILL.md');
  assert.ok(o.includes('references/open-decisions.md'));
  assert.ok(o.includes('spec decisions'));
  assert.ok(size('skills/orchestrator/SKILL.md') <= 18765);
  assert.ok(size('skills/playbook/references/lifecycle.md') <= 29105);
});

test('AC14: dod-gate.md documents the decisions check with the exact failure line', () => {
  const d = rd('skills/orchestrator/references/dod-gate.md');
  assert.ok(d.includes('! DOD-GATE FAILED: decisions last status = OPEN; aborting before push.'));
  assert.match(d, /not a history gate/);
});
