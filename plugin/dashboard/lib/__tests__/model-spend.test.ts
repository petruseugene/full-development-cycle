import { describe, it, expect } from 'vitest';
import { aggregateByModel } from '../model-spend';

describe('aggregateByModel', () => {
  it('(a) mixed history in registry order', () => {
    const rows = aggregateByModel([
      { model: 'opus', duration_s: 240, tokens_k: 0 },
      { model: 'sonnet', duration_s: 60, tokens_k: 10 },
      { model: 'haiku', duration_s: 30, tokens_k: 2 },
      { model: 'opus', duration_s: 10, tokens_k: 5 },
    ]);
    expect(rows).toEqual([
      { model: 'opus', calls: 2, tokens_k: 5, time_s: 250 },
      { model: 'sonnet', calls: 1, tokens_k: 10, time_s: 60 },
      { model: 'haiku', calls: 1, tokens_k: 2, time_s: 30 },
    ]);
  });

  it('(b) legacy history without model -> single unknown row', () => {
    const rows = aggregateByModel([
      { subagent: 'implement.task=3', resolution: 'x', cycle: 1, concerns: 'c', duration_s: 20, tokens_k: 3 },
      { subagent: 'spec-writer', duration_s: 5, tokens_k: 1.5, note: 'n' },
      { subagent: 'git-agent' },
    ]);
    expect(rows).toEqual([{ model: 'unknown', calls: 3, tokens_k: 4.5, time_s: 25 }]);
  });

  it('(c) unknown last, unrecognised keys after inherit', () => {
    const rows = aggregateByModel([
      {},
      { model: 'fable' },
      { model: 'inherit' },
      { model: ' Opus ' },
      { model: 'aardvark' },
    ]);
    expect(rows.map((r) => r.model)).toEqual(['opus', 'inherit', 'aardvark', 'fable', 'unknown']);
  });

  it('(d) non-array / junk input gives []', () => {
    expect(aggregateByModel(undefined)).toEqual([]);
    expect(aggregateByModel(null)).toEqual([]);
    expect(aggregateByModel({})).toEqual([]);
    expect(aggregateByModel([null, 42, 'x'])).toEqual([]);
  });

  it('(e) STOPPED entry counts as a call', () => {
    const rows = aggregateByModel([{ status: 'STOPPED', tokens_k: 0 }]);
    expect(rows).toEqual([{ model: 'unknown', calls: 1, tokens_k: 0, time_s: 0 }]);
  });

  it('(f) non-numeric tokens_k counts as 0', () => {
    const rows = aggregateByModel([{ model: 'opus', tokens_k: 'abc', duration_s: 'x' }]);
    expect(rows[0]).toEqual({ model: 'opus', calls: 1, tokens_k: 0, time_s: 0 });
  });
});
