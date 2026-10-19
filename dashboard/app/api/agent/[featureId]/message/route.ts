import { assertSameOrigin } from '@/lib/csrf';
/**
 * POST /api/agent/[featureId]/message — push a user turn into the SDK.
 *
 * Spec references: R11, R15; acceptance AC1.
 *
 * Body: `{ text: string }` (non-empty after trim).
 *
 * Returns `{ accepted: true }` on success, or `{ accepted: false, reason }`
 * on the explicit no-session / killed / errored / empty cases — see the
 * `send()` JSDoc in `session-manager.ts` for the exact reason strings.
 *
 * HTTP status is always 200 for the structured-reject path so the frontend
 * `ReplyComposer` (Task 14) can surface the `reason` as a small inline
 * error rather than throwing a generic network error. Genuine client
 * errors (invalid JSON, missing field, wrong type) return 400.
 */

import { NextResponse } from 'next/server';

import { assertLoopback } from '@/lib/agent/loopback';
import { assertSafeFeatureId } from '@/lib/agent/path-safety';
import { sessionManager } from '@/lib/agent/session-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { featureId: string } },
): Promise<Response> {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'body_must_be_object' },
      { status: 400 },
    );
  }
  const { text } = body as { text?: unknown };
  if (typeof text !== 'string') {
    return NextResponse.json(
      { error: 'text_must_be_string' },
      { status: 400 },
    );
  }
  if (text.trim().length === 0) {
    // The manager's `send()` also rejects empty strings; we mirror that
    // here so an empty submission never hits the input queue and the
    // frontend sees a structured `{ accepted: false }` rather than a 400.
    return NextResponse.json(
      { accepted: false, reason: 'empty_message' },
      { status: 200 },
    );
  }

  const result = sessionManager.send(featureId, text);
  return NextResponse.json(result);
}
