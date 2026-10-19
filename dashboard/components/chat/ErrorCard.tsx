'use client';

/**
 * ErrorCard — renderer for `error` events in the Chat tab (Task 13).
 *
 * Spec / AC refs:
 *   - AC1, AC3, AC17 — `.tool-card` with a danger accent for `error` events
 *   - R27 error      — red-accented card with the SDK error text and a "Retry"
 *                       button that calls `POST /api/agent/[featureId]/resume`
 *
 * Visual contract: `docs/features/2026-05-17-22h-01m-chat-redesign/spec.md`
 * §6.8 — white card body, 1px `border-line`, `rounded-lg`, `.accent-blocked`
 * red inset bar; head row carries the "ERROR" mono label, the title in Geist
 * semibold ink-900, and a `.chip.st-blocked` "errored" chip on the right.
 *
 * The Retry POST does not stream a response into this component directly —
 * the new session events arrive over the existing SSE stream consumed by
 * `EventStream.tsx`. We surface "in flight" and "failed" UI states from the
 * button so the user knows the click registered, but downstream UI doesn't
 * depend on this component's state machine.
 */

import { useCallback, useContext, useState } from 'react';
import { ChatTabFeatureContext } from './ChatTabFeatureContext';
import type { ErrorEvent as AgentErrorEvent } from '@/lib/agent/types';

export interface ErrorCardProps {
  event: AgentErrorEvent;
  /**
   * Optional featureId override — when rendered outside of `ChatTab` (tests,
   * Storybook). The default reads `ChatTabFeatureContext`.
   */
  featureId?: string;
}

export default function ErrorCard({
  event,
  featureId,
}: ErrorCardProps): JSX.Element {
  const contextFeatureId = useContext(ChatTabFeatureContext);
  const effectiveFeatureId = featureId ?? contextFeatureId;

  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  const onRetry = useCallback(async () => {
    if (!effectiveFeatureId) {
      setState('failed');
      setFailureMessage('No featureId in context');
      return;
    }
    setState('pending');
    setFailureMessage(null);
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(effectiveFeatureId)}/resume`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      if (!res.ok) {
        let detail = `Retry failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // Body wasn't JSON — keep the generic detail.
        }
        setState('failed');
        setFailureMessage(detail);
        return;
      }
      // Success — the resumed session will emit a `status { phase: 'resumed' }`
      // event over SSE, which `StatusLine` renders. Leave the card in place;
      // the user's chat scrollback now shows both the original error and the
      // resume confirmation.
      setState('idle');
    } catch (err) {
      setState('failed');
      setFailureMessage(
        err instanceof Error ? err.message : 'Network error during retry',
      );
    }
  }, [effectiveFeatureId]);

  const detail = event.message || 'Unknown error';

  return (
    <article
      className="tool-card tool-card--err error-card bg-white border border-line rounded-lg p-3 accent-blocked"
      role="alert"
    >
      <div className="head flex items-center gap-2">
        <span className="mono text-[11px] uppercase tracking-wider text-ink-500 font-semibold">
          ERROR
        </span>
        <span className="text-[13px] font-semibold text-ink-900">
          SDK error
        </span>
        <span className="ml-auto chip st-blocked">errored</span>
      </div>
      <p className="summary mt-1.5 mb-0 text-[12.5px] text-ink-600 whitespace-pre-wrap break-words">
        {detail}
      </p>
      <div className="actions mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn btn--sm inline-flex items-center justify-center h-7 px-3 rounded-md bg-primary text-white text-[12.5px] font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
          onClick={onRetry}
          disabled={state === 'pending' || !effectiveFeatureId}
          aria-disabled={state === 'pending' || !effectiveFeatureId}
        >
          {state === 'pending' ? 'Retrying…' : 'Retry'}
        </button>
        {state === 'failed' && failureMessage && (
          <span className="retry-failed text-[12px] text-red-700">
            {failureMessage}
          </span>
        )}
      </div>
    </article>
  );
}
