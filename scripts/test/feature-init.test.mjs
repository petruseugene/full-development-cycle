import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli } from './helpers.mjs';

const PROFILE = {
  platform: 'mobile',
  interview_defaults: { visual_tests: false },
  commands: { lint: 'pnpm lint' },
  extra_gates: [{ name: 'content', cmd: 'pnpm validate-content' }],
  post_merge: [{ name: 'dev', cmd: 'x.sh', confirm: true }],
  guards: ['g1'],
  rules: [{ globs: ['src/**'], text: 'r' }],
  enabled_skills: ['frontend-dev', 'discovery', 'visual-tester', 'plan-writer'],
};

const readFj = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'feature.json'), 'utf8'));

test('AC16: --answer > profile > track defaults; profile copied', () => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify(PROFILE));
  const r = runCli(['feature', 'init', 'x', '--flow', 'feature', '--track', 'full', '--answer', 'visual_tests=true'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.match(path.basename(dir), /^\d{4}-\d{2}-\d{2}-\d{2}h-\d{2}m-x$/);
  assert.equal(path.dirname(dir), fx.featuresDir);
  const fj = readFj(dir);
  assert.equal(fj.platform, 'mobile');
  assert.equal(fj.visual_tests, true);
  assert.deepEqual(fj.profile.extra_gates, PROFILE.extra_gates);
  assert.deepEqual(fj.profile.guards, PROFILE.guards);
  assert.deepEqual(fj.profile.rules, PROFILE.rules);
  assert.deepEqual(fj.profile.post_merge, PROFILE.post_merge);
  assert.deepEqual(fj.profile.enabled_skills, PROFILE.enabled_skills);
  fx.cleanup();
});

test('AC16: profile default beats track default when no --answer', () => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ ...PROFILE, interview_defaults: { visual_tests: false, discovery: 'internal' } }));
  const r = runCli(['feature', 'init', 'y', '--flow', 'feature', '--track', 'full'], { cwd: fx.root });
  const fj = readFj(r.stdout.trim());
  assert.equal(fj.visual_tests, false);
  assert.equal(fj.discovery, 'internal');
  fx.cleanup();
});

test('AC16: no profile => no profile key; track discovery defaults', () => {
  const fx = mkFixture();
  const full = readFj(runCli(['feature', 'init', 'a', '--flow', 'feature', '--track', 'full'], { cwd: fx.root }).stdout.trim());
  assert.equal('profile' in full, false);
  assert.equal(full.platform, 'web');
  assert.equal(full.discovery, 'full');
  const lite = readFj(runCli(['feature', 'init', 'b', '--flow', 'feature', '--track', 'lite'], { cwd: fx.root }).stdout.trim());
  assert.equal(lite.discovery, 'skip');
  fx.cleanup();
});

test('feature init usage errors exit 2', () => {
  const fx = mkFixture();
  const bad = [
    ['feature', 'init', 'Bad_Slug', '--flow', 'feature', '--track', 'full'],
    ['feature', 'init', 'x', '--flow', 'nope', '--track', 'full'],
    ['feature', 'init', 'x', '--flow', 'feature', '--track', 'huge'],
    ['feature', 'init', 'x', '--flow', 'feature', '--track', 'full', '--answer', 'bogus=1'],
    ['feature', 'init', 'x', '--flow', 'feature', '--track', 'full', '--answer', 'has_ui=maybe'],
    ['feature', 'frob'],
  ];
  for (const a of bad) assert.equal(runCli(a, { cwd: fx.root }).status, 2, a.join(' '));
  fx.cleanup();
});

test('feature set: allowlisted keys write and print', () => {
  const fx = mkFixture();
  const set = (k, v) => runCli(['feature', 'set', k, v], { cwd: fx.root });
  const fj = () => JSON.parse(fx.read(`docs/features/${path.basename(fx.featureDir)}/feature.json`));
  let r = set('current_phase', 'review');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'feature.current_phase = "review"');
  assert.equal(fj().current_phase, 'review');
  assert.equal(set('task_count', '5').status, 0);
  assert.equal(fj().task_count, 5);
  assert.equal(set('branch', 'feat/x').status, 0);
  assert.equal(fj().branch, 'feat/x');
  assert.equal(set('status', 'blocked').status, 0);
  assert.equal(set('design_source', 'null').status, 0);
  assert.equal(fj().design_source, null);
  assert.equal(set('areas', '[{"name":"api","touches":["src/**"]}]').status, 0);
  assert.equal(set('models', '{"backend-dev":"opus"}').status, 0);
  assert.deepEqual(fj().models, { 'backend-dev': 'opus' });
  fx.cleanup();
});

