import { NextResponse } from 'next/server';
import { assertSameOrigin } from '@/lib/csrf';
import { watcherHub } from '@/lib/watcher';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_SLUG_LEN = 200;
const MAX_ORIGIN_LEN = 64;

/**
 * Type guard: non-empty string with a max length.
 */
function isBoundedString(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

/**
 * POST /api/pins — stateless broadcast endpoint.
 *
 * Validates a `{ action, slug, origin, slugs }` body, then fans out a
 * `pinned-changed` SSE event to every `/api/events` subscriber via
 * `watcherHub.publish`. The endpoint owns no persisted state in v1; clients
 * are the source of truth for their own pinned set (see spec R9).
 *
 * Validation failures and JSON parse errors return 400 without publishing.
 */
export async function POST(req: Request) {
  const csrf = assertSameOrigin(req, { requireJson: true });
  if (csrf) return csrf;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body === null || typeof body !== 'object') {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }

  const { action, slug, origin, slugs } = body as {
    action?: unknown;
    slug?: unknown;
    origin?: unknown;
    slugs?: unknown;
  };

  if (action !== 'pin' && action !== 'unpin') {
    return NextResponse.json(
      { error: "action must be 'pin' or 'unpin'" },
      { status: 400 },
    );
  }

  if (!isBoundedString(slug, MAX_SLUG_LEN)) {
    return NextResponse.json(
      { error: `slug must be a non-empty string of length <= ${MAX_SLUG_LEN}` },
      { status: 400 },
    );
  }

  if (!isBoundedString(origin, MAX_ORIGIN_LEN)) {
    return NextResponse.json(
      { error: `origin must be a non-empty string of length <= ${MAX_ORIGIN_LEN}` },
      { status: 400 },
    );
  }

  if (!Array.isArray(slugs)) {
    return NextResponse.json({ error: 'slugs must be an array' }, { status: 400 });
  }
  for (const s of slugs) {
    if (!isBoundedString(s, MAX_SLUG_LEN)) {
      return NextResponse.json(
        {
          error: `each entry in slugs must be a non-empty string of length <= ${MAX_SLUG_LEN}`,
        },
        { status: 400 },
      );
    }
  }

  // Validation passed — fan out over the existing SSE channel. The published
  // payload mirrors the `PinnedChangedEvent` interface (spec R25).
  watcherHub.publish('pinned-changed', {
    kind: 'pinned-changed',
    slugs: slugs as string[],
    origin,
    ts: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
