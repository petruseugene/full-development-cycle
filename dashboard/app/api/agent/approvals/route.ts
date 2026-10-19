/**
 * GET /api/agent/approvals — flat list of every pending `canUseTool`
 * request across all active sessions (spec R14 / AC4, Task 7).
 *
 * Used by the TopBar `PendingApprovalsPill` popover (Task 17) which
 * needs a one-shot snapshot on render and a live signal from
 * `GET /api/agent/events` (also Task 7) for updates.
 *
 * Body: `{ approvals: Array<{ featureId, requestId, toolName, toolInput, createdAt }> }`
 *
 * Loopback-only.
 */

import { NextResponse } from 'next/server';

import { agentGate } from '@/lib/agent-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const gated = await agentGate();
  if (gated) return gated;
  const { assertLoopback } = await import('@/lib/agent/loopback');
  const { sessionManager } = await import('@/lib/agent/session-manager');
  const blocked = assertLoopback(request);
  if (blocked) return blocked;

  // `listPendingApprovals()` returns `PendingApproval` records keyed by
  // `id`. Reshape to the route's wire contract — `requestId` is the
  // spec-named field, even though internally we call it `id` (R14).
  const approvals = sessionManager.listPendingApprovals().map((p) => ({
    featureId: p.featureId,
    requestId: p.id,
    toolName: p.toolName,
    toolInput: p.toolInput,
    createdAt: p.createdAt,
  }));

  return NextResponse.json(
    { approvals },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
