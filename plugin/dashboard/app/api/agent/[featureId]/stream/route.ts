/**
 * SSE per-feature stream — `GET /api/agent/[featureId]/stream` (Task 5).
 *
 * Spec references: AC1, AC3, R8 (ring-buffer replay), R15 (loopback guard).
 *
 * Wire shape: standard Server-Sent Events frames —
 *   `event: <AgentEvent.type>\ndata: <JSON.stringify(event)>\n\n`
 *
 * On connect we replay the session's in-memory ring buffer so a late
 * subscriber (e.g. browser reload, drawer re-open) sees the recent history
 * before the live stream takes over (R8). After the replay we subscribe to
 * the session's per-session `EventEmitter` and forward each emitted event
 * verbatim. When the client disconnects (`request.signal` aborts) we
 * unsubscribe and close the controller.
 *
 * For an unknown / non-live featureId we still return a valid SSE stream
 * but emit exactly one `status` frame with `{ status: 'no_session' }` and
 * close — the frontend uses that to render the empty-state pane.
 */

import type { AgentEvent } from '@/lib/agent/types';

import { agentGate } from '@/lib/agent-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE frame encoder. Always returns `event: <type>\ndata: <json>\n\n` — the
 * shape every browser `EventSource` parser expects.
 */
function encodeSseFrame(encoder: TextEncoder, type: string, payload: unknown): Uint8Array {
  const data = JSON.stringify(payload);
  return encoder.encode(`event: ${type}\ndata: ${data}\n\n`);
}

/**
 * Narrow `sessionManager.get()`'s return — a live `SessionRecord` carries
 * a `ringBuffer` + `emitter`; a disk-only `SessionMeta` does not. Using a
 * structural check keeps us decoupled from `SessionRecord` being importable
 * by this module (it's an internal type of session-manager).
 */
function isLiveRecord(
  value: unknown,
): value is { ringBuffer: AgentEvent[]; emitter: { on: Function; off: Function } } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ringBuffer?: unknown; emitter?: unknown };
  return Array.isArray(v.ringBuffer) && v.emitter != null && typeof v.emitter === 'object';
}

export async function GET(
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

  try {
    assertSafeFeatureId(params.featureId);
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid_feature_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { featureId } = params;
  const record = await sessionManager.get(featureId);
  const encoder = new TextEncoder();

  // No live session — emit one status frame and close. Note we deliberately
  // do this even when on-disk metadata exists: the SSE stream only fans out
  // live events, and an orphaned/killed session has no emitter to subscribe
  // to. The frontend interprets `no_session` as "show the empty state".
  if (!isLiveRecord(record)) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeSseFrame(encoder, 'status', { status: 'no_session' }));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  }

  const live = record;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      // Single close path: idempotent so the abort listener and any future
      // error path can both call it without double-close throws.
      const closeOnce = (): void => {
        if (closed) return;
        closed = true;
        try {
          (live.emitter as unknown as { off: (e: string, l: Function) => void }).off(
            'event',
            onEvent,
          );
        } catch {
          // Emitter already gone — nothing to detach.
        }
        try {
          controller.close();
        } catch {
          // Controller already closed.
        }
      };

      // Per-event forwarder. Wrapped in try/catch because controller.enqueue
      // throws after the client disconnects but BEFORE our abort listener
      // has fired — without the guard we'd surface a noisy error to the
      // session-manager's emitter loop.
      const onEvent = (ev: AgentEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseFrame(encoder, ev.type, ev));
        } catch {
          closeOnce();
        }
      };

      // (1) Replay the ring buffer (R8). Snapshot the array first so an
      // event that lands mid-replay doesn't get duplicated by the live
      // subscription — emitter.on is attached AFTER the replay completes.
      const replay = live.ringBuffer.slice();
      for (const ev of replay) {
        try {
          controller.enqueue(encodeSseFrame(encoder, ev.type, ev));
        } catch {
          closeOnce();
          return;
        }
      }

      // (2) Subscribe to the live emitter. Topic name matches the session
      // manager's `emitter.emit('event', ev)` call in `emitEvent()`.
      (live.emitter as unknown as { on: (e: string, l: Function) => void }).on(
        'event',
        onEvent,
      );

      // (3) Client disconnect → unsubscribe + close. `request.signal` is
      // the standard Web Fetch abort signal Next.js wires into route
      // handlers; it fires when the browser navigates away or the
      // EventSource closes.
      if (request.signal.aborted) {
        closeOnce();
      } else {
        request.signal.addEventListener('abort', closeOnce, { once: true });
      }
    },
    cancel() {
      // ReadableStream.cancel() fires when the consumer pulls the plug
      // before the abort signal does (e.g. some proxies). Best-effort
      // detach — the abort listener already covers the common path.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