test('feature set: invalid key/value exits 2 and leaves file unchanged', () => {
  const fx = mkFixture();
  const file = `docs/features/${path.basename(fx.featureDir)}/feature.json`;
  const before = fx.read(file);
  const bad = [
    ['history', '[]'], ['totals', '{}'], ['flow', 'bugfix'],
    ['current_phase', 'bogus'], ['current_task_idx', '-1'], ['task_count', '1.5'],
    ['branch', '""'], ['status', 'done'],
    ['areas', '[{"name":"A b","touches":["x"]}]'],
    ['areas', '[{"name":"a","touches":["x"]},{"name":"a","touches":["y"]}]'],
    ['areas', '[{"name":"a","touches":[]}]'],
    ['models', '{"nope":"opus"}'], ['models', '{"backend-dev":"gpt"}'],
    ['design_source', '5'],
  ];
  for (const [k, v] of bad) assert.equal(runCli(['feature', 'set', k, v], { cwd: fx.root }).status, 2, `${k} ${v}`);
  assert.equal(fx.read(file), before);
  fx.cleanup();
});

let seq = 0;
const init = (fx, args, env = {}) => runCli(['feature', 'init', `z${seq++}`, ...args], { cwd: fx.root, env });

test('AC29: started_at and sessions from env', () => {
  const fx = mkFixture();
  let r = init(fx, ['--flow', 'feature', '--track', 'full'], { CLAUDE_CODE_SESSION_ID: 'sess-1' });
  let fj = readFj(r.stdout.trim());
  assert.ok(!Number.isNaN(Date.parse(fj.started_at)));
  assert.deepEqual(fj.sessions, ['sess-1']);
  const env = { ...process.env }; delete env.CLAUDE_CODE_SESSION_ID;
  r = init(fx, ['--flow', 'feature', '--track', 'lite'], { CLAUDE_CODE_SESSION_ID: '' });
  fj = readFj(r.stdout.trim());
  assert.deepEqual(fj.sessions, []);
  fx.cleanup();
});

test('AC32/AC33: enabled_skills yields skipped_skills and forced values', () => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ enabled_skills: ['auto-tester'] }));
  const r = init(fx, ['--flow', 'feature', '--track', 'full', '--answer', 'security_review=true', '--answer', 'discovery=full']);
  assert.equal(r.status, 0, r.stderr);
  const fj = readFj(r.stdout.trim());
  for (const s of ['security-reviewer', 'discovery', 'wireframer', 'plan-writer']) assert.ok(fj.skipped_skills.includes(s), s);
  assert.ok(!fj.skipped_skills.includes('auto-tester'));
  assert.ok(!fj.skipped_skills.includes('backend-dev'));
  assert.equal(fj.security_review, false);
  assert.equal(fj.discovery, 'skip');
  assert.equal(fj.separate_plan, false);
  assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('! SKILL:')).length >= 3, true);
  assert.match(r.stderr, /! SKILL: security_review=false forced .* security-reviewer not in enabled_skills/);
  fx.cleanup();
});

test('AC33: no enabled_skills => no skipped_skills', () => {
  const fx = mkFixture();
  const r = init(fx, ['--flow', 'feature', '--track', 'full']);
  assert.equal('skipped_skills' in readFj(r.stdout.trim()), false);
  fx.cleanup();
});

test('AC35: separate_plan defaults and precedence', () => {
  const fx = mkFixture();
  assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', 'full']).stdout.trim()).separate_plan, true);
  assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', 'full', '--answer', 'separate_plan=false']).stdout.trim()).separate_plan, false);
  for (const t of ['lite', 'quick']) {
    assert.equal('separate_plan' in readFj(init(fx, ['--flow', 'feature', '--track', t]).stdout.trim()), false);
  }
  fx.write('.dev-cycle/project.json', JSON.stringify({ interview_defaults: { separate_plan: false } }));
  assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', 'full']).stdout.trim()).separate_plan, false);
  fx.cleanup();
});

