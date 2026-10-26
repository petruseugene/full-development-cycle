'use client';

/**
 * PendingApprovalsPill — TopBar cross-feature approvals indicator
 * (Task 17, spec R39 / AC24 / AC33 / AC34 / AC35 / AC36 / AC37).
 *
 * Renders only when there is at least one pending approval anywhere in
 * the dashboard. Clicking the pill toggles a popover that groups
 * pending approvals by feature; clicking a row opens that feature's
 * chat drawer on the Chat tab and scrolls the matching ApprovalCard
 * (id="approval-<requestId>") into view.
 *
 * Data sources:
 *   - `GET /api/agent/approvals` polled every 4s (R39 backstop).
 *   - `useDashboardAgentEvents()` — SSE bridge that fires on every
 *     `approval_request` / `approval_resolved` frame. Each event
 *     re-fetches the approvals snapshot so the pill count stays
 *     consistent with the underlying queue.
 *
 * Wireframe contract: `wireframes/topbar-pending-approvals-popover.html`.
 * Element order in the pill (left-to-right): pulsing red `.pulse-dot`,
 * literal text "Approvals", `.badge.badge--accent` count. Popover is
 * 420px wide, anchored under the pill, with grouped feature sections.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSnapshot } from '@/lib/snapshot-context';
import { useDashboardAgentEvents } from '@/lib/agent/dashboard-events';
import type { Feature, FeatureJson } from '@/lib/types';

interface PendingApproval {
  featureId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: string;
}

interface ApprovalsResponse {
  approvals: PendingApproval[];
}

const POLL_INTERVAL_MS = 4000;
const POPOVER_ID = 'approvals-popover';
const CHAT_TAB_SS_KEY_PREFIX = 'chat-drawer-tab:';

/**
 * Format the elapsed-time slot for an approval row (AC36 — "12s ago",
 * "2m ago", "1h ago"). Falls back to "—" when the timestamp is
 * missing or unparseable.
 */
