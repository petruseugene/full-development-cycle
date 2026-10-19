import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkGitRepo } from './git-helpers.mjs';
import { runCli } from './helpers.mjs';

function plan(tasks) {
  const list = tasks.map((t) => `- [${t.status ?? 'TODO'}] **Task ${t.n}** (${t.tag ?? 'backend'}): T${t.n}`).join('\n');
  const detail = tasks.map((t) => [
    `### Task ${t.n}: T${t.n}`,
    `**Touches:** ${t.touches.map((x) => `\`${x}\``).join(', ')}`,
    '**Depends on:** none',
  ].join('\n')).join('\n\n');
  return `# Plan\n\n## Tasks\n\n${list}\n\n${detail}\n`;
}

const TASKS = [
  { n: 1, touches: ['src/one.mjs'] },
  { n: 2, touches: ['src/two.mjs'] },
];

function setup(t, { worktrees, tasks = TASKS } = {}) {
  const repo = mkGitRepo({ remote: false, files: { 'plan.md': plan(tasks) } });
  t.after(() => repo.cleanup());
  repo.put = (rel, text, mode) => {
    const abs = path.join(repo.root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    if (mode) fs.chmodSync(abs, mode);
  };
  repo.get = (rel) => fs.readFileSync(path.join(repo.root, rel), 'utf8');
  repo.cli = (...args) => runCli(args, { cwd: repo.root, env: repo.env });
  repo.json = (...args) => {
    const r = repo.cli(...args, '--json');
    return { ...r, data: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  repo.manifestFile = path.join(repo.root, '.git', 'dev-cycle', 'worktrees.json');
  repo.history = () => JSON.parse(fs.readFileSync(path.join(repo.featureDir, 'feature.json'), 'utf8')).history;
  repo.put('.gitignore', 'node_modules/\n.env\n');
  repo.put('a.txt', 'a0\n');
  repo.put('src/one.mjs', 'one0\n');
  repo.put('src/two.mjs', 'two0\n');
  repo.put('gone.txt', 'gone\n');
  repo.put('node_modules/pkg/index.js', 'pkg\n');
  repo.put('.env', 'SECRET=1\n');
  if (worktrees !== undefined) repo.put('.dev-cycle/project.json', JSON.stringify({ worktrees }));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'files']);
  return repo;
}

const AUTO = { mode: 'auto', min_group: 2 };
const wtList = (repo) => repo.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));

function started(repo, tasks = '1,2') {
  const r = repo.json('worktree', 'start', '--tasks', tasks);
  assert.equal(r.status, 0, r.stderr);
  return r.data;
}
const pathOf = (data, n) => data.tasks.find((t) => t.n === n).path;
const put = (data, n, rel, text, mode) => {
  const abs = path.join(pathOf(data, n), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  if (mode) fs.chmodSync(abs, mode);
};

test('AC4: mode absent exits 2 and a normal run leaves no worktree artefacts', (t) => {
  const repo = setup(t);
  const r = repo.cli('worktree', 'start', '--tasks', '1');
  assert.equal(r.status, 2);
  assert.equal(repo.cli('groups', '--all', '--json').status, 0);
  assert.equal(repo.cli('history', 'add', '--phase', 'implement.task=1', '--subagent', 'backend-dev', '--status', 'DONE').status, 0);
  repo.cli('check', '--scope', 'touched', '--files', 'a.txt');
  repo.cli('report', '--no-network');
  assert.ok(!fs.existsSync(path.join(repo.root, '.dev-cycle', 'worktrees')));
  assert.ok(!fs.existsSync(repo.manifestFile));
  assert.ok(!repo.history().some((e) => e.phase === 'worktree'));
  const off = setup(t, { worktrees: { mode: 'off' } });
  assert.equal(off.cli('worktree', 'start', '--tasks', '1,2').status, 2);
});

test('AC7/AC11/AC16: link, copy, collect applies bytes + exec bit and leaves nothing', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const data = started(repo);
  assert.equal(data.isolated, true);
  const nm = path.join(pathOf(data, 1), 'node_modules');
  assert.ok(fs.lstatSync(nm).isSymbolicLink());
  const env = path.join(pathOf(data, 1), '.env');
  assert.ok(fs.lstatSync(env).isFile() && !fs.lstatSync(env).isSymbolicLink());
  assert.equal(fs.readFileSync(env, 'utf8'), 'SECRET=1\n');

  put(data, 1, 'src/one.mjs', 'one1\n');
  put(data, 2, 'src/two.mjs', 'two1\n');
  put(data, 2, 'tools/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  fs.writeFileSync(env, 'SECRET=changed\n');

  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.data.touches_expanded, { 2: ['tools/run.sh'] });
  assert.equal(repo.get('src/one.mjs'), 'one1\n');
  assert.equal(repo.get('src/two.mjs'), 'two1\n');
  assert.equal(repo.get('tools/run.sh'), '#!/bin/sh\necho hi\n');
  assert.ok((fs.statSync(path.join(repo.root, 'tools/run.sh')).mode & 0o111) !== 0);
  assert.equal(repo.get('.env'), 'SECRET=1\n');
  assert.equal(repo.get('node_modules/pkg/index.js'), 'pkg\n');

  const h = repo.history().filter((e) => e.phase === 'worktree');
  assert.equal(h.filter((e) => e.task !== undefined && e.status === 'APPLIED').length, 2);
  assert.equal(h.filter((e) => e.status === 'ISOLATED').length, 1);
  assert.deepEqual(h.find((e) => e.status === 'ISOLATED').tasks, [1, 2]);

  assert.equal(wtList(repo).length, 1);
  assert.ok(!fs.existsSync(path.join(repo.root, '.dev-cycle', 'worktrees', 'task-1')));
  assert.deepEqual(repo.json('worktree', 'list').data, { active: false });
});

