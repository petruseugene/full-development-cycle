/**
 * Stats accumulator factory (Task 4 / spec R7 / AC5).
 *
 * Pins that `createSessionStats(startedAt)` returns a fully-initialised
 * empty snapshot — every counter at 0, every record empty — so the
 * stats API route can serve it unmodified for a brand-new session.
 */
import { describe, it, expect } from 'vitest';
import { createSessionStats } from '../stats';

describe('createSessionStats', () => {
  it('returns an empty initialised SessionStats rooted at startedAt', () => {
    const startedAt = '2026-05-15T22:52:00.000Z';
    const stats = createSessionStats(startedAt);

    expect(stats.startedAt).toBe(startedAt);
    expect(stats.costUsd).toBe(0);
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.cacheCreationTokens).toBe(0);
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.turns).toBe(0);
    expect(stats.wallClockMs).toBe(0);
    expect(stats.toolCalls).toEqual({});
    expect(stats.filesTouched).toEqual({});
    expect(stats.subagents).toEqual({});
  });
});
