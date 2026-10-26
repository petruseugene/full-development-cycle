import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from '../plugin/scripts/lib/core.mjs';
import {
  ReleaseError, agreedVersion, bumpVersion, inferLevel, insertChangelog, loadManifests,
  readNotesFile, setManifestVersion, subjectNotes, today,
} from '../plugin/scripts/lib/release.mjs';

const T = { timeout: 60_000 };

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-cycle-rel-')));
}

test('bumpVersion and inferLevel follow conventional commits', T, () => {
  assert.equal(bumpVersion('1.4.0', 'minor'), '1.5.0');
  assert.equal(bumpVersion('1.4.9', 'patch'), '1.4.10');
  assert.equal(bumpVersion('1.4.0', 'major'), '2.0.0');
  assert.equal(inferLevel(['feat!: z'], '1.4.0'), 'major');
  assert.equal(inferLevel(['fix: a', 'feat(x): b'], '1.4.0'), 'patch');
  assert.equal(inferLevel(['chore: a'], '1.4.0'), 'patch');
  assert.equal(inferLevel(['fix: a\n\nBREAKING CHANGE: gone'], '1.4.0'), 'major');
  assert.equal(inferLevel(['feat: z'], '0.3.1'), 'patch');
  assert.equal(inferLevel(['feat!: z'], '0.3.1'), 'minor');
  assert.throws(() => bumpVersion('1.4', 'patch'), ReleaseError);
});

test('manifests: detect, bump in place, keep formatting', T, () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    const plugin = '{\n  "name": "x",\n\t"version":   "1.4.0",\n  "deps": {"version": "9.9.9"}\n}\n';
    fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), plugin);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x","dependencies":{"version":"7.7.7"},"version":"1.4.0"}');
    fs.writeFileSync(path.join(root, 'app.json'), '{"version":"0.0.1","expo":{"name":"a","version":"1.4.0"}}');
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[build-system]\nversion = "5.5.5"\n\n[project]\nname = "p"\nversion = "1.4.0"  # c\r\n');
    fs.writeFileSync(path.join(root, 'Cargo.toml'), "[package]\nname = 'c'\nversion = '1.4.0'\n[dependencies]\nfoo = { version = '3.3.3' }\n");
    const ms = loadManifests(root);
    assert.deepEqual(ms.map((m) => m.rel), ['.claude-plugin/plugin.json', 'package.json', 'app.json', 'pyproject.toml', 'Cargo.toml']);
    assert.equal(agreedVersion(ms), '1.4.0');
    const out = Object.fromEntries(ms.map((m) => [m.rel, setManifestVersion(m.abs, m.text, '1.5.0')]));
    assert.equal(out['.claude-plugin/plugin.json'], plugin.replace('"1.4.0"', '"1.5.0"'));
    assert.match(out['package.json'], /"dependencies":\{"version":"7.7.7"\},"version":"1.5.0"/);
    assert.equal(out['app.json'], '{"version":"0.0.1","expo":{"name":"a","version":"1.5.0"}}');
    assert.match(out['pyproject.toml'], /\[build-system\]\nversion = "5.5.5"[\s\S]*version = "1.5.0"  # c\r\n/);
    assert.match(out['Cargo.toml'], /version = '1.5.0'\n\[dependencies\]\nfoo = \{ version = '3.3.3' \}/);
    assert.throws(() => setManifestVersion('package.json', '{"version":"1.0.0"}', '1.0.0-rc1'), ReleaseError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manifest errors: version-mismatch, no-manifest, invalid-version, explicit paths', T, () => {
  const root = tmp();
  try {
    assert.throws(() => loadManifests(root), (e) => e instanceof ReleaseError && e.reason === 'no-manifest');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"private"}');
    assert.throws(() => loadManifests(root), (e) => e.reason === 'no-manifest');
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), '{"version":"1.4.0"}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.3.0"}');
    assert.throws(() => agreedVersion(loadManifests(root)), (e) => e.reason === 'version-mismatch');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.4.0-beta"}');
    assert.throws(() => agreedVersion(loadManifests(root, ['package.json'])), (e) => e.reason === 'invalid-version');
    assert.throws(() => loadManifests(root, ['../outside.json']), (e) => e.reason === 'no-manifest');
    fs.writeFileSync(path.join(root, 'notes.json'), '{}');
    assert.throws(() => loadManifests(root, ['notes.json']), UsageError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('changelog: insert before first section, preamble kept, Unreleased turned into the release', T, () => {
  assert.equal(insertChangelog(null, '1.5.0', '2026-10-19', 'notes\n'), '# Changelog\n\n## [1.5.0] — 2026-10-19\n\nnotes\n');
  const plain = '## [1.4.0] - 2026-01-01\n- old\n';
  assert.equal(insertChangelog(plain, '1.5.0', 'D', 'N\n'), `## [1.5.0] — D\n\nN\n\n${plain}`);
  const pre = '# Changelog\n\nAll notable changes.\n\n## [1.4.0] - 2026-01-01\n- old\n';
  assert.equal(insertChangelog(pre, '1.5.0', 'D', 'N'), '# Changelog\n\nAll notable changes.\n\n## [1.5.0] — D\n\nN\n\n## [1.4.0] - 2026-01-01\n- old\n');
  const unrel = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- map\n\n## [1.4.0] - 2026-01-01\n- old\n';
  assert.equal(
    insertChangelog(unrel, '1.5.0', 'D', 'N'),
    '# Changelog\n\n## [1.5.0] — D\n\nN\n\n### Added\n\n- map\n\n## [1.4.0] - 2026-01-01\n- old\n',
  );
  assert.equal(insertChangelog('# Changelog\n', '1.5.0', 'D', 'N'), '# Changelog\n\n## [1.5.0] — D\n\nN\n');
  assert.throws(() => insertChangelog(null, 'x', 'D', 'N'), ReleaseError);
  assert.match(today(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('subjectNotes picks the section from the commit type', T, () => {
  assert.equal(subjectNotes('fix(x): y'), '### Fixed\n\n- fix(x): y\n');
  assert.equal(subjectNotes('feat: z'), '### Added\n\n- feat: z\n');
  assert.equal(subjectNotes('chore: z'), '### Changed\n\n- chore: z\n');
});

test('readNotesFile: regular file, size cap, location, no symlink escape', T, () => {
  const root = tmp();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.rel-outside-')));
  try {
    fs.writeFileSync(path.join(root, 'n.md'), '### Added\n- $(touch X)\n');
    assert.equal(readNotesFile('n.md', { root }), '### Added\n- $(touch X)\n');
    assert.equal(readNotesFile(path.join(root, 'n.md'), { root: outside, cwd: outside }), '### Added\n- $(touch X)\n'); // temp dir is allowed
    fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(64 * 1024 + 1));
    assert.throws(() => readNotesFile('big.md', { root }), UsageError);
    fs.mkdirSync(path.join(root, 'd'));
    assert.throws(() => readNotesFile('d', { root }), UsageError);
    assert.throws(() => readNotesFile('missing.md', { root }), UsageError);
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link.md'));
    // outside is under cwd, not under root or the temp dir
    assert.throws(() => readNotesFile('link.md', { root }), UsageError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