test('AC41: --track optional for bugfix and feature (AC32 default quick)', () => {
  const fx = mkFixture();
  let r = init(fx, ['--flow', 'bugfix']);
  assert.equal(r.status, 0, r.stderr);
  let fj = readFj(r.stdout.trim());
  assert.equal('track' in fj, false);
  assert.equal(fj.current_phase, 'implement');
  r = init(fx, ['--flow', 'bugfix', '--track', 'full']);
  assert.match(r.stderr, /--track ignored for flow bugfix/);
  assert.equal('track' in readFj(r.stdout.trim()), false);
  r = init(fx, ['--flow', 'feature']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFj(r.stdout.trim()).track, 'quick');
  assert.match(r.stderr, /^track: quick \(default\)$/m);
  fx.cleanup();
});

test('AC25: owner_blocking via --answer and feature set; recipes snapshot', () => {
  const fx = mkFixture();
  const recipes = [{ name: 'r', cmd: 'echo {a}', params: { a: {} } }];
  fx.write('.dev-cycle/project.json', JSON.stringify({ recipes }));
  const r = runCli(['feature', 'init', 'y', '--flow', 'feature', '--track', 'full', '--answer', 'owner_blocking=true'], { cwd: fx.root });
  assert.equal(r.status, 0, r.stderr);
  const fj = readFj(r.stdout.trim());
  assert.equal(fj.owner_blocking, true);
  assert.deepEqual(fj.profile.recipes, recipes);
  fx.cleanup();

  const f2 = mkFixture();
  const set = (k, v) => runCli(['feature', 'set', k, v], { cwd: f2.root });
  assert.equal(set('owner_blocking', 'true').status, 0);
  assert.equal(set('owner_blocking', 'x').status, 2);
  f2.cleanup();
});

const writeProfile = (fx, p) => fx.write('.dev-cycle/project.json', JSON.stringify(p));

