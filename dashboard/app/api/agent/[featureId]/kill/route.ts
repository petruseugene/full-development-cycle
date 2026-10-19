import { assertSameOrigin } from '@/lib/csrf';
/**
 * POST /api/agent/[featureId]/kill — terminate a live session.
 *
 * Spec references: R6, R13, R15, R43; acceptance AC6.
 *
 * Calls `sessionManager.kill(featureId)`. The manager:
 *   - aborts the SDK's `AbortController`,
 *   - closes the streaming-input queue,
 *   - flips `<featureId>.json` status to `killed`,
 *   - emits a final `status` event with `phase: 'killed'` (the per-feature
 *     SSE stream from Task 5 forwards it to the browser, satisfying R13),
 *   - leaves `<featureId>.events.jsonl` / `.stats.json` intact on disk.
 *     A subsequent `POST /start` rotates them under an ISO-timestamp
 *     suffix via `log-rotation.ts` (R43).
 *
 * Returns `{ killed: true }`. If no session is live, the manager returns
 * `{ killed: false }` — both shapes serialise identically here; the
 * frontend treats a `false` outcome as "nothing to do" and re-renders the
 * empty state.
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
  const result = await sessionManager.kill(featureId);
  return NextResponse.json({ killed: result.killed });
}
