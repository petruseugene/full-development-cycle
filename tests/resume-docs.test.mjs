import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../plugin/scripts/lib/profile.mjs';
import { PLUGIN_ROOT, rootFor } from './helpers.mjs';

const ROOT = PLUGIN_ROOT;
const rd = (p) => fs.readFileSync(path.join(rootFor(p), p), 'utf8');
const size = (p) => fs.statSync(path.join(rootFor(p), p)).size;
const CLI = path.join(ROOT, 'scripts/dev-cycle.mjs');

test('AC26: orchestrator docs mention resume within size caps', () => {
  const skill = rd('skills/orchestrator/SKILL.md');
  assert.ok(size('skills/orchestrator/SKILL.md') <= 18765);
  assert.ok(skill.includes('references/resume.md') || skill.includes('`resume.md`'));
  assert.ok(skill.includes('feature resume'));
  const r = rd('skills/orchestrator/references/resume.md');
  assert.ok(size('skills/orchestrator/references/resume.md') <= 2500);
  for (const s of ['feature resume --feature', '--agent-id', 'no --agent-id', 'strict_tokens']) assert.ok(r.includes(s), s);
  const q = rd('skills/orchestrator/references/quick.md');
  assert.ok(size('skills/orchestrator/references/quick.md') <= 8192);
  assert.ok(q.includes('feature resume'));
});

test('AC27: README row, strict_tokens key and example validate', () => {
  const readme = rd('README.md');
  assert.ok(readme.includes('`feature resume [--json]`'));
  const sentence = readme.split('\n').find((l) => l.startsWith('Optional file `.dev-cycle/project.json`') || l.includes('Allowed top-level keys'));
  assert.ok(sentence.includes('`strict_tokens`'));
  const m = readme.match(/### `profile\.strict_tokens`[\s\S]*?```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'strict_tokens example missing');
  const ex = JSON.parse(m[1]);
  assert.deepEqual(ex, { strict_tokens: true });
  const res = validateProfile(ex);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
});

test('AC27: resume.md example runs through the real CLI', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rdocs-')));
  try {
    spawnSync('git', ['init', '-q'], { cwd: proj });
    const init = spawnSync('node', [CLI, 'feature', 'init', 'demo', '--flow', 'feature', '--track', 'quick'], { cwd: proj, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const dir = init.stdout.trim().split('\n').pop().trim();
    assert.ok(fs.existsSync(path.join(dir, 'feature.json')), dir);
    const text = rd('skills/orchestrator/references/resume.md');
    const line = text.split('\n').find((l) => l.startsWith('node "$CLI" feature resume --feature '));
    assert.ok(line, 'example line missing');
    const args = line.replace('node "$CLI" ', '').replace('<abs feature dir>', dir).split(' ');
    const r = spawnSync('node', [CLI, ...args], { cwd: proj, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^feature: /);
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('AC28: CHANGELOG records the feature in any release section', () => {
  const cl = rd('CHANGELOG.md');
  const sections = cl.split(/^## /m).filter((s) => /^(\[Unreleased\]|\[\d+\.\d+\.\d+\])/.test(s));
  assert.ok(sections.some((s) => s.includes('feature resume') && s.includes('strict_tokens') && s.includes('no --agent-id')));
});
