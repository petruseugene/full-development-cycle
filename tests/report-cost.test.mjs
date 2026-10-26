import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgent, buildCost, buildTrend, buildTracks } from '../plugin/scripts/lib/report-cost.mjs';

const M = (extra) => ({ tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, ...extra });

test('AC23: normalizeAgent strips dev-cycle: prefix', () => {
  assert.equal(normalizeAgent('dev-cycle:discovery'), 'discovery');
  assert.equal(normalizeAgent('discovery'), 'discovery');
  assert.equal(normalizeAgent(undefined), 'unknown');
});

test('AC23: agents merge, cli entries excluded, measured/estimated kept apart', () => {
  const cost = buildCost([
    M({ phase: 'discovery', subagent: 'dev-cycle:discovery', model: 'opus', usd_est: 1.5, tokens_k: 10 }),
    { phase: 'discovery', subagent: 'discovery', model: 'opus', tokens_k: 4, estimated: true },
    { phase: 'gate.content', subagent: 'cli', executor: 'cli', tokens_k: 99 },
    { phase: 'git', subagent: 'cli', executor: 'cli' },
  ]);
  assert.deepEqual(Object.keys(cost.by_agent), ['discovery']);
  assert.equal(cost.by_agent.discovery.calls, 2);
  assert.equal(cost.by_agent.discovery.usd_est, 1.5);
  assert.equal(cost.by_agent.discovery.tokens_k, 14);
  assert.deepEqual(cost.counts, { measured: 1, estimated: 1 });
  assert.equal(cost.by_model.opus.calls, 2);
});

test('AC23: tokens-only feature has measured:false; trend ordered by created', () => {
  const trend = buildTrend([
    { folder: 'b', created: '2026-02-01 10:00', history: [M({ phase: 'x', subagent: 'a', usd_est: 2, tokens_k: 5 })] },
    { folder: 'a', created: '2026-01-01 10:00', history: [{ phase: 'x', subagent: 'a', tokens_k: 7, estimated: true }] },
  ]);
  assert.deepEqual(trend.map((t) => t.folder), ['a', 'b']);
  assert.equal(trend[0].measured, false);
  assert.equal(trend[0].tokens_k, 7);
  assert.equal('usd_est' in trend[0], false);
  assert.equal(trend[1].measured, true);
  assert.equal(trend[1].usd_est, 2);
});

test('AC24: tracks group full/lite/bugfix with small_sample', () => {
  const h = (usd) => [
    { ts: '2026-01-01T00:00:00Z', phase: 'x', subagent: 'a', tokens_k: 1 },
    M({ ts: '2026-01-01T00:10:00Z', phase: 'y', subagent: 'a', usd_est: usd, tokens_k: 1 }),
  ];
  const tracks = buildTracks([
    { folder: '1', flow: 'feature', track: 'full', history: h(2) },
    { folder: '2', flow: 'feature', history: h(4) },
    { folder: '3', flow: 'feature', track: 'lite', history: h(1) },
    { folder: '4', flow: 'bugfix', history: [{ ts: '2026-01-01T00:00:00Z', tokens_k: 3 }] },
  ]);
  assert.equal(tracks.length, 3);
  const full = tracks.find((t) => t.track === 'full');
  assert.equal(full.n, 2);
  assert.equal(full.median_usd, 3);
  assert.equal(full.usd_n, 2);
  assert.equal(full.median_wall_s, 600);
  assert.deepEqual(tracks.map((t) => t.n), [2, 1, 1]);
  assert.ok(tracks.every((t) => t.small_sample === true));
  const bug = tracks.find((t) => t.flow === 'bugfix');
  assert.equal(bug.median_usd, null);
  assert.equal(bug.usd_n, 0);
});

test('small_sample false at n=3', () => {
  const f = { flow: 'feature', track: 'full', history: [] };
  assert.equal(buildTracks([f, f, f])[0].small_sample, false);
});