export function formatAgo(createdAt: string | null | undefined, nowMs: number): string {
  if (!createdAt) return '—';
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return '—';
  const diffSec = Math.max(0, Math.floor((nowMs - parsed.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

/**
 * One-line monospace summary for a tool's `toolInput` payload (AC36).
 * Keeps the popover row predictable across tool shapes:
 *   - Bash       → `command` string
 *   - Edit/Write → `file_path` / `path`
 *   - Read       → `file_path`
 *   - default    → JSON-stringified input, truncated to one line
 */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const pick = (key: string): string | null => {
    const v = input[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  if (toolName === 'Bash') {
    return pick('command') ?? '';
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return pick('file_path') ?? pick('path') ?? '';
  }
  if (toolName === 'Read') {
    return pick('file_path') ?? pick('path') ?? '';
  }
  try {
    return JSON.stringify(input).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

interface FeatureGroup {
  featureId: string;
  feature: Feature | null;
  approvals: PendingApproval[];
}

/**
 * Group an approvals list by featureId, preserving the insertion
 * order of features (matches the order they appear in the dashboard
 * snapshot — typically lex-desc by id), and within each group the
 * order of approvals as returned by the API (oldest-first in the
 * underlying queue per R14).
 */
export function groupApprovalsByFeature(
  approvals: PendingApproval[],
  features: Feature[],
): FeatureGroup[] {
  const featureById = new Map<string, Feature>();
  for (const f of features) featureById.set(f.id, f);

  const order: string[] = [];
  const buckets = new Map<string, PendingApproval[]>();
  for (const a of approvals) {
    if (!buckets.has(a.featureId)) {
      buckets.set(a.featureId, []);
      order.push(a.featureId);
    }
    buckets.get(a.featureId)!.push(a);
  }
  return order.map((featureId) => ({
    featureId,
    feature: featureById.get(featureId) ?? null,
    approvals: buckets.get(featureId)!,
  }));
}

export default function PendingApprovalsPill() {
  const { snapshot, openChat } = useSnapshot();
  const events = useDashboardAgentEvents();

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // ── Fetch approvals (poll + event-driven refresh) ───────────────────
  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/approvals', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as ApprovalsResponse;
      if (Array.isArray(data.approvals)) {
        setApprovals(data.approvals);
      }
    } catch {
      // Transient network failure — next poll tick will recover.
    }
  }, []);

  // Initial fetch + 4s backstop poll. The interval persists across the
  // pill's lifetime so the count stays accurate even when the popover
  // is closed.
  useEffect(() => {
    void fetchApprovals();
    const id = setInterval(() => {
      void fetchApprovals();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchApprovals]);

  // Refresh on every dashboard-agent SSE event. `events.seq` increments
  // on every observed approval_request / approval_resolved / session_status
  // frame, so this effect re-fires immediately on any of them.
  useEffect(() => {
    if (events.seq === 0) return;
    void fetchApprovals();
  }, [events.seq, fetchApprovals]);

  // Refresh the "Xs ago" labels while the popover is open so the
  // timestamps don't go stale. Single 15s tick — cheap and matches the
  // granularity (`Xs` / `Ym` / `Zh`) the formatter reports.
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [open]);

  // ── Outside-mousedown + Escape close (AC37) ─────────────────────────
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ── Pre-bind a row click to: close, switch tab, openChat, scroll ────
  const onRowClick = useCallback(
    (featureId: string, requestId: string) => {
      setOpen(false);
      // Switch the drawer's tab to "Chat" via the same sessionStorage
      // key ChatDrawer reads on (re)open. T12/T15 may rebuild the
      // ChatDrawer, but the per-feature `chat-drawer-tab:<featureId>`
      // key is stable across this feature (see ChatDrawer.tsx, AC14).
      try {
        window.sessionStorage.setItem(
          `${CHAT_TAB_SS_KEY_PREFIX}${featureId}`,
          'chat',
        );
      } catch {
        // sessionStorage unavailable — drawer falls back to default tab
      }
      openChat(featureId);
      // ApprovalCards (Task 14) render with id="approval-<requestId>".
      // The element appears only after: drawer opens → ChatTab mounts →
      // SSE connects → historical events arrive → ApprovalCard renders.
      // A fixed setTimeout (50ms / 200ms / etc.) races that pipeline.
      //
      // We use a MutationObserver on <body> so we react the instant the
      // node is added to the DOM, with a 5s timeout as a give-up gate
      // (the approval may have been resolved server-side already, or
      // T14 may not yet have shipped the ApprovalCard renderer). Try a
      // synchronous lookup first in case the element is already mounted
      // (e.g. drawer was already open on the right feature).
      const targetId = `approval-${requestId}`;
      const scrollTo = (el: HTMLElement) => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      const existing = document.getElementById(targetId);
      if (existing) {
        scrollTo(existing);
      } else if (typeof MutationObserver !== 'undefined') {
        let timeoutId = 0;
        const observer = new MutationObserver(() => {
          const el = document.getElementById(targetId);
          if (el) {
            observer.disconnect();
            window.clearTimeout(timeoutId);
            scrollTo(el);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        timeoutId = window.setTimeout(() => {
          observer.disconnect();
        }, 5000);
      }
    },
    [openChat],
  );

  const features = snapshot?.features ?? [];
  const groups = useMemo(
    () => groupApprovalsByFeature(approvals, features),
    [approvals, features],
  );
  const totalCount = approvals.length;

  // R39 — render only when there's at least one pending approval.
  if (totalCount === 0) return null;

  const pillBg = open ? '#FEF3C7' /* warn-bg */ : '#FEE2E2' /* error-bg */;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={POPOVER_ID}
        aria-label={`Pending approvals: ${totalCount}`}
        className="approvals-pill inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-line text-[12px] font-semibold text-ink-900 hover:brightness-105"
        style={{ background: pillBg }}
      >
        {/* AC24/AC33 — left-most: pulsing red dot. The `.sd` class gives
            a 6px round dot; the inline background overrides the default
            blue/grey to error-red. The `.pulse-dot` animation is the
            shared globals.css ring. */}
        <span
          className="sd progress pulse-dot rounded-full"
          aria-hidden="true"
          style={{ background: '#DC2626' }}
        />
        <span>Approvals</span>
        <span className="badge badge--accent ml-1 inline-flex items-center justify-center h-[18px] min-w-[18px] px-1.5 rounded-[4px] border border-line text-[10.5px] font-bold mono"
              style={{ background: '#FEF3C7', color: '#0F172A' }}>
          {totalCount}
        </span>
      </button>

      {open ? (
        <div
          id={POPOVER_ID}
          role="dialog"
          aria-label="Pending approvals"
          // Anchored under the pill. TopBar height in the live shell is
          // h-12 (48px); `top-full mt-1` ties it to the trigger so the
          // value tracks the TopBar height (the wireframe's 56px arrives
          // from its taller header). Right-aligned with the pill via
          // `right-0`; the popover is 420px wide per AC34.
          className="absolute top-full mt-1 right-0 z-30 w-[420px] rounded-md border border-line bg-white p-3 text-[12.5px] text-ink-800"
          style={{ boxShadow: '0 10px 24px -8px rgba(15,23,42,.18), 0 0 0 1px #E5E7EB' }}
        >
          {/* Triangular caret (AC34) — wedge anchored to the right
              under the pill. Drawn via a rotated square with two
              borders so it picks up the popover's border colour. */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: -6,
              right: 18,
              width: 10,
              height: 10,
              background: '#fff',
              borderLeft: '1px solid #E5E7EB',
              borderTop: '1px solid #E5E7EB',
              transform: 'rotate(45deg)',
            }}
          />

          {/* Header (AC35) */}
          <h4 className="serif text-[15px] font-semibold text-ink-900 mb-2 px-1">
            Pending approvals · {totalCount}
          </h4>

          {/* Grouped sections (AC35) */}
          <div className="flex flex-col gap-2 max-h-[420px] overflow-auto">
            {groups.map((group) => (
              <FeatureGroupSection
                key={group.featureId}
                group={group}
                nowMs={nowMs}
                onRowClick={onRowClick}
              />
            ))}
          </div>

          {/* Footer hint (AC37) */}
          <p className="text-[10.5px] text-ink-500 mt-2 px-1">
            Esc to close · click outside dismisses
          </p>
        </div>
      ) : null}
    </div>
  );
}

function FeatureGroupSection({
  group,
  nowMs,
  onRowClick,
}: {
  group: FeatureGroup;
  nowMs: number;
  onRowClick: (featureId: string, requestId: string) => void;
}) {
  const { feature, approvals } = group;
  const slug = feature?.slug ?? group.featureId;
  const phase = (feature?.meta?.current_phase ??
    null) as FeatureJson['current_phase'] | null;
  const groupHeadId = `approvals-group-${group.featureId}`;

  return (
    <section className="feat-group" aria-labelledby={groupHeadId}>
      <div
        id={groupHeadId}
        className="feat-head flex items-center gap-2 px-1 py-1 text-[11.5px] text-ink-500"
        style={{ borderBottom: '1px dashed #E5E7EB' }}
      >
        <span className="slug-pill">{slug}</span>
        {phase ? (
          <span className={`chip phase-${phase}`}>{phase}</span>
        ) : null}
        <span className="ml-auto mono text-[10.5px] text-ink-500">
          {approvals.length} pending
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 mt-1 list-none p-0 m-0">
        {approvals.map((approval) => (
          <li key={approval.requestId}>
            <ApprovalRowButton
              approval={approval}
              nowMs={nowMs}
              onClick={() => onRowClick(approval.featureId, approval.requestId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApprovalRowButton({
  approval,
  nowMs,
  onClick,
}: {
  approval: PendingApproval;
  nowMs: number;
  onClick: () => void;
}) {
  const summary = summarizeToolInput(approval.toolName, approval.toolInput);
  const ago = formatAgo(approval.createdAt, nowMs);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Approve ${approval.toolName} for ${approval.featureId}`}
      // AC36 — 2-column grid: left = tool name (bold) over a one-line
      // monospace summary; right = muted "Xs ago" timestamp. Hover and
      // focus reveal the paper-shade background + dashed ink outline at
      // outline-offset:-2px.
      className="approval-row w-full grid items-center gap-2 px-1.5 py-1.5 rounded-md text-left"
      style={{
        gridTemplateColumns: '1fr auto',
        background: 'transparent',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#F4F6FA';
        e.currentTarget.style.outline = '2px dashed #0F172A';
        e.currentTarget.style.outlineOffset = '-2px';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.outline = 'none';
        e.currentTarget.style.outlineOffset = '0';
      }}
      onFocus={(e) => {
        e.currentTarget.style.background = '#F4F6FA';
        e.currentTarget.style.outline = '2px dashed #0F172A';
        e.currentTarget.style.outlineOffset = '-2px';
      }}
      onBlur={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.outline = 'none';
        e.currentTarget.style.outlineOffset = '0';
      }}
    >
      <span className="min-w-0 block">
        <span className="tool block font-bold text-[12.5px] text-ink-900">
          {approval.toolName}
        </span>
        <span className="summary block mono text-[11.5px] text-ink-500 truncate"
              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {summary}
        </span>
      </span>
      <span className="ago text-[10.5px] text-ink-500 mono whitespace-nowrap">
        {ago}
      </span>
    </button>
  );
}
