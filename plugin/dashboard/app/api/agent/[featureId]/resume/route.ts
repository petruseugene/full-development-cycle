import { assertSameOrigin } from '@/lib/csrf';
/**
 * POST /api/agent/[featureId]/resume — re-attach to a persisted session.
 *
 * Spec references: R5, R10, R15; acceptance AC1, AC6.
 *
 * Flow:
 *   1. Loopback guard (R15).
 *   2. Empty body — `featureId` is the only input, taken from the path.
 *   3. Require persisted session metadata to exist on disk; otherwise
 *      respond 404 `{ error: 'no_session_to_resume' }` so the UI can
 *      render the "No session yet" empty state.
 *   4. Hand off to `sessionManager.resume(featureId)`. If the session is
 *      already live (in-memory record present), the manager returns the
 *      live `{ sessionId, status }` without spawning a new SDK query.
 */

import { NextResponse } from 'next/server';

import { agentGate } from '@/lib/agent-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { featureId: string } },
): Promise<Response> {
  const gated = await agentGate();
  if (gated) return gated;
  const { assertLoopback } = await import('@/lib/agent/loopback');
  const { assertSafeFeatureId } = await import('@/lib/agent/path-safety');
  const { sessionManager } = await import('@/lib/agent/session-manager');
  const guard = assertLoopback(request);
  if (guard) return guard;
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  try {
    assertSafeFeatureId(params.featureId);
  } catch {
    return NextResponse.json(
      { error: 'invalid_feature_id' },
      { status: 400 },
    );
  }

  const { featureId } = params;

  // Resume requires persisted metadata — i.e. a prior `start()` must have
  // run for this featureId in this workspace. A live in-memory record
  // also satisfies the precondition (sessionManager.resume short-circuits
  // and returns the live record).
  const existing = await sessionManager.get(featureId);
  if (!existing) {
    return NextResponse.json(
      { error: 'no_session_to_resume' },
      { status: 404 },
    );
  }

  try {
    const { sessionId, status } = await sessionManager.resume(featureId);
    return NextResponse.json({ sessionId, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('no_session_to_resume')) {
      return NextResponse.json(
        { error: 'no_session_to_resume' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: 'resume_failed', message },
      { status: 500 },
    );
  }
}
