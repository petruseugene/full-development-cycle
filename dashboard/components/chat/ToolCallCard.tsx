'use client';

/**
 * ToolCallCard — renderer for `tool_call` events in the Chat tab.
 *
 * Spec / AC refs:
 *   - AC1  — events render inside the chat log
 *   - AC3  — non-text events use dedicated renderers
 *   - AC18 — collapsed by default; head row with TOOL label, tool name, and a
 *            right-aligned status chip; one-line summary derived from tool +
 *            input; click toggles expansion to show the full JSON input in a
 *            `<pre>` block
 *   - R27  — tool_call collapsed card; click to expand
 *
 * Visual contract: spec §6.3 (chat-redesign). The card uses the dashboard
 * primitives — white card on `border-line`, `accent-progress` blue inset bar,
 * `.chip.phase-implement` status chip, mono row for the input summary, and a
 * light-themed `<pre>` for the expanded JSON input. The "paper / handwritten"
 * styling (handwritten font, kraft backgrounds, asymmetric radii) is gone — every
 * style hook is a Tailwind utility class or an existing globals.css class
 * (no new global CSS introduced).
 *
 * The component remains intentionally presentational: it knows only about the
 * `ToolCallEvent` shape and the per-tool input-summary heuristic. Pairing
 * with the matching `ToolResultEvent` (so the result nests under the call)
 * happens in `ChatTab.tsx`'s dispatcher, not here — keeping this card
 * stateless lets it render in isolation in Storybook / tests / re-rendered
 * via the module-registry path without `ChatTab` cooperating.
 */

import { useState } from 'react';
import type { ToolCallEvent } from '@/lib/agent/types';

/* ────────────────────────────────────────────────────────────────────────
   Per-tool summary derivation
   ──────────────────────────────────────────────────────────────────────── */

/** Coerce an `input` field to a string for the summary line. */
function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/**
 * Derive a one-line summary from a tool name + input. The summary is the
 * collapsed-card body and is intentionally compact: it must survive being
 * truncated with `text-overflow: ellipsis` inside a narrow drawer.
 *
 * Examples (matching the AC18 brief):
 *   Bash:   command field                     → "Bash: npm test"
 *   Edit:   file_path field                   → "Edit: dashboard/components/Board.tsx"
 *   Write:  file_path field                   → "Write: docs/notes.md"
 *   Read:   file_path field                   → "Read: dashboard/lib/types.ts"
 *   Glob:   pattern + optional path           → "Glob: src star-star slash star dot ts"
 *   Grep:   pattern + optional path           → "Grep: TODO in dashboard/"
 *   Task:   subagent_type / description       → "Task: spec-writer"
 *   …else:  bracketed tool name only          → "<toolName>"
 *
 * Exported so a colocated test can pin the contract without rendering.
 */
export function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const i = input ?? {};
  switch (toolName) {
    case 'Bash': {
      const cmd = asString(i.command);
      return cmd ? `Bash: ${cmd}` : 'Bash';
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path = asString(i.file_path) ?? asString(i.notebook_path);
      return path ? `${toolName}: ${path}` : toolName;
    }
    case 'Read': {
      const path = asString(i.file_path);
      return path ? `Read: ${path}` : 'Read';
    }
    case 'Glob': {
      const pattern = asString(i.pattern);
      const path = asString(i.path);
      if (pattern && path) return `Glob: ${pattern} in ${path}`;
      if (pattern) return `Glob: ${pattern}`;
      return 'Glob';
    }
    case 'Grep': {
      const pattern = asString(i.pattern);
      const path = asString(i.path);
      if (pattern && path) return `Grep: ${pattern} in ${path}`;
      if (pattern) return `Grep: ${pattern}`;
      return 'Grep';
    }
    case 'Task': {
      const subagent = asString(i.subagent_type);
      const desc = asString(i.description);
      if (subagent) return `Task: ${subagent}`;
      if (desc) return `Task: ${desc}`;
      return 'Task';
    }
    case 'WebFetch': {
      const url = asString(i.url);
      return url ? `WebFetch: ${url}` : 'WebFetch';
    }
    case 'WebSearch': {
      const q = asString(i.query);
      return q ? `WebSearch: ${q}` : 'WebSearch';
    }
    default:
      return toolName;
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Component
   ──────────────────────────────────────────────────────────────────────── */

export interface ToolCallCardProps {
  event: ToolCallEvent;
  /** Optional initial open state (used by tests / story controls). */
  defaultOpen?: boolean;
  /**
   * Optional lifecycle state for the chip text. Defaults to `'running'`
   * since a standalone card has no visibility into the paired
   * `ToolResultEvent`. `ChatTab.tsx`'s dispatcher flips this to `'done'`
   * once the matching result lands (Task 10 wiring).
   */
  status?: 'running' | 'done';
}

export default function ToolCallCard({
  event,
  defaultOpen = false,
  status = 'running',
}: ToolCallCardProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const summary = summarizeToolCall(event.toolName, event.input);
  const detailsId = `tool-call-${event.toolUseId}-body`;
  const chipText = status === 'done' ? 'done' : 'running…';

  // The whole head row is the toggle (AC18 "click toggles expansion"). It
  // must be a real <button> for keyboard + a11y; we reset the default button
  // chrome so the row reads as a flex layout, not a chunky form control.
  return (
    <article className="tool-card bg-white border border-line rounded-lg p-3 accent-progress">
      <button
        type="button"
        className="head flex items-center gap-2 w-full bg-transparent border-0 p-0 m-0 text-left cursor-pointer font-sans"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        <span className="mono text-[11px] uppercase tracking-wider text-ink-500 font-semibold">
          TOOL
        </span>
        <span className="text-[13.5px] font-semibold text-ink-900">
          {event.toolName}
        </span>
        <span className="ml-auto chip phase-implement">{chipText}</span>
      </button>
      <div
        className="summary mt-2 bg-ink-50 border border-line rounded-md px-2.5 py-1.5 mono text-[11.5px] text-ink-700 truncate"
        title={summary}
      >
        {summary}
      </div>
      {open && (
        <pre
          id={detailsId}
          className="tool-input mt-2 mb-0 px-2.5 py-2 bg-ink-50 border border-line rounded-md mono text-[11.5px] text-ink-700 max-h-60 overflow-auto whitespace-pre-wrap break-words"
        >
          {JSON.stringify(event.input ?? {}, null, 2)}
        </pre>
      )}
    </article>
  );
}
