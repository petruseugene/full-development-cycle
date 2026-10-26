'use client';

/**
 * ChatTab — the Chat panel inside the ChatDrawer.
 *
 * Spec / AC refs:
 *   - AC1   — live event stream rendered inside the drawer
 *   - AC3   — assistant_text supports markdown via AssistantText
 *   - AC17  — `.chat-log` vertical flex; assistant cards with an uppercase
 *             ink-500 "who" label; composer anchored below
 *   - AC19  — "stick to bottom" auto-scroll + `New messages ↓` pill when
 *             the user scrolls away
 *   - R26   — auto-scroll within 100px of the bottom
 *
 * Visual idiom: dashboard tokens — white cards, `border-line`,
 * `rounded-lg`, `shadow-sm`, Geist body, `mono` only inside code rows.
 * The `.chat-log` is a vertical flex with `gap-2.5`; assistant cards carry
 * a 22px monogram avatar and an uppercase "claude" label. The composer
 * below the log is `ReplyComposer`.
 *
 * Extension point — `eventRenderers` prop:
 *
 *   Tasks 13 (tool / status / error cards) and 14 (approval card,
 *   user-message rendering) ship their renderers AFTER this task. To
 *   avoid a parallel-write race on this file, `ChatTab` reads optional
 *   renderers off `eventRenderers` (a `Record<AgentEvent['type'], FC>`)
 *   AND off a module-level registry (`registerEventRenderer`). A
 *   downstream task can either:
 *     - pass `eventRenderers` from `ChatDrawer.tsx` (preferred for
 *       per-feature overrides), or
 *     - call `registerEventRenderer('tool_call', ToolCallCard)` at
 *       module import time (Tasks 13/14 will pick this path so the
 *       drawer wiring stays minimal).
 *
 *   The dispatcher walks: prop override → module registry → default.
 *   Today only `assistant_text` has a default (AssistantText); every
 *   other event type renders as a muted `.event-placeholder` line so a
 *   reviewer can see traffic without the cards mounted.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import type {
  AgentEvent,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
  AssistantTextEvent,
  SessionStatus,
  ToolResultEvent,
} from '@/lib/agent/types';
import AssistantText from './AssistantText';
import { useEventStream } from './EventStream';
import ToolCallCard from './ToolCallCard';
import ToolResultCard from './ToolResultCard';
import StatusLine from './StatusLine';
import ErrorCard from './ErrorCard';
import ApprovalCard from './ApprovalCard';
import ReplyComposer, {
  type ComposerSessionStatus,
} from './ReplyComposer';
import { ChatTabFeatureContext } from './ChatTabFeatureContext';

/** Distance from the bottom (px) within which we auto-scroll on new events. */
const STICK_TO_BOTTOM_THRESHOLD_PX = 100;

/**
 * Per-event-type renderer. Each renderer receives the (possibly coalesced)
 * event and is responsible for its own card chrome. The `assistant_text`
 * renderer reads `delta` (which the coalesce step has rolled up into the
 * full message text by the time it hits the renderer).
 */
export type EventRenderer<E extends AgentEvent = AgentEvent> = ComponentType<{
  event: E;
}>;

/** The shape Tasks 13/14 will populate; everything is optional today. */
export type EventRenderers = Partial<{
  [K in AgentEvent['type']]: EventRenderer<Extract<AgentEvent, { type: K }>>;
}>;

// ── Module-level registry ─────────────────────────────────────────────────
// Tasks 13 and 14 call `registerEventRenderer` at import time so they don't
// need to wire props through ChatDrawer. The registry is a plain mutable
// object — it's process-wide and survives HMR, which is what we want; the
// alternative (a React context) would force a re-render of every consumer
// when a new renderer registers, and that's strictly worse than relying on
// the next event arrival to repaint.
const moduleRegistry: EventRenderers = {};

/**
 * Register a renderer for an event type from a downstream task module.
 * Idempotent: re-registering replaces the previous handler.
 */
export function registerEventRenderer<K extends AgentEvent['type']>(
  type: K,
  renderer: EventRenderer<Extract<AgentEvent, { type: K }>>,
): void {
  (moduleRegistry as Record<string, unknown>)[type] = renderer;
}

