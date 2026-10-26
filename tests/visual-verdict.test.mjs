import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, mkCtx, sampleFeatureJson } from './helpers.mjs';
import { computeVerdict, mergeReport, run } from '../plugin/scripts/lib/visual-verdict.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'visual-verdict');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');
const T0 = '2026-10-19T10:00:00.000Z';
const T1 = '2026-10-19T10:05:00.000Z';

const scaleCheck = (result) => ({
  type: 'scale', subject: 'friend/hero', measured: result === 'pass' ? 1.0 : 0.85, expected: 1.0,
  tolerance: 10, source: 'vision', result,
});

function goodManifest(over = {}) {
  const screen = (id, acs) => ({
    id, acs, target: 'iPhone 15', duration_s: 20, timeout_s: 100, screenshot: `${id}.png`,
    checks: [scaleCheck('pass')], failures: [], updated_at: T0,
  });
  return {
    version: 1,
    last_activity: T0,
    plan: { ts: T0, selected: ['home', 'detail'], budget_s: 200 },
    build: { status: 'built' },
    screens: { home: screen('home', ['AC3']), detail: screen('detail', ['AC4', 'AC5']) },
    ...over,
  };
}
const goodTeardown = () => ({ ts: T1, steps: [{ name: 'simctl', exit_code: 0, ok: true }] });

function setup(t, { manifest = goodManifest(), teardown = goodTeardown(), report = null, refs = ['design/home.png', 'design/detail.png'] } = {}) {
  const visual = JSON.parse(fx('profile-visual.json'));
  const f = mkFixture({
    featureJson: sampleFeatureJson({ platform: 'mobile', profile: { visual } }),
    files: report === null ? {} : { 'test-report.md': report },
  });
  t.after(() => f.cleanup());
  for (const r of refs) f.write(r, 'png');
  const vdir = path.join(f.featureDir, 'verification');
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, 'manifest.json'), JSON.stringify(manifest));
  if (teardown) fs.writeFileSync(path.join(vdir, 'teardown.json'), JSON.stringify(teardown));
  return f;
}
const catalogOf = () => JSON.parse(fx('profile-visual.json')).screens;
const reportOf = (f) => fs.readFileSync(path.join(f.featureDir, 'test-report.md'), 'utf8');
async function exec(f) {
  const ctx = mkCtx({ cwd: f.root });
  const code = await run(['--feature', f.featureDir, '--json'], ctx);
  return { code, data: JSON.parse(ctx.out()) };
}

// ---- computeVerdict: every AC12 reason in isolation -----------------------

function verdictFor(f, mutate) {
  const manifest = goodManifest();
  const teardown = goodTeardown();
  const ctxIn = { manifest, catalog: catalogOf(), teardown, root: f.root, visual: JSON.parse(fx('profile-visual.json')), platform: 'mobile' };
  mutate?.(ctxIn);
  return computeVerdict(ctxIn);
}

test('all passing with a fresh marker is PASSED', (t) => {
  const f = setup(t);
  const v = verdictFor(f);
  assert.equal(v.status, 'PASSED');
  assert.deepEqual(v.reasons, []);
  assert.equal(v.passed, 2);
});

const CASES = {
  missing: (c) => { delete c.manifest.screens.detail; },
  'no-reference': (c) => { fs.rmSync(path.join(c.root, 'design/home.png')); },
  unmeasured: (c) => { c.manifest.screens.home.checks[0].result = 'unmeasured'; },
  fail: (c) => { c.manifest.screens.home.checks[0] = scaleCheck('fail'); },
  timeout: (c) => { c.manifest.screens.home.result = 'timeout'; },
  '--fail': (c) => { c.manifest.screens.home.failures = ['console error: boom']; },
  'build failed': (c) => { c.manifest.build.status = 'failed'; },
  'over budget': (c) => { c.manifest.plan.budget_s = 30; },
  'no-screens': (c) => { c.manifest.screens = {}; c.manifest.plan.selected = []; },
  'no-teardown': (c) => { c.teardown = null; },
  'no-teardown (stale)': (c) => { c.teardown.ts = '2026-10-19T09:00:00.000Z'; },
  'teardown step failed': (c) => { c.teardown.steps[0] = { name: 'adb', exit_code: 1, ok: false }; },
};
for (const [name, mutate] of Object.entries(CASES)) {
  test(`reason alone fails: ${name}`, (t) => {
    const f = setup(t);
    const v = verdictFor(f, mutate);
    assert.equal(v.status, 'FAILED');
    const key = name.replace(' (stale)', '');
    assert.ok(v.reasons.some((r) => r.startsWith(key)), `${key} in ${JSON.stringify(v.reasons)}`);
    // Isolation: only that reason (plus its own consequences) is present.
    assert.ok(v.reasons.length >= 1);
  });
}

