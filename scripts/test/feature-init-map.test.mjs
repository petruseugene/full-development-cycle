import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkGitRepo } from './git-helpers.mjs';
import { mkFixture, runCli } from './helpers.mjs';

const init = (fx, slug, env) => runCli(['feature', 'init', slug, '--flow', 'feature', '--track', 'lite'], { cwd: fx.root, env });
const MAP = (r) => path.join(r.root, '.dev-cycle', 'map.md');

test('AC19: init creates the map once, then stays silent and byte-identical', () => {
  const repo = mkGitRepo({ remote: false });
  try {
    const a = init(repo, 'one', repo.env);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stderr, /map: created \.dev-cycle\/map\.md/);
    assert.equal(a.stdout.trim(), a.stdout.trimEnd());
    assert.ok(path.isAbsolute(a.stdout.trim()) && !a.stdout.trim().includes('\n'));
    const before = fs.readFileSync(MAP(repo));
    const b = init(repo, 'two', repo.env);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(!/map:/i.test(b.stderr));
    assert.ok(before.equals(fs.readFileSync(MAP(repo))));
  } finally { repo.cleanup(); }
});

test('AC19: non-git dir prints no map text; invalid map warns and exits 0', () => {
  const fx = mkFixture();
  try {
    const r = init(fx, 'plain');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/map/i.test(r.stderr));
  } finally { fx.cleanup(); }
  const repo = mkGitRepo({ remote: false });
  try {
    repo.write('.dev-cycle/map.md', 'not a dev-cycle map\n');
    const r = init(repo, 'bad', repo.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /! MAP: invalid — run dev-cycle map/);
  } finally { repo.cleanup(); }
});
