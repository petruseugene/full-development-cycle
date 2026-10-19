import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkGitRepo } from './git-helpers.mjs';
import { runCli } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function plan() {
  const list = [1, 2].map((n) => `- [TODO] **Task ${n}** (backend): T${n}`).join('\n');
  const detail = [1, 2].map((n) => `### Task ${n}: T${n}\n**Touches:** \`src/f${n}.mjs\`\n**Depends on:** none`).join('\n\n');
  return `# Plan\n\n## Tasks\n\n${list}\n\n${detail}\n`;
}

function setup(t) {
  const repo = mkGitRepo({ remote: false, files: { 'plan.md': plan() } });
  t.after(() => repo.cleanup());
  const put = (rel, text) => {
    const abs = path.join(repo.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  put('.gitignore', 'node_modules/\n.env\n');
  put('src/f1.mjs', 'f1\n');
  put('src/f2.mjs', 'f2\n');
  put('.dev-cycle/project.json', JSON.stringify({ worktrees: { mode: 'auto', min_group: 2 } }));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'files']);
  put('src/f1.mjs', 'f1 modified\n');
  put('untracked.txt', 'u\n');
  const cli = (...a) => runCli(a, { cwd: repo.root, env: repo.env });
  return { repo, cli };
}

const state = (repo) => ({
  status: repo.git(['status', '--porcelain']),
  head: repo.git(['rev-parse', 'HEAD']),
  staged: repo.git(['diff', '--cached', '--stat']),
  refs: repo.git(['for-each-ref']),
});

test('AC5: start --json isolates under .dev-cycle/worktrees, main untouched, uncommitted files present, no feature folder', (t) => {
  const { repo, cli } = setup(t);
  const before = state(repo);
  const r = cli('worktree', 'start', '--tasks', '1,2', '--json');
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.isolated, true);
  const root = fs.realpathSync(repo.root);
  for (const task of data.tasks) {
    assert.ok(task.path);
    assert.ok(fs.realpathSync(task.path).startsWith(path.join(root, '.dev-cycle', 'worktrees') + path.sep));
    assert.equal(fs.readFileSync(path.join(task.path, 'src/f1.mjs'), 'utf8'), 'f1 modified\n');
    assert.equal(fs.readFileSync(path.join(task.path, 'untracked.txt'), 'utf8'), 'u\n');
    assert.ok(!fs.existsSync(path.join(task.path, path.relative(repo.root, repo.featureDir))));
  }
  assert.deepEqual(state(repo), before);
  assert.equal(cli('worktree', 'remove', '--all').status, 0);
});

test('AC6: info/exclude gets the line once, not duplicated by a second start, no tracked change', (t) => {
  const { repo, cli } = setup(t);
  const tracked = repo.git(['ls-files', '-m']);
  assert.equal(cli('worktree', 'start', '--tasks', '1,2').status, 0);
  const ex = path.join(repo.root, '.git', 'info', 'exclude');
  const count = () => fs.readFileSync(ex, 'utf8').split('\n').filter((l) => l === '/.dev-cycle/worktrees/').length;
  assert.equal(count(), 1);
  assert.equal(cli('worktree', 'remove', '--all').status, 0);
  assert.equal(cli('worktree', 'start', '--tasks', '1,2').status, 0);
  assert.equal(count(), 1);
  assert.equal(repo.git(['ls-files', '-m']), tracked);
  assert.equal(cli('worktree', 'remove', '--all').status, 0);
  assert.equal(repo.git(['worktree', 'list']).trim().split('\n').length, 1);
});

test('AC24: worktrees.md content and orchestrator reference', () => {
  const w = rd('skills/orchestrator/references/worktrees.md');
  for (const k of ['worktree start', 'worktree collect', 'worktree remove --all', 'stray']) assert.ok(w.includes(k), k);
  assert.ok(rd('skills/orchestrator/SKILL.md').includes('references/worktrees.md'));
});

test('AC25: dev skills carry a Worktree paragraph; lint-skills passes', () => {
  for (const s of ['frontend-dev', 'backend-dev']) {
    const t = rd(`skills/${s}/SKILL.md`);
    assert.match(t, /Worktree/);
    assert.ok(t.includes('cd <abs>'), s);
    assert.ok(t.includes('--feature'), s);
  }
  const r = spawnSync('bash', [path.join(REPO, 'scripts', 'lint-skills.sh')], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stdout.slice(-300) + r.stderr.slice(-300));
});

test('AC26: git-guard still denies subagent worktree add/remove, allows list', () => {
  const guard = path.join(REPO, 'scripts', 'git-guard.mjs');
  const run = (command) => spawnSync('node', [guard], {
    input: JSON.stringify({ agent_id: 'a', tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
  });
  for (const c of ['git worktree add ../x', 'git worktree remove ../x', 'git worktree prune']) {
    assert.match(run(c).stdout, /deny/, c);
  }
  assert.equal(run('git worktree list').stdout, '');
});

test('AC27: project profile, README and CHANGELOG', () => {
  assert.ok(['off', 'audit', 'auto'].includes(JSON.parse(rd('.dev-cycle/project.json')).worktrees.mode));
  const readme = rd('README.md');
  assert.ok(readme.includes('worktrees.mode') && readme.includes('worktree collect'));
  const cl = rd('CHANGELOG.md');
  const heads = cl.split('\n').filter((l) => l.startsWith('## '));
  assert.match(heads[0], /^## \[(Unreleased|\d+\.\d+\.\d+)\]/);
  const sec = cl.split(/^## /m)[1];
  assert.match(sec.slice(sec.indexOf('### Added')), /worktree/);
});
