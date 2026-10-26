import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateProfile } from '../plugin/scripts/lib/profile.mjs';
import { PLUGIN_ROOT, rootFor } from './helpers.mjs';

// Doc checks for tdd mode (AC18-AC21). Read-only over the repo tree.
const ROOT = PLUGIN_ROOT;
const rd = (p) => fs.readFileSync(path.join(rootFor(p), p), 'utf8');

test('AC18: lifecycle.md lists tdd twice and stays under the cap', () => {
  const s = rd('skills/playbook/references/lifecycle.md');
  assert.match(s, /`owner_blocking`, `tdd`; any other key/);
  assert.match(s, /`owner_blocking`, `tdd`, discovery depth/);
  assert.ok(fs.statSync(path.join(ROOT, 'skills/playbook/references/lifecycle.md')).size <= 29105);
});

test('AC19: README tdd bullet and interview_defaults sentence', () => {
  const s = rd('README.md');
  const bullet = s.split('\n').find((l) => l.startsWith('- `tdd`'));
  assert.ok(bullet, 'tdd bullet');
  assert.match(bullet, /interview_defaults/);
  assert.match(bullet, /feature set/);
  assert.match(bullet, /audit/);
  assert.match(s, /`interview_defaults` accepts[^\n]*`tdd`/);
});

test('AC20: README profile JSON example has tdd and validates (L9)', () => {
  const s = rd('README.md');
  const sec = s.slice(s.indexOf('## Project profile'));
  const m = sec.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'json block');
  const profile = JSON.parse(m[1]);
  assert.equal(profile.interview_defaults.tdd, true);
  const { errors } = validateProfile(profile);
  assert.deepEqual(errors, []);
});

test('AC21: CHANGELOG mentions tdd under Added (release-proof)', () => {
  const s = rd('CHANGELOG.md');
  const secs = s.split(/^## /m).filter((x) => /^\[(Unreleased|\d+\.\d+\.\d+)\]/.test(x));
  const ok = secs.some((sec) => {
    const m = sec.match(/### Added\n([\s\S]*?)(?=\n### |$)/);
    return m && /tdd/i.test(m[1]);
  });
  assert.ok(ok);
});
