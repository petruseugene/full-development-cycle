import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { aggregateByModel } from '../model-spend';

const FEATURES = path.resolve(__dirname, '../../../../docs/features');

(existsSync(FEATURES) ? describe : describe.skip)('aggregateByModel on real feature.json files', () => {
  it('legacy mobile-platform-aware-skills: single unknown row, calls == history length', () => {
    const j = JSON.parse(
      readFileSync(path.join(FEATURES, '2026-10-08-10h-26m-mobile-platform-aware-skills/feature.json'), 'utf8'),
    );
    const rows = aggregateByModel(j.history);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('unknown');
    expect(rows[0].calls).toBe(j.history.length);
    const tok = j.history.reduce((s: number, h: any) => s + (Number(h.tokens_k) || 0), 0);
    expect(rows[0].tokens_k).toBeCloseTo(tok);
  });

  it('this feature: opus calls equal count of model:opus entries, unknown never before named models', () => {
    const j = JSON.parse(
      readFileSync(path.join(FEATURES, '2026-10-08-11h-16m-per-skill-model-selection/feature.json'), 'utf8'),
    );
    const rows = aggregateByModel(j.history);
    const opus = j.history.filter((h: any) => h.model === 'opus').length;
    if (opus) expect(rows.find((r) => r.model === 'opus')?.calls).toBe(opus);
    expect(rows.reduce((s, r) => s + r.calls, 0)).toBe(j.history.length);
    const idx = rows.findIndex((r) => r.model === 'unknown');
    if (idx !== -1) expect(idx).toBe(rows.length - 1);
  });
});

describe('aggregateByModel edge cases', () => {
  it('empty array gives []', () => {
    expect(aggregateByModel([])).toEqual([]);
  });
  it('empty / whitespace / non-string model is bucketed unknown', () => {
    const rows = aggregateByModel([{ model: '' }, { model: '   ' }, { model: 5 }, { model: null }]);
    expect(rows).toEqual([{ model: 'unknown', calls: 4, tokens_k: 0, time_s: 0 }]);
  });
  it('DONE_WITH_CONCERNS and STOPPED statuses with extra keys do not throw', () => {
    expect(() =>
      aggregateByModel([
        { model: 'sonnet', status: 'DONE_WITH_CONCERNS', concerns: 'x', cycle: 2, resolution: 'r' },
        { model: 'sonnet', status: 'STOPPED', note: 'n' },
      ]),
    ).not.toThrow();
  });
  it('full registry order: opus, sonnet, haiku, inherit, others alpha, unknown', () => {
    const rows = aggregateByModel([
      { model: 'unknown' },
      { model: 'zed' },
      { model: 'inherit' },
      { model: 'haiku' },
      { model: 'sonnet' },
      { model: 'opus' },
      { model: 'alpha' },
    ]);
    expect(rows.map((r) => r.model)).toEqual(['opus', 'sonnet', 'haiku', 'inherit', 'alpha', 'zed', 'unknown']);
  });
  it('string numerics are summed; NaN/undefined count as 0', () => {
    const rows = aggregateByModel([
      { model: 'opus', tokens_k: '2.5', duration_s: '10' },
      { model: 'opus', tokens_k: undefined, duration_s: NaN },
    ]);
    expect(rows[0]).toEqual({ model: 'opus', calls: 2, tokens_k: 2.5, time_s: 10 });
  });
  it('does not mutate input', () => {
    const h = [{ model: 'Opus', tokens_k: 1 }];
    const copy = JSON.parse(JSON.stringify(h));
    aggregateByModel(h);
    expect(h).toEqual(copy);
  });
});
