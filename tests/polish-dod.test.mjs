import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';
import { requiredGates } from '../plugin/scripts/lib/dod.mjs';

const POLISH = (statuses, extra = '') => `---\nfeature: x\nstatus: [TODO]\n---\n\n## Tasks\n${statuses.map((s, i) => `- [${s}] **Task ${i + 1}** (frontend${extra && i === 0 ? ', deferred' : ''}): item ${i + 1}`).join('\n')}\n\n${statuses.map((_, i) => `### Task ${i + 1}\n**Item:** P${i + 1}\n**Area:** home\n**Touches:** \`src/a.ts\`\n${extra && i === 0 ? `**Deferred:** ${extra === 'empty' ? '' : extra}\n` : ''}`).join('\n')}`;

const AREAS = [{ name: 'home', touches: ['src/a.ts'] }, { name: 'api', touches: ['src/api.ts'] }];

test('AC10: requiredGates on polish', () => {
  assert.deepEqual(requiredGates(sampleFeatureJson({ track: 'polish', areas: AREAS, auto_tests: true })),
    ['implement.area=home', 'implement.area=api', 'static-check', 'review', 'auto-test']);
  assert.deepEqual(requiredGates(sampleFeatureJson({ track: 'polish', auto_tests: false })).slice(0, 2),
    ['implement.area=<none>', 'static-check']);
});

test('AC11: dod items precondition MISSING / OPEN / OK', () => {
  const dodItems = (files, over) => {
    const fx = mkFixture({ featureJson: sampleFeatureJson({ track: 'polish', auto_tests: false, areas: AREAS.slice(0, 1), history: [], ...over }), files });
    try {
      const r = runCli(['dod'], { cwd: fx.root });
      return { r };
    } finally { fx.cleanup(); }
  };
  let o = dodItems({});
  assert.equal(o.r.status, 1);
  assert.match(o.r.stdout, /! DOD-GATE FAILED: items last status = MISSING; aborting before push\./);
  o = dodItems({ 'polish.md': POLISH(['TODO', 'IMPL-DONE']) });
  assert.match(o.r.stdout, /! DOD-GATE FAILED: items last status = OPEN; aborting before push\./);
  o = dodItems({ 'polish.md': POLISH(['TODO', 'IMPL-DONE'], 'empty') });
  assert.match(o.r.stdout, /items last status = OPEN/);
  o = dodItems({ 'polish.md': POLISH(['TODO', 'DONE'], 'needs API') });
  assert.match(o.r.stdout, /! DOD-GATE FAILED: implement\.area=home last status = MISSING/);
  o = dodItems({ 'polish.md': POLISH(['IMPL-DONE', 'DONE']) });
  assert.match(o.r.stdout, /! DOD-GATE FAILED: implement\.area=home/);
});

test('AC11: polish skips decisions and spec-analyze even with a stray spec.md', () => {
  const spec = '---\nstatus: [TODO]\n---\n# S\n## Decisions\n- **D1:** Q? → OPEN\n';
  const hist = [{ ts: '2026-01-01T00:00:00Z', phase: 'implement.area=home', subagent: 'x', status: 'DONE' },
    { ts: '2026-01-01T00:00:00Z', phase: 'static-check', subagent: 'x', status: 'PASSED' },
    { ts: '2026-01-01T00:00:00Z', phase: 'review', subagent: 'x', status: 'APPROVED' }];
  const fx = mkFixture({
    featureJson: sampleFeatureJson({ track: 'polish', auto_tests: false, areas: AREAS.slice(0, 1), history: hist }),
    files: { 'polish.md': POLISH(['IMPL-DONE']), 'spec.md': spec },
  });
  try {
    const r = runCli(['dod'], { cwd: fx.root });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /DOD-GATE PASSED/);
  } finally { fx.cleanup(); }
});
