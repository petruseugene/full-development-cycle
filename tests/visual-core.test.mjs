import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { UsageError } from '../plugin/scripts/lib/core.mjs';
import {
  loadVisualConfig, buildCatalog, parseSpecScreens, verificationDir, cacheDir,
  ensureSelfIgnore, resolveInside, readManifest, updateManifest, screenLimit,
  touchActivity, referenceProblems,
} from '../plugin/scripts/lib/visual-core.mjs';
import * as visualCore from '../plugin/scripts/lib/visual-core.mjs';
import { visualCmdProblems } from '../plugin/scripts/lib/visual-profile.mjs';
import { run as runVisual, runWith as runVisualWith, SUBCOMMANDS } from '../plugin/scripts/lib/cmd-visual.mjs';
import { mkFixture, mkCtx, runCli, sampleFeatureJson, leftoverTempFiles, FIXTURES_DIR } from './helpers.mjs';

const FIX = path.join(FIXTURES_DIR, 'visual-core');
const fixtureText = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const profileVisual = () => JSON.parse(fixtureText('profile-visual.json'));

function tmpDir(t, prefix = 'visual-core-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// loadVisualConfig (R3)
// ---------------------------------------------------------------------------

test('loadVisualConfig: feature.json snapshot wins over the live profile', (t) => {
  const snap = { screen_timeout_s: 60, screens: [{ id: 'snap', route: '/s' }] };
  const fx = mkFixture({ featureJson: sampleFeatureJson({ platform: 'mobile', profile: { visual: snap } }) });
  t.after(() => fx.cleanup());
  fx.write('.dev-cycle/project.json', JSON.stringify({ platform: 'web', visual: { screens: [{ id: 'live', route: '/l' }] } }));
  const cfg = loadVisualConfig(mkCtx({ cwd: fx.root }), fx.featureDir);
  assert.equal(cfg.source, 'snapshot');
  assert.equal(cfg.platform, 'mobile');
  assert.deepEqual(cfg.visual, snap);
});

test('loadVisualConfig: falls back to the live profile when the snapshot is absent', (t) => {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { recipes: {} } }) });
  t.after(() => fx.cleanup());
  const live = { screens: [{ id: 'live', route: '/l' }] };
  fx.write('.dev-cycle/project.json', JSON.stringify({ visual: live }));
  const cfg = loadVisualConfig(mkCtx({ cwd: fx.root }), fx.featureDir);
  assert.equal(cfg.source, 'profile');
  assert.equal(cfg.platform, 'web');
  assert.deepEqual(cfg.visual, live);
});

test('loadVisualConfig: an invalid snapshot is a UsageError (same validator as the profile)', (t) => {
  const bad = [
    [{ screens: [{ id: 'a/../../../../../tmp/evil', route: '/x' }] }, /\.id must match/],
    [{ screens: [{ id: '-rf', route: '/x' }] }, /\.id must match/],
    [{ screens: [{ id: '..', route: '/x' }] }, /\.id must match/],
    [{ screens: [{ id: 'a', flow: 'caffeinate bash -c id' }] }, /'bash' is a shell/],
    [{ device: 'emulator-5554', screens: [{ id: 'a', flow: 'adb uninstall com.x' }] }, /device-sensitive/],
  ];
  for (const [snap, re] of bad) {
    const fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { visual: snap } }) });
    t.after(() => fx.cleanup());
    assert.throws(() => loadVisualConfig(mkCtx({ cwd: fx.root }), fx.featureDir), (e) => e instanceof UsageError && re.test(e.message), JSON.stringify(snap));
  }
});

test('loadVisualConfig: no snapshot and no profile visual → none', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const cfg = loadVisualConfig(mkCtx({ cwd: fx.root }), fx.featureDir);
  assert.deepEqual(cfg, { visual: null, platform: 'web', source: 'none' });
});

// ---------------------------------------------------------------------------
// buildCatalog (R4)
// ---------------------------------------------------------------------------

test('buildCatalog: profile only, catalog order, deep copies', () => {
  const visual = profileVisual();
  const screens = buildCatalog(visual, null);
  assert.deepEqual(screens.map((s) => s.id), ['lis-home', 'lis-detail', 'other', 'about']);
  screens[0].title = 'changed';
  assert.equal(visual.screens[0].title, 'Lis home');
});