test('AC8: a second start while a manifest is active exits 2 naming collect and remove --all', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  started(repo);
  const r = repo.cli('worktree', 'start', '--tasks', '1,2');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /worktree collect/);
  assert.match(r.stderr, /worktree remove --all/);
  assert.equal(repo.cli('worktree', 'remove', '--all').status, 0);
  assert.equal(wtList(repo).length, 1);
  assert.equal(repo.get('node_modules/pkg/index.js'), 'pkg\n');
  assert.equal(repo.get('.env'), 'SECRET=1\n');
});

test('AC9: below min_group nothing is isolated; content tasks never get a path', (t) => {
  const repo = setup(t, { worktrees: { mode: 'auto', min_group: 3 } });
  const d = started(repo);
  assert.equal(d.isolated, false);
  assert.deepEqual(d.tasks.map((x) => x.path), [null, null]);
  assert.equal(wtList(repo).length, 1);
  assert.equal(repo.json('worktree', 'collect').status, 0);

  const tasks = [...TASKS, { n: 3, tag: 'content', touches: ['docs/x.md'] }];
  const r2 = setup(t, { worktrees: AUTO, tasks });
  const d2 = started(r2, '1,2,3');
  assert.equal(d2.isolated, true);
  assert.equal(pathOf(d2, 3), null);
  assert.ok(pathOf(d2, 1));
  r2.cli('worktree', 'remove', '--all');
});

test('AC12: same file in two tasks -> second conflicts, nothing of it applied', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  put(d, 1, 'a.txt', 'from1\n');
  put(d, 2, 'a.txt', 'from2\n');
  put(d, 2, 'src/two.mjs', 'two1\n');
  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 1);
  assert.deepEqual(r.data.applied.map((a) => a.n), [1]);
  assert.equal(r.data.conflicts[0].n, 2);
  assert.ok(r.data.conflicts[0].paths.some((p) => p.path === 'a.txt'));
  assert.equal(repo.get('a.txt'), 'from1\n');
  assert.equal(repo.get('src/two.mjs'), 'two0\n');
  const c = repo.history().find((e) => e.phase === 'worktree' && e.task === 2);
  assert.equal(c.status, 'CONFLICT');
  assert.equal(wtList(repo).length, 1);
});

test('AC13: a main edit after start conflicts unless identical to the worktree', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  put(d, 1, 'src/one.mjs', 'wt1\n');
  put(d, 2, 'src/two.mjs', 'same\n');
  repo.put('src/one.mjs', 'main-edit\n');
  repo.put('src/two.mjs', 'same\n');
  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 1);
  assert.equal(r.data.conflicts.length, 1);
  assert.equal(r.data.conflicts[0].n, 1);
  assert.equal(repo.get('src/one.mjs'), 'main-edit\n');
  assert.deepEqual(r.data.applied.map((a) => a.n), [2]);
});

test('AC14: a deletion in the worktree is applied to main', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  fs.rmSync(path.join(pathOf(d, 1), 'gone.txt'));
  put(d, 2, 'src/two.mjs', 'two1\n');
  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(repo.root, 'gone.txt')));
});

