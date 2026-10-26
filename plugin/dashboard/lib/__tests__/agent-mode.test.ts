// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseAgentMode,
  resolveAgentStatus,
  getAgentStatus,
  __resetAgentStatusForTests,
} from '@/lib/agent-mode';

const res = (status: number) => ({ status }) as Response;
const spy = (impl: () => Promise<Response>) =>
  vi.fn(impl) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('parseAgentMode (R1)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('unset / empty resolve to auto without warning', () => {
    expect(parseAgentMode(undefined)).toBe('auto');
    expect(parseAgentMode('')).toBe('auto');
    expect(parseAgentMode('   ')).toBe('auto');
    expect(warn).not.toHaveBeenCalled();
  });
  it('is case-insensitive and trimmed', () => {
    expect(parseAgentMode(' ON ')).toBe('on');
    expect(parseAgentMode('Off')).toBe('off');
  });
  it('garbage resolves to auto and warns once naming the value', () => {
    expect(parseAgentMode('banana')).toBe('auto');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('banana');
  });
});

describe('resolveAgentStatus', () => {
  it('auto without key: no-api-key, no fetch', async () => {
    const f = spy(async () => res(200));
    for (const env of [{}, { ANTHROPIC_API_KEY: '  ' }, { DASHBOARD_AGENT: '' }]) {
      expect(await resolveAgentStatus(env, f)).toEqual({
        enabled: false,
        mode: 'auto',
        reason: 'no-api-key',
      });
    }
    expect(f).toHaveBeenCalledTimes(0);
  });
  it('off with key: off-by-config, no fetch', async () => {
    const f = spy(async () => res(200));
    expect(
      await resolveAgentStatus({ DASHBOARD_AGENT: 'off', ANTHROPIC_API_KEY: 'k' }, f),
    ).toEqual({ enabled: false, mode: 'off', reason: 'off-by-config' });
    expect(f).toHaveBeenCalledTimes(0);
  });
  it('on without key: forced-on, no fetch', async () => {
    const f = spy(async () => res(200));
    expect(await resolveAgentStatus({ DASHBOARD_AGENT: 'on' }, f)).toEqual({
      enabled: true,
      mode: 'on',
      reason: 'forced-on',
    });
    expect(f).toHaveBeenCalledTimes(0);
  });

  it('auto with key calls /v1/models with headers and a signal', async () => {
    const f = spy(async () => res(200));
    const s = await resolveAgentStatus({ ANTHROPIC_API_KEY: 'sk-test' }, f);
    expect(s).toEqual({ enabled: true, mode: 'auto', reason: 'key-verified' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(url)).not.toContain('sk-test');
  });
  it('honours ANTHROPIC_BASE_URL', async () => {
    const f = spy(async () => res(200));
    await resolveAgentStatus(
      { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://proxy.local:9' },
      f,
    );
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'http://proxy.local:9/v1/models?limit=1',
    );
  });
  it.each([401, 403])('%i -> invalid-key, disabled', async (code) => {
    const s = await resolveAgentStatus(
      { ANTHROPIC_API_KEY: 'k' },
      spy(async () => res(code)),
    );
    expect(s).toEqual({ enabled: false, mode: 'auto', reason: 'invalid-key' });
  });
  it.each([429, 500, 404])('%i -> key-unverified, enabled', async (code) => {
    const s = await resolveAgentStatus(
      { ANTHROPIC_API_KEY: 'k' },
      spy(async () => res(code)),
    );
    expect(s).toEqual({ enabled: true, mode: 'auto', reason: 'key-unverified' });
  });
  it('rejection and AbortError -> key-unverified', async () => {
    for (const err of [
      new TypeError('fetch failed'),
      new DOMException('timed out', 'AbortError'),
    ]) {
      const s = await resolveAgentStatus(
        { ANTHROPIC_API_KEY: 'k' },
        spy(async () => {
          throw err;
        }),
      );
      expect(s).toEqual({ enabled: true, mode: 'auto', reason: 'key-unverified' });
    }
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetAgentStatusForTests();
  });

  it('3 concurrent + 2 sequential calls cause exactly 1 fetch', async () => {
    process.env.DASHBOARD_AGENT = 'auto';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const f = vi.fn(async () => res(200));
    vi.stubGlobal('fetch', f);
    const all = await Promise.all([
      getAgentStatus(),
      getAgentStatus(),
      getAgentStatus(),
    ]);
    await getAgentStatus();
    await getAgentStatus();
    expect(f).toHaveBeenCalledTimes(1);
    expect(all.every((s) => s.reason === 'key-verified')).toBe(true);
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