test('AC22: old skill names in enabled_skills warn once each and still count', () => {
  const fx = mkFixture();
  const listed = ['frontend-dev', 'discovery', 'a11y-auditor', 'static-checker', 'auto-tester', 'security-reviewer', 'dependency-auditor', 'release-manager', 'plan-writer', 'visual-tester'];
  writeProfile(fx, { enabled_skills: listed });
  const r = init(fx, ['--flow', 'feature', '--track', 'full']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.split('\n');
  assert.equal(lines.filter((l) => l === "warning: skill 'a11y-auditor' was merged into 'visual-tester'").length, 1);
  assert.equal(lines.filter((l) => l === "warning: skill 'static-checker' was merged into 'cli-fallback'").length, 1);
  const fj = readFj(r.stdout.trim());
  assert.notEqual(fj.a11y_audit, false);
  assert.notEqual(fj.dependency_audit, false);
  assert.notEqual(fj.release_manage, false);
  fx.cleanup();
});

test('AC22: omitting an old name still forces its flag false', () => {
  const fx = mkFixture();
  writeProfile(fx, { enabled_skills: ['frontend-dev', 'discovery', 'visual-tester'] });
  const r = init(fx, ['--flow', 'feature', '--track', 'full']);
  assert.equal(r.status, 0, r.stderr);
  const fj = readFj(r.stdout.trim());
  assert.equal(fj.a11y_audit, false);
  assert.equal(fj.dependency_audit, false);
  assert.equal(fj.release_manage, false);
  assert.match(r.stderr, /a11y_audit=false forced/);
  fx.cleanup();
});

test('AC23: feature set models maps old keys, new key wins, release-manager ignored', () => {
  const fx = mkFixture();
  const set = (v) => runCli(['feature', 'set', 'models', JSON.stringify(v)], { cwd: fx.root });
  const fj = () => JSON.parse(fx.read(`docs/features/${path.basename(fx.featureDir)}/feature.json`));
  let r = set({ 'a11y-auditor': 'haiku' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fj().models, { 'visual-tester': 'haiku' });
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /warning: skill 'a11y-auditor' was merged into 'visual-tester'/);
  r = set({ 'a11y-auditor': 'haiku', 'visual-tester': 'opus' });
  assert.deepEqual(fj().models, { 'visual-tester': 'opus' });
  r = set({ 'release-manager': 'opus' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fj().models, {});
  assert.match(r.stderr, /release-manager/);
  fx.cleanup();
});

test('AC31: discovery defaults to internal with a profile (full, lite); precedence holds', () => {
  const fx = mkFixture();
  writeProfile(fx, {});
  for (const t of ['full', 'lite']) {
    assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', t]).stdout.trim()).discovery, 'internal', t);
  }
  assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', 'full', '--answer', 'discovery=full']).stdout.trim()).discovery, 'full');
  assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', 'quick']).stdout.trim()).discovery, 'skip');
  writeProfile(fx, { interview_defaults: { discovery: 'skip' } });
  assert.equal(readFj(init(fx, ['--flow', 'feature', '--track', 'full']).stdout.trim()).discovery, 'skip');
  fx.cleanup();
  const nx = mkFixture();
  assert.equal(readFj(init(nx, ['--flow', 'feature', '--track', 'full']).stdout.trim()).discovery, 'full');
  assert.equal(readFj(init(nx, ['--flow', 'feature', '--track', 'lite']).stdout.trim()).discovery, 'skip');
  nx.cleanup();
});

test('tdd AC2/AC4: --answer tdd writes top-level; invalid exits 2; absent by default', () => {
  const fx = mkFixture();
  let r = init(fx, ['--flow', 'feature', '--track', 'lite', '--answer', 'tdd=true']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFj(r.stdout.trim()).tdd, true);
  r = init(fx, ['--flow', 'feature', '--track', 'lite', '--answer', 'tdd=maybe']);
  assert.equal(r.status, 2);
  r = init(fx, ['--flow', 'feature', '--track', 'lite']);
  assert.equal('tdd' in readFj(r.stdout.trim()), false);
  fx.cleanup();
});

test('tdd AC3: profile default applies to full, quick and bugfix; --answer overrides', () => {
  const fx = mkFixture();
  fx.write('.dev-cycle/project.json', JSON.stringify({ interview_defaults: { tdd: true } }));
  for (const args of [['--flow', 'feature', '--track', 'full'], ['--flow', 'feature', '--track', 'quick'], ['--flow', 'bugfix']]) {
    const r = init(fx, args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFj(r.stdout.trim()).tdd, true, args.join(' '));
  }
  const o = init(fx, ['--flow', 'feature', '--track', 'full', '--answer', 'tdd=false']);
  assert.equal(readFj(o.stdout.trim()).tdd, false);
  fx.cleanup();
});

test('tdd AC5: feature set tdd validates boolean', () => {
  const fx = mkFixture();
  const set = (v) => runCli(['feature', 'set', 'tdd', v], { cwd: fx.root });
  assert.equal(set('true').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.featureDir, 'feature.json'), 'utf8')).tdd, true);
  const bad = set('yes');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must be a boolean/);
  fx.cleanup();
});

test('tdd AC6: tdd with auto_tests=false is valid and silent; skill forcing leaves tdd', () => {
  const fx = mkFixture();
  let r = init(fx, ['--flow', 'feature', '--track', 'full', '--answer', 'tdd=true', '--answer', 'auto_tests=false']);
  assert.equal(r.status, 0, r.stderr);
  const fj = readFj(r.stdout.trim());
  assert.equal(fj.tdd, true);
  assert.equal(fj.auto_tests, false);
  assert.doesNotMatch(r.stderr, /tdd|auto_tests/);
  fx.write('.dev-cycle/project.json', JSON.stringify({ enabled_skills: ['frontend-dev'], interview_defaults: { tdd: true } }));
  r = init(fx, ['--flow', 'feature', '--track', 'full']);
  assert.equal(r.status, 0, r.stderr);
  const f2 = readFj(r.stdout.trim());
  assert.equal(f2.auto_tests, false);
  assert.equal(f2.tdd, true);
  fx.cleanup();
});
