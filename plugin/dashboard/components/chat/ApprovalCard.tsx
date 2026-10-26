'use client';

/**
 * ApprovalCard — renderer for `approval_request` events in the Chat tab.
 *
 * Visual contract (chat-redesign spec §6.5, §6.6):
 *   - Card root: `bg-white border border-line rounded-lg p-3 accent-testing`
 *     (amber inset bar already defined in globals.css).
 *   - Head row: `[label "APPROVAL"] [title "Permission requested"] [spacer]
 *     [chip .chip.infra "awaiting"]`. Label uses `mono` + uppercase +
 *     `text-ink-500`; title uses Geist semibold ink-900.
 *   - Subject line: `<tool> · <code in mono>`.
 *   - Actions row: primary "Approve" (`bg-primary text-white`), outline
 *     "Approve & remember", danger "Deny" (`border-red-200 text-red-700`).
 *     `.kbd` hint `⏎ approve · esc deny` right-aligned.
 *   - Resolved state: same row, accent bar removed, `opacity-90`, title in
 *     `text-ink-600`, chip swaps to `.chip.st-done` ("approved") or
 *     `.chip.st-blocked` ("denied"). Card stays in place — no new card
 *     spawns when the matching `approval_resolved` event arrives.
 *
 * Behavioral / ARIA refs (preserved from the previous implementation):
 *   - AC1, AC2, AC4 — approval cards land inline in the chat stream and a
 *                     user resolution flows back through the agent SDK.
 *   - AC20 — `<section class="approval-card" id="approval-<requestId>"
 *            role="region">`.
 *   - AC21 — Bash branch: `command` rendered in `<code>` on its own line;
 *            `cwd`/`timeout` shown as a muted monospace `meta` line beneath.
 *   - AC22 — Actions row, exact order: Approve (`allow`),
 *            Approve & remember (`allow_and_remember`), Deny (`deny`).
 *   - R28  — per-tool input formatter rules.
 *   - R39  — stable DOM id `approval-<requestId>` so the TopBar pending-
 *            approvals pill can `scrollIntoView` to the card.
 *
 * On click of any action button: all three disable, an inline spinner
 * shows, and we POST to `/api/agent/<featureId>/approval` with
 * `{ requestId, decision }`. On `{ resolved: true }` we render the same
 * one-line resolved state described above. On any failure we re-enable
 * the buttons and surface the reason in an inline error tooltip beneath
 * the actions row.
 *
 * Re-entry after `approval_resolved`: when ChatTab observes an
 * `approval_resolved` event with this card's `requestId`, it forwards
 * `resolvedDecision` down. The card then renders the same one-line
 * summary regardless of whether the resolution came from the local click
 * or another tab/source (e.g. TopBar popover, CLI).
 */

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ApprovalRequestEvent } from '@/lib/agent/types';
import { ChatTabFeatureContext } from './ChatTabFeatureContext';
import { summarizeToolCall } from './ToolCallCard';

// ── Decision type ─────────────────────────────────────────────────────────

type Decision = 'allow' | 'allow_and_remember' | 'deny';

/** Verb used in the post-resolution one-line summary. */
const DECISION_VERB: Record<Decision, string> = {
  allow: 'Approved',
  allow_and_remember: 'Approved & remembered',
  deny: 'Denied',
};

// ── Per-tool input formatters (R28) ───────────────────────────────────────

/** Coerce an unknown input value to a non-empty string or null. */
function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Edit / Write / NotebookEdit diff preview.
 *
 * Reads `old_string` / `new_string` (Edit / NotebookEdit) or `content`
 * (Write — there's no prior text). Emits a synthetic +/- diff:
 *   - `Edit` / `NotebookEdit` → `-<old>` then `+<new>`
 *   - `Write` → `+<content>` (no prior body)
 */
function diffPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const old = asNonEmptyString(input.old_string);
  const next = asNonEmptyString(input.new_string);
  const content = asNonEmptyString(input.content);

  const lines: string[] = [];
  if (toolName === 'Write') {
    const body = next ?? content;
    if (body) {
      for (const line of body.split('\n')) lines.push(`+ ${line}`);
    }
  } else {
    if (old) {
      for (const line of old.split('\n')) lines.push(`- ${line}`);
    }
    if (next) {
      for (const line of next.split('\n')) lines.push(`+ ${line}`);
    }
  }
  return lines.join('\n');
}

