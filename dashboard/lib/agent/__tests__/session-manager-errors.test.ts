/**
 * R9 / AC7 — SDK-reported errors become one `error` event (not assistant_text).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Built at runtime so no key-like literal ships in the repo.
const FAKE_KEY = ['sk', 'ant', 'api03', 'AbC_123', 'xyz'].join('-');

vi.mock('node:fs', async () => {
  const noop = async () => undefined;
  const promises = {
    mkdir: noop,
    writeFile: noop,
    rename: noop,
    appendFile: noop,
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdir: async () => [],
  };
  return { promises, default: { promises } };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery() {
    const messages: Array<Record<string, unknown>> = (
      (globalThis as Record<string, unknown>).__testMessages as Array<
        Record<string, unknown>
      >
    ).slice();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (): Promise<{ value: unknown; done: boolean }> => {
        const value = messages.shift();
        if (value) return { value, done: false };
        return { value: undefined, done: true };
      },
      async close() {},
    };
  }
  return { query: makeQuery };
});

const BILLING_MSG =
  'API credit balance too low — top up at https://platform.claude.com/settings/billing, then Retry.';

const init = { type: 'system', subtype: 'init', session_id: 'sess-err-1' };

async function run(messages: Array<Record<string, unknown>>) {
  (globalThis as Record<string, unknown>).__testMessages = messages;
  const { sessionManager } = await import('../session-manager');
  await sessionManager.start('feat-err');
  // let the iterator drain
  await new Promise((r) => setTimeout(r, 50));
  const record = (await sessionManager.get('feat-err')) as unknown as {
    ringBuffer?: Array<Record<string, unknown>>;
    meta?: { status: string };
    status?: string;
  };
  return { record, sessionManager };
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__testMessages;
  delete (globalThis as Record<string, unknown>).__sessionManager;
});

describe('session-manager SDK error mapping', () => {
  it('billing_error assistant + is_error result -> exactly one error event', async () => {
    const { record } = await run([
      init,
      {
        type: 'assistant',
        error: 'billing_error',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: 'Credit balance is too low' }],
        },
      },
      { type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' },
    ]);
    const events = record.ringBuffer ?? [];
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'billing_error',
      message: BILLING_MSG,
      retryable: true,
    });
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(0);
    expect(record.meta?.status ?? record.status).toBe('errored');
  });

  it('authentication_failed has the key-rejected message', async () => {
    const { record } = await run([
      init,
      {
        type: 'assistant',
        error: 'authentication_failed',
        message: { id: 'm1', content: [{ type: 'text', text: 'bad key' }] },
      },
    ]);
    const errors = (record.ringBuffer ?? []).filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'authentication_failed',
      message: 'API key rejected — check ANTHROPIC_API_KEY.',
    });
  });

  it('result is_error alone emits one error event', async () => {
    const { record } = await run([
      init,
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' },
    ]);
    const errors = (record.ringBuffer ?? []).filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'unknown', message: 'boom' });
  });

  it('normal assistant text is unaffected', async () => {
    const { record } = await run([
      init,
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ]);
    const events = record.ringBuffer ?? [];
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1);
  });
});

describe('session-manager errored-session recovery (L13)', () => {
  const billing = [
    init,
    {
      type: 'assistant',
      error: 'billing_error',
      message: { id: 'm1', content: [{ type: 'text', text: 'low' }] },
    },
  ];

  it('send() is rejected while errored, but resume() restarts the live session', async () => {
    const { sessionManager } = await run(billing);
    expect(sessionManager.send('feat-err', 'hi')).toEqual({
      accepted: false,
      reason: 'session_errored',
    });
    // Retry path: queue a clean stream for the restarted session.
    vi.spyOn(
      sessionManager as unknown as { readMeta: () => Promise<unknown> },
      'readMeta',
    ).mockResolvedValue({
      featureId: 'feat-err',
      sessionId: 'sess-err-1',
      cwd: '/tmp/x',
      status: 'errored',
    });
    (globalThis as Record<string, unknown>).__testMessages = [];
    const res = await sessionManager.resume('feat-err');
    expect(res.status).toBe('running');
    const rec = (await sessionManager.get('feat-err')) as unknown as {
      ringBuffer: Array<Record<string, unknown>>;
    };
    expect(
      rec.ringBuffer.some((e) => e.type === 'status' && e.phase === 'resumed'),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(sessionManager.send('feat-err', 'hi again')).toEqual({ accepted: true });
  });

  it('retryable is false for authentication_failed / invalid_request, true for billing', async () => {
    for (const [code, want] of [
      ['authentication_failed', false],
      ['invalid_request', false],
      ['billing_error', true],
    ] as const) {
      vi.resetModules();
      delete (globalThis as Record<string, unknown>).__sessionManager;
      const { record } = await run([
        init,
        { type: 'assistant', error: code, message: { id: 'm', content: [{ type: 'text', text: 'x' }] } },
      ]);
      const err = (record.ringBuffer ?? []).find((e) => e.type === 'error');
      expect(err?.retryable).toBe(want);
    }
  });

  it('redacts API keys and truncates raw SDK detail', async () => {
    const { record } = await run([
      init,
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: `bad ${FAKE_KEY} ${'z'.repeat(500)}`,
      },
    ]);
    const err = (record.ringBuffer ?? []).find((e) => e.type === 'error');
    const msg = String(err?.message);
    expect(msg).not.toContain(FAKE_KEY);
    expect(msg).toContain('[redacted]');
    expect(msg.length).toBeLessThanOrEqual(201);
  });
});
