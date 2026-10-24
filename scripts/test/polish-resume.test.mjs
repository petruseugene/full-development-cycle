import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkCtx, mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { run as runVisualPlan } from '../lib/visual-plan.mjs';

const POLISH = `---
feature: x
status: [TODO]
---

## Tasks
- [IMPL-DONE] **Task 1** (frontend): one
- [TODO] **Task 2** (frontend, deferred): two
- [TODO] **Task 3** (frontend): three

### Task 1
**Item:** P1
**Area:** home
**Touches:** \`src/home/**\`

### Task 2
**Item:** P2
**Area:** home
**Touches:** \`src/home/**\`
**Deferred:** needs API

### Task 3
**Item:** P3
**Area:** home
**Touches:** \`src/home/**\`
`;

test('AC12: feature resume on polish shows areas, context --touches and items line', () => {
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ track: 'polish', auto_tests: false, areas: [{ name: 'home', touches: ['src/home/**'] }], history: [] }),
    files: { 'polish.md': POLISH },
  });
  try {
    const r = runCli(['feature', 'resume'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /areas:\n {2}home MISSING/);
    assert.match(r.stdout, /items: 3 \(IMPL-DONE 1, TODO 2\) · deferred 1/);
    assert.match(r.stdout, /context --touches "src\/home\/\*\*"/);
    assert.match(r.stdout, /dispatch implementer: Area home/);
    assert.ok(!/decisions:|spec analyze:/.test(r.stdout));
    const j = JSON.parse(runCli(['feature', 'resume', '--json'], { cwd: fx.root }).stdout);
    assert.deepEqual(j.items, { total: 3, by_status: { 'IMPL-DONE': 1, TODO: 2 }, deferred: 1 });
  } finally { fx.cleanup(); }
});

test('AC12: dod items failure routes resume to polish list', () => {
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ track: 'polish', auto_tests: false, areas: [{ name: 'home', touches: ['src/home/**'] }], history: [{ ts: '2026-01-01T00:00:00Z', phase: 'implement.area=home', subagent: 'x', status: 'DONE' }] }),
    files: { 'polish.md': POLISH },
  });
  try {
    const r = runCli(['feature', 'resume'], { cwd: fx.root });
    assert.match(r.stdout, /dod: needs items=OPEN/);
    assert.match(r.stdout, /polish list/);
  } finally { fx.cleanup(); }
});

test('AC12: visual plan on polish selects screens from area touches', async () => {
  const visual = JSON.parse(fs.readFileSync(new URL('./fixtures/visual-plan/profile-visual.json', import.meta.url), 'utf8'));
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ track: 'polish', profile: { visual }, areas: [{ name: 'other', touches: ['apps/other/x.ts'] }] }),
    files: { 'polish.md': POLISH },
  });
  try {
    const ctx = mkCtx({ cwd: fx.root });
    assert.equal(await runVisualPlan(['--feature', fx.featureDir, '--json'], ctx), 0);
    assert.deepEqual(JSON.parse(ctx.out()).screens.map((s) => s.id), ['other']);
  } finally { fx.cleanup(); }
});
