// Coverage for cost-cuts ACs that had no direct test: hook (AC1-AC8), AC11, AC18 spec-writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PLUGIN_ROOT, rootFor } from './helpers.mjs';

const GUARD = `${PLUGIN_ROOT}/scripts/git-guard.mjs`;
const read = (p) => fs.readFileSync(`${rootFor(p)}/${p}`, 'utf8');

function guard(stdin, agent = true) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify({
    tool_name: 'Bash', tool_input: { command: stdin.cmd }, ...(agent ? { agent_id: 'a1' } : {}),
  });
  const r = spawnSync('node', [GUARD], { input, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: r.stdout };
}
const cmd = (c, agent = true) => guard({ cmd: c }, agent);
const denied = (c) => {
  const r = cmd(c);
  assert.equal(r.status, 0, c);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny', c);
};
const allowed = (c) => {
  const r = cmd(c);
  assert.equal(r.status, 0, c);
  assert.equal(r.out, '', c);
};

test('AC1: hooks.json keeps SessionStart and adds PreToolUse Bash -> git-guard.mjs', () => {
  const h = JSON.parse(read('hooks/hooks.json')).hooks;
  assert.ok(h.SessionStart[0].hooks[0].command.includes('session-start.sh'));
  const pre = h.PreToolUse.find((e) => e.matcher === 'Bash');
  assert.match(pre.hooks[0].command, /scripts\/git-guard\.mjs/);
});

test('AC2: no agent_id passes silently; agent_id denies', () => {
  const a = cmd('git stash', false);
  assert.equal(a.status, 0);
  assert.equal(a.out, '');
  const b = cmd('git stash');
  assert.equal(JSON.parse(b.out).hookSpecificOutput.permissionDecision, 'deny');
});

test('AC3: state-changing git and CLI verbs are denied for agents', () => {
  for (const c of ['git stash', 'git stash push -m x', 'git stash pop', 'git checkout main', 'git checkout -- a.ts',
    'git switch x', 'git reset --hard', 'git restore a.ts', 'git commit -m x', 'git rebase main', 'git merge x',
    'git clean -fd', 'git cherry-pick abc', 'git revert abc', 'git am p.patch', 'git pull', 'git push',
    'git branch -D x', 'git branch --move a b', 'git worktree add ../w', 'git tag v1',
    'node /p/scripts/dev-cycle.mjs git commit', 'node scripts/dev-cycle.mjs ship']) denied(c);
});

test('AC4: compound and wrapped forms are denied', () => {
  for (const c of ['cd src && git stash', 'true; git reset --hard', 'false || git checkout x', 'echo | git commit -F -',
    'git -C ../x stash', 'git -c core.x=1 checkout x', 'FOO=1 git stash', 'env A=1 git stash', 'command git switch x',
    '(git stash)', 'echo $(git stash)', "bash -c 'git stash'", '/usr/bin/git reset']) denied(c);
});

test('AC5: read-only git and lookalike text are allowed', () => {
  for (const c of ['git status', 'git diff HEAD', 'git log -5', 'git show x', 'git blame f', 'git ls-files',
    'git rev-parse HEAD', 'git grep x', 'git stash list', 'git stash show', 'git branch', 'git branch -a',
    'git tag -l', 'git rm a.ts', 'echo "git stash"', "grep 'git reset' f", 'npm test']) allowed(c);
});

test('AC6: fallback marker only at the very start', () => {
  allowed('DEV_CYCLE_GIT_FALLBACK=1 git checkout --theirs a.ts');
  denied('echo x && DEV_CYCLE_GIT_FALLBACK=1 git checkout a');
});

test('AC7: hook fails open', () => {
  for (const s of ['not json', '', JSON.stringify({ tool_name: 'Read', tool_input: { command: 'git stash' }, agent_id: 'a1' }),
    JSON.stringify({ tool_name: 'Bash', tool_input: {}, agent_id: 'a1' })]) {
    const r = guard(s);
    assert.equal(r.status, 0);
    assert.equal(r.out, '');
  }
});

test('AC8: deny reason names verb, "do not retry", orchestrator', () => {
  const reason = JSON.parse(cmd('git stash').out).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /stash/);
  assert.match(reason, /do not retry/i);
  assert.match(reason, /orchestrator/i);
  assert.match(read('scripts/git-guard.mjs'), /not a security boundary/);
});

test('AC11: project test command is quiet; dev skills use check --scope touched and ban pasting output', () => {
  assert.match(JSON.parse(read('.dev-cycle/project.json')).commands.test, /--test-reporter=dot/);
  for (const s of ['frontend-dev', 'backend-dev', 'auto-tester']) {
    const t = read(`skills/${s}/SKILL.md`);
    assert.match(t, /check --scope touched/, s);
    assert.match(t, /never paste full test/, s);
  }
});

test('AC18: spec-writer threat-look checklist and section name', () => {
  const t = read('skills/spec-writer/SKILL.md');
  assert.match(t, /## Threat notes/);
  for (const w of ['exec/shell', 'paths', 'auth', 'network', 'secrets', 'device control']) {
    assert.match(t, new RegExp(w.replace('/', '\\/'), 'i'), w);
  }
});
