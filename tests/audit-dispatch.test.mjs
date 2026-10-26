import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli } from './helpers.mjs';
import { modelLine } from '../plugin/scripts/lib/brief.mjs';

const LIFECYCLE = fs.readFileSync(new URL('../plugin/skills/playbook/references/lifecycle.md', import.meta.url), 'utf8');
const ORCH = fs.readFileSync(new URL('../plugin/skills/orchestrator/SKILL.md', import.meta.url), 'utf8');

let seq = 0;
const init = (enabled) => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ enabled_skills: enabled }));
  const r = runCli(['feature', 'init', `ad${seq++}`, '--flow', 'feature', '--track', 'full'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  const fj = JSON.parse(fs.readFileSync(path.join(r.stdout.trim(), 'feature.json'), 'utf8'));
  fx.cleanup();
  return { fj, stderr: r.stderr };
};

test('F1: old alias names in enabled_skills keep their new owners', () => {
  const { fj, stderr } = init(['a11y-auditor', 'dependency-auditor']);
  for (const owner of ['visual-tester', 'security-reviewer']) assert.ok(!fj.skipped_skills.includes(owner), owner);
  assert.doesNotMatch(stderr, /visual_tests=false forced/);
  assert.doesNotMatch(stderr, /security_review=false forced/);
  assert.notEqual(fj.a11y_audit, false);
  assert.notEqual(fj.dependency_audit, false);
});

test('F1: owner alone does not keep the other alias flag', () => {
  const { fj } = init(['visual-tester']);
  assert.equal(fj.a11y_audit, false);
  assert.equal(fj.dependency_audit, false);
});

test('F1: docs dispatch audit modes on their own flags', () => {
  assert.match(LIFECYCLE, /visual-tester if visual_tests or \(a11y_audit && has_ui\)/);
  assert.match(LIFECYCLE, /security-reviewer if security_review or dependency_audit/);
  assert.match(ORCH, /a11y-only when `a11y_audit && has_ui`/);
  assert.match(ORCH, /dependency-audit-only when `dependency_audit`/);
});

test('F11: mixed tasks resolve frontend-dev model override', () => {
  const task = { tag: 'mixed', size: 'M', touches: ['src/**'] };
  assert.equal(modelLine(task, { models: { 'frontend-dev': 'opus' } }), 'opus (override)');
  assert.equal(modelLine(task, { models: { 'backend-dev': 'opus' } }), 'sonnet (default)');
  assert.equal(modelLine(task, { models: { 'frontend-dev': 'opus' }, skipped_skills: ['frontend-dev'] }), 'sonnet (default)');
});

test('F11: legacy alias model keys resolve to the owner', () => {
  const task = { tag: 'backend', size: 'M', touches: ['db/**'] };
  assert.equal(modelLine(task, { models: { 'db-migrator': 'haiku' } }), 'haiku (override)');
  assert.equal(modelLine(task, { models: { 'backend-dev': 'opus', 'db-migrator': 'haiku' } }), 'opus (override)');
});
