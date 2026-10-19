'use client';

/**
 * ReplyComposer — multiline reply textarea + Send button anchored below
 * the `.chat-log` (Task 14).
 *
 * Spec / AC refs:
 *   - AC1, AC2 — user messages reach the orchestrator via the in-drawer
 *                composer
 *   - AC19 — textarea with placeholder `Type a reply to the orchestrator…`;
 *            primary Send button labelled `Send`; hint line
 *            `⌘+Enter to send · empty messages not sent`. Empty messages
 *            no-op. Send disables while a previous send is in flight.
 *   - AC23 — Awaiting-approval lockout: textarea + Send `disabled` /
 *            `aria-disabled="true"`, textarea placeholder switches to
 *            `Resolve the approval above to continue…`, container
 *            `opacity-60`.
 *   - R29  — Send disables while in flight.
 *   - R30  — awaiting-approval composer lockout.
 *
 * Styling: chat-redesign Task 6 (spec §6.12). All inline-style constants
 * removed in favor of Tailwind utilities. Container: white card with
 * border-line and rounded-lg; on focus-within it emits the primary-tinted
 * 3px ring + border via Tailwind arbitrary-value utilities (the
 * `.ring-primary` / `.border-primary` token values inlined so the JIT
 * actually compiles the `focus-within:` variant). Send button uses
 * `bg-primary text-white`.
 *
 * Submission contract:
 *   - On submit: POST `/api/agent/<featureId>/message` with `{ text }`.
 *   - On `{ accepted: true }`: clear the textarea, reset the auto-grow
 *     height, return focus to the textarea so the user can type the next
 *     reply without re-targeting.
 *   - On `{ accepted: false, reason }`: surface `reason` as a small
 *     inline error beneath the hint line, leave the textarea contents
 *     in place so the user can edit and retry.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChatTabFeatureContext } from './ChatTabFeatureContext';

/**
 * Session-status shape the composer cares about. We only branch on
 * `awaiting_approval` — every other state behaves identically. Kept as a
 * string union (not the full `SessionStatus`) so this component doesn't
 * pull in the agent-types module just for one literal.
 */
export type ComposerSessionStatus =
  | 'running'
  | 'idle'
  | 'awaiting_approval'
  | 'errored'
  | 'killed'
  | 'orphaned'
  | 'no_session';

// ── Layout constants ──────────────────────────────────────────────────────

/**
 * Auto-grow envelope. The composer textarea starts at 32px (one line of
 * Geist 13px) and grows up to ~10 rows so a very long draft doesn't push
 * the chat log off-screen. The user can still scroll inside the textarea
 * past the cap.
 */
const MIN_HEIGHT_PX = 32;
const MAX_HEIGHT_PX = 220;

// ── Component ─────────────────────────────────────────────────────────────

export interface ReplyComposerProps {
  /**
   * Current session status. The composer locks out when
   * `awaiting_approval` (AC23 / R30); every other value renders the
   * normal composer. Optional — defaults to `running` so a host that
   * doesn't yet wire the SSE status (tests, Storybook) still gets a
   * functional composer.
   */
  sessionStatus?: ComposerSessionStatus;
  /**
   * Optional featureId override. The default reads
   * `ChatTabFeatureContext` (set by `ChatTab`).
   */
  featureId?: string;
}

