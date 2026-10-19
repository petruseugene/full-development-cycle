import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeTotals } from '../lib/totals.mjs';
import { updateFeatureJson } from '../lib/feature-json.mjs';
import { mkFixture, sampleFeatureJson } from './helpers.mjs';

// AC10 fixture: missing model, gate.*, interview, conflict, and every status.
const HISTORY = [
  { phase: 'interview', subagent: 'orchestrator', status: 'DONE' },
  { phase: 'discovery', subagent: 'discovery', model: 'opus', status: 'DONE', duration_s: 100, tokens_k: 40 },
  { phase: 'implement.task=1', subagent: 'backend-dev', model: 'sonnet', status: 'NEEDS_CONTEXT', duration_s: 30, tokens_k: 5.5 },
  { phase: 'implement.task=1', subagent: 'backend-dev', model: 'sonnet', status: 'DONE', duration_s: 200, tokens_k: 20.25 },
  { phase: 'implement.task=2', subagent: 'backend-dev', status: 'DONE', duration_s: 50, tokens_k: 10 },
  { phase: 'review', subagent: 'code-reviewer', model: 'opus', status: 'CHANGES_REQUIRED', duration_s: 60, tokens_k: 12 },
  { phase: 'review', subagent: 'code-reviewer', model: 'opus', status: 'APPROVED', duration_s: 40, tokens_k: 8 },
  { phase: 'auto-test', subagent: 'auto-tester', model: 'sonnet', status: 'FAILED', duration_s: 90, tokens_k: 0.1 },
  { phase: 'auto-test', subagent: 'auto-tester', model: 'sonnet', status: 'PASSED', duration_s: 80, tokens_k: 0.2 },
  { phase: 'gate.content', subagent: 'gate', status: 'PASSED', duration_s: 12 },
  { phase: 'gate.content', subagent: 'gate', status: 'FAILED', duration_s: 3 },
  { phase: 'conflict', subagent: 'orchestrator', status: 'DONE', message: 'collision' },
  { phase: 'git', subagent: 'git-agent', model: 'inherit', status: 'DONE', duration_s: 20, tokens_k: 3 },
];

const ZERO = { input: 0, output: 0, cache_read: 0, cache_write: 0, billable_k: 0, usd_est: 0, measured_entries: 0, estimated_entries: 0 };

const EXPECTED = {
  by_subagent: {
    discovery: { calls: 1, approved: 0, retried: 0, time_s: 100, tokens_k: 40 },
    'backend-dev': { calls: 3, approved: 0, retried: 1, time_s: 280, tokens_k: 35.75 },
    'code-reviewer': { calls: 2, approved: 1, retried: 1, time_s: 100, tokens_k: 20 },
    'auto-tester': { calls: 2, approved: 1, retried: 1, time_s: 170, tokens_k: 0.3 },
    'git-agent': { calls: 1, approved: 0, retried: 0, time_s: 20, tokens_k: 3 },
  },
  by_model: {
    opus: { calls: 3, time_s: 200, tokens_k: 60 },
    sonnet: { calls: 4, time_s: 400, tokens_k: 26.05 },
    unknown: { calls: 1, time_s: 50, tokens_k: 10 },
    inherit: { calls: 1, time_s: 20, tokens_k: 3 },
  },
  measured: ZERO,
};

test('AC10: computeTotals matches the hand-computed fixture', () => {
  assert.deepEqual(computeTotals(HISTORY), EXPECTED);
});

test('computeTotals is pure and handles empty / missing history', () => {
  const copy = structuredClone(HISTORY);
  computeTotals(copy);
  assert.deepEqual(copy, HISTORY);
  assert.deepEqual(computeTotals([]), { by_subagent: {}, by_model: {}, measured: ZERO });
  assert.deepEqual(computeTotals(undefined), { by_subagent: {}, by_model: {}, measured: ZERO });
});