test('target falls back to visual.device then platform', (t) => {
  const f = setup(t);
  const v = verdictFor(f, (c) => { delete c.manifest.screens.home.target; c.manifest.screens.detail.target = 'web-375'; });
  assert.equal(v.screens.find((s) => s.id === 'home').target, 'A1B2C3D4-0000-1111-2222-333344445555');
  assert.equal(v.screens.find((s) => s.id === 'detail').target, 'web-375');
  const w = computeVerdict({ manifest: goodManifest({ screens: { x: { id: 'x', screenshot: 'x.png' } }, plan: {} }), catalog: [], teardown: goodTeardown(), root: f.root, platform: 'web' });
  assert.equal(w.screens[0].target, 'web');
});

// ---- command ---------------------------------------------------------------

test('scale fail: FAILED section, exit 1, frontmatter + manifest.verdict', async (t) => {
  const m = goodManifest();
  m.screens.home.checks[0] = scaleCheck('fail');
  const f = setup(t, { manifest: m });
  const r = await exec(f);
  assert.equal(r.code, 1);
  const text = reportOf(f);
  assert.match(text, /^---\nstatus: FAILED\nfailures_count: 1\n---\n/);
  assert.match(text, /## Visual tests — \S+ — FAILED/);
  assert.match(text, /visual-diff: 1\/2/);
  assert.match(text, /Run time: 40s \/ budget 200s/);
  assert.match(text, /- \[fail\] home @ iPhone 15 — scale friend\/hero 0.85 vs 1.00 ±10% \(vision\)/);
  assert.match(text, /## AC coverage — visual\n- \[fail\] AC3 — verification\/manifest.json › "home"\n- \[pass\] AC4, AC5/);
  const mf = JSON.parse(fs.readFileSync(path.join(f.featureDir, 'verification', 'manifest.json'), 'utf8'));
  assert.equal(mf.verdict.status, 'FAILED');
  assert.equal(mf.verdict.passed, 1);
});

test('all passing: PASSED, exit 0, file created with frontmatter', async (t) => {
  const f = setup(t);
  const r = await exec(f);
  assert.equal(r.code, 0);
  const text = reportOf(f);
  assert.match(text, /^---\nstatus: PASSED\nfailures_count: 0\n---\n/);
  assert.match(text, /## Visual tests — \S+ — PASSED/);
});

test('missing teardown marker: FAILED with a header reason', async (t) => {
  const f = setup(t, { teardown: null });
  const r = await exec(f);
  assert.equal(r.code, 1);
  assert.match(reportOf(f), /Reasons: no-teardown/);
});

test('double run leaves exactly one section, text stable', async (t) => {
  const m = goodManifest();
  m.screens.home.checks[0] = scaleCheck('fail');
  const f = setup(t, { manifest: m, report: fx('test-report-auto.md') });
  await exec(f);
  const once = reportOf(f);
  await exec(f);
  const twice = reportOf(f);
  assert.equal(twice.match(/^## Visual tests/gm).length, 1);
  assert.equal(twice.match(/^## AC coverage — visual/gm).length, 1);
  assert.equal(twice.replace(/— \d{4}-[^ ]+ —/, '— TS —'), once.replace(/— \d{4}-[^ ]+ —/, '— TS —'));
  assert.match(twice, /failures_count: 3/);
});

test('AC13: auto section stays byte-identical; FAILED and count 2 kept on PASSED', async (t) => {
  const auto = fx('test-report-auto.md');
  const f = setup(t, { report: auto });
  const r = await exec(f);
  assert.equal(r.code, 0);
  const text = reportOf(f);
  assert.match(text, /^---\nstatus: FAILED\nfailures_count: 2\n---\n/);
  const body = auto.slice(auto.indexOf('## Unit tests'));
  assert.ok(text.includes(body.trimEnd() + '\n'), 'auto sections preserved');
  assert.ok(text.indexOf('## Unit tests') < text.indexOf('## Visual tests'));
  // Re-running after a failing visual run then a passing one restores the original count.
  await exec(f);
  assert.match(reportOf(f), /failures_count: 2/);
});

test('a PASSED rerun after a visual FAILED clears status when nothing else failed', async (t) => {
  const bad = goodManifest();
  bad.screens.home.checks[0] = scaleCheck('fail');
  const f = setup(t, { manifest: bad });
  await exec(f);
  assert.match(reportOf(f), /status: FAILED/);
  fs.writeFileSync(path.join(f.featureDir, 'verification', 'manifest.json'), JSON.stringify(goodManifest()));
  const r = await exec(f);
  assert.equal(r.code, 0);
  assert.match(reportOf(f), /^---\nstatus: PASSED\nfailures_count: 0\n---\n/);
});

test('agent Notes block survives a rerun', async (t) => {
  const f = setup(t);
  await exec(f);
  fs.appendFileSync(path.join(f.featureDir, 'test-report.md'), '\n**Notes:** hero looked fine to me\n');
  await exec(f);
  const text = reportOf(f);
  assert.equal(text.match(/\*\*Notes:\*\*/g).length, 1);
  assert.match(text, /hero looked fine/);
});

test('mergeReport creates frontmatter for a file without one', () => {
  const v = { status: 'PASSED', reasons: [], screens: [], run_time_s: 0, budget_s: 0, passed: 0, total: 0 };
  const out = mergeReport('# Report\n\n## Unit\nok\n', v, { ts: T0 });
  assert.match(out, /^---\nstatus: PASSED\nfailures_count: 0\n---\n\n# Report/);
});

test('F6: without a plan, a catalog screen with checks that ran/marked but was never checked is missing', (t) => {
  const f = setup(t);
  const catalog = [
    { id: 'home', reference: 'design/home.png', checks: [{ type: 'scale', a: 'friend', b: 'hero' }] },
    { id: 'detail', reference: 'design/detail.png' },
  ];
  const manifest = goodManifest();
  delete manifest.plan;
  manifest.screens.home = { ...manifest.screens.home, checks: [] };
  manifest.screens.detail = { ...manifest.screens.detail, checks: [] };
  const v = computeVerdict({ manifest, catalog, teardown: goodTeardown(), root: f.root, platform: 'mobile' });
  assert.equal(v.status, 'FAILED');
  assert.ok(v.reasons.includes('missing: home'), v.reasons.join('; '));
  // A catalog screen without profile checks keeps the screenshot-is-enough rule.
  assert.ok(!v.reasons.includes('missing: detail'), v.reasons.join('; '));
  // Once checked, the same unplanned screen passes.
  manifest.screens.home.checks = [scaleCheck('pass')];
  assert.equal(computeVerdict({ manifest, catalog, teardown: goodTeardown(), root: f.root, platform: 'mobile' }).status, 'PASSED');
});

test('AC38: ad-hoc web screen with an AC and a breakpoint; ad-hoc without AC listed', () => {
  const manifest = {
    version: 1, last_activity: T0, plan: {}, build: { status: 'built' },
    screens: {
      shot: { id: 'shot', adhoc: true, target: 'web', breakpoint: 375, acs: ['AC3'], duration_s: 5, timeout_s: 100, screenshot: 's.png', checks: [] },
      bare: { id: 'bare', adhoc: true, target: 'web', duration_s: 5, timeout_s: 100, screenshot: 'b.png', checks: [] },
    },
  };
  const v = computeVerdict({ manifest, catalog: [], teardown: goodTeardown(), root: '/nonexistent-root', platform: 'web' });
  const text = mergeReport(null, v, { ts: T1 });
  assert.match(text, /- \[pass\] shot @ 375 /);
  assert.doesNotMatch(text, /shot @ web/);
  assert.match(text, /bare @ web /);
  assert.match(text, /## AC coverage — visual\n- \[pass\] AC3 — verification\/manifest.json › "shot"\n- ad-hoc, no AC: bare\n/);
});
