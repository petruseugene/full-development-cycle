import { describe, it, expect } from 'vitest';
import { buildKPIs, buildTicker } from '../features';
import type { Feature } from '../types';

const history = [
  { ts: '2026-10-18T10:00:00Z', phase: 'implement', subagent: 'backend-dev', status: 'DONE', duration_s: 10, tokens_k: 2 },
  { ts: '2026-10-18T10:05:00Z', phase: 'implement', subagent: 'backend-dev', status: 'DONE', tokens: '~3k' },
  {
    ts: '2026-10-18T10:10:00Z',
    phase: 'implement',
    subagent: 'frontend-dev',
    status: 'DONE',
    tokens: { input: 100, output: 50, cache_read: 1000, cache_write: 20 },
    tokens_k: 0.2,
    usd_est: 1.25,
  },
];

function feat(meta: unknown, status = 'IN_PROGRESS'): Feature {
  return { tasks: [], derived: { overallStatus: status }, meta } as unknown as Feature;
}

describe('measured spend (AC31)', () => {
  it('uses totals.measured.usd_est for measured features, mixed history, no throw', () => {
    const f = feat({
      history,
      totals: {
        by_subagent: { 'backend-dev': { calls: 2, approved: 0, retried: 0, time_s: 10, tokens_k: 2 } },
        measured: { input: 100, output: 50, cache_read: 1000, cache_write: 20, billable_k: 0.2, usd_est: 1.25, measured_entries: 1, estimated_entries: 0 },
      },
    });
    expect(() => buildTicker([f])).not.toThrow();
    expect(buildKPIs([f]).agentSpend.dollars).toBe(1.25);
  });

  it('legacy features keep the flat rate and tolerate missing totals', () => {
    const legacy = feat({ history: [history[0]], totals: { by_subagent: { a: { calls: 1, approved: 0, retried: 0, time_s: 1, tokens_k: 10 } } } });
    const none = feat({ history: [] });
    const k = buildKPIs([legacy, none]);
    expect(k.agentSpend.tokens).toBe(10000);
    expect(k.agentSpend.dollars).toBeGreaterThan(0);
  });
});
