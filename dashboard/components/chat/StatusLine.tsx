'use client';

/**
 * StatusLine — renderer for `status` events in the Chat tab.
 *
 * Spec / AC refs:
 *   - Spec §6.7 — not a card; inline mono row with a dot whose color tracks
 *                 the current session status. `.pulse-dot` animates when the
 *                 status is `running` or `awaiting_approval`.
 *   - AC1, AC3, AC17 — status events render as a muted single-line entry
 *                       between cards (chat tab).
 *   - R27 status     — e.g. "Session resumed", "Session killed"
 *
 * Visual contract (Task 5 of chat-redesign):
 *   `[● dot]  status text  ·  optional message`
 *   - container: `flex items-center gap-2 px-1 py-1.5 text-[11.5px] text-ink-500 mono`
 *   - dot color per status: ink-400 idle, blue-600 running, amber-600
 *     awaiting_approval, red-600 errored, ink-500 killed
 *   - `.pulse-dot` applied when status is running or awaiting_approval
 *   - field separators are middle-dots (·) in `text-ink-400`
 *
 * Empty / phase-only events: a `status { phase: 'message_end' }` carries no
 * user-readable text and exists only as a flush boundary for the
 * `assistant_text` coalesce step (see `EventStream.tsx`). We render nothing
 * for those — otherwise every assistant turn would leave a stray status line
 * in the log.
 */

import type { SessionStatus, StatusEvent } from '@/lib/agent/types';

/**
 * Derive the human-readable label from a `StatusEvent`. Preference order:
 * explicit `message` (e.g. `"Session resumed at 23:14:02"`) → phase-mapped
 * caption → status-mapped caption.
 *
 * Exported so a colocated test can pin the contract.
 */
export function statusLineLabel(event: StatusEvent): string | null {
  if (event.message && event.message.trim().length > 0) {
    return event.message;
  }
  // `message_end` is the assistant-turn boundary used by EventStream to
  // flush the in-flight markdown block. It is not a user-facing event.
  if (event.phase === 'message_end') return null;
  switch (event.phase) {
    case 'started':
      return 'Session started';
    case 'resumed':
      return 'Session resumed';
    case 'idle':
      return 'Session idle';
    case 'killed':
      return 'Session killed';
    case 'errored':
      return 'Session errored';
    default:
      break;
  }
  switch (event.status) {
    case 'no_session':
      return 'No session';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'orphaned':
      return 'Session orphaned';
    case 'idle':
      return 'Session idle';
    case 'running':
      return 'Session running';
    case 'errored':
      return 'Session errored';
    case 'killed':
      return 'Session killed';
    default:
      return null;
  }
}

/**
 * Map the event's status / phase to the dot palette key used by §6.7.
 * Phase wins over status when it carries a more specific lifecycle marker
 * (e.g. a `phase: 'errored'` event whose `status` is still `running`
 * because the manager hasn't transitioned yet).
 */
function resolveDotStatus(
  event: StatusEvent,
): SessionStatus | 'no_session' {
  switch (event.phase) {
    case 'errored':
      return 'errored';
    case 'killed':
      return 'killed';
    case 'idle':
      return 'idle';
    case 'started':
    case 'resumed':
      return 'running';
    default:
      return event.status;
  }
}

const DOT_COLOR_CLASS: Record<SessionStatus | 'no_session', string> = {
  idle: 'text-ink-400',
  running: 'text-blue-600',
  awaiting_approval: 'text-amber-600',
  errored: 'text-red-600',
  killed: 'text-ink-500',
  orphaned: 'text-ink-500',
  no_session: 'text-ink-400',
};

export interface StatusLineProps {
  event: StatusEvent;
}

export default function StatusLine({ event }: StatusLineProps): JSX.Element | null {
  const label = statusLineLabel(event);
  if (!label) return null;
  const dotStatus = resolveDotStatus(event);
  const dotColor = DOT_COLOR_CLASS[dotStatus] ?? 'text-ink-400';
  const isLive = dotStatus === 'running' || dotStatus === 'awaiting_approval';
  const dotClass = [
    'inline-block leading-none',
    dotColor,
    isLive ? 'pulse-dot' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <p className="status-line flex items-center gap-2 px-1 py-1.5 text-[11.5px] text-ink-500 mono">
      <span aria-hidden="true" className={dotClass}>
        ●
      </span>
      <span>{label}</span>
    </p>
  );
}
