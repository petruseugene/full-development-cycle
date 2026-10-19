import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Doc-level acceptance checks AC16 and AC17 for the visual-tester-dashboard-insights feature.
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('AC16: visual-tester SKILL is flagged, short, names the CLI verbs and the teardown/verdict rules', () => {
  const s = rd('skills/visual-tester/SKILL.md');
  assert.match(s, /disable-model-invocation:\s*true/);
  assert.ok(s.split('\n').length <= 80, 'at most 80 lines');
  for (const v of ['visual plan', 'visual check', 'visual teardown', 'visual verdict']) assert.ok(s.includes(v), v);
  assert.match(s, /playbook\/SKILL\.md/);
  assert.match(s, /after an error or a timeout/i);
  assert.match(s, /Never write or edit the verdict/);
  assert.ok(fs.existsSync(path.join(ROOT, 'skills/visual-tester/references/visual-cli.md')));
});

test('AC17: auto-tester carries the AC coverage grammar; lifecycle and report command exist', () => {
  const a = rd('skills/auto-tester/SKILL.md');
  assert.ok(a.includes('## AC coverage — auto'));
  assert.ok(a.includes('- [pass|fail|manual|none] AC<n>'));
  const l = rd('skills/playbook/references/lifecycle.md');
  assert.match(l, /visual teardown/);
  assert.match(l, /mandatory/);
  assert.match(l, /report --feature/);
  assert.ok(fs.existsSync(path.join(ROOT, 'commands/report.md')));
});