/** Inverse — used by tests to keep cases isolated. */
export function unregisterEventRenderer(type: AgentEvent['type']): void {
  delete (moduleRegistry as Record<string, unknown>)[type];
}

// ── Default renderers ─────────────────────────────────────────────────────

/**
 * Default `assistant_text` card. Dashboard-token styling: white card,
 * 1px line border, `rounded-lg`, subtle shadow. The "who" row pairs a
 * 22px square monogram avatar with an uppercase ink-500 label and an
 * optional right-side context chip slot. Body is delegated to
 * `AssistantText` (sanitised markdown).
 */
function DefaultAssistantTextRenderer({
  event,
}: {
  event: AssistantTextEvent;
}): JSX.Element {
  return (
    <article className="msg-assistant bg-white border border-line rounded-lg p-3 shadow-sm">
      <div className="who flex items-center gap-2 mb-2">
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-md bg-primary text-white mono text-[10px] font-bold leading-none"
        >
          CL
        </span>
        <span className="text-[11px] tracking-wider uppercase text-ink-500 font-semibold">
          claude
        </span>
      </div>
      <AssistantText text={event.delta} />
    </article>
  );
}

/**
 * Built-in defaults Task 13 wires for the non-text event types. Each is a
 * thin wrapper that satisfies the renderer signature; the heavy lifting
 * lives in the per-card components. Approval events (request / resolved)
 * remain unrendered defaults — Task 14 will register an `ApprovalCard`
 * via `registerEventRenderer` once it lands.
 */
const DEFAULT_RENDERERS: EventRenderers = {
  assistant_text: DefaultAssistantTextRenderer,
  tool_call: ToolCallCard as EventRenderer<
    Extract<AgentEvent, { type: 'tool_call' }>
  >,
  status: StatusLine as EventRenderer<
    Extract<AgentEvent, { type: 'status' }>
  >,
  error: ErrorCard as EventRenderer<Extract<AgentEvent, { type: 'error' }>>,
  // Task 14: approval requests render as the warn-bg ApprovalCard. We do
  // not register a renderer for `approval_resolved` — those events fold
  // into the matching `approval_request` row in the dispatcher below so a
  // resolved card stays in its original position rather than spawning a
  // duplicate line.
  approval_request: ApprovalCard as EventRenderer<
    Extract<AgentEvent, { type: 'approval_request' }>
  >,
};