test('AC10: totals after a CLI write equal the expected object, identical on repeat', (t) => {
  const fx = mkFixture({
    featureJson: sampleFeatureJson({
      history: HISTORY,
      totals: { by_subagent: { stale: { calls: 99 } }, by_model: {} },
    }),
  });
  t.after(() => fx.cleanup());

  const file = path.join(fx.featureDir, 'feature.json');
  updateFeatureJson(fx.featureDir, () => {});
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(first.totals, EXPECTED);

  const bytes1 = fs.readFileSync(file, 'utf8');
  updateFeatureJson(fx.featureDir, () => {});
  const bytes2 = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(bytes2).totals, first.totals);
  assert.equal(bytes2, bytes1);
});

test('AC27: cli and orchestrator entries are excluded from by_* ; orchestrator summarised', () => {
  const h = [
    { phase: 'static-check', subagent: 'cli', executor: 'cli', status: 'PASSED', model: 'none', duration_s: 5 },
    { phase: 'static-check', subagent: 'static-checker', status: 'PASSED', model: 'haiku', duration_s: 7 },
    { phase: 'orchestrator', subagent: 'orchestrator', status: 'DONE', model: 'opus',
      tokens: { input: 1000, output: 500, cache_read: 9000, cache_write: 500 }, usd_est: 0.25 },
  ];
  const t = computeTotals(h);
  assert.deepEqual(Object.keys(t.by_subagent), ['static-checker']);
  assert.deepEqual(Object.keys(t.by_model), ['haiku']);
  assert.equal(t.by_subagent['static-checker'].usd_est, undefined);
  assert.deepEqual(t.orchestrator, { billable_k: 2, usd_est: 0.25 });
  assert.deepEqual(t.measured, {
    input: 1000, output: 500, cache_read: 9000, cache_write: 500,
    billable_k: 2, usd_est: 0.25, measured_entries: 1, estimated_entries: 0,
  });
});

test('AC27: measured + estimated + legacy mix', () => {
  const h = [
    { phase: 'implement.task=1', subagent: 'backend-dev', model: 'sonnet', status: 'DONE', duration_s: 10,
      tokens: { input: 2000, output: 1000, cache_read: 0, cache_write: 1000 }, usd_est: 0.1, tokens_k: 4 },
    // real `history add --agent-id` fallback shape: tokens_k + estimated, no tokens object
    { phase: 'review', subagent: 'backend-dev', model: 'sonnet', status: 'DONE', duration_s: 10,
      agent_id: 'a1', estimated: true, tokens_k: 0.15 },
    { phase: 'review', subagent: 'backend-dev', model: 'sonnet', status: 'DONE', duration_s: 10, tokens_k: 1 },
    { phase: 'spec', subagent: 'spec-writer', model: 'opus', status: 'DONE', tokens: '~3k', tokens_k: 3 },
  ];
  const t = computeTotals(h);
  assert.equal(t.orchestrator, undefined);
  assert.equal(t.measured.measured_entries, 1);
  assert.equal(t.measured.estimated_entries, 1);
  assert.equal(t.measured.billable_k, 4);
  assert.equal(t.measured.usd_est, 0.1);
  assert.equal(t.by_subagent['backend-dev'].usd_est, 0.1);
  assert.equal(t.by_subagent['backend-dev'].calls, 3);
  assert.equal(t.by_subagent['backend-dev'].tokens_k, 5.15);
  assert.equal(t.by_model.sonnet.usd_est, 0.1);
  assert.equal('usd_est' in t.by_subagent['spec-writer'], false);
  assert.equal('usd_est' in t.by_model.opus, false);
});

test('AC27: legacy-only history keeps by_* identical and measured zeros', () => {
  const t = computeTotals(HISTORY);
  assert.deepEqual(t.by_subagent, EXPECTED.by_subagent);
  assert.deepEqual(t.by_model, EXPECTED.by_model);
  assert.deepEqual(t.measured, ZERO);
  assert.equal('orchestrator' in t, false);
});

test('security S6: __proto__ subagent/model keys do not pollute Object.prototype', () => {
  const t = computeTotals([{ phase: 'review', subagent: '__proto__', model: 'constructor', status: 'DONE', duration_s: 1, tokens_k: 2 }]);
  assert.equal(({}).calls, undefined);
  assert.ok(Object.hasOwn(t.by_subagent, '__proto__'));
  assert.equal(t.by_subagent['__proto__'].calls, 1);
  assert.equal(Object.getOwnPropertyDescriptor(t.by_model, 'constructor').value.tokens_k, 2);
});
