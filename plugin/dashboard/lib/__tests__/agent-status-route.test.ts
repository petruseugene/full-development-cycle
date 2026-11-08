// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GET } from '@/app/api/agent-status/route';
import { __resetAgentStatusForTests } from '@/lib/agent-mode';

const saved = { ...process.env };
let logs: string[] = [];

beforeEach(() => {
  __resetAgentStatusForTests();
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  }
  delete process.env.DASHBOARD_AGENT;
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetAgentStatusForTests();
});

async function call() {
  const res = await GET();
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

describe('GET /api/agent-status (AC5)', () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ['off', { DASHBOARD_AGENT: 'off' }, false],
    ['on', { DASHBOARD_AGENT: 'on' }, true],
    ['default', {}, false],
    ['legacy auto', { DASHBOARD_AGENT: 'auto' }, false],
  ];
  it.each(cases)('%s: 200, exact key set', async (_n, env, enabled) => {
    Object.assign(process.env, env);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['enabled', 'mode', 'reason']);
    expect(body.enabled).toBe(enabled);
  });
});
