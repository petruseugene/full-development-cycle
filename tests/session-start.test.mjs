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
  const r = spawnSync('bash', [path.join(REPO, 'scripts/session-start.sh')], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO } });
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
    fs.copyFileSync(path.join(REPO, 'scripts/session-start.py'), path.join(tmp, 'scripts/session-start.py'));
    const r = spawnSync('bash', [path.join(tmp, 'scripts/session-start.sh')], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: tmp } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validator: session-start.sh and hooks.json have no computed paths or inline programs', () => {
  const sh = fs.readFileSync(path.join(REPO, 'scripts/session-start.sh'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!sh.includes('$('), 'command substitution');
  assert.ok(!sh.includes('`'), 'backtick');
  assert.ok(!/\s-[ce]\s/.test(sh), 'inline interpreter program');
  assert.ok(!/[*?]|\{[^}$]*,[^}]*\}/.test(sh.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '')), 'glob or brace');
  for (const m of sh.matchAll(/\$\{[^}]*\}/g)) assert.equal(m[0], '${CLAUDE_PLUGIN_ROOT}');
  assert.ok(!/\$[A-Za-z_]/.test(sh), 'bare variable');
  assert.ok(sh.includes('"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.py"'));
  assert.ok(fs.existsSync(path.join(REPO, 'scripts/session-start.py')));
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const group of Object.values(hooks)) for (const g of group) for (const h of g.hooks) {
    const c = h.command;
    assert.ok(!c.includes('$(') && !c.includes('`'), c);
    assert.ok(!/\s-[ce]\s/.test(c), c);
    for (const m of c.matchAll(/\$\{[^}]*\}/g)) assert.equal(m[0], '${CLAUDE_PLUGIN_ROOT}', c);
  }
});

test('validator: unset or empty CLAUDE_PLUGIN_ROOT => silent exit 0', () => {
  for (const v of [undefined, '']) {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    if (v !== undefined) env.CLAUDE_PLUGIN_ROOT = v;
    const r = spawnSync('bash', [path.join(REPO, 'scripts/session-start.sh')], { encoding: 'utf8', env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

function copyPlugin(dst) {
  fs.mkdirSync(path.join(dst, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'skills/using-dev-cycle'), { recursive: true });
  for (const f of ['scripts/session-start.sh', 'scripts/session-start.py', 'skills/using-dev-cycle/primer.md']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dst, f));
  }
}
const runHook = (root) => spawnSync('bash', [path.join(root, 'scripts/session-start.sh')], {
  encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
});

test('validator: symlinked CLAUDE_PLUGIN_ROOT resolves to realpath in {{ROOT}}', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-link-')));
  try {
    copyPlugin(path.join(tmp, 'real'));
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    const r = runHook(path.join(tmp, 'link'));
    assert.equal(r.status, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('{{ROOT}}'));
    assert.ok(ctx.includes(path.join(tmp, 'real')));
    assert.ok(!ctx.includes(path.join(tmp, 'link')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validator: plugin root with spaces still emits the primer', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss sp-')));
  try {
    const root = path.join(tmp, 'my plugin');
    copyPlugin(root);
    const r = runHook(root);
    assert.equal(r.status, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(root) && !ctx.includes('{{ROOT}}'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