test('AC15: stray main-tree writes are reported in auto and audit modes', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  put(d, 1, 'src/one.mjs', 'one1\n');
  repo.put('nobody/owns.txt', 'x\n');
  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 1);
  assert.deepEqual(r.data.stray, ['nobody/owns.txt']);

  const audit = setup(t, { worktrees: { mode: 'audit' } });
  const a = started(audit);
  assert.deepEqual(a.tasks.map((x) => x.path), [null, null]);
  assert.equal(wtList(audit).length, 1);
  audit.put('src/one.mjs', 'inside\n');
  audit.put('outside.txt', 'x\n');
  const ar = audit.json('worktree', 'collect');
  assert.equal(ar.status, 1);
  assert.deepEqual(ar.data.stray, ['outside.txt']);
  const g = audit.history().find((e) => e.phase === 'worktree' && Array.isArray(e.tasks));
  assert.equal(g.status, 'AUDIT');
  assert.deepEqual(g.stray, ['outside.txt']);
});

test('AC17: a tampered manifest path is refused and the target survives', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  const victim = path.join(repo.root, 'src');
  const outside = repo.tmpDir();
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'k');
  const tamper = (p1, p2) => {
    const m = JSON.parse(fs.readFileSync(repo.manifestFile, 'utf8'));
    m.tasks[0].path = p1;
    m.tasks[1].path = p2;
    fs.writeFileSync(repo.manifestFile, JSON.stringify(m));
  };
  const real1 = pathOf(d, 1);
  const real2 = pathOf(d, 2);
  tamper(outside, victim);
  const rm = repo.cli('worktree', 'remove', '--all');
  assert.equal(rm.status, 2);
  assert.match(rm.stderr, /refus/);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  assert.ok(fs.existsSync(path.join(victim, 'one.mjs')));

  const repo2 = setup(t, { worktrees: AUTO });
  const d2 = started(repo2);
  const m = JSON.parse(fs.readFileSync(repo2.manifestFile, 'utf8'));
  m.tasks[0].path = path.join(repo2.root, 'src');
  fs.writeFileSync(repo2.manifestFile, JSON.stringify(m));
  put(d2, 2, 'src/two.mjs', 'two1\n');
  const c = repo2.json('worktree', 'collect');
  assert.match(c.stderr, /refusing worktree path/);
  assert.ok(fs.existsSync(path.join(repo2.root, 'src', 'one.mjs')));
  assert.equal(repo2.get('src/two.mjs'), 'two1\n');
  assert.deepEqual(c.data.applied.map((a) => a.n), [2]);
  assert.ok(real1 && real2);
});

test('F9: a manifest with tampered dir + path deletes nothing (remove and collect)', (t) => {
  for (const verb of [['remove', '--all'], ['collect']]) {
    const repo = setup(t, { worktrees: AUTO });
    const d = started(repo);
    repo.put('src/components/c.mjs', 'c\n');
    const m = JSON.parse(fs.readFileSync(repo.manifestFile, 'utf8'));
    m.dir = 'src';
    m.tasks[0].path = path.join(repo.root, 'src', 'components');
    fs.writeFileSync(repo.manifestFile, JSON.stringify(m));
    const r = repo.cli('worktree', ...verb);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /differs from the profile/);
    assert.ok(fs.existsSync(path.join(repo.root, 'src', 'components', 'c.mjs')));
    assert.ok(fs.existsSync(pathOf(d, 1)));
    assert.ok(fs.existsSync(repo.manifestFile));
  }
});

test('F9: a plain directory under the real dir is not removed even with a matching dir', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  const fake = path.join(repo.root, '.dev-cycle', 'worktrees', 'task-50');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'keep'), 'k');
  const m = JSON.parse(fs.readFileSync(repo.manifestFile, 'utf8'));
  m.tasks[0].path = fake;
  fs.writeFileSync(repo.manifestFile, JSON.stringify(m));
  const r = repo.cli('worktree', 'remove', '--all');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a linked worktree/);
  assert.ok(fs.existsSync(path.join(fake, 'keep')));
  assert.ok(pathOf(d, 2));
});

test('F6: list on a corrupt manifest exits 0 and points to remove --all; F8: manifest uses links/copies', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  started(repo);
  const m = JSON.parse(fs.readFileSync(repo.manifestFile, 'utf8'));
  assert.deepEqual(m.tasks[0].links, ['node_modules']);
  assert.deepEqual(m.tasks[0].copies, ['.env']);
  assert.ok(!('linked' in m.tasks[0]) && !('copied' in m.tasks[0]));
  fs.writeFileSync(repo.manifestFile, '{not json');
  const l = repo.json('worktree', 'list');
  assert.equal(l.status, 0, l.stderr);
  assert.equal(l.data.active, true);
  assert.equal(l.data.corrupt, true);
  assert.match(l.data.hint, /remove --all/);
  assert.equal(repo.cli('worktree', 'remove', '--all').status, 0);
});