test('buildCatalog: spec rows override same-id fields and add new screens without checks', () => {
  const visual = profileVisual();
  const screens = buildCatalog(visual, fixtureText('spec-screens.md'));
  assert.deepEqual(screens.map((s) => s.id), ['lis-home', 'lis-detail', 'other', 'about', 'report-index', 'settings']);

  const detail = screens.find((s) => s.id === 'lis-detail');
  assert.equal(detail.route, '/lis/detail-v2');
  assert.equal(detail.reference, 'design/lis-detail-v2.png');
  assert.deepEqual(detail.touches, ['apps/mova/src/lis/detail.tsx', 'apps/mova/src/lis/*.ts']);
  assert.deepEqual(detail.acs, ['AC4', 'AC6', 'AC7']);
  assert.equal(detail.title, 'Lis detail', 'unset fields keep the profile value');
  assert.deepEqual(detail.checks, [{ type: 'colors' }], 'profile checks survive an override');

  const report = screens.find((s) => s.id === 'report-index');
  assert.deepEqual(report, { id: 'report-index', route: '/report', touches: ['dashboard/app/report/**'], acs: ['AC31'] });
  assert.equal(report.checks, undefined);

  const settings = screens.find((s) => s.id === 'settings');
  assert.equal(settings.flow, 'maestro --device {device} test flows/settings.yaml');
  assert.equal(settings.route, undefined);
  assert.equal(settings.touches, undefined);

  assert.ok(!screens.some((s) => s.id === 'ignored' || s.id === 'also-ignored'), 'only the ## Screens section is read');
  assert.equal(visual.screens[1].route, '/lis/detail', 'input not mutated');
});

test('buildCatalog: a route row replaces a profile flow and vice versa', () => {
  const visual = { screens: [{ id: 'a', flow: 'maestro test a.yaml --device {device}' }, { id: 'b', route: '/b' }] };
  const spec = '## Screens\n\n| id | route or flow | reference | touches | acs |\n|---|---|---|---|---|\n| a | /a | | | |\n| b | maestro test b.yaml | | | |\n';
  const [a, b] = buildCatalog(visual, spec);
  assert.deepEqual(a, { id: 'a', route: '/a' });
  assert.deepEqual(b, { id: 'b', flow: 'maestro test b.yaml' });
});

test('buildCatalog: no profile + spec table → spec screens only; nothing → []', () => {
  assert.deepEqual(buildCatalog(null, fixtureText('spec-screens.md')).map((s) => s.id), ['lis-detail', 'report-index', 'settings']);
  assert.deepEqual(buildCatalog(null, '# spec\n\nno table\n'), []);
  assert.deepEqual(buildCatalog(undefined, undefined), []);
});

test('parseSpecScreens: flows go through the recipe grammar; bad rows are UsageErrors', () => {
  assert.throws(() => parseSpecScreens(fixtureText('spec-bad-flow.md')), (e) => e instanceof UsageError && /evil/.test(e.message) && /shell/.test(e.message));
  const row = (cells) => `## Screens\n\n| id | route or flow | reference | touches | acs |\n|---|---|---|---|---|\n| ${cells} |\n`;
  assert.throws(() => parseSpecScreens(row('Bad_Id | /x | | |')), /id 'Bad_Id'/);
  assert.throws(() => parseSpecScreens(row('x | /x | ../out.png | |')), /'\.\.'/);
  assert.throws(() => parseSpecScreens(row('x | /x | /abs.png | |')), /absolute/);
  assert.throws(() => parseSpecScreens(row('x | /x | https://e.com/a.png | |')), /URL scheme/);
  assert.throws(() => parseSpecScreens(row('x | caffeinate bash -c {screen} | | |')), UsageError);
  assert.throws(() => parseSpecScreens(row('x | maestro test {evil} | | |')), /placeholder \{evil\} is not allowed/);
  // every literal argv word is checked (one validator, lessons L3/L4)
  for (const flow of ['caffeinate bash -c id', 'arch zsh run.sh', 'caffeinate bash scripts/x.sh']) {
    assert.throws(() => parseSpecScreens(row(`x | ${flow} | | |`)), /is a shell/, flow);
  }
  assert.throws(() => parseSpecScreens(row('x | /x | | | AC5-AC2')), /invalid AC range/);
  assert.throws(() => parseSpecScreens(`${row('x | /x | | |')}| x | /y | | | |\n`), /duplicate id 'x'/);
});

test('referenceProblems / visualCmdProblems (one validator: visual-core has no copy)', () => {
  assert.equal(visualCore.visualCmdProblems, undefined);
  assert.deepEqual(referenceProblems('design/a.png'), []);
  assert.deepEqual(referenceProblems('none'), []);
  assert.ok(referenceProblems('C:\\x.png').length > 0);
  assert.deepEqual(visualCmdProblems('maestro --device {device} test flows/a.yaml --out={out}'), []);
  assert.ok(visualCmdProblems('sh -c x').length > 0);
});

