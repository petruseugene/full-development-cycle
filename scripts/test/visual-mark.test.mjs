import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWith } from '../lib/visual-mark.mjs';
import { makeContext, UsageError } from '../lib/core.mjs';
import { mkFixture, sampleFeatureJson, runCli, DEFAULT_FEATURE } from './helpers.mjs';

const VISUAL = { screen_timeout_s: 100, screens: [{ id: 'home', title: 'Home', route: '/', reference: 'refs/home.png', acs: ['AC1'] }] };

function setup(t) {
  const fx = mkFixture({ featureJson: sampleFeatureJson({ profile: { visual: VISUAL } }) });
  t.after(() => fx.cleanup());
  const out = [];
  const ctx = makeContext({ cwd: fx.root, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write() {} } });
  const manifest = () => JSON.parse(fx.read(`docs/features/${DEFAULT_FEATURE}/verification/manifest.json`));
  const mark = (argv, ms) => runWith(['--json', ...argv], ctx, { now: () => ms });
  return { fx, out, manifest, mark };
}
const T0 = Date.parse('2026-01-01T00:00:00Z');

test('1.5x the limit → overrun, not failed for time', async (t) => {
  const { manifest, mark } = setup(t);
  await mark(['home', 'start'], T0);
  await mark(['home', 'end'], T0 + 150_000);
  const s = manifest().screens.home;
  assert.equal(s.duration_s, 150);
  assert.equal(s.overrun, true);
  assert.equal(s.result, undefined);
  assert.equal(s.reference, 'refs/home.png');
  assert.equal(manifest().last_activity, new Date(T0 + 150_000).toISOString());
});

test('2.1x the limit → result timeout', async (t) => {
  const { manifest, mark } = setup(t);
  await mark(['home', 'start'], T0);
  await mark(['home', 'end'], T0 + 210_000);
  const s = manifest().screens.home;
  assert.equal(s.result, 'timeout');
  assert.equal(s.overrun, true);
});

test('within the limit → no overrun', async (t) => {
  const { manifest, mark } = setup(t);
  await mark(['home', 'start'], T0);
  await mark(['home', 'end'], T0 + 50_000);
  assert.equal(manifest().screens.home.overrun, false);
});

test('unknown id without --adhoc → UsageError (exit 2)', async (t) => {
  const { mark, fx } = setup(t);
  await assert.rejects(mark(['nope', 'start'], T0), UsageError);
  const r = runCli(['visual', 'mark', 'nope', 'start', '--feature', fx.featureDir], { cwd: fx.root });
  assert.equal(r.status, 2);
});

test('--adhoc registers an unknown id with reference none and no checks', async (t) => {
  const { manifest, mark } = setup(t);
  await mark(['extra', 'start', '--adhoc'], T0);
  await mark(['extra', 'end'], T0 + 1000);
  const s = manifest().screens.extra;
  assert.equal(s.adhoc, true);
  assert.equal(s.reference, 'none');
  assert.deepEqual(s.checks, []);
  assert.equal(s.duration_s, 1);
});

test('end without start → UsageError', async (t) => {
  const { mark } = setup(t);
  await assert.rejects(mark(['home', 'end'], T0), UsageError);
});

test('W5: prototype keys and path-like ids are refused before the manifest is touched', async (t) => {
  const { mark, fx } = setup(t);
  for (const id of ['__proto__', '../x', 'a/b', '-rf', 'Home']) {
    await assert.rejects(mark([id, 'start', '--adhoc'], T0), UsageError, id);
  }
  const fs = await import('node:fs');
  const file = `${fx.root}/docs/features/${DEFAULT_FEATURE}/verification/manifest.json`;
  assert.equal(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).screens : undefined, undefined);
});

test('W5: a valid id that is an Object.prototype name (constructor) is an own manifest key', async (t) => {
  const { mark, manifest } = setup(t);
  await mark(['constructor', 'start', '--adhoc'], T0);
  await mark(['constructor', 'end'], T0 + 1000);
  const m = manifest();
  assert.ok(Object.hasOwn(m.screens, 'constructor'));
  assert.equal(m.screens.constructor.adhoc, true);
  assert.equal(m.screens.constructor.duration_s, 1);
});

test('--ac (repeatable) stores the ACs on an ad-hoc screen; --breakpoint is stored', async (t) => {
  const { manifest, mark } = setup(t);
  await mark(['extra', 'start', '--adhoc', '--ac', 'AC3', '--ac', 'AC4', '--ac', 'AC3', '--breakpoint', '375'], T0);
  const s = manifest().screens.extra;
  assert.deepEqual(s.acs, ['AC3', 'AC4']);
  assert.equal(s.breakpoint, 375);
  await assert.rejects(mark(['extra', 'start', '--ac', 'three'], T0), UsageError);
});
