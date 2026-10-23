import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Doc checks for spec amend / spec analyze (AC18-AC22). Read-only over the repo tree.
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const size = (p) => fs.statSync(path.join(ROOT, p)).size;
const FAIL_LINE = '! DOD-GATE FAILED: spec-analyze last status = ERRORS; aborting before push.';

test('AC18: spec-writer Amend mode and template example', () => {
  const s = rd('skills/spec-writer/SKILL.md');
  for (const k of ['Amend mode', 'Amendment:', 'spec amend --title', 'spec amend --supersede', 'spec analyze', 'never renumber', 'Never hand-write']) {
    assert.ok(s.toLowerCase().includes(k.toLowerCase()), k);
  }
  const t = rd('skills/spec-writer/references/spec-template.md');
  assert.ok(t.includes('### Acceptance Criteria (amendment'));
  assert.ok(t.includes('**[superseded → AC'));
});

test('AC19: live ACs only in task-format and auto-tester', () => {
  assert.match(rd('skills/plan-writer/references/task-format.md'), /live AC ids covered/);
  const a = rd('skills/auto-tester/SKILL.md');
  assert.match(a, /skip superseded and removed ACs/);
});

test('AC20: spec-analyze.md literals, pointer and dod line', () => {
  const o = rd('skills/orchestrator/references/spec-analyze.md');
  for (const k of ['spec analyze', 'spec amend', 'Amendment:', 'exit 1', '3 rounds', 'never hand-edit', 'Quick track', 'bugfix', 'hotfix', FAIL_LINE]) {
    assert.ok(o.toLowerCase().includes(k.toLowerCase()), k);
  }
  assert.ok(rd('skills/orchestrator/references/open-decisions.md').includes('spec-analyze.md'));
  assert.ok(size('skills/orchestrator/references/open-decisions.md') <= 4096);
  assert.ok(rd('skills/orchestrator/references/dod-gate.md').includes(FAIL_LINE));
});

test('AC21: byte caps hold', () => {
  assert.ok(size('skills/orchestrator/SKILL.md') <= 18765);
  assert.ok(size('skills/playbook/references/lifecycle.md') <= 29105);
});

test('AC22: README rows and CHANGELOG entries (any Unreleased or released section)', () => {
  const r = rd('README.md');
  const cli = r.slice(r.indexOf('## CLI reference'));
  assert.match(cli, /\| `spec amend --title/);
  assert.match(cli, /\| `spec amend --supersede/);
  assert.match(cli, /\| `spec analyze/);
  assert.ok(cli.includes('spec-analyze'));
  const c = rd('CHANGELOG.md');
  assert.match(c, /^## \[(Unreleased|\d+\.\d+\.\d+)\]/m);
  assert.ok(c.includes('`spec amend`'));
  assert.ok(c.includes('`spec analyze'));
  assert.match(c, /#6\b/);
});
