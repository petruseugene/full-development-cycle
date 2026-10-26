import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, PLUGIN_ROOT, TEST_DIR } from './helpers.mjs';

const REPO = REPO_ROOT;
const LINT = path.join(TEST_DIR, 'lint-skills.sh');

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skills-'));
  for (const d of ['skills', 'commands', 'hooks']) {
    fs.cpSync(path.join(PLUGIN_ROOT, d), path.join(dir, 'plugin', d), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# dev-cycle\n');
  return dir;
}
function lint(copy) {
  return spawnSync('bash', [LINT, path.join(copy, 'plugin', 'skills')], { cwd: copy, encoding: 'utf8' });
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
  edit(path.join(c, 'plugin/skills/spec-writer/SKILL.md'), (s) => s.replace(/^disable-model-invocation: true\n/m, ''));
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*spec-writer/);
});

test('AC5: adding flag to orchestrator fails', () => {
  const c = makeCopy();
  edit(path.join(c, 'plugin/skills/orchestrator/SKILL.md'), (s) => s.replace(/^name:.*\n/m, (m) => m + 'disable-model-invocation: true\n'));
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*orchestrator/);
});

test('AC6: Skill-tool instruction on flagged skill in a skill file fails with file:line', () => {
  const c = makeCopy();
  const f = path.join(c, 'plugin/skills/backend-dev/SKILL.md');
  fs.appendFileSync(f, '\n1. Invoke the `dev-cycle:playbook` skill (Skill tool)\n');
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*backend-dev\/SKILL\.md:\d+/);
});

test('AC6: Skill(dev-cycle:code-reviewer) in a command file fails', () => {
  const c = makeCopy();
  fs.appendFileSync(path.join(c, 'plugin/commands/orchestrator.md'), '\nSkill(dev-cycle:code-reviewer)\n');
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*commands\/orchestrator\.md:\d+/);
});

test('AC6: invoking orchestrator by name passes', () => {
  const c = makeCopy();
  fs.appendFileSync(path.join(c, 'plugin/commands/dashboard.md'), '\nInvoke the `dev-cycle:orchestrator` skill\n');
  const r = lint(c);
  assert.equal(r.status, 0, r.stdout);
});

test('AC10: core padded to 4801 bytes fails', () => {
  const c = makeCopy();
  const f = path.join(c, 'plugin/skills/playbook/SKILL.md');
  const size = fs.statSync(f).size;
  fs.appendFileSync(f, 'x'.repeat(4801 - size));
  assert.equal(fs.statSync(f).size, 4801);
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*playbook/);
});

test('AC10: missing lifecycle.md fails', () => {
  const c = makeCopy();
  fs.rmSync(path.join(c, 'plugin/skills/playbook/references/lifecycle.md'));
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL .*lifecycle\.md/);
});

test('AC16: default root is plugin/skills (no argument, any cwd)', () => {
  const r = spawnSync('bash', [LINT], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const src = fs.readFileSync(LINT, 'utf8');
  assert.match(src, /plugin\/skills/);
});

test('AC16: a /Users/ string in the repo-root README.md makes lint fail', () => {
  const c = makeCopy();
  fs.appendFileSync(path.join(c, 'README.md'), '\nsee /Users/someone/x\n');
  const r = lint(c);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /\/Users\//);
});
