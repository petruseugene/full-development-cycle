/**
 * GET /api/agent/events — dashboard-wide SSE stream for cross-feature
 * signals (spec R14 / AC4, Task 7).
 *
 * Subscribes to the session manager's process-wide `globalEvents`
 * broadcaster and forwards three event types to the browser:
 *
 *   - `approval_request`   `{ featureId, requestId, toolName, toolInput, createdAt, ... }`
 *   - `approval_resolved`  `{ featureId, requestId, decision, ... }`
 *   - `session_status`     `{ featureId, status, phase?, message?, ... }`
 *
 * Unlike the per-feature stream (`GET /api/agent/[featureId]/stream`),
 * this route does NOT replay history — it is a live signal feed for
 * the TopBar pill + any cross-feature widgets. New subscribers start
 * fresh and rely on `GET /api/agent/approvals` for the initial snapshot.
 *
 * Loopback-only. `runtime = 'nodejs'` + `dynamic = 'force-dynamic'`
 * disable edge + ISR so the stream is never cached.
 */

import { agentGate } from '@/lib/agent-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BROADCAST_EVENTS = [
  'approval_request',
  'approval_resolved',
  'session_status',
] as const;

export async function GET(request: Request): Promise<Response> {
  const gated = await agentGate();
  if (gated) return gated;
  const { assertLoopback } = await import('@/lib/agent/loopback');
  const { sessionManager } = await import('@/lib/agent/session-manager');
  const blocked = assertLoopback(request);
  if (blocked) return blocked;

  const encoder = new TextEncoder();
  const { globalEvents } = sessionManager;

  // Per-connection cleanup closures. Captured by both the abort handler
  // and `cancel()` so the listeners come off whichever path fires first.
  const cleanups: Array<() => void> = [];
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (type: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          // Controller already closed — fall through; abort handler
          // will run cleanups.
        }
      };

      // Emit one `hello` frame so the browser's EventSource transitions
      // out of `CONNECTING` immediately. No payload beyond a timestamp.
      send('hello', { ts: new Date().toISOString() });

      // Heartbeat keeps proxies and dev-server hot-reloaders from
      // dropping an otherwise-idle SSE connection. Plain SSE comment.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      cleanups.push(() => clearInterval(heartbeat));

      // Subscribe to every broadcast topic. Listeners are removed
      // together when the request aborts or the stream is cancelled.
      for (const topic of BROADCAST_EVENTS) {
        const listener = (payload: unknown): void => send(topic, payload);
        globalEvents.on(topic, listener);
        cleanups.push(() => globalEvents.off(topic, listener));
      }

      // Browser disconnect path: `request.signal` aborts when the
      // client closes the EventSource. Tear down listeners and close
      // the controller so the runtime releases the response.
      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        for (const fn of cleanups) {
          try {
            fn();
          } catch {
            // best-effort cleanup
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    cancel() {
      // ReadableStream.cancel fires when the consumer disconnects via
      // the stream API rather than aborting the request. Tear down
      // listeners the same way.
      if (closed) return;
      closed = true;
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // best-effort cleanup
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
