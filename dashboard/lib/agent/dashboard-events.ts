'use client';

/**
 * Dashboard-wide agent SSE bridge (Task 17, spec R14 / AC4).
 *
 * Wraps `GET /api/agent/events` — the cross-feature SSE feed that emits
 * `approval_request`, `approval_resolved`, and `session_status` frames
 * tagged with `{ featureId, ... }`. Exposes a singleton module-level
 * EventSource so any number of subscribers share one connection.
 *
 * Consumers:
 *   - `PendingApprovalsPill` (Task 17) — uses `useDashboardAgentEvents()`
 *     to refresh the approvals snapshot immediately on every
 *     approval_request / approval_resolved frame, on top of the 4s
 *     backstop poll.
 *
 * Design notes:
 *   - One module-level subscriber count + one shared EventSource. The
 *     EventSource is opened on first subscription and closed when the
 *     last subscriber unmounts (`subscriberCount === 0`).
 *   - `EventSource` reconnects automatically on transient network
 *     errors with its built-in backoff; we layer a watchdog so that
 *     after a CLOSED transition we recreate the EventSource (browsers
 *     stop retrying once the source enters the CLOSED state).
 *   - SSR-safe: every browser-only path is gated on
 *     `typeof window !== 'undefined'`. The hook returns an empty
 *     `DashboardAgentEventState` during SSR so React-on-server renders
 *     stably.
 */

import { useEffect, useState } from 'react';

export interface ApprovalRequestPayload {
  featureId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalResolvedPayload {
  featureId: string;
  requestId: string;
  decision: 'allow' | 'allow_and_remember' | 'deny';
}

export interface SessionStatusPayload {
  featureId: string;
  status: string;
  phase?: string;
  message?: string;
}

/**
 * Snapshot of the most-recent dashboard-agent SSE event observed since
 * the EventSource was opened. `seq` is monotonically increasing — used
 * by `useSyncExternalStore`-style consumers (and `useEffect` deps) to
 * detect any change without doing payload-equality on the union.
 */
export interface DashboardAgentEventState {
  /** Monotonic counter incremented on every new event. */
  seq: number;
  /** The most recent approval_request frame, or null if none seen yet. */
  lastApprovalRequest: ApprovalRequestPayload | null;
  /** The most recent approval_resolved frame, or null if none seen yet. */
  lastApprovalResolved: ApprovalResolvedPayload | null;
  /** The most recent session_status frame, or null if none seen yet. */
  lastSessionStatus: SessionStatusPayload | null;
  /** True after at least one frame has been delivered. */
  connected: boolean;
}

type Listener = (state: DashboardAgentEventState) => void;

const EMPTY_STATE: DashboardAgentEventState = Object.freeze({
  seq: 0,
  lastApprovalRequest: null,
  lastApprovalResolved: null,
  lastSessionStatus: null,
  connected: false,
});

let currentState: DashboardAgentEventState = EMPTY_STATE;
const listeners = new Set<Listener>();
let eventSource: EventSource | null = null;
let subscriberCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 16000];

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(currentState);
    } catch {
      // best-effort fan-out — never let one bad subscriber halt the rest
    }
  }
}

function setState(patch: Partial<DashboardAgentEventState>): void {
  currentState = {
    ...currentState,
    ...patch,
    seq: currentState.seq + 1,
    connected: true,
  };
  notify();
}

function clearReconnect(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (subscriberCount === 0) return;
  clearReconnect();
  const idx = Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
  const delay = RECONNECT_BACKOFF_MS[idx];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openEventSource();
  }, delay);
}

function openEventSource(): void {
  if (typeof window === 'undefined') return;
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
  if (eventSource) {
    try {
      eventSource.close();
    } catch {
      // already closed
    }
    eventSource = null;
  }
  let es: EventSource;
  try {
    es = new EventSource('/api/agent/events');
  } catch {
    // EventSource constructor can throw in some embedded contexts; back
    // off and try again.
    scheduleReconnect();
    return;
  }
  eventSource = es;

  const onApprovalRequest = (ev: MessageEvent): void => {
    try {
      const payload = JSON.parse(ev.data) as ApprovalRequestPayload;
      setState({ lastApprovalRequest: payload });
    } catch {
      // ignore malformed frame
    }
  };
  const onApprovalResolved = (ev: MessageEvent): void => {
    try {
      const payload = JSON.parse(ev.data) as ApprovalResolvedPayload;
      setState({ lastApprovalResolved: payload });
    } catch {
      // ignore malformed frame
    }
  };
  const onSessionStatus = (ev: MessageEvent): void => {
    try {
      const payload = JSON.parse(ev.data) as SessionStatusPayload;
      setState({ lastSessionStatus: payload });
    } catch {
      // ignore malformed frame
    }
  };
  const onHello = (): void => {
    // Successful connection — reset backoff. Don't bump `seq` for the
    // hello frame; it carries no payload of interest to consumers.
    reconnectAttempt = 0;
  };

  es.addEventListener('approval_request', onApprovalRequest as EventListener);
  es.addEventListener('approval_resolved', onApprovalResolved as EventListener);
  es.addEventListener('session_status', onSessionStatus as EventListener);
  es.addEventListener('hello', onHello as EventListener);

  es.onerror = (): void => {
    // EventSource transitions: CONNECTING (0) on retry, CLOSED (2) on
    // permanent failure. Browsers stop reconnecting once CLOSED, so we
    // tear it down and re-open via our own backoff schedule.
    if (es.readyState === EventSource.CLOSED) {
      try {
        es.close();
      } catch {
        // ignore
      }
      if (eventSource === es) eventSource = null;
      scheduleReconnect();
    }
    // CONNECTING state — browser handles reconnect itself; do nothing.
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) {
    openEventSource();
  }
  return () => {
    listeners.delete(listener);
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) {
      clearReconnect();
      if (eventSource) {
        try {
          eventSource.close();
        } catch {
          // ignore
        }
        eventSource = null;
      }
      // Don't reset `currentState` — keep the snapshot around for the
      // next mount so newly-mounted consumers see the last known values
      // until the EventSource emits afresh.
    }
  };
}

/**
 * React hook — subscribes the calling component to the singleton
 * dashboard agent event stream. Returns the most-recent
 * `DashboardAgentEventState`. The `seq` field changes on every event,
 * making the return value safe to use directly as a `useEffect`
 * dependency.
 *
 * SSR-safe: returns `EMPTY_STATE` during SSR; the post-mount effect
 * subscribes and triggers a re-render with the live state.
 */
export function useDashboardAgentEvents(): DashboardAgentEventState {
  const [state, setLocal] = useState<DashboardAgentEventState>(
    () => currentState,
  );
  useEffect(() => {
    // Re-sync after mount in case events arrived between module-import
    // and the first render.
    setLocal(currentState);
    return subscribe(setLocal);
  }, []);
  return state;
}

/** Test-only — reset the module singleton between unit tests. */
export function __resetDashboardAgentEventsForTests(): void {
  clearReconnect();
  if (eventSource) {
    try {
      eventSource.close();
    } catch {
      // ignore
    }
    eventSource = null;
  }
  listeners.clear();
  subscriberCount = 0;
  reconnectAttempt = 0;
  currentState = EMPTY_STATE;
}
