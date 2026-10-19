import { assertSameOrigin } from '@/lib/csrf';
/**
 * POST /api/agent/[featureId]/approval — resolve one pending `canUseTool`
 * request (spec R12 / AC2, Task 7).
 *
 * Body: `{ requestId: string, decision: 'allow' | 'allow_and_remember' | 'deny' }`
 *
 * Returns:
 *   - `200 { resolved: true }`            on success
 *   - `400 { error: 'invalid_body' }`     on malformed / missing fields
 *   - `400 { error: 'invalid_decision' }` if decision is outside the enum
 *   - `404 { error: 'unknown_request' }`  if the requestId is not pending
 *     (also covers the session-gone case)
 *
 * Loopback-only — `assertLoopback` is the first line, mirroring every other
 * `/api/agent/*` handler (R15 / AC7).
 */

import { NextResponse } from 'next/server';

import { assertLoopback } from '@/lib/agent/loopback';
import { assertSafeFeatureId } from '@/lib/agent/path-safety';
import { sessionManager } from '@/lib/agent/session-manager';
import type { ApprovalDecision } from '@/lib/agent/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DECISIONS: readonly ApprovalDecision[] = [
  'allow',
  'allow_and_remember',
  'deny',
];

function isValidDecision(v: unknown): v is ApprovalDecision {
  return (
    typeof v === 'string' &&
    (VALID_DECISIONS as readonly string[]).includes(v)
  );
}

export async function POST(
  request: Request,
  { params }: { params: { featureId: string } },
): Promise<Response> {
  const blocked = assertLoopback(request);
  if (blocked) return blocked;
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { requestId, decision } =
    (body as { requestId?: unknown; decision?: unknown }) ?? {};

  if (typeof requestId !== 'string' || requestId.length === 0) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!isValidDecision(decision)) {
    return NextResponse.json({ error: 'invalid_decision' }, { status: 400 });
  }

  try {
    await sessionManager.respondApproval(
      params.featureId,
      requestId,
      decision,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // session-manager throws `unknown_request:<id>` for both missing
    // sessions and missing requestIds. Either way the route maps to 404
    // per the task envelope ("404 { error: 'unknown_request' } on miss").
    if (msg.startsWith('unknown_request')) {
      return NextResponse.json(
        { error: 'unknown_request' },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ resolved: true });
}