/** Build the renderer-lookup function from the prop override + module registry. */
function resolveRenderer(
  type: AgentEvent['type'],
  overrides: EventRenderers,
): EventRenderer | null {
  // Prop override > module registry > built-in default. Cast to the loose
  // `EventRenderer` after lookup because the per-key narrowing the public
  // API exposes doesn't survive an indexed access through Partial<…>.
  const fromProps = overrides[type] as EventRenderer | undefined;
  if (fromProps) return fromProps;
  const fromRegistry = moduleRegistry[type] as EventRenderer | undefined;
  if (fromRegistry) return fromRegistry;
  const fromDefault = DEFAULT_RENDERERS[type] as EventRenderer | undefined;
  if (fromDefault) return fromDefault;
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────

interface ChatTabProps {
  featureId: string;
  /** Optional renderer overrides per event type (Tasks 13/14). */
  eventRenderers?: EventRenderers;
}

export default function ChatTab({
  featureId,
  eventRenderers,
}: ChatTabProps): JSX.Element {
  const events = useEventStream(featureId);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Track whether the user is "stuck to bottom" — within 100px of the
  // scroll bottom (R26). When true, every new event auto-scrolls; when
  // false, we surface the `New messages ↓` pill instead. Tracked in
  // state so the pill visibility re-renders on scroll.
  const [stickToBottom, setStickToBottom] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);

  const updateStickFromScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    setStickToBottom(next);
    if (next) setHasUnseen(false);
  }, []);

  // Scroll listener — fires on user scroll AND on the programmatic
  // scroll-to-bottom below. The second pass is harmless (sticky state
  // recomputes to `true` and stays there).
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = (): void => updateStickFromScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [updateStickFromScroll]);

  // Auto-scroll on new events when stick-to-bottom is true. Otherwise
  // flip the unseen flag so the pill appears. The dependency on
  // `events.length` keeps this from firing for every coalesced delta —
  // an `assistant_text` chunk merged in place doesn't bump the count,
  // so we also depend on the last event's identity to catch the
  // streaming case (length unchanged, content grew).
  const lastEvent = events[events.length - 1];
  const lastSig =
    lastEvent?.type === 'assistant_text'
      ? `${lastEvent.id}:${lastEvent.delta.length}`
      : lastEvent?.id ?? -1;
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (stickToBottom) {
      el.scrollTop = el.scrollHeight;
    } else if (events.length > 0) {
      setHasUnseen(true);
    }
    // We deliberately depend on the signature, not on `events` — events
    // is a fresh array reference per rAF flush, so depending on it would
    // re-run this effect on every flush even when content hasn't grown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSig, stickToBottom]);

  // Click-to-bottom for the `New messages ↓` pill.
  const onJumpToBottom = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
    setHasUnseen(false);
  }, []);

  // Cache the dispatcher so we don't re-resolve per event on every render.
  // Built off the (stable) prop reference + the module registry (which is
  // stable per process). The renderer's identity matters because we use
  // it as the `key` fallback for events without a stable id.
  const dispatcher = useMemo(() => {
    return (event: AgentEvent): JSX.Element | null => {
      // `usage` events do NOT render in the chat (AC18 / R27 usage). They
      // update Stats (Task 15) and the header status badge via separate
      // channels; in the chat log they would be visual noise.
      if (event.type === 'usage') return null;
      const Renderer = resolveRenderer(event.type, eventRenderers ?? {});
      if (!Renderer) return null;
      // The renderer is typed against the narrowed event type at the
      // resolveRenderer boundary; cast back to the open shape here so a
      // generic dispatcher can call it with any `AgentEvent`.
      const R = Renderer as ComponentType<{ event: AgentEvent }>;
      return <R event={event} />;
    };
  }, [eventRenderers]);

  // Pair `tool_result` events with their matching `tool_call` by
  // `tool_use_id` (AC18). The dispatcher walks the linear event list once
  // and produces a list of "rows", where a `tool_call` row may carry its
  // (optional) matching `tool_result` so the result renders nested
  // beneath the call card. Orphan `tool_result` events — i.e. a result
  // whose matching call is missing from the current event list (older
  // than the ring buffer, or the call was elided) — render at the top
  // level so the user still sees the output.
  const rows = useMemo(() => {
    type Row =
      | { kind: 'pair'; call: AgentEvent; result?: ToolResultEvent }
      | {
          kind: 'approval';
          request: ApprovalRequestEvent;
          /** Forwarded from a matching `approval_resolved` event. */
          resolvedDecision: ApprovalResolvedEvent['decision'] | null;
        }
      | { kind: 'event'; event: AgentEvent };

    const out: Row[] = [];
    const callIdxById = new Map<string, number>();
    // Track approval rows by requestId so a later `approval_resolved`
    // event can fold its decision into the matching `approval_request`
    // row without spawning a duplicate line.
    const approvalIdxById = new Map<string, number>();
    for (const ev of events) {
      if (ev.type === 'tool_call') {
        callIdxById.set(ev.toolUseId, out.length);
        out.push({ kind: 'pair', call: ev });
        continue;
      }
      if (ev.type === 'tool_result') {
        const parentIdx = callIdxById.get(ev.toolUseId);
        if (parentIdx != null) {
          const parent = out[parentIdx];
          if (parent.kind === 'pair' && !parent.result) {
            out[parentIdx] = { ...parent, result: ev };
            continue;
          }
        }
        // No parent (or parent already paired) — fall through to a
        // top-level row so the result still surfaces.
        out.push({ kind: 'event', event: ev });
        continue;
      }
      if (ev.type === 'approval_request') {
        approvalIdxById.set(ev.requestId, out.length);
        out.push({ kind: 'approval', request: ev, resolvedDecision: null });
        continue;
      }
      if (ev.type === 'approval_resolved') {
        // Fold the resolution into the matching request row. If the
        // matching request is missing from the ring buffer (older than
        // the replay window), drop the event entirely — there's no card
        // to update, and a stand-alone "Approved · …" line without its
        // request context would be visual noise. The TopBar pill and
        // global approvals API are the source of truth for cross-feature
        // pending counts.
        const reqIdx = approvalIdxById.get(ev.requestId);
        if (reqIdx != null) {
          const row = out[reqIdx];
          if (row && row.kind === 'approval') {
            out[reqIdx] = { ...row, resolvedDecision: ev.decision };
          }
        }
        continue;
      }
      out.push({ kind: 'event', event: ev });
    }
    return out;
  }, [events]);

  // Derive the current session status from the most recent `status` event
  // observed on the per-feature stream. The session manager broadcasts
  // `awaiting_approval` here whenever an approval lands (see Task 7),
  // which is exactly what `ReplyComposer` needs for its AC23 lockout.
  // We default to `running` so a host without a status frame yet (fresh
  // attach, no_session) still gets a functional composer; the lockout
  // only kicks in once we see an explicit `awaiting_approval`.
  const sessionStatus: ComposerSessionStatus = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'status') {
        const s = ev.status;
        if (s === 'no_session') return 'no_session';
        // Narrow back to the SessionStatus literal union — the status
        // field carries both shapes, and Composer accepts the same union.
        return s as SessionStatus;
      }
    }
    return 'running';
  }, [events]);

  return (
    <ChatTabFeatureContext.Provider value={featureId}>
    <div
      role="tabpanel"
      aria-label="Chat events"
      className="chat-tab relative flex flex-col h-full min-h-0"
    >
      {/* `.chat-log` — vertical flex container, aria-live="polite" so
          screen readers announce new assistant messages without
          interrupting the user mid-read (AC17). The `tabpanel` role on
          the wrapper already labels the region; we mark the inner log
          as the live region so the pill below isn't announced as it
          appears/disappears. */}
      <div
        ref={logRef}
        className="chat-log col-scroll flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 px-3.5 py-3"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {rows.map((row, idx) => {
          if (row.kind === 'pair') {
            const callRendered = dispatcher(row.call);
            // Skip rendering an empty row entirely (e.g. a future event
            // type with a null renderer). Without this, the gap from
            // the parent flex would still allocate vertical space.
            if (!callRendered && !row.result) return null;
            return (
              <div
                key={`pair:${row.call.id}:${idx}`}
                className="event-row event-tool_call"
              >
                {callRendered}
                {row.result && (
                  <div className="event-row event-tool_result mt-1.5 ml-3">
                    <ToolResultCard event={row.result} />
                  </div>
                )}
              </div>
            );
          }
          if (row.kind === 'approval') {
            // Approval rows bypass the dispatcher so we can thread the
            // `resolvedDecision` prop through. When the matching
            // `approval_resolved` event has been observed, the card
            // switches to its one-line summary view automatically.
            return (
              <div
                key={`approval:${row.request.requestId}:${idx}`}
                className="event-row event-approval_request"
              >
                <ApprovalCard
                  event={row.request}
                  resolvedDecision={row.resolvedDecision}
                />
              </div>
            );
          }
          const rendered = dispatcher(row.event);
          if (!rendered) return null;
          return (
            <div
              key={`${row.event.type}:${row.event.id}:${idx}`}
              className={`event-row event-${row.event.type}`}
            >
              {rendered}
            </div>
          );
        })}
      </div>

      {/* `New messages ↓` pill (R26 / AC19). Positioned over the log
          near the bottom edge. Hidden when the user is already stuck to
          bottom or when no new events have arrived since they scrolled
          away. Uses a real `<button>` for keyboard + a11y. */}
      {!stickToBottom && hasUnseen && (
        <button
          type="button"
          className="new-msg-pill absolute left-1/2 -translate-x-1/2 bottom-4 bg-white border border-line rounded-full px-3 py-1 text-[12px] shadow-sm hover:bg-ink-50 z-10"
          onClick={onJumpToBottom}
        >
          New messages ↓
        </button>
      )}

      {/* Composer slot (Task 14). Anchored as the next sibling under
          `.chat-log` per the wireframe. `sessionStatus` is derived from
          the most recent `status` SSE frame above; when it's
          `awaiting_approval`, AC23's lockout kicks in inside the
          composer (disabled textarea + Send, placeholder swap,
          container opacity .55). */}
      <ReplyComposer sessionStatus={sessionStatus} />
    </div>
    </ChatTabFeatureContext.Provider>
  );
}