// ---------------------------------------------------------------------------
// Folders, self-ignore (R12, constraints)
// ---------------------------------------------------------------------------

test('verificationDir / cacheDir', (t) => {
  assert.equal(verificationDir('/p/docs/features/f'), path.join('/p/docs/features/f', 'verification'));
  assert.equal(cacheDir('/p'), path.join('/p', '.dev-cycle', 'cache'));
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  assert.equal(cacheDir(mkCtx({ cwd: fx.featureDir })), path.join(fx.root, '.dev-cycle', 'cache'));
});

test('ensureSelfIgnore: creates, is idempotent, appends * to an existing .gitignore', (t) => {
  const base = tmpDir(t);
  const dir = path.join(base, 'a', 'verification');
  assert.equal(ensureSelfIgnore(dir), dir);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  ensureSelfIgnore(dir);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');

  const other = path.join(base, 'b');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, '.gitignore'), '*.log');
  ensureSelfIgnore(other);
  ensureSelfIgnore(other);
  assert.equal(fs.readFileSync(path.join(other, '.gitignore'), 'utf8'), '*.log\n*\n');
  assert.deepEqual(leftoverTempFiles(other), []);
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('self-ignore: git status --porcelain shows nothing under verification/ or .dev-cycle/cache/', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  git(fx.root, 'init', '-q');
  git(fx.root, 'add', '-A');
  git(fx.root, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init');
  updateManifest(fx.featureDir, (m) => { m.plan = { selected: [] }; });
  fs.writeFileSync(path.join(verificationDir(fx.featureDir), 'shot.png'), 'png');
  const cache = ensureSelfIgnore(cacheDir(fx.root));
  fs.writeFileSync(path.join(cache, 'visual-started.json'), '{}');
  assert.equal(git(fx.root, 'status', '--porcelain', '--untracked-files=all'), '');
});

// ---------------------------------------------------------------------------
// resolveInside (AC11 primitive)
// ---------------------------------------------------------------------------

test('resolveInside: accepts paths inside base and returns the real path', (t) => {
  const base = tmpDir(t);
  fs.mkdirSync(path.join(base, 'shots'));
  fs.writeFileSync(path.join(base, 'shots', 'a.png'), 'x');
  assert.equal(resolveInside(base, 'shots/a.png'), path.join(base, 'shots', 'a.png'));
  assert.equal(resolveInside(base, path.join(base, 'shots', 'a.png')), path.join(base, 'shots', 'a.png'));
  assert.equal(resolveInside(base, 'new/b.png'), path.join(base, 'new', 'b.png'), 'a not-yet-existing tail is fine');
  fs.symlinkSync(path.join(base, 'shots', 'a.png'), path.join(base, 'link.png'));
  assert.equal(resolveInside(base, 'link.png'), path.join(base, 'shots', 'a.png'), 'an inside symlink is fine');
});

test('resolveInside: rejects traversal, absolute outside paths and outside symlinks with exit 2', (t) => {
  const root = tmpDir(t);
  const base = path.join(root, 'verification');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(root, 'outside.png'), 'x');
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(base, 'evil.png'));
  fs.symlinkSync(root, path.join(base, 'evil-dir'));
  const bad = ['../../../etc/passwd', '/tmp/x.png', 'evil.png', 'evil-dir/outside.png', 'a/../b.png', '', '..'];
  for (const p of bad) {
    assert.throws(() => resolveInside(base, p), (e) => e instanceof UsageError && e.exitCode === 2, `accepted ${JSON.stringify(p)}`);
  }
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test('readManifest: missing → {version:1} and the folder is self-ignored', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  assert.deepEqual(readManifest(fx.featureDir), { version: 1 });
  assert.equal(fs.readFileSync(path.join(fx.featureDir, 'verification', '.gitignore'), 'utf8'), '*\n');
});

test('updateManifest: writers merge their own keys; read back round-trips', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  updateManifest(fx.featureDir, (m) => { m.plan = { selected: ['a'], budget_s: 90 }; });
  const out = updateManifest(fx.featureDir, (m) => touchActivity(m, '2026-10-19T00:00:00.000Z'));
  assert.deepEqual(out, { version: 1, plan: { selected: ['a'], budget_s: 90 }, last_activity: '2026-10-19T00:00:00.000Z' });
  assert.deepEqual(readManifest(fx.featureDir), out);
  const text = fs.readFileSync(path.join(fx.featureDir, 'verification', 'manifest.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
});

test('updateManifest atomicity: throwing mutator and concurrent change leave the file intact, no temp leftovers', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const vdir = verificationDir(fx.featureDir);
  const file = path.join(vdir, 'manifest.json');
  updateManifest(fx.featureDir, (m) => { m.plan = { selected: ['a'] }; });
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(() => updateManifest(fx.featureDir, (m) => { m.plan = null; throw new Error('boom'); }), /boom/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const concurrent = JSON.stringify({ version: 1, verdict: { status: 'PASSED' } });
  assert.throws(
    () => updateManifest(fx.featureDir, (m) => { m.build = { status: 'built' }; fs.writeFileSync(file, concurrent); }),
    (e) => e instanceof UsageError && /changed on disk/.test(e.message),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), concurrent, 'the concurrent write is not clobbered');
  assert.deepEqual(leftoverTempFiles(vdir), []);
});

