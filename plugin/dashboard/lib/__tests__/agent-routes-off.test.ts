// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

import { __resetAgentStatusForTests } from '@/lib/agent-mode';

const trackers = vi.hoisted(() => ({ sdk: vi.fn(), sm: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  trackers.sdk();
  return { query: vi.fn() };
});
vi.mock('@/lib/agent/session-manager', () => {
  trackers.sm();
  return {
    sessionManager: {
      get: async () => undefined,
      start: async () => ({ sessionId: 'sess-1' }),
      listPendingApprovals: () => [],
      globalEvents: { on() {}, off() {} },
    },
  };
});
vi.mock('@/lib/agent/log-rotation', () => ({
  logRotation: { rotateIfPresent: async () => undefined },
}));

const saved = { ...process.env };

const ROUTES: Array<[string, () => Promise<Record<string, unknown>>]> = [
  ['events', () => import('@/app/api/agent/events/route')],
  ['approvals', () => import('@/app/api/agent/approvals/route')],
  ['[featureId]/start', () => import('@/app/api/agent/[featureId]/start/route')],
  ['[featureId]/resume', () => import('@/app/api/agent/[featureId]/resume/route')],
  ['[featureId]/message', () => import('@/app/api/agent/[featureId]/message/route')],
  ['[featureId]/kill', () => import('@/app/api/agent/[featureId]/kill/route')],
  ['[featureId]/stats', () => import('@/app/api/agent/[featureId]/stats/route')],
  ['[featureId]/approval', () => import('@/app/api/agent/[featureId]/approval/route')],
  ['[featureId]/stream', () => import('@/app/api/agent/[featureId]/stream/route')],
];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const req = (method: string) =>
  new Request('http://127.0.0.1:3737/api/agent/x', {
    method: method === 'GET' || method === 'HEAD' ? 'GET' : method,
    headers: { host: '127.0.0.1:3737', 'content-type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });

describe('agent routes when mode=off (AC3)', () => {
  beforeAll(() => {
    __resetAgentStatusForTests();
    process.env.DASHBOARD_AGENT = 'off';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    process.env = { ...saved };
    __resetAgentStatusForTests();
  });

  it('covers all 9 route modules', () => {
    expect(ROUTES).toHaveLength(9);
  });

  it('every exported method returns an empty 404 and loads nothing', async () => {
    let checked = 0;
    for (const [name, load] of ROUTES) {
      const mod = await load();
      for (const m of METHODS) {
        const handler = mod[m] as
          | ((r: Request, c: unknown) => Promise<Response>)
          | undefined;
        if (typeof handler !== 'function') continue;
        const res = await handler(req(m), { params: { featureId: 'feat-1' } });
        expect(res.status, `${name} ${m}`).toBe(404);
        expect(await res.text(), `${name} ${m}`).toBe('');
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
    expect(trackers.sdk).toHaveBeenCalledTimes(0);
    expect(trackers.sm).toHaveBeenCalledTimes(0);
  });
});

describe('start route when mode=on without a key (AC6)', () => {
  it('does not return the ANTHROPIC_API_KEY not set 500', async () => {
    __resetAgentStatusForTests();
    process.env.DASHBOARD_AGENT = 'on';
    delete process.env.ANTHROPIC_API_KEY;
    const { POST } = await import('@/app/api/agent/[featureId]/start/route');
    const res = await POST(req('POST'), { params: { featureId: 'feat-1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId: 'sess-1' });
    process.env = { ...saved };
    __resetAgentStatusForTests();
  });
});
