import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixture, mkCtx, sampleFeatureJson } from './helpers.mjs';
import { run, runWith, selectScreens, groupFlows } from '../plugin/scripts/lib/visual-plan.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'visual-plan');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');

function setup(t, { fj = {}, withProfile = true, spec = null, plan = true } = {}) {
  const visual = withProfile ? JSON.parse(fx('profile-visual.json')) : undefined;
  const f = mkFixture({
    featureJson: sampleFeatureJson({ track: 'full', ...(visual ? { profile: { visual } } : {}), ...fj }),
    files: { ...(plan ? { 'plan.md': fx('plan.md') } : {}), ...(spec ? { 'spec.md': spec } : {}) },
  });
  t.after(() => f.cleanup());
  return f;
}
const manifest = (f) => JSON.parse(fs.readFileSync(path.join(f.featureDir, 'verification', 'manifest.json'), 'utf8'));
const exec = async (f, args) => {
  const ctx = mkCtx({ cwd: f.root });
  const code = await run(['--feature', f.featureDir, ...args], ctx);
  return { code, out: ctx.out(), err: ctx.err() };
};

test('full track: 3-task plan selects the 2 lis screens; budget is the sum of timeouts', async (t) => {
  const f = setup(t);
  const r = await exec(f, ['--json']);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.deepEqual(d.screens.map((s) => s.id), ['lis-home', 'lis-detail']);
  assert.equal(d.budget_s, 90 + 120);
  const p = manifest(f).plan;
  assert.deepEqual(p.selected, ['lis-home', 'lis-detail']);
  assert.equal(p.budget_s, 210);
  assert.deepEqual(p.flows, [{ flow: 'maestro --device {device} test flows/lis.yaml', screens: ['lis-home'] }]);
});

test('--all selects all 4; a spec row with a new id adds a 5th', async (t) => {
  const f = setup(t);
  assert.equal(JSON.parse((await exec(f, ['--all', '--json'])).out).screens.length, 4);
  const g = setup(t, { spec: fx('spec-screens.md') });
  const d = JSON.parse((await exec(g, ['--all', '--json'])).out);
  assert.equal(d.screens.length, 5);
  assert.equal(d.screens[4].id, 'settings');
});

test('explicit budget_s wins over the sum', async (t) => {
  const visual = JSON.parse(fx('profile-visual.json'));
  visual.budget_s = 500;
  const f = setup(t, { fj: { profile: { visual } } });
  assert.equal(JSON.parse((await exec(f, ['--json'])).out).budget_s, 500);
});

test('lite track uses areas[].touches', async (t) => {
  const f = setup(t, { fj: { track: 'lite', areas: [{ name: 'other', touches: ['apps/other/x.ts'] }] }, plan: false });
  assert.deepEqual(JSON.parse((await exec(f, ['--json'])).out).screens.map((s) => s.id), ['other']);
});

test('quick track uses git diff against the default branch', async (t) => {
  const f = setup(t, { fj: { track: 'quick' }, plan: false });
  const calls = [];
  const gitRun = async (args) => {
    calls.push(args);
    return { code: 0, stdout: 'apps/mova/src/lis/home.tsx\n', stderr: '' };
  };
  const ctx = mkCtx({ cwd: f.root });
  assert.equal(await runWith(['--feature', f.featureDir, '--json'], ctx, { gitRun }), 0);
  assert.deepEqual(JSON.parse(ctx.out()).screens.map((s) => s.id), ['lis-home', 'lis-detail']);
  assert.deepEqual(calls.at(-1), ['diff', '--name-only', 'main...HEAD']);
});

test('no catalog: ad-hoc mode, exit 0', async (t) => {
  const f = setup(t, { withProfile: false });
  const r = await exec(f, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /no catalog: ad-hoc mode/);
  const j = JSON.parse((await exec(f, ['--json'])).out);
  assert.deepEqual(j.screens, []);
  assert.equal(manifest(f).plan.catalog, false);
});

test('pure helpers', () => {
  const cat = [{ id: 'a', touches: ['x/*.ts'], flow: 'f' }, { id: 'b', flow: 'f' }, { id: 'c', route: '/c' }];
  assert.deepEqual(selectScreens(cat, ['x/**'], false).map((s) => s.id), ['a']);
  assert.deepEqual(groupFlows(cat), [{ flow: 'f', screens: ['a', 'b'] }]);
});
