/**
 * Stats API route — `GET /api/agent/[featureId]/stats` (spec §4.1 R7, AC5).
 *
 * The Stats tab in the chat drawer polls this endpoint every 3 seconds while
 * the tab is visible and the session is `running` (Task 15). The handler is a
 * thin shim over `sessionManager.getStats(featureId)`:
 *
 *   - loopback-only (R15) — non-loopback Host header earns a 404
 *   - when no live session exists for `featureId` → `200 {}` so the poller can
 *     keep firing without surfacing 404 errors to the user
 *   - otherwise return the manager's snapshot verbatim. The manager has
 *     already recomputed `wallClockMs` against `Date.now()` (Task 4); we do
 *     NOT recompute it here.
 *
 * `Cache-Control: no-store` is set on every response so the 3 s poll never
 * hits a stale value from an intermediary or the framework's data cache
 * (R33, R35).
 */

import { NextResponse } from 'next/server';

import { assertLoopback } from '@/lib/agent/loopback';
import { assertSafeFeatureId } from '@/lib/agent/path-safety';
import { sessionManager } from '@/lib/agent/session-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export async function GET(
  request: Request,
  { params }: { params: { featureId: string } },
): Promise<Response> {
  // R15 — loopback check is the first line of every /api/agent/* handler.
  const blocked = assertLoopback(request);
  if (blocked) return blocked;

  try {
    assertSafeFeatureId(params.featureId);
  } catch {
    return NextResponse.json(
      { error: 'invalid_feature_id' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const { featureId } = params;

  // `sessionManager.get()` is async (it falls back to disk metadata for
  // orphaned sessions). The dispatch envelope treats "returns nothing" as
  // "no live session" — disk-only orphans have no in-memory stats either, so
  // we collapse both cases to `200 {}`.
  const record = await sessionManager.get(featureId);
  if (!record) {
    return NextResponse.json({}, { status: 200, headers: NO_STORE_HEADERS });
  }

  // Live session — pull the in-memory snapshot. `getStats` recomputes
  // `wallClockMs` against `Date.now()` so this handler doesn't have to.
  const stats = sessionManager.getStats(featureId);
  if (!stats) {
    // Defensive: `get()` returned a record but `getStats()` did not — this
    // happens when the record is disk-only (SessionMeta, no in-memory stats).
    // Same UX as the "no session" path.
    return NextResponse.json({}, { status: 200, headers: NO_STORE_HEADERS });
  }

  return NextResponse.json(stats, { status: 200, headers: NO_STORE_HEADERS });
}