test('readManifest: invalid JSON or unknown version → UsageError', (t) => {
  const fx = mkFixture({ files: { 'verification/manifest.json': '{nope' } });
  t.after(() => fx.cleanup());
  assert.throws(() => readManifest(fx.featureDir), UsageError);
  fs.writeFileSync(path.join(fx.featureDir, 'verification', 'manifest.json'), '{"version":2}');
  assert.throws(() => readManifest(fx.featureDir), /unsupported manifest version/);
});

test('screenLimit and touchActivity', () => {
  assert.equal(screenLimit({ timeout_s: 90 }, { screen_timeout_s: 120 }), 90);
  assert.equal(screenLimit({}, { screen_timeout_s: 120 }), 120);
  assert.equal(screenLimit({}, null), 180);
  const m = { version: 1 };
  assert.equal(touchActivity(m, 'X'), m);
  assert.equal(m.last_activity, 'X');
});

// ---------------------------------------------------------------------------
// Dispatcher (cmd-visual.mjs) + registry
// ---------------------------------------------------------------------------

test('dispatcher: routes to visual-<sub>.mjs in the module dir seam', async (t) => {
  const lib = tmpDir(t, 'visual-lib-');
  fs.writeFileSync(path.join(lib, 'visual-plan.mjs'),
    'export async function run(argv, ctx) { ctx.stdout.write("plan " + JSON.stringify(argv) + "\\n"); return 0; }\n');
  fs.writeFileSync(path.join(lib, 'visual-verdict.mjs'), 'export async function run() { return 1; }\n');
  fs.writeFileSync(path.join(lib, 'visual-gallery.mjs'), 'export const x = 1;\n');
  const libUrl = pathToFileURL(lib + path.sep);

  let ctx = mkCtx();
  assert.equal(await runVisualWith(['plan', '--all', '--json'], ctx, { libUrl }), 0);
  assert.equal(ctx.out(), 'plan ["--all","--json"]\n');

  ctx = mkCtx();
  assert.equal(await runVisualWith(['verdict'], ctx, { libUrl }), 1);

  ctx = mkCtx();
  assert.equal(await runVisualWith(['build'], ctx, { libUrl }), 2);
  assert.equal(ctx.err(), 'visual build: not implemented yet\n');

  ctx = mkCtx();
  assert.equal(await runVisualWith(['gallery'], ctx, { libUrl }), 2);
  assert.match(ctx.err(), /no run\(\) export/);
});

test('dispatcher: --help, missing and unknown subcommands', async () => {
  let ctx = mkCtx();
  assert.equal(await runVisual(['--help'], ctx), 0);
  for (const sub of SUBCOMMANDS) assert.match(ctx.out(), new RegExp(`\\b${sub}\\b`));
  ctx = mkCtx();
  assert.equal(await runVisual([], ctx), 2);
  assert.match(ctx.err(), /missing subcommand/);
  ctx = mkCtx();
  assert.equal(await runVisual(['frobnicate'], ctx), 2);
  assert.match(ctx.err(), /unknown subcommand 'frobnicate'[\s\S]*usage: dev-cycle visual/);
  ctx = mkCtx();
  assert.equal(await runVisual(['--definitely-not-a-flag'], ctx), 2);
});

test('CLI: visual and report are registered (exit 2 until their modules land, never 0 on bad input)', (t) => {
  const fx = mkFixture();
  t.after(() => fx.cleanup());
  const help = runCli(['--help'], { cwd: fx.root });
  assert.match(help.stdout, /\bvisual\b/);
  assert.match(help.stdout, /\breport\b/);
  const v = runCli(['visual', 'nope'], { cwd: fx.root });
  assert.equal(v.status, 2);
  assert.match(v.stderr, /unknown subcommand 'nope'/);
  const vh = runCli(['visual', '--help'], { cwd: fx.root });
  assert.equal(vh.status, 0);
  assert.match(vh.stdout, /usage: dev-cycle visual/);
});
