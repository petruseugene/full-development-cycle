import { watcherHub } from '@/lib/watcher';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('hello', { ts: new Date().toISOString() });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      const unsub = watcherHub.subscribe((kind, payload) => {
        try {
          if (kind === 'pinned-changed') {
            // Custom server-published event: payload is already the full
            // SSE data object (built by POST /api/pins). Forward it
            // verbatim as an `event: pinned-changed` frame.
            send('pinned-changed', payload);
          } else {
            // Chokidar filesystem event: kind is the chokidar event name
            // (add / change / unlink / addDir / unlinkDir) and payload is
            // the file path string. Preserve the existing `event: change`
            // wire shape so current subscribers keep working.
            send('change', { event: kind, file: payload, ts: new Date().toISOString() });
          }
        } catch {
          // controller closed
        }
      });

      const close = () => {
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      // Best-effort cleanup if the runtime exposes a signal in future.
      (controller as unknown as { _close?: () => void })._close = close;
    },
    cancel() {
      // ReadableStream.cancel fires when the client disconnects.
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
