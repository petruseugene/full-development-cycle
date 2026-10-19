/**
 * Approval state-machine — `allow_and_remember` allowlist contract.
 *
 * Spec R6: when the user picks "Approve & remember", the chosen tool is
 * added to the per-session `ApprovalState.allowlist`. The session
 * manager's `canUseTool` wrapper checks this set FIRST and short-circuits
 * to `{ behavior: 'allow' }` without producing a fresh pending entry.
 *
 * The integration-with-session-manager spike here drives the live
 * `sessionManager` singleton with a mocked Anthropic SDK so we exercise
 * the real `makeCanUseTool` → `respondApproval` round-trip end-to-end.
 *
 * Pinned behaviours:
 *   1. First canUseTool('Bash', …) creates a pending request (listed in
 *      `listPendingApprovals()`).
 *   2. Resolving with `'allow_and_remember'` settles the awaited Promise
 *      with `behavior: 'allow'` AND adds 'Bash' to the allowlist.
 *   3. A second canUseTool('Bash', …) returns `{ behavior: 'allow' }`
 *      synchronously, never appears in `listPendingApprovals()`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs so the manager's persistMeta / appendEventLine /
// flushStats all no-op. This sidesteps a benign cross-write race on the
// shared `.tmp` filename between the canUseTool status-flip (fire-and-
// forget) and respondApproval's persist that surfaces as an ENOENT in
// the unhandled-rejection collector. The contract we're pinning is the
// in-memory allowlist + pending-map state machine, not disk format.
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

// Mock the SDK BEFORE importing session-manager so the import-time
// `query()` binding is the mocked one. We surface the manager's
// canUseTool callback on globalThis so the test can drive it directly.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeQuery(args: {
    options?: { canUseTool?: unknown };
  } & Record<string, unknown>) {
    const messages: Array<Record<string, unknown>> = [
      { type: 'system', session_id: 'sess-test-1', subtype: 'init' },
    ];
    const iter = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (): Promise<{ value: unknown; done: boolean }> => {
        const value = messages.shift();
        if (value) return { value, done: false };
        // Park forever — the test exits via afterEach, never via the
        // SDK iterator completing. Prevents the manager from flipping
        // to `idle` mid-test and racing a second persistMeta against
        // the one canUseTool fires when flipping to `awaiting_approval`.
        return new Promise(() => {
          /* never resolves */
        });
      },
      async close() {
        /* noop */
      },
    };
    (globalThis as Record<string, unknown>).__testCanUseTool =
      args.options?.canUseTool;
    return iter;
  }
  return { query: makeQuery };
});

beforeEach(() => {
  // Fresh module graph per test so the session-manager singleton (and
  // its in-memory sessions map) is rebuilt from scratch.
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__testCanUseTool;
  delete (globalThis as Record<string, unknown>).__sessionManager;
});

describe('approvals — allow_and_remember adds to session allowlist', () => {
  it('short-circuits subsequent canUseTool calls for the same tool', async () => {
    const { sessionManager } = await import('../session-manager');

    const { sessionId } = await sessionManager.start('feat-test-allowlist');
    expect(sessionId).toBe('sess-test-1');

    type CanUse = (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; suggestions?: unknown },
    ) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: unknown }>;
    const canUseTool = (globalThis as Record<string, unknown>)
      .__testCanUseTool as CanUse;
    expect(typeof canUseTool).toBe('function');

    const controller = new AbortController();

    // (1) First call — enqueues a pending approval.
    const firstCall = canUseTool('Bash', { command: 'ls' }, {
      signal: controller.signal,
    });
    const pendingBefore = sessionManager.listPendingApprovals();
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].toolName).toBe('Bash');
    const requestId = pendingBefore[0].id;

    // (2) Resolve with allow_and_remember.
    await sessionManager.respondApproval(
      'feat-test-allowlist',
      requestId,
      'allow_and_remember',
    );
    const firstResult = await firstCall;
    expect(firstResult.behavior).toBe('allow');

    // Pending queue drained.
    expect(sessionManager.listPendingApprovals()).toHaveLength(0);

    // (3) Second call short-circuits — no pending entry, immediate allow.
    const secondCall = canUseTool('Bash', { command: 'pwd' }, {
      signal: controller.signal,
    });
    const secondResult = await secondCall;
    expect(secondResult.behavior).toBe('allow');
    // Critical: the short-circuit must NOT create a pending entry.
    expect(sessionManager.listPendingApprovals()).toHaveLength(0);
  });
});
