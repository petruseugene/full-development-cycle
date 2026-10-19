'use client';

/**
 * EventStream — SSE consumer hook for the Chat tab (Task 12).
 *
 * Spec / AC refs:
 *   - AC1, AC3 — live event stream + assistant_text coalescing
 *   - AC17     — events render in `.chat-log`; this hook is the source
 *   - AC19     — composer wires its `awaiting_approval` lockout off the
 *                same event stream (consumed later by Task 14)
 *   - R8       — SSE event types + ring-buffer replay on connect
 *   - R27      — assistant_text coalescing rules: chunks sharing
 *                `messageId` merge into one block; a `status` event with
 *                `phase: 'message_end'` (or a different `messageId`)
 *                flushes
 *   - Constraints §5 — DOM batching via `requestAnimationFrame`
 *
 * Contract:
 *
 *   - Opens an `EventSource` against `/api/agent/<featureId>/stream`.
 *   - Listens for one EventSource event-type per `AgentEvent.type`
 *     (`assistant_text`, `tool_call`, `tool_result`, `approval_request`,
 *     `approval_resolved`, `usage`, `status`, `error`) — the SSE route
 *     encodes each frame with the matching `event:` name.
 *   - Maintains an in-memory ordered list of events. Order is the
 *     EventSource arrival order, which on initial connect = ring-buffer
 *     replay → live tail (per R8).
 *   - Coalesces streaming `assistant_text` chunks: when the current
 *     in-flight messageId matches the new event's `messageId`, the new
 *     event's `delta` is appended to the last block's text in place; a
 *     new `messageId` (or a `status { phase: 'message_end' }`) flushes
 *     the in-flight pointer.
 *   - DOM batching: state writes are coalesced through `requestAnimationFrame`
 *     so a burst of chunks doesn't trigger a re-render per chunk. We append
 *     into a buffer ref, schedule one rAF, and flush on next paint.
 *   - Auto-reconnect with capped exponential backoff on `error`. The
 *     browser EventSource has its own retry, but ours fires on the same
 *     close path so featureId changes or hot reloads close cleanly.
 *
 * The hook returns the event list. Callers (`ChatTab`) handle rendering
 * and the auto-scroll heuristic.
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, AssistantTextEvent } from '@/lib/agent/types';

/**
 * Backoff schedule for the auto-reconnect path. The browser EventSource
 * also retries, but we wrap our own loop so featureId changes / hot
 * reloads can close cleanly without an in-flight reconnect leaking. Capped
 * at 30s so a long server outage doesn't quietly stop polling forever.
 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000, 30_000] as const;

/**
 * Mutate-in-place coalesce: if the incoming `assistant_text` chunk shares
 * its `messageId` with the most-recent event of the same type AND
 * messageId, append the new delta to that block's text. Otherwise push
 * the new event verbatim.
 *
 * Exported for the colocated test in `__tests__/`.
 *
 * Returns the array reference (always the same reference passed in) so
 * the caller can keep referential stability around the buffer.
 */
export function coalesceAssistantText(
  buffer: AgentEvent[],
  next: AssistantTextEvent,
): AgentEvent[] {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const prev = buffer[i];
    if (prev.type === 'assistant_text') {
      if (prev.messageId === next.messageId) {
        // In-place append — the consumer treats the events list as
        // append-only and reads `.delta`-aggregated text by walking the
        // array; mutating the existing block is safe because we always
        // hand consumers a new array reference via `setEvents([...buf])`.
        (prev as AssistantTextEvent).delta = prev.delta + next.delta;
        return buffer;
      }
      // Different messageId on the most-recent assistant block — the
      // previous message is implicitly flushed (R27 "or a different
      // messageId"). Fall through to push as a new block.
      break;
    }
    // Any non-assistant_text event between text chunks implicitly flushes:
    // a tool_call, status, or approval splits the assistant cards in the
    // wireframe (`.msg-assistant` cards separated by `.tool-card` /
    // `.status-line`). Break out to push as a new block.
    break;
  }
  buffer.push(next);
  return buffer;
}

/**
 * Apply a `status { phase: 'message_end' }` event by clearing the
 * in-flight messageId pointer so the next `assistant_text` starts a new
 * block. The events list itself is unchanged — the status line still
 * renders. This is the second half of R27's flushing rule.
 *
 * Returns the (possibly new) in-flight messageId.
 */
function applyStatusFlush(
  ev: AgentEvent,
  inflightMessageId: string | null,
): string | null {
  if (ev.type !== 'status') return inflightMessageId;
  if (ev.phase === 'message_end') return null;
  return inflightMessageId;
}

/**
 * Hook signature — returns a snapshot of the ordered event list. The
 * caller re-renders when events arrive (one re-render per rAF tick under
 * burst load thanks to the batching).
 */
