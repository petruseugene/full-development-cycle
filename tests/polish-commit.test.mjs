// Polish track: one commit per item (AC13-AC20). Fixtures are temp git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sampleFeatureJson, DEFAULT_FEATURE, mkCtx } from './helpers.mjs';
import { installSpawnRecorder, mkGitRepo, readFj } from './git-helpers.mjs';
import { run } from '../plugin/scripts/lib/cmd-git.mjs';
import { CliError } from '../plugin/scripts/lib/core.mjs';
import { buildPolishMessages } from '../plugin/scripts/lib/git-message.mjs';
import { parseItems } from '../plugin/scripts/lib/polish.mjs';

const T = { timeout: 60_000 };

/** Hand-written polish.md in the R3 format. items: [{ title, touches, tag?, status?, deferred? }] */
function polishMd(items) {
  const tagOf = (i) => `${i.tag ?? 'backend'}${i.deferred ? ', deferred' : ''}`;
  const out = ['---', 'feature: sample', 'created: 2026-01-01 00:00', 'status: [TODO]', 'flow: feature', 'track: polish', '---', '',
    '# Polish batch — sample', '', '## Tasks'];
  items.forEach((i, k) => out.push(`- [${i.status ?? 'IMPL-DONE'}] **Task ${k + 1}** (${tagOf(i)}): ${i.title}`));
  items.forEach((i, k) => {
    out.push('', `### Task ${k + 1}`, `**Item:** P${k + 1}`, '**Area:** a', `**Touches:** ${i.touches.map((t) => `\`${t}\``).join(', ')}`);
    if (i.deferred) out.push(`**Deferred:** ${i.deferred}`);
  });
  return `${out.join('\n')}\n`;
}

const ITEMS = [
  { title: 'Home title clipped', touches: ['src/a.ts'] },
  { title: 'Settings colour', touches: ['src/b.ts'] },
];

function mkRepo(items = ITEMS, { over = {}, ignoreFeatures = false, baseline } = {}) {
  const repo = mkGitRepo({
    featureJson: sampleFeatureJson({ track: 'polish', branch: 'feat/sample', ...over }),
    files: { 'polish.md': polishMd(items) },
  });
  if (ignoreFeatures) {
    repo.write('.gitignore', 'docs/features/\n');
    repo.git(['add', '-A']);
    repo.git(['rm', '-r', '-q', '--cached', 'docs/features']);
    repo.git(['commit', '-q', '-m', 'ignore features']);
  }
  repo.git(['checkout', '-q', '-b', 'feat/sample']);
  if (baseline) {
    const fjFile = path.join(repo.featureDir, 'feature.json');
    const fj = JSON.parse(fs.readFileSync(fjFile, 'utf8'));
    fj.untracked_baseline = baseline;
    fs.writeFileSync(fjFile, JSON.stringify(fj, null, 2));
  }
  return repo;
}

async function gitCommit(repo, argv, extraEnv = {}, cwd = null) {
  const ctx = cwd ? mkCtx({ cwd, env: { ...repo.env, ...extraEnv } }) : repo.ctx(extraEnv);
  const rec = installSpawnRecorder();
  try {
    let code;
    let usage = '';
    try {
      code = await run(['commit', ...argv], ctx);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      code = err.exitCode;
      usage = err.message;
    }
    rec.assertNoForbidden();
    return { code, out: ctx.out(), err: ctx.err() + usage, calls: rec.calls, gitCalls: rec.gitCalls() };
  } finally { rec.restore(); }
}

const files = (repo, rev) => repo.git(['show', '--name-only', '--format=', rev]).split('\n').filter(Boolean).sort();
const subjects = (repo, base = 'main') => repo.git(['log', '--reverse', '--format=%s', `${base}..HEAD`]).split('\n').filter(Boolean);
const rel = (name) => `docs/features/${DEFAULT_FEATURE}/${name}`;

test('AC13: one commit per item, each with only its own paths', T, async () => {
  const repo = mkRepo();
  try {
    repo.write('src/a.ts', 'a\n');
    repo.write('src/b.ts', 'b\n');
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 0, r.err);
    const subs = subjects(repo);
    assert.deepEqual(subs.slice(0, 2), ['fix(src): P1 Home title clipped', 'fix(src): P2 Settings colour']);
    assert.equal(subs.length, 3, 'two item commits plus the batch commit');
    assert.deepEqual(files(repo, 'HEAD~2'), ['src/a.ts']);
    assert.deepEqual(files(repo, 'HEAD~1'), ['src/b.ts']);
    assert.match(repo.git(['log', '-1', '--format=%B', 'HEAD~2']), new RegExp(`Refs: ${rel('polish.md')}`));
    assert.equal(r.out.trim().split('\n').length, 3);
    assert.equal(repo.git(['status', '--porcelain']), '');
    // no git call stages without an explicit pathspec
    for (const a of r.gitCalls.filter((c) => c[0] === 'add')) assert.ok(a.includes('--') && a.indexOf('--') < a.length - 1, a.join(' '));
  } finally { repo.cleanup(); }
});

test('AC14: items sharing a path get one combined commit', T, async () => {
  const repo = mkRepo([
    { title: 'Colour A', touches: ['src/theme.ts'] },
    { title: 'Other', touches: ['src/b.ts'] },
    { title: 'Colour B', touches: ['src/theme.ts'] },
  ]);
  try {
    repo.write('src/theme.ts', 't\n');
    repo.write('src/b.ts', 'b\n');
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 0, r.err);
    const subs = subjects(repo);
    assert.deepEqual(subs.slice(0, 2), ['fix(src): P1+P3 Colour A', 'fix(src): P2 Other']);
    assert.ok(!subs.some((s) => /^fix\(src\): P3 /.test(s)));
    assert.match(repo.git(['log', '-1', '--format=%B', 'HEAD~2']), /^Combined: P1, P3 share src\/theme\.ts$/m);
  } finally { repo.cleanup(); }
});

test('AC15: unassigned tracked file lands in the batch commit; baseline untracked stays untracked; new matched file is in its item', T, async () => {
  const repo = mkRepo(ITEMS, { baseline: ['notes.txt'] });
  try {
    repo.write('README.md', 'old\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'readme']);
    repo.write('README.md', 'new\n');
    repo.write('notes.txt', 'mine\n');
    repo.write('src/a.ts', 'new file\n'); // untracked, matched by P1
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /unassigned → batch commit/);
    assert.deepEqual(files(repo, 'HEAD~1'), ['src/a.ts']);
    assert.match(repo.git(['log', '-1', '--format=%B']), /Other changes:\n- README\.md/);
    assert.ok(files(repo, 'HEAD').includes('README.md'));
    assert.equal(repo.git(['status', '--porcelain']), '?? notes.txt');
    assert.match(r.err, /P2 has no changed paths/);
  } finally { repo.cleanup(); }
});

test('AC16: batch commit flips items and frontmatter, lists Items and Deferred; ignored folder → --closes on the last item commit', T, async () => {
  const repo = mkRepo([
    { title: 'One', touches: ['src/a.ts'] },
    { title: 'Two', touches: ['src/b.ts'], deferred: 'needs new API', tag: 'backend', status: 'TODO' },
  ]);
  try {
    repo.write('src/a.ts', 'a\n');
    const r = await gitCommit(repo, ['--closes', '27']);
    assert.equal(r.code, 0, r.err);
    const text = repo.git(['show', `HEAD:${rel('polish.md')}`]);
    assert.match(text, /^- \[DONE\] \*\*Task 1\*\*/m);
    assert.match(text, /^- \[TODO\] \*\*Task 2\*\* \(backend, deferred\)/m, 'deferred item untouched');
    assert.match(text, /^status: \[DONE\]$/m);
    const hist = JSON.parse(repo.git(['show', `HEAD:${rel('feature.json')}`])).history.at(-1);
    assert.equal(hist.phase, 'git');
    assert.equal(hist.summary, 'feature commit');
    const body = repo.git(['log', '-1', '--format=%B']);
    assert.match(body, /^chore\(polish\): close batch P1–P2$/m);
    assert.match(body, /Items:\n- P1: One \(DONE\)/);
    assert.match(body, /Deferred:\n- P2: Two — needs new API/);
    assert.match(body, /Closes #27/);
    assert.ok(!/Closes #27/.test(repo.git(['log', '-1', '--format=%B', 'HEAD~1'])), 'closes only on the last commit');
  } finally { repo.cleanup(); }

  const ign = mkRepo([{ title: 'One', touches: ['src/a.ts'] }], { ignoreFeatures: true });
  try {
    ign.write('src/a.ts', 'a\n');
    const r = await gitCommit(ign, ['--closes', '27']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(subjects(ign), ['fix(src): P1 One']);
    assert.match(ign.git(['log', '-1', '--format=%B']), /Closes #27/);
    assert.match(fs.readFileSync(path.join(ign.featureDir, 'polish.md'), 'utf8'), /^status: \[DONE\]$/m, 'flips still land on disk');
  } finally { ign.cleanup(); }
});

test('AC17: a failing hook on the second commit rolls everything back; a re-run succeeds', T, async () => {
  const repo = mkRepo();
  try {
    repo.write('src/a.ts', 'a\n');
    repo.write('src/b.ts', 'b\n');
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
    const counter = path.join(repo.root, '.git', 'count');
    fs.writeFileSync(hook, `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '${counter}'\n[ "$n" -ge 2 ] && { echo hook says no; exit 1; }\nexit 0\n`, { mode: 0o755 });
    const start = repo.git(['rev-parse', 'HEAD']);
    const polishBefore = fs.readFileSync(path.join(repo.featureDir, 'polish.md'));
    const fjBefore = fs.readFileSync(path.join(repo.featureDir, 'feature.json'));
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /FAILED hook-failed|hook-failed/);
    assert.match(r.err, /P2/);
    assert.equal(repo.git(['rev-parse', 'HEAD']), start);
    assert.deepEqual(fs.readFileSync(path.join(repo.featureDir, 'polish.md')), polishBefore);
    assert.deepEqual(fs.readFileSync(path.join(repo.featureDir, 'feature.json')), fjBefore);
    assert.match(repo.git(['status', '--porcelain', '-uall']), /src\/a\.ts/);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
    fs.rmSync(hook);
    const again = await gitCommit(repo, []);
    assert.equal(again.code, 0, again.err);
    assert.equal(subjects(repo).length, 3);
  } finally { repo.cleanup(); }
});

test('AC18: secret-like path → secret-like-file with nothing committed or staged; no changes → nothing-to-commit', T, async () => {
  const repo = mkRepo([{ title: 'Env', touches: ['.env'] }, { title: 'B', touches: ['src/b.ts'] }]);
  try {
    repo.write('.env', 'X=1\n');
    repo.write('src/b.ts', 'b\n');
    const start = repo.git(['rev-parse', 'HEAD']);
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /secret-like-file/);
    assert.equal(repo.git(['rev-parse', 'HEAD']), start);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), '');
  } finally { repo.cleanup(); }

  const empty = mkRepo();
  try {
    const r = await gitCommit(empty, []);
    assert.equal(r.code, 1);
    assert.match(r.err, /nothing-to-commit/);
  } finally { empty.cleanup(); }
});

test('AC19: trailers on every commit; no --subject needed on polish (still required on quick)', T, async () => {
  const repo = mkRepo();
  try {
    repo.write('src/a.ts', 'a\n');
    repo.write('src/b.ts', 'b\n');
    const r = await gitCommit(repo, ['--trailer', 'Co-Authored-By: X <x@y>']);
    assert.equal(r.code, 0, r.err);
    for (const rev of ['HEAD', 'HEAD~1', 'HEAD~2']) {
      assert.match(repo.git(['log', '-1', '--format=%B', rev]), /Co-Authored-By: X <x@y>\s*$/);
    }
  } finally { repo.cleanup(); }

  const quick = mkRepo(ITEMS, { over: { track: 'quick' } });
  try {
    quick.write('src/a.ts', 'a\n');
    const r = await gitCommit(quick, []);
    assert.equal(r.code, 2);
  } finally { quick.cleanup(); }
});

test('AC20: buildPolishMessages is pure and keeps hostile titles literal; argv never carries a title', T, async () => {
  const title = 'fix `x` $(touch pwned) done';
  const items = parseItems(polishMd([{ title, touches: ['src/a.ts'] }]));
  assert.equal(items[0].title, title);
  const msgs = buildPolishMessages({
    fj: sampleFeatureJson(), items, groups: [{ items, shared: [] }], batch: { leftovers: [] }, folder: 'f',
  });
  assert.equal(msgs[0].subject, `fix(src): P1 ${title}`);
  assert.equal(msgs[0].message.split('\n')[0], msgs[0].subject);

  const repo = mkRepo([{ title, touches: ['src/a.ts'] }]);
  try {
    repo.write('src/a.ts', 'a\n');
    const r = await gitCommit(repo, []);
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.git(['log', '--format=%s', '-n', '2']).split('\n').at(-1), `fix(src): P1 ${title}`);
    assert.ok(!fs.existsSync(path.join(repo.root, 'pwned')));
    for (const call of r.gitCalls) assert.ok(!call.some((a) => a.includes('touch pwned')), call.join(' '));
    assert.equal(readFj(repo).history.at(-1).summary, 'feature commit');
  } finally { repo.cleanup(); }
});

test('F1/F6: project root below the git root — per-item commits, baseline untracked file never committed, skip warned', T, async () => {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ track: 'polish', branch: 'feat/sample' }), files: {} });
  try {
    // The dev-cycle project lives in R/app; the git repo is R.
    const app = path.join(repo.root, 'app');
    const feat = path.join(app, 'docs', 'features', DEFAULT_FEATURE);
    fs.mkdirSync(feat, { recursive: true });
    fs.writeFileSync(path.join(feat, 'polish.md'), polishMd([
      { title: 'Home', touches: ['src/a.ts'] }, { title: 'Owner file', touches: ['src/owner.ts'] }, { title: 'Gone', touches: ['src/gone.ts'] },
    ]));
    fs.writeFileSync(path.join(feat, 'feature.json'), JSON.stringify(sampleFeatureJson({
      track: 'polish', branch: 'feat/sample', untracked_baseline: ['src/owner.ts'],
    }), null, 2));
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'app']);
    repo.git(['checkout', '-q', '-b', 'feat/sample']);
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.writeFileSync(path.join(app, 'src', 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(app, 'src', 'owner.ts'), 'mine\n');
    fs.writeFileSync(path.join(app, 'src', 'gone.ts'), 'x\n');
    repo.git(['add', '--', 'app/src/gone.ts']); // staged, then deleted: status AD
    fs.rmSync(path.join(app, 'src', 'gone.ts'));
    const r = await gitCommit(repo, ['--feature', feat], {}, app);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /P2 skips baseline untracked src\/owner\.ts/);
    const subs = subjects(repo);
    assert.equal(subs[0], 'fix(src): P1 Home');
    assert.deepEqual(files(repo, 'HEAD~1'), ['app/src/a.ts']);
    assert.equal(repo.git(['status', '--porcelain', '-uall']), '?? app/src/owner.ts');
    assert.ok(!repo.git(['ls-tree', '-r', '--name-only', 'HEAD']).includes('owner.ts'));
  } finally { repo.cleanup(); }
});
