// Polish track end to end on a temp git repo: polish init -> task status -> defer -> git commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, sampleFeatureJson, DEFAULT_FEATURE } from './helpers.mjs';
import { mkGitRepo, gitTestEnv } from './git-helpers.mjs';

const T = { timeout: 90_000 };

function setup(items) {
  const repo = mkGitRepo({ featureJson: sampleFeatureJson({ track: 'polish', branch: 'feat/sample' }) });
  repo.git(['checkout', '-q', '-b', 'feat/sample']);
  repo.write('owner-notes.txt', 'owner file\n'); // untracked before init -> baseline
  const itemsFile = repo.write('items.json', JSON.stringify(items));
  const env = gitTestEnv();
  const cli = (args) => runCli([...args, '--feature', repo.featureDir], { cwd: repo.root, env });
  return { repo, itemsFile, cli };
}
const subjects = (repo) => repo.git(['log', '--reverse', '--format=%s', 'main..HEAD']).split('\n').filter(Boolean);

test('polish run: P1+P2 share a file (combined), P3 deferred, untracked owner file never committed', T, () => {
  const { repo, itemsFile, cli } = setup([
    { title: 'Home title clipped', area: 'home', touches: ['src/theme.ts', 'src/home.ts'] },
    { title: 'Settings colour', area: 'settings', touches: ['src/theme.ts'] },
    { title: 'Profile crash', area: 'profile', touches: ['src/profile.ts'] },
  ]);
  try {
    assert.equal(cli(['polish', 'init', '--items', itemsFile]).status, 0);
    repo.write('src/theme.ts', 't\n');
    repo.write('src/home.ts', 'h\n');
    assert.equal(cli(['task', '1', 'status', 'IMPL-DONE']).status, 0);
    assert.equal(cli(['task', '2', 'status', 'IMPL-DONE']).status, 0);
    assert.equal(cli(['polish', 'defer', '3', '--reason', 'needs new profile API']).status, 0);
    const r = cli(['git', 'commit']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const subs = subjects(repo);
    assert.equal(subs[0], 'fix(src): P1+P2 Home title clipped');
    assert.ok(!subs.some((s) => /P3 /.test(s) && s.startsWith('fix(')), 'deferred item has no item commit');
    const all = repo.git(['log', 'main..HEAD', '--name-only', '--format=']);
    assert.ok(!all.includes('owner-notes.txt'));
    assert.ok(!all.includes('items.json'));
    assert.match(repo.git(['status', '--porcelain']), /\?\? owner-notes\.txt/);
    const last = repo.git(['log', '-1', '--format=%B']);
    assert.match(last, /Deferred:\n- P3: Profile crash — needs new profile API/);
  } finally { repo.cleanup(); }
});

test('hostile title: newline/backticks/$(touch) sanitized in commit subjects and nothing executed', T, () => {
  const { repo, itemsFile, cli } = setup([
    { title: 'Bad\n# title `x` $(touch PWNED)', area: 'home', touches: ['src/a.ts'] },
  ]);
  try {
    assert.equal(cli(['polish', 'init', '--items', itemsFile]).status, 0);
    repo.write('src/a.ts', 'a\n');
    assert.equal(cli(['task', '1', 'status', 'IMPL-DONE']).status, 0);
    const r = cli(['git', 'commit']);
    assert.equal(r.status, 0, r.stderr);
    const subs = subjects(repo);
    assert.ok(subs.every((s) => !s.includes('\n')));
    assert.match(subs[0], /^fix\(src\): P1 Bad/);
    assert.ok(!fs.existsSync(path.join(repo.root, 'PWNED')));
    assert.ok(!fs.existsSync(path.join(process.cwd(), 'PWNED')));
    assert.equal(repo.git(['log', '-1', '--format=%s']).includes('\n'), false);
  } finally { repo.cleanup(); }
});

test('forced hook failure on 2nd commit: HEAD, index, polish.md and feature.json restored byte-identical', T, () => {
  const { repo, itemsFile, cli } = setup([
    { title: 'One', area: 'home', touches: ['src/a.ts'] },
    { title: 'Two', area: 'home', touches: ['src/b.ts'] },
  ]);
  try {
    assert.equal(cli(['polish', 'init', '--items', itemsFile]).status, 0);
    repo.write('src/a.ts', 'a\n');
    repo.write('src/b.ts', 'b\n');
    cli(['task', '1', 'status', 'IMPL-DONE']);
    cli(['task', '2', 'status', 'IMPL-DONE']);
    const counter = path.join(repo.root, '.git', 'cnt');
    const hook = path.join(repo.root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '${counter}'\n[ "$n" -ge 2 ] && exit 1\nexit 0\n`, { mode: 0o755 });
    const start = repo.git(['rev-parse', 'HEAD']);
    const idxBefore = repo.git(['diff', '--cached', '--name-only']);
    const pm = fs.readFileSync(path.join(repo.featureDir, 'polish.md'));
    const fj = fs.readFileSync(path.join(repo.featureDir, 'feature.json'));
    const r = cli(['git', 'commit']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /hook-failed/);
    assert.equal(repo.git(['rev-parse', 'HEAD']), start);
    assert.equal(repo.git(['diff', '--cached', '--name-only']), idxBefore);
    assert.deepEqual(fs.readFileSync(path.join(repo.featureDir, 'polish.md')), pm);
    assert.deepEqual(fs.readFileSync(path.join(repo.featureDir, 'feature.json')), fj);
  } finally { repo.cleanup(); }
});
