import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const LINT = path.join(REPO, 'scripts', 'lint-skills.sh');

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skills-'));
  for (const d of ['skills', 'commands', 'hooks']) {
    fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  }
  return dir;
}
function lint(copy) {
  return spawnSync('bash', [LINT, path.join(copy, 'skills')], { cwd: copy, encoding: 'utf8' });
}
function edit(file, fn) {
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
}

test('real tree passes', () => {
  const r = spawnSync('bash', [LINT], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('AC5: removing flag from spec-writer fails', () => {
  const c = makeCopy();
  edit(path.join(c, 'skills/spec-writer/SKILL.md'), (s) => s.replace(/^disable-model-invocation: true\n/m, ''));
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*spec-writer/);
});

test('AC5: adding flag to orchestrator fails', () => {
  const c = makeCopy();
  edit(path.join(c, 'skills/orchestrator/SKILL.md'), (s) => s.replace(/^name:.*\n/m, (m) => m + 'disable-model-invocation: true\n'));
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*orchestrator/);
});

test('AC6: Skill-tool instruction on flagged skill in a skill file fails with file:line', () => {
  const c = makeCopy();
  const f = path.join(c, 'skills/backend-dev/SKILL.md');
  fs.appendFileSync(f, '\n1. Invoke the `dev-cycle:playbook` skill (Skill tool)\n');
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*backend-dev\/SKILL\.md:\d+/);
});

test('AC6: Skill(dev-cycle:code-reviewer) in a command file fails', () => {
  const c = makeCopy();
  fs.appendFileSync(path.join(c, 'commands/orchestrator.md'), '\nSkill(dev-cycle:code-reviewer)\n');
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*commands\/orchestrator\.md:\d+/);
});

test('AC6: invoking orchestrator by name passes', () => {
  const c = makeCopy();
  fs.appendFileSync(path.join(c, 'commands/dashboard.md'), '\nInvoke the `dev-cycle:orchestrator` skill\n');
  const r = lint(c);
  assert.equal(r.status, 0, r.stdout);
});

test('AC10: core padded to 4801 bytes fails', () => {
  const c = makeCopy();
  const f = path.join(c, 'skills/playbook/SKILL.md');
  const size = fs.statSync(f).size;
  fs.appendFileSync(f, 'x'.repeat(4801 - size));
  assert.equal(fs.statSync(f).size, 4801);
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*playbook/);
});

test('AC10: missing lifecycle.md fails', () => {
  const c = makeCopy();
  fs.rmSync(path.join(c, 'skills/playbook/references/lifecycle.md'));
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*lifecycle\.md/);
});