/** One-line summary for Read / Glob / Grep — reuses ToolCallCard's helper. */
function inspectorSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return summarizeToolCall(toolName, input);
}

/**
 * Pretty-print + line-cap helper for the fallback ("other tools") branch.
 * Returns `{ text, totalLines, capped }` so the renderer can show an
 * "expand toggle" only when there's something to expand.
 */
function jsonPreview(
  input: Record<string, unknown>,
  expanded: boolean,
  capLines: number,
): { text: string; totalLines: number; capped: boolean } {
  let json: string;
  try {
    json = JSON.stringify(input ?? {}, null, 2);
  } catch {
    // Circular / unserialisable payload — fall back to a coarse string.
    json = String(input);
  }
  const allLines = json.split('\n');
  if (expanded || allLines.length <= capLines) {
    return { text: json, totalLines: allLines.length, capped: false };
  }
  const capped = allLines.slice(0, capLines).join('\n');
  return { text: `${capped}\n…`, totalLines: allLines.length, capped: true };
}

// ── Shared className strings ──────────────────────────────────────────────

// Pending-state card root: white surface, 1px line border, 8px radius,
// amber inset accent bar (via .accent-testing). Spec §6.5.
const CARD_CLASS =
  'approval-card bg-white border border-line rounded-lg p-3 accent-testing shadow-sm';

// Resolved-state card root: same surface, accent bar dropped, dimmed.
// Spec §6.6 — stays in place so the chat scrollback keeps its rhythm.
const RESOLVED_CARD_CLASS =
  'approval-card approval-card--resolved bg-white border border-line rounded-lg p-3 opacity-90 shadow-sm';

// Light-themed mono block for Bash command / Edit-Write diff bodies. Per
// spec §5 — `bg-ink-50 border border-line` for inline mono surfaces.
const CODE_BLOCK_CLASS =
  'block bg-ink-50 border border-line rounded-md mono text-[12px] text-ink-700 px-2.5 py-1.5 my-1.5 whitespace-pre-wrap break-all';

const PRE_BLOCK_CLASS =
  'bg-ink-50 border border-line rounded-md mono text-[11.5px] text-ink-700 px-2.5 py-1.5 my-1.5 whitespace-pre-wrap break-all max-h-[360px] overflow-auto';

const DIFF_BLOCK_CLASS =
  'bg-ink-50 border border-line rounded-md mono text-[12px] text-ink-700 px-2.5 py-1.5 my-1.5 whitespace-pre-wrap break-words';

// ── Tool-body renderer ────────────────────────────────────────────────────

/**
 * Render the per-tool body block. Pure (no state) — the "JSON expand"
 * toggle for the fallback branch lives in the parent so resolved cards
 * never carry stale toggle state.
 */
