'use client';

/**
 * ToolResultCard — renderer for `tool_result` events in the Chat tab.
 *
 * Spec / AC refs:
 *   - AC1  — events render inside the chat log
 *   - AC3  — non-text events use dedicated renderers
 *   - AC17 — error variants render with the `.accent-blocked` accent bar plus
 *            an `.chip.st-blocked` chip (chat-redesign §6.4 supersedes the
 *            original `border-color: var(--error)` / `.badge--danger` rule
 *            from Task 13; semantics are preserved).
 *   - AC18 — rendered nested under its matching `ToolCallCard` (matched by
 *            `tool_use_id` upstream in `ChatTab.tsx`); collapsed by default;
 *            first 20 lines of output inside a `<pre>` block with a
 *            "Show full ↗" affordance beneath
 *   - R27  — tool_result truncated output + show-full toggle
 *
 * Visual contract (chat-redesign §6.4):
 *   - Card: `bg-white border border-line rounded-lg p-3` with `.accent-done`
 *     on success or `.accent-blocked` on `isError`.
 *   - Head row: `[label "RESULT · <toolName>" mono uppercase ink-500]
 *               [spacer] [chip .chip.st-done | .chip.st-blocked]`. Duration
 *     (when available) appears inside the chip text.
 *   - Output block: dark-themed `<pre>` — `bg-ink-900 text-ink-200 rounded-md
 *     p-2.5 mono text-[11.5px] overflow-auto`. Error bodies may color changed
 *     lines `text-red-300` inside the dark block; baseline stays `text-ink-200`.
 *
 * Pairing (the result rendering directly below its tool_call) happens in
 * `ChatTab.tsx`'s dispatcher; this component only cares about its own event.
 */

import { useMemo, useState } from 'react';
import type { ToolResultEvent } from '@/lib/agent/types';

const PREVIEW_LINES = 20;

/* ────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Split the result body to the first `PREVIEW_LINES`, returning the preview
 * text and a flag indicating whether more lines were elided. Exported so a
 * colocated test can pin the boundary without rendering.
 */
export function previewResultLines(
  content: string,
  maxLines: number = PREVIEW_LINES,
): { preview: string; truncated: boolean } {
  if (!content) return { preview: '', truncated: false };
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return { preview: content, truncated: false };
  }
  return { preview: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/**
 * Format an optional duration (milliseconds) as a compact `"<n>s"` or
 * `"<n>ms"` suffix for the chip text. Returns `null` when no duration is
 * available so callers can render a bare label.
 */
function formatDurationMs(durationMs: number | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

/* ────────────────────────────────────────────────────────────────────────
   Component
   ──────────────────────────────────────────────────────────────────────── */

export interface ToolResultCardProps {
  event: ToolResultEvent;
  /** Optional initial expansion (used by tests / story controls). */
  defaultExpanded?: boolean;
}

export default function ToolResultCard({
  event,
  defaultExpanded = false,
}: ToolResultCardProps): JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const isError = event.isError === true;

  const content = event.content ?? '';
  const { preview, truncated } = useMemo(
    () => previewResultLines(content),
    [content],
  );
  const body = expanded ? content : preview;

  const raw = (event.raw ?? {}) as {
    toolName?: string;
    tool_name?: string;
    durationMs?: number;
    duration_ms?: number;
  };
  const toolName = raw.toolName ?? raw.tool_name ?? '';
  const durationMs = raw.durationMs ?? raw.duration_ms;
  const durationLabel = formatDurationMs(durationMs);

  const accentClass = isError ? 'accent-blocked' : 'accent-done';
  const chipClass = isError ? 'chip st-blocked' : 'chip st-done';
  const chipBase = isError ? 'failed' : 'ok';
  const chipText =
    durationLabel != null ? `${chipBase} · ${durationLabel}` : chipBase;

  const detailsId = `tool-result-${event.toolUseId}-body`;
  const labelText = toolName ? `RESULT · ${toolName}` : 'RESULT';

  return (
    <article
      className={`bg-white border border-line rounded-lg p-3 ${accentClass}`}
    >
      <div className="flex items-center gap-2">
        <span className="mono uppercase tracking-wider text-[11px] font-semibold text-ink-500">
          {labelText}
        </span>
        <span className="flex-1" />
        <span className={chipClass}>{chipText}</span>
      </div>
      {body.length > 0 && (
        <pre
          id={detailsId}
          aria-label={
            truncated && !expanded
              ? `Tool result (first ${PREVIEW_LINES} lines)`
              : 'Tool result'
          }
          className="mt-2 bg-ink-900 text-ink-200 rounded-md p-2.5 mono text-[11.5px] overflow-auto whitespace-pre-wrap break-words max-h-60 m-0"
        >
          {body}
        </pre>
      )}
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="inline-block mt-1 text-[12px] text-primary underline bg-transparent border-0 p-0 cursor-pointer"
        >
          {expanded ? 'Show less ↑' : 'Show full ↗'}
        </button>
      )}
    </article>
  );
}
