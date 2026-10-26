import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleFeatureJson } from './helpers.mjs';
import { installSpawnRecorder, mkGhStub, mkGitRepo } from './git-helpers.mjs';
import { run } from '../plugin/scripts/lib/cmd-ship.mjs';
import { UsageError } from '../plugin/scripts/lib/core.mjs';
import { agreedVersion, loadManifests } from '../plugin/scripts/lib/release.mjs';

const T = { timeout: 60_000 };
const mp = (plugins) => JSON.stringify({ name: 'm', plugins });
const pj = (v) => `{\n  "name": "p",\n  "version": "${v}"\n}\n`;

function proj(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-rd-')));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const rels = (root, explicit) => loadManifests(root, explicit).map((m) => m.rel);

test('AC17: loadManifests follows marketplace source ./plugin', T, () => {
  const root = proj({
    '.claude-plugin/marketplace.json': mp([{ name: 'p', source: './plugin' }]),
    'plugin/.claude-plugin/plugin.json': pj('1.2.3'),
  });
  try { assert.deepEqual(rels(root), ['plugin/.claude-plugin/plugin.json']); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AC17: ship --release patch bumps plugin/ manifest and the root CHANGELOG', T, async () => {
  const repo = mkGitRepo({
    featureJson: sampleFeatureJson({
      branch: 'feat/sample',
      history: [
        { phase: 'spec', status: 'DONE' }, { phase: 'plan', status: 'DONE' }, { phase: 'implement.task=1', status: 'DONE' },
        { phase: 'static-check', status: 'PASSED' }, { phase: 'review', status: 'APPROVED' },
        { phase: 'auto-test', status: 'PASSED' }, { phase: 'security', status: 'APPROVED' },
      ],
    }),
    files: {
      'spec.md': '# Sample — Spec\n\n## 1. Problem & Goal\n\nSlow.\n',
      'plan.md': '# Sample — Plan\n\n## Tasks\n- [IMPL-DONE] **Task 1** (backend): Speed up\n',
    },
  });
  try {
    repo.write('.claude-plugin/marketplace.json', mp([{ name: 'p', source: './plugin' }]));
    repo.write('plugin/.claude-plugin/plugin.json', pj('1.2.3'));
    repo.write('CHANGELOG.md', '## [1.2.3] - 2026-01-01\n\n- old\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'chore: manifests']);
    repo.git(['push', '-q', 'origin', 'main']);
    repo.git(['checkout', '-q', '-b', 'feat/sample']);
    repo.write('src/a.js', 'export const a = 1;\n');
    const gh = mkGhStub(repo.tmpDir());
    gh.setRules([{ match: 'pr view feat/sample --json mergeCommit', stdout: JSON.stringify({ mergeCommit: { oid: repo.git(['rev-parse', 'main']) } }) }]);
    const ctx = repo.ctx({ ...gh.env, CLAUDE_CODE_SESSION_ID: '' });
    const rec = installSpawnRecorder();
    let code;
    try {
      try { code = await run(['--release', 'patch', '--subject', 'fix(x): y'], ctx); } catch (e) {
        if (e instanceof UsageError) code = 2; else throw e;
      }
    } finally { rec.restore(); }
    assert.equal(code, 0, ctx.err());
    assert.match(repo.git(['show', 'feat/sample:plugin/.claude-plugin/plugin.json']), /"version": "1.2.4"/);
    assert.match(repo.git(['show', 'feat/sample:CHANGELOG.md']), /^## \[1\.2\.4\]/);
  } finally { repo.cleanup(); }
});

test('AC18: old behaviour for ./, no marketplace, remote and outside sources', T, () => {
  const cases = [
    ['source ./', { '.claude-plugin/marketplace.json': mp([{ name: 'p', source: './' }]) }],
    ['no marketplace', {}],
    ['remote source', { '.claude-plugin/marketplace.json': mp([{ name: 'p', source: { source: 'github', repo: 'a/b' } }]) }],
    ['outside source', { '.claude-plugin/marketplace.json': mp([{ name: 'p', source: '../outside' }]) }],
    ['absolute source', { '.claude-plugin/marketplace.json': mp([{ name: 'p', source: '/etc' }]) }],
  ];
  for (const [label, extra] of cases) {
    const withRoot = proj({ ...extra, '.claude-plugin/plugin.json': pj('3.0.0') });
    const none = proj(extra);
    try {
      assert.deepEqual(rels(withRoot), ['.claude-plugin/plugin.json'], label);
      assert.throws(() => loadManifests(none), (e) => e.reason === 'no-manifest', label);
    } finally {
      fs.rmSync(withRoot, { recursive: true, force: true });
      fs.rmSync(none, { recursive: true, force: true });
    }
  }
});

test('AC18: --manifest overrides; two local sources must agree', T, () => {
  const root = proj({
    '.claude-plugin/marketplace.json': mp([{ name: 'a', source: './plugin' }]),
    'plugin/.claude-plugin/plugin.json': pj('1.0.0'),
    'package.json': '{"name":"x","version":"2.0.0"}\n',
  });
  const two = proj({
    '.claude-plugin/marketplace.json': mp([{ name: 'a', source: './a' }, { name: 'b', source: './b' }]),
    'a/.claude-plugin/plugin.json': pj('1.0.0'),
    'b/.claude-plugin/plugin.json': pj('1.1.0'),
  });
  try {
    assert.deepEqual(rels(root, ['package.json']), ['package.json']);
    assert.throws(() => agreedVersion(loadManifests(two)), (e) => e.reason === 'version-mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(two, { recursive: true, force: true });
  }
});

test('AC18: a source symlinked outside the root is rejected', T, () => {
  const outside = proj({ '.claude-plugin/plugin.json': pj('9.9.9') });
  const root = proj({ '.claude-plugin/marketplace.json': mp([{ name: 'p', source: './plugin' }]), '.claude-plugin/plugin.json': pj('3.0.0') });
  try {
    fs.symlinkSync(outside, path.join(root, 'plugin'));
    assert.deepEqual(rels(root), ['.claude-plugin/plugin.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('AC17: a symlinked project root still finds the plugin/ manifest', T, () => {
  const real = proj({
    '.claude-plugin/marketplace.json': mp([{ name: 'p', source: './plugin' }]),
    'plugin/.claude-plugin/plugin.json': pj('1.2.3'),
    'package.json': '{"name":"x","version":"7.7.7"}\n',
  });
  const link = path.join(os.tmpdir(), `dev-cycle-rd-link-${process.pid}`);
  try {
    fs.symlinkSync(real, link);
    assert.deepEqual(rels(link), ['plugin/.claude-plugin/plugin.json']);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});
