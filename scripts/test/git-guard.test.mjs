import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'git-guard.mjs');

function run(input, raw = false) {
  const r = spawnSync('node', [GUARD], { input: raw ? input : JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const sub = (command, extra = {}) => ({ agent_id: 'agent-1', tool_name: 'Bash', tool_input: { command }, ...extra });
const denied = (command) => {
  const r = run(sub(command));
  assert.equal(r.code, 0, command);
  assert.ok(r.out, `expected deny: ${command}`);
  const j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /orchestrator/);
};
const allowed = (command) => {
  const r = run(sub(command));
  assert.equal(r.code, 0, command);
  assert.equal(r.out, '', `expected allow: ${command}`);
};

test('AC1: subagent state-changing git verbs are denied', () => {
  for (const c of [
    'git checkout main', 'git switch -c x', 'git reset --hard', 'git restore .', 'git commit -m x',
    'git rebase main', 'git merge x', 'git clean -fd', 'git cherry-pick abc', 'git revert abc', 'git am p.patch',
    'git pull', 'git push origin x', 'git update-ref HEAD abc', 'git stash', 'git stash pop', 'git worktree add ../x',
    'git tag v1', 'git tag -d v1', 'git branch -D x', 'git branch newbranch', 'git branch -m a b',
  ]) denied(c);
});

test('AC2: no agent_id (orchestrator) is always allowed', () => {
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: 'git push' } },
    { agent_id: '', tool_name: 'Bash', tool_input: { command: 'git push' } },
  ]) {
    const r = run(input);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  }
});

test('non-Bash tools and empty commands are ignored', () => {
  assert.equal(run({ agent_id: 'a', tool_name: 'Edit', tool_input: { command: 'git push' } }).out, '');
  assert.equal(run({ agent_id: 'a', tool_name: 'Bash', tool_input: {} }).out, '');
  assert.equal(run({ agent_id: 'a', tool_name: 'Bash' }).out, '');
});

test('AC3: read-only git forms are allowed', () => {
  for (const c of [
    'git status', 'git diff HEAD', 'git log --oneline', 'git show HEAD', 'git branch', 'git branch --list',
    'git branch -a', 'git branch --contains abc', 'git tag', 'git tag -l', 'git stash list', 'git stash show',
    'git worktree list', 'git rev-parse HEAD', 'git ls-files', 'git add -A', 'git fetch', 'echo git push',
    'grep -r "git commit" .', 'ls',
  ]) allowed(c);
});

test('AC4: global options before the verb do not hide it', () => {
  denied('git -C /repo commit -m x');
  denied('git -c user.name=x commit -m y');
  denied('git --git-dir=/x/.git push');
  denied('git --no-pager checkout x');
  denied('/usr/bin/git reset --hard');
  allowed('git -C /repo status');
});

test('AC5: chains with cd, &&, ;, ||, | and newlines are scanned', () => {
  denied('cd /repo && git checkout x');
  denied('ls; git stash');
  denied('false || git reset --hard');
  denied('echo hi | git commit -F -');
  denied('echo a\ngit push');
  denied('echo $(git commit -m x)');
  denied('echo "$(git push)"');
  denied('echo `git push`');
  denied('(git push)');
  allowed('cd /repo && git status && git diff');
});

test('AC6: env prefixes and wrappers do not hide the verb', () => {
  denied('FOO=1 git push');
  denied('A=1 B=2 git commit -m x');
  denied('env git push');
  denied('env -i FOO=1 git push');
  denied('env -u FOO git push');
  denied('command git push');
  denied('bash -c "git push"');
  denied("sh -c 'cd x && git commit -m y'");
  denied('node scripts/dev-cycle.mjs git commit');
  denied('node /p/dev-cycle.mjs ship');
  allowed('node scripts/dev-cycle.mjs status');
});

