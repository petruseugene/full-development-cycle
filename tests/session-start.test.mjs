import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT } from './helpers.mjs';

const REPO = fs.realpathSync(PLUGIN_ROOT);

test('AC12: primer.md is small and has the required routes', () => {
  const p = path.join(REPO, 'skills/using-dev-cycle/primer.md');
  assert.ok(fs.statSync(p).size <= 900);
  const t = fs.readFileSync(p, 'utf8');
  for (const s of ['{{ROOT}}', 'dev-cycle:orchestrator', 'dev-cycle:architector', '/dev-cycle:dashboard']) {
    assert.ok(t.includes(s), s);
  }
});

test('AC13: session-start emits resolved primer JSON', () => {
  const r = spawnSync('bash', [path.join(REPO, 'scripts/session-start.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  const ctx = out.additionalContext;
  assert.ok(ctx.includes(`${REPO}/skills/`));
  for (const bad of ['{{ROOT}}', '${CLAUDE_PLUGIN_ROOT}', '<SUBAGENT-STOP>', '## Output contract']) {
    assert.ok(!ctx.includes(bad), bad);
  }
  assert.ok(ctx.split('\n')[0].length <= 120);
  const n = ctx.split(REPO).length - 1;
  assert.ok(ctx.length - REPO.length * n <= 1050, `${ctx.length}`);
});

test('AC14: missing primer => silent exit 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.mkdirSync(path.join(tmp, 'skills/using-dev-cycle'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'scripts/session-start.sh'), path.join(tmp, 'scripts/session-start.sh'));
    const r = spawnSync('bash', [path.join(tmp, 'scripts/session-start.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