export function useEventStream(featureId: string | null): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  // Buffer of events received between rAF ticks. Mutated in place by the
  // EventSource listeners; flushed to state inside the rAF callback. We
  // keep the ref + state in lockstep on every flush.
  const bufferRef = useRef<AgentEvent[]>([]);
  // rAF handle for in-flight flushes — `null` means no flush is scheduled.
  const rafRef = useRef<number | null>(null);
  // The messageId of the assistant_text block we're currently coalescing
  // into. `null` between messages or after a `message_end` status. Held
  // in a ref so listener identity is stable across re-renders.
  const inflightMidRef = useRef<string | null>(null);
  // Hold the active EventSource so we can close on featureId change /
  // unmount. The reconnect loop reassigns through this ref.
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!featureId) {
      // Caller's drawer is closed (or no feature selected). Reset state
      // so the next open starts from an empty log — otherwise stale
      // events from a previous feature would leak into the next session.
      bufferRef.current = [];
      inflightMidRef.current = null;
      setEvents([]);
      return;
    }

    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = (): void => {
      if (rafRef.current != null) return;
      // SSR-safety: useEffect only runs client-side so `window` is defined,
      // but the typeof guard keeps the code defensible if a future caller
      // imports this module on the server.
      const cb = (): void => {
        rafRef.current = null;
        if (cancelled) return;
        // Snapshot the buffer — React state setter needs a new array ref
        // for the re-render to fire. The buffer ref itself stays the same
        // mutable instance so the next chunk appends in place.
        setEvents([...bufferRef.current]);
      };
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        rafRef.current = window.requestAnimationFrame(cb);
      } else {
        // SSR / test fallback — cast through `unknown` to fit the
        // shared number-typed ref. We invert the cast in the unmount
        // path so the right cancel API is used.
        rafRef.current = setTimeout(cb, 16) as unknown as number;
      }
    };

    const handleEvent = (ev: AgentEvent): void => {
      if (ev.type === 'assistant_text') {
        const inflight = inflightMidRef.current;
        if (inflight === ev.messageId) {
          coalesceAssistantText(bufferRef.current, ev);
        } else {
          // New assistant message — push as a new block and update the
          // in-flight pointer. coalesceAssistantText also handles the
          // "same messageId at the tail" case defensively, but the
          // pointer check short-circuits the array walk for the hot path.
          bufferRef.current.push(ev);
          inflightMidRef.current = ev.messageId;
        }
      } else {
        bufferRef.current.push(ev);
        inflightMidRef.current = applyStatusFlush(ev, inflightMidRef.current);
      }
      scheduleFlush();
    };

    const open = (): void => {
      if (cancelled) return;
      const url = `/api/agent/${encodeURIComponent(featureId)}/stream`;
      let es: EventSource;
      try {
        es = new EventSource(url);
      } catch {
        // Browsers without EventSource — there's nothing to do; the chat
        // log stays empty and the surrounding UI handles the no-stream
        // state. We don't schedule a retry because the constructor would
        // keep failing.
        return;
      }
      esRef.current = es;

      // Named-event listeners — the SSE route encodes each frame with
      // `event: <AgentEvent.type>` so the generic `onmessage` channel
      // never fires. We register one listener per known type and parse
      // the payload defensively.
      const types: AgentEvent['type'][] = [
        'assistant_text',
        'tool_call',
        'tool_result',
        'approval_request',
        'approval_resolved',
        'usage',
        'status',
        'error',
      ];
      const listeners: Array<{ type: string; fn: (e: MessageEvent) => void }> = [];
      for (const type of types) {
        const fn = (e: MessageEvent): void => {
          if (cancelled) return;
          try {
            const parsed = JSON.parse(e.data) as AgentEvent;
            handleEvent(parsed);
            // Successful frame resets the backoff — a transient
            // network blip shouldn't drag retries to the cap.
            reconnectAttempt = 0;
          } catch {
            // Malformed frame — skip rather than tearing the stream down.
            // The server-side ring buffer is the source of truth and
            // will re-emit on the next reconnect.
          }
        };
        es.addEventListener(type, fn as EventListener);
        listeners.push({ type, fn });
      }

      es.onerror = (): void => {
        // EventSource transitions to CLOSED on most errors. We pre-empt
        // its native retry so we own the timing + backoff and so a
        // featureId change can interrupt the loop cleanly.
        if (cancelled) return;
        for (const { type, fn } of listeners) {
          try {
            es.removeEventListener(type, fn as EventListener);
          } catch {
            // Listener already gone — safe to ignore.
          }
        }
        try {
          es.close();
        } catch {
          // Already closed.
        }
        esRef.current = null;
        const delay =
          RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          open();
        }, delay);
      };
    };

    open();

    return () => {
      cancelled = true;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (rafRef.current != null) {
        if (typeof window !== 'undefined' && window.cancelAnimationFrame) {
          window.cancelAnimationFrame(rafRef.current);
        } else {
          clearTimeout(rafRef.current as unknown as ReturnType<typeof setTimeout>);
        }
        rafRef.current = null;
      }
      if (esRef.current) {
        try {
          esRef.current.close();
        } catch {
          // Already closed.
        }
        esRef.current = null;
      }
      // Hard reset so re-opening for a different feature starts clean.
      bufferRef.current = [];
      inflightMidRef.current = null;
    };
  }, [featureId]);

  return events;
}