test('AC7: DEV_CYCLE_GIT_FALLBACK=1 exempts the command it prefixes', () => {
  allowed('DEV_CYCLE_GIT_FALLBACK=1 git commit -m x');
  allowed('  DEV_CYCLE_GIT_FALLBACK=1 git push');
});

test('marker exempts only the single command, not later chain members', () => {
  denied('DEV_CYCLE_GIT_FALLBACK=1 git status; git stash');
  denied('DEV_CYCLE_GIT_FALLBACK=1 git status && git push');
  denied('DEV_CYCLE_GIT_FALLBACK=1 git status\ngit stash');
  denied('DEV_CYCLE_GIT_FALLBACK=1 git status | git commit -F -');
  allowed('DEV_CYCLE_GIT_FALLBACK=1 git commit -m x && git status');
  denied('echo x && DEV_CYCLE_GIT_FALLBACK=1 git checkout a');
});

test('F2: shell keywords and wrappers are transparent prefixes', () => {
  for (const c of [
    'for f in a b; do git checkout $f; done',
    'if true; then git push; fi',
    'if false; then ls; else git stash; fi',
    'while true; do git commit -m x; done',
    'time git push',
    '! git checkout x',
    '{ git stash; }',
    '( git stash )',
    'exec git push',
    'command git push',
    'builtin git push',
    'nohup git push',
    'timeout 5 git push',
    'timeout -s KILL 5 git push',
    'env git stash',
    'env -i FOO=1 git stash',
    'xargs git checkout',
    'xargs -n 1 git checkout',
    'sudo git push',
    'sudo -u bob git push',
    'nice git push',
    'nice -n 5 git push',
    'nice -5 git push',
    "bash -c 'git push'",
    "sh -c 'git push'",
    "bash -c 'bash -c \"git push\"'",
    "timeout 5 bash -c 'git push'",
    "eval 'git push'",
    'sudo env FOO=1 timeout 5 git reset --hard',
  ]) denied(c);
});

test('F2: wrappers around read-only git stay allowed', () => {
  for (const c of ['time git status', 'timeout 5 git log', 'sudo git diff', "bash -c 'git status'", '{ git status; }', 'nice -n 5 git show']) allowed(c);
});

test('malformed or odd input fails open with exit 0 and no output', () => {
  for (const raw of ['', '{not json', 'null', '42', '"str"', '[]']) {
    const r = run(raw, true);
    assert.equal(r.code, 0, JSON.stringify(raw));
    assert.equal(r.out, '', JSON.stringify(raw));
  }
  const r = run(sub('git push', { tool_input: { command: 123 } }));
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('unterminated quotes and substitutions do not crash', () => {
  for (const c of ['echo "unterminated', "echo 'x", 'echo $(git', 'echo `abc']) {
    const r = run(sub(c));
    assert.equal(r.code, 0, c);
  }
});

test('perf: a 10 KB command is handled quickly', () => {
  const big = 'echo ' + 'a'.repeat(5000) + '; ls -la ' + 'b '.repeat(2000) + '&& git push';
  assert.ok(big.length >= 9000);
  const t = Date.now();
  const r = run(sub(big));
  const dt = Date.now() - t;
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('deny'));
  assert.ok(dt < 1500, `took ${dt}ms`);
  const benign = run(sub('echo ' + 'x '.repeat(5000)));
  assert.equal(benign.out, '');
});

test('#43: glued redirects are split off the word', () => {
  for (const c of ['git stash>/dev/null', 'git checkout 2>&1', 'git checkout main 2>/dev/null', 'git push>>log', 'git commit -F<msg', 'git stash 2>&1 >/dev/null', 'git checkout&>/dev/null']) denied(c);
  for (const c of ['git status>/dev/null', 'git stash list 2>/dev/null', 'git tag 2>&1', 'git branch >out.txt', 'git log 2>&1 | head', 'git diff <file']) allowed(c);
  denied('git status >/dev/null; git stash>/dev/null');
});
