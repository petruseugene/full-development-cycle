import { assertSameOrigin } from '@/lib/csrf';
/**
 * POST /api/agent/[featureId]/start — spawn a new orchestrator session.
 *
 * Spec references: R1, R15, R18, R43; acceptance AC1, AC3, AC6, AC8.
 *
 * Flow:
 *   1. Loopback guard (R15) — non-loopback Host → 404.
 *   2. `ANTHROPIC_API_KEY` must be set; missing → 500 with a stable error
 *      string the empty-state UI keys off (AC8 / AC16).
 *   3. If a live (non-killed) session already exists for `featureId`,
 *      return 409 `{ error: 'session_already_exists' }` (R1 invariant —
 *      one live session per feature).
 *   4. Rotate any prior killed-session logs (R43) so the fresh start writes
 *      to an empty `<featureId>.events.jsonl` / `.stats.json`.
 *   5. Hand off to `sessionManager.start(featureId)` and return the SDK-
 *      provided sessionId + status.
 *
 * `runtime = 'nodejs'` is required because `sessionManager` uses
 * `node:fs` + `node:events`. `dynamic = 'force-dynamic'` disables ISR /
 * static caching of the POST handler (POSTs aren't cached by default but
 * the directive keeps the per-route flags symmetric with the SSE stream
 * route in this directory).
 */

import { NextResponse } from 'next/server';

import type { SessionMeta, SessionRecord } from '@/lib/agent/types';

import { agentGate, getAgentStatus } from '@/lib/agent-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `sessionManager.get()` returns either an in-memory `SessionRecord` (live)
 * or an on-disk `SessionMeta` (orphaned / killed snapshot). Both shapes
 * carry `meta.status` indirectly — `SessionRecord` nests it under `.meta`,
 * `SessionMeta` exposes it directly. This helper hides the union and
 * returns the bare status string, or `null` when neither exists.
 */
function resolveStatus(
  existing: SessionRecord | SessionMeta | null,
): string | null {
  if (!existing) return null;
  if ('meta' in existing) return existing.meta.status;
  return existing.status;
}

export async function POST(
  request: Request,
  { params }: { params: { featureId: string } },
): Promise<Response> {
  const gated = await agentGate();
  if (gated) return gated;
  const { assertLoopback } = await import('@/lib/agent/loopback');
  const { logRotation } = await import('@/lib/agent/log-rotation');
  const { assertSafeFeatureId } = await import('@/lib/agent/path-safety');
  const { sessionManager } = await import('@/lib/agent/session-manager');
  const guard = assertLoopback(request);
  if (guard) return guard;
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  // Path-safety guard runs right after the loopback check so a hostile
  // segment (`..%2F..%2Fpwn`) never reaches the manager or rotation
  // helpers, both of which interpolate the id into filesystem paths.
  try {
    assertSafeFeatureId(params.featureId);
  } catch {
    return NextResponse.json(
      { error: 'invalid_feature_id' },
      { status: 400 },
    );
  }

  // Mode `on` skips the key check so a Claude Code login can be used.
  const { mode } = await getAgentStatus();
  if (mode !== 'on' && !process.env.ANTHROPIC_API_KEY) {
    // Stable error string — `ChatDrawer` (Task 10) deep-links to the README
    // anchor on exactly this body.
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not set' },
      { status: 500 },
    );
  }

  const { featureId } = params;

  // Reject if a live session is already running. `killed` / `orphaned` /
  // `errored` are all terminal — those should fall through to a fresh start
  // (after log rotation below).
  const existing = await sessionManager.get(featureId);
  const status = resolveStatus(existing);
  if (
    status !== null &&
    status !== 'killed' &&
    status !== 'orphaned' &&
    status !== 'errored'
  ) {
    return NextResponse.json(
      { error: 'session_already_exists' },
      { status: 409 },
    );
  }

  // R43 — preserve the prior run's logs under an ISO-timestamp suffix
  // before the new session starts writing to the same paths.
  await logRotation.rotateIfPresent(featureId);

  try {
    const { sessionId } = await sessionManager.start(featureId);
    return NextResponse.json({ sessionId, status: 'running' });
  } catch (err) {
    // `start()` throws `session_already_exists:<id>` if the in-memory map
    // already holds a record — race with another caller between our get()
    // and start(). Translate to 409 for consistency.
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('session_already_exists')) {
      return NextResponse.json(
        { error: 'session_already_exists' },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: 'start_failed', message },
      { status: 500 },
    );
  }
}