export default function ReplyComposer({
  sessionStatus = 'running',
  featureId,
}: ReplyComposerProps): JSX.Element {
  const contextFeatureId = useContext(ChatTabFeatureContext);
  const effectiveFeatureId = featureId ?? contextFeatureId;

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const awaitingApproval = sessionStatus === 'awaiting_approval';
  const trimmed = text.trim();
  const empty = trimmed.length === 0;

  // Auto-grow: rewrite the textarea height to fit the content, clamped to
  // [MIN_HEIGHT_PX, MAX_HEIGHT_PX]. We do this in an effect so the value
  // is settled after React commits the new value to the DOM. Scrollbar
  // appears past the cap because of the textarea's intrinsic overflow.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Reset to min so the scrollHeight reflects the actual content height
    // and not the previous (larger) layout. Two-pass measurement.
    ta.style.height = 'auto';
    const next = Math.min(
      MAX_HEIGHT_PX,
      Math.max(MIN_HEIGHT_PX, ta.scrollHeight),
    );
    ta.style.height = `${next}px`;
  }, [text]);

  // When the lockout flips ON, blur the textarea so the disabled attribute
  // doesn't leave a stranded caret. The browser's normal disabled-input
  // behaviour already blocks input, but the visual caret can persist
  // briefly on some browsers when `disabled` is set on a focused element.
  useEffect(() => {
    if (!awaitingApproval) return;
    const ta = textareaRef.current;
    if (ta && document.activeElement === ta) ta.blur();
  }, [awaitingApproval]);

  const send = useCallback(async () => {
    // AC19 — empty messages are a no-op (R29). Whitespace-only counts as
    // empty so the user can't accidentally submit a stray newline.
    if (empty) return;
    if (sending) return;
    if (awaitingApproval) return;
    if (!effectiveFeatureId) {
      setErrorMessage('No featureId in context');
      return;
    }
    setSending(true);
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(effectiveFeatureId)}/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed }),
        },
      );
      if (!res.ok) {
        let detail = `Send failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // Body wasn't JSON — keep the generic detail.
        }
        setErrorMessage(detail);
        return;
      }
      const body = (await res.json()) as {
        accepted?: boolean;
        reason?: string;
      };
      if (body?.accepted === false) {
        // Server rejected (e.g. session not running). Leave the text in
        // place so the user can edit + retry once the lockout clears.
        setErrorMessage(body.reason ?? 'Message not accepted');
        return;
      }
      // Accepted — clear the field and reset the auto-grown height. The
      // textarea keeps focus so the user can fire off the next reply
      // without re-targeting.
      setText('');
      const ta = textareaRef.current;
      if (ta) {
        ta.style.height = `${MIN_HEIGHT_PX}px`;
        ta.focus();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSending(false);
    }
  }, [awaitingApproval, effectiveFeatureId, empty, sending, trimmed]);

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void send();
    },
    [send],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // ⌘+Enter (macOS) or Ctrl+Enter (Windows / Linux) submits — the
      // hint mentions ⌘+Enter; we accept both modifiers so cross-platform
      // users have the same shortcut.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const sendDisabled = awaitingApproval || sending || empty || !effectiveFeatureId;

  // Container Tailwind chain (spec §6.12). On focus-within we emit the
  // primary-tinted 3px ring + border via arbitrary-value utilities (the
  // `.ring-primary` / `.border-primary` token values inlined so Tailwind's
  // JIT compiles the variant). Locked state dims the whole composer to 60%.
  const containerClassName = [
    'composer',
    'bg-white border border-line rounded-lg p-2 flex items-end gap-2',
    'focus-within:shadow-[0_0_0_3px_rgba(91,91,247,0.35)] focus-within:border-[#5B5BF7]',
    awaitingApproval ? 'opacity-60' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <form
      className={containerClassName}
      aria-label={
        awaitingApproval ? 'Reply composer (disabled)' : 'Reply composer'
      }
      onSubmit={onSubmit}
    >
      <label htmlFor="chat-reply" className="sr-only absolute -left-[9999px]">
        Reply
      </label>
      <textarea
        ref={textareaRef}
        id="chat-reply"
        className="flex-1 border-0 outline-none resize-none font-sans text-[13px] min-h-[32px] text-ink-900 bg-transparent"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setTextareaFocused(true)}
        onBlur={() => setTextareaFocused(false)}
        placeholder={
          awaitingApproval
            ? 'Resolve the approval above to continue…'
            : 'Type a reply to the orchestrator…'
        }
        disabled={awaitingApproval}
        aria-disabled={awaitingApproval ? 'true' : undefined}
      />
      <button
        type="submit"
        className="bg-primary text-white rounded-md h-8 px-3 font-semibold text-[12.5px] inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
        disabled={sendDisabled}
        aria-disabled={sendDisabled ? 'true' : undefined}
      >
        <span>{sending ? 'Sending…' : 'Send'}</span>
        {textareaFocused && !sending && (
          <span className="mono text-[10px] opacity-80" aria-hidden="true">
            ⌘⏎
          </span>
        )}
      </button>
      {errorMessage && (
        <p
          className="composer-error w-full basis-full text-[12px] text-red-700 mt-1"
          role="alert"
        >
          {errorMessage}
        </p>
      )}
    </form>
  );
}