test('F5: collect history follows R12 (file counts, CONFLICT touches_expanded, REFUSED, executor)', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  put(d, 1, 'src/one.mjs', 'one1\n');
  put(d, 1, 'extra.txt', 'x\n'); // outside Touches
  put(d, 2, 'src/two.mjs', 'two1\n');
  repo.put('src/two.mjs', 'main-changed\n'); // makes task 2 conflict
  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 1);
  const h = repo.history().filter((e) => e.phase === 'worktree');
  const a = h.find((e) => e.task === 1);
  assert.equal(a.status, 'APPLIED');
  assert.equal(a.files, 2);
  assert.deepEqual(a.touches_expanded, ['extra.txt']);
  const c = h.find((e) => e.task === 2);
  assert.equal(c.status, 'CONFLICT');
  assert.equal(c.files, 0);
  assert.ok(Array.isArray(c.touches_expanded));
  assert.ok(c.conflicts.length > 0);
  const g = h.find((e) => Array.isArray(e.tasks));
  assert.equal(g.status, 'ISOLATED');
  assert.ok(h.every((e) => e.executor === 'cli'));
});

test('AC18: a symlink created in a worktree is a conflict, not applied', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  fs.symlinkSync('/etc/passwd', path.join(pathOf(d, 1), 'evil'));
  put(d, 1, 'src/one.mjs', 'one1\n');
  put(d, 2, 'src/two.mjs', 'two1\n');
  const r = repo.json('worktree', 'collect');
  assert.equal(r.status, 1);
  const c = r.data.conflicts.find((x) => x.n === 1);
  assert.ok(c.paths.some((p) => p.path === 'evil' && p.reason === 'symlink'));
  assert.ok(!fs.existsSync(path.join(repo.root, 'evil')));
  assert.equal(repo.get('src/one.mjs'), 'one0\n');
  assert.equal(repo.get('src/two.mjs'), 'two1\n');
});

test('AC19: remove --task keeps the manifest; remove --all clears it', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  const r = repo.json('worktree', 'remove', '--task', '2');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(pathOf(d, 2)));
  assert.ok(fs.existsSync(pathOf(d, 1)));
  const l = repo.json('worktree', 'list');
  assert.equal(l.data.active, true);
  assert.equal(l.data.tasks.find((x) => x.n === 2).path, null);
  assert.equal(l.data.tasks.find((x) => x.n === 2).removed, true);
  assert.equal(repo.cli('worktree', 'remove', '--task', '9').status, 2);
  assert.equal(repo.cli('worktree', 'remove', '--all').status, 0);
  assert.deepEqual(repo.json('worktree', 'list').data, { active: false });
  assert.equal(wtList(repo).length, 1);
  assert.equal(repo.cli('worktree', 'remove', '--all').status, 2);
});

test('AC28: usage errors exit 2 and --json output is valid', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  assert.equal(repo.cli('worktree').status, 2);
  assert.equal(repo.cli('worktree', 'bogus').status, 2);
  assert.equal(repo.cli('worktree', 'start').status, 2);
  assert.equal(repo.cli('worktree', 'start', '--tasks', '99').status, 2);
  assert.equal(repo.cli('worktree', 'start', '--tasks', 'x').status, 2);
  assert.equal(repo.cli('worktree', 'collect').status, 2);
  assert.equal(repo.cli('worktree', 'remove').status, 2);
  for (const args of [['list'], ['start', '--tasks', '1,2'], ['list'], ['collect'], ['list']]) {
    const r = repo.cli('worktree', ...args, '--json');
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  }
});

test('a [DONE] task is rejected', (t) => {
  const repo = setup(t, { worktrees: AUTO, tasks: [{ ...TASKS[0], status: 'DONE' }, TASKS[1]] });
  assert.equal(repo.cli('worktree', 'start', '--tasks', '1,2').status, 2);
});

test('a failing setup rolls everything back: exit 1, no manifest, no worktrees', (t) => {
  const repo = setup(t, { worktrees: { ...AUTO, setup: 'node -e "process.exit(3)"' } });
  const r = repo.cli('worktree', 'start', '--tasks', '1,2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /task 1/);
  assert.ok(!fs.existsSync(repo.manifestFile));
  assert.equal(wtList(repo).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(repo.root, '.dev-cycle', 'worktrees')), []);
});

test('cwd inside a worktree works with --feature', (t) => {
  const repo = setup(t, { worktrees: AUTO });
  const d = started(repo);
  const r = runCli(['worktree', 'list', '--json', '--feature', repo.featureDir], { cwd: pathOf(d, 1), env: repo.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).active, true);
  repo.cli('worktree', 'remove', '--all');
});
