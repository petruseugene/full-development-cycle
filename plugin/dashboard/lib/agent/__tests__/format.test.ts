/**
 * Format helpers — duration + relative-time rendering for the Stats and
 * Files tabs (spec R34 / R36).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatWallClock,
  formatToolDuration,
  formatRelativeTime,
} from '../format';

describe('formatWallClock', () => {
  it('renders 0ms as 0s', () => {
    expect(formatWallClock(0)).toBe('0s');
  });

  it('renders 65 000ms (1m 5s) as "1m 05s"', () => {
    expect(formatWallClock(65_000)).toBe('1m 05s');
  });

  it('renders 3 700 000ms (1h 1m 40s) as "1h 1m 40s"', () => {
    expect(formatWallClock(3_700_000)).toBe('1h 1m 40s');
  });
});

describe('formatToolDuration', () => {
  it('renders 150ms as "150ms" (sub-second band)', () => {
    expect(formatToolDuration(150)).toBe('150ms');
  });

  it('renders 2400ms as "2.4s" (second-scale band)', () => {
    expect(formatToolDuration(2400)).toBe('2.4s');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T22:52:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a 5-second-old timestamp as "5s ago"', () => {
    const d = new Date(Date.now() - 5_000);
    expect(formatRelativeTime(d)).toBe('5s ago');
  });

  it('renders a 5-minute-old timestamp as "5m ago"', () => {
    const d = new Date(Date.now() - 5 * 60_000);
    expect(formatRelativeTime(d)).toBe('5m ago');
  });
});