function ToolBody({
  toolName,
  input,
  jsonExpanded,
  onToggleJson,
}: {
  toolName: string;
  input: Record<string, unknown>;
  jsonExpanded: boolean;
  onToggleJson: () => void;
}): JSX.Element {
  switch (toolName) {
    case 'Bash': {
      // AC21 — command on its own line in a `<code>` block; cwd/timeout
      // in a muted monospace meta line beneath. Both meta values are
      // optional; we omit the meta line entirely when neither is present
      // so the body doesn't grow an empty paragraph.
      const command = asNonEmptyString(input.command) ?? '';
      const cwd = asNonEmptyString(input.cwd);
      const timeoutRaw = input.timeout;
      const timeout =
        typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
          ? `${timeoutRaw}ms`
          : asNonEmptyString(timeoutRaw);
      const metaParts: string[] = [];
      if (cwd) metaParts.push(`cwd: ${cwd}`);
      if (timeout) metaParts.push(`timeout: ${timeout}`);
      return (
        <div className="body mt-1.5">
          <code className={CODE_BLOCK_CLASS}>{command}</code>
          {metaParts.length > 0 && (
            <p className="meta mono text-[11.5px] text-ink-500 mt-1 break-all">
              {metaParts.join(' · ')}
            </p>
          )}
        </div>
      );
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const filePath =
        asNonEmptyString(input.file_path) ??
        asNonEmptyString(input.notebook_path);
      const diff = diffPreview(toolName, input);
      return (
        <div className="body mt-1.5">
          {filePath && (
            <p className="mono text-[12px] text-ink-700 break-all my-1">
              {filePath}
            </p>
          )}
          {diff && <pre className={DIFF_BLOCK_CLASS}>{diff}</pre>}
        </div>
      );
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      return (
        <div className="body mt-1.5">
          <p className="mono text-[12.5px] text-ink-700 break-all my-1.5">
            {inspectorSummary(toolName, input)}
          </p>
        </div>
      );
    }
    default: {
      // Other tools (Task / MCP / anything new the SDK emits): show the
      // tool name + JSON pretty-print capped at 30 lines with an expand
      // toggle. We render the tool name in the head row already, so the
      // body just needs the JSON block.
      const { text, capped } = jsonPreview(input, jsonExpanded, 30);
      return (
        <div className="body mt-1.5">
          <pre className={PRE_BLOCK_CLASS}>{text}</pre>
          {(capped || jsonExpanded) && (
            <button
              type="button"
              onClick={onToggleJson}
              className="inline-flex items-center justify-center h-6 px-2 text-[12px] font-medium text-ink-700 bg-white border border-line rounded-md hover:bg-ink-50"
              aria-expanded={jsonExpanded}
            >
              {jsonExpanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      );
    }
  }
}

// ── Component ─────────────────────────────────────────────────────────────

export interface ApprovalCardProps {
  event: ApprovalRequestEvent;
  /**
   * Optional featureId override — when rendered outside ChatTab (tests,
   * Storybook). The default reads `ChatTabFeatureContext`.
   */
  featureId?: string;
  /**
   * When set, the card renders in its resolved (post-decision) state
   * regardless of local interaction. ChatTab forwards this when an
   * `approval_resolved` event arrives that matches this card's requestId,
   * so the card stays in sync with out-of-band resolutions (TopBar
   * popover, CLI, another tab).
   */
  resolvedDecision?: Decision | null;
}

export default function ApprovalCard({
  event,
  featureId,
  resolvedDecision = null,
}: ApprovalCardProps): JSX.Element {
  const contextFeatureId = useContext(ChatTabFeatureContext);
  const effectiveFeatureId = featureId ?? contextFeatureId;

  // Local "I just clicked" state. `localDecision` tracks the in-flight
  // decision so we can render the spinner inside the button the user
  // clicked. Once the POST resolves, we hand off to `resolvedHere` so the
  // card renders the same one-line summary as an out-of-band resolution.
  const [localDecision, setLocalDecision] = useState<Decision | null>(null);
  const [resolvedHere, setResolvedHere] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonExpanded, setJsonExpanded] = useState(false);

  // The card is "resolved" if either the local POST succeeded OR ChatTab
  // forwarded a matching approval_resolved event from the stream.
  const effectiveResolved = resolvedDecision ?? resolvedHere;
  const inFlight = localDecision !== null;
  const disabled = inFlight || effectiveResolved !== null;

  // Auto-clear the error after a few seconds so the tooltip doesn't
  // permanently linger after the user retries successfully. The cleanup
  // also drops the timer if the component unmounts mid-toast.
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!error) return;
    errorTimerRef.current = setTimeout(() => setError(null), 6000);
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    };
  }, [error]);

  const onDecision = useCallback(
    async (decision: Decision) => {
      if (disabled) return;
      if (!effectiveFeatureId) {
        setError('No featureId in context');
        return;
      }
      setError(null);
      setLocalDecision(decision);
      try {
        const res = await fetch(
          `/api/agent/${encodeURIComponent(effectiveFeatureId)}/approval`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: event.requestId, decision }),
          },
        );
        if (!res.ok) {
          let detail = `Approval failed (${res.status})`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) detail = body.error;
          } catch {
            // Body wasn't JSON — keep the generic detail.
          }
          setLocalDecision(null);
          setError(detail);
          return;
        }
        // Server confirmed — render the resolved summary. ChatTab will
        // also receive a matching `approval_resolved` SSE event and pass
        // `resolvedDecision` down; setting state here keeps the UI
        // responsive even if the SSE round-trip is slow.
        setResolvedHere(decision);
        setLocalDecision(null);
      } catch (err) {
        setLocalDecision(null);
        setError(err instanceof Error ? err.message : 'Network error');
      }
    },
    [disabled, effectiveFeatureId, event.requestId],
  );

  // Memoize the summary text — recomputing per render is cheap but the
  // calculation runs through `summarizeToolCall` which we use both in the
  // resolved state and as a tooltip on the head row.
  const callSummary = useMemo(
    () => summarizeToolCall(event.toolName, event.toolInput),
    [event.toolName, event.toolInput],
  );

  const titleId = `approval-${event.requestId}-title`;
  const sectionId = `approval-${event.requestId}`;

  // Resolved state — one-line summary in the same card container so the
  // chat scrollback keeps its visual rhythm. Out-of-band resolutions
  // (`resolvedDecision` prop) and local-click resolutions both end up
  // here. Spec §6.6: accent bar removed, opacity-90, title in ink-600,
  // chip becomes .chip.st-done ("approved") or .chip.st-blocked
  // ("denied").
  if (effectiveResolved !== null) {
    const resolvedChipClass =
      effectiveResolved === 'deny' ? 'chip st-blocked' : 'chip st-done';
    const resolvedChipText = effectiveResolved === 'deny' ? 'denied' : 'approved';
    return (
      <section
        className={RESOLVED_CARD_CLASS}
        id={sectionId}
        role="region"
        aria-labelledby={titleId}
      >
        <div className="flex items-center gap-2">
          <span className="mono uppercase text-[11px] tracking-wider text-ink-500 font-semibold">
            APPROVAL
          </span>
          <p
            id={titleId}
            className="text-[13px] text-ink-600 break-all m-0 flex-1"
          >
            <strong className="font-semibold">
              {DECISION_VERB[effectiveResolved]}
            </strong>
            {' · '}
            {callSummary}
          </p>
          <span className={resolvedChipClass}>{resolvedChipText}</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className={CARD_CLASS}
      id={sectionId}
      role="region"
      aria-labelledby={titleId}
    >
      <div className="head flex items-center gap-2 mb-1.5">
        <span className="mono uppercase text-[11px] tracking-wider text-ink-500 font-semibold">
          APPROVAL
        </span>
        <h4
          id={titleId}
          className="text-[13.5px] font-semibold text-ink-900 m-0"
        >
          Permission requested
        </h4>
        <span className="ml-auto chip infra">awaiting</span>
      </div>
      <p className="text-[12.5px] text-ink-600 m-0">
        <strong className="font-semibold text-ink-700">{event.toolName}</strong>
        {' · '}
        <span className="mono text-[12px] text-ink-700">{callSummary}</span>
      </p>
      <ToolBody
        toolName={event.toolName}
        input={event.toolInput}
        jsonExpanded={jsonExpanded}
        onToggleJson={() => setJsonExpanded((v) => !v)}
      />
      <div className="actions flex flex-wrap items-center gap-1.5 mt-2.5">
        {/* AC22 — exact button order: Approve / Approve & remember / Deny.
            The spinner replaces the text on the in-flight button so the
            user sees which decision they picked while the POST is open. */}
        <button
          type="button"
          className={`btn btn--primary btn--sm inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] font-semibold bg-primary text-white hover:brightness-110 disabled:opacity-55 disabled:cursor-not-allowed${
            disabled ? ' opacity-55 cursor-not-allowed' : ''
          }`}
          onClick={() => onDecision('allow')}
          disabled={disabled}
          aria-disabled={disabled}
          aria-label="Approve this tool call"
        >
          {localDecision === 'allow' && (
            <span
              className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
            />
          )}
          <span>Approve</span>
        </button>
        <button
          type="button"
          className={`btn btn--sm inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] font-medium bg-white border border-line text-ink-700 hover:bg-ink-50 disabled:opacity-55 disabled:cursor-not-allowed${
            disabled ? ' opacity-55 cursor-not-allowed' : ''
          }`}
          onClick={() => onDecision('allow_and_remember')}
          disabled={disabled}
          aria-disabled={disabled}
          aria-label="Approve this tool call and remember the decision"
        >
          {localDecision === 'allow_and_remember' && (
            <span
              className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
            />
          )}
          <span>Approve &amp; remember</span>
        </button>
        <button
          type="button"
          className={`btn btn--danger btn--sm inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[12.5px] font-medium bg-white border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-55 disabled:cursor-not-allowed${
            disabled ? ' opacity-55 cursor-not-allowed' : ''
          }`}
          onClick={() => onDecision('deny')}
          disabled={disabled}
          aria-disabled={disabled}
          aria-label="Deny this tool call"
        >
          {localDecision === 'deny' && (
            <span
              className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
            />
          )}
          <span>Deny</span>
        </button>
        <span className="ml-auto kbd" aria-hidden="true">
          ⏎ approve · esc deny
        </span>
        {error && (
          <span
            role="alert"
            title={error}
            className="approval-card__error w-full mt-1 text-[12px] text-red-700"
          >
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
