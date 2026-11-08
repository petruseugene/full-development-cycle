// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseAgentMode,
  resolveAgentStatus,
  getAgentStatus,
  __resetAgentStatusForTests,
} from '@/lib/agent-mode';

describe('parseAgentMode (R1)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('unset/empty/auto -> off (default)', () => {
    for (const v of [undefined, '', '   ', 'auto', 'AUTO']) {
      expect(parseAgentMode(v)).toEqual({ mode: 'off', explicit: false });
    }
    expect(warn).not.toHaveBeenCalled();
  });
  it('on/off case-insensitive and trimmed', () => {
    expect(parseAgentMode(' ON ')).toEqual({ mode: 'on', explicit: true });
    expect(parseAgentMode('Off')).toEqual({ mode: 'off', explicit: true });
  });
  it('unknown -> off with a warning', () => {
    expect(parseAgentMode('banana')).toEqual({ mode: 'off', explicit: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAgentStatus', () => {
  it('default is off-by-default', () => {
    expect(resolveAgentStatus({})).toEqual({
      enabled: false,
      mode: 'off',
      reason: 'off-by-default',
    });
  });
  it('off is off-by-config', () => {
    expect(resolveAgentStatus({ DASHBOARD_AGENT: 'off' })).toEqual({
      enabled: false,
      mode: 'off',
      reason: 'off-by-config',
    });
  });
  it('on is on-by-config and makes no network call', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(resolveAgentStatus({ DASHBOARD_AGENT: 'on' })).toEqual({
      enabled: true,
      mode: 'on',
      reason: 'on-by-config',
    });
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('getAgentStatus memoization (R5)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    __resetAgentStatusForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    __resetAgentStatusForTests();
  });

  it('resolves once and ignores later env changes', async () => {
    process.env.DASHBOARD_AGENT = 'on';
    const first = await getAgentStatus();
    process.env.DASHBOARD_AGENT = 'off';
    const all = await Promise.all([getAgentStatus(), getAgentStatus()]);
    expect(first.enabled).toBe(true);
    expect(all.every((s) => s === first)).toBe(true);
    expect(console.log).toHaveBeenCalledTimes(1);
  });
});

describe('agent-mode client guard', () => {
  it('throws when loaded where window exists', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).window = {};
    try {
      await expect(import('../agent-mode')).rejects.toThrow(/server-only/);
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});
